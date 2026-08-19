/**
 * Exponential backoff with full jitter (assessment §7).
 *
 * Full jitter — a uniform random draw from `[0, exponential]` rather than
 * `exponential ± noise` — is what stops a fleet of concurrent workers from
 * retrying in lockstep and re-creating the burst that triggered the throttle.
 *
 * @see https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/
 */

export interface BackoffOptions {
    /** Delay for the first retry, before jitter. */
    readonly baseMs: number;
    /** Upper bound on any single sleep. */
    readonly maxMs: number;
}

/**
 * Delay before retry number `attempt` (1 = the first retry).
 *
 * @param random Injectable for deterministic tests; defaults to `Math.random`.
 */
export function backoffDelayMs(
    attempt: number,
    { baseMs, maxMs }: BackoffOptions,
    random: () => number = Math.random,
): number {
    const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
    return Math.floor(random() * exponential);
}

/**
 * Honour a `retry-after` header when the server sent one, otherwise fall back to
 * computed backoff. Servers know their own recovery window better than we do.
 *
 * Accepts both header forms: delay-seconds and an HTTP-date.
 */
export function retryDelayMs(
    attempt: number,
    options: BackoffOptions,
    retryAfterHeader?: string  ,
    random: () => number = Math.random,
    now: () => number = Date.now,
): number {
    if (retryAfterHeader !== undefined) {
        const trimmed = retryAfterHeader.trim();
        // Delay-seconds form. Matched by shape rather than by `Number()`, because
        // `Number` also accepts values the header may not take — and a malformed
        // one such as "-5" would otherwise fall through to `Date.parse`, which
        // reads it as a year, clamps to zero, and retries with no backoff at all.
        // Retrying instantly is the worst possible response to a 429.
        if (/^\d+(\.\d+)?$/.test(trimmed)) {
            return Math.min(options.maxMs, Math.ceil(Number(trimmed) * 1000));
        }
        // HTTP-date form — required to contain letters before `Date.parse` sees
        // it. `Date.parse` happily reads a bare number as a year ("-5" becomes
        // 2001), which would resolve to a date in the past, clamp to zero, and
        // retry with no backoff at all.
        if (/[A-Za-z]/.test(trimmed)) {
            const asDate = Date.parse(trimmed);
            if (!Number.isNaN(asDate)) {
                return Math.min(options.maxMs, Math.max(0, asDate - now()));
            }
        }
    }
    // Absent or malformed: fall back to computed backoff rather than trusting it.
    return backoffDelayMs(attempt, options, random);
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
