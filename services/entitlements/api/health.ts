/**
 * Liveness probe.
 *
 * Reports whether the service is configured without revealing anything about
 * the configuration itself — the README references this endpoint so the
 * entitlements design can be demonstrated without handing out the secret or
 * the allow-list.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export default function handler(_request: IncomingMessage, response: ServerResponse): void {
    const configured =
        typeof process.env['ENTITLEMENTS_SECRET'] === 'string' &&
        process.env['ENTITLEMENTS_SECRET'].length > 0;

    response.writeHead(configured ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
    });
    response.end(
        JSON.stringify({
            service: 'x-tweet-scraper-entitlements',
            configured,
            entitledUsers: readAllowListSize(),
        }),
    );
}

/** Count only — the IDs themselves are not disclosed. */
function readAllowListSize(): number {
    const raw = process.env['ENTITLED_USER_IDS'];
    if (raw === undefined || raw.trim().length === 0) return 0;
    return raw.split(',').filter((entry) => entry.trim().length > 0).length;
}
