/**
 * Filter tests (assessment §7 requires unit tests for the filter logic).
 *
 * Two properties matter beyond "does each filter work":
 *
 *   - **An unspecified filter must not narrow anything.** A field the user did
 *     not set means "no constraint", so the default input has to pass
 *     everything that is not a reply or a retweet.
 *   - **Filters combine with AND.** Every active filter must hold, and a
 *     required hashtag means *every* listed hashtag, not any of them.
 */

import { describe, expect, it } from 'vitest';

import { sortResults, TweetFilter } from '../src/filters/apply.js';
import { parseInput } from '../src/input/parse.js';
import type { ScraperInput } from '../src/input/schema.js';
import type { OutputTweet } from '../src/output/types.js';

/** Build input through the real parser, so defaults match production. */
function inputWith(overrides: Record<string, unknown> = {}): ScraperInput {
    return parseInput({ fromUsers: ['someone'], ...overrides });
}

function tweetWith(overrides: Partial<OutputTweet> = {}): OutputTweet {
    return {
        id: '1',
        url: 'https://x.com/someone/status/1',
        text: 'hello',
        lang: 'en',
        createdAt: '2026-06-15T12:00:00.000Z',
        conversationId: '1',
        isReply: false,
        isRetweet: false,
        isQuote: false,
        inReplyToId: null,
        quotedTweetId: null,
        author: {
            id: '9',
            username: 'someone',
            name: 'Someone',
            verified: false,
            followers: 10,
            following: 5,
        },
        metrics: { likes: 100, retweets: 10, replies: 5, quotes: 1, bookmarks: 2, views: 999 },
        entities: { hashtags: [], mentions: [], urls: [], media: [] },
        source: 'Twitter Web App',
        scrapedAt: '2026-08-19T00:00:00.000Z',
        ...overrides,
    };
}

const accepts = (input: ScraperInput, tweet: OutputTweet): boolean =>
    new TweetFilter(input).accepts(tweet);

describe('defaults', () => {
    it('accepts an ordinary tweet when no filters are set', () => {
        expect(accepts(inputWith(), tweetWith())).toBe(true);
    });

    it('excludes replies and retweets by default', () => {
        expect(accepts(inputWith(), tweetWith({ isReply: true }))).toBe(false);
        expect(accepts(inputWith(), tweetWith({ isRetweet: true }))).toBe(false);
    });

    it('includes them when asked', () => {
        const input = inputWith({ includeReplies: true, includeRetweets: true });
        expect(accepts(input, tweetWith({ isReply: true }))).toBe(true);
        expect(accepts(input, tweetWith({ isRetweet: true }))).toBe(true);
    });
});

describe('hashtags', () => {
    const withTags = (tags: string[]): OutputTweet =>
        tweetWith({ entities: { hashtags: tags, mentions: [], urls: [], media: [] } });

    it('requires every listed hashtag, not merely one', () => {
        const input = inputWith({ hashtags: ['buildinpublic', 'devtools'] });
        expect(accepts(input, withTags(['buildinpublic', 'devtools', 'extra']))).toBe(true);
        expect(accepts(input, withTags(['buildinpublic']))).toBe(false);
    });

    it('compares case-insensitively and ignores a leading #', () => {
        const input = inputWith({ hashtags: ['#BuildInPublic'] });
        expect(accepts(input, withTags(['buildinpublic']))).toBe(true);
        expect(accepts(input, withTags(['BUILDINPUBLIC']))).toBe(true);
    });
});

describe('date window', () => {
    const at = (iso: string): OutputTweet => tweetWith({ createdAt: iso });

    it('treats since as inclusive from the start of the day', () => {
        const input = inputWith({ since: '2026-06-15' });
        expect(accepts(input, at('2026-06-15T00:00:00.000Z'))).toBe(true);
        expect(accepts(input, at('2026-06-14T23:59:59.000Z'))).toBe(false);
    });

    it('treats until as inclusive through the end of the day', () => {
        const input = inputWith({ until: '2026-06-15' });
        // The bug this guards: a bare date parsed as midnight would exclude
        // everything actually posted on that day.
        expect(accepts(input, at('2026-06-15T23:59:59.000Z'))).toBe(true);
        expect(accepts(input, at('2026-06-16T00:00:00.000Z'))).toBe(false);
    });

    it('rejects a window that ends before it starts', () => {
        expect(() => inputWith({ since: '2026-06-15', until: '2026-06-01' })).toThrow(
            /Empty date window/,
        );
    });
});

describe('language', () => {
    it('matches the requested code', () => {
        const input = inputWith({ language: 'es' });
        expect(accepts(input, tweetWith({ lang: 'es' }))).toBe(true);
        expect(accepts(input, tweetWith({ lang: 'en' }))).toBe(false);
    });

    it('rejects a tweet with no detected language', () => {
        // `null` cannot satisfy a language constraint, so it is a rejection
        // rather than a pass-through.
        expect(accepts(inputWith({ language: 'en' }), tweetWith({ lang: null }))).toBe(false);
    });
});

describe('engagement floors', () => {
    const metrics = (over: Partial<OutputTweet['metrics']>): OutputTweet =>
        tweetWith({ metrics: { ...tweetWith().metrics, ...over } });

    it('is inclusive at the boundary', () => {
        expect(accepts(inputWith({ minLikes: 100 }), metrics({ likes: 100 }))).toBe(true);
        expect(accepts(inputWith({ minLikes: 101 }), metrics({ likes: 100 }))).toBe(false);
    });

    it('applies to retweets and replies independently', () => {
        expect(accepts(inputWith({ minRetweets: 20 }), metrics({ retweets: 10 }))).toBe(false);
        expect(accepts(inputWith({ minReplies: 3 }), metrics({ replies: 5 }))).toBe(true);
    });
});

describe('onlyVerified', () => {
    it('keeps only verified authors', () => {
        const input = inputWith({ onlyVerified: true });
        const verified = tweetWith({ author: { ...tweetWith().author, verified: true } });
        expect(accepts(input, verified)).toBe(true);
        expect(accepts(input, tweetWith())).toBe(false);
    });
});

describe('mediaType', () => {
    const media = (items: OutputTweet['entities']['media'], urls: string[] = []): OutputTweet =>
        tweetWith({ entities: { hashtags: [], mentions: [], urls, media: items } });

    const photo = { type: 'photo' as const, url: 'https://x/p.jpg', thumbnail: null };
    const video = { type: 'video' as const, url: 'https://x/v.mp4', thumbnail: 'https://x/t.jpg' };
    const gif = { type: 'animated_gif' as const, url: 'https://x/g.mp4', thumbnail: null };

    it('any imposes no constraint', () => {
        expect(accepts(inputWith({ mediaType: 'any' }), media([]))).toBe(true);
        expect(accepts(inputWith({ mediaType: 'any' }), media([photo]))).toBe(true);
    });

    it('images requires a photo', () => {
        expect(accepts(inputWith({ mediaType: 'images' }), media([photo]))).toBe(true);
        expect(accepts(inputWith({ mediaType: 'images' }), media([video]))).toBe(false);
    });

    it('video counts animated GIFs, which X serves as video', () => {
        expect(accepts(inputWith({ mediaType: 'video' }), media([video]))).toBe(true);
        expect(accepts(inputWith({ mediaType: 'video' }), media([gif]))).toBe(true);
        expect(accepts(inputWith({ mediaType: 'video' }), media([photo]))).toBe(false);
    });

    it('links requires an external URL', () => {
        expect(accepts(inputWith({ mediaType: 'links' }), media([], ['https://e.com']))).toBe(true);
        expect(accepts(inputWith({ mediaType: 'links' }), media([]))).toBe(false);
    });

    it('text_only requires neither media nor links', () => {
        expect(accepts(inputWith({ mediaType: 'text_only' }), media([]))).toBe(true);
        expect(accepts(inputWith({ mediaType: 'text_only' }), media([photo]))).toBe(false);
        expect(accepts(inputWith({ mediaType: 'text_only' }), media([], ['https://e.com']))).toBe(
            false,
        );
    });
});

describe('AND semantics', () => {
    const input = inputWith({
        language: 'en',
        minLikes: 50,
        onlyVerified: true,
        hashtags: ['ai'],
    });
    const verifiedAuthor = { ...tweetWith().author, verified: true };
    const passing = tweetWith({
        author: verifiedAuthor,
        entities: { hashtags: ['ai'], mentions: [], urls: [], media: [] },
    });

    it('accepts a tweet satisfying every filter', () => {
        expect(accepts(input, passing)).toBe(true);
    });

    it.each([
        ['language', { lang: 'es' }],
        ['likes', { metrics: { ...tweetWith().metrics, likes: 1 } }],
        ['verified', { author: tweetWith().author }],
        ['hashtags', { entities: { hashtags: [], mentions: [], urls: [], media: [] } }],
    ])('rejects when only %s fails', (_label, override) => {
        expect(accepts(input, { ...passing, ...override })).toBe(false);
    });

    it('attributes each rejection to the filter responsible', () => {
        const filter = new TweetFilter(input);
        filter.accepts({ ...passing, lang: 'fr' });
        expect(filter.stats.language).toBe(1);
    });
});

describe('sortResults', () => {
    const byId = (tweets: readonly OutputTweet[]): string[] => tweets.map((t) => t.id);
    const engaged = (id: string, likes: number): OutputTweet =>
        tweetWith({ id, metrics: { ...tweetWith().metrics, likes } });

    it('leaves latest untouched — X already serves newest first', () => {
        const tweets = [engaged('a', 1), engaged('b', 500), engaged('c', 10)];
        expect(byId(sortResults(tweets, 'latest'))).toEqual(['a', 'b', 'c']);
    });

    it('orders top by total engagement', () => {
        const tweets = [engaged('a', 1), engaged('b', 500), engaged('c', 10)];
        expect(byId(sortResults(tweets, 'top'))).toEqual(['b', 'c', 'a']);
    });

    it('does not mutate its input', () => {
        const tweets = [engaged('a', 1), engaged('b', 500)];
        sortResults(tweets, 'top');
        expect(byId(tweets)).toEqual(['a', 'b']);
    });
});
