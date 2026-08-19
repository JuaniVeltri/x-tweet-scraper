/**
 * Contract drift guard.
 *
 * `.actor/dataset_schema.json` publishes the output contract to consumers and
 * to the Apify UI. The normalizer produces it. Nothing mechanically ties the
 * two together, so this file does: it validates real normalized tweets against
 * the declared schema and fails if either side moves without the other.
 *
 * Without this, the most likely failure is silent — a field added to the
 * normalizer never reaches the published schema, and clients build against
 * documentation that no longer describes what they receive.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { normalizeTweet } from '../src/normalize/tweet.js';
import { walkTimeline } from '../src/normalize/timeline.js';
import type { OutputTweet } from '../src/output/types.js';

interface JsonSchema {
    readonly type?: string | readonly string[];
    readonly properties?: Readonly<Record<string, JsonSchema>>;
    readonly required?: readonly string[];
    readonly items?: JsonSchema;
    readonly enum?: readonly unknown[];
}

function load(path: string): unknown {
    return JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'));
}

const datasetSchema = load('../.actor/dataset_schema.json') as {
    actorSpecification: number;
    fields: JsonSchema;
    views: Record<string, unknown>;
};

/** Normalized tweets from both of X's live user schemas. */
const tweets: OutputTweet[] = [
    'user-tweets.legacy-schema.json',
    'user-tweets.core-schema.json',
].flatMap((file) => {
    const body = load(`./fixtures/${file}`) as { data?: unknown };
    return walkTimeline(body.data)
        .tweets.map((raw) => normalizeTweet(raw))
        .filter((tweet): tweet is OutputTweet => tweet !== null);
});

/** Minimal JSON Schema check covering the subset this contract uses. */
function validate(value: unknown, schema: JsonSchema, path = '$'): string[] {
    const errors: string[] = [];
    const types: readonly string[] =
        schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];

    if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
        return [`${path}: expected ${types.join('|')}, got ${typeName(value)}`];
    }
    if (schema.enum !== undefined && !schema.enum.includes(value)) {
        errors.push(`${path}: ${String(value)} is not one of ${schema.enum.join('|')}`);
    }

    if (types.includes('object') && typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>;
        for (const key of schema.required ?? []) {
            if (!Object.hasOwn(record, key)) errors.push(`${path}.${key}: missing`);
        }
        for (const [key, sub] of Object.entries(schema.properties ?? {})) {
            if (Object.hasOwn(record, key)) {
                errors.push(...validate(record[key], sub, `${path}.${key}`));
            }
        }
    }

    if (Array.isArray(value) && schema.items !== undefined) {
        value.forEach((entry, i) => {
            errors.push(...validate(entry, schema.items!, `${path}[${i}]`));
        });
    }

    return errors;
}

function matchesType(value: unknown, type: string): boolean {
    switch (type) {
        case 'null':
            return value === null;
        case 'array':
            return Array.isArray(value);
        case 'object':
            return typeof value === 'object' && value !== null && !Array.isArray(value);
        case 'number':
            return typeof value === 'number';
        case 'string':
            return typeof value === 'string';
        case 'boolean':
            return typeof value === 'boolean';
        default:
            return false;
    }
}

function typeName(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

describe('.actor/dataset_schema.json', () => {
    it('declares the current spec version and at least one view', () => {
        expect(datasetSchema.actorSpecification).toBe(1);
        expect(Object.keys(datasetSchema.views).length).toBeGreaterThan(0);
    });

    it('has fixtures to validate against', () => {
        expect(tweets.length).toBeGreaterThan(0);
    });

    it('validates every normalized tweet', () => {
        const failures = tweets.flatMap((tweet) => validate(tweet, datasetSchema.fields));
        expect(failures).toEqual([]);
    });

    it('requires every key the normalizer emits, so none can be dropped silently', () => {
        const required = new Set(datasetSchema.fields.required ?? []);
        for (const tweet of tweets) {
            for (const key of Object.keys(tweet)) {
                expect(required.has(key), `"${key}" is emitted but not required`).toBe(true);
            }
        }
    });

    it('declares no field the normalizer never emits', () => {
        const declared = Object.keys(datasetSchema.fields.properties ?? {});
        const emitted = new Set(tweets.flatMap((tweet) => Object.keys(tweet)));
        for (const key of declared) {
            expect(emitted.has(key), `"${key}" is declared but never emitted`).toBe(true);
        }
    });

    it('keeps nested object contracts in step with the normalizer', () => {
        const first = tweets[0];
        expect(first).toBeDefined();
        for (const group of ['author', 'metrics', 'entities'] as const) {
            const declared = Object.keys(
                datasetSchema.fields.properties?.[group]?.properties ?? {},
            ).sort();
            const actual = Object.keys(first![group]).sort();
            expect(declared, `${group} drifted`).toEqual(actual);
        }
    });

    it('only references fields that exist, in every view', () => {
        for (const [name, raw] of Object.entries(datasetSchema.views)) {
            const view = raw as { transformation?: { fields?: string[] } };
            for (const field of view.transformation?.fields ?? []) {
                // Views flatten nested objects, so a dotted path is a real path.
                const [head, tail] = field.split('.');
                expect(
                    Object.hasOwn(datasetSchema.fields.properties ?? {}, head ?? ''),
                    `view "${name}" references unknown field "${field}"`,
                ).toBe(true);
                if (tail !== undefined) {
                    const nested = datasetSchema.fields.properties?.[head!]?.properties ?? {};
                    expect(
                        Object.hasOwn(nested, tail),
                        `view "${name}" references unknown field "${field}"`,
                    ).toBe(true);
                }
            }
        }
    });
});
