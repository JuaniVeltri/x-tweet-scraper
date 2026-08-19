/**
 * Resumable state (assessment §7: *"Use Actor.on('migrating') / persisted state
 * so a resurrected run resumes rather than restarts."*).
 *
 * Apify can move a run to another worker mid-flight. Without persisted state
 * the replacement starts from scratch — re-fetching pages already paid for and,
 * worse, re-emitting tweets already in the dataset. This module keeps the small
 * amount of state needed to pick up where the previous instance left off:
 * the cursor per target, the set of IDs already seen, and how many items were
 * emitted (so the cap survives a migration too).
 */

import { Actor, log } from 'apify';

import { isRecord } from '../util/json.js';

/** Key-value store record holding the run's resume point. */
const STATE_KEY = 'SCRAPER_STATE';

export interface PersistedState {
    /** Target key → cursor for the next page. */
    cursors: Record<string, string>;
    /** Tweet IDs already emitted, so a resumed run does not duplicate them. */
    seenIds: string[];
    /** Items already pushed, so the cap is not reset by a migration. */
    emitted: number;
    /** Targets fully drained; skipped entirely on resume. */
    completed: string[];
}

function emptyState(): PersistedState {
    return { cursors: {}, seenIds: [], emitted: 0, completed: [] };
}

/**
 * Owns the run's resumable state and its persistence schedule.
 *
 * Snapshots are written on `persistState` (which the SDK emits periodically)
 * and on `migrating` (emitted just before the run moves), so a migration loses
 * at most the work done since the last tick.
 */
export class RunState {
    private state: PersistedState = emptyState();
    private dirty = false;

    /** Load any state left by a previous instance of this run. */
    async load(): Promise<PersistedState> {
        const stored = await Actor.getValue(STATE_KEY).catch(() => null);
        if (isRecord(stored)) {
            this.state = {
                cursors: isRecord(stored.cursors)
                    ? (stored.cursors as Record<string, string>)
                    : {},
                seenIds: Array.isArray(stored.seenIds)
                    ? stored.seenIds.filter((id): id is string => typeof id === 'string')
                    : [],
                emitted: typeof stored.emitted === 'number' ? stored.emitted : 0,
                completed: Array.isArray(stored.completed)
                    ? stored.completed.filter((id): id is string => typeof id === 'string')
                    : [],
            };
            log.info('Resuming from persisted state', {
                targets: Object.keys(this.state.cursors).length,
                seen: this.state.seenIds.length,
                emitted: this.state.emitted,
            });
        }
        return this.state;
    }

    /** Register SDK event handlers. Call once, after `Actor.init()`. */
    register(): void {
        Actor.on('persistState', () => {
            void this.persist();
        });
        Actor.on('migrating', () => {
            log.info('Migration signalled; snapshotting state.');
            void this.persist(true);
        });
    }

    get snapshot(): Readonly<PersistedState> {
        return this.state;
    }

    cursorFor(target: string): string | undefined {
        return this.state.cursors[target];
    }

    isCompleted(target: string): boolean {
        return this.state.completed.includes(target);
    }

    setCursor(target: string, cursor: string | null): void {
        if (cursor === null) this.clearCursor(target);
        else this.state.cursors[target] = cursor;
        this.dirty = true;
    }

    markCompleted(target: string): void {
        if (!this.state.completed.includes(target)) this.state.completed.push(target);
        this.clearCursor(target);
        this.dirty = true;
    }

    /**
     * Drop one cursor by rebuilding the map.
     *
     * `delete` on a computed key would do, but rebuilding keeps the record free
     * of the holes `delete` leaves behind, which matters because this object is
     * serialised straight into the key-value store.
     */
    private clearCursor(target: string): void {
        const { [target]: _removed, ...remaining } = this.state.cursors;
        this.state.cursors = remaining;
    }

    recordEmitted(count: number): void {
        this.state.emitted = count;
        this.dirty = true;
    }

    rememberSeen(ids: Iterable<string>): void {
        for (const id of ids) this.state.seenIds.push(id);
        this.dirty = true;
    }

    /** Write a snapshot. `force` persists even when nothing changed. */
    async persist(force = false): Promise<void> {
        if (!this.dirty && !force) return;
        this.dirty = false;
        await Actor.setValue(STATE_KEY, this.state).catch((error: unknown) => {
            log.warning('Failed to persist state', { error: String(error) });
        });
    }
}
