/** @jest-environment jsdom */
import 'reflect-metadata';
import { ArschatChatAgent } from './arschat-chat-agent';
import { LanguageModel, LanguageModelMessage, ToolRequest } from '@theia/ai-core';
import { MutableChatRequestModel } from '@theia/ai-chat/lib/common/chat-model';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { CLI_DEFAULTS, CLI_SETTINGS } from 'arschat-providers/lib/common/cli-agents';

class TestAgent extends ArschatChatAgent {
    send(request: MutableChatRequestModel, messages: LanguageModelMessage[], tools: ToolRequest[], model: LanguageModel) {
        return this.sendLlmRequest(request, messages, tools, model, 'persona', true);
    }
}
it('snapshots CLI preferences and workspace per request, sends the full history and no ArsChat tools', async () => {
    const agent = new TestAgent();
    const prefs = new Map<string, unknown>();
    const sendRequest = jest.fn(async () => ({ text: 'PONG' }));
    const workspace = { roots: Promise.resolve([{ resource: FileUri.create(process.cwd()) }]) };
    Object.assign(agent, { cliPreferences: { ready: Promise.resolve(), get: (k: string, d: unknown) => prefs.get(k) ?? d },
        cliWorkspace: workspace, languageModelService: { sendRequest } });
    const token = {};
    const request = { id: 'r', session: { id: 's' }, response: { cancellationToken: token } } as MutableChatRequestModel;
    const messages: LanguageModelMessage[] = [{ actor: 'system', type: 'text', text: 'system' },
        { actor: 'user', type: 'text', text: 'previous' }, { actor: 'ai', type: 'text', text: 'answer' },
        { actor: 'user', type: 'text', text: 'current' }];
    const model = { id: 'codex-cli' } as LanguageModel;
    await agent.send(request, messages, [{ name: 'private-tool' } as ToolRequest], model);
    expect(sendRequest).toHaveBeenCalledWith(model, {
        messages, settings: { [CLI_SETTINGS]: { ...CLI_DEFAULTS, workingDirectory: FileUri.fsPath(FileUri.create(process.cwd())) } },
        agentId: 'ArsChat', sessionId: 's', requestId: 'r', cancellationToken: token,
        promptVariantId: 'persona', isPromptVariantCustomized: true
    });
    prefs.set('arschat.cliAgents.codex.model', 'new-model');
    prefs.set('arschat.cliAgents.workingDirectory', 'explicit-directory');
    await agent.send(request, messages, [], model);
    expect(sendRequest.mock.calls[1]).toEqual([model, expect.objectContaining({ settings: {
        [CLI_SETTINGS]: expect.objectContaining({ codexModel: 'new-model', workingDirectory: 'explicit-directory' })
    } })]);
});
it('leaves the directory empty without a workspace so the backend chooses the config directory', async () => {
    const agent = new TestAgent();
    const sendRequest = jest.fn(async () => ({ text: 'PONG' }));
    Object.assign(agent, { cliPreferences: { ready: Promise.resolve(), get: (_k: string, d: unknown) => d },
        cliWorkspace: { roots: Promise.resolve([]) }, languageModelService: { sendRequest } });
    await agent.send({ id: 'r', session: { id: 's' }, response: {} } as MutableChatRequestModel, [], [], { id: 'claude-code-cli' } as LanguageModel);
    expect(sendRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ settings: { [CLI_SETTINGS]: CLI_DEFAULTS } }));
});
