/**
 * HTTP transport.
 *
 * Deliberately thin: it performs one request and reports what happened. All
 * retry, backoff, token rotation and query-ID refresh logic lives in
 * `client.ts`, so that policy is testable without a socket and this module
 * stays the only place that knows about the HTTP library.
 *
 * `got-scraping` is used rather than bare `fetch` because it reproduces a real
 * browser's TLS/HTTP2 fingerprint and header ordering. That matters here: X's
 * edge fingerprints clients, and the assessment forbids running an actual
 * browser (§3) — so the request has to look right without one.
 */

import { gotScraping } from 'got-scraping';

import { DEFAULTS, DEFAULT_USER_AGENT, X_WEB_ORIGIN } from '../config/constants.js';

export interface HttpRequest {
    readonly url: string;
    readonly method?: 'GET' | 'POST';
    readonly headers?: Readonly<Record<string, string>>;
    readonly proxyUrl?: string | undefined;
    readonly timeoutMs?: number;
    /** Request body, for POSTs. Callers set their own `content-type`. */
    readonly body?: string;
}

export interface HttpResponse {
    readonly statusCode: number;
    readonly body: string;
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * Headers X's edge expects from a logged-out web client.
 *
 * `origin` and `referer` are not optional decoration: requests to
 * `api.x.com` are cross-origin from `x.com`, and the edge rejects GraphQL
 * calls that arrive without them.
 */
export function browserHeaders(): Record<string, string> {
    return {
        'user-agent': DEFAULT_USER_AGENT,
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        origin: X_WEB_ORIGIN,
        referer: `${X_WEB_ORIGIN}/`,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
    };
}

/**
 * Perform a single request. Never throws on a non-2xx status — the status is
 * data that the caller's classifier needs.
 */
export async function performRequest(request: HttpRequest): Promise<HttpResponse> {
    const response = await gotScraping({
        url: request.url,
        method: request.method ?? 'GET',
        headers: { ...browserHeaders(), ...request.headers },
        // Only set `proxyUrl` when there is one: under
        // `exactOptionalPropertyTypes` an explicit `undefined` is not the same
        // as an absent key, and got-scraping's option type rejects it.
        ...(request.proxyUrl !== undefined ? { proxyUrl: request.proxyUrl } : {}),
        ...(request.body !== undefined ? { body: request.body } : {}),
        timeout: { request: request.timeoutMs ?? DEFAULTS.requestTimeoutMs },
        // Retries are this project's own concern; the library must not
        // second-guess them or the backoff policy becomes unobservable.
        retry: { limit: 0 },
        throwHttpErrors: false,
        responseType: 'text',
        followRedirect: true,
    });

    return {
        statusCode: response.statusCode,
        body: typeof response.body === 'string' ? response.body : String(response.body),
        headers: response.headers,
    };
}

/** Read a response header as a single string, collapsing the array form. */
export function headerValue(
    headers: HttpResponse['headers'],
    name: string,
): string | undefined {
    const value = headers[name.toLowerCase()];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value[0];
    return undefined;
}

/** Fetch a URL as text, for bundle/dump retrieval. Throws on non-2xx. */
export async function fetchText(url: string, proxyUrl?: string  ): Promise<string> {
    const response = await performRequest({
        url,
        proxyUrl,
        headers: { accept: 'text/html,application/xhtml+xml,application/json,*/*;q=0.8' },
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`GET ${url} failed with HTTP ${response.statusCode}`);
    }
    return response.body;
}
