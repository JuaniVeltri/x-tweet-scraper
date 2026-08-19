/**
 * Error taxonomy and failure classification.
 *
 * The whole point of this module is the distinction the assessment calls out in
 * §7: a run must not hard-crash on a single 429/403, but it also must not
 * pointlessly retry something that will never succeed. Every failure is sorted
 * into one of {@link FailureKind}, and that verdict alone decides what the
 * retry loop does next.
 */

/** What the caller should do about a failed request. */
export type FailureKind =
    /** Transient. Back off and retry the same request. */
    | 'retryable'
    /** The guest token is dead. Rotate to a new one, then retry. */
    | 'rotate-token'
    /** The query ID rotated. Re-resolve the ID map, then retry. */
    | 'refresh-query-id'
    /** Will never succeed as a guest. Give up on this operation. */
    | 'auth-walled'
    /** Our own bug or a malformed request. Give up loudly. */
    | 'fatal';

/** Base class so callers can `instanceof` a single type. */
export class ScraperError extends Error {
    override readonly name: string = 'ScraperError';
}

/**
 * Input failed validation at the boundary. Always fatal, and always the user's
 * to fix, so the message is written to be read by a human.
 */
export class InputValidationError extends ScraperError {
    override readonly name = 'InputValidationError';
}

/** A non-success response from X's API, carrying everything needed to classify it. */
export class XApiError extends ScraperError {
    override readonly name = 'XApiError';

    constructor(
        message: string,
        readonly detail: {
            readonly operation: string;
            readonly httpStatus: number;
            /** Numeric codes from the GraphQL `errors[]` array, if any. */
            readonly apiCodes: readonly number[];
            readonly kind: FailureKind;
            readonly bodyPreview: string;
        },
    ) {
        super(message);
    }
}

/**
 * X's documented error codes for a dead session, as used by nitter and twscrape.
 * All of them mean the same thing to us: this guest token is finished.
 */
const TOKEN_DEAD_CODES = new Set([
    89, // expired token
    239, // bad token
    326, // account locked
]);

/** Rate limiting, which X signals both as HTTP 429 and as this code. */
const RATE_LIMITED_CODE = 88;

/**
 * Classify a raw response into a {@link FailureKind}.
 *
 * The three-way split on 404 is the subtle part, and it comes from probing the
 * live API (see `docs/INVESTIGATION.md`):
 *
 *   - `404` + `{"message":"Query not found"}` → the query ID rotated. X is
 *     telling us the operation is unknown at that ID. Re-resolve and retry.
 *   - `404` + empty body → the operation exists (X even attributes its
 *     rate-limit bucket to the response) but is not served to guests. Retrying
 *     is pointless; this is the auth wall.
 *   - any other 404 → treat as fatal rather than guess.
 */
export function classifyFailure(
    httpStatus: number,
    body: string,
    apiCodes: readonly number[],
): FailureKind {
    if (apiCodes.some((code) => TOKEN_DEAD_CODES.has(code))) return 'rotate-token';
    if (apiCodes.includes(RATE_LIMITED_CODE)) return 'retryable';

    if (httpStatus === 429) return 'retryable';
    if (httpStatus >= 500) return 'retryable';

    if (httpStatus === 404) {
        if (body.trim().length === 0) return 'auth-walled';
        if (body.includes('Query not found')) return 'refresh-query-id';
        return 'fatal';
    }

    // 401/403 with no recognised code: the token may simply be stale, so it is
    // worth one rotation rather than failing the whole run.
    if (httpStatus === 401 || httpStatus === 403) return 'rotate-token';

    return 'fatal';
}

/** Pull the numeric codes out of a GraphQL error envelope, tolerating any shape. */
export function extractApiCodes(body: string): number[] {
    try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed !== 'object' || parsed === null) return [];
        const errors = (parsed as { errors?: unknown }).errors;
        if (!Array.isArray(errors)) return [];
        return errors
            .map((entry) =>
                typeof entry === 'object' && entry !== null
                    ? (entry as { code?: unknown }).code
                    : undefined,
            )
            .filter((code): code is number => typeof code === 'number');
    } catch {
        return [];
    }
}

/** Render an unknown thrown value as a string, for logs. */
export function describeError(error: unknown): string {
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return String(error);
}
