/**
 * Post-filters (assessment §4).
 *
 * X's timeline operations accept no filter arguments beyond a page size, so
 * every filter here is applied client-side to what the timeline returned.
 * Filters combine with **AND** semantics, and an unspecified filter means "no
 * constraint" — so an absent field must never narrow the result set.
 *
 * Filtering runs *before* emission, which matters under a cap: the items that
 * reach the dataset are the first N that actually satisfy the request, not the
 * first N fetched of which some are then discarded.
 */

import type { ScraperInput } from '../input/schema.js';
import type { OutputTweet } from '../output/types.js';
import { parseBoundaryDate } from '../util/time.js';

/** A single named predicate, so a rejection can be attributed for debugging. */
interface Filter {
    readonly name: string;
    readonly test: (tweet: OutputTweet) => boolean;
}

/** Tallies why tweets were dropped, surfaced in the run summary. */
export type FilterStats = Record<string, number>;

export class TweetFilter {
    private readonly filters: readonly Filter[];
    readonly stats: FilterStats = {};

    constructor(input: ScraperInput) {
        this.filters = buildFilters(input);
    }

    /** @returns Whether the tweet satisfies every active filter. */
    accepts(tweet: OutputTweet): boolean {
        for (const filter of this.filters) {
            if (!filter.test(tweet)) {
                this.stats[filter.name] = (this.stats[filter.name] ?? 0) + 1;
                return false;
            }
        }
        return true;
    }

    /** Lazily filter a batch, preserving order. */
    *apply(tweets: Iterable<OutputTweet>): Generator<OutputTweet> {
        for (const tweet of tweets) {
            if (this.accepts(tweet)) yield tweet;
        }
    }
}

function buildFilters(input: ScraperInput): Filter[] {
    const filters: Filter[] = [];

    // Replies and retweets are excluded by default (§4), so these are the only
    // filters that are active precisely when their flag is *false*.
    if (!input.includeReplies) {
        filters.push({ name: 'replies', test: (tweet) => !tweet.isReply });
    }
    if (!input.includeRetweets) {
        filters.push({ name: 'retweets', test: (tweet) => !tweet.isRetweet });
    }

    if (input.hashtags !== undefined && input.hashtags.length > 0) {
        // Input hashtags are already lowercased by the schema.
        const required = new Set(input.hashtags);
        filters.push({
            name: 'hashtags',
            test: (tweet) => {
                const present = new Set(tweet.entities.hashtags.map((tag) => tag.toLowerCase()));
                // "Must contain these hashtags" — every one, not any.
                for (const tag of required) if (!present.has(tag)) return false;
                return true;
            },
        });
    }

    const since = parseBoundaryDate(input.since, 'start');
    if (since !== null) {
        filters.push({
            name: 'since',
            test: (tweet) => Date.parse(tweet.createdAt) >= since,
        });
    }

    const until = parseBoundaryDate(input.until, 'end');
    if (until !== null) {
        filters.push({
            name: 'until',
            test: (tweet) => Date.parse(tweet.createdAt) <= until,
        });
    }

    if (input.language !== undefined) {
        const wanted = input.language.toLowerCase();
        filters.push({
            name: 'language',
            // A tweet with no detected language cannot satisfy a language
            // constraint, so `null` is a rejection rather than a pass.
            test: (tweet) => tweet.lang?.toLowerCase() === wanted,
        });
    }

    for (const [name, floor, read] of [
        ['minLikes', input.minLikes, (t: OutputTweet) => t.metrics.likes],
        ['minRetweets', input.minRetweets, (t: OutputTweet) => t.metrics.retweets],
        ['minReplies', input.minReplies, (t: OutputTweet) => t.metrics.replies],
    ] as const) {
        if (floor !== undefined) {
            filters.push({ name, test: (tweet) => read(tweet) >= floor });
        }
    }

    if (input.onlyVerified) {
        filters.push({ name: 'onlyVerified', test: (tweet) => tweet.author.verified });
    }

    if (input.mediaType !== 'any') {
        filters.push({ name: 'mediaType', test: mediaTypeTest(input.mediaType) });
    }

    return filters;
}

function mediaTypeTest(mediaType: ScraperInput['mediaType']): (tweet: OutputTweet) => boolean {
    switch (mediaType) {
        case 'images':
            return (tweet) => tweet.entities.media.some((m) => m.type === 'photo');
        case 'video':
            // Animated GIFs are served as video by X and read as video here.
            return (tweet) =>
                tweet.entities.media.some((m) => m.type === 'video' || m.type === 'animated_gif');
        case 'links':
            return (tweet) => tweet.entities.urls.length > 0;
        case 'text_only':
            return (tweet) => tweet.entities.media.length === 0 && tweet.entities.urls.length === 0;
        case 'any':
            return () => true;
    }
}

/**
 * Order results for output.
 *
 * X serves profile timelines newest-first, so `latest` is already satisfied and
 * left untouched — re-sorting would only risk disturbing pagination order.
 * `top` is applied over what was collected, which is the honest scope: it
 * cannot reorder tweets the timeline never returned.
 */
export function sortResults(
    tweets: readonly OutputTweet[],
    sortBy: ScraperInput['sortBy'],
): readonly OutputTweet[] {
    if (sortBy !== 'top') return tweets;
    return [...tweets].sort((a, b) => engagement(b) - engagement(a));
}

function engagement(tweet: OutputTweet): number {
    const { likes, retweets, replies, quotes } = tweet.metrics;
    return likes + retweets + replies + quotes;
}
