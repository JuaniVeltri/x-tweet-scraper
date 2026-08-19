/**
 * Guest-token lifecycle: acquire, cache, rotate, refresh (assessment §7).
 *
 * A guest token is what turns the public web bearer into a usable session for
 * anonymous reads. X meters them per token, and the binding limit measured on
 * the live API is `UserTweets` at 50 requests per window — so a run of any size
 * outlives a single token. This pool therefore holds several tokens, hands out
 * the least-recently-used one, and retires a token the moment X signals it is
 * dead (codes 89 / 239 / 326, or a 401/403).
 *
 * Tokens are also bound to the IP that requested them, so each is acquired
 * through the same proxy session it will later be used with.
 */

import { log } from 'apify';

import { DEFAULTS, GUEST_ACTIVATE_URL, X_PUBLIC_WEB_BEARER } from '../config/constants.js';
import { ScraperError } from '../util/errors.js';

/** One pooled token plus the bookkeeping needed to rotate it fairly. */
interface PooledToken {
    readonly value: string;
    readonly acquiredAt: number;
    /** Proxy URL this token was minted through; reused for affinity. */
    readonly proxyUrl: string | undefined;
    /**
     * Monotonic lease counter, not a timestamp.
     *
     * Wall-clock time is the wrong ordering key here: a run issues several
     * requests inside the same millisecond, which gives every token an identical
     * `Date.now()` and makes a strict `<` comparison never true. The pool then
     * hands out the first token forever — rotation silently stops, one token
     * absorbs the whole 50-per-window budget, and the rest sit idle.
     */
    lastUsedSeq: number;
    uses: number;
}

/** Issues a raw guest token. Injectable so tests never touch the network. */
export type GuestTokenFetcher = (proxyUrl: string | undefined) => Promise<string>;

export interface GuestTokenPoolOptions {
    readonly size?: number;
    readonly ttlMs?: number;
    /** Supplies a proxy URL per token, or `undefined` for a direct connection. */
    readonly nextProxyUrl?: () => Promise<string | undefined>;
    readonly now?: () => number;
}

/**
 * A rotating pool of guest tokens.
 *
 * Acquisition is lazy: tokens are minted on demand up to `size`, so a run that
 * only fetches one tweet never pays for three activations.
 */
export class GuestTokenPool {
    private readonly tokens: PooledToken[] = [];
    private readonly size: number;
    private readonly ttlMs: number;
    private readonly nextProxyUrl: () => Promise<string | undefined>;
    private readonly now: () => number;
    private acquisitions = 0;
    /** Ticks once per lease; the ordering key for LRU rotation. */
    private leaseSeq = 0;

    constructor(
        private readonly fetchToken: GuestTokenFetcher,
        options: GuestTokenPoolOptions = {},
    ) {
        this.size = options.size ?? DEFAULTS.guestTokenPoolSize;
        this.ttlMs = options.ttlMs ?? DEFAULTS.guestTokenTtlMs;
        // No proxy configured: every token is minted over a direct connection.
        this.nextProxyUrl = options.nextProxyUrl ?? (() => Promise.resolve(undefined));
        this.now = options.now ?? Date.now;
    }

    /** Total activations performed, for the run summary. */
    get activationCount(): number {
        return this.acquisitions;
    }

    /**
     * Least-recently-used live token, minting one if the pool is cold or every
     * token has aged out.
     */
    async acquire(): Promise<GuestTokenLease> {
        this.evictExpired();

        if (this.tokens.length < this.size) {
            return this.lease(await this.mint());
        }

        let lru = this.tokens[0];
        /* istanbul ignore next -- pool is never empty at this point */
        if (lru === undefined) return this.lease(await this.mint());
        for (const token of this.tokens) {
            if (token.lastUsedSeq < lru.lastUsedSeq) lru = token;
        }
        return this.lease(lru);
    }

    /**
     * Retire a token X has rejected. The next `acquire` mints a replacement, so
     * a poisoned token can never be handed out twice.
     */
    invalidate(value: string): void {
        const index = this.tokens.findIndex((token) => token.value === value);
        if (index === -1) return;
        this.tokens.splice(index, 1);
        log.debug('Guest token invalidated', { remaining: this.tokens.length });
    }

    private lease(token: PooledToken): GuestTokenLease {
        token.lastUsedSeq = ++this.leaseSeq;
        token.uses += 1;
        return { value: token.value, proxyUrl: token.proxyUrl };
    }

    private async mint(): Promise<PooledToken> {
        const proxyUrl = await this.nextProxyUrl();
        const value = await this.fetchToken(proxyUrl);
        this.acquisitions += 1;
        const token: PooledToken = {
            value,
            proxyUrl,
            acquiredAt: this.now(),
            lastUsedSeq: ++this.leaseSeq,
            uses: 0,
        };
        this.tokens.push(token);
        log.debug('Guest token acquired', { poolSize: this.tokens.length });
        return token;
    }

    private evictExpired(): void {
        const cutoff = this.now() - this.ttlMs;
        for (let i = this.tokens.length - 1; i >= 0; i -= 1) {
            const token = this.tokens[i];
            if (token !== undefined && token.acquiredAt < cutoff) this.tokens.splice(i, 1);
        }
    }
}

/** A token handed to a caller, along with the proxy it is bound to. */
export interface GuestTokenLease {
    readonly value: string;
    readonly proxyUrl: string | undefined;
}

/**
 * Default fetcher: `POST /1.1/guest/activate.json` with the public web bearer.
 *
 * @param request Injected HTTP function, so this module stays free of a
 *   transport dependency and is trivially testable.
 */
export function createGuestTokenFetcher(
    request: (url: string, init: GuestActivateInit) => Promise<{ statusCode: number; body: string }>,
): GuestTokenFetcher {
    return async (proxyUrl) => {
        const response = await request(GUEST_ACTIVATE_URL, {
            method: 'POST',
            proxyUrl,
            headers: { authorization: `Bearer ${X_PUBLIC_WEB_BEARER}` },
        });

        if (response.statusCode !== 200) {
            throw new ScraperError(
                `Guest token activation failed with HTTP ${response.statusCode}: ` +
                    response.body.slice(0, 200),
            );
        }

        const token = readGuestToken(response.body);
        if (token === undefined) {
            throw new ScraperError(
                `Guest token activation returned an unexpected body: ${response.body.slice(0, 200)}`,
            );
        }
        return token;
    };
}

export interface GuestActivateInit {
    readonly method: 'POST';
    readonly proxyUrl: string | undefined;
    readonly headers: Readonly<Record<string, string>>;
}

/** Extract `guest_token` from an activation response. Exported for tests. */
export function readGuestToken(body: string): string | undefined {
    try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed !== 'object' || parsed === null) return undefined;
        const token = (parsed as { guest_token?: unknown }).guest_token;
        return typeof token === 'string' && token.length > 0 ? token : undefined;
    } catch {
        return undefined;
    }
}
