/**
 * Failure classification — the core of the retry policy (assessment §7).
 *
 * Every failed request is sorted into exactly one {@link FailureKind}, and that
 * verdict alone decides what happens next. Getting a verdict wrong is expensive
 * in both directions: retrying something that can never succeed burns the rate
 * limit for nothing, and giving up on something transient loses the run.
 *
 * The three-way split on 404 is the part worth pinning hardest. It came from
 * probing the live API (see `docs/INVESTIGATION.md`) and it is the difference
 * between concluding the task is impossible and finding the door that is open.
 */

import { describe, expect, it } from 'vitest';

import { classifyFailure, extractApiCodes, describeError, XApiError } from '../src/util/errors.js';

describe('the three meanings of 404', () => {
    it('reads an empty body as the guest auth wall', () => {
        // X resolved the operation, metered it against its own rate-limit
        // bucket, and declined to serve it. Retrying cannot help.
        expect(classifyFailure(404, '', [])).toBe('auth-walled');
        expect(classifyFailure(404, '   \n  ', [])).toBe('auth-walled');
    });

    it('reads "Query not found" as a rotated query ID', () => {
        // X is saying the operation is unknown *at that ID* — a different claim
        // entirely from refusing to serve it.
        expect(classifyFailure(404, '{"message":"Query not found"}', [])).toBe(
            'refresh-query-id',
        );
    });

    it('refuses to guess about any other 404', () => {
        expect(classifyFailure(404, '{"message":"something else"}', [])).toBe('fatal');
    });

    it('keeps the two apart even though both are 404', () => {
        // This is the whole finding in one assertion.
        expect(classifyFailure(404, '', [])).not.toBe(
            classifyFailure(404, '{"message":"Query not found"}', []),
        );
    });
});

describe('token-death codes rotate rather than retry', () => {
    it.each([
        [89, 'expired token'],
        [239, 'bad token'],
        [326, 'account locked'],
    ])('code %i (%s) retires the guest token', (code) => {
        expect(classifyFailure(200, '', [code])).toBe('rotate-token');
    });

    it('rotates on a bare 401 or 403, since the token may simply be stale', () => {
        // Worth one rotation rather than failing the whole run.
        expect(classifyFailure(401, '', [])).toBe('rotate-token');
        expect(classifyFailure(403, '', [])).toBe('rotate-token');
    });

    it('prefers rotation over backoff when a dead token also carries a 403', () => {
        expect(classifyFailure(403, '', [89])).toBe('rotate-token');
    });
});

describe('transient failures back off', () => {
    it('treats 429 as retryable', () => {
        expect(classifyFailure(429, '', [])).toBe('retryable');
    });

    it('treats X error code 88 as retryable, since it is rate limiting by another name', () => {
        expect(classifyFailure(200, '', [88])).toBe('retryable');
    });

    it.each([500, 502, 503, 504])('treats %i as retryable', (status) => {
        expect(classifyFailure(status, '', [])).toBe('retryable');
    });

    it('does not treat a 4xx that is not 401/403/404/429 as retryable', () => {
        expect(classifyFailure(400, '{"errors":[]}', [])).toBe('fatal');
        expect(classifyFailure(422, '{"errors":[]}', [])).toBe('fatal');
    });
});

describe('extractApiCodes', () => {
    it('pulls numeric codes out of a GraphQL error envelope', () => {
        expect(extractApiCodes('{"errors":[{"code":88,"message":"Rate limit"}]}')).toEqual([88]);
    });

    it('collects several', () => {
        expect(extractApiCodes('{"errors":[{"code":89},{"code":326}]}')).toEqual([89, 326]);
    });

    it('returns nothing rather than throwing on anything unexpected', () => {
        // A parser that throws here would turn a recoverable failure into a crash.
        for (const body of ['', 'not json', 'null', '[]', '{}', '{"errors":"nope"}',
                            '{"errors":[{"noCode":1}]}', '{"errors":[{"code":"88"}]}']) {
            expect(extractApiCodes(body)).toEqual([]);
        }
    });
});

describe('XApiError carries what the caller needs to react', () => {
    it('keeps the verdict and the evidence together', () => {
        const error = new XApiError('SearchTimeline is walled', {
            operation: 'SearchTimeline',
            httpStatus: 404,
            apiCodes: [],
            kind: 'auth-walled',
            bodyPreview: '',
        });
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('XApiError');
        expect(error.detail.kind).toBe('auth-walled');
        expect(error.detail.operation).toBe('SearchTimeline');
    });
});

describe('describeError', () => {
    it('names an Error by type and message', () => {
        expect(describeError(new TypeError('boom'))).toBe('TypeError: boom');
    });

    it('stringifies anything else rather than throwing', () => {
        expect(describeError('plain string')).toBe('plain string');
        expect(describeError(null)).toBe('null');
        expect(describeError(42)).toBe('42');
    });
});
