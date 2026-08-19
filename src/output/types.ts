/**
 * The dataset item contract (assessment §5).
 *
 * Two rules govern every field here and are enforced by the normalizer:
 *   1. Missing values are `null`. Never `undefined`, never an omitted key —
 *      clients build against this shape, so a key vanishing is a breaking change.
 *   2. IDs are strings. X's IDs exceed `Number.MAX_SAFE_INTEGER`, so putting one
 *      through a JS number silently corrupts it.
 *
 * Timestamps are ISO-8601 in UTC.
 */

export interface TweetAuthor {
    id: string;
    /** Handle without the leading `@`. */
    username: string;
    name: string;
    verified: boolean;
    followers: number;
    following: number;
}

export interface TweetMetrics {
    likes: number;
    retweets: number;
    replies: number;
    quotes: number;
    /** `null` when X does not expose it for this tweet. */
    bookmarks: number | null;
    /** `null` for tweets whose view count is not public (e.g. older posts). */
    views: number | null;
}

export type MediaKind = 'photo' | 'video' | 'animated_gif';

export interface TweetMedia {
    type: MediaKind;
    url: string;
    thumbnail: string | null;
}

export interface TweetEntities {
    /** Hashtag texts without the leading `#`. */
    hashtags: string[];
    /** Mentioned handles without the leading `@`. */
    mentions: string[];
    /** Expanded URLs — never the `t.co` shortlink. */
    urls: string[];
    media: TweetMedia[];
}

export interface OutputTweet {
    id: string;
    /** `https://x.com/<username>/status/<id>` */
    url: string;
    /** Full text, unescaped, with `t.co` links expanded. */
    text: string;
    /** ISO-639-1, or `null` when X reports no detected language. */
    lang: string | null;
    createdAt: string;
    conversationId: string | null;
    isReply: boolean;
    isRetweet: boolean;
    isQuote: boolean;
    inReplyToId: string | null;
    quotedTweetId: string | null;
    author: TweetAuthor;
    metrics: TweetMetrics;
    entities: TweetEntities;
    /** Client application that posted the tweet, when X exposes it. */
    source: string | null;
    scrapedAt: string;
}

/**
 * Summary written to the run's `OUTPUT` key-value record and used as the basis
 * for the final status message (assessment §6 transparency, §7 observability).
 */
export interface RunSummary {
    requested: number;
    fetched: number;
    pushed: number;
    /** True when the free-tier cap truncated the run. */
    limited: boolean;
    reason: string | null;
    cap: number;
    tier: string;
    errors: {
        retryable: number;
        fatal: number;
    };
    targets: {
        /** Handles scraped, including any discovered from `searchTerms`. */
        users: number;
        tweetIds: number;
        searchTerms: number;
        /** Handles found by topic discovery, included in `users`. */
        discoveredHandles: number;
        /** Which search engine answered, or `null` when none did. */
        discoveryEngine: string | null;
    };
    startedAt: string;
    finishedAt: string;
    durationMs: number;
}
