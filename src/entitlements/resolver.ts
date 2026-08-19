/**
 * Entitlement resolution — the free-tier gate (assessment §6).
 *
 * This module answers exactly one question: **how many items may this run
 * emit?** It is the only place in the codebase that may answer it, and the
 * answer is never a function of the run's input.
 *
 * ## Why input cannot influence the cap
 *
 * The cap is produced here from a verified identity plus a signed claim, and
 * handed to the emitter, which fixes it at construction. `maxResults` is only
 * ever applied as `min(maxResults, entitlement.cap)` — it can lower the ceiling
 * but never raise it. Setting `maxResults: 1000000`, adding undocumented input
 * fields, or editing the input JSON changes nothing, because none of those
 * values reach this function.
 *
 * ## Why editing the environment does not help
 *
 * The claimed user ID is cross-checked against Apify's own record of the run
 * (see `identity.ts`). A user who rewrites `APIFY_USER_ID` produces a claim
 * that disagrees with the platform record, which marks the identity unverified
 * — and an unverified identity is capped, never entitled.
 *
 * ## Why forking the source does not help
 *
 * Both authorities are reached with **Actor-level secret** credentials, which
 * Apify attaches to the Actor rather than to the run. A fork ships the code
 * without the signing secret and without the API token, so it cannot obtain a
 * claim that verifies. Deleting this check from a fork is possible, of course —
 * but a fork runs on the forker's own compute against their own quota, and no
 * longer consumes the hosted service this gate protects.
 *
 * ## Fail-closed
 *
 * Every failure mode — unreachable service, malformed response, invalid
 * signature, unknown user, unverifiable identity — resolves to the free tier.
 * There is no path through this function that returns a raised cap without a
 * verified identity *and* a verified claim.
 */

import { log } from 'apify';

import { FREE_TIER_CAP } from '../config/constants.js';
import { resolveRunIdentity } from './identity.js';
import { KeyValueStoreSource, keyValueConfigFromEnv } from './stores/apify-kv.js';
import { SignedEndpointSource, signedEndpointConfigFromEnv } from './stores/http-endpoint.js';
import type { Entitlement, EntitlementSource, RunIdentity } from './types.js';

/** The cap applied whenever nothing authoritative says otherwise. */
export const FAIL_CLOSED: Entitlement = {
    tier: 'free',
    cap: FREE_TIER_CAP,
    reason: 'unverified',
    source: 'fail-closed',
};

export interface ResolveOptions {
    /** Overrides the default source chain; used by tests. */
    readonly sources?: readonly EntitlementSource[];
    /** Overrides identity resolution; used by tests. */
    readonly identity?: RunIdentity;
    readonly env?: NodeJS.ProcessEnv;
}

/**
 * Build the ordered list of authorities from the environment.
 *
 * An Actor deployed without any entitlements configuration ends up with an
 * empty chain, which resolves to {@link FAIL_CLOSED}. Absent configuration
 * therefore means "everyone is free", never "everyone is unlimited".
 */
export function buildSources(env: NodeJS.ProcessEnv = process.env): EntitlementSource[] {
    const sources: EntitlementSource[] = [];

    const endpoint = signedEndpointConfigFromEnv(env);
    if (endpoint !== null) sources.push(new SignedEndpointSource(endpoint));

    const kv = keyValueConfigFromEnv(env);
    if (kv !== null) sources.push(new KeyValueStoreSource(kv));

    if (sources.length === 0) {
        log.warning(
            'No entitlements authority is configured; every run will be capped at the free tier.',
        );
    }
    return sources;
}

/**
 * Resolve this run's entitlement.
 *
 * Never throws. A thrown error here would be a way to skip the gate, so every
 * failure is caught and converted into the closed state.
 */
export async function resolveEntitlement(options: ResolveOptions = {}): Promise<Entitlement> {
    try {
        const identity = options.identity ?? (await resolveRunIdentity());
        const sources = options.sources ?? buildSources(options.env);

        if (!identity.verified) {
            log.info('Run identity is unverified; applying the free-tier cap.', {
                note: identity.note,
            });
            return { ...FAIL_CLOSED, reason: 'identity_unverified' };
        }

        for (const source of sources) {
            const entitlement = await source.resolve(identity).catch((error: unknown) => {
                log.warning('Entitlement source threw', {
                    source: source.name,
                    error: String(error),
                });
                return null;
            });

            // `null` means "this source could not answer" — try the next one.
            if (entitlement === null) continue;

            log.info('Entitlement resolved', {
                tier: entitlement.tier,
                cap: entitlement.cap,
                source: entitlement.source,
                reason: entitlement.reason,
            });
            return entitlement;
        }

        log.info('No entitlements authority answered; applying the free-tier cap.');
        return FAIL_CLOSED;
    } catch (error: unknown) {
        log.warning('Entitlement resolution failed; applying the free-tier cap.', {
            error: String(error),
        });
        return FAIL_CLOSED;
    }
}

/**
 * The number of items a run may actually emit.
 *
 * The asymmetry is the whole point: the requested value can only narrow the
 * entitled ceiling.
 */
export function effectiveCap(entitlement: Entitlement, requested: number): number {
    return Math.max(0, Math.min(requested, entitlement.cap));
}
