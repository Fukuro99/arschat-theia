// *****************************************************************************
// Tests for the pure legacy MCP config importer (M5 e-6).
//
// Fixtures cover every branch the receiving code (@theia/ai-mcp) cares about:
//   stdio / http / streamable-http / enabled:false / missing-fields, plus
//   duplicate names, description drop, empty maps, and malformed roots.
// *****************************************************************************

import {
    convertLegacyMCPConfig,
    mergeIntoExisting,
    TheiaLocalMCPServerValue,
    TheiaRemoteMCPServerValue,
    TheiaMCPServersPreference
} from './mcp-config-import';

describe('convertLegacyMCPConfig', () => {

    it('converts a stdio server to a local (command/args/env) entry', () => {
        const res = convertLegacyMCPConfig({
            servers: [{
                name: 'filesystem',
                type: 'stdio',
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/Users/takep'],
                env: {},
                url: '',
                headers: {},
                enabled: true,
                description: 'ファイル操作'
            }]
        });
        expect(res.importedCount).toBe(1);
        expect(res.warnings).toHaveLength(0);
        const fs = res.servers['filesystem'] as TheiaLocalMCPServerValue;
        expect(fs.command).toBe('npx');
        expect(fs.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', 'C:/Users/takep']);
        // empty env / url / headers must not leak into the preference
        expect(fs.env).toBeUndefined();
        expect((fs as unknown as Record<string, unknown>).serverUrl).toBeUndefined();
        expect(fs.autostart).toBeUndefined(); // enabled:true => default autostart
        // description drop is a note, not a warning
        expect(res.notes.some(n => n.name === 'filesystem' && /description/.test(n.reason))).toBe(true);
    });

    it('carries non-empty env through for a stdio server', () => {
        const res = convertLegacyMCPConfig({
            servers: [{ name: 'brave', type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { BRAVE_API_KEY: 'k' }, enabled: true }]
        });
        const v = res.servers['brave'] as TheiaLocalMCPServerValue;
        expect(v.env).toEqual({ BRAVE_API_KEY: 'k' });
    });

    it('converts an http server to a remote (serverUrl) entry', () => {
        const res = convertLegacyMCPConfig({
            servers: [{ name: 'remoteHttp', type: 'http', url: 'https://example.com/mcp', headers: { 'X-Api': 'v' }, enabled: true }]
        });
        expect(res.importedCount).toBe(1);
        const v = res.servers['remoteHttp'] as TheiaRemoteMCPServerValue;
        expect(v.serverUrl).toBe('https://example.com/mcp');
        expect(v.headers).toEqual({ 'X-Api': 'v' });
        expect((v as unknown as Record<string, unknown>).command).toBeUndefined();
    });

    it('converts a streamable-http server to a remote (serverUrl) entry', () => {
        const res = convertLegacyMCPConfig({
            servers: [{ name: 'resonitelink', type: 'streamable-http', url: 'http://127.0.0.1:7790/mcp', enabled: true }]
        });
        const v = res.servers['resonitelink'] as TheiaRemoteMCPServerValue;
        expect(v.serverUrl).toBe('http://127.0.0.1:7790/mcp');
        expect(v.headers).toBeUndefined();
    });

    it('maps enabled:false to autostart:false and records a note', () => {
        const res = convertLegacyMCPConfig({
            servers: [{ name: 'off', type: 'stdio', command: 'npx', enabled: false }]
        });
        expect(res.importedCount).toBe(1); // imported, not skipped
        const v = res.servers['off'] as TheiaLocalMCPServerValue;
        expect(v.autostart).toBe(false);
        expect(res.notes.some(n => n.name === 'off' && /autostart:false/.test(n.reason))).toBe(true);
    });

    it('skips a stdio server missing its command, with a reason', () => {
        const res = convertLegacyMCPConfig({
            servers: [{ name: 'broken', type: 'stdio', enabled: true }]
        });
        expect(res.importedCount).toBe(0);
        expect(res.servers['broken']).toBeUndefined();
        expect(res.warnings).toHaveLength(1);
        expect(res.warnings[0]).toMatchObject({ name: 'broken' });
        expect(res.warnings[0].reason).toMatch(/変換不能/);
    });

    it('skips an http server missing its url, with a reason', () => {
        const res = convertLegacyMCPConfig({
            servers: [{ name: 'nourl', type: 'streamable-http', enabled: true }]
        });
        expect(res.importedCount).toBe(0);
        expect(res.warnings[0].name).toBe('nourl');
    });

    it('skips a server with an empty name', () => {
        const res = convertLegacyMCPConfig({
            servers: [{ name: '  ', type: 'stdio', command: 'npx', enabled: true }]
        });
        expect(res.importedCount).toBe(0);
        expect(res.warnings[0].reason).toMatch(/name/);
    });

    it('falls back to field presence when type is unknown/missing', () => {
        const res = convertLegacyMCPConfig({
            servers: [
                { name: 'a', type: 'weird', command: 'npx', enabled: true },
                { name: 'b', command: undefined, url: 'https://h/mcp', enabled: true } as unknown as Record<string, unknown>
            ]
        });
        expect((res.servers['a'] as TheiaLocalMCPServerValue).command).toBe('npx');
        expect((res.servers['b'] as TheiaRemoteMCPServerValue).serverUrl).toBe('https://h/mcp');
    });

    it('keeps the first of duplicate names and warns on the second', () => {
        const res = convertLegacyMCPConfig({
            servers: [
                { name: 'dup', type: 'stdio', command: 'first', enabled: true },
                { name: 'dup', type: 'stdio', command: 'second', enabled: true }
            ]
        });
        expect(res.importedCount).toBe(1);
        expect((res.servers['dup'] as TheiaLocalMCPServerValue).command).toBe('first');
        expect(res.warnings.some(w => w.name === 'dup' && /同名/.test(w.reason))).toBe(true);
    });

    it('warns (not throws) on a malformed root without a servers array', () => {
        for (const bad of [undefined, null, {}, { servers: 'nope' }, 42]) {
            const res = convertLegacyMCPConfig(bad);
            expect(res.importedCount).toBe(0);
            expect(res.warnings).toHaveLength(1);
            expect(res.warnings[0].reason).toMatch(/servers/);
        }
    });

    it('converts the full 4-server current ArsChat fixture as expected', () => {
        // Mirrors the real %APPDATA%\ArsChat\arschat-data\mcp-config.json shape.
        const res = convertLegacyMCPConfig({
            servers: [
                { name: 'filesystem', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/Users/takep'], env: {}, url: '', headers: {}, enabled: true, description: 'd1' },
                { name: 'Atlassian', type: 'stdio', command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.atlassian.com/v1/mcp'], env: {}, url: '', headers: {}, enabled: true, description: 'd2' },
                { name: 'discord', description: '', type: 'stdio', command: 'npx', args: ['mcp-remote', 'https://ringleted-perceptional-kimberli.ngrok-free.dev/mcp'], env: {}, url: '', headers: {}, enabled: true },
                { name: 'resonitelink', description: 'Resonite ワールド操作ツール', type: 'streamable-http', url: 'http://127.0.0.1:7790/mcp', enabled: true }
            ]
        });
        expect(res.importedCount).toBe(4);
        expect(res.warnings).toHaveLength(0);
        expect(Object.keys(res.servers).sort()).toEqual(['Atlassian', 'discord', 'filesystem', 'resonitelink']);
        expect((res.servers['filesystem'] as TheiaLocalMCPServerValue).command).toBe('npx');
        expect((res.servers['resonitelink'] as TheiaRemoteMCPServerValue).serverUrl).toBe('http://127.0.0.1:7790/mcp');
        // discord has an empty description -> no drop note for it
        expect(res.notes.some(n => n.name === 'discord' && /description/.test(n.reason))).toBe(false);
    });
});

describe('mergeIntoExisting', () => {
    it('adds new servers and preserves existing ones', () => {
        const existing: TheiaMCPServersPreference = { keep: { command: 'old' } as TheiaLocalMCPServerValue };
        const incoming: TheiaMCPServersPreference = { fresh: { command: 'new' } as TheiaLocalMCPServerValue };
        const { merged, skippedExisting } = mergeIntoExisting(existing, incoming);
        expect(Object.keys(merged).sort()).toEqual(['fresh', 'keep']);
        expect(skippedExisting).toHaveLength(0);
    });

    it('does not overwrite an existing server of the same name and reports it', () => {
        const existing: TheiaMCPServersPreference = { dup: { command: 'existing' } as TheiaLocalMCPServerValue };
        const incoming: TheiaMCPServersPreference = { dup: { command: 'incoming' } as TheiaLocalMCPServerValue };
        const { merged, skippedExisting } = mergeIntoExisting(existing, incoming);
        expect((merged['dup'] as TheiaLocalMCPServerValue).command).toBe('existing');
        expect(skippedExisting).toEqual(['dup']);
    });

    it('treats undefined existing as an empty base', () => {
        const { merged } = mergeIntoExisting(undefined, { a: { command: 'x' } as TheiaLocalMCPServerValue });
        expect(Object.keys(merged)).toEqual(['a']);
    });
});
