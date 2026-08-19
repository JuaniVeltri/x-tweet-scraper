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
 * Explanation shown when a run supplies `searchTerms`.
 *
 * The assessment (§2a, §4) asks for an honest, explicit refusal rather than a
 * run that quietly returns nothing. The evidence behind this claim is recorded
 * in `docs/INVESTIGATION.md` and reproducible via `scripts/probe2.py`.
 */
const SEARCH_UNSUPPORTED_MESSAGE = [
    'searchTerms is not supported by this Actor.',
    '',
    'Free-text search is served by X\'s SearchTimeline operation, which is not',
    'reachable with a guest token, and this Actor deliberately uses guest tokens',
    'only — it never touches a logged-in session (assessment §3).',
    '',
    'Measured on 2026-08-19 against the current query ID (hyPfJYJ_XAtDYoslQc-Rgg,',
    'matching the daily-regenerated public dump), sending the operation\'s own',
    'declared feature switches and field toggles:',
    '',
    '  SearchTimeline        -> HTTP 404, empty body',
    '  UserTweets            -> HTTP 200, data      (guest-reachable)',
    '  UserByScreenName      -> HTTP 200, data      (guest-reachable)',
    '  TweetResultByRestId   -> HTTP 200, data      (guest-reachable)',
    '  [control] bogus ID    -> HTTP 404, {"message":"Query not found"}',
    '',
    'The control matters: an unknown query ID gets a JSON error naming the',
    'problem, whereas SearchTimeline gets a silent empty 404 while X still',
    'attributes its own rate-limit bucket to the response. X knows the operation',
    'and declines to serve it to a guest. That is an auth boundary, not a stale ID.',
    '',
    'Use fromUsers and/or tweetIds instead. See the README for the full write-up.',
].join('\n');

/**
 * Validate and normalize raw Actor input.
 *
 * @throws {InputValidationError} with a human-readable, multi-line explanation.
 */
export function parseInput(raw: unknown): ScraperInput {
    if (raw === null || raw === undefined) {
        throw new InputValidationError(
            'No input was provided. Supply at least one target: fromUsers or tweetIds.',
        );
    }

    const result = inputSchema.safeParse(raw);
    if (!result.success) {
        throw new InputValidationError(
            `Invalid input:\n${z.prettifyError(result.error)}`,
        );
    }
    const input = result.data;

    // Refuse the unsupported surface before anything else, so the user gets the
    // specific explanation rather than a generic "no targets" complaint.
    if (input.searchTerms !== undefined && input.searchTerms.length > 0) {
        throw new InputValidationError(SEARCH_UNSUPPORTED_MESSAGE);
    }

    const fromUsers = dedupe(input.fromUsers ?? [], (handle) => handle.toLowerCase());
    const tweetIds = dedupe(input.tweetIds ?? [], (id) => id);

    if (fromUsers.length === 0 && tweetIds.length === 0) {
        throw new InputValidationError(
            'At least one target is required: provide fromUsers (handles) or tweetIds.',
        );
    }

    assertDateWindow(input.since, input.until);

    const { searchTerms: _discarded, ...rest } = input;
    return { ...rest, fromUsers, tweetIds };
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

export { SEARCH_UNSUPPORTED_MESSAGE };
