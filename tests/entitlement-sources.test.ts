/**
 * The two entitlement authorities (assessment §6).
 *
 * Both answer the same question — may this run emit more than the free
 * allowance — and both must be wrong in only one direction. Every ambiguous
 * outcome has to resolve to *free*, because the alternative is handing out the
 * paid product to anyone who can make a request fail.
 *
 * The distinction these tests pin hardest is between "not entitled" and "could
 * not tell". The first is an answer and ends the chain; the second is a failure
 * and must let the next authority speak. Collapsing them either caps paying
 * customers or opens the gate.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HttpRequest, HttpResponse } from '../src/x/http.js';

const performRequest = vi.fn<(request: HttpRequest) => Promise<HttpResponse>>();

vi.mock('../src/x/http.js', () => ({ performRequest: (r: HttpRequest) => performRequest(r) }));
vi.mock('apify', () => ({
    log: { info: vi.fn(), warning: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { SignedEndpointSource, signedEndpointConfigFromEnv } = await import(
    '../src/entitlements/stores/http-endpoint.js'
);
const { KeyValueStoreSource, keyValueConfigFromEnv } = await import(
    '../src/entitlements/stores/apify-kv.js'
);
const { sign } = await import('../src/entitlements/verify.js');

const SECRET = 'author-only-secret';
const VERIFIED = { userId: 'user-123', verified: true, note: null };
const UNVERIFIED = { userId: 'user-123', verified: false, note: 'mismatch' };

function response(over: Partial<HttpResponse> = {}): HttpResponse {
    return { statusCode: 200, body: '', headers: {}, ...over };
}

beforeEach(() => {
    performRequest.mockReset();
});

describe('reading configuration from the environment', () => {
    it('builds the endpoint config when both halves are present', () => {
        expect(
            signedEndpointConfigFromEnv({ ENTITLEMENTS_URL: 'https://e/x', ENTITLEMENTS_SECRET: 's' }),
        ).toEqual({ url: 'https://e/x', secret: 's' });
    });

    it('refuses a half-configured endpoint rather than running without a secret', () => {
        // A URL with no signing key would accept any answer on the wire.
        expect(signedEndpointConfigFromEnv({ ENTITLEMENTS_URL: 'https://e/x' })).toBeNull();
        expect(signedEndpointConfigFromEnv({ ENTITLEMENTS_SECRET: 's' })).toBeNull();
        expect(signedEndpointConfigFromEnv({})).toBeNull();
        expect(signedEndpointConfigFromEnv({ ENTITLEMENTS_URL: '', ENTITLEMENTS_SECRET: 's' }))
            .toBeNull();
    });

    it('builds the key-value config only with both store and token', () => {
        expect(
            keyValueConfigFromEnv({ ENTITLEMENTS_KV_STORE: 'store', ENTITLEMENTS_API_TOKEN: 't' }),
        ).toEqual({ storeId: 'store', token: 't' });
        expect(keyValueConfigFromEnv({ ENTITLEMENTS_KV_STORE: 'store' })).toBeNull();
        expect(keyValueConfigFromEnv({})).toBeNull();
    });
});

describe('SignedEndpointSource', () => {
    const source = new SignedEndpointSource({ url: 'https://entitlements/api', secret: SECRET });

    /** Replies the way the deployed service does, echoing the run's nonce. */
    function replyWith(tier: 'free' | 'paid', cap: number, overrides: Record<string, unknown> = {}) {
        performRequest.mockImplementation(async (request) => {
            const nonce = request.headers?.['x-entitlement-nonce'] ?? '';
            const claim = {
                userId: 'user-123', tier, cap,
                issuedAt: new Date().toISOString(), nonce,
                ...overrides,
            };
            return response({
                body: JSON.stringify({ claim, signature: sign(claim, SECRET) }),
            });
        });
    }

    it('never asks about an identity that did not verify', async () => {
        const entitlement = await source.resolve(UNVERIFIED);
        expect(performRequest).not.toHaveBeenCalled();
        expect(entitlement).toMatchObject({ tier: 'free', reason: 'identity_unverified' });
    });

    it('grants a verified paid claim', async () => {
        replyWith('paid', 100_000);
        await expect(source.resolve(VERIFIED)).resolves.toMatchObject({
            tier: 'paid', cap: 100_000, reason: 'entitled', source: 'signed-endpoint',
        });
    });

    it('sends a fresh challenge on every call', async () => {
        replyWith('paid', 100_000);
        await source.resolve(VERIFIED);
        await source.resolve(VERIFIED);

        const first = performRequest.mock.calls[0]?.[0].headers?.['x-entitlement-nonce'];
        const second = performRequest.mock.calls[1]?.[0].headers?.['x-entitlement-nonce'];
        // A reused challenge would make an old captured reply valid forever.
        expect(first).toBeTruthy();
        expect(first).not.toBe(second);
    });

    it('reports a verified free answer as an answer, not a failure', async () => {
        replyWith('free', 10);
        await expect(source.resolve(VERIFIED)).resolves.toMatchObject({
            tier: 'free', reason: 'not_entitled', source: 'signed-endpoint',
        });
    });

    it('floors a paid claim at the free allowance, never below', async () => {
        replyWith('paid', 2);
        await expect(source.resolve(VERIFIED)).resolves.toMatchObject({ cap: 10 });
    });

    it('denies outright when the signature does not verify', async () => {
        performRequest.mockResolvedValue(
            response({
                body: JSON.stringify({
                    claim: { userId: 'user-123', tier: 'paid', cap: 99_999,
                             issuedAt: new Date().toISOString(), nonce: 'x' },
                    signature: 'forged',
                }),
            }),
        );

        // Something answering that should not be is worse than nothing
        // answering, so this does not fall through to the next authority.
        await expect(source.resolve(VERIFIED)).resolves.toMatchObject({
            tier: 'free', reason: 'signature_invalid', source: 'fail-closed',
        });
    });

    it('denies a correctly signed reply to a different challenge', async () => {
        performRequest.mockImplementation(async () => {
            const claim = { userId: 'user-123', tier: 'paid' as const, cap: 100_000,
                            issuedAt: new Date().toISOString(), nonce: 'some-old-nonce' };
            return response({ body: JSON.stringify({ claim, signature: sign(claim, SECRET) }) });
        });
        await expect(source.resolve(VERIFIED)).resolves.toMatchObject({
            reason: 'signature_invalid',
        });
    });

    it('returns null when the service is unreachable, so the chain continues', async () => {
        performRequest.mockRejectedValue(new Error('ECONNREFUSED'));
        // Not an answer — the fallback authority should get its turn.
        await expect(source.resolve(VERIFIED)).resolves.toBeNull();
    });

    it('returns null on a non-200', async () => {
        performRequest.mockResolvedValue(response({ statusCode: 500, body: 'boom' }));
        await expect(source.resolve(VERIFIED)).resolves.toBeNull();
    });

    it('identifies the user in the request it sends', async () => {
        replyWith('paid', 100_000);
        await source.resolve(VERIFIED);
        const sent = performRequest.mock.calls[0]?.[0];
        expect(sent?.method).toBe('POST');
        expect(sent?.headers?.['x-entitlement-user-id']).toBe('user-123');
    });
});

describe('KeyValueStoreSource', () => {
    const source = new KeyValueStoreSource({ storeId: 'entitlements', token: 'author-token' });

    it('never asks about an identity that did not verify', async () => {
        await expect(source.resolve(UNVERIFIED)).resolves.toMatchObject({
            tier: 'free', reason: 'identity_unverified',
        });
        expect(performRequest).not.toHaveBeenCalled();
    });

    it('grants a paid record', async () => {
        performRequest.mockResolvedValue(
            response({ body: JSON.stringify({ tier: 'paid', cap: 50_000 }) }),
        );
        await expect(source.resolve(VERIFIED)).resolves.toMatchObject({
            tier: 'paid', cap: 50_000, source: 'key-value-store',
        });
    });

    it('treats a missing record as a definitive "not entitled"', async () => {
        performRequest.mockResolvedValue(response({ statusCode: 404 }));
        // 404 here means the author never provisioned this user — an answer,
        // not an outage, so the chain should stop.
        await expect(source.resolve(VERIFIED)).resolves.toMatchObject({
            tier: 'free', reason: 'not_entitled', source: 'key-value-store',
        });
    });

    it('reads the record with the author\'s token, keyed by user ID', async () => {
        performRequest.mockResolvedValue(
            response({ body: JSON.stringify({ tier: 'paid', cap: 1000 }) }),
        );
        await source.resolve(VERIFIED);
        const sent = performRequest.mock.calls[0]?.[0];
        expect(sent?.url).toContain('/key-value-stores/entitlements/records/user-123');
        expect(sent?.headers?.authorization).toBe('Bearer author-token');
    });

    it('returns null when the store is unreachable', async () => {
        performRequest.mockRejectedValue(new Error('timeout'));
        await expect(source.resolve(VERIFIED)).resolves.toBeNull();
    });

    it('returns null on a malformed record rather than guessing', async () => {
        for (const body of ['not json', '{}', '{"tier":"platinum"}', 'null']) {
            performRequest.mockResolvedValue(response({ body }));
            await expect(source.resolve(VERIFIED)).resolves.toBeNull();
        }
    });

    it('floors a paid record with a nonsense cap at the free allowance', async () => {
        performRequest.mockResolvedValue(
            response({ body: JSON.stringify({ tier: 'paid', cap: -5 }) }),
        );
        await expect(source.resolve(VERIFIED)).resolves.toMatchObject({ cap: 10 });
    });
});
