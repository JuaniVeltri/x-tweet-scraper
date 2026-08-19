/**
 * Safe navigation over untyped JSON.
 *
 * X's GraphQL payloads are deeply nested, inconsistently shaped, and change
 * without notice — the same field lives at `legacy.screen_name` on one query ID
 * and at `core.screen_name` on another. Declaring optimistic interfaces over
 * that and casting to them would be a lie the type system happily accepts, and
 * the first schema change turns it into a runtime crash.
 *
 * Instead every read goes through these helpers: they take `unknown`, walk the
 * path defensively, and return a correctly typed value or `undefined`. No cast,
 * no `any`, and a missing field can never throw.
 */

/** A JSON object with unknown values — the honest type for a parsed payload. */
export type JsonRecord = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a dotted path, e.g. `get(tweet, 'legacy.entities.hashtags')`.
 *
 * @returns The value at the path, or `undefined` if any segment is missing or
 *   the path traverses a non-object.
 */
export function get(source: unknown, path: string): unknown {
    let current = source;
    for (const segment of path.split('.')) {
        if (!isRecord(current)) return undefined;
        current = current[segment];
    }
    return current;
}

/** First path that yields a defined, non-null value. Encodes schema fallbacks. */
export function getFirst(source: unknown, paths: readonly string[]): unknown {
    for (const path of paths) {
        const value = get(source, path);
        if (value !== undefined && value !== null) return value;
    }
    return undefined;
}

export function getString(source: unknown, path: string): string | undefined {
    const value = get(source, path);
    return typeof value === 'string' ? value : undefined;
}

export function getFirstString(source: unknown, paths: readonly string[]): string | undefined {
    const value = getFirst(source, paths);
    return typeof value === 'string' ? value : undefined;
}

/**
 * Read a number, also accepting the numeric strings X sometimes returns for
 * counts (notably `views.count`).
 */
export function getNumber(source: unknown, path: string): number | undefined {
    const value = get(source, path);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return undefined;
}

export function getFirstNumber(source: unknown, paths: readonly string[]): number | undefined {
    for (const path of paths) {
        const value = getNumber(source, path);
        if (value !== undefined) return value;
    }
    return undefined;
}

export function getBoolean(source: unknown, path: string): boolean | undefined {
    const value = get(source, path);
    return typeof value === 'boolean' ? value : undefined;
}

export function getFirstBoolean(source: unknown, paths: readonly string[]): boolean | undefined {
    for (const path of paths) {
        const value = getBoolean(source, path);
        if (value !== undefined) return value;
    }
    return undefined;
}

/** Read an array, returning `[]` rather than `undefined` so callers can iterate. */
export function getArray(source: unknown, path: string): readonly unknown[] {
    const value = get(source, path);
    return Array.isArray(value) ? value : [];
}

export function getFirstArray(source: unknown, paths: readonly string[]): readonly unknown[] {
    for (const path of paths) {
        const value = get(source, path);
        if (Array.isArray(value)) return value;
    }
    return [];
}
