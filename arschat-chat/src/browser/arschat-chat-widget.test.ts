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
import { render } from '@testing-library/react';
import { act } from 'react';

describe('ArschatChatWidget', () => {

    let widget: ArschatChatWidget;

    beforeEach(async () => {
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
                setConfirmationMode: () => { /* noop */ },
                setSessionConfirmationMode: () => { /* noop */ }
            } as unknown as ToolConfirmationManager);
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

    it('renders a tool call card in the 承認待ち state with allow/deny + scope buttons', () => {
        const tc = new ToolCallChatResponseContentImpl('tc1', 'write_file', '{"path":"a.txt"}', false, undefined);
        const msg: any = { id: 1, author: 'assistant', text: '', streaming: true };
        asAny(widget).syncToolCalls(msg, fakeResponseWith(tc));
        // needsUserConfirmation drives the card into confirm; force it directly for a
        // synchronous render assertion.
        msg.toolCalls[0].state = 'confirm';
        asAny(widget).messages = [msg];
        const element = render(widget.render());
        expect(element.queryByText('write_file')).toBeTruthy();
        expect(element.queryByText('許可')).toBeTruthy();
        expect(element.queryByText('セッション中')).toBeTruthy();
        expect(element.queryByText('常に許可')).toBeTruthy();
        expect(element.queryByText('拒否')).toBeTruthy();
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
