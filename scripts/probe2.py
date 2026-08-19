#!/usr/bin/env python3
"""Definitive guest-reachability test.

Builds each request from the operation's OWN declared contract (queryId,
featureSwitches, fieldToggles) as published by the daily-regenerated
fa0311/TwitterInternalAPIDocument dump, so a failure cannot be blamed on a
missing feature flag or a rotated id. Whatever remains is the auth boundary.
"""

from __future__ import annotations

import json
import pathlib

from probe import BEARER, UA, gql, guest_token, http  # reuse verified plumbing

HERE = pathlib.Path(__file__).parent
OUT = HERE / "probe2-results"
OUT.mkdir(exist_ok=True)

OPS = json.loads((HERE / "ops-current.json").read_text())

APIFY_UID = "3510729917"
REAL_TWEET = "2087572956683567110"

# Sensible defaults for every switch/toggle X might demand. Booleans only; the
# point is completeness, not tuning.
FEATURE_DEFAULT = {
    "rweb_video_screen_enabled": False,
    "payments_enabled": False,
    "rweb_xchat_enabled": False,
    "profile_label_improvements_pcf_label_in_post_enabled": True,
    "responsive_web_profile_redirect_enabled": False,
    "rweb_tipjar_consumption_enabled": True,
    "verified_phone_label_enabled": False,
    "premium_content_api_read_enabled": False,
    "responsive_web_grok_analyze_button_fetch_trends_enabled": False,
    "responsive_web_grok_analyze_post_followups_enabled": True,
    "responsive_web_grok_share_attachment_enabled": True,
    "responsive_web_grok_show_grok_translated_post": False,
    "responsive_web_grok_community_note_auto_translation_is_enabled": False,
    "responsive_web_grok_imagine_annotation_enabled": True,
    "responsive_web_grok_annotations_enabled": True,
    "tweet_awards_web_tipping_enabled": False,
    "responsive_web_enhance_cards_enabled": False,
    "creator_subscriptions_quote_tweet_preview_enabled": False,
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
}

TOGGLE_DEFAULT = {
    "withPayments": False,
    "withAuxiliaryUserLabels": True,
    "withArticleRichContentState": True,
    "withArticlePlainText": False,
    "withArticleSummaryText": False,
    "withArticleVoiceOver": False,
    "withGrokAnalyze": False,
    "withDisallowedReplyControls": False,
}

VARIABLES = {
    "SearchTimeline": {"rawQuery": "apify", "count": 20, "querySource": "typed_query",
                       "product": "Latest", "withGrokTranslatedBio": False},
    "UserTweets": {"userId": APIFY_UID, "count": 20, "includePromotedContent": False,
                   "withQuickPromoteEligibilityTweetFields": False, "withVoice": True},
    "UserByScreenName": {"screen_name": "apify", "withGrokTranslatedBio": False},
    "TweetResultByRestId": {"tweetId": REAL_TWEET, "includePromotedContent": False,
                            "withBirdwatchNotes": True, "withVoice": True, "withCommunity": True},
    "UserTweetsAndReplies": {"userId": APIFY_UID, "count": 20, "includePromotedContent": False,
                             "withCommunity": True, "withVoice": True},
    "TweetDetail": {"focalTweetId": REAL_TWEET, "with_rux_injections": False,
                    "rankingMode": "Relevance", "includePromotedContent": False,
                    "withCommunity": True, "withQuickPromoteEligibilityTweetFields": False,
                    "withBirdwatchNotes": True, "withVoice": True},
}


def build(op_name: str) -> tuple[str, dict, dict, dict]:
    """Build the exact contract this operation declares for itself."""
    entry = OPS[op_name]
    md = entry.get("metadata") or {}
    features = {k: FEATURE_DEFAULT.get(k, True) for k in (md.get("featureSwitches") or [])}
    toggles = {k: TOGGLE_DEFAULT.get(k, False) for k in (md.get("fieldToggles") or [])}
    return entry["queryId"], VARIABLES[op_name], features, toggles


def verdict(status: int, body: str) -> str:
    if status == 200:
        doc = json.loads(body)
        if doc.get("data"):
            return "GUEST-REACHABLE"
        return f"200 but no data: {list(doc)}"
    if not body.strip():
        return f"HTTP {status}, EMPTY BODY"
    try:
        doc = json.loads(body)
    except Exception:  # noqa: BLE001
        return f"HTTP {status}, non-JSON ({len(body)}b): {body[:100]!r}"
    if "message" in doc:
        return f"HTTP {status}: {doc['message']}"
    errs = doc.get("errors") or []
    return f"HTTP {status} codes={[e.get('code') for e in errs]} {[(e.get('message') or '')[:70] for e in errs]}"


def main() -> None:
    gt = guest_token()
    print(f"guest_token: {gt}")
    print(f"{'OPERACION':<24} {'VEREDICTO':<52} RATE-LIMIT\n{'-'*100}")

    rows = []
    for op in ["UserByScreenName", "UserTweets", "TweetResultByRestId",
               "SearchTimeline", "UserTweetsAndReplies", "TweetDetail"]:
        qid, variables, features, toggles = build(op)
        status, headers, body = gql(gt, qid, op, variables, features, toggles)
        v = verdict(status, body)
        rl = headers.get("x-rate-limit-limit", "-")
        print(f"{op:<24} {v:<52} {rl}")
        (OUT / f"{op}.json").write_text(body)
        rows.append({"operation": op, "queryId": qid, "httpStatus": status, "verdict": v,
                     "rateLimitPerWindow": rl,
                     "featureSwitchesSent": len(features), "fieldTogglesSent": len(toggles)})

    # Control: a queryId that never existed, same machinery.
    status, _, body = gql(gt, "ZZZZneverExistedZZZZ", "UserTweets", VARIABLES["UserTweets"], {}, {})
    print(f"{'[control: fake id]':<24} {verdict(status, body):<52} -")
    rows.append({"operation": "[control] bogus queryId", "queryId": "ZZZZneverExistedZZZZ",
                 "httpStatus": status, "verdict": verdict(status, body)})

    (OUT / "verdicts.json").write_text(json.dumps(rows, indent=2))
    print(f"\nguardado en {OUT}/verdicts.json")


if __name__ == "__main__":
    main()
