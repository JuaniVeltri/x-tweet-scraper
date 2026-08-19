/**
 * Fallback entitlement authority: a key-value store the author owns.
 *
 * The assessment explicitly allows this simplification (§6: *"a protected Apify
 * key-value store keyed by userId"*). It exists here as a second opinion so a
 * paying customer is not capped merely because the primary endpoint had a bad
 * minute.
 *
 * It is authoritative for the same reason the endpoint is: the store belongs to
 * the author's account and is read with the author's API token, supplied as an
 * Actor-level **secret** environment variable. A forked Actor has neither the
 * token nor write access to the store, so it cannot mint itself an entitlement.
 *
 * Records are keyed by Apify user ID and hold `{"tier":"paid","cap":100000}`.
 *
 * @see https://docs.apify.com/api/v2/key-value-store-record-get
 */

import { log } from 'apify';

import { FREE_TIER_CAP } from '../../config/constants.js';
import { isRecord } from '../../util/json.js';
import { performRequest } from '../../x/http.js';
import type { Entitlement, EntitlementSource, RunIdentity } from '../types.js';

const APIFY_API_BASE = 'https://api.apify.com/v2';

export interface KeyValueEntitlementConfig {
    /** Store ID, or `username~store-name`. */
    readonly storeId: string;
    /** Author's API token. Must be an Actor-level secret env var. */
    readonly token: string;
    readonly timeoutMs?: number;
}

export function keyValueConfigFromEnv(
    env: NodeJS.ProcessEnv = process.env,
): KeyValueEntitlementConfig | null {
    const storeId = env['ENTITLEMENTS_KV_STORE'];
    const token = env['ENTITLEMENTS_API_TOKEN'];
    if (storeId === undefined || storeId.length === 0) return null;
    if (token === undefined || token.length === 0) return null;
    return { storeId, token };
}

export class KeyValueStoreSource implements EntitlementSource {
    readonly name = 'key-value-store' as const;

    constructor(private readonly config: KeyValueEntitlementConfig) {}

    async resolve(identity: RunIdentity): Promise<Entitlement | null> {
        if (!identity.verified || identity.userId.length === 0) {
            return {
                tier: 'free',
                cap: FREE_TIER_CAP,
                reason: 'identity_unverified',
                source: 'fail-closed',
            };
        }

        const url =
            `${APIFY_API_BASE}/key-value-stores/${encodeURIComponent(this.config.storeId)}` +
            `/records/${encodeURIComponent(identity.userId)}`;

        const response = await performRequest({
            url,
            headers: {
                authorization: `Bearer ${this.config.token}`,
                accept: 'application/json',
            },
            timeoutMs: this.config.timeoutMs ?? 10_000,
        }).catch((error: unknown) => {
            log.warning('Entitlements key-value store unreachable', { error: String(error) });
            return null;
        });

        if (response === null) return null;

        // 404 is a definitive answer, not a failure: there is no record for this
        // user, therefore this user is not entitled.
        if (response.statusCode === 404) {
            return {
                tier: 'free',
                cap: FREE_TIER_CAP,
                reason: 'not_entitled',
                source: 'key-value-store',
            };
        }

        if (response.statusCode !== 200) return null;

        const record = parseRecord(response.body);
        if (record === null) return null;

        return {
            tier: record.tier,
            cap: record.tier === 'paid' ? Math.max(record.cap, FREE_TIER_CAP) : FREE_TIER_CAP,
            reason: record.tier === 'paid' ? 'entitled' : 'not_entitled',
            source: 'key-value-store',
        };
    }
}

function parseRecord(body: string): { tier: 'free' | 'paid'; cap: number } | null {
    try {
        const parsed: unknown = JSON.parse(body);
        if (!isRecord(parsed)) return null;
        const tier = parsed['tier'];
        if (tier !== 'free' && tier !== 'paid') return null;
        const rawCap = parsed['cap'];
        const cap =
            typeof rawCap === 'number' && Number.isInteger(rawCap) && rawCap >= 0
                ? rawCap
                : FREE_TIER_CAP;
        return { tier, cap };
    } catch {
        return null;
    }
}
