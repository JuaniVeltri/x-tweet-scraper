/**
 * Free-tier enforcement (assessment §6, and the test §7 explicitly requires:
 * *"prove a free user with maxResults: 1000 still gets 10"*).
 *
 * These tests take the adversary's side. Each one is an attempt to obtain more
 * than 10 items through a channel the user actually controls — input values,
 * undocumented fields, environment variables, a downed entitlements service, a
 * forged response — and asserts that the attempt fails closed.
 */

import { describe, expect, it } from 'vitest';

import { FREE_TIER_CAP } from '../src/config/constants.js';
import { effectiveCap, resolveEntitlement, FAIL_CLOSED } from '../src/entitlements/resolver.js';
import type { Entitlement, EntitlementSource, RunIdentity } from '../src/entitlements/types.js';
import { canonicalize, sign, verifyResponse } from '../src/entitlements/verify.js';
import { ResultEmitter } from '../src/pipeline/emitter.js';
import type { OutputTweet } from '../src/output/types.js';

const VERIFIED: RunIdentity = { userId: 'user-123', verified: true, note: null };
const UNVERIFIED: RunIdentity = {
    userId: 'user-123',
    verified: false,
    note: 'claimed ID did not match the platform run record',
};

const FREE: Entitlement = {
    tier: 'free',
    cap: FREE_TIER_CAP,
    reason: 'not_entitled',
    source: 'signed-endpoint',
};
const PAID: Entitlement = {
    tier: 'paid',
    cap: 100_000,
    reason: 'entitled',
    source: 'signed-endpoint',
};

function tweet(id: number): OutputTweet {
    return {
        id: String(id),
        url: `https://x.com/someone/status/${id}`,
        text: `tweet ${id}`,
        lang: 'en',
        createdAt: '2026-08-19T00:00:00.000Z',
        conversationId: null,
        isReply: false,
        isRetweet: false,
        isQuote: false,
        inReplyToId: null,
        quotedTweetId: null,
        author: {
            id: '1',
            username: 'someone',
            name: 'Someone',
            verified: false,
            followers: 1,
            following: 1,
        },
        metrics: { likes: 0, retweets: 0, replies: 0, quotes: 0, bookmarks: null, views: null },
        entities: { hashtags: [], mentions: [], urls: [], media: [] },
        source: null,
        scrapedAt: '2026-08-19T00:00:00.000Z',
    };
}

/** Collects everything that reaches the "dataset". */
function recordingSink(): { items: OutputTweet[]; sink: (i: readonly OutputTweet[]) => Promise<void> } {
    const items: OutputTweet[] = [];
    return {
        items,
        sink: async (batch) => {
            items.push(...batch);
        },
    };
}

/** Feed an emitter more items than it could ever accept. */
async function drain(emitter: ResultEmitter, supply = 5_000): Promise<void> {
    for (let i = 0; i < supply; i += 1) {
        if (!(await emitter.offer(tweet(i)))) break;
    }
    await emitter.finalize();
}

describe('the required proof: free user, maxResults 1000', () => {
    it('emits exactly 10 items', async () => {
        const { items, sink } = recordingSink();
        const emitter = new ResultEmitter(FREE, 1000, { sink, batchSize: 7 });

        await drain(emitter);

        expect(emitter.count).toBe(10);
        expect(items).toHaveLength(10);
        expect(emitter.wasLimitedByEntitlement).toBe(true);
    });
});

describe('input cannot lift the cap', () => {
    for (const requested of [11, 100, 1000, 1_000_000, Number.MAX_SAFE_INTEGER]) {
        it(`maxResults: ${requested} still yields ${FREE_TIER_CAP}`, async () => {
            const { items, sink } = recordingSink();
            const emitter = new ResultEmitter(FREE, requested, { sink });
            await drain(emitter);
            expect(items).toHaveLength(FREE_TIER_CAP);
        });
    }

    it('a smaller maxResults still narrows the run', async () => {
        const { items, sink } = recordingSink();
        const emitter = new ResultEmitter(FREE, 3, { sink });
        await drain(emitter);
        // The request may lower the ceiling; it may never raise it.
        expect(items).toHaveLength(3);
    });

    it('closes the emitter as soon as the limit is reached, stopping the fetch loop', async () => {
        const emitter = new ResultEmitter(FREE, 1000, { sink: async () => undefined });
        for (let i = 0; i < FREE_TIER_CAP; i += 1) await emitter.offer(tweet(i));
        expect(emitter.isOpen).toBe(false);
        expect(emitter.remaining).toBe(0);
    });

    it('refuses items offered in bulk past the limit', async () => {
        const { items, sink } = recordingSink();
        const emitter = new ResultEmitter(FREE, 1000, { sink });
        const accepted = await emitter.offerAll(
            Array.from({ length: 500 }, (_unused, i) => tweet(i)),
        );
        await emitter.finalize();
        expect(accepted).toBe(FREE_TIER_CAP);
        expect(items).toHaveLength(FREE_TIER_CAP);
    });
});

describe('a paid entitlement is honoured', () => {
    it('emits up to the requested count', async () => {
        const { items, sink } = recordingSink();
        const emitter = new ResultEmitter(PAID, 250, { sink });
        await drain(emitter, 400);
        expect(items).toHaveLength(250);
        expect(emitter.wasLimitedByEntitlement).toBe(false);
    });

    it('never exceeds the entitled ceiling either', () => {
        const modest: Entitlement = { ...PAID, cap: 42 };
        expect(effectiveCap(modest, 1_000_000)).toBe(42);
    });
});

describe('the "limited" flag reports honestly', () => {
    it('is true when the entitlement is what truncated the run', async () => {
        const emitter = new ResultEmitter(FREE, 25, { sink: async () => undefined });
        await drain(emitter);
        // Asked for 25, entitled to 10, and the supply had more to give.
        expect(emitter.count).toBe(FREE_TIER_CAP);
        expect(emitter.wasLimitedByEntitlement).toBe(true);
    });

    it('is false when the request was the lower ceiling', async () => {
        const emitter = new ResultEmitter(FREE, 4, { sink: async () => undefined });
        await drain(emitter);
        // The user asked for less than they were entitled to; the cap is not
        // what shortened this run, so claiming otherwise would be misleading.
        expect(emitter.count).toBe(4);
        expect(emitter.wasLimitedByEntitlement).toBe(false);
    });

    it('is false when the run simply ran out of tweets', async () => {
        const emitter = new ResultEmitter(FREE, 1000, { sink: async () => undefined });
        // Only three tweets exist; the cap was never reached.
        await emitter.offerAll([tweet(1), tweet(2), tweet(3)]);
        await emitter.finalize();
        expect(emitter.count).toBe(3);
        expect(emitter.wasLimitedByEntitlement).toBe(false);
    });

    it('is false for a paid run that fits inside its entitlement', async () => {
        const emitter = new ResultEmitter(PAID, 50, { sink: async () => undefined });
        await drain(emitter, 100);
        expect(emitter.wasLimitedByEntitlement).toBe(false);
    });
});

describe('resolution fails closed', () => {
    const failing: Record<string, EntitlementSource> = {
        'the service is down': {
            name: 'signed-endpoint',
            resolve: async () => null,
        },
        'the service throws': {
            name: 'signed-endpoint',
            resolve: () => Promise.reject(new Error('ECONNREFUSED')),
        },
        'the service denies': {
            name: 'signed-endpoint',
            resolve: async () => FREE,
        },
    };

    for (const [label, source] of Object.entries(failing)) {
        it(`caps the run when ${label}`, async () => {
            const entitlement = await resolveEntitlement({
                identity: VERIFIED,
                sources: [source],
            });
            expect(entitlement.tier).toBe('free');
            expect(entitlement.cap).toBe(FREE_TIER_CAP);
        });
    }

    it('caps the run when no authority is configured at all', async () => {
        const entitlement = await resolveEntitlement({ identity: VERIFIED, sources: [] });
        expect(entitlement).toEqual(FAIL_CLOSED);
    });

    it('caps the run when the identity does not verify', async () => {
        const generous: EntitlementSource = {
            name: 'signed-endpoint',
            resolve: async () => PAID,
        };
        const entitlement = await resolveEntitlement({
            identity: UNVERIFIED,
            sources: [generous],
        });
        // An unverified identity must never even be asked about.
        expect(entitlement.tier).toBe('free');
        expect(entitlement.reason).toBe('identity_unverified');
    });
});

describe('claims cannot be forged or replayed', () => {
    const secret = 'author-only-secret';
    const nonce = 'challenge-abc';
    const claim = {
        userId: 'user-123',
        tier: 'paid' as const,
        cap: 100_000,
        issuedAt: new Date().toISOString(),
        nonce,
    };
    const body = (overrides: object = {}, signWith = secret): string =>
        JSON.stringify({ claim: { ...claim, ...overrides }, signature: sign({ ...claim, ...overrides }, signWith) });

    const opts = { secret, expectedNonce: nonce, expectedUserId: 'user-123' };

    it('accepts a properly signed, fresh claim', () => {
        const result = verifyResponse(body(), opts);
        expect(result.ok).toBe(true);
    });

    it('rejects a claim signed with the wrong key', () => {
        const result = verifyResponse(body({}, 'attacker-guess'), opts);
        expect(result).toEqual({ ok: false, failure: 'bad-signature' });
    });

    it('rejects a claim whose cap was edited after signing', () => {
        const forged = JSON.stringify({
            claim: { ...claim, cap: 999_999 },
            signature: sign(claim, secret),
        });
        expect(verifyResponse(forged, opts)).toEqual({ ok: false, failure: 'bad-signature' });
    });

    it('rejects an unsigned claim', () => {
        const unsigned = JSON.stringify({ claim });
        expect(verifyResponse(unsigned, opts)).toEqual({ ok: false, failure: 'malformed' });
    });

    it('rejects a replayed response from an earlier run', () => {
        // Correctly signed, but answering a challenge this run never issued.
        const replayed = body({ nonce: 'a-previous-runs-nonce' });
        expect(verifyResponse(replayed, opts)).toEqual({ ok: false, failure: 'nonce-mismatch' });
    });

    it('rejects a claim minted for a different user', () => {
        const other = body({ userId: 'someone-else' });
        expect(verifyResponse(other, opts)).toEqual({ ok: false, failure: 'subject-mismatch' });
    });

    it('rejects a stale claim', () => {
        const old = body({ issuedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
        expect(verifyResponse(old, opts)).toEqual({ ok: false, failure: 'stale' });
    });

    it('signs over every field, so none can be tampered with independently', () => {
        const base = canonicalize(claim);
        for (const mutation of [
            { userId: 'x' },
            { tier: 'free' as const },
            { cap: 1 },
            { issuedAt: '2020-01-01T00:00:00.000Z' },
            { nonce: 'y' },
        ]) {
            expect(canonicalize({ ...claim, ...mutation })).not.toBe(base);
        }
    });
});
