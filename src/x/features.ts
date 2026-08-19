/**
 * GraphQL feature switches and field toggles.
 *
 * Every X GraphQL operation declares a set of "feature switches" it expects the
 * client to send. Omit one and X rejects the whole request — it does not fall
 * back to a default. The set changes as X ships features, which makes a
 * hardcoded list a slow-motion outage.
 *
 * Two mechanisms keep this robust:
 *
 *  1. A superset default (below), taken from the switches the three target
 *     operations declared on 2026-08-19 and verified to return HTTP 200.
 *  2. Error-driven negotiation ({@link missingFeaturesFrom}). When X rejects a
 *     request because a switch is absent, it names the switch in the error
 *     message. We add it and retry, so a newly-introduced flag self-heals
 *     within one request instead of requiring a redeploy.
 *
 * Sending a superset is safe: X ignores switches an operation does not declare.
 */

/** Feature switches sent with every GraphQL request. */
export const DEFAULT_FEATURES: Readonly<Record<string, boolean>> = {
    articles_preview_enabled: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    communities_web_enable_tweet_community_results_fetch: true,
    content_disclosure_ai_generated_indicator_enabled: true,
    content_disclosure_indicator_enabled: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    freedom_of_speech_not_reach_fetch_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    hidden_profile_subscriptions_enabled: true,
    highlights_tweets_tab_ui_enabled: true,
    longform_notetweets_consumption_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    post_ctas_fetch_enabled: true,
    premium_content_api_read_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    responsive_web_enhance_cards_enabled: false,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_grok_analysis_button_from_backend: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    responsive_web_grok_annotations_enabled: true,
    responsive_web_grok_community_note_auto_translation_is_enabled: false,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_grok_imagine_annotation_enabled: true,
    responsive_web_grok_share_attachment_enabled: true,
    responsive_web_grok_show_grok_translated_post: false,
    responsive_web_jetfuel_frame: true,
    responsive_web_profile_redirect_enabled: false,
    responsive_web_twitter_article_notes_tab_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    rweb_cashtags_composer_attachment_enabled: true,
    rweb_cashtags_enabled: true,
    rweb_conversational_replies_downvote_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    rweb_video_screen_enabled: false,
    standardized_nudges_misinfo: true,
    subscriptions_feature_can_gift_premium: true,
    subscriptions_verification_info_is_identity_verified_enabled: true,
    subscriptions_verification_info_verified_since_enabled: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    verified_phone_label_enabled: false,
    view_counts_everywhere_api_enabled: true,
};

/**
 * Field toggles. Unlike feature switches these select *shape*, so the values
 * are chosen deliberately: article bodies and Grok analysis are not part of the
 * §5 output contract, and requesting them only inflates responses.
 */
export const DEFAULT_FIELD_TOGGLES: Readonly<Record<string, boolean>> = {
    withArticlePlainText: false,
    withArticleRichContentState: false,
    withArticleSummaryText: false,
    withArticleVoiceOver: false,
    withAuxiliaryUserLabels: true,
    withDisallowedReplyControls: false,
    withGrokAnalyze: false,
    withPayments: false,
};

/**
 * Feature switches X complained were missing.
 *
 * X phrases the rejection as e.g.
 * `The following features cannot be null: foo_enabled, bar_enabled`.
 *
 * @returns Switch names to add before retrying; empty when the error is
 *   unrelated to features.
 */
export function missingFeaturesFrom(errorBody: string): string[] {
    const names = new Set<string>();
    const pattern = /following features cannot be null:\s*([A-Za-z0-9_,\s]+)/g;
    for (const match of errorBody.matchAll(pattern)) {
        const list = match[1];
        if (list === undefined) continue;
        for (const raw of list.split(',')) {
            const name = raw.trim();
            if (/^[a-z0-9_]+$/i.test(name) && name.length > 0) names.add(name);
        }
    }
    return [...names];
}
