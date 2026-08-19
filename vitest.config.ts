import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        // Deterministic: no test may depend on wall-clock ordering with another.
        sequence: { shuffle: false },
        coverage: {
            provider: 'v8',
            reportsDirectory: 'coverage',
            include: ['src/**/*.ts'],
            exclude: ['src/main.ts', 'src/**/types.ts'],
        },
    },
});
