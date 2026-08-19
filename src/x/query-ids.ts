/**
 * Query-ID resolution (assessment §7: *"the per-operation query identifiers are
 * not [constant]. Think about where those live and how they change."*).
 *
 * X rotates the per-operation query IDs continuously, so hardcoding them
 * guarantees the Actor breaks on X's schedule rather than ours. They live in
 * x.com's own JavaScript bundle, which makes them recoverable at runtime.
 *
 * ## Where they actually live (measured 2026-08-19)
 *
 * x.com currently serves two different frontends depending on the route:
 *
 *   - `/`, `/<handle>` → a new Vite/Relay app under `abs.twimg.com/x-web/`.
 *     Its bundles carry only 24 persisted queries, all of them UI chrome
 *     (titles, hover cards). The timeline is server-rendered, so **no timeline
 *     operation appears there at all**, and the HTML links a single entry
 *     script.
 *   - `/home`, `/i/flow/login` → the legacy webpack app under
 *     `abs.twimg.com/responsive-web/client-web/`. Its `main.*.js` carries 104
 *     operations including every one this Actor needs.
 *
 * So the resolver targets `/home`. The IDs it recovers there were verified to
 * match both a live 200 response and the community's daily-regenerated dump.
 *
 * ## Resolution order
 *
 * 1. Key-value store cache (cheap, survives migrations).
 * 2. Live extraction from x.com's bundle — first-party, self-healing.
 * 3. Public daily dump — no browser, but a third-party dependency.
 * 4. Compiled-in constants — last resort so a run degrades rather than dies.
 */

import { log } from 'apify';

import {
    DEFAULTS,
    FALLBACK_QUERY_IDS,
    QUERY_ID_DUMP_URL,
    X_WEB_ORIGIN,
} from '../config/constants.js';
import { isRecord } from '../util/json.js';

/** Maps `operationName` → `queryId`. */
export type QueryIdMap = Readonly<Record<string, string>>;

/** Where a resolved map came from, recorded for the run summary and README. */
export type QueryIdSource = 'cache' | 'live-bundle' | 'public-dump' | 'fallback-constants';

export interface ResolvedQueryIds {
    readonly ids: QueryIdMap;
    readonly source: QueryIdSource;
    readonly resolvedAt: number;
}

/** Persistence for the resolved map; backed by the Actor key-value store. */
export interface QueryIdCache {
    read(): Promise<ResolvedQueryIds | null>;
    write(value: ResolvedQueryIds): Promise<void>;
}

/** Plain text fetch, injected so this module carries no transport dependency. */
export type TextFetcher = (url: string) => Promise<string>;

/**
 * The legacy webpack bundle emits `queryId:"…",operationName:"…"` adjacently.
 * Anchored to both keys so it cannot match unrelated minified object literals.
 */
const WEBPACK_PATTERN = /queryId:"([A-Za-z0-9_-]{8,})",operationName:"([A-Za-z0-9_]+)"/g;

/**
 * The newer Relay build emits the same information as persisted-query params.
 * Kept because X is mid-migration and may move the timeline operations across.
 */
const RELAY_PATTERN =
    /params:\{id:`([A-Za-z0-9_-]{8,})`,\s*metadata:\{[^}]*\},\s*name:`([A-Za-z0-9_]+)`/g;

/** Bundles served by the legacy frontend, which is the one that carries our ops. */
const LEGACY_BUNDLE_PATTERN =
    /https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"'\s]+\.js/g;

/** Pull `{operationName: queryId}` pairs out of a JavaScript bundle. */
export function extractQueryIds(source: string): Record<string, string> {
    const found: Record<string, string> = {};
    for (const pattern of [WEBPACK_PATTERN, RELAY_PATTERN]) {
        pattern.lastIndex = 0;
        for (const match of source.matchAll(pattern)) {
            const [, queryId, operationName] = match;
            if (queryId !== undefined && operationName !== undefined) {
                found[operationName] = queryId;
            }
        }
    }
    return found;
}

/** Collect candidate bundle URLs from an HTML page, largest-first heuristics aside. */
export function extractBundleUrls(html: string): string[] {
    return [...new Set(html.match(LEGACY_BUNDLE_PATTERN) ?? [])];
}

export class QueryIdResolver {
    private resolved: ResolvedQueryIds | null = null;
    private inFlight: Promise<ResolvedQueryIds> | null = null;

    constructor(
        private readonly fetchText: TextFetcher,
        private readonly cache: QueryIdCache | null = null,
        private readonly options: { readonly ttlMs?: number; readonly now?: () => number } = {},
    ) {}

    private get now(): () => number {
        return this.options.now ?? Date.now;
    }

    /** Resolve once and memoize; concurrent callers share a single resolution. */
    async resolve(): Promise<ResolvedQueryIds> {
        if (this.resolved !== null && !this.isStale(this.resolved)) return this.resolved;
        this.inFlight ??= this.resolveUncached().finally(() => {
            this.inFlight = null;
        });
        return this.inFlight;
    }

    /** Look up one operation, falling back to the compiled-in constant. */
    async queryIdFor(operationName: string): Promise<string> {
        const { ids } = await this.resolve();
        const id = ids[operationName] ?? FALLBACK_QUERY_IDS[operationName];
        if (id === undefined) {
            throw new Error(`No query ID known for operation "${operationName}"`);
        }
        return id;
    }

    /**
     * Discard the memoized map so the next call re-resolves.
     *
     * Called when X answers `404 {"message":"Query not found"}`, which is
     * exactly the signal that an ID rotated underneath us.
     */
    invalidate(): void {
        this.resolved = null;
    }

    private isStale(value: ResolvedQueryIds): boolean {
        const ttl = this.options.ttlMs ?? DEFAULTS.queryIdCacheTtlMs;
        return this.now() - value.resolvedAt > ttl;
    }

    private async resolveUncached(): Promise<ResolvedQueryIds> {
        const cached = await this.readCache();
        if (cached !== null) {
            this.resolved = cached;
            return cached;
        }

        for (const attempt of [
            () => this.fromLiveBundle(),
            () => this.fromPublicDump(),
        ] as const) {
            const result = await attempt().catch((error: unknown) => {
                log.warning('Query ID resolution step failed', { error: String(error) });
                return null;
            });
            if (result !== null && Object.keys(result.ids).length > 0) {
                this.resolved = result;
                await this.cache?.write(result).catch(() => undefined);
                log.info('Resolved X query IDs', {
                    source: result.source,
                    operations: Object.keys(result.ids).length,
                });
                return result;
            }
        }

        log.warning('Falling back to compiled-in query IDs; they may be stale.');
        const fallback: ResolvedQueryIds = {
            ids: FALLBACK_QUERY_IDS,
            source: 'fallback-constants',
            resolvedAt: this.now(),
        };
        this.resolved = fallback;
        return fallback;
    }

    private async readCache(): Promise<ResolvedQueryIds | null> {
        if (this.cache === null) return null;
        const cached = await this.cache.read().catch(() => null);
        if (cached === null || this.isStale(cached)) return null;
        return { ...cached, source: 'cache' };
    }

    /**
     * Fetch `/home` — which serves the legacy frontend — and mine its bundles.
     *
     * Bundles are tried largest-name-first only incidentally; correctness comes
     * from stopping as soon as a bundle yields any operations, since `main.*.js`
     * carries all of them.
     */
    private async fromLiveBundle(): Promise<ResolvedQueryIds | null> {
        const html = await this.fetchText(`${X_WEB_ORIGIN}/home`);
        const bundles = extractBundleUrls(html);
        if (bundles.length === 0) return null;

        // `main.*.js` holds the operation registry; try it before the rest.
        const ordered = [...bundles].sort((a, b) => scoreBundle(b) - scoreBundle(a));

        const ids: Record<string, string> = {};
        for (const url of ordered) {
            const source = await this.fetchText(url).catch(() => null);
            if (source === null) continue;
            Object.assign(ids, extractQueryIds(source));
            // `main` alone covers every operation we need; stop once we have them.
            if (hasRequiredOperations(ids)) break;
        }

        if (Object.keys(ids).length === 0) return null;
        return { ids, source: 'live-bundle', resolvedAt: this.now() };
    }

    /** Community dump, regenerated daily. Used only if live extraction fails. */
    private async fromPublicDump(): Promise<ResolvedQueryIds | null> {
        const body = await this.fetchText(QUERY_ID_DUMP_URL);
        const parsed: unknown = JSON.parse(body);
        if (!Array.isArray(parsed)) return null;

        const ids: Record<string, string> = {};
        for (const entry of parsed) {
            const exports = isRecord(entry) ? entry.exports : undefined;
            if (!isRecord(exports)) continue;
            const name = exports.operationName;
            const queryId = exports.queryId;
            if (typeof name === 'string' && typeof queryId === 'string') ids[name] = queryId;
        }

        if (Object.keys(ids).length === 0) return null;
        return { ids, source: 'public-dump', resolvedAt: this.now() };
    }
}

/** Prefer `main`, then `bundle.*`, then anything else. */
function scoreBundle(url: string): number {
    if (url.includes('/main.')) return 2;
    if (url.includes('/bundle.')) return 1;
    return 0;
}

function hasRequiredOperations(ids: Readonly<Record<string, string>>): boolean {
    return ['UserByScreenName', 'UserTweets', 'TweetResultByRestId'].every(
        (name) => ids[name] !== undefined,
    );
}
