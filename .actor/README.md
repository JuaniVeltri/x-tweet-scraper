![X (Twitter) GraphQL Tweet Scraper](https://raw.githubusercontent.com/JuaniVeltri/x-tweet-scraper/main/docs/assets/banner.png)

# X (Twitter) Tweet Scraper — browserless

Collects public posts from X over its internal GraphQL API using **HTTP requests only**. No headless browser is involved anywhere in the data path, which is why it is fast and cheap to run: **100 tweets in a median of 11.7 seconds**, at roughly **$0.035 per 1,000 results**.

Give it handles, tweet IDs or topic terms. Every result comes back in the same fixed schema.

## What you can scrape

| Target | What you get |
| --- | --- |
| `fromUsers` | Recent tweets from each handle's timeline |
| `tweetIds` | Specific tweets, fully hydrated |
| `searchTerms` | Tweets on a topic, found through profile discovery (see below) |

Then narrow the results with filters: hashtags, a date window, language, engagement floors, verified-only, media type, and whether replies and retweets count.

## Example input

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
  "proxyConfiguration": { "useApifyProxy": true }
}
```

Filters combine with AND. A field you leave out means "no constraint".

## Example output

Every dataset item has the same shape. Missing values are `null` — never absent, never `undefined` — and IDs are strings, because X's IDs are larger than JavaScript can hold as numbers.

```json
{
  "id": "2087572956683567110",
  "url": "https://x.com/apify/status/2087572956683567110",
  "text": "Everything runs on Apify. One day. San Francisco.",
  "lang": "en",
  "createdAt": "2026-08-12T16:12:32.000Z",
  "conversationId": "2087572956683567110",
  "isReply": false,
  "isRetweet": false,
  "isQuote": false,
  "inReplyToId": null,
  "quotedTweetId": null,
  "author": {
    "id": "3510729917",
    "username": "apify",
    "name": "Apify",
    "verified": true,
    "followers": 12047,
    "following": 296
  },
  "metrics": {
    "likes": 17,
    "retweets": 4,
    "replies": 2,
    "quotes": 0,
    "bookmarks": 1,
    "views": 2332
  },
  "entities": {
    "hashtags": [],
    "mentions": [],
    "urls": ["http://apify.it/X054l"],
    "media": [
      {
        "type": "photo",
        "url": "https://pbs.twimg.com/media/HPiMidvXgAEpJ53.jpg",
        "thumbnail": null
      }
    ]
  },
  "source": "Agorapulse app",
  "scrapedAt": "2026-08-19T01:51:12.965Z"
}
```

`t.co` shortlinks are expanded in `text`, and `source` is stripped down to the client name.

## Free tier

Free runs return **up to 10 items**. That limit is enforced on the server, so raising `maxResults` will not lift it — a capped run stops fetching at 10 rather than collecting more and discarding it.

The run's `OUTPUT` record always says which happened:

```json
{ "limited": true, "reason": "free_tier", "cap": 10 }
```

## How topic search works

X's own search endpoint is closed to anonymous clients. Rather than pretend otherwise, `searchTerms` takes a different route: a public search engine is asked which X profiles rank for your topic, those profiles' timelines are read through the path that does work, and only tweets that actually mention the term are kept.

**This is not an exhaustive index.** It returns tweets from accounts that rank for a topic — a matching tweet from an account no search engine surfaced will not appear. For complete coverage of a specific account, use `fromUsers`.

## Reliability

- **Guest-token rotation.** Tokens are pooled, rotated least-recently-used, and retired the moment X rejects one.
- **Query IDs resolved at runtime** from X's own JavaScript bundle, so the Actor keeps working when X rotates them.
- **Exponential backoff with full jitter**, honouring `retry-after`, so a single 429 costs a retry rather than the run.
- **Resumable.** If the platform migrates your run mid-flight, it picks up from its cursor instead of starting over and re-emitting.
- **No duplicates**, including across overlapping targets.
- **Protected, suspended and deleted accounts** are reported and skipped, not treated as failures.

## Proxy

Works with Apify Proxy, including residential groups and country selection, through the standard `proxyConfiguration` input.

## Finish webhook

Set `webhookUrl` and the run summary — counts, timing, error tallies, whether the cap applied — is POSTed there when the run finishes. Delivery failures are logged and never fail the run.

## A note on responsible use

This Actor reads **public data only** — what any logged-out visitor can see. It never logs in, and no personal or purchased credential is involved.

These are X's undocumented internal endpoints, not a supported product, and automated access sits in tension with X's Terms of Service. Before running this commercially you should take your own view on that, and prefer X's paid API where the budget allows. Tweets and profiles are personal data under GDPR even when public, so a production deployment needs a lawful basis and a retention policy.

## Source

Fully open source, including the free-tier design and the investigation behind which endpoints are reachable without a login:

**https://github.com/JuaniVeltri/x-tweet-scraper**
