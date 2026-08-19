/**
 * Constants for X's internal web API.
 *
 * Everything here is public information served to every logged-out visitor of
 * x.com. No credential, cookie or personal session is involved (assessment §3).
 */

/**
 * The public web bearer that pairs with a guest token.
 *
 * This is a build-time constant of x.com's own frontend — it identifies the web
 * client, not a user, and is served verbatim to anyone who loads the site. It is
 * the same value used by every open-source X client (twscrape, twikit, tweety,
 * nitter, the-convocation/twitter-scraper).
 *
 * Verified reachable on 2026-08-19: paired with a fresh guest token it returns
 * HTTP 200 for the three operations in {@link OPERATIONS}.
 */
export const X_PUBLIC_WEB_BEARER =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D' +
    '1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

/** Issues a guest token. POST, empty body, bearer auth only. */
export const GUEST_ACTIVATE_URL = 'https://api.x.com/1.1/guest/activate.json';

/**
 * GraphQL base. Requests compose as `<base>/<queryId>/<operationName>`.
 *
 * `api.x.com/graphql` and `x.com/i/api/graphql` are equivalent and both accept a
 * guest token; we use the former because it avoids the same-origin CSRF cookie
 * check that the `x.com` host applies.
 */
export const GRAPHQL_BASE = 'https://api.x.com/graphql';

/** Homepage, crawled to discover the JS bundles that carry current query IDs. */
export const X_WEB_ORIGIN = 'https://x.com';

/**
 * Community-maintained dump of X's GraphQL operation contracts, regenerated
 * daily. Used only to bootstrap/refresh query IDs when live bundle extraction
 * yields nothing; never on the hot path.
 *
 * @see https://github.com/fa0311/TwitterInternalAPIDocument
 */
export const QUERY_ID_DUMP_URL =
    'https://raw.githubusercontent.com/fa0311/TwitterInternalAPIDocument/master/docs/json/GraphQL.json';

/** The GraphQL operations this Actor targets. */
export const OPERATIONS = {
    /** Profile by handle. Guest-reachable. Observed rate limit: 150/window. */
    userByScreenName: 'UserByScreenName',
    /** A user's tweet timeline. Guest-reachable. Observed rate limit: 50/window. */
    userTweets: 'UserTweets',
    /** A single tweet, fully hydrated. Guest-reachable. Observed limit: 500/window. */
    tweetResultByRestId: 'TweetResultByRestId',
    /** Free-text search. NOT guest-reachable — see docs/INVESTIGATION.md. */
    searchTimeline: 'SearchTimeline',
} as const;

export type OperationName = (typeof OPERATIONS)[keyof typeof OPERATIONS];

/**
 * Last-known-good query IDs, used only when live resolution fails.
 *
 * X rotates these continuously, so they are a fallback and not a source of
 * truth — {@link ../x/query-ids.ts} resolves them at runtime. Verified working
 * on 2026-08-19.
 */
export const FALLBACK_QUERY_IDS: Readonly<Record<string, string>> = {
    [OPERATIONS.userByScreenName]: 'Gb-d6r0vxPOADdG62OEBpQ',
    [OPERATIONS.userTweets]: 'SXVCYB8XHSS25nzIljNtZA',
    [OPERATIONS.tweetResultByRestId]: 'GZsN2Pc4knAoit6pXa4HSA',
    [OPERATIONS.searchTimeline]: 'hyPfJYJ_XAtDYoslQc-Rgg',
};

/**
 * Rate limits observed empirically per guest token, per 15-minute window
 * (read from `x-rate-limit-limit` on live responses on 2026-08-19).
 *
 * `UserTweets` at 50 is the binding constraint: a single guest token affords
 * ~50 pages, which is why the token pool rotates rather than reusing one token.
 */
export const OBSERVED_RATE_LIMITS: Readonly<Record<string, number>> = {
    [OPERATIONS.userByScreenName]: 150,
    [OPERATIONS.userTweets]: 50,
    [OPERATIONS.tweetResultByRestId]: 500,
};

/** Browser-shaped headers. X's edge rejects requests without a plausible client. */
export const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

/** Tuning knobs, all overridable through {@link RuntimeConfig}. */
export const DEFAULTS = {
    /** Tweets requested per timeline page. X caps this around 100; 40 pages fast. */
    pageSize: 40,
    /** Concurrent in-flight requests across all targets. */
    concurrency: 4,
    /** Attempts per request, including the first. */
    maxAttempts: 5,
    /** Base delay for exponential backoff, in milliseconds. */
    backoffBaseMs: 500,
    /** Ceiling for a single backoff sleep, in milliseconds. */
    backoffMaxMs: 30_000,
    /** Per-request timeout, in milliseconds. */
    requestTimeoutMs: 30_000,
    /** Guest tokens kept warm for rotation. */
    guestTokenPoolSize: 3,
    /** Guest tokens are refreshed well before X's observed ~3h expiry. */
    guestTokenTtlMs: 2 * 60 * 60 * 1000,
    /** Consecutive pages with no usable tweets before a timeline is abandoned. */
    maxEmptyPages: 3,
    /** How long a resolved query-ID map stays cached in the key-value store. */
    queryIdCacheTtlMs: 6 * 60 * 60 * 1000,
} as const;

/** The item cap applied to any run that is not entitled to more (assessment §6). */
export const FREE_TIER_CAP = 10;
