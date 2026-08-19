/**
 * Backoff and time handling (assessment §7).
 *
 * Both modules are pure and take their sources of nondeterminism by injection,
 * so the behaviour that matters under load can be pinned exactly rather than
 * observed by luck.
 */

import { describe, expect, it } from 'vitest';

import { backoffDelayMs, retryDelayMs, sleep } from '../src/util/backoff.js';
import { nowIso, parseBoundaryDate, xTimestampToIso } from '../src/util/time.js';

const OPTS = { baseMs: 500, maxMs: 30_000 };

describe('backoffDelayMs', () => {
    it('doubles the ceiling on each attempt', () => {
        // With random() pinned at its maximum, the value is the ceiling itself.
        const ceiling = (attempt: number) => backoffDelayMs(attempt, OPTS, () => 0.999_999);
        expect(ceiling(1)).toBe(499);
        expect(ceiling(2)).toBe(999);
        expect(ceiling(3)).toBe(1999);
        expect(ceiling(4)).toBe(3999);
    });

    it('draws from the whole range, not a band around the ceiling', () => {
        // Full jitter is a uniform draw from [0, exponential]. That is what
        // stops concurrent workers retrying in lockstep and recreating the
        // burst that caused the throttle — "exponential ± noise" leaves them
        // clustered.
        expect(backoffDelayMs(4, OPTS, () => 0)).toBe(0);
        expect(backoffDelayMs(4, OPTS, () => 0.5)).toBe(2000);
        expect(backoffDelayMs(4, OPTS, () => 0.999_999)).toBe(3999);
    });

    it('never exceeds the ceiling', () => {
        for (let attempt = 1; attempt <= 20; attempt += 1) {
            expect(backoffDelayMs(attempt, OPTS, () => 0.999_999)).toBeLessThan(OPTS.maxMs + 1);
        }
    });

    it('treats attempt 0 as the first retry rather than going negative', () => {
        expect(backoffDelayMs(0, OPTS, () => 0.999_999)).toBe(499);
    });

    it('is always a non-negative integer', () => {
        for (const r of [0, 0.13, 0.5, 0.97, 0.999_999]) {
            const delay = backoffDelayMs(3, OPTS, () => r);
            expect(Number.isInteger(delay)).toBe(true);
            expect(delay).toBeGreaterThanOrEqual(0);
        }
    });
});

describe('retryDelayMs honours the server first', () => {
    it('uses retry-after when given as delay-seconds', () => {
        // The server knows its own recovery window better than we do.
        expect(retryDelayMs(1, OPTS, '2')).toBe(2000);
        expect(retryDelayMs(5, OPTS, '0')).toBe(0);
    });

    it('uses retry-after when given as an HTTP-date', () => {
        const now = () => Date.parse('2026-08-19T04:00:00.000Z');
        const header = new Date(Date.parse('2026-08-19T04:00:07.000Z')).toUTCString();
        expect(retryDelayMs(1, OPTS, header, Math.random, now)).toBe(7000);
    });

    it('clamps a retry-after that exceeds our ceiling', () => {
        expect(retryDelayMs(1, OPTS, '99999')).toBe(OPTS.maxMs);
    });

    it('never returns a negative delay for a date already past', () => {
        const now = () => Date.parse('2026-08-19T04:00:00.000Z');
        const past = new Date(Date.parse('2026-08-19T03:00:00.000Z')).toUTCString();
        expect(retryDelayMs(1, OPTS, past, Math.random, now)).toBe(0);
    });

    it('falls back to computed backoff when the header is absent or junk', () => {
        expect(retryDelayMs(1, OPTS, undefined, () => 0.5)).toBe(250);
        expect(retryDelayMs(1, OPTS, 'soon', () => 0.5)).toBe(250);
        expect(retryDelayMs(1, OPTS, '-5', () => 0.5)).toBe(250);
    });
});

describe('sleep', () => {
    it('resolves after roughly the requested delay', async () => {
        const started = Date.now();
        await sleep(20);
        expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    });
});

describe('xTimestampToIso', () => {
    it('converts X\'s timestamp format to ISO-8601 UTC', () => {
        expect(xTimestampToIso('Wed Aug 12 16:12:32 +0000 2026')).toBe(
            '2026-08-12T16:12:32.000Z',
        );
    });

    it('handles a non-zero offset by normalizing to UTC', () => {
        expect(xTimestampToIso('Wed Aug 12 16:12:32 +0300 2026')).toBe(
            '2026-08-12T13:12:32.000Z',
        );
    });

    it('returns null rather than throwing on anything else', () => {
        // A single bad timestamp must cost one tweet, never the run.
        for (const bad of ['', 'yesterday', '2026-08-12', null, undefined, 42, {}]) {
            expect(xTimestampToIso(bad)).toBeNull();
        }
    });
});

describe('parseBoundaryDate', () => {
    it('anchors a bare `since` date to the start of that day', () => {
        expect(parseBoundaryDate('2026-06-15', 'start')).toBe(
            Date.parse('2026-06-15T00:00:00.000Z'),
        );
    });

    it('anchors a bare `until` date to the very end of that day', () => {
        // The bug this prevents: parsing a bare date as midnight would exclude
        // everything actually posted on the day the user asked for.
        expect(parseBoundaryDate('2026-06-15', 'end')).toBe(
            Date.parse('2026-06-15T23:59:59.999Z'),
        );
    });

    it('leaves a full timestamp alone', () => {
        const iso = '2026-06-15T12:30:00.000Z';
        expect(parseBoundaryDate(iso, 'start')).toBe(Date.parse(iso));
        expect(parseBoundaryDate(iso, 'end')).toBe(Date.parse(iso));
    });

    it('returns null for absent or unparseable input', () => {
        expect(parseBoundaryDate(undefined, 'start')).toBeNull();
        expect(parseBoundaryDate('not a date', 'start')).toBeNull();
    });
});

describe('nowIso', () => {
    it('returns a parseable ISO-8601 UTC string', () => {
        const value = nowIso();
        expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
        expect(Number.isNaN(Date.parse(value))).toBe(false);
    });
});
