import 'reflect-metadata';
import { ContainerModule, Container } from '@theia/core/shared/inversify';
import { ArschatChatWidget } from './arschat-chat-widget';
import { ChatService } from '@theia/ai-chat/lib/common/chat-service';
import { ChatAgentService } from '@theia/ai-chat/lib/common/chat-agent-service';
import { ProviderSwitchService } from 'arschat-providers/lib/browser/provider-switch-service';
import { PersonaService } from 'arschat-agents/lib/browser/persona-service';
import { SkillService } from 'arschat-agents/lib/browser/skill-service';
import { ArschatChatUiService } from './arschat-chat-ui-service';
import { ToolConfirmationManager } from '@theia/ai-chat/lib/browser/chat-tool-preference-bindings';
import { ToolCallChatResponseContentImpl } from '@theia/ai-chat/lib/common/chat-model';
import { ToolInvocationRegistry } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { ToolRequest } from '@theia/ai-core/lib/common/language-model';
import { render } from '@testing-library/react';
import { act } from 'react';

describe('ArschatChatWidget', () => {

    let widget: ArschatChatWidget;
    /** Tools the fake ToolInvocationRegistry knows about, keyed by id. */
    let registeredTools: Map<string, ToolRequest>;
    let setConfirmationModeCalls: Array<{ toolId: string; mode: string; toolRequest: ToolRequest | undefined }>;
    let setSessionConfirmationModeCalls: Array<{ toolId: string; mode: string; chatId: string }>;

    beforeEach(async () => {
        registeredTools = new Map<string, ToolRequest>();
        setConfirmationModeCalls = [];
        setSessionConfirmationModeCalls = [];
        const module = new ContainerModule(bind => {
            // Minimal stubs: doInit() is async and fired from postConstruct, but render()
            // works off the widget's own fields, so a bare stub is enough for rendering.
            bind(ProviderSwitchService).toConstantValue({
                getActiveProvider: () => 'anthropic',
                getActiveModel: () => '',
                getModelsForProvider: async () => [],
                resolveActiveModelId: () => undefined,
                setActive: async () => undefined,
                onDidChange: () => ({ dispose(): void { /* noop */ } })
            } as unknown as ProviderSwitchService);
            bind(ChatService).toConstantValue({} as ChatService);
            bind(ChatAgentService).toConstantValue({} as ChatAgentService);
            bind(PersonaService).toConstantValue({
                ready: async () => undefined,
                getPersonas: () => [
                    { id: 'default', name: 'ArsChat', systemPrompt: 'sp', avatarPath: null },
                    { id: 'coder', name: 'Coder', systemPrompt: 'sp2', avatarPath: null }
                ],
                getActivePersonaId: () => 'default',
                setActivePersona: async () => undefined,
                onDidChange: () => ({ dispose(): void { /* noop */ } })
            } as unknown as PersonaService);
            bind(SkillService).toConstantValue({
                ready: async () => undefined,
                getSkills: () => [],
                filterByQuery: () => [],
                expandInput: () => undefined,
                onDidChange: () => ({ dispose(): void { /* noop */ } })
            } as unknown as SkillService);
            bind(ArschatChatUiService).toConstantValue({
                onLoadSessionRequested: () => ({ dispose(): void { /* noop */ } }),
                onNewSessionRequested: () => ({ dispose(): void { /* noop */ } }),
                onSessionChanged: () => ({ dispose(): void { /* noop */ } }),
                onSessionsMutated: () => ({ dispose(): void { /* noop */ } }),
                notifySessionChanged: () => { /* noop */ },
                notifySessionsMutated: () => { /* noop */ },
                requestLoadSession: () => { /* noop */ },
                requestNewSession: () => { /* noop */ }
            } as unknown as ArschatChatUiService);
            bind(ToolConfirmationManager).toConstantValue({
                getConfirmationMode: () => 'confirm',
                setConfirmationMode: (toolId: string, mode: string, toolRequest?: ToolRequest) => {
                    setConfirmationModeCalls.push({ toolId, mode, toolRequest });
                },
                setSessionConfirmationMode: (toolId: string, mode: string, chatId: string) => {
                    setSessionConfirmationModeCalls.push({ toolId, mode, chatId });
                }
            } as unknown as ToolConfirmationManager);
            bind(ToolInvocationRegistry).toConstantValue({
                getFunction: (toolId: string) => registeredTools.get(toolId)
            } as unknown as ToolInvocationRegistry);
            bind(ArschatChatWidget).toSelf();
        });
        const container = new Container();
        container.load(module);
        await act(async () => {
            widget = container.resolve<ArschatChatWidget>(ArschatChatWidget);
        });
    });

    it('should render react node correctly', async () => {
        const element = render(widget.render());
        expect(element.queryByText('送信')).toBeTruthy();
    });

    it('should show provider options in the header', () => {
        const element = render(widget.render());
        expect(element.queryByText('Anthropic')).toBeTruthy();
        expect(element.queryByText('LM Studio')).toBeTruthy();
    });

    it('should show persona options in the header (M4)', () => {
        const element = render(widget.render());
        // "Coder" only exists as a persona <option>; "ArsChat" also appears as the
        // header title, so assert the persona <select> contains both option labels.
        const select = element.container.querySelector('#arschat-persona-select');
        expect(select).toBeTruthy();
        const options = Array.from(select!.querySelectorAll('option')).map(o => o.textContent);
        expect(options).toContain('ArsChat');
        expect(options).toContain('Coder');
    });

    // ---- M5 e-3: tool call cards + approval ----

    /** Build a fake response model carrying a single tool call content part. */
    function fakeResponseWith(content: ToolCallChatResponseContentImpl): any {
        return {
            response: { content: [content] },
            isComplete: false,
            isError: false,
            isCanceled: false,
            onDidChange: () => ({ dispose(): void { /* noop */ } })
        };
    }

    /** Access to the widget's protected tool-call helpers for testing. */
    function asAny(w: ArschatChatWidget): any {
        return w as any;
    }

    /** Register a fake tool so the widget's ToolInvocationRegistry lookup resolves. */
    function registerTool(id: string, confirmAlwaysAllow?: boolean | string): void {
        registeredTools.set(id, {
            id, name: id, confirmAlwaysAllow,
            handler: async () => '', parameters: { type: 'object', properties: {} }
        } as unknown as ToolRequest);
    }

    /** Force a single tool-call card into the 承認待ち (confirm) state and render it. */
    function renderConfirmCard(toolName: string) {
        const tc = new ToolCallChatResponseContentImpl('tc1', toolName, '{"path":"a.txt"}', false, undefined);
        const msg: any = { id: 1, author: 'assistant', text: '', streaming: true };
        asAny(widget).syncToolCalls(msg, fakeResponseWith(tc));
        msg.toolCalls[0].state = 'confirm';
        asAny(widget).messages = [msg];
        return { element: render(widget.render()), view: msg.toolCalls[0] };
    }

    it('renders a read-only tool card with all 3 approve options + deny (no confirmAlwaysAllow)', () => {
        // read_file carries no confirmAlwaysAllow -> "常に許可" persists, so it stays visible.
        registerTool('read_file');
        const { element } = renderConfirmCard('read_file');
        expect(element.queryByText('read_file')).toBeTruthy();
        expect(element.queryByText('許可')).toBeTruthy();
        expect(element.queryByText('セッション中')).toBeTruthy();
        expect(element.queryByText('常に許可')).toBeTruthy();
        expect(element.queryByText('拒否')).toBeTruthy();
    });

    it('hides "常に許可" for confirmAlwaysAllow tools but keeps 許可/セッション中/拒否 (e-18)', () => {
        // write_file carries confirmAlwaysAllow -> persisted ALWAYS_ALLOW does not stick
        // in Theia 1.71.2, so the button is hidden. Session + once + deny remain.
        registerTool('write_file', 'This tool writes to disk.');
        const { element } = renderConfirmCard('write_file');
        expect(element.queryByText('write_file')).toBeTruthy();
        expect(element.queryByText('許可')).toBeTruthy();
        expect(element.queryByText('セッション中')).toBeTruthy();
        expect(element.queryByText('拒否')).toBeTruthy();
        expect(element.queryByText('常に許可')).toBeFalsy();
    });

    it('"セッション中" calls setSessionConfirmationMode (kept because session overrides stick)', () => {
        registerTool('write_file', 'This tool writes to disk.');
        const { view } = renderConfirmCard('write_file');
        asAny(widget).onToolAllow(view, 'session');
        expect(setSessionConfirmationModeCalls).toHaveLength(1);
        expect(setSessionConfirmationModeCalls[0].toolId).toBe('write_file');
        expect(setSessionConfirmationModeCalls[0].mode).toBe('always_allow');
    });

    it('"常に許可" passes the live ToolRequest to setConfirmationMode (non-confirmAlwaysAllow tool)', () => {
        registerTool('read_file');
        const { view } = renderConfirmCard('read_file');
        asAny(widget).onToolAllow(view, 'forever');
        expect(setConfirmationModeCalls).toHaveLength(1);
        expect(setConfirmationModeCalls[0].toolId).toBe('read_file');
        expect(setConfirmationModeCalls[0].mode).toBe('always_allow');
        // The ToolRequest must be forwarded so setConfirmationMode computes the correct default.
        expect(setConfirmationModeCalls[0].toolRequest).toBeDefined();
        expect(setConfirmationModeCalls[0].toolRequest!.id).toBe('read_file');
    });

    it('allow (once) confirms the underlying tool call so execution proceeds', async () => {
        const tc = new ToolCallChatResponseContentImpl('tc2', 'write_file', '{}', false, undefined);
        const confirmedProbe = tc.confirmed; // captured before confirm()
        const view: any = { key: 'tc2', content: tc, state: 'confirm' };
        asAny(widget).onToolAllow(view, 'once');
        await expect(confirmedProbe).resolves.toBe(true);
        expect(view.state).toBe('running');
    });

    it('deny finishes the tool call as a denial result (tool does not run)', async () => {
        const tc = new ToolCallChatResponseContentImpl('tc3', 'edit_file', '{}', false, undefined);
        const view: any = { key: 'tc3', content: tc, state: 'confirm' };
        asAny(widget).onToolDeny(view);
        expect(view.state).toBe('denied');
        expect(tc.finished).toBe(true);
        expect((tc.result as any).denied).toBe(true);
    });

});
