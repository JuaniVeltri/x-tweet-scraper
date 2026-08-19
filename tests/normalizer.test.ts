/**
 * Normalizer tests, run against **real captured responses** rather than
 * hand-written fixtures.
 *
 * The two timeline fixtures are the same profile fetched through two different
 * query IDs, which X answers with two different user schemas:
 *
 *   - `user-tweets.legacy-schema.json` — `user.legacy` populated.
 *   - `user-tweets.core-schema.json`   — `user.legacy` null, fields moved to
 *     `core`, `relationship_counts` and `verification`.
 *
 * Both must produce byte-identical output shapes, because the dataset contract
 * (§5) cannot change just because X rotated a query ID.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { normalizeTweet } from '../src/normalize/tweet.js';
import { walkTimeline } from '../src/normalize/timeline.js';
import type { OutputTweet } from '../src/output/types.js';

function loadFixture(name: string): unknown {
    const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
    return JSON.parse(readFileSync(path, 'utf8'));
}

/** Fixtures are full HTTP responses; the walker consumes the `data` object. */
function timelineData(name: string): unknown {
    const body = loadFixture(name);
    return (body as { data?: unknown }).data;
}

const SCHEMAS = [
    { label: 'legacy schema (user.legacy populated)', file: 'user-tweets.legacy-schema.json' },
    { label: 'core schema (user.legacy null)', file: 'user-tweets.core-schema.json' },
] as const;

describe('walkTimeline', () => {
    for (const { label, file } of SCHEMAS) {
        it(`extracts tweets and a bottom cursor — ${label}`, () => {
            const page = walkTimeline(timelineData(file));

            expect(page.tweets.length).toBeGreaterThan(0);
            expect(page.entryIds.length).toBeGreaterThan(0);
            // A live profile timeline always offers an older page.
            expect(page.nextCursor).toBeTypeOf('string');
            expect(page.nextCursor).not.toBe('');
        });
    }

    it('returns an empty page instead of throwing on an unknown shape', () => {
        expect(walkTimeline({})).toEqual({ tweets: [], nextCursor: null, entryIds: [] });
        expect(walkTimeline(null)).toEqual({ tweets: [], nextCursor: null, entryIds: [] });
    });
});

describe('normalizeTweet', () => {
    for (const { label, file } of SCHEMAS) {
        describe(label, () => {
            const page = walkTimeline(timelineData(file));
            const normalized = page.tweets
                .map((raw) => normalizeTweet(raw, '2026-08-19T00:00:00.000Z'))
                .filter((tweet): tweet is OutputTweet => tweet !== null);

            it('normalizes every tweet in the page', () => {
                expect(normalized.length).toBe(page.tweets.length);
            });

            it('emits IDs as strings that survive round-tripping', () => {
                for (const tweet of normalized) {
                    expect(typeof tweet.id).toBe('string');
                    expect(tweet.id).toMatch(/^\d+$/);
                    // The invariant that motivates string IDs: these values
                    // exceed Number.MAX_SAFE_INTEGER.
                    expect(String(BigInt(tweet.id))).toBe(tweet.id);
                }
            });

            it('resolves the author across both user schemas', () => {
                for (const tweet of normalized) {
                    expect(tweet.author.username).not.toBe('');
                    expect(tweet.author.id).toMatch(/^\d+$/);
                    expect(typeof tweet.author.verified).toBe('boolean');
                    expect(tweet.author.followers).toBeGreaterThan(0);
                    expect(tweet.author.following).toBeGreaterThan(0);
                }
            });

            it('emits ISO-8601 UTC timestamps', () => {
                for (const tweet of normalized) {
                    expect(tweet.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
                    expect(Number.isNaN(Date.parse(tweet.createdAt))).toBe(false);
                    expect(tweet.scrapedAt).toBe('2026-08-19T00:00:00.000Z');
                }
            });

            it('builds a canonical URL from the resolved handle', () => {
                for (const tweet of normalized) {
                    expect(tweet.url).toBe(
                        `https://x.com/${tweet.author.username}/status/${tweet.id}`,
                    );
                }
            });

            it('never leaves a contract key undefined or absent', () => {
                const required: readonly (keyof OutputTweet)[] = [
                    'id', 'url', 'text', 'lang', 'createdAt', 'conversationId',
                    'isReply', 'isRetweet', 'isQuote', 'inReplyToId', 'quotedTweetId',
                    'author', 'metrics', 'entities', 'source', 'scrapedAt',
                ];
                for (const tweet of normalized) {
                    for (const key of required) {
                        expect(Object.hasOwn(tweet, key)).toBe(true);
                        expect(tweet[key]).not.toBeUndefined();
                    }
                    for (const value of Object.values(tweet.metrics)) {
                        expect(value === null || typeof value === 'number').toBe(true);
                    }
                }
            });

            it('leaves no t.co shortlink in the text', () => {
                for (const tweet of normalized) {
                    expect(tweet.text).not.toMatch(/https:\/\/t\.co\//);
                }
            });

            it('strips the anchor markup from source', () => {
                for (const tweet of normalized) {
                    if (tweet.source === null) continue;
                    expect(tweet.source).not.toContain('<');
                    expect(tweet.source).not.toContain('href');
                }
            });

            it('reports entities as arrays of plain strings', () => {
                for (const tweet of normalized) {
                    for (const tag of tweet.entities.hashtags) {
                        expect(tag.startsWith('#')).toBe(false);
                    }
                    for (const mention of tweet.entities.mentions) {
                        expect(mention.startsWith('@')).toBe(false);
                    }
                    for (const url of tweet.entities.urls) {
                        expect(url).not.toMatch(/^https:\/\/t\.co\//);
                    }
                    for (const media of tweet.entities.media) {
                        expect(['photo', 'video', 'animated_gif']).toContain(media.type);
                        expect(media.url).toMatch(/^https:\/\//);
                    }
                }
            });
        });
    }

    it('produces the same author for the same profile across both schemas', () => {
        const [legacy, core] = SCHEMAS.map(({ file }) => {
            const page = walkTimeline(timelineData(file));
            const first = page.tweets
                .map((raw) => normalizeTweet(raw))
                .find((tweet): tweet is OutputTweet => tweet !== null);
            return first?.author;
        });

        expect(legacy).toBeDefined();
        expect(core).toBeDefined();
        expect(legacy?.username).toBe(core?.username);
        expect(legacy?.id).toBe(core?.id);
        expect(legacy?.name).toBe(core?.name);
    });

    it('returns null rather than a half-populated item', () => {
        expect(normalizeTweet(null)).toBeNull();
        expect(normalizeTweet({})).toBeNull();
        // Has an ID but no timestamp and no author: not contract-conforming.
        expect(normalizeTweet({ rest_id: '123' })).toBeNull();
    });
});
