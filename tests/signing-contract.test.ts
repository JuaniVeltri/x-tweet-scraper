/**
 * Cross-implementation contract between the entitlements service and the Actor.
 *
 * The two sign and verify the same claim, but they are separate projects with
 * separate TypeScript configs and **no shared code** — the canonical encoding is
 * written out twice, once on each side. Nothing but this file stops them
 * drifting.
 *
 * That drift would be near-invisible in production, which is exactly why it is
 * worth a test. If the two encodings disagree by a single byte, every signature
 * fails to verify, the resolver does what it is supposed to do and fails closed,
 * and **every user silently drops to the free tier** — a total outage of the paid
 * product that looks, from the logs, like nobody happens to be entitled.
 *
 * So these tests do not check the encoding against a hardcoded string. They
 * import both real implementations and assert they agree, and that a claim the
 * service actually signs is one the Actor actually accepts.
 */

import { describe, expect, it } from 'vitest';

import {
    canonicalize as serviceCanonicalize,
    sign as serviceSign,
} from '../services/entitlements/api/entitlement.js';
import {
    canonicalize as actorCanonicalize,
    sign as actorSign,
    verifyResponse,
} from '../src/entitlements/verify.js';
import type { EntitlementClaim } from '../src/entitlements/types.js';

const SECRET = 'shared-secret-only-the-author-holds';

/**
 * A corpus chosen to break a naive encoding: characters JSON escapes, a
 * separator that would collide under string concatenation, the boundary values
 * of `cap`, and both tiers.
 */
const CORPUS: readonly EntitlementClaim[] = [
    { userId: 'fGwpysB8NgHk97ZCp', tier: 'paid', cap: 100_000, issuedAt: '2026-08-19T04:00:00.000Z', nonce: 'abc123' },
    { userId: 'someone-else', tier: 'free', cap: 10, issuedAt: '2026-01-01T00:00:00.000Z', nonce: 'x' },
    { userId: 'user', tier: 'paid', cap: 0, issuedAt: '2026-08-19T04:00:00.000Z', nonce: 'n' },
    { userId: 'user', tier: 'paid', cap: Number.MAX_SAFE_INTEGER, issuedAt: '2026-08-19T04:00:00.000Z', nonce: 'n' },
    // Quotes and backslashes: JSON must escape these identically on both sides.
    { userId: 'quote"inside', tier: 'paid', cap: 5, issuedAt: '2026-08-19T04:00:00.000Z', nonce: 'back\\slash' },
    // Unicode, including an emoji outside the BMP.
    { userId: 'ñandú-日本', tier: 'paid', cap: 7, issuedAt: '2026-08-19T04:00:00.000Z', nonce: '🔑' },
    // A separator that would collide if either side joined fields with a comma.
    { userId: 'a,b', tier: 'paid', cap: 1, issuedAt: '2026-08-19T04:00:00.000Z', nonce: 'c,d' },
];

describe('the service and the Actor agree on the canonical encoding', () => {
    it.each(CORPUS.map((c) => [c.userId, c] as const))(
        'encodes identically on both sides — %s',
        (_label, claim) => {
            expect(serviceCanonicalize(claim)).toBe(actorCanonicalize(claim));
        },
    );

    it('produces the same signature on both sides', () => {
        for (const claim of CORPUS) {
            expect(serviceSign(claim, SECRET)).toBe(actorSign(claim, SECRET));
        }
    });

    it('cannot be fooled by moving content across the field boundary', () => {
        // If either side concatenated fields, these two would encode the same.
        const a: EntitlementClaim = { userId: 'ab', tier: 'paid', cap: 1, issuedAt: '2026-01-01T00:00:00.000Z', nonce: 'cd' };
        const b: EntitlementClaim = { ...a, userId: 'a', nonce: 'bcd' };
        expect(actorCanonicalize(a)).not.toBe(actorCanonicalize(b));
        expect(serviceCanonicalize(a)).not.toBe(serviceCanonicalize(b));
    });
});

describe('a claim the service signs is one the Actor accepts', () => {
    /** Exactly the body shape the deployed service returns. */
    const serviceResponse = (claim: EntitlementClaim): string =>
        JSON.stringify({ claim, signature: serviceSign(claim, SECRET) });

    it('accepts a fresh paid claim end to end', () => {
        const claim: EntitlementClaim = {
            userId: 'fGwpysB8NgHk97ZCp',
            tier: 'paid',
            cap: 100_000,
            issuedAt: new Date().toISOString(),
            nonce: 'challenge-from-this-run',
        };

        const result = verifyResponse(serviceResponse(claim), {
            secret: SECRET,
            expectedNonce: claim.nonce,
            expectedUserId: claim.userId,
        });

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.claim.cap).toBe(100_000);
    });

    it('accepts a free claim too, so "not entitled" is distinguishable from "broken"', () => {
        const claim: EntitlementClaim = {
            userId: 'unknown-user',
            tier: 'free',
            cap: 10,
            issuedAt: new Date().toISOString(),
            nonce: 'n',
        };

        const result = verifyResponse(serviceResponse(claim), {
            secret: SECRET,
            expectedNonce: 'n',
            expectedUserId: 'unknown-user',
        });

        // A verified free answer is an answer. Only an *unverifiable* one is a
        // failure, and the resolver routes those two differently.
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.claim.tier).toBe('free');
    });

    it('rejects a service response signed with a different secret', () => {
        const claim: EntitlementClaim = {
            userId: 'u', tier: 'paid', cap: 99, issuedAt: new Date().toISOString(), nonce: 'n',
        };
        const body = JSON.stringify({ claim, signature: serviceSign(claim, 'wrong-secret') });

        const result = verifyResponse(body, {
            secret: SECRET, expectedNonce: 'n', expectedUserId: 'u',
        });
        expect(result).toEqual({ ok: false, failure: 'bad-signature' });
    });

    it('survives a unicode round trip, where a byte-level mismatch would hide', () => {
        const claim: EntitlementClaim = {
            userId: 'ñandú-日本-🔑', tier: 'paid', cap: 42,
            issuedAt: new Date().toISOString(), nonce: 'ñ',
        };
        const result = verifyResponse(serviceResponse(claim), {
            secret: SECRET, expectedNonce: 'ñ', expectedUserId: 'ñandú-日本-🔑',
        });
        expect(result.ok).toBe(true);
    });
});

describe('the free-tier constant matches on both sides', () => {
    it('is 10 in the service, as the Actor assumes', async () => {
        // The service floors an unentitled user at its own FREE_TIER_CAP. If the
        // two constants diverged, an unentitled user would be handed a cap the
        // Actor never intended to grant.
        const { readFileSync } = await import('node:fs');
        const { fileURLToPath } = await import('node:url');
        const source = readFileSync(
            fileURLToPath(new URL('../services/entitlements/api/entitlement.ts', import.meta.url)),
            'utf8',
        );
        const declared = /const FREE_TIER_CAP = (\d+);/.exec(source)?.[1];
        expect(declared).toBe('10');
    });
});
