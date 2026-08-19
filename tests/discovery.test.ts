/**
 * Topic discovery (assessment §2a stretch).
 *
 * Parsing a search results page is the fragile half of this feature — engines
 * change markup without notice, and every false positive costs a wasted profile
 * lookup against an operation limited to 150 requests per window. These tests
 * pin the extractor against real markup shapes.
 */

import { describe, expect, it } from 'vitest';

import {
    extractHandles,
    matchesAnyTerm,
    rankHandles,
} from '../src/x/discovery/search-engines.js';

describe('extractHandles', () => {
    it('reads handles from plain result links', () => {
        const html = `
            <a href="https://x.com/apify">Apify</a>
            <a href="https://twitter.com/scrapingdog">Scrapingdog</a>
        `;
        expect(extractHandles(html).sort()).toEqual(['apify', 'scrapingdog']);
    });

    it('reads handles from URL-encoded redirect links', () => {
        // DuckDuckGo wraps results in a redirect with the target percent-encoded.
        const html = '<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.com%2Fapify">Apify</a>';
        expect(extractHandles(html)).toEqual(['apify']);
    });

    it('drops reserved paths that are not accounts', () => {
        // Each of these would otherwise cost a wasted profile lookup.
        const html = [
            'https://x.com/home',
            'https://x.com/explore',
            'https://x.com/i/flow/login',
            'https://x.com/search',
            'https://x.com/settings',
            'https://x.com/hashtag',
            'https://x.com/realuser',
        ].map((u) => `<a href="${u}">x</a>`).join('');
        expect(extractHandles(html)).toEqual(['realuser']);
    });

    it('ignores status permalinks rather than treating the ID as a handle', () => {
        const html = '<a href="https://x.com/apify/status/2087572956683567110">post</a>';
        // The handle is real; the numeric ID must not become a second "handle".
        expect(extractHandles(html)).toEqual(['apify']);
    });

    it('drops purely numeric and single-character candidates', () => {
        const html = '<a href="https://x.com/12345">n</a><a href="https://x.com/a">s</a>';
        expect(extractHandles(html)).toEqual([]);
    });

    it('deduplicates and lowercases', () => {
        const html = `
            <a href="https://x.com/Apify">a</a>
            <a href="https://x.com/apify">b</a>
            <a href="https://twitter.com/APIFY">c</a>
        `;
        expect(extractHandles(html)).toEqual(['apify']);
    });

    it('never exceeds the 15-character handle limit', () => {
        const html = '<a href="https://x.com/waaaaaaaaaaaaaaaytoolonghandle">x</a>';
        for (const handle of extractHandles(html)) {
            expect(handle.length).toBeLessThanOrEqual(15);
        }
    });

    it('returns nothing for a page with no X links', () => {
        expect(extractHandles('<html><body>no results</body></html>')).toEqual([]);
    });
});

describe('matchesAnyTerm', () => {
    it('matches case-insensitively', () => {
        expect(matchesAnyTerm('Learning Web Scraping today', ['web scraping'])).toBe(true);
        expect(matchesAnyTerm('learning WEB SCRAPING', ['Web Scraping'])).toBe(true);
    });

    it('matches when any one term is present', () => {
        expect(matchesAnyTerm('a post about APIs', ['scraping', 'apis'])).toBe(true);
    });

    it('rejects a tweet mentioning none of the terms', () => {
        // This is what keeps `searchTerms` honest: discovery returns accounts
        // that rank for a topic, so without this the run would emit their whole
        // timelines regardless of subject.
        expect(matchesAnyTerm('lunch was good', ['scraping', 'apis'])).toBe(false);
    });

    it('matches inside longer words, which is intended for topic search', () => {
        expect(matchesAnyTerm('webscraping tools', ['scraping'])).toBe(true);
    });
});

describe('rankHandles', () => {
    const ev = (terms: string[], bestRank: number) => ({ terms: new Set(terms), bestRank });

    it('puts breadth of term coverage above engine position', () => {
        // `broad` ranked last for its terms but answered two of them; `narrow`
        // ranked first for one. Coverage is the stronger signal of topical
        // relevance, because engine position reflects page authority.
        const ranked = rankHandles(
            new Map([
                ['narrow', ev(['scraping'], 0)],
                ['broad', ev(['scraping', 'apis'], 9)],
            ]),
        );
        expect(ranked).toEqual(['broad', 'narrow']);
    });

    it('falls back to engine position when coverage ties', () => {
        const ranked = rankHandles(
            new Map([
                ['later', ev(['scraping'], 5)],
                ['earlier', ev(['scraping'], 1)],
            ]),
        );
        expect(ranked).toEqual(['earlier', 'later']);
    });

    it('is deterministic when coverage and position both tie', () => {
        const build = () =>
            new Map([
                ['zeta', ev(['t'], 2)],
                ['alpha', ev(['t'], 2)],
            ]);
        // The same input must always produce the same run.
        expect(rankHandles(build())).toEqual(['alpha', 'zeta']);
        expect(rankHandles(build())).toEqual(rankHandles(build()));
    });

    it('returns every candidate, leaving the cut to the caller', () => {
        const ranked = rankHandles(
            new Map([['a', ev(['t'], 0)], ['b', ev(['t'], 1)], ['c', ev(['t'], 2)]]),
        );
        expect(ranked).toHaveLength(3);
    });
});
