// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        // eslint.config.js is plain JS and sits outside the TypeScript project,
        // so type-aware rules cannot parse it.
        ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'storage/**', 'eslint.config.js'],
    },
    eslint.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                // tsconfig.test.json is the widest project: it covers src/,
                // tests/ and the vitest config, so type-aware rules apply
                // everywhere rather than only to the build inputs.
                project: ['./tsconfig.test.json'],
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // The assessment forbids `any` leaking through public boundaries.
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/explicit-module-boundary-types': 'error',
            '@typescript-eslint/consistent-type-imports': [
                'error',
                { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
            ],
            // X's GraphQL payloads are deeply optional; template expressions over
            // `unknown` are a real risk, so keep the strict checks but allow the
            // numeric/boolean cases that make log lines readable.
            '@typescript-eslint/restrict-template-expressions': [
                'error',
                { allowNumber: true, allowBoolean: true },
            ],
            // A leading underscore marks a binding that exists only to be
            // discarded — the rest-destructuring idiom for omitting a key.
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                    ignoreRestSiblings: true,
                },
            ],
            'no-console': 'error',
        },
    },
    {
        // Tests may reach into internals and use non-null assertions on
        // fixtures. Test doubles also legitimately implement async interfaces
        // synchronously, which is what `require-await` would otherwise flag.
        files: ['tests/**/*.ts'],
        rules: {
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/require-await': 'off',
        },
    },
);
