/**
 * Topic discovery, for the `searchTerms` stretch (assessment §2a).
 *
 * X's own `SearchTimeline` is closed to guest tokens — measured, with a control,
 * in `docs/INVESTIGATION.md`. The brief allows one other route: *"or via an
 * equivalent public HTTP source you justify"*. This is that route.
 *
 * ## The move
 *
 * Rather than searching X for *posts*, ask a general search engine for
 * *profiles* that talk about the topic, then read those profiles' timelines
 * through the guest-token path that already works, and keep only the tweets
 * that actually mention the term.
 *
 * That inversion is what makes it viable. Search engines index X profile pages
 * well and individual posts poorly and late, so asking about people gives a
 * dense, stable answer while recency still comes from X itself.
 *
 * ## What this is not
 *
 * It is not equivalent to X's search. It finds tweets *by accounts that rank
 * for the topic*, not every tweet matching a query. A tweet from an account the
 * engine never surfaced will not appear. That limit is stated in the README
 * rather than papered over.
 *
 * No credential, session or paid API is involved — the constraint in §3 that
 * rules out a logged-in account rules out buying our way around it too.
 */

import { log } from 'apify';

import { DEFAULTS } from '../../config/constants.js';
import { performRequest } from '../http.js';

/**
 * Engines are tried in order and the first that yields handles wins.
 *
 * A cascade rather than a single source because engines rate-limit automated
 * traffic unevenly and without warning — Brave answered 429 from a datacenter
 * IP during development while both DuckDuckGo endpoints answered 200. Ordered
 * by response size, since this traffic shares the run's proxy budget.
 */
const ENGINES: readonly { readonly name: string; readonly url: (query: string) => string }[] = [
    { name: 'ddg-lite', url: (q) => `https://lite.duckduckgo.com/lite/?q=${q}` },
    { name: 'ddg-html', url: (q) => `https://html.duckduckgo.com/html/?q=${q}` },
    { name: 'brave', url: (q) => `https://search.brave.com/search?q=${q}` },
    { name: 'startpage', url: (q) => `https://www.startpage.com/sp/search?query=${q}` },
];

/**
 * Paths under x.com that are not accounts.
 *
 * Every one of these would otherwise cost a wasted profile lookup against a
 * rate-limited operation, so the list is worth keeping complete.
 */
const RESERVED_PATHS = new Set([
    'about', 'account', 'compose', 'developer', 'download', 'en', 'explore',
    'flow', 'followers', 'following', 'hashtag', 'help', 'home', 'i', 'intent',
    'jobs', 'l', 'login', 'logout', 'messages', 'notifications', 'overview',
    'privacy', 'search', 'session', 'settings', 'share', 'signup', 'status',
    'terms', 'tos', 'tweet', 'welcome', 'who_to_follow', 'oauth', 'account',
]);

/** Matches an x.com or twitter.com handle, in plain or URL-encoded form. */
const HANDLE_PATTERN =
    /(?:x|twitter)\.com(?:%2F|\/)([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/gi;

export interface DiscoveryOptions {
    /** Cap on engine requests, so a long term list cannot become a crawl. */
    readonly maxQueries?: number;
    /** Cap on handles fed into the timeline path. */
    readonly maxHandles?: number;
    readonly proxyUrl?: string | undefined;
}

export interface DiscoveryResult {
    readonly handles: readonly string[];
    /** Which engine answered, for the run summary. `null` when none did. */
    readonly engine: string | null;
    readonly queriesRun: number;
}

/**
 * Find candidate handles for a set of topic terms.
 *
 * Never throws: discovery failing means the run finds nothing for that term,
 * which is a result, not a crash.
 */
export async function discoverHandles(
    terms: readonly string[],
    options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
    const maxQueries = options.maxQueries ?? DEFAULTS.maxDiscoveryQueries;
    const maxHandles = options.maxHandles ?? DEFAULTS.maxDiscoveredHandles;

    const evidence = new Map<string, HandleEvidence>();
    let engineUsed: string | null = null;
    let queriesRun = 0;

    for (const term of terms.slice(0, maxQueries)) {
        queriesRun += 1;

        const result = await queryEngines(term, options.proxyUrl);
        if (result === null) {
            log.warning('No search engine answered for term', { term });
            continue;
        }

        engineUsed ??= result.engine;
        // Every candidate is recorded, not just the first `maxHandles`. The cut
        // happens after ranking, so a handle that only shows up on the last
        // term still gets to compete with the ones seen first.
        result.handles.forEach((handle, index) => {
            const seen = evidence.get(handle) ?? { terms: new Set(), bestRank: index };
            seen.terms.add(term);
            seen.bestRank = Math.min(seen.bestRank, index);
            evidence.set(handle, seen);
        });

        log.info('Discovered handles for term', {
            term,
            engine: result.engine,
            found: result.handles.length,
            candidates: evidence.size,
        });
    }

    const handles = rankHandles(evidence).slice(0, maxHandles);
    if (evidence.size > handles.length) {
        log.info('Ranked discovery candidates', {
            candidates: evidence.size,
            kept: handles.length,
            dropped: evidence.size - handles.length,
        });
    }

    return { handles, engine: engineUsed, queriesRun };
}

/** What a run learned about one candidate handle across all its queries. */
interface HandleEvidence {
    /** Distinct terms this handle answered for. */
    readonly terms: Set<string>;
    /** Best (lowest) position the engine gave it. */
    bestRank: number;
}

/**
 * Order candidates by how much evidence backs them.
 *
 * Taking the first N in arrival order treats a handle that surfaced for three
 * separate terms the same as one that appeared once, at the bottom of a single
 * result page. Since each kept handle costs a profile lookup against a
 * 150/window operation and then a share of the timeline budget, the ones that
 * earn those requests should be the best-evidenced.
 *
 * Term coverage outranks engine position: appearing for two different terms is
 * a stronger signal of topical relevance than ranking first for one, because
 * search-engine position is optimised for a page's overall authority rather
 * than for whether an account actually posts about the subject.
 *
 * Exported for tests.
 */
export function rankHandles(evidence: ReadonlyMap<string, HandleEvidence>): string[] {
    return [...evidence.entries()]
        .sort(([handleA, a], [handleB, b]) => {
            const byCoverage = b.terms.size - a.terms.size;
            if (byCoverage !== 0) return byCoverage;
            const byRank = a.bestRank - b.bestRank;
            if (byRank !== 0) return byRank;
            // Alphabetical last, so the same inputs always give the same run.
            return handleA.localeCompare(handleB);
        })
        .map(([handle]) => handle);
}

/** Walk the cascade for one term; first engine that yields handles wins. */
async function queryEngines(
    term: string,
    proxyUrl: string | undefined,
): Promise<{ engine: string; handles: string[] } | null> {
    const query = encodeURIComponent(`site:x.com ${term}`);

    for (const engine of ENGINES) {
        const response = await performRequest({
            url: engine.url(query),
            proxyUrl,
            timeoutMs: 15_000,
            headers: {
                accept: 'text/html,application/xhtml+xml',
                'accept-language': 'en-US,en;q=0.9',
            },
        }).catch(() => null);

        if (response?.statusCode !== 200) {
            log.debug('Search engine unavailable, falling through', {
                engine: engine.name,
                status: response?.statusCode ?? 'transport error',
            });
            continue;
        }

        const handles = extractHandles(response.body);
        if (handles.length > 0) return { engine: engine.name, handles };
    }

    return null;
}

/** Pull X handles out of a search results page. Exported for tests. */
export function extractHandles(html: string): string[] {
    const found = new Set<string>();
    HANDLE_PATTERN.lastIndex = 0;

    for (const match of html.matchAll(HANDLE_PATTERN)) {
        const handle = match[1]?.toLowerCase();
        if (handle === undefined) continue;
        if (RESERVED_PATHS.has(handle)) continue;
        // Single characters and pure digits are almost always route noise.
        if (handle.length < 2 || /^\d+$/.test(handle)) continue;
        found.add(handle);
    }

    return [...found];
}

/**
 * Does this tweet actually mention one of the terms?
 *
 * Discovery returns accounts that rank for a topic, not tweets about it, so
 * without this the run would return those accounts' entire timelines and quietly
 * redefine what `searchTerms` means.
 */
export function matchesAnyTerm(text: string, terms: readonly string[]): boolean {
    const haystack = text.toLowerCase();
    return terms.some((term) => haystack.includes(term.toLowerCase()));
}
