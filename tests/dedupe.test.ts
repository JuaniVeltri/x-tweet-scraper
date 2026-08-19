/**
 * Deduplication and stall detection (assessment §7, §11).
 *
 * Two hazards that both present as "the same tweet twice", with different
 * causes and different fixes.
 *
 * The stall detector is the subtle one. X sometimes hands back the cursor you
 * just sent, or a page of entries identical to the previous one. Following that
 * cursor loops forever — a run that never ends, burning the rate limit on
 * nothing. But cursors can also legitimately repeat once while the page differs,
 * so stopping on the cursor alone would truncate good timelines.
 */

import { describe, expect, it } from 'vitest';

import { SeenSet, StallDetector } from '../src/pipeline/dedupe.js';

describe('SeenSet', () => {
    it('accepts an ID once and refuses it afterwards', () => {
        const seen = new SeenSet();
        expect(seen.add('123')).toBe(true);
        expect(seen.add('123')).toBe(false);
        expect(seen.size).toBe(1);
    });

    it('deduplicates across overlapping targets', () => {
        // Two handles that retweet each other legitimately yield the same tweet
        // from two paths; the dataset must still be unique.
        const seen = new SeenSet();
        expect(seen.add('shared')).toBe(true);
        expect(seen.add('shared')).toBe(false);
    });

    it('rehydrates from a previous run segment', () => {
        // After a migration, IDs already emitted must not be emitted again.
        const seen = new SeenSet(['a', 'b']);
        expect(seen.has('a')).toBe(true);
        expect(seen.add('a')).toBe(false);
        expect(seen.add('c')).toBe(true);
        expect(seen.values().sort()).toEqual(['a', 'b', 'c']);
    });

    it('treats IDs as opaque strings, since they are snowflakes', () => {
        const seen = new SeenSet();
        expect(seen.add('2087572956683567110')).toBe(true);
        // One digit apart, and beyond Number.MAX_SAFE_INTEGER — they must not
        // collapse into each other.
        expect(seen.add('2087572956683567111')).toBe(true);
        expect(seen.size).toBe(2);
    });
});

describe('StallDetector', () => {
    const detector = () => new StallDetector(3);

    it('stops when the timeline offers no further cursor', () => {
        expect(detector().shouldStop(null, ['e1'], 5)).toBe(true);
    });

    it('keeps going on a normal page', () => {
        expect(detector().shouldStop('cursor-1', ['e1', 'e2'], 20)).toBe(false);
    });

    it('stops when the same cursor and page come back', () => {
        // The infinite-loop case: X returns the cursor just sent, with the same
        // entries. Following it again would repeat forever.
        const d = detector();
        expect(d.shouldStop('cursor-1', ['e1', 'e2'], 20)).toBe(false);
        expect(d.shouldStop('cursor-1', ['e1', 'e2'], 20)).toBe(true);
    });

    it('allows a cursor to repeat when the page genuinely differs', () => {
        // Keying on the cursor alone would truncate a good timeline here.
        const d = detector();
        expect(d.shouldStop('cursor-1', ['e1'], 20)).toBe(false);
        expect(d.shouldStop('cursor-1', ['e2'], 20)).toBe(false);
    });

    it('allows the same page under a different cursor', () => {
        const d = detector();
        expect(d.shouldStop('cursor-1', ['e1'], 20)).toBe(false);
        expect(d.shouldStop('cursor-2', ['e1'], 20)).toBe(false);
    });

    it('tolerates a couple of empty pages before giving up', () => {
        // Pages of only promoted or unavailable content are normal in ones and
        // twos; a run of them means the timeline has nothing left.
        const d = detector();
        expect(d.shouldStop('c1', ['e1'], 0)).toBe(false);
        expect(d.shouldStop('c2', ['e2'], 0)).toBe(false);
        expect(d.shouldStop('c3', ['e3'], 0)).toBe(true);
    });

    it('resets the empty-page count after a page with content', () => {
        const d = detector();
        d.shouldStop('c1', ['e1'], 0);
        d.shouldStop('c2', ['e2'], 0);
        expect(d.shouldStop('c3', ['e3'], 15)).toBe(false); // content again
        // The counter restarted, so two more empties are still tolerated.
        expect(d.shouldStop('c4', ['e4'], 0)).toBe(false);
        expect(d.shouldStop('c5', ['e5'], 0)).toBe(false);
        expect(d.shouldStop('c6', ['e6'], 0)).toBe(true);
    });

    it('honours a tighter tolerance', () => {
        const d = new StallDetector(1);
        expect(d.shouldStop('c1', ['e1'], 0)).toBe(true);
    });

    it('treats entry order as significant, since a reordered page is a new page', () => {
        const d = detector();
        expect(d.shouldStop('c1', ['a', 'b'], 5)).toBe(false);
        expect(d.shouldStop('c1', ['b', 'a'], 5)).toBe(false);
    });

    it('does not confuse pages whose entry IDs concatenate the same', () => {
        // A naive join would make ['ab','c'] and ['a','bc'] identical keys.
        const d = detector();
        expect(d.shouldStop('c1', ['ab', 'c'], 5)).toBe(false);
        expect(d.shouldStop('c1', ['a', 'bc'], 5)).toBe(false);
    });
});
