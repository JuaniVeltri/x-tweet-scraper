/**
 * Entity extraction: hashtags, mentions, URLs and media (assessment §5).
 *
 * X splits media across two keys — `entities.media` holds only the first item,
 * `extended_entities.media` holds all of them — so anything reading the former
 * silently loses images from multi-photo tweets. This module always prefers
 * `extended_entities`.
 */

import type { MediaKind, TweetEntities, TweetMedia } from '../output/types.js';
import { getArray, getFirstArray, getNumber, getString, isRecord } from '../util/json.js';

/** X's media type strings, which map 1:1 onto the output contract. */
const MEDIA_KINDS = new Set<MediaKind>(['photo', 'video', 'animated_gif']);

export function extractEntities(tweetLegacy: unknown): TweetEntities {
    return {
        hashtags: extractHashtags(tweetLegacy),
        mentions: extractMentions(tweetLegacy),
        urls: extractUrls(tweetLegacy),
        media: extractMedia(tweetLegacy),
    };
}

/** Hashtag texts, without `#`. */
export function extractHashtags(tweetLegacy: unknown): string[] {
    return getArray(tweetLegacy, 'entities.hashtags')
        .map((tag) => getString(tag, 'text'))
        .filter((text): text is string => text !== undefined && text.length > 0);
}

/** Mentioned handles, without `@`. */
export function extractMentions(tweetLegacy: unknown): string[] {
    return getArray(tweetLegacy, 'entities.user_mentions')
        .map((mention) => getString(mention, 'screen_name'))
        .filter((name): name is string => name !== undefined && name.length > 0);
}

/**
 * Expanded URLs. Never the `t.co` shortlink — the contract asks for the real
 * destination, and a shortlink is useless to a downstream consumer.
 */
export function extractUrls(tweetLegacy: unknown): string[] {
    const fromEntities = getArray(tweetLegacy, 'entities.urls');
    const fromNoteTweet = getArray(tweetLegacy, 'note_tweet_results.result.entity_set.urls');
    return [...fromEntities, ...fromNoteTweet]
        .map((entry) => getString(entry, 'expanded_url') ?? getString(entry, 'url'))
        .filter((url): url is string => url !== undefined && url.length > 0);
}

/** Media attachments, preferring the complete `extended_entities` list. */
export function extractMedia(tweetLegacy: unknown): TweetMedia[] {
    const items = getFirstArray(tweetLegacy, [
        'extended_entities.media', // all attachments
        'entities.media', // first attachment only
    ]);

    const media: TweetMedia[] = [];
    for (const item of items) {
        if (!isRecord(item)) continue;

        const rawType = getString(item, 'type');
        if (rawType === undefined || !MEDIA_KINDS.has(rawType as MediaKind)) continue;
        const type = rawType as MediaKind;

        const still = getString(item, 'media_url_https');
        const url = type === 'photo' ? still : (bestVariantUrl(item) ?? still);
        if (url === undefined) continue;

        media.push({
            type,
            url,
            // For video and GIFs the still frame is the useful thumbnail; for a
            // photo the thumbnail would just repeat `url`, so it stays null.
            thumbnail: type === 'photo' ? null : (still ?? null),
        });
    }
    return media;
}

/**
 * Highest-bitrate MP4 variant of a video or GIF.
 *
 * HLS playlists (`application/x-mpegURL`) are skipped: they carry no bitrate
 * and are not directly downloadable, which makes them a poor value for a
 * dataset consumer.
 */
function bestVariantUrl(mediaItem: unknown): string | undefined {
    let bestUrl: string | undefined;
    let bestBitrate = -1;

    for (const variant of getArray(mediaItem, 'video_info.variants')) {
        const contentType = getString(variant, 'content_type');
        if (contentType !== 'video/mp4') continue;
        const url = getString(variant, 'url');
        if (url === undefined) continue;
        // Animated GIFs are served as MP4 with no bitrate; treat as 0 so they
        // still win over nothing.
        const bitrate = getNumber(variant, 'bitrate') ?? 0;
        if (bitrate > bestBitrate) {
            bestBitrate = bitrate;
            bestUrl = url;
        }
    }
    return bestUrl;
}
