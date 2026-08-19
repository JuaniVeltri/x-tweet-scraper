/**
 * The enforcement point (assessment §6).
 *
 * The assessment is specific about *where* the cap must live: *"Apply the cap
 * where results are emitted (push loop / pagination), not by clamping
 * maxResults at the top. A correct implementation stops fetching and pushing at
 * 10 for free users regardless of any input."*
 *
 * So this is the only object in the system that can write to the dataset, and
 * its limit is fixed at construction from a resolved {@link Entitlement}. There
 * is no setter, no way to raise it later, and no code path that reads the
 * limit from user input.
 *
 * Producers do not decide when to stop — they ask. {@link ResultEmitter.isOpen}
 * going false is what ends pagination, which is why a capped run also stops
 * *fetching* rather than fetching everything and throwing most of it away.
 */

import { Actor, log } from 'apify';

import { effectiveCap } from '../entitlements/resolver.js';
import type { Entitlement } from '../entitlements/types.js';
import type { OutputTweet } from '../output/types.js';

/** Sink for emitted items; the dataset in production, an array in tests. */
export type ItemSink = (items: readonly OutputTweet[]) => Promise<void>;

export interface EmitterOptions {
    /** Items are pushed in batches of this size to amortise API calls. */
    readonly batchSize?: number;
    readonly sink?: ItemSink;
}

export class ResultEmitter {
    /**
     * The hard ceiling for this run. Derived once, from the entitlement and the
     * requested count, and never mutated.
     */
    readonly limit: number;

    private readonly buffer: OutputTweet[] = [];
    private readonly batchSize: number;
    private readonly sink: ItemSink;
    private emitted = 0;
    private suppressed = 0;

    constructor(
        private readonly entitlement: Entitlement,
        private readonly requested: number,
        options: EmitterOptions = {},
    ) {
        this.limit = effectiveCap(entitlement, requested);
        this.batchSize = options.batchSize ?? 50;
        this.sink = options.sink ?? (async (items) => Actor.pushData([...items]));
    }

    /** How many items have actually reached the dataset. */
    get count(): number {
        return this.emitted;
    }

    /** Items rejected because the run was already at its limit. */
    get suppressedCount(): number {
        return this.suppressed;
    }

    /** True while the run may still emit. Producers poll this to stop early. */
    get isOpen(): boolean {
        return this.emitted + this.buffer.length < this.limit;
    }

    get remaining(): number {
        return Math.max(0, this.limit - (this.emitted + this.buffer.length));
    }

    /**
     * True when the entitlement — not the request — is what truncated the run.
     *
     * Suppression alone is the wrong signal: a well-behaved producer stops
     * offering once {@link isOpen} goes false, so nothing is ever suppressed and
     * a capped run would report itself as unlimited. What actually matters is
     * whether the ceiling that bound the run came from the entitlement, and
     * whether the run reached it.
     */
    get wasLimitedByEntitlement(): boolean {
        // The request asked for no more than we were entitled to: whatever
        // truncated the run, it was not the entitlement.
        if (this.entitlement.cap >= this.requested) return false;
        // The entitlement was the lower ceiling — but it only *bit* if the run
        // actually ran out of room, rather than running out of tweets.
        return this.emitted >= this.limit || this.suppressed > 0;
    }

    /**
     * Offer an item.
     *
     * @returns Whether it was accepted. A `false` is not an error: it is the
     *   cap doing its job, and the producer should stop.
     */
    async offer(item: OutputTweet): Promise<boolean> {
        if (!this.isOpen) {
            this.suppressed += 1;
            return false;
        }

        this.buffer.push(item);
        if (this.buffer.length >= this.batchSize) await this.flush();
        return true;
    }

    /**
     * Offer several items, stopping at the limit.
     *
     * @returns How many were accepted.
     */
    async offerAll(items: Iterable<OutputTweet>): Promise<number> {
        let accepted = 0;
        for (const item of items) {
            if (!(await this.offer(item))) break;
            accepted += 1;
        }
        return accepted;
    }

    /** Write any buffered items. Safe to call repeatedly. */
    async flush(): Promise<void> {
        if (this.buffer.length === 0) return;

        // Defence in depth: even if a producer somehow queued past the limit,
        // the batch is trimmed before it can reach the dataset.
        const room = Math.max(0, this.limit - this.emitted);
        const batch = this.buffer.splice(0, this.buffer.length).slice(0, room);
        this.suppressed += this.buffer.length;

        if (batch.length === 0) return;
        await this.sink(batch);
        this.emitted += batch.length;
    }

    /**
     * Flush and report what the cap did, if anything.
     *
     * The assessment asks for an explicit signal when the cap applies (§6
     * transparency); this logs it, and `run.ts` mirrors the same facts into the
     * run's OUTPUT record.
     */
    async finalize(): Promise<void> {
        await this.flush();

        if (this.wasLimitedByEntitlement) {
            log.warning(
                `Free-tier limit reached: this run emitted ${this.emitted} items and ` +
                    `withheld ${this.suppressed} more. Paid entitlements are not capped ` +
                    'at 10; see the README for how entitlements are granted.',
                { limited: true, reason: 'free_tier', cap: this.limit },
            );
        }
    }
}
