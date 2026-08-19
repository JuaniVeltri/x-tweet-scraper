/**
 * Finish-webhook delivery (assessment §11).
 *
 * The one rule that matters: this fires after the dataset and the OUTPUT record
 * are already durable, so nothing it does may fail the run. A webhook that
 * turned an unreachable endpoint into a failed run would destroy real work over
 * a notification.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HttpRequest, HttpResponse } from '../src/x/http.js';
import type { RunSummary } from '../src/output/types.js';

const performRequest = vi.fn<(request: HttpRequest) => Promise<HttpResponse>>();

vi.mock('../src/x/http.js', () => ({ performRequest: (r: HttpRequest) => performRequest(r) }));
vi.mock('apify', () => ({
    log: { info: vi.fn(), warning: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { postRunSummary } = await import('../src/pipeline/webhook.js');

const SUMMARY: RunSummary = {
    requested: 100, fetched: 107, pushed: 100,
    limited: false, reason: null, cap: 100, tier: 'paid',
    errors: { retryable: 0, fatal: 0 },
    targets: {
        users: 1, tweetIds: 0, searchTerms: 0,
        discoveredHandles: 0, discoveryEngine: null,
    },
    startedAt: '2026-08-19T04:00:00.000Z',
    finishedAt: '2026-08-19T04:00:11.700Z',
    durationMs: 11_700,
};

beforeEach(() => {
    performRequest.mockReset();
});

describe('delivery', () => {
    it('POSTs the summary as JSON', async () => {
        performRequest.mockResolvedValue({ statusCode: 200, body: 'ok', headers: {} });

        const delivered = await postRunSummary('https://hooks.example.com/x', SUMMARY, 'run-1');

        expect(delivered).toBe(true);
        const sent = performRequest.mock.calls[0]?.[0];
        expect(sent?.method).toBe('POST');
        expect(sent?.headers?.['content-type']).toBe('application/json');

        const body = JSON.parse(sent?.body ?? '{}') as Record<string, unknown>;
        expect(body).toMatchObject({ event: 'run.finished', runId: 'run-1' });
        expect(body.summary).toMatchObject({ pushed: 100, tier: 'paid' });
    });

    it.each([200, 201, 202, 204])('treats %i as delivered', async (statusCode) => {
        performRequest.mockResolvedValue({ statusCode, body: '', headers: {} });
        await expect(postRunSummary('https://e.com/h', SUMMARY, null)).resolves.toBe(true);
    });

    it.each([400, 404, 500])('reports %i as not delivered, without throwing', async (statusCode) => {
        performRequest.mockResolvedValue({ statusCode, body: '', headers: {} });
        await expect(postRunSummary('https://e.com/h', SUMMARY, null)).resolves.toBe(false);
    });

    it('reports a transport failure as not delivered, without throwing', async () => {
        // The scrape already succeeded; a dead endpoint must cost a
        // notification, never the results.
        performRequest.mockRejectedValue(new Error('ECONNREFUSED'));
        await expect(postRunSummary('https://e.com/h', SUMMARY, null)).resolves.toBe(false);
    });
});

describe('an unsafe target is never contacted', () => {
    it.each([
        ['loopback', 'http://127.0.0.1/hook'],
        ['localhost', 'http://localhost:9200/hook'],
        ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
        ['a file URL', 'file:///etc/passwd'],
        ['not a URL at all', 'nonsense'],
    ])('refuses %s before sending anything', async (_label, url) => {
        // The URL comes from run input, and an Actor has network reach the
        // caller does not — this is a textbook SSRF vector.
        await expect(postRunSummary(url, SUMMARY, null)).resolves.toBe(false);
        expect(performRequest).not.toHaveBeenCalled();
    });
});
