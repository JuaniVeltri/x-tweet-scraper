/**
 * Timeline walking: turn X's instruction tree into tweets plus a cursor.
 *
 * A timeline response is not a list. It is a list of *instructions* the client
 * is meant to apply to a local store — add entries, pin an entry, clear the
 * cache, terminate. Entries then nest differently depending on whether they are
 * a single tweet or a conversation module.
 *
 * This module flattens all of that, tolerating unknown instruction and entry
 * types rather than failing on them: X adds new ones regularly and an
 * unrecognised entry should cost one tweet, never the run.
 */

import { getArray, getFirst, getString, isRecord } from '../util/json.js';

export interface TimelinePage {
    /** Raw `tweet_results.result` nodes, in timeline order. */
    readonly tweets: readonly unknown[];
    /** Cursor for the next (older) page, or `null` at the end of the timeline. */
    readonly nextCursor: string | null;
    /** Entry IDs seen on this page; used to detect a stalled paginator. */
    readonly entryIds: readonly string[];
}

/** Instruction shapes that carry entries, mapped to where the entries live. */
const ENTRY_BEARING_KEYS = ['entries', 'entry'] as const;

/**
 * Extract tweets and the bottom cursor from a timeline response.
 *
 * @param data The `data` object of a `UserTweets` response.
 */
export function walkTimeline(data: unknown): TimelinePage {
    const instructions = getFirst(data, [
        'user.result.timeline_v2.timeline.instructions', // current
        'user.result.timeline.timeline.instructions', // older / other surfaces
    ]);

    const tweets: unknown[] = [];
    const entryIds: string[] = [];
    let nextCursor: string | null = null;

    if (!Array.isArray(instructions)) return { tweets, nextCursor, entryIds };

    for (const instruction of instructions) {
        for (const entry of entriesOf(instruction)) {
            if (!isRecord(entry)) continue;

            const entryId = getString(entry, 'entryId');
            if (entryId !== undefined) entryIds.push(entryId);

            const cursor = readBottomCursor(entry);
            if (cursor !== null) {
                nextCursor = cursor;
                continue;
            }

            tweets.push(...tweetsOf(entry));
        }
    }

    return { tweets, nextCursor, entryIds };
}

/** Normalize the two shapes an instruction uses to carry entries. */
function entriesOf(instruction: unknown): readonly unknown[] {
    if (!isRecord(instruction)) return [];
    for (const key of ENTRY_BEARING_KEYS) {
        const value = instruction[key];
        if (Array.isArray(value)) return value;
        if (isRecord(value)) return [value];
    }
    return [];
}

/**
 * Pull tweets out of an entry.
 *
 * Two layouts occur: a plain item entry holding one tweet, and a module entry
 * (conversations, "who to follow"-style grids) holding several.
 */
function tweetsOf(entry: unknown): unknown[] {
    const found: unknown[] = [];

    const direct = getFirst(entry, [
        'content.itemContent.tweet_results.result',
        'content.itemContent.tweetResult.result',
    ]);
    if (direct !== undefined) found.push(unwrapTweet(direct));

    for (const item of getArray(entry, 'content.items')) {
        const nested = getFirst(item, [
            'item.itemContent.tweet_results.result',
            'item.itemContent.tweetResult.result',
        ]);
        if (nested !== undefined) found.push(unwrapTweet(nested));
    }

    return found;
}

/**
 * Unwrap `TweetWithVisibilityResults`.
 *
 * When a tweet carries visibility limitations X wraps it, moving the real tweet
 * one level down under `.tweet`. Missing this unwrap is a well-known source of
 * silently dropped tweets, so it is handled centrally here.
 */
export function unwrapTweet(node: unknown): unknown {
    if (!isRecord(node)) return node;
    if (getString(node, '__typename') === 'TweetWithVisibilityResults') {
        const inner = node['tweet'];
        if (inner !== undefined) return inner;
    }
    return node;
}

/**
 * Find the "load older tweets" cursor.
 *
 * Only the `Bottom` cursor advances pagination; `Top` walks toward newer
 * tweets and would loop forever against a live timeline.
 */
function readBottomCursor(entry: unknown): string | null {
    const contentType = getFirst(entry, ['content.entryType', 'content.__typename']);
    const cursorType = getString(entry, 'content.cursorType');

    if (contentType === 'TimelineTimelineCursor' && cursorType === 'Bottom') {
        return getString(entry, 'content.value') ?? null;
    }

    // Module entries can carry their cursor one level deeper.
    for (const item of getArray(entry, 'content.items')) {
        const itemCursorType = getString(item, 'item.itemContent.cursorType');
        if (itemCursorType === 'Bottom') {
            return getString(item, 'item.itemContent.value') ?? null;
        }
    }

    return null;
}
