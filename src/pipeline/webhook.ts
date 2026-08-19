/**
 * Finish webhook (assessment §11 bonus).
 *
 * Posts the run summary to a URL supplied in the input, so a caller can react
 * to a finished run without polling the Apify API.
 *
 * Two properties matter:
 *
 *   - **It can never fail the run.** The scrape has already succeeded and the
 *     data is already in the dataset by the time this fires. A webhook that
 *     turned an unreachable endpoint into a failed run would destroy real work
 *     over a notification.
 *   - **The destination is validated.** The URL comes from user input, and an
 *     Actor is a server-side HTTP client — so it is exactly the shape of thing
 *     that gets pointed at internal addresses. Only http/https is accepted, and
 *     obvious loopback and link-local targets are refused.
 */

import { log } from 'apify';

import { performRequest } from '../x/http.js';
import type { RunSummary } from '../output/types.js';

/** Hosts an Actor has no business posting to on a caller's behalf. */
const BLOCKED_HOSTNAMES = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    '0.0.0.0',
    // Cloud instance metadata — the classic SSRF target.
    '169.254.169.254',
    'metadata.google.internal',
]);

export type WebhookRejection = 'invalid-url' | 'unsupported-scheme' | 'blocked-host';

export type WebhookTarget =
    | { readonly ok: true; readonly url: string }
    | { readonly ok: false; readonly reason: WebhookRejection };

/** Validate a user-supplied webhook URL before anything is sent to it. */
export function resolveWebhookTarget(raw: string): WebhookTarget {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return { ok: false, reason: 'invalid-url' };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, reason: 'unsupported-scheme' };
    }

    const host = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost')) {
        return { ok: false, reason: 'blocked-host' };
    }
    // Link-local and loopback ranges, which no legitimate webhook uses.
    if (/^(127\.|169\.254\.)/.test(host)) {
        return { ok: false, reason: 'blocked-host' };
    }

    return { ok: true, url: parsed.toString() };
}

/**
 * POST the run summary. Resolves either way — never throws, never rejects.
 *
 * @returns Whether the summary was delivered, for the run log.
 */
export async function postRunSummary(
    webhookUrl: string,
    summary: RunSummary,
    runId: string | null,
): Promise<boolean> {
    const target = resolveWebhookTarget(webhookUrl);
    if (!target.ok) {
        log.warning('Skipping finish webhook', { reason: target.reason });
        return false;
    }

    const response = await performRequest({
        url: target.url,
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'user-agent': 'x-tweet-scraper/1.0 (+finish-webhook)',
        },
        timeoutMs: 10_000,
        body: JSON.stringify({
            event: 'run.finished',
            actor: 'x-tweet-scraper',
            runId,
            summary,
        }),
    }).catch((error: unknown) => {
        log.warning('Finish webhook could not be delivered', { error: String(error) });
        return null;
    });

    if (response === null) return false;

    const delivered = response.statusCode >= 200 && response.statusCode < 300;
    if (delivered) {
        log.info('Finish webhook delivered', { status: response.statusCode });
    } else {
        log.warning('Finish webhook returned a non-2xx', { status: response.statusCode });
    }
    return delivered;
}
