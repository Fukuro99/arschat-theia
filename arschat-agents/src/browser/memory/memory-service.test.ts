/** @jest-environment jsdom */
import 'reflect-metadata';
import { ArschatMemoryService } from './memory-service';
import { ArschatMemoryEnvironment } from './memory-environment';
import { ToolInvocationRegistryImpl } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { ToolRequest } from '@theia/ai-core';

function fixture() {
    const preferences: Record<string, unknown> = {};
    const order: string[] = [];
    const prepared = { token: 'token-private', instructions: 'extract', schema: { type: 'object' }, context: { content: 'context-private' } };
    const manager = {
        getRunningServers: jest.fn(async () => ['sqgraph-memory']),
        callTool: jest.fn(async (_server: string, tool: string, _args: string) => {
            order.push(tool);
            return { content: [{ type: 'text', text: JSON.stringify(tool === 'add_memory' ? prepared : { facts: [{ fact: 'remembered', status: 'valid' }], episode_id: 'ep_test' }) }] };
        })
    };
    const model = { id: 'real/model', request: jest.fn(async (_request: any) => { order.push('LLM'); return { text: '{"entities":[],"facts":[]}' }; }) };
    const environment = Object.assign(new ArschatMemoryEnvironment(), { ready: jest.fn(async () => {}), serverName: 'sqgraph-memory', autoSaveBlocked: false });
    const provider = { resolveActiveModelId: jest.fn(() => 'real/model') };
    const logger = { warn: jest.fn(), debug: jest.fn() };
    const tools = new ToolInvocationRegistryImpl();
    for (const name of ['search_memory', 'get_entity']) { tools.registerTool({ id: `mcp_sqgraph-memory_${name}` } as ToolRequest); }
    const service = new ArschatMemoryService();
    Object.assign(service, { preferences: { get: (key: string, fallback: unknown) => preferences[key] ?? fallback },
        manager, models: { getLanguageModel: jest.fn(async () => model) }, provider, environment, logger, tools });
    return { service, manager, model, environment, provider, preferences, order, logger, tools, prepared };
}
const turn = { user: 'user-private', assistant: '<think>secret-reasoning</think>visible', sessionId: 'session', requestId: 'request' };

describe('ArschatMemoryService', () => {
    it('calls add → active model → commit, with schema/context and no thinking', async () => {
        const f = fixture();
        await f.service.save(turn);
        expect(f.order).toEqual(['add_memory', 'LLM', 'commit_memory']);
        expect(JSON.parse(f.manager.callTool.mock.calls[0][2])).toEqual({ content: 'ユーザー: user-private\nアシスタント: visible',
            channel: 'arschat', author: 'user', source: 'arschat', occurred_at: expect.stringMatching(/^\d{4}-/) });
        expect(f.model.request.mock.calls[0][0].messages[1].text).toContain('context-private');
        expect(f.model.request.mock.calls[0][0].tools).toBeUndefined();
        expect(f.model.request.mock.calls[0][0].settings).toEqual({ stream: false });
        expect(JSON.parse(f.manager.callTool.mock.calls[1][2])).toEqual({ token: 'token-private', extraction: { entities: [], facts: [] } });
    });
    it('retries malformed JSON only once', async () => {
        const f = fixture();
        f.model.request.mockResolvedValueOnce({ text: 'broken' });
        await f.service.save(turn);
        expect(f.model.request).toHaveBeenCalledTimes(2);
        expect(f.manager.callTool.mock.calls.map(call => call[1])).toEqual(['add_memory', 'commit_memory']);
    });
    it('abandons two malformed outputs without commit or content logging', async () => {
        const f = fixture();
        f.model.request.mockResolvedValue({ text: 'user-private' });
        await f.service.save(turn);
        expect(f.model.request).toHaveBeenCalledTimes(2);
        expect(f.order).toEqual(['add_memory']);
        expect(JSON.stringify(f.logger.warn.mock.calls)).not.toMatch(/user-private|context-private|token-private/);
    });
    it('consumes streaming extraction and fenced JSON', async () => {
        const f = fixture();
        f.model.request.mockResolvedValue({ stream: { async *[Symbol.asyncIterator]() { yield { content: '```json\n{}\n```' }; } } } as any);
        await f.service.save(turn);
        expect(f.manager.callTool.mock.calls.map(call => call[1])).toEqual(['add_memory', 'commit_memory']);
    });
    it.each(['disabled', 'autoSave', 'autotest', 'mock', 'env failure', 'unavailable'])('does not write for %s', async mode => {
        const f = fixture();
        if (mode === 'disabled') { f.preferences['arschat.memory.enabled'] = false; }
        if (mode === 'autoSave') { f.preferences['arschat.memory.autoSave'] = false; }
        if (mode === 'autotest') { f.environment.autoSaveBlocked = true; }
        if (mode === 'mock') { f.provider.resolveActiveModelId.mockReturnValue('arschat-mock/m13'); }
        if (mode === 'env failure') { f.environment.ready.mockRejectedValue(new Error('env unavailable')); }
        if (mode === 'unavailable') { f.service.setUnavailable(true); }
        await f.service.save(turn);
        expect(f.manager.callTool).not.toHaveBeenCalled();
    });
    it('does not commit when autoSave is disabled during extraction', async () => {
        const f = fixture();
        f.model.request.mockImplementation(async () => { f.preferences['arschat.memory.autoSave'] = false; return { text: '{}' }; });
        await f.service.save(turn);
        expect(f.manager.callTool.mock.calls.map(call => call[1])).toEqual(['add_memory']);
    });
    it('swallows provider/MCP errors without logging their private messages', async () => {
        const f = fixture();
        f.manager.callTool.mockRejectedValue(new Error('user-private'));
        await expect(f.service.save(turn)).resolves.toBeUndefined();
        expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain('user-private');
    });
    it('recalls with default and explicit limits', async () => {
        const f = fixture();
        expect(await f.service.recall('q')).toEqual([{ fact: 'remembered', status: 'valid' }]);
        expect(JSON.parse(f.manager.callTool.mock.calls[0][2])).toEqual({ query: 'q', limit: 5 });
        await f.service.recall('q', 20);
        expect(JSON.parse(f.manager.callTool.mock.calls[1][2]).limit).toBe(20);
    });
    it('returns empty for missing server and MCP errors', async () => {
        const f = fixture();
        f.manager.getRunningServers.mockResolvedValue([]);
        expect(await f.service.recall('q')).toEqual([]);
        expect(f.manager.callTool).not.toHaveBeenCalled();
        f.manager.getRunningServers.mockResolvedValue(['sqgraph-memory']);
        f.manager.callTool.mockRejectedValue(new Error('private'));
        expect(await f.service.recall('q')).toEqual([]);
    });
    it('bounds the whole recall including environment and status RPCs to three seconds', async () => {
        jest.useFakeTimers();
        const f = fixture();
        f.environment.ready.mockReturnValue(new Promise(() => {}));
        const recall = f.service.recall('q');
        jest.advanceTimersByTime(3000);
        expect(await recall).toEqual([]);
        jest.useRealTimers();
    });
    it('exposes exactly read-only tools and removes them when disabled', () => {
        const f = fixture();
        expect(f.service.readTools().map(tool => tool.id)).toEqual(['mcp_sqgraph-memory_search_memory', 'mcp_sqgraph-memory_get_entity']);
        f.preferences['arschat.memory.enabled'] = false;
        expect(f.service.readTools()).toEqual([]);
    });
    it('returns only registered tools with the real Theia registry', () => {
        const f = fixture();
        const registry = new ToolInvocationRegistryImpl();
        Object.assign(f.service, { tools: registry });
        expect(f.service.readTools()).toEqual([]);
        const tool = { id: 'mcp_sqgraph-memory_search_memory' } as ToolRequest;
        registry.registerTool(tool);
        expect(f.service.readTools()).toEqual([tool]);
    });
    it.each(['sqgraph-memory', 'personal-alias'])('blocks every service entry point to %s during autotests', async serverName => {
        const f = fixture();
        Object.assign(f.environment, { autoSaveBlocked: true, serverName, m16: true, testHome: 'C:/isolated' });
        expect(await f.service.recall('synthetic query')).toEqual([]);
        expect(f.service.readTools()).toEqual([]);
        await expect(f.service.call('add_memory', {})).rejects.toThrow('memory unavailable');
        expect(f.manager.getRunningServers).not.toHaveBeenCalled();
        expect(f.manager.callTool).not.toHaveBeenCalled();
    });
    it('allows only the dedicated isolated M16 server, while still blocking automatic save', async () => {
        const f = fixture();
        const name = 'sqgraph-memory-autotest';
        Object.assign(f.environment, { autoSaveBlocked: true, m16: true, serverName: name, testHome: 'C:/isolated' });
        f.manager.getRunningServers.mockResolvedValue([name]);
        f.tools.registerTool({ id: `mcp_${name}_search_memory` } as ToolRequest);
        expect(await f.service.recall('synthetic')).toHaveLength(1);
        expect(f.service.readTools().map(tool => tool.id)).toEqual([`mcp_${name}_search_memory`]);
        await f.service.call('commit_memory', {});
        await f.service.save(turn);
        expect(f.manager.callTool.mock.calls.map(call => call[0])).toEqual([name, name]);
        expect(f.model.request).not.toHaveBeenCalled();
    });
    it.each([
        { facts: [{ fact: 'missing subject and relation' }] },
        { facts: [{ subject: 'author', relation: 'LIKES' }] },
        { entities: [{ name: 'missing ref and type' }] },
        { entities: [{ ref: 'e1', type: 'Person' }] },
        { entities: [{ ref: 1, name: 'bad ref', type: 'Person' }] },
        { facts: [null] }
    ])('repairs schema violations before committing: %j', async extraction => {
        const f = fixture();
        f.model.request.mockResolvedValueOnce({ text: JSON.stringify(extraction) });
        await f.service.save(turn);
        expect(f.model.request).toHaveBeenCalledTimes(2);
        expect(f.order).toEqual(['add_memory', 'LLM', 'commit_memory']);
        expect(f.model.request.mock.calls[1][0].messages[2].text).toBe(JSON.stringify(extraction));
    });
    it('validates additional constraints from the returned schema and stops after one repair', async () => {
        const f = fixture();
        Object.assign(f.prepared.schema, { properties: { facts: { type: 'array', items: { type: 'object',
            properties: { confidence: { type: 'number', maximum: 1 } } } } } });
        f.model.request.mockResolvedValue({ text: JSON.stringify({ facts: [{ subject: 'author', relation: 'LIKES', fact: 'x', confidence: 2 }] }) });
        await f.service.save(turn);
        expect(f.model.request).toHaveBeenCalledTimes(2);
        expect(f.manager.callTool.mock.calls.map(call => call[1])).toEqual(['add_memory']);
    });
    it.each(['mcp', 'rejection', 'json'])('repairs commit validation errors (%s) once with the same token', async mode => {
        const f = fixture();
        const original = f.manager.callTool.getMockImplementation()!;
        let commits = 0;
        f.manager.callTool.mockImplementation(async (...args) => {
            if (args[1] === 'commit_memory' && commits++ === 0) {
                const message = 'invalid extraction (1 problem): unknown ref user-private';
                if (mode === 'rejection') { throw new Error(message); }
                return (mode === 'json' ? JSON.stringify({ error: message }) : { isError: true, content: [{ type: 'text', text: message }] }) as any;
            }
            return original(...args);
        });
        await f.service.save(turn);
        const calls = f.manager.callTool.mock.calls.filter(call => call[1] === 'commit_memory');
        expect(calls).toHaveLength(2);
        expect(calls.map(call => JSON.parse(call[2]).token)).toEqual(['token-private', 'token-private']);
        expect(f.model.request).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain('user-private');
    });
    it.each(['invalid extraction (1 problem): private', 'connection lost'])('bounds commit retries for %s', async message => {
        const f = fixture();
        const original = f.manager.callTool.getMockImplementation()!;
        f.manager.callTool.mockImplementation(async (...args) => {
            if (args[1] === 'commit_memory') { throw new Error(message); }
            return original(...args);
        });
        await f.service.save(turn);
        const attempts = message.startsWith('invalid extraction') ? 2 : 1;
        expect(f.model.request).toHaveBeenCalledTimes(attempts);
        expect(f.manager.callTool.mock.calls.filter(call => call[1] === 'commit_memory')).toHaveLength(attempts);
    });
    it('shares the single repair budget across schema and commit validation failures', async () => {
        const f = fixture();
        f.model.request.mockResolvedValueOnce({ text: '{"facts":[{"fact":"missing fields"}]}' });
        const original = f.manager.callTool.getMockImplementation()!;
        f.manager.callTool.mockImplementation(async (...args) => {
            if (args[1] === 'commit_memory') { throw new Error('invalid extraction (1 problem): private'); }
            return original(...args);
        });
        await f.service.save(turn);
        expect(f.model.request).toHaveBeenCalledTimes(2);
        expect(f.manager.callTool.mock.calls.filter(call => call[1] === 'commit_memory')).toHaveLength(1);
    });
});
