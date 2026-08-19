/**
 * The three guest-reachable operations (assessment §2a).
 *
 * The interesting logic is `parseUserResult`, which is the single place that
 * absorbs X's mid-flight schema migration. The same profile arrives shaped one
 * way under an older query ID and another way under a current one, and every
 * author on every tweet goes through this function — so a gap here is not one
 * missing field, it is a missing field on every row.
 */

import { describe, expect, it, vi } from 'vitest';

import type { GraphQLCall, XClient } from '../src/x/client.js';
import { fetchTweetById } from '../src/x/operations/tweet-by-rest-id.js';
import { fetchUserProfile, parseUserResult } from '../src/x/operations/user-by-screen-name.js';
import { fetchUserTweetsPage } from '../src/x/operations/user-tweets.js';

/** A client that returns a canned `data` object and records the call. */
function clientReturning(data: unknown) {
    const execute = vi.fn(async (_call: GraphQLCall) => data);
    return { client: { execute } as unknown as XClient, execute };
}

/** The shape older query IDs return: everything under `legacy`. */
const LEGACY_USER = {
    __typename: 'User',
    rest_id: '3510729917',
    legacy: {
        screen_name: 'apify',
        name: 'Apify',
        followers_count: 12_047,
        friends_count: 296,
        verified: false,
    },
    is_blue_verified: false,
};

/** The shape current query IDs return: `legacy` null, fields split out. */
const CORE_USER = {
    __typename: 'User',
    rest_id: '3510729917',
    legacy: null,
    core: { screen_name: 'apify', name: 'Apify', created_at: 'Wed Aug 12 16:12:32 +0000 2014' },
    relationship_counts: { followers: 12_047, following: 296 },
    verification: { verified: false, verified_type: 'Business' },
    is_blue_verified: false,
};

describe('parseUserResult reads both live schemas', () => {
    it('reads the legacy shape', () => {
        expect(parseUserResult(LEGACY_USER)).toMatchObject({
            restId: '3510729917',
            username: 'apify',
            name: 'Apify',
            followers: 12_047,
            following: 296,
            unavailable: false,
        });
    });

    it('reads the current shape', () => {
        expect(parseUserResult(CORE_USER)).toMatchObject({
            restId: '3510729917',
            username: 'apify',
            name: 'Apify',
            followers: 12_047,
            following: 296,
            unavailable: false,
        });
    });

    it('produces the same identity from both, so a rotation is a non-event', () => {
        const legacy = parseUserResult(LEGACY_USER);
        const core = parseUserResult(CORE_USER);
        expect(legacy?.restId).toBe(core?.restId);
        expect(legacy?.username).toBe(core?.username);
        expect(legacy?.name).toBe(core?.name);
        expect(legacy?.followers).toBe(core?.followers);
    });
});

describe('verified covers every checkmark X actually shows', () => {
    it('is true for the legacy blue check', () => {
        const user = { ...LEGACY_USER, legacy: { ...LEGACY_USER.legacy, verified: true } };
        expect(parseUserResult(user)?.verified).toBe(true);
    });

    it('is true for an X Premium subscriber', () => {
        expect(parseUserResult({ ...LEGACY_USER, is_blue_verified: true })?.verified).toBe(true);
    });

    it('is true for a Business account, which reports false everywhere else', () => {
        // The bug this guards: @apify is Business-verified, shows a gold check,
        // and reports verified:false and is_blue_verified:false. Reading only
        // those two dropped it from every onlyVerified run.
        expect(parseUserResult(CORE_USER)?.verified).toBe(true);
    });

    it('is true for a Government account', () => {
        const gov = { ...CORE_USER, verification: { verified: false, verified_type: 'Government' } };
        expect(parseUserResult(gov)?.verified).toBe(true);
    });

    it('is false for an ordinary account', () => {
        const plain = { ...CORE_USER, verification: { verified: false, verified_type: 'None' } };
        expect(parseUserResult(plain)?.verified).toBe(false);
        expect(parseUserResult(LEGACY_USER)?.verified).toBe(false);
    });
});

describe('accounts that are not available', () => {
    it('flags an unavailable account instead of failing', () => {
        // Protected, suspended and deleted accounts arrive as a different
        // __typename, not as an error — they are outcomes, not failures.
        const result = parseUserResult({
            __typename: 'UserUnavailable',
            rest_id: '999',
            reason: 'Suspended',
        });
        expect(result).toMatchObject({ unavailable: true, unavailableReason: 'Suspended' });
    });

    it('returns null when there is no usable identity', () => {
        expect(parseUserResult(null)).toBeNull();
        expect(parseUserResult({})).toBeNull();
        expect(parseUserResult({ rest_id: '1' })).toBeNull(); // no handle
    });

    it('falls back to the handle when the display name is missing', () => {
        const noName = { rest_id: '1', core: { screen_name: 'someone' } };
        expect(parseUserResult(noName)?.name).toBe('someone');
    });
});

describe('fetchUserProfile', () => {
    it('asks for the profile by handle', async () => {
        const { client, execute } = clientReturning({ user: { result: LEGACY_USER } });
        const profile = await fetchUserProfile(client, 'apify');

        expect(profile?.username).toBe('apify');
        expect(execute.mock.calls[0]?.[0]).toMatchObject({
            operationName: 'UserByScreenName',
            variables: { screen_name: 'apify' },
        });
    });

    it('returns null when X reports no user', async () => {
        const { client } = clientReturning({ user: {} });
        expect(await fetchUserProfile(client, 'ghost')).toBeNull();
    });
});

describe('fetchUserTweetsPage', () => {
    const page = {
        user: {
            result: {
                timeline_v2: {
                    timeline: {
                        instructions: [
                            {
                                type: 'TimelineAddEntries',
                                entries: [
                                    {
                                        entryId: 'tweet-1',
                                        content: {
                                            entryType: 'TimelineTimelineItem',
                                            itemContent: {
                                                tweet_results: { result: { rest_id: '1' } },
                                            },
                                        },
                                    },
                                    {
                                        entryId: 'cursor-bottom',
                                        content: {
                                            entryType: 'TimelineTimelineCursor',
                                            cursorType: 'Bottom',
                                            value: 'next-page',
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                },
            },
        },
    };

    it('returns the tweets and the bottom cursor', async () => {
        const { client } = clientReturning(page);
        const result = await fetchUserTweetsPage(client, { userId: '1' });
        expect(result.tweets).toHaveLength(1);
        expect(result.nextCursor).toBe('next-page');
    });

    it('excludes promoted content, which is advertising rather than a post', async () => {
        const { client, execute } = clientReturning(page);
        await fetchUserTweetsPage(client, { userId: '1' });
        expect(execute.mock.calls[0]?.[0].variables).toMatchObject({
            includePromotedContent: false,
        });
    });

    it('sends the cursor when paging', async () => {
        const { client, execute } = clientReturning(page);
        await fetchUserTweetsPage(client, { userId: '1', cursor: 'from-last-page' });
        expect(execute.mock.calls[0]?.[0].variables).toMatchObject({ cursor: 'from-last-page' });
    });

    it('omits the cursor entirely on the first page', async () => {
        const { client, execute } = clientReturning(page);
        await fetchUserTweetsPage(client, { userId: '1' });
        const vars = execute.mock.calls[0]?.[0].variables ?? {};
        expect(Object.hasOwn(vars, 'cursor')).toBe(false);
    });

    it('requests a larger page than X\'s default of 20', async () => {
        const { client, execute } = clientReturning(page);
        await fetchUserTweetsPage(client, { userId: '1' });
        const count = execute.mock.calls[0]?.[0].variables.count as number;
        expect(count).toBeGreaterThan(20);
    });
});

describe('fetchTweetById', () => {
    it('returns the hydrated tweet', async () => {
        const { client } = clientReturning({
            tweetResult: { result: { rest_id: '123', legacy: { full_text: 'hi' } } },
        });
        expect(await fetchTweetById(client, '123')).toMatchObject({ rest_id: '123' });
    });

    it('unwraps a visibility-limited tweet', async () => {
        // Missing this unwrap silently drops every restricted tweet.
        const { client } = clientReturning({
            tweetResult: {
                result: {
                    __typename: 'TweetWithVisibilityResults',
                    tweet: { rest_id: '456', legacy: { full_text: 'limited' } },
                },
            },
        });
        expect(await fetchTweetById(client, '456')).toMatchObject({ rest_id: '456' });
    });

    it('returns null for a deleted or withheld tweet', async () => {
        // X signals these with an empty result rather than an error status.
        const { client } = clientReturning({ tweetResult: {} });
        expect(await fetchTweetById(client, '999')).toBeNull();
    });
});
