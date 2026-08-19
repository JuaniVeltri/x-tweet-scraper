/**
 * Resumable run state (assessment §7).
 *
 * Apify can move a run to another worker mid-flight. Without persisted state the
 * replacement starts from scratch — re-fetching pages already paid for and, far
 * worse, re-emitting tweets already in the dataset.
 *
 * The Apify SDK is mocked here so the state machine can be exercised on its own,
 * including the shapes a previous instance might have left behind.
 */

/* eslint-disable @typescript-eslint/unbound-method -- the Apify SDK is
   mocked as an object literal; its members are read as values, never rebound. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
const handlers = new Map<string, () => void>();

vi.mock('apify', () => ({
    Actor: {
        getValue: vi.fn(async (key: string) => store.get(key) ?? null),
        setValue: vi.fn(async (key: string, value: unknown) => {
            store.set(key, value);
        }),
        on: vi.fn((event: string, handler: () => void) => {
            handlers.set(event, handler);
        }),
    },
    log: { info: vi.fn(), warning: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { RunState } = await import('../src/pipeline/state.js');

beforeEach(() => {
    store.clear();
    handlers.clear();
    vi.clearAllMocks();
});

describe('a cold run starts empty', () => {
    it('reports no cursors, no seen IDs and nothing emitted', async () => {
        const state = new RunState();
        const loaded = await state.load();
        expect(loaded).toEqual({ cursors: {}, seenIds: [], emitted: 0, completed: [] });
    });
});

describe('a resumed run picks up where the last one stopped', () => {
    it('restores cursors, seen IDs, emitted count and completed targets', async () => {
        store.set('SCRAPER_STATE', {
            cursors: { 'user:apify': 'cursor-42' },
            seenIds: ['1', '2'],
            emitted: 7,
            completed: ['user:done'],
        });

        const state = new RunState();
        await state.load();

        expect(state.cursorFor('user:apify')).toBe('cursor-42');
        expect(state.isCompleted('user:done')).toBe(true);
        expect(state.snapshot.emitted).toBe(7);
        expect(state.snapshot.seenIds).toEqual(['1', '2']);
    });

    it('survives a stored record that is the wrong shape', async () => {
        // A malformed snapshot must degrade to a cold start, not crash the run.
        store.set('SCRAPER_STATE', {
            cursors: 'not an object', seenIds: 'nope', emitted: 'lots', completed: 42,
        });
        const state = new RunState();
        expect(await state.load()).toEqual({
            cursors: {}, seenIds: [], emitted: 0, completed: [],
        });
    });

    it('drops non-string entries from the stored arrays', async () => {
        store.set('SCRAPER_STATE', { seenIds: ['ok', 5, null, 'fine'], completed: ['a', 7] });
        const state = new RunState();
        const loaded = await state.load();
        expect(loaded.seenIds).toEqual(['ok', 'fine']);
        expect(loaded.completed).toEqual(['a']);
    });

    it('starts cold when reading the store throws', async () => {
        const { Actor } = await import('apify');
        vi.mocked(Actor.getValue).mockRejectedValueOnce(new Error('store unavailable'));
        const state = new RunState();
        expect(await state.load()).toEqual({
            cursors: {}, seenIds: [], emitted: 0, completed: [],
        });
    });
});

describe('cursor bookkeeping', () => {
    it('records and returns a cursor per target', async () => {
        const state = new RunState();
        await state.load();
        state.setCursor('user:a', 'cursor-a');
        state.setCursor('user:b', 'cursor-b');
        expect(state.cursorFor('user:a')).toBe('cursor-a');
        expect(state.cursorFor('user:b')).toBe('cursor-b');
    });

    it('clears one cursor without disturbing the others', async () => {
        const state = new RunState();
        await state.load();
        state.setCursor('user:a', 'cursor-a');
        state.setCursor('user:b', 'cursor-b');

        state.setCursor('user:a', null);

        expect(state.cursorFor('user:a')).toBeUndefined();
        expect(state.cursorFor('user:b')).toBe('cursor-b');
    });

    it('leaves a serialisable object behind after clearing', async () => {
        // The map is written straight into the key-value store, so it must not
        // carry holes or an own key whose value is undefined.
        const state = new RunState();
        await state.load();
        state.setCursor('user:a', 'cursor-a');
        state.setCursor('user:a', null);

        expect(Object.hasOwn(state.snapshot.cursors, 'user:a')).toBe(false);
        expect(JSON.parse(JSON.stringify(state.snapshot.cursors))).toEqual({});
    });

    it('drops the cursor when a target completes', async () => {
        const state = new RunState();
        await state.load();
        state.setCursor('user:a', 'cursor-a');

        state.markCompleted('user:a');

        expect(state.isCompleted('user:a')).toBe(true);
        expect(state.cursorFor('user:a')).toBeUndefined();
    });

    it('does not list a completed target twice', async () => {
        const state = new RunState();
        await state.load();
        state.markCompleted('user:a');
        state.markCompleted('user:a');
        expect(state.snapshot.completed).toEqual(['user:a']);
    });
});

describe('persistence', () => {
    it('writes nothing when nothing changed', async () => {
        const { Actor } = await import('apify');
        const state = new RunState();
        await state.load();
        vi.mocked(Actor.setValue).mockClear();

        await state.persist();
        expect(Actor.setValue).not.toHaveBeenCalled();
    });

    it('writes when forced, even with no changes', async () => {
        const { Actor } = await import('apify');
        const state = new RunState();
        await state.load();
        vi.mocked(Actor.setValue).mockClear();

        await state.persist(true);
        expect(Actor.setValue).toHaveBeenCalledTimes(1);
    });

    it('writes once after a change, then goes quiet again', async () => {
        const { Actor } = await import('apify');
        const state = new RunState();
        await state.load();
        state.setCursor('user:a', 'c1');
        vi.mocked(Actor.setValue).mockClear();

        await state.persist();
        await state.persist();
        expect(Actor.setValue).toHaveBeenCalledTimes(1);
    });

    it('survives a failed write rather than losing the run', async () => {
        const { Actor } = await import('apify');
        vi.mocked(Actor.setValue).mockRejectedValueOnce(new Error('store full'));
        const state = new RunState();
        await state.load();
        state.recordEmitted(5);

        await expect(state.persist()).resolves.toBeUndefined();
    });

    it('round-trips through the store into a fresh instance', async () => {
        const first = new RunState();
        await first.load();
        first.setCursor('user:apify', 'cursor-99');
        first.rememberSeen(['id-1', 'id-2']);
        first.recordEmitted(12);
        await first.persist(true);

        // What a migrated run would see.
        const second = new RunState();
        await second.load();
        expect(second.cursorFor('user:apify')).toBe('cursor-99');
        expect(second.snapshot.emitted).toBe(12);
        expect(second.snapshot.seenIds).toEqual(['id-1', 'id-2']);
    });
});

describe('SDK event registration', () => {
    it('subscribes to both persistState and migrating', async () => {
        const state = new RunState();
        await state.load();
        state.register();

        // persistState fires on a timer; migrating fires just before the run
        // moves. Missing either loses work.
        expect(handlers.has('persistState')).toBe(true);
        expect(handlers.has('migrating')).toBe(true);
    });

    it('snapshots when the platform signals a migration', async () => {
        const { Actor } = await import('apify');
        const state = new RunState();
        await state.load();
        state.register();
        state.setCursor('user:a', 'c1');
        vi.mocked(Actor.setValue).mockClear();

        handlers.get('migrating')?.();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(Actor.setValue).toHaveBeenCalled();
    });
});
