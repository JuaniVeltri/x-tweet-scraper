/**
 * Run identity (assessment §6: *"The check must be server-authoritative, not
 * derived from anything the user can set."*).
 *
 * `Actor.getEnv().userId` reads `APIFY_USER_ID`, which the Apify platform
 * injects into every run. On the platform that value is trustworthy — but the
 * threat model here is a user who controls their own environment, and an
 * environment variable is exactly the kind of thing such a user can set. Taking
 * it at face value would make the whole gate a client-side check.
 *
 * So the claimed ID is cross-checked against the platform's own record of the
 * run. `GET /v2/actor-runs/{runId}` returns, among other things, the `userId`
 * that started it. That record lives on Apify's servers and cannot be edited by
 * the person running the Actor, which makes it the authority. If the claim and
 * the record disagree — or the record cannot be read — identity is not
 * considered verified, and the resolver fails closed to the free tier.
 */

import { Actor, log } from 'apify';

import { performRequest } from '../x/http.js';
import { isRecord } from '../util/json.js';
import type { RunIdentity } from './types.js';

const APIFY_API_BASE = 'https://api.apify.com/v2';

/** Injectable so tests never touch the network. */
export type RunRecordFetcher = (runId: string) => Promise<{ userId: string | null } | null>;

/**
 * Resolve and verify the identity of the account running this Actor.
 *
 * Never throws: an unresolvable identity is a legitimate outcome that the
 * caller must handle by capping the run, not by crashing it.
 */
export async function resolveRunIdentity(
    fetchRunRecord: RunRecordFetcher = defaultRunRecordFetcher,
): Promise<RunIdentity> {
    const env = Actor.getEnv();
    const claimedUserId = env.userId;
    const runId = env.actorRunId;

    if (claimedUserId === null || claimedUserId === undefined || claimedUserId.length === 0) {
        return {
            userId: '',
            verified: false,
            note: 'No user ID in the run environment (running locally?).',
        };
    }

    if (runId === null || runId === undefined || runId.length === 0) {
        return {
            userId: claimedUserId,
            verified: false,
            note: 'No run ID available, so the claimed user ID could not be cross-checked.',
        };
    }

    const record = await fetchRunRecord(runId).catch((error: unknown) => {
        log.warning('Could not read the platform run record', { error: String(error) });
        return null;
    });

    if (record === null) {
        return {
            userId: claimedUserId,
            verified: false,
            note: 'The platform run record was unreachable; identity is unverified.',
        };
    }

    if (record.userId !== claimedUserId) {
        // The environment says one thing and Apify's own record says another.
        // Trust the record, and treat the run as unverified.
        log.warning('Run identity mismatch — trusting the platform record', {
            claimed: claimedUserId,
            actual: record.userId ?? '(absent)',
        });
        return {
            userId: record.userId ?? '',
            verified: false,
            note: 'The claimed user ID did not match the platform run record.',
        };
    }

    return { userId: claimedUserId, verified: true, note: null };
}

/**
 * Read a run record from the Apify API.
 *
 * The run ID is itself the credential — Apify documents these calls as
 * "authenticated using a hard-to-guess ID of the run" — so no token is needed
 * to confirm who owns the run.
 *
 * @see https://docs.apify.com/api/v2/actor-run-get
 */
async function defaultRunRecordFetcher(runId: string): Promise<{ userId: string | null } | null> {
    const response = await performRequest({
        url: `${APIFY_API_BASE}/actor-runs/${encodeURIComponent(runId)}`,
        headers: { accept: 'application/json' },
        timeoutMs: 10_000,
    });

    if (response.statusCode !== 200) return null;

    const parsed: unknown = JSON.parse(response.body);
    const data = isRecord(parsed) ? parsed['data'] : undefined;
    if (!isRecord(data)) return null;

    const userId = data['userId'];
    return { userId: typeof userId === 'string' ? userId : null };
}
