/**
 * Input contract (assessment §4), declared once with zod and mirrored by
 * `.actor/INPUT_SCHEMA.json` for the Apify UI.
 *
 * Unknown keys are stripped rather than rejected: the Apify platform is free to
 * add fields to a run's input, and — critically — no undocumented field can
 * influence the result cap anyway, because the cap is never read from input
 * (see `src/entitlements/resolver.ts`).
 */

import { z } from 'zod';

/** X handles: 1–15 chars, letters/digits/underscore. A leading `@` is tolerated. */
const handle = z
    .string()
    .trim()
    .transform((value) => value.replace(/^@/, ''))
    .refine((value) => /^[A-Za-z0-9_]{1,15}$/.test(value), {
        message:
            'must be an X handle: 1-15 characters, letters, digits or underscore, without "@"',
    });

/** Tweet IDs are numeric strings; they exceed the safe integer range as numbers. */
const tweetId = z
    .string()
    .trim()
    .refine((value) => /^\d{1,25}$/.test(value), {
        message: 'must be a numeric tweet ID, e.g. "1878961234567890123"',
    });

/** Hashtags are compared case-insensitively, so they are lowercased up front. */
const hashtag = z
    .string()
    .trim()
    .transform((value) => value.replace(/^#/, '').toLowerCase())
    .refine((value) => value.length > 0, { message: 'must not be empty' });

const isoDate = z.union([
    z.iso.date(),
    z.iso.datetime({ offset: true }),
    z.iso.datetime(),
]);

export const MEDIA_TYPES = ['any', 'text_only', 'images', 'video', 'links'] as const;
export const SORT_MODES = ['latest', 'top'] as const;

export const inputSchema = z.object({
    // --- targets -----------------------------------------------------------
    fromUsers: z.array(handle).optional(),
    tweetIds: z.array(tweetId).optional(),
    /**
     * Accepted by the schema so that the run can fail with a purposeful message
     * (§4: "validate and reject clearly rather than silently returning
     * nothing"). Rejection happens in `parse.ts`, not here, so the error can
     * explain *why* rather than just flagging a bad field.
     */
    searchTerms: z.array(z.string().trim().min(1)).optional(),

    // --- filters -----------------------------------------------------------
    hashtags: z.array(hashtag).optional(),
    since: isoDate.optional(),
    until: isoDate.optional(),
    language: z
        .string()
        .trim()
        .toLowerCase()
        .refine((value) => /^[a-z]{2,3}$/.test(value), {
            message: 'must be an ISO-639-1 language code, e.g. "en"',
        })
        .optional(),
    minLikes: z.int().min(0).optional(),
    minRetweets: z.int().min(0).optional(),
    minReplies: z.int().min(0).optional(),
    onlyVerified: z.boolean().default(false),
    mediaType: z.enum(MEDIA_TYPES).default('any'),
    includeReplies: z.boolean().default(false),
    includeRetweets: z.boolean().default(false),
    sortBy: z.enum(SORT_MODES).default('latest'),

    /**
     * A *request*, not a guarantee. The effective cap is
     * `min(maxResults, entitlement.cap)` and is resolved server-side; raising
     * this value cannot lift the free-tier cap.
     */
    maxResults: z.int().min(1).max(1_000_000).default(100),

    // --- platform ----------------------------------------------------------
    proxyConfiguration: z
        .object({
            useApifyProxy: z.boolean().optional(),
            apifyProxyGroups: z.array(z.string()).optional(),
            apifyProxyCountry: z.string().optional(),
            proxyUrls: z.array(z.string()).optional(),
        })
        .optional(),
});

/** Raw shape as it arrives, before cross-field validation. */
export type RawInput = z.infer<typeof inputSchema>;

/** Validated, normalized input. Targets are guaranteed non-empty arrays. */
export interface ScraperInput extends Omit<RawInput, 'fromUsers' | 'tweetIds' | 'searchTerms'> {
    readonly fromUsers: readonly string[];
    readonly tweetIds: readonly string[];
}
