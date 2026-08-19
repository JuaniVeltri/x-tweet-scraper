/**
 * Safe navigation over untyped JSON.
 *
 * X's payloads are deeply nested, inconsistently shaped, and move between
 * releases — the same field sits at `legacy.screen_name` under one query ID and
 * `core.screen_name` under another. Declaring optimistic interfaces and casting
 * to them is a lie the type system accepts right up until the first schema
 * change turns it into a crash.
 *
 * These helpers are the alternative, so the property that matters is that
 * *nothing here ever throws*, whatever it is handed.
 */

import { describe, expect, it } from 'vitest';

import {
    compact,
    get,
    getArray,
    getBoolean,
    getFirst,
    getFirstArray,
    getFirstBoolean,
    getFirstNumber,
    getFirstString,
    getNumber,
    getString,
    isRecord,
} from '../src/util/json.js';

const TWEET = {
    rest_id: '123',
    legacy: {
        full_text: 'hello',
        favorite_count: 17,
        entities: { hashtags: [{ text: 'ai' }] },
    },
    views: { count: '2332' },
    truthy: true,
};

describe('isRecord', () => {
    it('accepts a plain object only', () => {
        expect(isRecord({})).toBe(true);
        expect(isRecord({ a: 1 })).toBe(true);
    });

    it('rejects arrays, null and primitives', () => {
        // Arrays are objects in JavaScript; treating one as a record is how a
        // path walk silently produces undefined instead of failing loudly.
        for (const value of [[], null, undefined, 'str', 42, true]) {
            expect(isRecord(value)).toBe(false);
        }
    });
});

describe('get', () => {
    it('walks a dotted path', () => {
        expect(get(TWEET, 'legacy.full_text')).toBe('hello');
        expect(get(TWEET, 'legacy.entities.hashtags')).toEqual([{ text: 'ai' }]);
    });

    it('returns undefined for a path that does not exist', () => {
        expect(get(TWEET, 'legacy.nope')).toBeUndefined();
        expect(get(TWEET, 'a.b.c.d.e')).toBeUndefined();
    });

    it('stops rather than throwing when the path hits a non-object', () => {
        expect(get(TWEET, 'rest_id.nested')).toBeUndefined();
    });

    it('tolerates any root at all', () => {
        for (const root of [null, undefined, 42, 'str', []]) {
            expect(get(root, 'a.b')).toBeUndefined();
        }
    });
});

describe('typed readers return undefined on a type mismatch', () => {
    it('getString', () => {
        expect(getString(TWEET, 'legacy.full_text')).toBe('hello');
        expect(getString(TWEET, 'legacy.favorite_count')).toBeUndefined();
    });

    it('getNumber', () => {
        expect(getNumber(TWEET, 'legacy.favorite_count')).toBe(17);
        expect(getNumber(TWEET, 'legacy.full_text')).toBeUndefined();
    });

    it('getNumber also accepts the numeric strings X returns for counts', () => {
        // `views.count` arrives as a string; refusing it would report null views
        // on every tweet that has them.
        expect(getNumber(TWEET, 'views.count')).toBe(2332);
        expect(getNumber({ n: '12.5' }, 'n')).toBeUndefined();
        expect(getNumber({ n: '-3' }, 'n')).toBeUndefined();
    });

    it('getNumber rejects NaN and Infinity', () => {
        expect(getNumber({ n: NaN }, 'n')).toBeUndefined();
        expect(getNumber({ n: Infinity }, 'n')).toBeUndefined();
    });

    it('getBoolean', () => {
        expect(getBoolean(TWEET, 'truthy')).toBe(true);
        // Only a real boolean counts — "true" and 1 are not booleans.
        expect(getBoolean({ b: 'true' }, 'b')).toBeUndefined();
        expect(getBoolean({ b: 1 }, 'b')).toBeUndefined();
    });

    it('getArray returns an empty array so callers can always iterate', () => {
        expect(getArray(TWEET, 'legacy.entities.hashtags')).toHaveLength(1);
        expect(getArray(TWEET, 'nope')).toEqual([]);
        expect(getArray(null, 'a')).toEqual([]);
    });
});

describe('the getFirst family encodes schema fallbacks', () => {
    it('takes the first path that resolves', () => {
        // This is exactly how the normalizer survives both of X's user schemas.
        expect(getFirstString(TWEET, ['core.screen_name', 'legacy.full_text'])).toBe('hello');
    });

    it('skips null as well as undefined', () => {
        const value = { a: null, b: 'found' };
        expect(getFirst(value, ['a', 'b'])).toBe('found');
    });

    it('returns undefined when no path resolves', () => {
        expect(getFirst(TWEET, ['x', 'y'])).toBeUndefined();
        expect(getFirstString(TWEET, ['x'])).toBeUndefined();
        expect(getFirstNumber(TWEET, ['x'])).toBeUndefined();
        expect(getFirstBoolean(TWEET, ['x'])).toBeUndefined();
    });

    it('skips a path whose value is the wrong type', () => {
        expect(getFirstNumber(TWEET, ['legacy.full_text', 'legacy.favorite_count'])).toBe(17);
    });

    it('getFirstArray returns an empty array rather than undefined', () => {
        expect(getFirstArray(TWEET, ['nope', 'legacy.entities.hashtags'])).toHaveLength(1);
        expect(getFirstArray(TWEET, ['nope'])).toEqual([]);
    });
});

describe('compact', () => {
    it('drops keys whose value is undefined', () => {
        // Under exactOptionalPropertyTypes an explicitly-undefined property is
        // not the same as an absent one, and several third-party option types
        // reject the former.
        expect(compact({ a: 1, b: undefined, c: 'x' })).toEqual({ a: 1, c: 'x' });
    });

    it('keeps null, which is a value rather than an absence', () => {
        expect(compact({ a: null })).toEqual({ a: null });
    });

    it('passes undefined straight through', () => {
        expect(compact(undefined)).toBeUndefined();
    });

    it('leaves an object with nothing to drop unchanged', () => {
        expect(compact({ useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] })).toEqual({
            useApifyProxy: true,
            apifyProxyGroups: ['RESIDENTIAL'],
        });
    });
});
