/**
 * Run identity (assessment §6).
 *
 * `Actor.getEnv().userId` reads `APIFY_USER_ID` — an environment variable, and
 * therefore something the person running the Actor can set. Believing it would
 * make the entire free-tier gate a client-side check, which is exactly what the
 * brief says must not happen.
 *
 * So the claimed ID is cross-checked against Apify's own record of the run,
 * which lives on Apify's servers and reports who actually started it. These
 * tests cover the adversarial case (a forged environment) alongside the ordinary
 * ones, because "unverified" has to be the outcome for anything that is not a
 * confirmed match.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = { userId: null as string | null, actorRunId: null as string | null };

vi.mock('apify', () => ({
    Actor: { getEnv: () => env },
    log: { info: vi.fn(), warning: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { resolveRunIdentity } = await import('../src/entitlements/identity.js');

beforeEach(() => {
    env.userId = null;
    env.actorRunId = null;
    vi.clearAllMocks();
});

describe('the happy path', () => {
    it('verifies when the platform record agrees with the environment', async () => {
        env.userId = 'user-123';
        env.actorRunId = 'run-abc';

        const identity = await resolveRunIdentity(async () => ({ userId: 'user-123' }));

        expect(identity).toEqual({ userId: 'user-123', verified: true, note: null });
    });

    it('asks the platform about the run it is actually in', async () => {
        env.userId = 'user-123';
        env.actorRunId = 'run-abc';
        const fetchRecord = vi.fn(async () => ({ userId: 'user-123' }));

        await resolveRunIdentity(fetchRecord);

        expect(fetchRecord).toHaveBeenCalledWith('run-abc');
    });
});

describe('a forged environment does not verify', () => {
    it('rejects a claimed ID the platform record contradicts', async () => {
        // The attack this exists for: rewrite APIFY_USER_ID to a known paid
        // user's ID and hope nobody checks.
        env.userId = 'somebody-elses-paid-id';
        env.actorRunId = 'run-abc';

        const identity = await resolveRunIdentity(async () => ({ userId: 'the-real-runner' }));

        expect(identity.verified).toBe(false);
        expect(identity.note).toMatch(/did not match/i);
    });

    it('trusts the platform record over the environment when they disagree', async () => {
        env.userId = 'claimed';
        env.actorRunId = 'run-abc';

        const identity = await resolveRunIdentity(async () => ({ userId: 'actual' }));

        // The record is the authority, so its answer is the one carried forward.
        expect(identity.userId).toBe('actual');
    });

    it('does not verify when the record reports no owner at all', async () => {
        env.userId = 'user-123';
        env.actorRunId = 'run-abc';

        const identity = await resolveRunIdentity(async () => ({ userId: null }));

        expect(identity.verified).toBe(false);
    });
});

describe('everything unverifiable stays unverified', () => {
    it('does not verify with no user ID in the environment', async () => {
        env.actorRunId = 'run-abc';

        const identity = await resolveRunIdentity(async () => ({ userId: 'anyone' }));

        expect(identity.userId).toBe('');
        expect(identity.verified).toBe(false);
        expect(identity.note).toMatch(/No user ID/);
    });

    it('does not verify with an empty user ID', async () => {
        env.userId = '';
        env.actorRunId = 'run-abc';
        expect((await resolveRunIdentity(async () => ({ userId: '' }))).verified).toBe(false);
    });

    it('does not verify without a run ID to check against', async () => {
        // Running locally: nothing to cross-check, so nothing is confirmed.
        env.userId = 'user-123';

        const identity = await resolveRunIdentity(async () => ({ userId: 'user-123' }));

        expect(identity.verified).toBe(false);
        expect(identity.note).toMatch(/cross-check/i);
        // The claimed ID is still reported, for the log — just not trusted.
        expect(identity.userId).toBe('user-123');
    });

    it('does not verify when the record is unreachable', async () => {
        env.userId = 'user-123';
        env.actorRunId = 'run-abc';

        const identity = await resolveRunIdentity(async () => null);

        expect(identity.verified).toBe(false);
        expect(identity.note).toMatch(/unreachable/i);
    });

    it('does not verify when the lookup throws', async () => {
        env.userId = 'user-123';
        env.actorRunId = 'run-abc';

        // A network error must not become an exception that skips the gate.
        const identity = await resolveRunIdentity(() =>
            Promise.reject(new Error('ECONNREFUSED')),
        );

        expect(identity.verified).toBe(false);
    });
});

describe('it never throws', () => {
    it('resolves for every shape of failure', async () => {
        // Throwing here would be a way to bypass the gate entirely, so the
        // function has to absorb everything.
        const cases: (() => Promise<{ userId: string | null } | null>)[] = [
            () => Promise.reject(new Error('boom')),
            () => Promise.reject(new Error('a plain failure')),
            async () => null,
            async () => ({ userId: null }),
        ];

        env.userId = 'user-123';
        env.actorRunId = 'run-abc';

        for (const fetchRecord of cases) {
            await expect(resolveRunIdentity(fetchRecord)).resolves.toMatchObject({
                verified: false,
            });
        }
    });
});
