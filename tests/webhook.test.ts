/**
 * Finish-webhook target validation (assessment §11 bonus).
 *
 * The URL comes from run input and an Actor is a server-side HTTP client with
 * network positions a caller does not have — a cloud metadata endpoint, a
 * service on the container's loopback, a private range. Posting a run summary
 * to an arbitrary caller-supplied address is a textbook SSRF, so the target is
 * validated before anything is sent.
 */

import { describe, expect, it } from 'vitest';

import { resolveWebhookTarget } from '../src/pipeline/webhook.js';

describe('resolveWebhookTarget', () => {
    it('accepts ordinary https and http endpoints', () => {
        for (const url of [
            'https://example.com/hooks/run-finished',
            'http://example.com:8080/hook?token=abc',
            'https://hooks.slack.com/services/T000/B000/XXXX',
        ]) {
            expect(resolveWebhookTarget(url)).toEqual({ ok: true, url: expect.any(String) });
        }
    });

    it('rejects anything that is not a URL', () => {
        for (const url of ['', 'not a url', '://missing-scheme', 'example.com']) {
            expect(resolveWebhookTarget(url)).toEqual({ ok: false, reason: 'invalid-url' });
        }
    });

    it('rejects schemes that are not http(s)', () => {
        for (const url of [
            'file:///etc/passwd',
            'ftp://example.com/x',
            'gopher://example.com',
            'javascript:alert(1)',
        ]) {
            expect(resolveWebhookTarget(url)).toEqual({
                ok: false,
                reason: 'unsupported-scheme',
            });
        }
    });

    it('refuses loopback targets', () => {
        for (const url of [
            'http://localhost:3000/hook',
            'http://127.0.0.1/hook',
            'http://127.0.0.53/hook',
            'http://0.0.0.0/hook',
            'http://app.localhost/hook',
        ]) {
            expect(resolveWebhookTarget(url)).toEqual({ ok: false, reason: 'blocked-host' });
        }
    });

    it('refuses cloud instance metadata, the classic SSRF target', () => {
        for (const url of [
            'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
            'http://metadata.google.internal/computeMetadata/v1/',
        ]) {
            expect(resolveWebhookTarget(url)).toEqual({ ok: false, reason: 'blocked-host' });
        }
    });

    it('refuses the link-local range generally, not just the metadata IP', () => {
        expect(resolveWebhookTarget('http://169.254.1.1/x')).toEqual({
            ok: false,
            reason: 'blocked-host',
        });
    });

    it('is case-insensitive about the host', () => {
        expect(resolveWebhookTarget('http://LOCALHOST/hook')).toEqual({
            ok: false,
            reason: 'blocked-host',
        });
    });
});
