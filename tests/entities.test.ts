/**
 * Entity extraction (assessment §5).
 *
 * Two things here are easy to get quietly wrong.
 *
 * X splits media across two keys: `entities.media` holds only the *first*
 * attachment, `extended_entities.media` holds all of them. Reading the former —
 * the more obvious name — silently loses images from every multi-photo tweet,
 * and nothing about the output looks broken.
 *
 * And video arrives as a list of variants at different bitrates plus an HLS
 * playlist. Picking the first is a coin flip on quality; picking the playlist
 * hands the consumer something they cannot download.
 */

import { describe, expect, it } from 'vitest';

import {
    extractEntities,
    extractHashtags,
    extractMedia,
    extractMentions,
    extractUrls,
} from '../src/normalize/entities.js';

describe('hashtags', () => {
    it('reads the texts without the leading #', () => {
        const legacy = { entities: { hashtags: [{ text: 'buildinpublic' }, { text: 'ai' }] } };
        expect(extractHashtags(legacy)).toEqual(['buildinpublic', 'ai']);
    });

    it('returns an empty array when there are none, never undefined', () => {
        expect(extractHashtags({ entities: {} })).toEqual([]);
        expect(extractHashtags({})).toEqual([]);
        expect(extractHashtags(null)).toEqual([]);
    });

    it('skips malformed entries instead of emitting empty strings', () => {
        const legacy = { entities: { hashtags: [{ text: 'ok' }, {}, { text: '' }, null] } };
        expect(extractHashtags(legacy)).toEqual(['ok']);
    });
});

describe('mentions', () => {
    it('reads handles without the leading @', () => {
        const legacy = { entities: { user_mentions: [{ screen_name: 'apify' }] } };
        expect(extractMentions(legacy)).toEqual(['apify']);
    });

    it('returns an empty array when absent', () => {
        expect(extractMentions({})).toEqual([]);
    });
});

describe('urls', () => {
    it('prefers the expanded destination over the t.co shortlink', () => {
        const legacy = {
            entities: {
                urls: [{ url: 'https://t.co/abc', expanded_url: 'https://apify.com/store' }],
            },
        };
        expect(extractUrls(legacy)).toEqual(['https://apify.com/store']);
    });

    it('falls back to the shortlink only when there is no expansion', () => {
        const legacy = { entities: { urls: [{ url: 'https://t.co/abc' }] } };
        expect(extractUrls(legacy)).toEqual(['https://t.co/abc']);
    });

    it('also reads the URLs of a long-form note tweet', () => {
        // Tweets past 280 characters carry their own entity set; missing it
        // drops every link from the longest posts.
        const legacy = {
            entities: { urls: [{ expanded_url: 'https://a.com' }] },
            note_tweet_results: {
                result: { entity_set: { urls: [{ expanded_url: 'https://b.com' }] } },
            },
        };
        expect(extractUrls(legacy)).toEqual(['https://a.com', 'https://b.com']);
    });
});

describe('media', () => {
    const photo = {
        type: 'photo',
        media_url_https: 'https://pbs.twimg.com/media/one.jpg',
        url: 'https://t.co/x',
    };
    const photoTwo = { ...photo, media_url_https: 'https://pbs.twimg.com/media/two.jpg' };

    it('prefers extended_entities, which is the only complete list', () => {
        // The bug this guards: `entities.media` carries just the first item, so
        // a four-photo tweet would silently emit one.
        const legacy = {
            entities: { media: [photo] },
            extended_entities: { media: [photo, photoTwo] },
        };
        expect(extractMedia(legacy)).toHaveLength(2);
    });

    it('falls back to entities.media when there is no extended set', () => {
        expect(extractMedia({ entities: { media: [photo] } })).toHaveLength(1);
    });

    it('leaves a photo thumbnail null rather than duplicating the URL', () => {
        expect(extractMedia({ extended_entities: { media: [photo] } })).toEqual([
            { type: 'photo', url: 'https://pbs.twimg.com/media/one.jpg', thumbnail: null },
        ]);
    });

    it('picks the highest-bitrate MP4 for a video', () => {
        const video = {
            type: 'video',
            media_url_https: 'https://pbs.twimg.com/still.jpg',
            video_info: {
                variants: [
                    { content_type: 'video/mp4', bitrate: 832_000, url: 'https://v/low.mp4' },
                    { content_type: 'video/mp4', bitrate: 2_176_000, url: 'https://v/high.mp4' },
                    { content_type: 'video/mp4', bitrate: 1_280_000, url: 'https://v/mid.mp4' },
                ],
            },
        };
        expect(extractMedia({ extended_entities: { media: [video] } })).toEqual([
            {
                type: 'video',
                url: 'https://v/high.mp4',
                thumbnail: 'https://pbs.twimg.com/still.jpg',
            },
        ]);
    });

    it('skips the HLS playlist, which carries no bitrate and cannot be downloaded', () => {
        const video = {
            type: 'video',
            media_url_https: 'https://pbs.twimg.com/still.jpg',
            video_info: {
                variants: [
                    { content_type: 'application/x-mpegURL', url: 'https://v/playlist.m3u8' },
                    { content_type: 'video/mp4', bitrate: 832_000, url: 'https://v/low.mp4' },
                ],
            },
        };
        expect(extractMedia({ extended_entities: { media: [video] } })[0]?.url).toBe(
            'https://v/low.mp4',
        );
    });

    it('still returns a GIF, which X serves as MP4 with no bitrate', () => {
        // Bitrate is absent here, so a naive "highest bitrate" would find
        // nothing and drop the media entirely.
        const gif = {
            type: 'animated_gif',
            media_url_https: 'https://pbs.twimg.com/gif-still.jpg',
            video_info: { variants: [{ content_type: 'video/mp4', url: 'https://v/anim.mp4' }] },
        };
        expect(extractMedia({ extended_entities: { media: [gif] } })).toEqual([
            {
                type: 'animated_gif',
                url: 'https://v/anim.mp4',
                thumbnail: 'https://pbs.twimg.com/gif-still.jpg',
            },
        ]);
    });

    it('falls back to the still frame when a video has no usable variant', () => {
        const video = {
            type: 'video',
            media_url_https: 'https://pbs.twimg.com/still.jpg',
            video_info: { variants: [{ content_type: 'application/x-mpegURL', url: 'https://v/p.m3u8' }] },
        };
        expect(extractMedia({ extended_entities: { media: [video] } })[0]?.url).toBe(
            'https://pbs.twimg.com/still.jpg',
        );
    });

    it('ignores a media type outside the contract', () => {
        const odd = { type: 'hologram', media_url_https: 'https://x/y.jpg' };
        expect(extractMedia({ extended_entities: { media: [odd] } })).toEqual([]);
    });

    it('skips an entry with no usable URL at all', () => {
        expect(extractMedia({ extended_entities: { media: [{ type: 'photo' }] } })).toEqual([]);
    });

    it('returns an empty array when there is no media', () => {
        expect(extractMedia({})).toEqual([]);
        expect(extractMedia(null)).toEqual([]);
    });
});

describe('extractEntities', () => {
    it('always returns all four keys, even for a bare tweet', () => {
        // The contract promises these keys exist; a consumer should never have
        // to guard against one being absent.
        expect(extractEntities({})).toEqual({
            hashtags: [], mentions: [], urls: [], media: [],
        });
    });
});
