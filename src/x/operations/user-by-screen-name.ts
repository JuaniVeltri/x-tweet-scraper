/**
 * `UserByScreenName` — resolve a handle to a profile (assessment §2a, required).
 *
 * Verified guest-reachable on 2026-08-19: HTTP 200, observed rate limit
 * 150 requests per window.
 */

import { OPERATIONS } from '../../config/constants.js';
import { get, getFirstNumber, getFirstString, isRecord } from '../../util/json.js';
import type { XClient } from '../client.js';

/** The subset of a profile this Actor needs, flattened across both schemas. */
export interface XUserProfile {
    readonly restId: string;
    readonly username: string;
    readonly name: string;
    readonly verified: boolean;
    readonly followers: number;
    readonly following: number;
    /** True when X reports the account as protected, suspended or unavailable. */
    readonly unavailable: boolean;
    readonly unavailableReason: string | null;
}

/**
 * X reports an inaccessible account by changing `__typename` rather than by
 * failing the request, so these are normal responses, not errors.
 */
const UNAVAILABLE_TYPENAMES = new Set(['UserUnavailable']);

export async function fetchUserProfile(
    client: XClient,
    handle: string,
): Promise<XUserProfile | null> {
    const data = await client.execute({
        operationName: OPERATIONS.userByScreenName,
        variables: { screen_name: handle, withGrokTranslatedBio: false },
    });

    const result = get(data, 'user.result');
    if (!isRecord(result)) return null;
    return parseUserResult(result);
}

/**
 * Flatten a `user.result` node.
 *
 * Exported because the same node is embedded in every tweet, and because both
 * of X's live schemas must be handled: the older one keeps everything under
 * `legacy`, the newer one sets `legacy` to null and splits fields across
 * `core`, `relationship_counts` and `verification`. Each field therefore reads
 * through an ordered list of candidate paths.
 */
export function parseUserResult(result: unknown): XUserProfile | null {
    if (!isRecord(result)) return null;

    const typename = getFirstString(result, ['__typename']);
    if (typename !== undefined && UNAVAILABLE_TYPENAMES.has(typename)) {
        return {
            restId: getFirstString(result, ['rest_id']) ?? '',
            username: '',
            name: '',
            verified: false,
            followers: 0,
            following: 0,
            unavailable: true,
            unavailableReason: getFirstString(result, ['reason']) ?? 'unavailable',
        };
    }

    const restId = getFirstString(result, ['rest_id', 'legacy.id_str', 'id_str']);
    const username = getFirstString(result, [
        'core.screen_name', // current schema
        'legacy.screen_name', // older schema
        'screen_name',
    ]);
    if (restId === undefined || username === undefined) return null;

    return {
        restId,
        username,
        name: getFirstString(result, ['core.name', 'legacy.name', 'name']) ?? username,
        verified: readVerified(result),
        followers:
            getFirstNumber(result, [
                'relationship_counts.followers', // current schema
                'legacy.followers_count', // older schema
                'followers_count',
            ]) ?? 0,
        following:
            getFirstNumber(result, [
                'relationship_counts.following',
                'legacy.friends_count',
                'friends_count',
            ]) ?? 0,
        unavailable: false,
        unavailableReason: null,
    };
}

/**
 * "Verified" now spans two independent notions: the legacy blue check and an X
 * Premium subscription. The output contract exposes a single boolean, so either
 * one counts.
 */
function readVerified(result: unknown): boolean {
    const legacyVerified =
        get(result, 'verification.verified') ??
        get(result, 'legacy.verified') ??
        get(result, 'verified');
    const blue = get(result, 'is_blue_verified') ?? get(result, 'legacy.is_blue_verified');
    return legacyVerified === true || blue === true;
}
