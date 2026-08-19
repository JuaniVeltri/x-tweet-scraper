/**
 * Boundary validation (assessment §7).
 *
 * Nothing downstream of this module accepts unvalidated input: `parseInput`
 * either returns a fully normalized {@link ScraperInput} or throws an
 * {@link InputValidationError} whose message is written for a human to act on.
 */

import { z } from 'zod';

import { InputValidationError } from '../util/errors.js';
import { parseBoundaryDate } from '../util/time.js';
import { inputSchema, type ScraperInput } from './schema.js';

/**
 * Validate and normalize raw Actor input.
 *
 * @throws {InputValidationError} with a human-readable, multi-line explanation.
 */
export function parseInput(raw: unknown): ScraperInput {
    if (raw === null || raw === undefined) {
        throw new InputValidationError(
            'No input was provided. Supply at least one target: fromUsers, tweetIds or searchTerms.',
        );
    }

    const result = inputSchema.safeParse(raw);
    if (!result.success) {
        throw new InputValidationError(
            `Invalid input:\n${z.prettifyError(result.error)}`,
        );
    }
    const input = result.data;

    const fromUsers = dedupe(input.fromUsers ?? [], (handle) => handle.toLowerCase());
    const tweetIds = dedupe(input.tweetIds ?? [], (id) => id);
    const searchTerms = dedupe(input.searchTerms ?? [], (term) => term.toLowerCase());

    if (fromUsers.length === 0 && tweetIds.length === 0 && searchTerms.length === 0) {
        throw new InputValidationError(
            'At least one target is required: provide fromUsers (handles), tweetIds, ' +
                'or searchTerms.',
        );
    }

    assertDateWindow(input.since, input.until);

    return { ...input, fromUsers, tweetIds, searchTerms };
}

/** `since` after `until` yields an empty result set; that is user error, not a filter. */
function assertDateWindow(since: string | undefined, until: string | undefined): void {
    const from = parseBoundaryDate(since, 'start');
    const to = parseBoundaryDate(until, 'end');
    if (from !== null && to !== null && from > to) {
        throw new InputValidationError(
            `Empty date window: since (${since}) is after until (${until}).`,
        );
    }
}

/** Preserve first-seen order while removing duplicates under `key`. */
function dedupe<T>(values: readonly T[], key: (value: T) => string): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const value of values) {
        const k = key(value);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(value);
    }
    return out;
}
