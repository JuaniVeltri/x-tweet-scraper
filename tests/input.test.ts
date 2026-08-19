/**
 * Boundary validation (assessment §7: *"Validate input at the boundary; reject
 * malformed or unsupported input with a clear error"*).
 *
 * The bar these tests hold is not merely "does it throw" but "would the message
 * tell someone what to do" — an error a user cannot act on is barely better
 * than silence.
 */

import { describe, expect, it } from 'vitest';

import { parseInput } from '../src/input/parse.js';
import { InputValidationError } from '../src/util/errors.js';

describe('targets', () => {
    it('requires at least one target', () => {
        expect(() => parseInput({})).toThrow(InputValidationError);
        expect(() => parseInput({})).toThrow(/At least one target is required/);
    });

    it('rejects null and undefined input', () => {
        expect(() => parseInput(null)).toThrow(/No input was provided/);
        expect(() => parseInput(undefined)).toThrow(/No input was provided/);
    });

    it('accepts handles alone, IDs alone, or both', () => {
        expect(parseInput({ fromUsers: ['apify'] }).fromUsers).toEqual(['apify']);
        expect(parseInput({ tweetIds: ['123'] }).tweetIds).toEqual(['123']);
        const both = parseInput({ fromUsers: ['apify'], tweetIds: ['123'] });
        expect(both.fromUsers).toEqual(['apify']);
        expect(both.tweetIds).toEqual(['123']);
    });

    it('strips a leading @ and deduplicates case-insensitively', () => {
        const input = parseInput({ fromUsers: ['@apify', 'APIFY', 'apify', 'other'] });
        expect(input.fromUsers).toEqual(['apify', 'other']);
    });

    it('rejects a handle that cannot exist', () => {
        expect(() => parseInput({ fromUsers: ['this handle has spaces'] })).toThrow(
            /1-15 characters/,
        );
        expect(() => parseInput({ fromUsers: ['waaaaaaaaaaaaaaaaytoolong'] })).toThrow(
            InputValidationError,
        );
    });

    it('rejects a non-numeric tweet ID', () => {
        expect(() => parseInput({ tweetIds: ['not-an-id'] })).toThrow(/numeric tweet ID/);
    });
});

describe('searchTerms is refused with an explanation, not silence', () => {
    const attempt = (): unknown => parseInput({ searchTerms: ['apify'] });

    it('throws rather than returning nothing', () => {
        expect(attempt).toThrow(InputValidationError);
    });

    it('says plainly that it is unsupported', () => {
        expect(attempt).toThrow(/searchTerms is not supported/);
    });

    it('explains why, with the evidence', () => {
        let message = '';
        try {
            attempt();
        } catch (error: unknown) {
            message = error instanceof Error ? error.message : '';
        }

        // The operation and the reason.
        expect(message).toContain('SearchTimeline');
        expect(message).toContain('guest token');
        // The measurement, including the control that makes it conclusive.
        expect(message).toContain('404, empty body');
        expect(message).toContain('Query not found');
        // What to do instead.
        expect(message).toMatch(/Use fromUsers and\/or tweetIds/);
    });

    it('is ignored when empty, since an empty array asks for nothing', () => {
        expect(() => parseInput({ fromUsers: ['apify'], searchTerms: [] })).not.toThrow();
    });

    it('takes precedence over the missing-target error', () => {
        // searchTerms alone is not a usable target, but the specific
        // explanation is far more useful than "no targets".
        expect(() => parseInput({ searchTerms: ['apify'] })).toThrow(/not supported/);
    });
});

describe('defaults match the documented contract', () => {
    it('applies §4 defaults', () => {
        const input = parseInput({ fromUsers: ['apify'] });
        expect(input.includeReplies).toBe(false);
        expect(input.includeRetweets).toBe(false);
        expect(input.onlyVerified).toBe(false);
        expect(input.mediaType).toBe('any');
        expect(input.sortBy).toBe('latest');
        expect(input.maxResults).toBe(100);
    });
});

describe('undocumented fields cannot smuggle anything in', () => {
    it('strips unknown keys instead of honouring them', () => {
        const input = parseInput({
            fromUsers: ['apify'],
            cap: 999_999,
            bypassFreeTier: true,
            entitlement: { tier: 'paid', cap: 1_000_000 },
            __proto__: { cap: 1_000_000 },
        });
        expect(Object.hasOwn(input, 'cap')).toBe(false);
        expect(Object.hasOwn(input, 'bypassFreeTier')).toBe(false);
        expect(Object.hasOwn(input, 'entitlement')).toBe(false);
        // The real guarantee is upstream — nothing from input reaches the
        // entitlement resolver at all — but stripping keeps the surface small.
    });
});

describe('normalization', () => {
    it('lowercases hashtags and drops a leading #', () => {
        const input = parseInput({ fromUsers: ['apify'], hashtags: ['#BuildInPublic', 'AI'] });
        expect(input.hashtags).toEqual(['buildinpublic', 'ai']);
    });

    it('lowercases the language code', () => {
        expect(parseInput({ fromUsers: ['a'], language: 'EN' }).language).toBe('en');
    });

    it('rejects a language code that is not ISO-639-1 shaped', () => {
        expect(() => parseInput({ fromUsers: ['a'], language: 'english' })).toThrow(/ISO-639-1/);
    });

    it('rejects a negative or zero maxResults', () => {
        expect(() => parseInput({ fromUsers: ['a'], maxResults: 0 })).toThrow(
            InputValidationError,
        );
        expect(() => parseInput({ fromUsers: ['a'], maxResults: -5 })).toThrow(
            InputValidationError,
        );
    });

    it('rejects a non-integer engagement floor', () => {
        expect(() => parseInput({ fromUsers: ['a'], minLikes: 1.5 })).toThrow(
            InputValidationError,
        );
    });
});
