#!/usr/bin/env python3
"""Probe X's internal GraphQL API with a guest token only.

Purpose: establish, with hard evidence, which operations are reachable without a
logged-in account. Distinguishes three outcomes that are easy to confuse:

  * 404 {"message":"Query not found"}  -> the queryId is dead (rotated), says
    NOTHING about auth.
  * 401/403 + errors[].code in {32,37,89,...} -> genuinely auth-walled.
  * 200 with data                      -> guest-reachable.
"""

from __future__ import annotations

import json
import pathlib
import ssl
import urllib.error
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).parent
OUT = HERE / "probe-results"
OUT.mkdir(exist_ok=True)

BEARER = (
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D"
    "1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
)
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
)
CTX = ssl.create_default_context()


def http(url: str, headers: dict[str, str], method: str = "GET", body: bytes | None = None):
    req = urllib.request.Request(url, headers=headers, method=method, data=body)
    try:
        with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
            return r.status, dict(r.headers), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return 0, {}, f"__TRANSPORT_ERROR__ {type(e).__name__}: {e}"


def guest_token() -> str:
    status, _, body = http(
        "https://api.x.com/1.1/guest/activate.json",
        {"authorization": f"Bearer {BEARER}", "user-agent": UA},
        method="POST",
        body=b"",
    )
    assert status == 200, f"activate.json failed: {status} {body[:200]}"
    return json.loads(body)["guest_token"]


# Feature sets captured from live x.com traffic (via the-convocation/twitter-scraper,
# which records real requests). Different operations demand different flags; X
# rejects a request naming any flag it wants but did not receive.
FEATURES_TIMELINE = {
    "rweb_video_screen_enabled": False,
    "profile_label_improvements_pcf_label_in_post_enabled": True,
    "responsive_web_profile_redirect_enabled": False,
    "rweb_tipjar_consumption_enabled": False,
    "verified_phone_label_enabled": False,
    "creator_subscriptions_tweet_preview_api_enabled": True,
    "responsive_web_graphql_timeline_navigation_enabled": True,
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
    "premium_content_api_read_enabled": False,
    "communities_web_enable_tweet_community_results_fetch": True,
    "c9s_tweet_anatomy_moderator_badge_enabled": True,
    "responsive_web_grok_analyze_button_fetch_trends_enabled": False,
    "responsive_web_grok_analyze_post_followups_enabled": True,
    "responsive_web_jetfuel_frame": True,
    "responsive_web_grok_share_attachment_enabled": True,
    "responsive_web_grok_annotations_enabled": True,
    "articles_preview_enabled": True,
    "responsive_web_edit_tweet_api_enabled": True,
    "graphql_is_translatable_rweb_tweet_is_translatable_enabled": True,
    "view_counts_everywhere_api_enabled": True,
    "longform_notetweets_consumption_enabled": True,
    "responsive_web_twitter_article_tweet_consumption_enabled": True,
    "tweet_awards_web_tipping_enabled": False,
    "responsive_web_grok_show_grok_translated_post": True,
    "responsive_web_grok_analysis_button_from_backend": True,
    "post_ctas_fetch_enabled": True,
    "freedom_of_speech_not_reach_fetch_enabled": True,
    "standardized_nudges_misinfo": True,
    "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": True,
    "longform_notetweets_rich_text_read_enabled": True,
    "longform_notetweets_inline_media_enabled": True,
    "responsive_web_grok_image_annotation_enabled": True,
    "responsive_web_grok_imagine_annotation_enabled": True,
    "responsive_web_grok_community_note_auto_translation_is_enabled": False,
    "responsive_web_enhance_cards_enabled": False,
}

FEATURES_PROFILE = {
    "hidden_profile_subscriptions_enabled": True,
    "profile_label_improvements_pcf_label_in_post_enabled": True,
    "responsive_web_profile_redirect_enabled": False,
    "rweb_tipjar_consumption_enabled": False,
    "verified_phone_label_enabled": False,
    "subscriptions_verification_info_is_identity_verified_enabled": True,
    "subscriptions_verification_info_verified_since_enabled": True,
    "highlights_tweets_tab_ui_enabled": True,
    "responsive_web_twitter_article_notes_tab_enabled": True,
    "subscriptions_feature_can_gift_premium": True,
    "creator_subscriptions_tweet_preview_api_enabled": True,
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
    "responsive_web_graphql_timeline_navigation_enabled": True,
}


def gql(gt: str, query_id: str, op: str, variables: dict, features: dict | None,
        field_toggles: dict | None = None):
    params = {"variables": json.dumps(variables, separators=(",", ":"))}
    if features is not None:
        params["features"] = json.dumps(features, separators=(",", ":"))
    if field_toggles is not None:
        params["fieldToggles"] = json.dumps(field_toggles, separators=(",", ":"))
    url = f"https://api.x.com/graphql/{query_id}/{op}?" + urllib.parse.urlencode(params)
    headers = {
        "authorization": f"Bearer {BEARER}",
        "x-guest-token": gt,
        "x-twitter-active-user": "yes",
        "x-twitter-client-language": "en",
        "content-type": "application/json",
        "user-agent": UA,
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "origin": "https://x.com",
        "referer": "https://x.com/",
    }
    return http(url, headers)


def classify(status: int, body: str) -> str:
    """Turn a raw response into an evidence-grade verdict."""
    if status == 0:
        return "TRANSPORT_ERROR"
    try:
        doc = json.loads(body)
    except Exception:  # noqa: BLE001
        return f"HTTP_{status}_NON_JSON"
    if status == 404 and doc.get("message") == "Query not found":
        return "DEAD_QUERY_ID"          # rotated; proves nothing about auth
    errs = doc.get("errors") or []
    if errs:
        codes = sorted({e.get("code") for e in errs if e.get("code") is not None})
        msgs = sorted({(e.get("message") or "")[:80] for e in errs})
        return f"HTTP_{status}_ERRORS codes={codes} msgs={msgs}"
    if status == 200 and doc.get("data"):
        return "OK_GUEST_REACHABLE"
    return f"HTTP_{status}_UNEXPECTED"


def save(name: str, status: int, headers: dict, body: str) -> None:
    (OUT / f"{name}.json").write_text(body)
    rate = {k: v for k, v in headers.items() if k.lower().startswith("x-rate-limit")}
    (OUT / f"{name}.meta.json").write_text(
        json.dumps({"status": status, "rateLimit": rate}, indent=2)
    )


def main() -> None:
    gt = guest_token()
    print(f"guest_token: {gt}\n")

    apify_uid = "3510729917"
    real_tweet = "2087572956683567110"
    results: list[tuple[str, str, str]] = []

    def run(label: str, qid: str, op: str, variables, features, toggles=None):
        status, headers, body = gql(gt, qid, op, variables, features, toggles)
        verdict = classify(status, body)
        save(label, status, headers, body)
        results.append((label, f"{op} ({qid})", verdict))
        rl = headers.get("x-rate-limit-remaining", "-")
        print(f"[{status:>3}] {verdict:<46} {op:<22} {qid}  rl_remaining={rl}")

    print("=== A. queryIds NUEVOS (nitter + fa0311 coinciden) ===")
    run("new-UserByScreenName", "Gb-d6r0vxPOADdG62OEBpQ", "UserByScreenName",
        {"screen_name": "apify", "withGrokTranslatedBio": False}, FEATURES_PROFILE,
        {"withPayments": False, "withAuxiliaryUserLabels": True})
    run("new-UserTweets", "SXVCYB8XHSS25nzIljNtZA", "UserTweets",
        {"userId": apify_uid, "count": 20, "includePromotedContent": False,
         "withQuickPromoteEligibilityTweetFields": False, "withVoice": True},
        FEATURES_TIMELINE, {"withArticlePlainText": False})
    run("new-TweetResultByRestId", "GZsN2Pc4knAoit6pXa4HSA", "TweetResultByRestId",
        {"tweetId": real_tweet, "includePromotedContent": False, "withBirdwatchNotes": True,
         "withVoice": True, "withCommunity": True},
        FEATURES_TIMELINE, {"withArticleRichContentState": True, "withArticlePlainText": False})

    print("\n=== B. queryIds VIEJOS (schema legacy, para fixture comparativa) ===")
    run("old-UserTweets", "HuTx74BxAnezK1gWvYY7zg", "UserTweets",
        {"userId": apify_uid, "count": 20, "includePromotedContent": False,
         "withQuickPromoteEligibilityTweetFields": False, "withVoice": False,
         "withV2Timeline": True}, FEATURES_TIMELINE)
    run("old-TweetResultByRestId", "Xl5pC_lBk_gcO2ItU39DQw", "TweetResultByRestId",
        {"tweetId": real_tweet, "withCommunity": False, "includePromotedContent": False,
         "withVoice": False}, FEATURES_TIMELINE)

    print("\n=== C. SearchTimeline — LA PRUEBA DEL MURO (§2a) ===")
    for qid in ["hyPfJYJ_XAtDYoslQc-Rgg", "BGd0T_j7oVwlW5U79tO_0A", "ML-n2SfAxx5S_9QMqNejbg"]:
        run(f"search-{qid[:10]}", qid, "SearchTimeline",
            {"rawQuery": "apify", "count": 20, "querySource": "typed_query",
             "product": "Latest", "withGrokTranslatedBio": False}, FEATURES_TIMELINE)

    print("\n=== D. Operaciones que se sospechan login-only ===")
    run("UserTweetsAndReplies", "qUpkZU6eN8MbtQb7rC_pYg", "UserTweetsAndReplies",
        {"userId": apify_uid, "count": 20, "includePromotedContent": False,
         "withCommunity": True, "withVoice": True}, FEATURES_TIMELINE,
        {"withArticlePlainText": False})
    run("TweetDetail", "XMOz5h24KAZ86qKffKTLdQ", "TweetDetail",
        {"focalTweetId": real_tweet, "with_rux_injections": False, "rankingMode": "Relevance",
         "includePromotedContent": False, "withCommunity": True,
         "withQuickPromoteEligibilityTweetFields": False, "withBirdwatchNotes": True,
         "withVoice": True}, FEATURES_TIMELINE,
        {"withArticleRichContentState": True, "withArticlePlainText": False,
         "withGrokAnalyze": False, "withDisallowedReplyControls": False})

    (OUT / "summary.json").write_text(json.dumps(
        [{"label": a, "op": b, "verdict": c} for a, b, c in results], indent=2))
    print(f"\nfixtures + meta guardados en {OUT}")


if __name__ == "__main__":
    main()
