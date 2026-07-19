import type { Config } from '@jest/types';

export default async (): Promise<Config.InitialOptions> => ({
    preset: 'ts-jest',
    testMatch: ['**.test.ts'],
    rootDir: '../',
    transform: {
        '^.+\\.(ts)$': 'ts-jest',
    },
    testEnvironment: 'node',
    setupFiles: ['<rootDir>/configs/jest-setup.js'],
    moduleNameMapper: {
        '^vscode-languageserver-types': require.resolve('vscode-languageserver-types'),
        '^msgpackr': require.resolve('msgpackr'),
    },
});
