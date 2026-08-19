/**
 * The retry loop (assessment §3, §7).
 *
 * The brief is explicit that *"a run must not hard-crash on a single 429/403"*.
 * These tests drive the loop through every failure shape and assert the loop
 * reacts the way the classification says it should — including the two cases
 * where the correct reaction is to stop immediately, since retrying an auth wall
 * just burns the rate limit on a request that can never succeed.
 *
 * The transport, the clock and the jitter source are all injected, so the policy
 * runs deterministically and instantly.
 */

import { describe, expect, it, vi } from 'vitest';

import { XClient } from '../src/x/client.js';
import type { HttpRequest, HttpResponse } from '../src/x/http.js';
import type { GuestTokenPool } from '../src/x/guest-token.js';
import type { QueryIdResolver } from '../src/x/query-ids.js';

const OK_BODY = JSON.stringify({ data: { user: { result: { rest_id: '1' } } } });

function response(over: Partial<HttpResponse> = {}): HttpResponse {
    return { statusCode: 200, body: OK_BODY, headers: {}, ...over };
}

/** A pool that hands out token-1, token-2, … and records retirements. */
function fakePool() {
    let issued = 0;
    const retired: string[] = [];
    const pool = {
        acquire: vi.fn(async () => ({ value: `token-${++issued}`, proxyUrl: undefined })),
        invalidate: vi.fn((value: string) => retired.push(value)),
    };
    return { pool: pool as unknown as GuestTokenPool, retired, raw: pool };
}

function fakeResolver() {
    const resolver = {
        queryIdFor: vi.fn(async () => 'query-id-abc'),
        invalidate: vi.fn(),
    };
    return { resolver: resolver as unknown as QueryIdResolver, raw: resolver };
}

/** Builds a client whose transport replays a scripted sequence of responses. */
function clientOver(sequence: HttpResponse[], maxAttempts = 5) {
    const { pool, retired, raw: rawPool } = fakePool();
    const { resolver, raw: rawResolver } = fakeResolver();
    let i = 0;
    const transport = vi.fn(async (_req: HttpRequest) =>
        sequence[Math.min(i++, sequence.length - 1)]!,
    );
    const client = new XClient(pool, resolver, {
        maxAttempts,
        transport,
        sleepFn: async () => undefined, // no real waiting
        random: () => 0.5,
    });
    return { client, transport, retired, rawPool, rawResolver };
}

const call = { operationName: 'UserTweets', variables: { userId: '1' } };

describe('the happy path', () => {
    it('returns the data object on a 200', async () => {
        const { client, transport } = clientOver([response()]);
        await expect(client.execute(call)).resolves.toEqual({
            user: { result: { rest_id: '1' } },
        });
        expect(transport).toHaveBeenCalledTimes(1);
    });

    it('sends the guest token and the public bearer', async () => {
        const { client, transport } = clientOver([response()]);
        await client.execute(call);
        const sent = transport.mock.calls[0]![0];
        expect(sent.headers?.['x-guest-token']).toBe('token-1');
        expect(sent.headers?.authorization).toMatch(/^Bearer /);
    });

    it('composes the URL as base/queryId/operationName', async () => {
        const { client, transport } = clientOver([response()]);
        await client.execute(call);
        expect(transport.mock.calls[0]![0].url).toContain('/query-id-abc/UserTweets?');
    });
});

describe('retryable failures back off and try again', () => {
    it('recovers from a 429', async () => {
        const { client, transport } = clientOver([
            response({ statusCode: 429, body: '' }),
            response(),
        ]);
        await expect(client.execute(call)).resolves.toBeDefined();
        // A single 429 costs a retry, not the run.
        expect(transport).toHaveBeenCalledTimes(2);
        expect(client.stats.retryableErrors).toBe(1);
    });

    it('recovers from a 5xx', async () => {
        const { client } = clientOver([response({ statusCode: 503, body: '' }), response()]);
        await expect(client.execute(call)).resolves.toBeDefined();
    });

    it('gives up after the attempt budget and reports the last failure', async () => {
        const { client, transport } = clientOver([response({ statusCode: 500, body: '' })], 3);
        await expect(client.execute(call)).rejects.toThrow(/HTTP 500/);
        expect(transport).toHaveBeenCalledTimes(3);
    });

    it('honours retry-after instead of its own backoff', async () => {
        const slept: number[] = [];
        const { pool } = fakePool();
        const { resolver } = fakeResolver();
        let i = 0;
        const seq = [
            response({ statusCode: 429, body: '', headers: { 'retry-after': '3' } }),
            response(),
        ];
        const client = new XClient(pool, resolver, {
            transport: async () => seq[i++]!,
            sleepFn: async (ms) => { slept.push(ms); },
        });

        await client.execute(call);
        expect(slept).toEqual([3000]);
    });
});

describe('a dead token is rotated, not retried blindly', () => {
    it.each([89, 239, 326])('retires the token on error code %i', async (code) => {
        const { client, retired, rawPool } = clientOver([
            response({ statusCode: 403, body: JSON.stringify({ errors: [{ code }] }) }),
            response(),
        ]);

        await expect(client.execute(call)).resolves.toBeDefined();
        expect(retired).toEqual(['token-1']);
        // And the retry went out on a different token.
        expect(rawPool.acquire).toHaveBeenCalledTimes(2);
        expect(client.stats.tokenRotations).toBe(1);
    });

    it('does not sleep before retrying with a fresh token', async () => {
        const slept: number[] = [];
        const { pool } = fakePool();
        const { resolver } = fakeResolver();
        let i = 0;
        const seq = [response({ statusCode: 401, body: '' }), response()];
        const client = new XClient(pool, resolver, {
            transport: async () => seq[i++]!,
            sleepFn: async (ms) => { slept.push(ms); },
        });

        await client.execute(call);
        // Rotation fixes the cause immediately; backing off would just be slow.
        expect(slept).toEqual([]);
    });
});

describe('a rotated query ID triggers re-resolution', () => {
    it('invalidates the resolver and retries', async () => {
        const { client, rawResolver } = clientOver([
            response({ statusCode: 404, body: '{"message":"Query not found"}' }),
            response(),
        ]);

        await expect(client.execute(call)).resolves.toBeDefined();
        expect(rawResolver.invalidate).toHaveBeenCalledTimes(1);
        expect(client.stats.queryIdRefreshes).toBe(1);
    });
});

describe('terminal failures stop immediately', () => {
    it('does not retry the guest auth wall', async () => {
        // 404 with an empty body means X knows the operation and declines to
        // serve it. Retrying can only waste the rate limit.
        const { client, transport } = clientOver([response({ statusCode: 404, body: '' })]);

        await expect(client.execute(call)).rejects.toThrow(/not available to guest tokens/);
        expect(transport).toHaveBeenCalledTimes(1);
        expect(client.stats.fatalErrors).toBe(1);
    });

    it('does not retry a fatal error', async () => {
        const { client, transport } = clientOver([
            response({ statusCode: 400, body: '{"errors":[]}' }),
        ]);
        await expect(client.execute(call)).rejects.toThrow(/HTTP 400/);
        expect(transport).toHaveBeenCalledTimes(1);
    });

    it('carries the classification on the thrown error', async () => {
        const { client } = clientOver([response({ statusCode: 404, body: '' })]);
        await client.execute(call).catch((error: unknown) => {
            expect(error).toMatchObject({
                name: 'XApiError',
                detail: { kind: 'auth-walled', operation: 'UserTweets', httpStatus: 404 },
            });
        });
        expect.assertions(1);
    });
});

describe('feature-switch negotiation', () => {
    it('adds the switch X named and retries without spending a backoff', async () => {
        const rejection = JSON.stringify({
            errors: [{ message: 'The following features cannot be null: brand_new_flag' }],
        });
        const slept: number[] = [];
        const { pool } = fakePool();
        const { resolver } = fakeResolver();
        let i = 0;
        const seq = [response({ statusCode: 400, body: rejection }), response()];
        const transport = vi.fn(async (_req: HttpRequest) => seq[i++]!);
        const client = new XClient(pool, resolver, {
            transport,
            sleepFn: async (ms) => { slept.push(ms); },
        });

        await expect(client.execute(call)).resolves.toBeDefined();
        expect(slept).toEqual([]);

        // The retry carries the flag X asked for, so a newly-shipped switch
        // heals within one request instead of needing a redeploy.
        const retried = transport.mock.calls[1]![0].url;
        expect(decodeURIComponent(retried)).toContain('"brand_new_flag":true');
    });
});

describe('dynamic headers', () => {
    it('merges the provider output over the static headers', async () => {
        const { pool } = fakePool();
        const { resolver } = fakeResolver();
        const transport = vi.fn(async (_req: HttpRequest) => response());
        const client = new XClient(pool, resolver, {
            transport,
            dynamicHeaders: async () => ({ 'x-client-transaction-id': 'computed-value' }),
        });

        await client.execute(call);
        expect(transport.mock.calls[0]![0].headers?.['x-client-transaction-id']).toBe(
            'computed-value',
        );
    });

    it('recomputes per attempt, since such values are single-use', async () => {
        let n = 0;
        const { pool } = fakePool();
        const { resolver } = fakeResolver();
        let i = 0;
        const seq = [response({ statusCode: 429, body: '' }), response()];
        const transport = vi.fn(async (_req: HttpRequest) => seq[i++]!);
        const client = new XClient(pool, resolver, {
            transport,
            sleepFn: async () => undefined,
            dynamicHeaders: async () => ({ 'x-nonce': `value-${++n}` }),
        });

        await client.execute(call);
        expect(transport.mock.calls[0]![0].headers?.['x-nonce']).toBe('value-1');
        expect(transport.mock.calls[1]![0].headers?.['x-nonce']).toBe('value-2');
    });

    it('sends the request anyway when the provider throws', async () => {
        const { pool } = fakePool();
        const { resolver } = fakeResolver();
        const transport = vi.fn(async (_req: HttpRequest) => response());
        const client = new XClient(pool, resolver, {
            transport,
            dynamicHeaders: () => Promise.reject(new Error('cannot compute')),
        });

        // Degrade rather than fail: the header may not even be required.
        await expect(client.execute(call)).resolves.toBeDefined();
    });
});

describe('observability', () => {
    it('counts every request, including the retries', async () => {
        const { client } = clientOver([response({ statusCode: 500, body: '' })], 4);
        await client.execute(call).catch(() => undefined);
        expect(client.stats.requests).toBe(4);
    });

    it('notices a token nearing its rate limit before X starts refusing', async () => {
        const { client } = clientOver([
            response({ headers: { 'x-rate-limit-remaining': '0' } }),
        ]);
        await client.execute(call);
        expect(client.stats.rateLimitHits).toBe(1);
    });

    it('stays quiet while the token has budget left', async () => {
        const { client } = clientOver([
            response({ headers: { 'x-rate-limit-remaining': '42' } }),
        ]);
        await client.execute(call);
        expect(client.stats.rateLimitHits).toBe(0);
    });
});

describe('malformed successes', () => {
    it('treats a 200 that is not JSON as a failure rather than returning garbage', async () => {
        const { client } = clientOver([
            response({ body: '<html>edge error page</html>' }),
        ]);
        await expect(client.execute(call)).rejects.toThrow();
    });

    it('treats a 200 carrying GraphQL errors as a failure', async () => {
        const { client } = clientOver([
            response({ body: JSON.stringify({ errors: [{ code: 88 }] }) }),
        ]);
        await expect(client.execute(call)).rejects.toThrow();
    });
});
