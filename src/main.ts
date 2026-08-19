/**
 * Actor entry point.
 *
 * Wiring only — every decision this file appears to make is delegated:
 * validation to `input/parse.ts`, the item cap to `entitlements/resolver.ts`,
 * and the work itself to `pipeline/run.ts`. Keeping it that way is what makes
 * the gate auditable: there is exactly one place that decides how many items a
 * run may emit, and it is not here.
 */

import { Actor, log } from 'apify';

import { resolveEntitlement } from './entitlements/resolver.js';
import { parseInput } from './input/parse.js';
import { ResultEmitter } from './pipeline/emitter.js';
import { runScraper } from './pipeline/run.js';
import { RunState } from './pipeline/state.js';
import { XClient } from './x/client.js';
import { createGuestTokenFetcher, GuestTokenPool } from './x/guest-token.js';
import { fetchText, performRequest } from './x/http.js';
import { QueryIdResolver, type QueryIdCache, type ResolvedQueryIds } from './x/query-ids.js';
import { compact } from './util/json.js';
import { InputValidationError } from './util/errors.js';

await Actor.init();

try {
    const input = parseInput(await Actor.getInput());

    // Resolved before any network work: the cap decides how much fetching is
    // even worth starting.
    const entitlement = await resolveEntitlement();
    const emitter = new ResultEmitter(entitlement, input.maxResults);

    log.info('Starting run', {
        targets: { users: input.fromUsers.length, tweetIds: input.tweetIds.length },
        requested: input.maxResults,
        effectiveLimit: emitter.limit,
        tier: entitlement.tier,
    });

    const proxyConfiguration = await Actor.createProxyConfiguration(
        compact(input.proxyConfiguration),
    );

    const state = new RunState();
    await state.load();
    state.register();

    // Each guest token is minted through the proxy session it will be used
    // with, because X binds a token to the IP that requested it.
    const tokens = new GuestTokenPool(
        createGuestTokenFetcher(async (url, init) =>
            performRequest({
                url,
                method: init.method,
                headers: init.headers,
                proxyUrl: init.proxyUrl,
            }),
        ),
        {
            nextProxyUrl: async () => proxyConfiguration?.newUrl(),
        },
    );

    const queryIds = new QueryIdResolver(
        (url) => fetchText(url),
        createKeyValueQueryIdCache(),
    );

    const client = new XClient(tokens, queryIds);

    const summary = await runScraper({
        input,
        entitlement,
        client,
        emitter,
        state,
        nextProxyUrl: async () => proxyConfiguration?.newUrl(),
    });

    await Actor.exit(
        summary.limited
            ? `Done — ${summary.pushed} items (free-tier cap applied).`
            : `Done — ${summary.pushed} items.`,
    );
} catch (error: unknown) {
    // Input problems are the user's to fix and deserve a clean message rather
    // than a stack trace; anything else is ours and is surfaced in full.
    if (error instanceof InputValidationError) {
        log.error(error.message);
        await Actor.exit({ exitCode: 1, statusMessage: 'Invalid input — see the log.' });
    } else {
        log.exception(error instanceof Error ? error : new Error(String(error)), 'Run failed');
        await Actor.exit({ exitCode: 1, statusMessage: 'Run failed — see the log.' });
    }
}

/** Persist the resolved query-ID map between runs, keyed in the Actor's store. */
function createKeyValueQueryIdCache(): QueryIdCache {
    const KEY = 'X_QUERY_IDS';
    return {
        read: async () => (await Actor.getValue<ResolvedQueryIds>(KEY)) ?? null,
        write: async (value) => Actor.setValue(KEY, value),
    };
}
