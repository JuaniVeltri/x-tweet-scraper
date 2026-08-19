/**
 * Entitlements service — the authority behind the Actor's free-tier gate.
 *
 * This is the "server you control" the assessment asks for (§6). It is
 * deliberately tiny and dependency-free: its only job is to answer *"is this
 * Apify user entitled to more than the free allowance?"* and to sign that
 * answer so the Actor can tell a genuine reply from anything else on the wire.
 *
 * ## Why the answer is signed
 *
 * Without a signature, anyone able to influence what the Actor's HTTP request
 * resolves to — a hosts entry, a DNS override, a proxy they control — could
 * simply reply `{"tier":"paid"}` and lift the cap. The signing key lives only
 * here and in the Actor's secret environment, so a forged reply fails
 * verification and the Actor falls closed.
 *
 * ## Why the nonce is echoed
 *
 * The Actor issues a fresh random challenge per run and requires it back inside
 * the signed payload. That makes a captured "paid" response worthless in any
 * later run — it answers a challenge that will never be asked again.
 *
 * ## Configuration (environment variables)
 *
 *   ENTITLEMENTS_SECRET   Shared HMAC key. Must match the Actor's secret.
 *   ENTITLED_USER_IDS     Comma-separated Apify user IDs granted a paid tier.
 *   ENTITLED_DEFAULT_CAP  Cap granted to an entitled user. Default 100000.
 *
 * An unknown user is answered honestly — `tier: "free"` — rather than with an
 * error, so the Actor can distinguish "not entitled" from "service is down".
 */

import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

type Tier = 'free' | 'paid';

interface EntitlementClaim {
    userId: string;
    tier: Tier;
    cap: number;
    issuedAt: string;
    nonce: string;
}

/** Free allowance. Must match FREE_TIER_CAP in the Actor. */
const FREE_TIER_CAP = 10;

/**
 * Canonical encoding — must match the Actor's `canonicalize()` byte for byte.
 *
 * A positional array rather than an object, so the encoding cannot drift with
 * key ordering on either side.
 */
function canonicalize(claim: EntitlementClaim): string {
    return JSON.stringify([claim.userId, claim.tier, claim.cap, claim.issuedAt, claim.nonce]);
}

function sign(claim: EntitlementClaim, secret: string): string {
    return createHmac('sha256', secret).update(canonicalize(claim)).digest('hex');
}

/** Parse the allow-list. Entries may be `userId` or `userId:cap`. */
function readAllowList(raw: string | undefined): Map<string, number> {
    const entries = new Map<string, number>();
    if (raw === undefined) return entries;
    const defaultCap = Number(process.env['ENTITLED_DEFAULT_CAP'] ?? 100_000);

    for (const chunk of raw.split(',')) {
        const [id, cap] = chunk.trim().split(':');
        if (id === undefined || id.length === 0) continue;
        const parsed = cap === undefined ? defaultCap : Number(cap);
        entries.set(id, Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultCap);
    }
    return entries;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return {};
    try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function headerOf(request: IncomingMessage, name: string): string | undefined {
    const value = request.headers[name];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value[0];
    return undefined;
}

export default async function handler(
    request: IncomingMessage,
    response: ServerResponse,
): Promise<void> {
    const secret = process.env['ENTITLEMENTS_SECRET'];
    if (secret === undefined || secret.length === 0) {
        // Misconfiguration must not read as "everyone is free" — a 500 lets the
        // Actor fall through to its fallback authority instead.
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'ENTITLEMENTS_SECRET is not configured' }));
        return;
    }

    const body = request.method === 'POST' ? await readBody(request) : {};
    const userId =
        headerOf(request, 'x-entitlement-user-id') ??
        (typeof body['userId'] === 'string' ? body['userId'] : undefined);
    const nonce =
        headerOf(request, 'x-entitlement-nonce') ??
        (typeof body['nonce'] === 'string' ? body['nonce'] : undefined);

    if (userId === undefined || nonce === undefined) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
            JSON.stringify({
                error: 'Both a user ID and a nonce are required.',
                hint: 'Send x-entitlement-user-id and x-entitlement-nonce headers, or a JSON body.',
            }),
        );
        return;
    }

    const allowList = readAllowList(process.env['ENTITLED_USER_IDS']);
    const entitledCap = allowList.get(userId);

    const claim: EntitlementClaim = {
        userId,
        tier: entitledCap === undefined ? 'free' : 'paid',
        cap: entitledCap ?? FREE_TIER_CAP,
        issuedAt: new Date().toISOString(),
        nonce,
    };

    response.writeHead(200, {
        'content-type': 'application/json',
        // The answer is per-user, per-nonce and time-bounded: never cache it.
        'cache-control': 'no-store',
    });
    response.end(JSON.stringify({ claim, signature: sign(claim, secret) }));
}
