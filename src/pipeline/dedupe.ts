/**
 * Deduplication and stall detection.
 *
 * Two distinct hazards, both of which show up as "the same tweet twice":
 *
 *  - **Overlapping targets.** Scraping two handles that retweet each other, or
 *    a handle plus one of its own tweet IDs, legitimately yields the same tweet
 *    from two paths. A global seen-set makes the dataset unique regardless of
 *    how targets overlap (§11 bonus).
 *
 *  - **A stalled paginator.** X sometimes returns a page whose cursor is the
 *    one we just sent, or a page of entries identical to the previous one.
 *    Following that cursor loops forever. The detector below notices repetition
 *    and ends the timeline instead.
 */

/** Tracks tweet IDs already emitted, across every target in the run. */
export class SeenSet {
    private readonly ids: Set<string>;

    constructor(initial: Iterable<string> = []) {
        this.ids = new Set(initial);
    }

    get size(): number {
        return this.ids.size;
    }

    /** @returns `true` the first time an ID is offered, `false` afterwards. */
    add(id: string): boolean {
        if (this.ids.has(id)) return false;
        this.ids.add(id);
        return true;
    }

    has(id: string): boolean {
        return this.ids.has(id);
    }

    values(): string[] {
        return [...this.ids];
    }
}

/**
 * Detects a timeline that has stopped making progress.
 *
 * Keyed on the cursor *and* the page's entry IDs together: a cursor can legally
 * repeat once while the page differs, and a page can repeat under a new cursor.
 * Only the combination recurring means we are going in circles.
 */
export class StallDetector {
    private readonly seenKeys = new Set<string>();
    private emptyPages = 0;

    constructor(private readonly maxEmptyPages: number) {}

    /**
     * Record a page and decide whether to keep paginating.
     *
     * @param usableTweets How many tweets on this page were actually usable.
     * @returns `true` when pagination should stop.
     */
    shouldStop(
        cursor: string | null,
        entryIds: readonly string[],
        usableTweets: number,
    ): boolean {
        // A timeline with no further cursor is simply finished.
        if (cursor === null) return true;

        const key = `${cursor}|${entryIds.join(',')}`;
        if (this.seenKeys.has(key)) return true;
        this.seenKeys.add(key);

        // Pages of only promoted or unavailable content are normal in small
        // numbers; a run of them means the timeline has nothing left to give.
        if (usableTweets === 0) {
            this.emptyPages += 1;
            return this.emptyPages >= this.maxEmptyPages;
        }

        this.emptyPages = 0;
        return false;
    }
}
