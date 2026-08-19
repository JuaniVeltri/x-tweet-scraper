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
    retryAfterHeader?: string | undefined,
    random: () => number = Math.random,
    now: () => number = Date.now,
): number {
    if (retryAfterHeader !== undefined) {
        const seconds = Number(retryAfterHeader);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.min(options.maxMs, Math.ceil(seconds * 1000));
        }
        const asDate = Date.parse(retryAfterHeader);
        if (!Number.isNaN(asDate)) {
            return Math.min(options.maxMs, Math.max(0, asDate - now()));
        }
    }
    return backoffDelayMs(attempt, options, random);
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
