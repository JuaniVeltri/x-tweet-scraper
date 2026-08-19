# Investigation log — what X serves to a guest

Reproducible record of how this Actor's scope was decided. Everything below was measured against
the live API on **2026-08-19**; the scripts that produced it are committed
([`scripts/probe.py`](../scripts/probe.py), [`scripts/probe2.py`](../scripts/probe2.py)) so the
findings can be re-derived rather than taken on faith.

---

## 1. Guest token

```
POST https://api.x.com/1.1/guest/activate.json
authorization: Bearer <public web bearer>
(empty body)

→ 200 {"guest_token":"2089881799644123357"}
```

The bearer is a build-time constant of x.com's own frontend, served to every logged-out visitor. It
identifies the web client, not a user. No cookie or personal session is involved.

---

## 2. The trap: 404 means three different things

This is the single most important finding, and misreading it is how one concludes the task is
impossible.

| Response | Meaning |
|---|---|
| `404` + `{"message":"Query not found"}` | The query ID is unknown to X — it rotated. Says nothing about authorization. |
| `404` + **empty body** | X recognises the operation and declines to serve it to a guest. |
| `200` + `data` | Guest-reachable. |

An early probe using community query IDs returned `404` for `SearchTimeline` and it would have been
easy to record that as "search is walled". It was not evidence of anything — those IDs were simply
dead. The second probe was built specifically to remove that ambiguity.

---

## 3. Method

For each operation, the request was built from **the operation's own declared contract**:

- the current query ID,
- every `featureSwitch` the operation declares,
- every `fieldToggle` it declares,

so a failure could not be attributed to a stale ID or a missing flag. A query ID that never existed
was included as a control, sent through identical machinery.

Query IDs were cross-checked against three independent sources that agreed exactly: x.com's own
`main.*.js` bundle, a daily-regenerated community dump, and a live 200 response.

---

## 4. Results

```
OPERACION                VEREDICTO                                    RATE-LIMIT
------------------------------------------------------------------------------
UserByScreenName         GUEST-REACHABLE                              150
UserTweets               GUEST-REACHABLE                               50
TweetResultByRestId      GUEST-REACHABLE                              500
SearchTimeline           HTTP 404, EMPTY BODY                          50
UserTweetsAndReplies     HTTP 404, EMPTY BODY                         500
TweetDetail              HTTP 404, EMPTY BODY                         150
[control: fake id]       HTTP 404: Query not found                      -
```

Raw responses: [`tests/fixtures/guest-reachability-verdicts.json`](../tests/fixtures/guest-reachability-verdicts.json).

### Reading the result

The control is what makes this conclusive. An operation X has never heard of receives a JSON error
that *names* the problem. `SearchTimeline` receives a silent empty 404 — **and X still attaches its
own rate-limit bucket to the response** (`x-rate-limit-limit: 50`, distinct from the 150 and 500
attached to the other two). X resolved the operation, metered it, and then declined to serve it.

That is an authorization boundary. A rotated ID would have produced the control's response instead.

### Conclusion

The three required surfaces are guest-reachable and are implemented. Free-text search is not, and is
rejected at the input boundary with this evidence rather than silently returning nothing. Reaching
it would require a non-personal, programmatically obtained logged-in session — a standing bonus,
deliberately not attempted, since the hard constraints forbid a personal session and a half-working
search that trips bans is worse than an honest refusal.

---

## 5. Where query IDs live

x.com serves **two different frontends, and the route decides which one you get.** This is not
documented anywhere and cost the most time to establish.

| Route | Frontend | Bundles | Operations found |
|---|---|---|---|
| `/`, `/<handle>` | Vite + TanStack Router + Relay | `abs.twimg.com/x-web/` (242 chunks) | 24 — all UI chrome. **Zero timeline operations.** |
| `/home`, `/i/flow/login` | Legacy webpack | `abs.twimg.com/responsive-web/client-web/` (6 bundles) | **104**, including all three required. |

The profile route — the intuitive place to look — is a dead end twice over: its bundles carry no
timeline operation, and the timeline itself is server-rendered, so watching a profile page in a
browser shows **no GraphQL timeline request at all**. Confirmed by driving a real browser and
capturing the network: scrolling a profile fired no timeline call.

Two extraction patterns are needed because X is mid-migration:

```js
// legacy webpack bundle
queryId:"SXVCYB8XHSS25nzIljNtZA",operationName:"UserTweets"

// newer Relay persisted queries
params:{id:`frIPQPuTi1WBHmfe-hRyrA`,metadata:{},name:`intentFollowUserByScreenNameQuery`}
```

The resolver reads `/home`, mines `main.*.js`, and both patterns are implemented so a migration of
the timeline operations into the Relay build is already handled.

A production run confirms the live path is the one being used:

```
INFO  Resolved X query IDs {"source":"live-bundle","operations":104}
```

### Note on browsers

A real browser was used **for reconnaissance only** — the equivalent of opening DevTools by hand.
It established that the profile route is server-rendered and revealed the `x-web` bundle layout.
No browser is present anywhere in the Actor's data path, which is plain HTTP end to end.

---

## 6. The two live user schemas

X is mid-migration on the user object, and which shape you get depends on the query ID:

| Field | Older query IDs | Current query IDs |
|---|---|---|
| `user.legacy` | populated | **`null`** |
| `screen_name`, `name` | `legacy.*` | `core.*` |
| followers / following | `legacy.followers_count` / `friends_count` | `relationship_counts.followers` / `.following` |
| verified | `legacy.verified` | `verification.verified` |

The **tweet** object keeps `legacy` in both — only the user object split. The normalizer reads
through an ordered candidate list per field, and captured responses of both shapes are committed as
fixtures with the same assertions run against each.

### A bug this surfaced

`verified` was initially read from `verified` and `is_blue_verified` alone. Both are `false` for
Business (gold) and Government (grey) accounts, which nonetheless display a checkmark — `@apify` is
exactly that case and came out unverified, so an `onlyVerified` run would have silently dropped it.
`verification.verified_type` is now consulted too.

---

## 7. Rate limits (per guest token, per window)

Read from `x-rate-limit-limit` on live responses. No public source documents these for guest
tokens specifically.

| Operation | Limit |
|---|---|
| `TweetResultByRestId` | 500 |
| `UserByScreenName` | 150 |
| `UserTweets` | **50** |

`UserTweets` at 50 is the binding constraint on the whole design. At 40 tweets per page, one token
is worth roughly 2,000 tweets — which is why the pool rotates tokens rather than reusing one, and
why concurrency is applied across handles rather than within a single timeline.

---

## 8. Reproducing this

```bash
python3 scripts/probe.py    # broad sweep: old vs current IDs, response shapes
python3 scripts/probe2.py   # definitive test, each op sent its own declared contract
```

Both write raw responses and per-operation verdicts to disk. They need no credentials — only a
guest token, which they acquire themselves.
