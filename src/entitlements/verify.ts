/**
 * Signature verification for entitlement claims.
 *
 * The entitlements service and this Actor share a secret that only the Actor's
 * author holds. The service signs each claim with it; the Actor refuses any
 * claim whose signature does not verify. That turns "is this user paid?" from a
 * question the network could lie about into one only the author's server can
 * answer.
 *
 * Three properties matter, and each defeats a specific attack:
 *
 *   - **HMAC over a canonical encoding** — an attacker who can return arbitrary
 *     HTTP (DNS spoofing, a hosts-file entry, a proxy they control) still
 *     cannot forge a claim, because they lack the key.
 *   - **Nonce echo** — the Actor picks a fresh random challenge per run and
 *     requires it back inside the signed payload, so a genuine "paid" response
 *     captured once cannot be replayed later.
 *   - **Freshness window** — bounds the damage of a replay even if the nonce
 *     check were somehow bypassed.
 *
 * Comparison is constant-time, so signature verification cannot be turned into
 * an oracle by timing it.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { isRecord } from '../util/json.js';
import type { EntitlementClaim, Tier } from './types.js';

/** How long a signed claim stays acceptable after it was issued. */
export const CLAIM_FRESHNESS_MS = 5 * 60 * 1000;

export function createNonce(): string {
    return randomBytes(24).toString('hex');
}

/**
 * Canonical encoding of a claim.
 *
 * Both sides must agree byte-for-byte, so key order is fixed explicitly rather
 * than left to object-literal order or `JSON.stringify`'s insertion order.
 */
export function canonicalize(claim: EntitlementClaim): string {
    return JSON.stringify([
        claim.userId,
        claim.tier,
        claim.cap,
        claim.issuedAt,
        claim.nonce,
    ]);
}

export function sign(claim: EntitlementClaim, secret: string): string {
    return createHmac('sha256', secret).update(canonicalize(claim)).digest('hex');
}

export type VerificationFailure =
    | 'malformed'
    | 'bad-signature'
    | 'nonce-mismatch'
    | 'subject-mismatch'
    | 'stale';

export type VerificationResult =
    | { readonly ok: true; readonly claim: EntitlementClaim }
    | { readonly ok: false; readonly failure: VerificationFailure };

export interface VerifyOptions {
    readonly secret: string;
    readonly expectedNonce: string;
    readonly expectedUserId: string;
    readonly now?: () => number;
    readonly freshnessMs?: number;
}

/**
 * Verify a raw response body from the entitlements service.
 *
 * Every failure path returns a reason rather than throwing, because the caller's
 * response to all of them is identical and non-negotiable: fall back to free.
 */
export function verifyResponse(body: string, options: VerifyOptions): VerificationResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return { ok: false, failure: 'malformed' };
    }

    if (!isRecord(parsed)) return { ok: false, failure: 'malformed' };
    const signature = parsed.signature;
    const claim = parseClaim(parsed.claim);
    if (typeof signature !== 'string' || claim === null) {
        return { ok: false, failure: 'malformed' };
    }

    if (!signaturesMatch(sign(claim, options.secret), signature)) {
        return { ok: false, failure: 'bad-signature' };
    }

    // Order matters below only for diagnostics; any failure yields the free tier.
    if (claim.nonce !== options.expectedNonce) {
        return { ok: false, failure: 'nonce-mismatch' };
    }
    if (claim.userId !== options.expectedUserId) {
        return { ok: false, failure: 'subject-mismatch' };
    }

    const issuedAt = Date.parse(claim.issuedAt);
    const now = (options.now ?? Date.now)();
    const freshness = options.freshnessMs ?? CLAIM_FRESHNESS_MS;
    if (Number.isNaN(issuedAt) || Math.abs(now - issuedAt) > freshness) {
        return { ok: false, failure: 'stale' };
    }

    return { ok: true, claim };
}

function parseClaim(value: unknown): EntitlementClaim | null {
    if (!isRecord(value)) return null;

    const userId = value.userId;
    const tier = value.tier;
    const cap = value.cap;
    const issuedAt = value.issuedAt;
    const nonce = value.nonce;

    if (
        typeof userId !== 'string' ||
        (tier !== 'free' && tier !== 'paid') ||
        typeof cap !== 'number' ||
        !Number.isInteger(cap) ||
        cap < 0 ||
        typeof issuedAt !== 'string' ||
        typeof nonce !== 'string'
    ) {
        return null;
    }

    return { userId, tier: tier satisfies Tier, cap, issuedAt, nonce };
}

/** Constant-time comparison that tolerates length differences. */
function signaturesMatch(expected: string, actual: string): boolean {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(actual, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}
