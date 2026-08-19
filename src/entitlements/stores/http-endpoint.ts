/**
 * Primary entitlement authority: a signed HTTP endpoint the author controls.
 *
 * This is the source of truth the assessment asks for (§6: *"the source of
 * truth must be a server you control"*). The Actor asks it a question and
 * refuses to believe the answer unless it carries a valid signature.
 *
 * The URL and the signing secret arrive as **Actor-level secret environment
 * variables**, which is what makes this hold up against a fork. Apify attaches
 * such variables to the Actor, not to the run: a user who runs the published
 * Actor gets them injected but cannot read them, and a user who forks the
 * source gets a copy of the code with no secret at all. Their fork therefore
 * cannot obtain a verifiable claim and falls closed to the free tier.
 *
 * @see https://docs.apify.com/platform/actors/development/programming-interface/environment-variables
 */

import { log } from 'apify';

import { FREE_TIER_CAP } from '../../config/constants.js';
import { performRequest } from '../../x/http.js';
import type { Entitlement, EntitlementSource, RunIdentity } from '../types.js';
import { createNonce, verifyResponse } from '../verify.js';

export interface SignedEndpointConfig {
    readonly url: string;
    readonly secret: string;
    readonly timeoutMs?: number;
}

/**
 * Read the endpoint configuration from the environment.
 *
 * @returns `null` when the Actor was deployed without an entitlements service,
 *   in which case the resolver moves on to the next source and ultimately fails
 *   closed. Missing configuration must never mean "unlimited".
 */
export function signedEndpointConfigFromEnv(
    env: NodeJS.ProcessEnv = process.env,
): SignedEndpointConfig | null {
    const url = env['ENTITLEMENTS_URL'];
    const secret = env['ENTITLEMENTS_SECRET'];
    if (url === undefined || url.length === 0) return null;
    if (secret === undefined || secret.length === 0) return null;
    return { url, secret };
}

export class SignedEndpointSource implements EntitlementSource {
    readonly name = 'signed-endpoint' as const;

    constructor(private readonly config: SignedEndpointConfig) {}

    async resolve(identity: RunIdentity): Promise<Entitlement | null> {
        // An unverified identity is never asked about: answering "paid" for a
        // user we cannot prove is the runner would defeat the whole check.
        if (!identity.verified || identity.userId.length === 0) {
            return {
                tier: 'free',
                cap: FREE_TIER_CAP,
                reason: 'identity_unverified',
                source: 'fail-closed',
            };
        }

        const nonce = createNonce();
        const response = await performRequest({
            url: this.config.url,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json',
                // The body is sent as a query string to keep the transport
                // helper single-purpose; the service accepts either form.
                'x-entitlement-user-id': identity.userId,
                'x-entitlement-nonce': nonce,
            },
            timeoutMs: this.config.timeoutMs ?? 10_000,
        }).catch((error: unknown) => {
            log.warning('Entitlements endpoint unreachable', { error: String(error) });
            return null;
        });

        // Unreachable: let the resolver try the fallback source.
        if (response === null) return null;

        if (response.statusCode !== 200) {
            log.warning('Entitlements endpoint returned a non-200', {
                status: response.statusCode,
            });
            return null;
        }

        const verification = verifyResponse(response.body, {
            secret: this.config.secret,
            expectedNonce: nonce,
            expectedUserId: identity.userId,
        });

        if (!verification.ok) {
            // A response that fails verification is worse than no response: it
            // means something is answering that should not be. Do not fall
            // through to another source — deny outright.
            log.warning('Entitlement claim failed verification', {
                failure: verification.failure,
            });
            return {
                tier: 'free',
                cap: FREE_TIER_CAP,
                reason: 'signature_invalid',
                source: 'fail-closed',
            };
        }

        const { claim } = verification;
        return {
            tier: claim.tier,
            // A signed claim may only ever *raise* the cap above the free tier;
            // a malformed-but-signed low cap still floors at the free allowance.
            cap: claim.tier === 'paid' ? Math.max(claim.cap, FREE_TIER_CAP) : FREE_TIER_CAP,
            reason: claim.tier === 'paid' ? 'entitled' : 'not_entitled',
            source: 'signed-endpoint',
        };
    }
}
