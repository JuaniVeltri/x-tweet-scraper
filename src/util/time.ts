/**
 * Time parsing and formatting.
 *
 * The output contract (§5) requires ISO-8601 UTC everywhere, while X serves
 * timestamps in the legacy Twitter format (`Wed Aug 12 16:12:32 +0000 2026`),
 * which is RFC-2822-shaped. Conversion is centralised here so no caller ever
 * hands a raw X timestamp to the dataset.
 */

/** Matches X's `created_at`, e.g. `Wed Aug 12 16:12:32 +0000 2026`. */
const X_TIMESTAMP = /^[A-Za-z]{3} [A-Za-z]{3} \d{2} \d{2}:\d{2}:\d{2} [+-]\d{4} \d{4}$/;

/**
 * Convert one of X's timestamps to ISO-8601 UTC.
 *
 * @returns The ISO string, or `null` when the input is missing or unparseable —
 *   a bad timestamp must not take down the whole run.
 */
export function xTimestampToIso(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0) return null;
    if (!X_TIMESTAMP.test(value)) return null;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return null;
    return new Date(parsed).toISOString();
}

/**
 * Parse an ISO date from user input (`since` / `until`) into a UTC instant.
 *
 * `until` is inclusive per §4, so a bare date is pushed to the very end of that
 * day; otherwise `until: 2025-01-01` would exclude everything posted that day.
 */
export function parseBoundaryDate(
    value: string | undefined,
    boundary: 'start' | 'end',
): number | null {
    if (value === undefined) return null;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const iso = dateOnly
        ? `${value}${boundary === 'start' ? 'T00:00:00.000Z' : 'T23:59:59.999Z'}`
        : value;
    const parsed = Date.parse(iso);
    return Number.isNaN(parsed) ? null : parsed;
}

export function nowIso(): string {
    return new Date().toISOString();
}
