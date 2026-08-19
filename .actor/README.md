![X (Twitter) GraphQL Tweet Scraper](https://raw.githubusercontent.com/JuaniVeltri/x-tweet-scraper/main/docs/assets/banner.png)

# x-tweet-scraper

A browserless Actor that collects public posts from X (Twitter) over its internal GraphQL API, normalizes them to a fixed contract, and enforces a free-tier limit that cannot be lifted from the input.

No browser engine is involved anywhere in the data path — no Playwright, no Puppeteer, no Selenium, no headless Chrome. Every request is plain HTTP.

**Measured:** median **11.7 s** to 100 valid results over 6 runs, every one inside the Grade A band, with zero errors. **~$0.035 per 1,000 results.** 382 tests, 83% coverage.

---

## Which surfaces are implemented, and why

| Surface | Operation | Status |
|---|---|---|
| Tweets by author | `UserTweets` | **Implemented.** Guest-reachable. |
| Single tweet by ID | `TweetResultByRestId` | **Implemented.** Guest-reachable. |
| User profile by handle | `UserByScreenName` | **Implemented.** Guest-reachable. |
| Free-text search | — | **Implemented a different way.** `SearchTimeline` is closed to guests, so topics resolve through public search-engine discovery. |

The three required surfaces are implemented against X's own endpoints with a guest token. Search is not, because X does not serve `SearchTimeline` to guests — established by measurement rather than assumed, and served instead through the alternative route the brief permits.

---

## The investigation: what is reachable without a login

### The trap — X returns 404 for three unrelated reasons

Conflating them is how one concludes the task is impossible.

| Response | Meaning | Correct reaction |
|---|---|---|
| `404` + `{"message":"Query not found"}` | The query ID rotated | Re-resolve the ID, retry |
| `404` + **empty body** | Operation exists but is not served to guests | Stop — this is the auth wall |
| `404`, anything else | Genuinely absent | Fail |

### The measurement

Each operation was called with **its own declared contract** — the query ID, feature switches and field toggles the operation itself advertises — so a failure could not be blamed on a stale ID or a missing flag. A query ID that never existed was sent through identical machinery as a control.

Measured 2026-08-19, guest token only:

```
UserByScreenName      -> 200, with data      rate limit: 150/window
UserTweets            -> 200, with data      rate limit:  50/window
TweetResultByRestId   -> 200, with data      rate limit: 500/window

SearchTimeline        -> 404, EMPTY body     rate limit:  50
UserTweetsAndReplies  -> 404, EMPTY body     rate limit: 500
TweetDetail           -> 404, EMPTY body     rate limit: 150

[control] bogus ID    -> 404 {"message":"Query not found"}
```

**The control is what makes this conclusive.** A query ID X has never heard of gets a JSON error that names the problem. `SearchTimeline` gets a silent, empty 404 — and X still attributes its own rate-limit bucket to the response. X resolved the operation, metered it against that bucket, and then declined to serve it. That is a deliberate authorization boundary, not a rotated ID.

### The rate limits are a design input, not trivia

`UserTweets` at 50 requests per window is the binding constraint on the whole Actor. At 40 tweets per page, one guest token is worth roughly 2,000 tweets. That is why the token pool rotates rather than reusing a single token, and why concurrency is applied across handles rather than within one timeline — paging a timeline is inherently sequential, since each page needs the previous page's cursor.

---

## Architecture and data flow

```
handles     ──► UserByScreenName ──► UserTweets (cursor paging) ──┐
searchTerms ──► search engine ──► handles ──► (same path) ────────┤──► normalize ──► filter ──► emit
tweet IDs   ──► TweetResultByRestId ──────────────────────────────┘                            │
                                                                                               ▼
                                                                entitlement decides how many get through
```

Two boundaries carry the design:

1. **The entitlement resolver is the only thing that may set a cap.** No input value reaches it.
2. **The emitter is the only thing that may write to the dataset.** Its limit is fixed at construction and has no setter.

Everything else is replaceable without touching either guarantee. The entitlement is resolved *before* any fetching starts, and the emitter feeds back into extraction — when its limit is reached the producers stop, so a capped run stops fetching rather than fetching everything and discarding most of it.

---

## The browserless approach

### Authentication

A guest token (`POST /1.1/guest/activate.json`) paired with the public web bearer that x.com's own frontend ships to every logged-out visitor. No cookies, no personal session, no credentials.

### Query IDs — where they live and how they change

Each GraphQL operation is addressed by a rotating opaque ID. Hardcoding them guarantees the Actor breaks on X's schedule, so they are resolved at runtime — and finding them took some digging, because **x.com currently serves two different frontends and the route decides which one you get**:

| Route | Frontend | Carries the operations? |
|---|---|---|
| `/`, `/<handle>` | New Vite + Relay app | **No.** Only 24 persisted queries, all UI chrome. The timeline is server-rendered, so no timeline operation exists in the bundle at all. |
| `/home`, `/i/flow/login` | Legacy webpack app | **Yes.** `main.*.js` carries 104 operations, including all three. |

Targeting a profile URL — the intuitive choice — finds nothing. The resolver therefore fetches `/home`, extracts the bundle URLs, and mines `main.*.js`.

The chain degrades rather than failing: key-value store cache → live extraction from X's bundle → a public daily-regenerated dump → compiled-in constants. A live run logs which one answered.

When X replies `404 {"message":"Query not found"}`, the resolver is invalidated and the request retried, so a mid-run rotation costs one retry rather than the run.

### Feature switches negotiate themselves

X rejects a request that omits any feature switch the operation declares, and the set changes as X ships features. Rather than a hardcoded list that silently rots, the Actor sends a superset and reads X's own rejection: the error names the missing switch, which is added and the request retried. A newly introduced flag heals within one request instead of requiring a redeploy.

### Topic search, without X's search

`SearchTimeline` is shut to guest tokens, so `searchTerms` inverts the question. Instead of asking X for **posts** matching a topic, a public search engine is asked which X **profiles** rank for it; those profiles' timelines are read through the guest-token path that already works, and only tweets that actually mention the term are kept.

The inversion is what makes it viable: engines index X profile pages densely and individual posts sparsely and late. Asking about people gives a stable answer, and recency still comes from X.

- **Engines cascade** — first to yield handles wins. They rate-limit datacenter traffic unevenly and without warning, so a single source would be a single point of failure.
- **Reserved paths are filtered** — `/home`, `/explore`, `/i/flow/login` and ~30 others look like handles in a URL, and each false positive costs a lookup against a 150/window operation.
- **Candidates are ranked before the cut** — by how many distinct terms each answered for, with engine position as the tie-break. What gets dropped is logged, never silently truncated.
- **Results are term-filtered** — discovery returns accounts that rank for a topic, not tweets about it. Without the final filter the run would emit whole timelines and quietly redefine what `searchTerms` means.

**It is not an index.** It returns tweets from accounts that rank for the topic; a matching tweet from an account no engine surfaced will not appear.

---

## Free-tier protection

Free runs receive at most **10 items**. Entitled runs receive up to their requested `maxResults`.

### How the cap is decided

1. **Identity.** `Actor.getEnv().userId` reads `APIFY_USER_ID` — a variable the person running the Actor can set. Taking it at face value would make this a client-side check, so the claimed ID is cross-checked against **Apify's own record of the run** (`GET /v2/actor-runs/{runId}`), which reports who actually started it and lives on Apify's servers. Disagreement, or an unreadable record, marks the identity unverified.
2. **Entitlement.** An unverified identity is never even asked about. A verified one is sent to a signed endpoint the author controls, which returns an HMAC-signed claim.
3. **Verification.** The signature is checked with a constant-time comparison. The run's random nonce must come back inside the signed payload, and the claim must be fresh.
4. **Enforcement.** The resulting cap is fixed at emitter construction. `maxResults` is applied only as `min(requested, cap)`.

### Why each bypass fails

| Attempt | Why it fails |
|---|---|
| `maxResults: 1000000` | The cap is never derived from input. `maxResults` can only narrow. |
| Undocumented input fields | Unknown keys are stripped, and no input key feeds the resolver. |
| Editing `APIFY_USER_ID` | Contradicts the platform's run record → identity unverified → capped. |
| Blocking the entitlements service | Unreachable authority → fail closed → capped. |
| Spoofing DNS to return `{"tier":"paid"}` | No signing key, so the claim fails verification. |
| Replaying a captured genuine "paid" response | It answers a nonce this run never issued. |
| Reading the public source for a client-side check | There isn't one — the source of truth is off-box. |

### Anti-fork reasoning

Both authorities are reached with **Actor-level secret credentials**. Apify attaches those to the Actor, not to the run: a user who runs the published Actor gets them injected but cannot read them, and a user who forks the source gets the code with no secret at all. A fork therefore cannot obtain a claim that verifies, and falls closed to 10.

A fork can of course delete the check — the source is public. That is not the threat this protects against, and pretending otherwise would be dishonest. What it protects is the **hosted service**: the author's compute, proxy budget and maintained query-ID resolution. A fork runs on the forker's own account and quota, consuming none of it. If the extraction itself had to be protected, the escalation is to move it behind the same signed service, so that a fork has nothing to run.

### Fail-closed, exhaustively

Unreachable service, malformed body, invalid signature, replayed nonce, wrong subject, stale claim, unknown user, unverifiable identity, **no entitlements configuration at all** — every one resolves to the free tier. There is no path returning a raised cap without both a verified identity and a verified claim.

### Verified on the platform

Same Actor, same input, the only difference being whether the user was on the allow-list:

```
Entitled:      requested 100,  fetched 107,  pushed 100,  limited false,  tier paid
Not entitled:  requested 1000, fetched 10,   pushed 10,   limited true,   tier free
               {"limited":true,"reason":"free_tier","cap":10}
```

Note `fetched: 10` against `requested: 1000`. The capped run made two requests and stopped — it stops **fetching**, not merely pushing.

---

## Input

At least one of `fromUsers`, `tweetIds` or `searchTerms` is required. Unspecified filters mean "no constraint"; filters combine with **AND**.

| Field | Type | Meaning |
|---|---|---|
| `fromUsers` | `string[]` | Handles, without `@`. |
| `tweetIds` | `string[]` | Tweet IDs to hydrate. |
| `searchTerms` | `string[]` | Topic terms, resolved to handles via search-engine discovery. |
| `hashtags` | `string[]` | Must contain all of these, without `#`. |
| `since` / `until` | ISO date | Inclusive window. A bare `until` date covers the whole day. |
| `language` | ISO-639-1 | Detected tweet language. |
| `minLikes` / `minRetweets` / `minReplies` | integer | Engagement floors. |
| `onlyVerified` | boolean | Includes blue, gold (business) and grey (government) checkmarks. |
| `mediaType` | enum | `any`, `text_only`, `images`, `video`, `links`. |
| `includeReplies` / `includeRetweets` | boolean | Both default `false`. |
| `sortBy` | enum | `latest` (default) or `top`. |
| `maxResults` | integer | Requested cap. Subject to the entitlement. |
| `webhookUrl` | string | Optional. The run summary is POSTed here on finish. |
| `proxyConfiguration` | object | Standard Apify proxy object; residential supported. |

```json
{
  "fromUsers": ["apify", "elonmusk"],
  "hashtags": ["buildinpublic"],
  "since": "2025-01-01",
  "language": "en",
  "minLikes": 25,
  "mediaType": "any",
  "includeReplies": false,
  "includeRetweets": false,
  "sortBy": "latest",
  "maxResults": 500,
  "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

---

## Output

Every dataset item conforms exactly to the contract. Missing values are `null` — never omitted, never `undefined`. IDs are strings, because X's snowflake IDs exceed `Number.MAX_SAFE_INTEGER` and routing one through a JS number corrupts it silently. Timestamps are ISO-8601 UTC.

A real item from a live run:

```json
{
  "id": "2087572956683567110",
  "url": "https://x.com/apify/status/2087572956683567110",
  "text": "Everything runs on Apify. One day. San Francisco. … Get your tickets now → http://apify.it/X054l",
  "lang": "en",
  "createdAt": "2026-08-12T16:12:32.000Z",
  "conversationId": "2087572956683567110",
  "isReply": false,
  "isRetweet": false,
  "isQuote": false,
  "inReplyToId": null,
  "quotedTweetId": null,
  "author": {
    "id": "3510729917", "username": "apify", "name": "Apify",
    "verified": true, "followers": 12047, "following": 296
  },
  "metrics": {
    "likes": 17, "retweets": 4, "replies": 2,
    "quotes": 0, "bookmarks": 1, "views": 2332
  },
  "entities": {
    "hashtags": [], "mentions": [], "urls": ["http://apify.it/X054l"],
    "media": [{ "type": "photo", "url": "https://pbs.twimg.com/media/HPiMidvXgAEpJ53.jpg", "thumbnail": null }]
  },
  "source": "Agorapulse app",
  "scrapedAt": "2026-08-19T01:51:12.965Z"
}
```

`t.co` shortlinks are expanded in `text`; `source` is stripped from its anchor markup.

### Two live user schemas

X is mid-migration. Newer query IDs return `user.legacy: null` with fields split across `core`, `relationship_counts` and `verification`; older ones return the legacy shape. The normalizer reads through an ordered list of candidate paths for each field, and the test suite runs the **same assertions against captured responses of both**, asserting they normalize identically. A rotation that flips X to the other shape is therefore a non-event.

---

## Running it

### On Apify

Open the Actor, set the input, and hit Start. The run's `OUTPUT` record carries the summary: requested vs fetched vs pushed, the `limited` flag, and error counts.

### Locally

```bash
npm ci
mkdir -p storage/key_value_stores/default
echo '{"fromUsers":["apify"],"maxResults":25}' > storage/key_value_stores/default/INPUT.json
npm start
```

A local run has no platform run record, so identity cannot be verified and the free-tier cap applies. That is the fail-closed path working as designed, and the easiest way to see it.

### Deploying your own copy

```bash
# 1. The entitlements service
cd services/entitlements
vercel deploy --prod
vercel env add ENTITLEMENTS_SECRET production      # a strong random string
vercel env add ENTITLED_USER_IDS production        # comma-separated Apify user IDs

# 2. The Actor
apify secrets add x-entitlements-secret <the same secret>
# point ENTITLEMENTS_URL in .actor/actor.json at your deployment
apify push
```

`ENTITLED_USER_IDS` accepts `userId` or `userId:cap` entries.

---

## Performance

**Median 11.7 s to 100 valid results**, measured on the platform. Grade A is < 30 s.

Six runs, same input (one high-volume author, `sortBy: latest`, `maxResults: 100`, Apify proxy, paid entitlement, 4 GB), timed from the run's own clock — first outbound request to the 100th item pushed — so cold start and build are excluded.

```
min 8.15 s · median 11.70 s · mean 11.71 s · max 14.59 s
6/6 inside Grade A · 0 errors across all runs · exactly 7 requests every time
```

The median is the number worth quoting; 8.15 s was the best case. What does not move is the request count — seven every single time — which places the variance in X's latency rather than in the paging logic.

Where the speed comes from: 40 tweets per page rather than the default 20, one profile lookup per handle rather than per page, a cached query-ID map, concurrency across handles, and stopping the moment the cap is filled.

### Cost per 1,000 results

Measured, not estimated, from the same run:

| Component | Per 1,000 | Share |
|---|---|---|
| Compute units | $0.0273 | 79% |
| Dataset writes | $0.0050 | 14% |
| Key-value store | $0.0021 | 6% |
| Data transfer | $0.0002 | 1% |
| **Total** | **≈ $0.035** | |

Compute is 79% of the bill, and Apify scales CPU with memory — so memory trades cost against wall-clock directly. 4 GB gives 11.7 s; 1 GB gives about 18 s for roughly half the cost. Both are Grade A. The default is 4 GB because the brief grades time-to-100.

**Honest caveat on the proxy.** The brief measures with a residential proxy. This was measured on an Apify **free** plan, which reports `RESIDENTIAL` with `availableCount: 0` — residential IPs are not allocated on that tier, so the run used datacenter proxy. Residential rotation is fully wired and configurable through `proxyConfiguration`; expect it to be somewhat slower per request and rather harder to rate-limit.

---

## Resilience

Every failure is sorted into one classification, and that verdict alone decides what happens next:

| Classification | Trigger | Reaction |
|---|---|---|
| `retryable` | 429, 5xx, X error code 88 | Exponential backoff with **full jitter**, honouring `retry-after` |
| `rotate-token` | Codes 89 / 239 / 326, or 401/403 | Retire the guest token, retry with a fresh one |
| `refresh-query-id` | `404 {"message":"Query not found"}` | Re-resolve IDs, retry |
| `auth-walled` | `404` + empty body | Stop immediately — retrying cannot help |
| `fatal` | Anything else | Stop immediately |

Full jitter — a uniform draw from `[0, exponential]` rather than `exponential ± noise` — is what stops concurrent workers retrying in lockstep and re-creating the burst that caused the throttle.

Also handled: `x-rate-limit-remaining` is watched so a token is retired before X starts refusing; pagination stops on a repeated cursor + entry-ID pair (X occasionally returns the cursor you just sent) and after three consecutive pages with nothing usable; a global seen-set deduplicates across overlapping targets; protected, suspended and deleted accounts are reported and skipped rather than treated as errors; and cursors, the seen-set and the emitted count are snapshotted on `persistState` and `migrating`, so a migrated run resumes instead of restarting and re-emitting.

---

## Known limitations

- **Topic search is not an index.** `SearchTimeline` is auth-walled to guests, so `searchTerms` returns tweets *from accounts that rank for the topic*, not every tweet matching a query. Discovery also depends on third-party engines that rate-limit datacenter traffic — hence the multi-engine cascade.
- **`UserTweetsAndReplies` and `TweetDetail` are likewise walled**, so replies are limited to those the profile timeline itself returns, and full conversation threads are out of reach.
- **`sortBy: "top"` orders what was collected.** X's profile timeline is chronological and accepts no ordering argument, so `top` cannot reorder tweets the timeline never returned.
- **`hashtags`, engagement floors and the date window are post-filters.** The timeline API takes no filter arguments, so a narrow filter over a busy account reads more pages to fill the same count.
- **Guest rate limits are the ceiling.** `UserTweets` allows 50 requests per token per window. Large runs are paced by token rotation and proxy IP diversity.
- **`x-client-transaction-id`** is not currently required — every request in this work succeeded without it — but X has been rolling it out. The algorithm is deliberately not implemented, since it would be speculative work against a header nothing is asking for and a bug in it would break requests that currently succeed. The seam exists: the client accepts a per-request header provider, so it plugs in without touching the retry loop.
- **Residential proxy unmeasured**, for the plan reason described above.

---

## Terms of service and robots

Points worth raising before running anything like this for a client:

- Only public data is read — content any logged-out visitor can see. No private, protected or authenticated content is accessed, and no login is used.
- These GraphQL endpoints are **undocumented internal APIs**, not a public product. They carry no stability guarantee and no license to use them. Automated access is in tension with X's Terms of Service, which restrict scraping without prior consent. A commercial deployment should have that conversation with counsel first, and should prefer the paid X API where the budget allows.
- `x.com/robots.txt` is written for crawlers rather than API clients. The Actor does not crawl HTML pages; it reads `/home` once to discover script bundles, which robots.txt does not disallow.
- The Actor is polite by construction: bounded concurrency, backoff with jitter, proactive retreat from rate limits, and no retry against an operation X has declined to serve.
- Personal data is in scope. Tweets and profiles are personal data under GDPR even when public; a production deployment needs a lawful basis, a retention policy, and a story for erasure requests.
- Nothing here defeats an access control, solves a CAPTCHA, or evades a bot defence. It sends the same requests x.com's own logged-out frontend sends.
