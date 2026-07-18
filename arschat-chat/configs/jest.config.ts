import type { Config } from '@jest/types';

export default async (): Promise<Config.InitialOptions> => ({
    preset: 'ts-jest',
    testMatch: ['**.test.ts'],
    rootDir: '../',
    transform: {
        '^.+\\.(ts)$': 'ts-jest',
    },
    testEnvironment: 'jsdom',
    setupFiles: ['<rootDir>/configs/jest-setup.js'],
    // jest resolves to the ESM variant of these packages, breaking the tests
    // by forcing the resolve via Node, the commonjs variant is used
    moduleNameMapper: {
        '^vscode-languageserver-types': require.resolve('vscode-languageserver-types'),
        '^msgpackr': require.resolve('msgpackr'),
        // ToolConfirmationManager (browser) transitively pulls @theia/core's browser
        // DOM tree, which jest can't transform. The widget only needs it as a DI
        // token, so stub it for tests (M5 e-3).
        '@theia/ai-chat/lib/browser/chat-tool-preference-bindings':
            '<rootDir>/configs/stubs/chat-tool-preference-bindings.js',
        // TerminalFrontendContribution also pulls the full Theia browser shell and
        // CSS. The widget only needs TerminalCommands.TOGGLE_TERMINAL.id in unit
        // tests, so keep this as a command-id stub (M11).
        '@theia/terminal/lib/browser/terminal-frontend-contribution':
            '<rootDir>/configs/stubs/terminal-frontend-contribution.js',
        // ApplicationShell is only a DI token in widget tests. Loading Theia's
        // browser barrel pulls shell/status-bar CSS, so stub the exact barrel
        // import while leaving browser subpaths (ReactWidget etc.) untouched.
        '@theia/core/lib/browser$':
            '<rootDir>/configs/stubs/application-shell.js',
    }
});
