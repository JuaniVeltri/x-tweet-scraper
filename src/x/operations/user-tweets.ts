/**
 * `UserTweets` — a profile's tweet timeline (assessment §2a, required).
 *
 * Verified guest-reachable on 2026-08-19: HTTP 200. Its observed rate limit of
 * **50 requests per window** is the tightest of the three operations and is
 * what makes guest-token rotation load-bearing rather than decorative.
 */

import { DEFAULTS, OPERATIONS } from '../../config/constants.js';
import { walkTimeline, type TimelinePage } from '../../normalize/timeline.js';
import type { XClient } from '../client.js';

export interface UserTweetsPageRequest {
    readonly userId: string;
    readonly cursor?: string | undefined;
    readonly count?: number;
}

/**
 * Fetch one page of a user's timeline.
 *
 * `includePromotedContent` is false because ads are not organic posts and would
 * pollute the dataset; `withVoice` is true because voice tweets are ordinary
 * posts whose text still belongs in the output.
 */
export async function fetchUserTweetsPage(
    client: XClient,
    request: UserTweetsPageRequest,
): Promise<TimelinePage> {
    const data = await client.execute({
        operationName: OPERATIONS.userTweets,
        variables: {
            userId: request.userId,
            count: request.count ?? DEFAULTS.pageSize,
            ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
            includePromotedContent: false,
            withQuickPromoteEligibilityTweetFields: false,
            withVoice: true,
        },
    });

    return walkTimeline(data);
}
