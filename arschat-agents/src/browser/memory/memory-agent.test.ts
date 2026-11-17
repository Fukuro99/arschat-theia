/** @jest-environment jsdom */
import 'reflect-metadata';
import { ArschatChatAgent } from '../arschat-chat-agent';
import { MutableChatRequestModel, MutableChatResponseModel, MarkdownChatResponseContentImpl, ThinkingChatResponseContentImpl } from '@theia/ai-chat/lib/common/chat-model';
import { ChatSessionContext } from '@theia/ai-chat/lib/common/chat-agents';
import { LanguageModel, ToolRequest, UserRequest } from '@theia/ai-core';
import { formatMemoryBlock } from './memory-utils';
import { ArschatMemoryService } from './memory-service';
import { ArschatMemoryEnvironment } from './memory-environment';
import { ToolInvocationRegistryImpl } from '@theia/ai-core/lib/common/tool-invocation-registry';

class TestAgent extends ArschatChatAgent {
    system(query: string) { return this.getSystemMessageDescription({ model: {}, request: { request: { text: query } } } as ChatSessionContext); }
    complete(request: MutableChatRequestModel) { return this.onResponseComplete(request); }
    send(request: MutableChatRequestModel, id: string) { return this.sendLlmRequest(request, [], [], { id } as LanguageModel); }
    protected override getLlmSettings() { return {}; }
}

function fixture() {
    const agent = new TestAgent();
    const memory = { recallBlock: jest.fn(async (query: string) => `\nMEMORY ${query}`), readTools: jest.fn((): ToolRequest[] => []), save: jest.fn(async () => {}) };
    Object.assign(agent, { personaService: { ready: async () => {}, getActiveEffectiveSystemPrompt: () => 'PERSONA' }, memory,
        languageModelService: { sendRequest: async () => ({ text: 'reply' }) } });
    const request = { id: 'request', session: { id: 'session' }, request: { text: 'user text' },
        response: { complete: jest.fn(), isError: false, isCanceled: false,
            response: { content: [new MarkdownChatResponseContentImpl('visible'),
                { kind: 'thinking', content: 'reasoning' } as ThinkingChatResponseContentImpl,
                { kind: 'toolCall', arguments: 'private args', result: 'private result' }] } } } as unknown as MutableChatRequestModel;
    return { agent, memory, request };
}

describe('memory agent hooks', () => {
    it('keeps concurrent recall results request-local even when they finish out of order', async () => {
        const f = fixture();
        let first!: (value: string) => void;
        f.memory.recallBlock.mockImplementationOnce(() => new Promise(resolve => { first = resolve; }));
        const firstRequest = f.agent.system('first');
        expect((await f.agent.system('second'))?.text).toBe('PERSONA\nMEMORY second');
        first('\nMEMORY first');
        expect((await firstRequest)?.text).toBe('PERSONA\nMEMORY first');
    });
    it('retains the persona when there are no memories', async () => {
        const f = fixture();
        f.memory.recallBlock.mockResolvedValue('');
        expect((await f.agent.system('q'))?.text).toBe('PERSONA');
    });
    it('completes without awaiting background save and excludes tool and native thinking content', async () => {
        const f = fixture();
        f.memory.save.mockReturnValue(new Promise(() => {}));
        await f.agent.complete(f.request);
        expect(f.request.response.complete).toHaveBeenCalled();
        expect(f.memory.save).toHaveBeenCalledWith({ user: 'user text', assistant: 'visible', sessionId: 'session', requestId: 'request' });
    });
    it.each(['isCanceled', 'isError'])('does not save %s responses', async key => {
        const f = fixture();
        Object.assign(f.request.response, { [key]: true });
        await f.agent.complete(f.request);
        expect(f.memory.save).not.toHaveBeenCalled();
    });
    it('does not save actual mock-model responses even if the provider selection is a real model', async () => {
        const f = fixture();
        await f.agent.send(f.request, 'arschat-mock/m16-memory');
        await f.agent.complete(f.request);
        expect(f.memory.save).not.toHaveBeenCalled();
    });
    it('delivers recalled context and read tools through AbstractChatAgent.invoke while keeping base tools', async () => {
        const f = fixture();
        const block = formatMemoryBlock([{ fact: 'ArschatM16MemoryQuartz', status: 'valid', valid_at: '2026-11-17' }]);
        const readTools = ['search_memory', 'get_entity'].map(name => ({ id: `mcp_sqgraph-memory_${name}`, name: `mcp_sqgraph-memory_${name}` } as ToolRequest));
        const model = { id: 'arschat-mock/m16', request: jest.fn(async (_request: UserRequest) => ({ text: 'reply' })) };
        f.memory.recallBlock.mockResolvedValue(block);
        f.memory.readTools.mockReturnValue(readTools);
        f.agent.setToolRequests([{ id: 'read_file', name: 'read_file' } as ToolRequest]);
        Object.assign(f.agent, {
            languageModelRegistry: { selectLanguageModel: async () => model },
            languageModelService: { sendRequest: (selected: LanguageModel, request: UserRequest) => selected.request(request) },
            chatToolRequestService: { getChatToolRequests: () => [], toChatToolRequests: (tools: ToolRequest[]) => tools }
        });
        Object.assign(f.request.session, { getRequests: () => [] });
        Object.assign(f.request, { response: new MutableChatResponseModel('request', 'ArsChat') });
        await f.agent.invoke(f.request);
        expect(f.request.response.isError).toBe(false);
        expect(f.request.response.isComplete).toBe(true);
        expect(model.request).toHaveBeenCalledTimes(1);
        expect(model.request.mock.calls[0][0].messages[0]).toEqual({ actor: 'system', type: 'text', text: `PERSONA${block}` });
        expect(model.request.mock.calls[0][0].tools?.map(tool => tool.id)).toEqual([...readTools.map(tool => tool.id), 'read_file']);
        expect(f.memory.save).not.toHaveBeenCalled();
    });
    it('completes a normal chat through the real memory service when no MCP tools are registered', async () => {
        const f = fixture();
        const memory = new ArschatMemoryService();
        Object.assign(memory, {
            environment: Object.assign(new ArschatMemoryEnvironment(), { ready: async () => {}, autoSaveBlocked: false }),
            preferences: { get: (_key: string, fallback: unknown) => fallback },
            manager: { getRunningServers: async () => [] }, tools: new ToolInvocationRegistryImpl(),
            logger: { debug: () => {}, warn: () => {} }
        });
        const model = { id: 'arschat-mock/missing-memory', request: jest.fn(async (_request: UserRequest) => ({ text: 'reply' })) };
        Object.assign(f.agent, { memory,
            languageModelRegistry: { selectLanguageModel: async () => model },
            languageModelService: { sendRequest: (selected: LanguageModel, request: UserRequest) => selected.request(request) },
            chatToolRequestService: { getChatToolRequests: () => [], toChatToolRequests: (tools: ToolRequest[]) => tools }
        });
        Object.assign(f.request.session, { getRequests: () => [] });
        Object.assign(f.request, { response: new MutableChatResponseModel('request', 'ArsChat') });
        await f.agent.invoke(f.request);
        expect(f.request.response.isError).toBe(false);
        expect(f.request.response.isComplete).toBe(true);
        expect(model.request).toHaveBeenCalledTimes(1);
        expect(model.request.mock.calls[0][0].messages[0]).toEqual({ actor: 'system', type: 'text', text: 'PERSONA' });
    });
});
