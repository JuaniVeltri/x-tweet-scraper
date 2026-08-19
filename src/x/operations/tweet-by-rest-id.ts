/**
 * `TweetResultByRestId` — one tweet, fully hydrated (assessment §2a, required).
 *
 * Verified guest-reachable on 2026-08-19: HTTP 200, observed rate limit
 * 500 requests per window — the most generous of the three, which is why tweet
 * IDs are fetched with higher concurrency than timelines.
 *
 * Note that `TweetDetail` — the operation that returns a whole conversation —
 * is *not* guest-reachable (HTTP 404, empty body). Hydrating by ID is the
 * single-tweet surface available without a login.
 */

import { OPERATIONS } from '../../config/constants.js';
import { unwrapTweet } from '../../normalize/timeline.js';
import { get, isRecord } from '../../util/json.js';
import type { XClient } from '../client.js';

/**
 * Fetch one tweet by ID.
 *
 * @returns The raw tweet node, or `null` when the tweet is deleted, private or
 *   otherwise withheld — X signals all of these with an empty `tweetResult`
 *   rather than an error status, so they are ordinary outcomes to be skipped.
 */
export async function fetchTweetById(client: XClient, tweetId: string): Promise<unknown | null> {
    const data = await client.execute({
        operationName: OPERATIONS.tweetResultByRestId,
        variables: {
            tweetId,
            includePromotedContent: false,
            withBirdwatchNotes: true,
            withVoice: true,
            withCommunity: true,
        },
    });

    const result = get(data, 'tweetResult.result');
    if (!isRecord(result)) return null;

    const unwrapped = unwrapTweet(result);
    return isRecord(unwrapped) ? unwrapped : null;
}
