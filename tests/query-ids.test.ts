/**
 * Query-ID resolution (assessment §7).
 *
 * X rotates the per-operation identifiers continuously, so hardcoding them
 * guarantees the Actor breaks on X's schedule. The resolver recovers them at
 * runtime from x.com's own bundle and degrades through progressively weaker
 * sources rather than failing.
 *
 * The order of that degradation is the thing worth testing: each step is
 * cheaper, fresher or more trustworthy than the one after it, and a bug that
 * silently reversed them would still "work" while quietly serving stale IDs.
 */

import { describe, expect, it, vi } from 'vitest';

import { FALLBACK_QUERY_IDS } from '../src/config/constants.js';
import {
    extractBundleUrls,
    extractQueryIds,
    QueryIdResolver,
    type QueryIdCache,
    type ResolvedQueryIds,
} from '../src/x/query-ids.js';

/** A page shaped like the one x.com/home serves. */
const HOME_HTML = `
  <script src="https://abs.twimg.com/responsive-web/client-web/main.3ced1cfa.js"></script>
  <script src="https://abs.twimg.com/responsive-web/client-web/vendor.0ba7ab8a.js"></script>
`;

/** Shaped like the legacy webpack bundle, which is where the operations live. */
const MAIN_JS =
    'queryId:"Gb-d6r0vxPOADdG62OEBpQ",operationName:"UserByScreenName",' +
    'queryId:"SXVCYB8XHSS25nzIljNtZA",operationName:"UserTweets",' +
    'queryId:"GZsN2Pc4knAoit6pXa4HSA",operationName:"TweetResultByRestId"';

function memoryCache(seed: ResolvedQueryIds | null = null): QueryIdCache & { written: number } {
    let stored = seed;
    let written = 0;
    return {
        read: async () => stored,
        write: async (value) => { stored = value; written += 1; },
        get written() { return written; },
    };
}

describe('extractQueryIds', () => {
    it('reads the legacy webpack pairing', () => {
        expect(extractQueryIds(MAIN_JS)).toEqual({
            UserByScreenName: 'Gb-d6r0vxPOADdG62OEBpQ',
            UserTweets: 'SXVCYB8XHSS25nzIljNtZA',
            TweetResultByRestId: 'GZsN2Pc4knAoit6pXa4HSA',
        });
    });

    it('reads the newer Relay persisted-query form', () => {
        // X is mid-migration; both shapes have to work or the resolver breaks
        // the day the timeline operations move across.
        const relay =
            'params:{id:`frIPQPuTi1WBHmfe-hRyrA`, metadata:{}, name:`intentFollowQuery`, ' +
            'operationKind:`query`}';
        expect(extractQueryIds(relay)).toEqual({ intentFollowQuery: 'frIPQPuTi1WBHmfe-hRyrA' });
    });

    it('finds nothing in a bundle that carries no operations', () => {
        expect(extractQueryIds('function noop(){return 1}')).toEqual({});
    });

    it('is not confused by a second call on the same module-level regex', () => {
        // A `g` regex carries lastIndex between calls; forgetting to reset it
        // makes every other invocation silently return nothing.
        expect(extractQueryIds(MAIN_JS)).toEqual(extractQueryIds(MAIN_JS));
    });
});

describe('extractBundleUrls', () => {
    it('picks up the legacy client-web bundles', () => {
        expect(extractBundleUrls(HOME_HTML)).toEqual([
            'https://abs.twimg.com/responsive-web/client-web/main.3ced1cfa.js',
            'https://abs.twimg.com/responsive-web/client-web/vendor.0ba7ab8a.js',
        ]);
    });

    it('ignores the new x-web bundles, which carry no timeline operation', () => {
        const newFrontend =
            '<script src="https://abs.twimg.com/x-web/x-web/entry-client-logged-out-Ctm.js"></script>';
        expect(extractBundleUrls(newFrontend)).toEqual([]);
    });

    it('deduplicates', () => {
        expect(extractBundleUrls(HOME_HTML + HOME_HTML)).toHaveLength(2);
    });
});

describe('the resolution chain', () => {
    it('serves a warm cache without touching the network', async () => {
        const cache = memoryCache({
            ids: { UserTweets: 'from-cache' }, source: 'live-bundle', resolvedAt: Date.now(),
        });
        const fetchText = vi.fn();
        const resolver = new QueryIdResolver(fetchText, cache);

        const result = await resolver.resolve();
        expect(fetchText).not.toHaveBeenCalled();
        expect(result.source).toBe('cache');
        expect(result.ids.UserTweets).toBe('from-cache');
    });

    it('ignores a cache entry past its TTL', async () => {
        const cache = memoryCache({
            ids: { UserTweets: 'stale' }, source: 'live-bundle', resolvedAt: 0,
        });
        const fetchText = vi.fn(async (url: string) =>
            url.endsWith('/home') ? HOME_HTML : MAIN_JS,
        );
        const resolver = new QueryIdResolver(fetchText, cache, { ttlMs: 1000 });

        const result = await resolver.resolve();
        expect(result.source).toBe('live-bundle');
        expect(result.ids.UserTweets).toBe('SXVCYB8XHSS25nzIljNtZA');
    });

    it('mines x.com/home for the bundles, not a profile route', async () => {
        const fetchText = vi.fn(async (url: string) =>
            url.endsWith('/home') ? HOME_HTML : MAIN_JS,
        );
        await new QueryIdResolver(fetchText).resolve();

        // The profile route serves a frontend whose bundles hold no timeline
        // operation at all, so targeting it would find nothing.
        expect(fetchText.mock.calls[0]![0]).toMatch(/\/home$/);
    });

    it('stops fetching bundles once it has the operations it needs', async () => {
        const fetchText = vi.fn(async (url: string) =>
            url.endsWith('/home') ? HOME_HTML : MAIN_JS,
        );
        await new QueryIdResolver(fetchText).resolve();
        // /home, then main.*.js — vendor.js is never downloaded.
        expect(fetchText).toHaveBeenCalledTimes(2);
    });

    it('writes what it resolved back to the cache', async () => {
        const cache = memoryCache();
        const fetchText = async (url: string) => (url.endsWith('/home') ? HOME_HTML : MAIN_JS);
        await new QueryIdResolver(fetchText, cache).resolve();
        expect(cache.written).toBe(1);
    });

    it('falls back to the public dump when the live bundle yields nothing', async () => {
        const dump = JSON.stringify([
            { exports: { operationName: 'UserTweets', queryId: 'from-dump' } },
        ]);
        const fetchText = async (url: string) => {
            if (url.endsWith('/home')) return '<html>no bundles here</html>';
            return dump;
        };
        const result = await new QueryIdResolver(fetchText).resolve();
        expect(result.source).toBe('public-dump');
        expect(result.ids.UserTweets).toBe('from-dump');
    });

    it('falls back to compiled-in constants when every source fails', async () => {
        const fetchText = async (): Promise<string> => {
            throw new Error('network down');
        };
        const result = await new QueryIdResolver(fetchText).resolve();
        // Degrade rather than die: a stale ID that might work beats no run.
        expect(result.source).toBe('fallback-constants');
        expect(result.ids).toEqual(FALLBACK_QUERY_IDS);
    });
});

describe('memoization and invalidation', () => {
    it('resolves once and reuses the result', async () => {
        const fetchText = vi.fn(async (url: string) =>
            url.endsWith('/home') ? HOME_HTML : MAIN_JS,
        );
        const resolver = new QueryIdResolver(fetchText);

        await resolver.resolve();
        await resolver.resolve();
        await resolver.resolve();
        expect(fetchText).toHaveBeenCalledTimes(2); // not 6
    });

    it('shares one in-flight resolution between concurrent callers', async () => {
        const fetchText = vi.fn(async (url: string) => {
            await new Promise((r) => setTimeout(r, 5));
            return url.endsWith('/home') ? HOME_HTML : MAIN_JS;
        });
        const resolver = new QueryIdResolver(fetchText);

        // Four handles starting at once must not each mine the bundle.
        await Promise.all([resolver.resolve(), resolver.resolve(),
                           resolver.resolve(), resolver.resolve()]);
        expect(fetchText).toHaveBeenCalledTimes(2);
    });

    it('re-resolves after invalidate, which is what a rotated ID triggers', async () => {
        const fetchText = vi.fn(async (url: string) =>
            url.endsWith('/home') ? HOME_HTML : MAIN_JS,
        );
        const resolver = new QueryIdResolver(fetchText);

        await resolver.resolve();
        resolver.invalidate();
        await resolver.resolve();
        expect(fetchText).toHaveBeenCalledTimes(4);
    });
});

describe('queryIdFor', () => {
    const fetchText = async (url: string) => (url.endsWith('/home') ? HOME_HTML : MAIN_JS);

    it('returns the resolved ID', async () => {
        const resolver = new QueryIdResolver(fetchText);
        expect(await resolver.queryIdFor('UserTweets')).toBe('SXVCYB8XHSS25nzIljNtZA');
    });

    it('falls back to the constant for an operation the bundle did not carry', async () => {
        const resolver = new QueryIdResolver(fetchText);
        expect(await resolver.queryIdFor('SearchTimeline')).toBe(
            FALLBACK_QUERY_IDS.SearchTimeline,
        );
    });

    it('throws for an operation nothing knows about', async () => {
        const resolver = new QueryIdResolver(fetchText);
        await expect(resolver.queryIdFor('NotAnOperation')).rejects.toThrow(/No query ID/);
    });
});
