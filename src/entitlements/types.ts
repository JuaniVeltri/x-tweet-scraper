/**
 * Entitlement types (assessment §6).
 *
 * The vocabulary here is deliberately narrow: an {@link Entitlement} is the
 * *only* thing allowed to set a run's item cap, and it can only be produced by
 * {@link ../resolver.ts}. Nothing derived from user input can construct one.
 */

export type Tier = 'free' | 'paid';

/** Why a run ended up on the tier it did — surfaced in logs and the summary. */
export type EntitlementReason =
    /** An authoritative source confirmed a paid entitlement. */
    | 'entitled'
    /** An authoritative source answered, and the user is not entitled. */
    | 'not_entitled'
    /** No authoritative source could be reached. Fail closed. */
    | 'unverified'
    /** The run's identity could not be established or did not match. */
    | 'identity_unverified'
    /** A response arrived but its signature did not verify. */
    | 'signature_invalid';

export interface Entitlement {
    readonly tier: Tier;
    /** Maximum items this run may emit. Never read from input. */
    readonly cap: number;
    readonly reason: EntitlementReason;
    /** Which authority answered, for the run summary. */
    readonly source: 'signed-endpoint' | 'key-value-store' | 'fail-closed';
}

/** The verified identity of the account that started this run. */
export interface RunIdentity {
    readonly userId: string;
    /** True only when the platform's own run record confirmed `userId`. */
    readonly verified: boolean;
    /** Set when verification was attempted and disagreed or failed. */
    readonly note: string | null;
}

/** The payload an entitlements authority signs. */
export interface EntitlementClaim {
    readonly userId: string;
    readonly tier: Tier;
    readonly cap: number;
    /** ISO-8601. Bounds how long a captured response stays usable. */
    readonly issuedAt: string;
    /** Echo of the client's challenge; defeats replay of an old "paid" answer. */
    readonly nonce: string;
}

/** An authority that can answer "what is this user entitled to?". */
export interface EntitlementSource {
    readonly name: Entitlement['source'];
    /**
     * @returns The entitlement, or `null` when this source cannot answer —
     *   which the resolver treats as "try the next source", never as "paid".
     */
    resolve(identity: RunIdentity): Promise<Entitlement | null>;
}
