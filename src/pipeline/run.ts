/**
 * Run orchestration: wires validated input, the entitlement, and the X client
 * into a dataset.
 *
 * The shape of the loop is dictated by the cap. Results are collected into a
 * buffer whose capacity *is* the effective limit, so fetching stops the moment
 * the run has enough — a capped run does not fetch a thousand tweets and
 * discard 990 of them (§6: *"stops fetching and pushing at 10"*). The emitter
 * then enforces the same limit again at push time, so the guarantee does not
 * depend on this loop being correct.
 */

import { Actor, log } from 'apify';
import pLimit from 'p-limit';

import { DEFAULTS } from '../config/constants.js';
import type { Entitlement } from '../entitlements/types.js';
import { sortResults, TweetFilter } from '../filters/apply.js';
import type { ScraperInput } from '../input/schema.js';
import { normalizeTweet } from '../normalize/tweet.js';
import type { OutputTweet, RunSummary } from '../output/types.js';
import { type XClient } from '../x/client.js';
import { fetchTweetById } from '../x/operations/tweet-by-rest-id.js';
import { fetchUserProfile } from '../x/operations/user-by-screen-name.js';
import { fetchUserTweetsPage } from '../x/operations/user-tweets.js';
import { discoverHandles, matchesAnyTerm } from '../x/discovery/search-engines.js';
import { SeenSet, StallDetector } from './dedupe.js';
import { type ResultEmitter } from './emitter.js';
import type { RunState } from './state.js';
import { postRunSummary } from './webhook.js';

export interface RunContext {
    readonly input: ScraperInput;
    readonly entitlement: Entitlement;
    readonly client: XClient;
    readonly emitter: ResultEmitter;
    readonly state: RunState;
    /**
     * Proxy for topic discovery. Search engines rate-limit datacenter IPs hard
     * — Brave answered 429 during development — so discovery goes through the
     * run's configured proxy when there is one.
     */
    readonly nextProxyUrl?: () => Promise<string | undefined>;
}

export async function runScraper(context: RunContext): Promise<RunSummary> {
    const startedAt = new Date();
    const { input, entitlement, client, emitter, state } = context;

    const filter = new TweetFilter(input);
    const seen = new SeenSet(state.snapshot.seenIds);
    const collected: OutputTweet[] = [];
    let fetched = 0;

    /** Capacity is the cap: reaching it is what stops every producer. */
    const capacity = emitter.limit;
    const hasRoom = (): boolean => collected.length < capacity;

    /** Normalize, filter and buffer one raw tweet node. */
    const consider = (raw: unknown): void => {
        if (!hasRoom()) return;
        fetched += 1;

        const tweet = normalizeTweet(raw);
        if (tweet === null) return;
        if (!seen.add(tweet.id)) return; // duplicate across overlapping targets
        if (!filter.accepts(tweet)) return;
        // Discovery yields accounts that rank for a topic, not tweets about it.
        // Without this the run would return whole timelines and quietly redefine
        // what `searchTerms` means.
        if (input.searchTerms.length > 0 && !matchesAnyTerm(tweet.text, input.searchTerms)) {
            return;
        }

        collected.push(tweet);
    };

    // --- tweet IDs -------------------------------------------------------
    // Hydration is independent per ID and its operation is the most generous
    // of the three (500/window), so it runs at full concurrency.
    if (input.tweetIds.length > 0 && hasRoom()) {
        const limit = pLimit(DEFAULTS.concurrency);
        await Promise.all(
            input.tweetIds.map((id) =>
                limit(async () => {
                    if (!hasRoom()) return;
                    const raw = await fetchTweetById(client, id).catch((error: unknown) => {
                        log.warning('Could not hydrate tweet', { id, error: String(error) });
                        return null;
                    });
                    if (raw !== null) consider(raw);
                }),
            ),
        );
    }

    // --- topic discovery (§2a stretch) -----------------------------------
    // X's SearchTimeline is closed to guests, so topic terms are resolved to
    // candidate accounts through a public search engine and then read through
    // the guest-token timeline path that does work.
    let discovery: Awaited<ReturnType<typeof discoverHandles>> | null = null;
    const handles = [...input.fromUsers];

    if (input.searchTerms.length > 0 && hasRoom()) {
        discovery = await discoverHandles(input.searchTerms, {
            proxyUrl: await context.nextProxyUrl?.(),
        }).catch((error: unknown) => {
            log.warning('Topic discovery failed', { error: String(error) });
            return null;
        });
        for (const handle of discovery?.handles ?? []) {
            if (!handles.some((existing) => existing.toLowerCase() === handle)) {
                handles.push(handle);
            }
        }
        log.info('Topic discovery complete', {
            terms: input.searchTerms.length,
            engine: discovery?.engine ?? null,
            handlesFound: discovery?.handles.length ?? 0,
        });
    }

    // --- author timelines ------------------------------------------------
    // Pagination within one timeline is inherently sequential (each page needs
    // the previous page's cursor), so concurrency is applied *across* handles.
    if (handles.length > 0 && hasRoom()) {
        const limit = pLimit(Math.min(DEFAULTS.concurrency, handles.length));
        await Promise.all(
            handles.map((handle) =>
                limit(() => scrapeTimeline(handle, { client, state, consider, hasRoom })),
            ),
        );
    }

    // --- emit ------------------------------------------------------------
    const ordered = sortResults(collected, input.sortBy);
    await emitter.offerAll(ordered);
    await emitter.finalize();

    state.recordEmitted(emitter.count);
    state.rememberSeen(seen.values());
    await state.persist(true);

    const finishedAt = new Date();
    const summary: RunSummary = {
        requested: input.maxResults,
        fetched,
        pushed: emitter.count,
        limited: emitter.wasLimitedByEntitlement,
        reason: emitter.wasLimitedByEntitlement ? 'free_tier' : null,
        cap: emitter.limit,
        tier: entitlement.tier,
        errors: {
            retryable: client.stats.retryableErrors,
            fatal: client.stats.fatalErrors,
        },
        targets: {
            users: handles.length,
            tweetIds: input.tweetIds.length,
            searchTerms: input.searchTerms.length,
            discoveredHandles: discovery?.handles.length ?? 0,
            discoveryEngine: discovery?.engine ?? null,
        },
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
    };

    log.info('Run finished', {
        ...summary,
        filteredOut: filter.stats,
        requests: client.stats.requests,
        tokenRotations: client.stats.tokenRotations,
        queryIdRefreshes: client.stats.queryIdRefreshes,
    });

    await Actor.setValue('OUTPUT', summary);

    // Fired after the dataset and OUTPUT are already durable, so a webhook
    // failure can only cost a notification, never the run's results.
    if (input.webhookUrl !== undefined) {
        await postRunSummary(input.webhookUrl, summary, Actor.getEnv().actorRunId);
    }

    await Actor.setStatusMessage(
        summary.limited
            ? `Pushed ${summary.pushed} items (free-tier cap of ${summary.cap} applied).`
            : `Pushed ${summary.pushed} items from ${summary.targets.users} timeline(s).`,
    ).catch(() => undefined);

    return summary;
}

interface TimelineDeps {
    readonly client: XClient;
    readonly state: RunState;
    readonly consider: (raw: unknown) => void;
    readonly hasRoom: () => boolean;
}

/** Page through one handle's timeline until it is exhausted or the run is full. */
async function scrapeTimeline(handle: string, deps: TimelineDeps): Promise<void> {
    const { client, state, consider, hasRoom } = deps;
    const target = `user:${handle.toLowerCase()}`;

    if (state.isCompleted(target)) {
        log.debug('Target already completed in a previous run segment', { handle });
        return;
    }

    const profile = await fetchUserProfile(client, handle).catch((error: unknown) => {
        log.warning('Could not resolve handle', { handle, error: String(error) });
        return null;
    });

    if (profile === null) {
        log.warning('Handle not found; skipping', { handle });
        state.markCompleted(target);
        return;
    }

    // Protected, suspended and deleted accounts are ordinary outcomes, not
    // errors: they are reported and skipped (§11 bonus).
    if (profile.unavailable) {
        log.warning('Account is unavailable; skipping', {
            handle,
            reason: profile.unavailableReason,
        });
        state.markCompleted(target);
        return;
    }

    const stall = new StallDetector(DEFAULTS.maxEmptyPages);
    let cursor = state.cursorFor(target);

    while (hasRoom()) {
        const page = await fetchUserTweetsPage(client, {
            userId: profile.restId,
            cursor,
            count: DEFAULTS.pageSize,
        }).catch((error: unknown) => {
            log.warning('Timeline page failed; ending this target', {
                handle,
                error: String(error),
            });
            return null;
        });

        if (page === null) break;

        for (const raw of page.tweets) consider(raw);

        if (stall.shouldStop(page.nextCursor, page.entryIds, page.tweets.length)) {
            state.markCompleted(target);
            return;
        }

        cursor = page.nextCursor ?? undefined;
        state.setCursor(target, page.nextCursor);
    }

    log.debug('Stopped paginating: the run reached its limit', { handle });
}
