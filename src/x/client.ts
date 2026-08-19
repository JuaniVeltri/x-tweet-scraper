/**
 * The GraphQL client: resilience policy in one place (assessment §7).
 *
 * Every request goes through {@link XClient.execute}, which owns the retry
 * loop. The loop is deliberately driven by a *classification* rather than by
 * status codes scattered through the code — `classifyFailure` decides what kind
 * of failure this is, and the loop decides what to do about that kind:
 *
 *   retryable        → sleep with jittered backoff, try again
 *   rotate-token     → retire the guest token, try again with a fresh one
 *   refresh-query-id → re-resolve query IDs, try again
 *   auth-walled      → stop immediately; retrying cannot help
 *   fatal            → stop immediately
 *
 * A single 429 or 403 therefore costs a retry, not the run (§3).
 */

import { log } from 'apify';

import { DEFAULTS, GRAPHQL_BASE, X_PUBLIC_WEB_BEARER } from '../config/constants.js';
import { retryDelayMs, sleep } from '../util/backoff.js';
import { classifyFailure, extractApiCodes, XApiError } from '../util/errors.js';
import { DEFAULT_FEATURES, DEFAULT_FIELD_TOGGLES, missingFeaturesFrom } from './features.js';
import type { GuestTokenPool } from './guest-token.js';
import { headerValue, performRequest, type HttpRequest, type HttpResponse } from './http.js';
import type { QueryIdResolver } from './query-ids.js';

export interface GraphQLCall {
    readonly operationName: string;
    readonly variables: Readonly<Record<string, unknown>>;
    /** Extra switches merged over {@link DEFAULT_FEATURES}. */
    readonly features?: Readonly<Record<string, boolean>>;
    readonly fieldToggles?: Readonly<Record<string, boolean>>;
}

/**
 * Extra headers computed per request, merged over the static ones.
 *
 * This is the seam for `x-client-transaction-id`. X computes that header
 * per-request from state in its own page bundle, and has been rolling it out
 * gradually — every request in this project succeeds without it today, which is
 * why the algorithm is not implemented. But "not needed yet" is a poor reason
 * to have nowhere to put it: when X does start demanding it, it plugs in here
 * without touching the retry loop, the header set, or any call site.
 *
 * @param operationName The GraphQL operation about to be called.
 * @param url The fully composed request URL.
 */
export type DynamicHeaderProvider = (
    operationName: string,
    url: string,
) => Promise<Readonly<Record<string, string>>>;

export interface ClientOptions {
    readonly maxAttempts?: number;
    readonly backoffBaseMs?: number;
    readonly backoffMaxMs?: number;
    readonly requestTimeoutMs?: number;
    /** Injectable for deterministic tests. */
    readonly random?: () => number;
    readonly sleepFn?: (ms: number) => Promise<void>;
    /** See {@link DynamicHeaderProvider}. Absent by default. */
    readonly dynamicHeaders?: DynamicHeaderProvider;
    /**
     * The transport. Defaults to the real HTTP client.
     *
     * Injectable so the retry policy — which is the whole point of this class —
     * can be exercised against every failure shape without a socket. Mocking at
     * the module boundary instead would mostly test the mock.
     */
    readonly transport?: (request: HttpRequest) => Promise<HttpResponse>;
}

/** Error tallies surfaced in the run summary (§7 observability). */
export interface ClientStats {
    requests: number;
    retryableErrors: number;
    fatalErrors: number;
    tokenRotations: number;
    queryIdRefreshes: number;
    rateLimitHits: number;
}

export class XClient {
    readonly stats: ClientStats = {
        requests: 0,
        retryableErrors: 0,
        fatalErrors: 0,
        tokenRotations: 0,
        queryIdRefreshes: 0,
        rateLimitHits: 0,
    };

    /** Switches discovered through negotiation, applied to subsequent calls. */
    private readonly negotiatedFeatures: Record<string, boolean> = {};

    constructor(
        private readonly tokens: GuestTokenPool,
        private readonly queryIds: QueryIdResolver,
        private readonly options: ClientOptions = {},
    ) {}

    /**
     * Run one GraphQL operation to completion, retrying per the policy above.
     *
     * @returns The parsed `data` object.
     * @throws {XApiError} when retries are exhausted or the failure is terminal.
     */
    async execute(call: GraphQLCall): Promise<unknown> {
        const maxAttempts = this.options.maxAttempts ?? DEFAULTS.maxAttempts;
        let lastError: XApiError | null = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const lease = await this.tokens.acquire();
            const queryId = await this.queryIds.queryIdFor(call.operationName);
            const url = this.buildUrl(queryId, call);

            // Resolved per attempt, not per call: anything computed here is
            // expected to be single-use, so a retry must recompute it.
            const dynamic = await this.options.dynamicHeaders?.(call.operationName, url).catch(
                (error: unknown) => {
                    log.warning('Dynamic header provider failed; sending without it', {
                        operation: call.operationName,
                        error: String(error),
                    });
                    return {};
                },
            );

            this.stats.requests += 1;
            const send = this.options.transport ?? performRequest;
            const response = await send({
                url,
                headers: {
                    authorization: `Bearer ${X_PUBLIC_WEB_BEARER}`,
                    'x-guest-token': lease.value,
                    'x-twitter-active-user': 'yes',
                    'x-twitter-client-language': 'en',
                    'content-type': 'application/json',
                    ...dynamic,
                },
                proxyUrl: lease.proxyUrl,
                timeoutMs: this.options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
            });

            this.trackRateLimit(response);

            const outcome = this.interpret(call.operationName, response);
            if (outcome.ok) return outcome.data;
            lastError = outcome.error;

            // A missing feature switch is recoverable without spending an
            // attempt on backoff: add what X asked for and go again.
            const missing = missingFeaturesFrom(response.body);
            if (missing.length > 0) {
                for (const name of missing) this.negotiatedFeatures[name] = true;
                log.info('Negotiated new GraphQL feature switches', { added: missing });
                continue;
            }

            const kind = outcome.error.detail.kind;
            if (kind === 'auth-walled' || kind === 'fatal') {
                this.stats.fatalErrors += 1;
                throw outcome.error;
            }

            if (kind === 'rotate-token') {
                this.tokens.invalidate(lease.value);
                this.stats.tokenRotations += 1;
                continue;
            }

            if (kind === 'refresh-query-id') {
                this.queryIds.invalidate();
                this.stats.queryIdRefreshes += 1;
                continue;
            }

            this.stats.retryableErrors += 1;
            if (attempt < maxAttempts) {
                const delay = retryDelayMs(
                    attempt,
                    {
                        baseMs: this.options.backoffBaseMs ?? DEFAULTS.backoffBaseMs,
                        maxMs: this.options.backoffMaxMs ?? DEFAULTS.backoffMaxMs,
                    },
                    headerValue(response.headers, 'retry-after'),
                    this.options.random,
                );
                log.debug('Retrying after backoff', {
                    operation: call.operationName,
                    attempt,
                    delayMs: delay,
                });
                await (this.options.sleepFn ?? sleep)(delay);
            }
        }

        this.stats.fatalErrors += 1;
        throw (
            lastError ??
            new XApiError(`${call.operationName} failed after ${maxAttempts} attempts`, {
                operation: call.operationName,
                httpStatus: 0,
                apiCodes: [],
                kind: 'fatal',
                bodyPreview: '',
            })
        );
    }

    private buildUrl(queryId: string, call: GraphQLCall): string {
        const params = new URLSearchParams({
            variables: JSON.stringify(call.variables),
            features: JSON.stringify({
                ...DEFAULT_FEATURES,
                ...this.negotiatedFeatures,
                ...call.features,
            }),
            fieldToggles: JSON.stringify({
                ...DEFAULT_FIELD_TOGGLES,
                ...call.fieldToggles,
            }),
        });
        return `${GRAPHQL_BASE}/${queryId}/${call.operationName}?${params.toString()}`;
    }

    /** Turn a raw response into either parsed data or a classified error. */
    private interpret(
        operationName: string,
        response: HttpResponse,
    ): { ok: true; data: unknown } | { ok: false; error: XApiError } {
        const apiCodes = extractApiCodes(response.body);

        if (response.statusCode === 200 && apiCodes.length === 0) {
            try {
                const parsed: unknown = JSON.parse(response.body);
                const data =
                    typeof parsed === 'object' && parsed !== null
                        ? (parsed as { data?: unknown }).data
                        : undefined;
                if (data !== undefined) return { ok: true, data };
            } catch {
                // Fall through: a 200 that is not JSON is an edge-layer error page.
            }
        }

        const kind = classifyFailure(response.statusCode, response.body, apiCodes);
        const message =
            kind === 'auth-walled'
                ? `${operationName} is not available to guest tokens ` +
                  `(HTTP ${response.statusCode}, empty body). See docs/INVESTIGATION.md.`
                : `${operationName} failed: HTTP ${response.statusCode}` +
                  (apiCodes.length > 0 ? ` codes=[${apiCodes.join(', ')}]` : '');

        return {
            ok: false,
            error: new XApiError(message, {
                operation: operationName,
                httpStatus: response.statusCode,
                apiCodes,
                kind,
                bodyPreview: response.body.slice(0, 300),
            }),
        };
    }

    /**
     * Watch X's rate-limit headers.
     *
     * `x-rate-limit-remaining` reaching zero is a signal to stop using this
     * token *before* X starts rejecting requests — cheaper than absorbing a 429
     * and better manners toward the API (§7 politeness).
     */
    private trackRateLimit(response: HttpResponse): void {
        const remaining = headerValue(response.headers, 'x-rate-limit-remaining');
        if (remaining === undefined) return;
        const value = Number(remaining);
        if (Number.isFinite(value) && value <= 1) {
            this.stats.rateLimitHits += 1;
            log.debug('Guest token near its rate limit', { remaining: value });
        }
    }
}
