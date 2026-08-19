/**
 * Guest-token lifecycle (assessment §7).
 *
 * `UserTweets` allows 50 requests per token per window — the tightest limit of
 * the three operations and the binding constraint on the whole Actor. A run of
 * any size therefore outlives a single token, which makes rotation load-bearing
 * rather than decorative.
 *
 * The pool takes an injected fetcher, so all of this is testable without a
 * socket and without spending real activations.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    createGuestTokenFetcher,
    GuestTokenPool,
    readGuestToken,
    type GuestActivateInit,
} from '../src/x/guest-token.js';

/** Hands out token-1, token-2, … and counts activations. */
function countingFetcher() {
    let issued = 0;
    const fetcher = vi.fn(async () => `token-${++issued}`);
    return { fetcher, activations: () => issued };
}

describe('the pool is lazy', () => {
    it('mints nothing until asked', () => {
        const { fetcher } = countingFetcher();
        new GuestTokenPool(fetcher, { size: 3 });
        // A run that fetches one tweet should not pay for three activations.
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('mints one token per acquire until the pool is full', async () => {
        const { fetcher, activations } = countingFetcher();
        const pool = new GuestTokenPool(fetcher, { size: 3 });

        await pool.acquire();
        expect(activations()).toBe(1);
        await pool.acquire();
        await pool.acquire();
        expect(activations()).toBe(3);

        // Full: further acquires reuse rather than mint.
        await pool.acquire();
        await pool.acquire();
        expect(activations()).toBe(3);
    });
});

describe('rotation is least-recently-used', () => {
    it('cycles through the pool instead of hammering one token', async () => {
        const { fetcher } = countingFetcher();
        const pool = new GuestTokenPool(fetcher, { size: 3 });

        const first = [
            (await pool.acquire()).value,
            (await pool.acquire()).value,
            (await pool.acquire()).value,
        ];
        expect(new Set(first).size).toBe(3);

        // The next three should come back around in the same order.
        const second = [
            (await pool.acquire()).value,
            (await pool.acquire()).value,
            (await pool.acquire()).value,
        ];
        expect(second).toEqual(first);
    });
});

describe('a rejected token is retired', () => {
    it('never hands the same dead token out twice', async () => {
        const { fetcher, activations } = countingFetcher();
        const pool = new GuestTokenPool(fetcher, { size: 2 });

        const dead = await pool.acquire();
        await pool.acquire();
        expect(activations()).toBe(2);

        pool.invalidate(dead.value);

        // A replacement is minted, and the poisoned value is gone for good.
        const replacements = [
            (await pool.acquire()).value,
            (await pool.acquire()).value,
            (await pool.acquire()).value,
        ];
        expect(activations()).toBe(3);
        expect(replacements).not.toContain(dead.value);
    });

    it('ignores an unknown token rather than throwing', () => {
        const { fetcher } = countingFetcher();
        const pool = new GuestTokenPool(fetcher, { size: 1 });
        expect(() => { pool.invalidate('never-issued'); }).not.toThrow();
    });
});

describe('tokens age out', () => {
    it('replaces a token once it passes its TTL', async () => {
        const { fetcher, activations } = countingFetcher();
        let now = 1_000_000;
        const pool = new GuestTokenPool(fetcher, {
            size: 1, ttlMs: 60_000, now: () => now,
        });

        const before = await pool.acquire();
        expect(activations()).toBe(1);

        // Still fresh.
        now += 59_000;
        expect((await pool.acquire()).value).toBe(before.value);
        expect(activations()).toBe(1);

        // Past the TTL: evicted and replaced, well before X's observed expiry.
        now += 2_000;
        expect((await pool.acquire()).value).not.toBe(before.value);
        expect(activations()).toBe(2);
    });
});

describe('proxy affinity', () => {
    it('binds each token to the proxy it was minted through', async () => {
        // X ties a guest token to the IP that requested it, so a token minted
        // through one exit node must not be used from another.
        const proxies = ['http://a.proxy:8000', 'http://b.proxy:8000'];
        let i = 0;
        const pool = new GuestTokenPool(async () => `token-${i}`, {
            size: 2,
            nextProxyUrl: () => Promise.resolve(proxies[i++ % 2]),
        });

        const first = await pool.acquire();
        const second = await pool.acquire();
        expect(first.proxyUrl).toBe(proxies[0]);
        expect(second.proxyUrl).toBe(proxies[1]);
        expect(first.proxyUrl).not.toBe(second.proxyUrl);
    });

    it('reports no proxy when none is configured', async () => {
        const pool = new GuestTokenPool(async () => 'token');
        expect((await pool.acquire()).proxyUrl).toBeUndefined();
    });
});

describe('readGuestToken', () => {
    it('reads the token out of a real activation response', () => {
        expect(readGuestToken('{"guest_token":"2089881799644123357"}')).toBe(
            '2089881799644123357',
        );
    });

    it('returns undefined rather than throwing on anything else', () => {
        for (const body of ['', 'not json', '{}', 'null', '[]',
                            '{"guest_token":null}', '{"guest_token":""}',
                            '{"guest_token":123}']) {
            expect(readGuestToken(body)).toBeUndefined();
        }
    });
});

describe('createGuestTokenFetcher', () => {
    const ok = { statusCode: 200, body: '{"guest_token":"abc123"}' };

    it('POSTs to the activation endpoint with the public bearer', async () => {
        const request = vi.fn(async (_url: string, _init: GuestActivateInit) => ok);
        const token = await createGuestTokenFetcher(request)(undefined);

        expect(token).toBe('abc123');
        const call = request.mock.calls[0];
        expect(call).toBeDefined();
        const [url, init] = call!;
        expect(url).toContain('/1.1/guest/activate.json');
        expect(init.method).toBe('POST');
        expect(init.headers.authorization).toMatch(/^Bearer /);
    });

    it('passes the proxy through, so the token is bound to that exit', async () => {
        const request = vi.fn(async (_url: string, _init: GuestActivateInit) => ok);
        await createGuestTokenFetcher(request)('http://proxy:8000');
        expect(request.mock.calls[0]?.[1].proxyUrl).toBe('http://proxy:8000');
    });

    it('throws with the status when activation is refused', async () => {
        const request = vi.fn(async () => ({ statusCode: 403, body: 'denied' }));
        await expect(createGuestTokenFetcher(request)(undefined)).rejects.toThrow(/403/);
    });

    it('throws when the body is not what activation returns', async () => {
        const request = vi.fn(async () => ({ statusCode: 200, body: '{"unexpected":true}' }));
        await expect(createGuestTokenFetcher(request)(undefined)).rejects.toThrow(/unexpected/);
    });
});
