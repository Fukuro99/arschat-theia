import 'reflect-metadata';
import { ContainerModule, Container } from '@theia/core/shared/inversify';
import { ArschatChatWidget } from './arschat-chat-widget';
import { ChatService } from '@theia/ai-chat/lib/common/chat-service';
import { ChatSessionStore } from '@theia/ai-chat/lib/common/chat-session-store';
import { ChatAgentService } from '@theia/ai-chat/lib/common/chat-agent-service';
import { ProviderSwitchService } from 'arschat-providers/lib/browser/provider-switch-service';
import { PersonaService } from 'arschat-agents/lib/browser/persona-service';
import { SkillService } from 'arschat-agents/lib/browser/skill-service';
import { ArschatChatUiService } from './arschat-chat-ui-service';
import { ArschatStatsStore } from './arschat-stats-store';
import { ToolConfirmationManager } from '@theia/ai-chat/lib/browser/chat-tool-preference-bindings';
import { TextChatResponseContentImpl, ToolCallChatResponseContentImpl } from '@theia/ai-chat/lib/common/chat-model';
import { ImageContextVariable } from '@theia/ai-chat/lib/common/image-context-variable';
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
    /** requestIds removed from the fake model by the widget's dropTurnFromModel. */
    let removedRequestIds: string[];
    let storeSessionsCalls: number;
    let storedSessions: any[];
    let fakeRequests: any[];
    let restoredSessionId: string | undefined;
    /** durations recorded / forgotten via the fake ArschatStatsStore (M6 e-25). */
    let recordedDurations: Array<{ requestId: string; durationMs: number }>;
    let forgottenRequestIds: string[];
    /** what the fake stats store returns from getDurationMs. */
    let storedDurations: Map<string, number>;

    beforeEach(async () => {
        registeredTools = new Map<string, ToolRequest>();
        setConfirmationModeCalls = [];
        setSessionConfirmationModeCalls = [];
        removedRequestIds = [];
        storeSessionsCalls = 0;
        storedSessions = [];
        fakeRequests = [];
        restoredSessionId = undefined;
        recordedDurations = [];
        forgottenRequestIds = [];
        storedDurations = new Map<string, number>();
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
            // Fake model whose getBranch returns a single-item root branch, so the
            // widget's dropTurnFromModel path runs the real removeRequestFromModel
            // (its re-link logic is unit-tested in arschat-request-tree.test.ts).
            bind(ChatService).toConstantValue({
                getSession: (_id: string) => ({
                    id: 'sess-1',
                    title: 'Existing session title',
                    pinnedAgent: { id: 'arschat-agent' },
                    model: {
                        location: 'panel',
                        getRequests: () => fakeRequests,
                        getBranch: (requestId: string) => {
                            removedRequestIds.push(requestId);
                            return {
                                items: [{ element: { id: requestId } }],
                                activeBranchIndex: 0,
                                previous: undefined,
                                hierarchy: { branch: {} }
                            };
                        }
                    }
                }),
                getOrRestoreSession: async (id: string) => {
                    restoredSessionId = id;
                    return { id, model: { getRequests: () => [] } };
                }
            } as unknown as ChatService);
            bind(ChatSessionStore).toConstantValue({
                storeSessions: async (...sessions: any[]) => {
                    storeSessionsCalls++;
                    storedSessions.push(...sessions);
                }
            } as unknown as ChatSessionStore);
            bind(ArschatStatsStore).toConstantValue({
                ready: async () => undefined,
                getDurationMs: (requestId: string) => storedDurations.get(requestId),
                record: async (requestId: string, durationMs: number) => { recordedDurations.push({ requestId, durationMs }); },
                forget: async (requestId: string) => { forgottenRequestIds.push(requestId); }
            } as unknown as ArschatStatsStore);
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

    // ---- M6 e-24: hover message actions ----

    /** Seed a finished user+assistant turn (one request id) plus the session id. */
    function seedTurn(requestId = 'req-1') {
        asAny(widget).sessionId = 'sess-1';
        asAny(widget).messages = [
            { id: 1, author: 'user', text: 'hello', requestId },
            { id: 2, author: 'assistant', text: 'hi there', requestId, streaming: false }
        ];
        return asAny(widget).messages[1];
    }

    it('shows copy + edit + regenerate + continue + branch + delete on the last assistant message', () => {
        seedTurn();
        const element = render(widget.render());
        const assistantActions = element.container.querySelector('.arschat-chat-message-assistant .arschat-message-actions');
        expect(assistantActions).toBeTruthy();
        expect(assistantActions!.querySelectorAll('.arschat-message-action')).toHaveLength(6);
        expect(assistantActions!.querySelector('[title="コピー"]')).toBeTruthy();
        expect(assistantActions!.querySelector('[title="編集"]')).toBeTruthy();
        expect(assistantActions!.querySelector('[title="再生成"]')).toBeTruthy();
        expect(assistantActions!.querySelector('[title="続きを生成"]')).toBeTruthy();
        expect(assistantActions!.querySelector('[title="ここから分岐"]')).toBeTruthy();
        expect(assistantActions!.querySelector('.arschat-message-action-delete')).toBeTruthy();
    });

    it('shows copy + edit + branch + delete on a user message', () => {
        seedTurn();
        const element = render(widget.render());
        const userActions = element.container.querySelector('.arschat-chat-message-user .arschat-message-actions');
        expect(userActions).toBeTruthy();
        expect(userActions!.querySelectorAll('.arschat-message-action')).toHaveLength(4);
        expect(userActions!.querySelector('.arschat-message-action-edit')).toBeTruthy();
        expect(userActions!.querySelector('.arschat-message-action-branch')).toBeTruthy();
        expect(userActions!.querySelector('.arschat-message-action-continue')).toBeFalsy();
        expect(userActions!.querySelector('.arschat-message-action-regenerate')).toBeFalsy();
    });

    it('hides 再生成 on an older assistant message (only the newest can regenerate)', () => {
        asAny(widget).sessionId = 'sess-1';
        asAny(widget).messages = [
            { id: 1, author: 'user', text: 'q1', requestId: 'r1' },
            { id: 2, author: 'assistant', text: 'a1', requestId: 'r1', streaming: false },
            { id: 3, author: 'user', text: 'q2', requestId: 'r2' },
            { id: 4, author: 'assistant', text: 'a2', requestId: 'r2', streaming: false }
        ];
        const element = render(widget.render());
        // one regenerate/continue pair total (only for the newest assistant)
        expect(element.queryAllByTitle('再生成')).toHaveLength(1);
        expect(element.queryAllByTitle('続きを生成')).toHaveLength(1);
        expect(element.container.querySelectorAll('.arschat-message-action-delete')).toHaveLength(4);
    });

    it('does not render actions while an assistant message is still streaming', () => {
        asAny(widget).sessionId = 'sess-1';
        asAny(widget).messages = [
            { id: 1, author: 'user', text: 'q', requestId: 'r' },
            { id: 2, author: 'assistant', text: 'partial', requestId: 'r', streaming: true }
        ];
        const element = render(widget.render());
        expect(element.container.querySelector('.arschat-chat-message-assistant .arschat-message-actions')).toBeFalsy();
    });

    it('regenerate preserves a half-written input draft (M6 e-26)', async () => {
        const assistant = seedTurn('req-1');
        // the user had started typing a new message while the last answer was on screen
        asAny(widget).inputValue = '書きかけのドラフト';
        let sentText: string | undefined;
        // Stub send() to mimic the real pipeline's only relevant side effect: it reads
        // the input as the request text, then clears it. The fix must survive this.
        asAny(widget).send = async () => {
            sentText = asAny(widget).inputValue;
            asAny(widget).inputValue = '';
        };
        await asAny(widget).regenerate(assistant);
        // the resend used the original user text of the turn being regenerated...
        expect(sentText).toBe('hello');
        // ...and the user's draft is back in the input box afterwards (not lost).
        expect(asAny(widget).inputValue).toBe('書きかけのドラフト');
    });

    it('opens edit mode with the message text as the edit draft', () => {
        const assistant = seedTurn('req-1');
        asAny(widget).startEdit(assistant);
        expect(assistant.editing).toBe(true);
        expect(asAny(widget).editDraft).toBe('hi there');
        const element = render(widget.render());
        const ta = element.container.querySelector('.arschat-message-edit-textarea') as HTMLTextAreaElement | null;
        expect(ta).toBeTruthy();
        expect(ta!.value).toBe('hi there');
    });

    it('cancelEdit leaves message text unchanged and exits edit mode', () => {
        const assistant = seedTurn('req-1');
        asAny(widget).startEdit(assistant);
        asAny(widget).editDraft = 'changed';
        asAny(widget).cancelEdit(assistant);
        expect(assistant.editing).toBe(false);
        expect(assistant.text).toBe('hi there');
        expect(asAny(widget).editDraft).toBe('');
    });

    it('saveUserEdit drops the edited and following turns, resends edited text, and restores input draft', async () => {
        asAny(widget).sessionId = 'sess-1';
        asAny(widget).messages = [
            { id: 1, author: 'user', text: 'old q1', requestId: 'r1' },
            { id: 2, author: 'assistant', text: 'old a1', requestId: 'r1', streaming: false },
            { id: 3, author: 'user', text: 'old q2', requestId: 'r2' },
            { id: 4, author: 'assistant', text: 'old a2', requestId: 'r2', streaming: false }
        ];
        asAny(widget).inputValue = 'draft';
        let sentText: string | undefined;
        asAny(widget).send = async () => {
            expect(storeSessionsCalls).toBe(1);
            sentText = asAny(widget).inputValue;
            asAny(widget).inputValue = '';
        };
        await asAny(widget).saveUserEdit(asAny(widget).messages[0], 'edited q1');
        expect(removedRequestIds).toEqual(['r1', 'r2']);
        expect(asAny(widget).messages).toHaveLength(0);
        expect(sentText).toBe('edited q1');
        expect(asAny(widget).inputValue).toBe('draft');
        expect(forgottenRequestIds).toEqual(['r1', 'r2']);
        expect(storeSessionsCalls).toBe(1);
        expect(storedSessions[0].title).toBe('Existing session title');
        expect(storedSessions[0].pinnedAgentId).toBe('arschat-agent');
    });

    it('saveUserEdit resends the original image variables and restores draft images', async () => {
        const originalImage = ImageContextVariable.createRequest({ data: 'abc123', mimeType: 'image/png', name: 'original.png' });
        fakeRequests = [
            {
                id: 'r1',
                request: { text: 'old q1', displayText: undefined, variables: [originalImage] },
                response: { response: { content: [] } }
            }
        ];
        asAny(widget).sessionId = 'sess-1';
        asAny(widget).messages = [
            { id: 1, author: 'user', text: 'old q1', requestId: 'r1', images: ['data:image/png;base64,abc123'] },
            { id: 2, author: 'assistant', text: 'old a1', requestId: 'r1', streaming: false }
        ];
        const draftImage = { data: 'draft', mimeType: 'image/jpeg', name: 'draft.jpg', previewUrl: 'data:image/jpeg;base64,draft' };
        asAny(widget).inputValue = 'draft text';
        asAny(widget).pendingImages = [draftImage];
        let sentImages: any[] | undefined;
        let sentText: string | undefined;
        asAny(widget).send = async () => {
            sentText = asAny(widget).inputValue;
            sentImages = [...asAny(widget).pendingImages];
            asAny(widget).inputValue = '';
            asAny(widget).pendingImages = [];
        };
        await asAny(widget).saveUserEdit(asAny(widget).messages[0], 'edited q1');
        expect(sentText).toBe('edited q1');
        expect(sentImages).toEqual([{
            data: 'abc123',
            mimeType: 'image/png',
            name: 'original.png',
            previewUrl: 'data:image/png;base64,abc123'
        }]);
        expect(asAny(widget).pendingImages).toEqual([draftImage]);
        expect(asAny(widget).inputValue).toBe('draft text');
    });

    it('hides edit for image user messages whose variables cannot be safely restored', () => {
        fakeRequests = [
            {
                id: 'r-path',
                request: { text: 'look', displayText: undefined, variables: [ImageContextVariable.createPathBasedRequest('img.png', 'img.png')] },
                response: { response: { content: [] } }
            }
        ];
        asAny(widget).sessionId = 'sess-1';
        asAny(widget).messages = [
            { id: 1, author: 'user', text: 'look', requestId: 'r-path', images: ['data:image/png;base64,preview'] },
            { id: 2, author: 'assistant', text: 'seen', requestId: 'r-path', streaming: false }
        ];
        const element = render(widget.render());
        const userActions = element.container.querySelector('.arschat-chat-message-user .arschat-message-actions');
        expect(userActions).toBeTruthy();
        expect(userActions!.querySelector('.arschat-message-action-edit')).toBeFalsy();
    });

    it('saveAssistantEdit overwrites response content and persists without sending', async () => {
        const assistant = seedTurn('req-1');
        const content: any[] = [{ kind: 'text', asString: () => 'old' }];
        assistant.response = {
            response: {
                content,
                clearContent: () => { content.splice(0, content.length); },
                addContent: (part: any) => { content.push(part); }
            }
        };
        let sendCalled = false;
        asAny(widget).send = async () => { sendCalled = true; };
        await asAny(widget).saveAssistantEdit(assistant, 'edited answer');
        expect(sendCalled).toBe(false);
        expect(assistant.text).toBe('edited answer');
        expect(content).toHaveLength(1);
        expect(content[0].asString()).toBe('edited answer');
        expect(storeSessionsCalls).toBe(1);
    });

    it('continueMessage sends the explicit continue prompt and restores input draft', async () => {
        const assistant = seedTurn('req-1');
        asAny(widget).inputValue = 'draft';
        let sentText: string | undefined;
        asAny(widget).send = async () => {
            sentText = asAny(widget).inputValue;
            asAny(widget).inputValue = '';
        };
        await asAny(widget).continueMessage(assistant);
        expect(sentText).toBe('続けてください');
        expect(asAny(widget).inputValue).toBe('draft');
    });

    it('branchMessage stores a sliced session and loads it', async () => {
        const assistant = seedTurn('r2');
        const responseWithText = (requestId: string, text: string): any => {
            const content = [new TextChatResponseContentImpl(text)];
            return {
                response: { content },
                toSerializable: () => ({ id: `resp-${requestId}`, requestId, isComplete: true, isError: false, content: content.map(part => part.toSerializable()) })
            };
        };
        fakeRequests = [
            {
                id: 'r1',
                request: { text: 'first user prompt', displayText: undefined },
                response: responseWithText('r1', 'first assistant answer'),
                toSerializable: () => ({ id: 'r1', text: 'first user prompt' })
            },
            {
                id: 'r2',
                request: { text: 'second prompt', displayText: undefined },
                response: responseWithText('r2', 'second assistant answer'),
                toSerializable: () => ({ id: 'r2', text: 'second prompt' })
            },
            {
                id: 'r3',
                request: { text: 'trailing prompt', displayText: undefined },
                response: responseWithText('r3', 'trailing assistant answer'),
                toSerializable: () => ({ id: 'r3', text: 'trailing prompt' })
            }
        ];
        await asAny(widget).branchMessage(assistant);
        expect(storeSessionsCalls).toBe(1);
        expect(storedSessions[0].title).toBe('[分岐] first user prompt');
        expect(storedSessions[0].pinnedAgentId).toBe('arschat-agent');
        const saved = storedSessions[0].model.toSerializable();
        expect(saved.requests.map((r: any) => r.id)).toEqual(['r1', 'r2']);
        expect(saved.responses.map((r: any) => r.content.map((part: any) => part.data.content))).toEqual([
            ['first assistant answer'],
            ['second assistant answer']
        ]);
        expect(restoredSessionId).toBe(storedSessions[0].model.id);
        expect(asAny(widget).sessionId).toBe(storedSessions[0].model.id);
    });

    it('copyMessage writes the message text to the clipboard and flags copied', async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });
        const assistant = seedTurn();
        await asAny(widget).copyMessage(assistant);
        expect(writeText).toHaveBeenCalledWith('hi there');
        expect(assistant.copied).toBe(true);
    });

    it('deleteMessage removes the whole turn (user+assistant) and persists', async () => {
        const assistant = seedTurn('req-1');
        await asAny(widget).deleteMessage(assistant);
        // both UiMessages sharing the request id are gone
        expect(asAny(widget).messages).toHaveLength(0);
        // the model was asked to remove that turn, then the session was stored
        expect(removedRequestIds).toContain('req-1');
        expect(storeSessionsCalls).toBe(1);
        expect(storedSessions[0].title).toBe('Existing session title');
        expect(storedSessions[0].pinnedAgentId).toBe('arschat-agent');
        // and the recorded duration for the turn is dropped too (M6 e-25)
        expect(forgottenRequestIds).toContain('req-1');
    });

    // ---- M6 e-25: stats bar ----

    it('shows tokens/sec, token count and duration from real usage + measured duration', () => {
        const assistant = seedTurn('req-1');
        assistant.response = { tokenUsage: { inputTokens: 120, outputTokens: 80 } };
        assistant.durationMs = 4000;
        const element = render(widget.render());
        // 80 output tokens / 4s = 20.00 tokens/sec; total = 200; 4.0s
        expect(element.queryByText(/20\.00 トークン\/秒/)).toBeTruthy();
        expect(element.queryByText(/200 トークン$/)).toBeTruthy();
        expect(element.queryByText(/4\.0s/)).toBeTruthy();
    });

    it('falls back to a char-based token approximation when usage is absent', () => {
        const assistant = seedTurn('req-1');
        assistant.text = 'a'.repeat(400); // ~100 tokens at 4 chars/token
        assistant.durationMs = 10_000;
        const element = render(widget.render());
        expect(element.queryByText(/100 トークン$/)).toBeTruthy();
        expect(element.queryByText(/10\.00 トークン\/秒/)).toBeTruthy();
    });

    it('shows token count without speed/duration for a restored turn with no recorded duration', () => {
        const assistant = seedTurn('req-old');
        assistant.response = { tokenUsage: { inputTokens: 10, outputTokens: 5 } };
        assistant.durationMs = undefined;
        const element = render(widget.render());
        expect(element.queryByText(/15 トークン$/)).toBeTruthy();
        expect(element.queryByText(/トークン\/秒/)).toBeFalsy();
    });

    it('does not render a stats bar while streaming', () => {
        asAny(widget).sessionId = 'sess-1';
        asAny(widget).messages = [
            { id: 1, author: 'user', text: 'q', requestId: 'r' },
            { id: 2, author: 'assistant', text: 'partial', requestId: 'r', streaming: true, durationMs: 1000 }
        ];
        const element = render(widget.render());
        expect(element.container.querySelector('.arschat-message-stats')).toBeFalsy();
    });

    it('restores the persisted duration when a session turn is re-opened from history', () => {
        storedDurations.set('req-42', 2500);
        const req: any = {
            id: 'req-42',
            request: { text: 'question', displayText: undefined },
            response: { response: { content: [] }, tokenUsage: { inputTokens: 4, outputTokens: 6 } }
        };
        asAny(widget).appendRestoredRequest(req);
        const assistant = asAny(widget).messages[1];
        expect(assistant.durationMs).toBe(2500);
        const element = render(widget.render());
        expect(element.queryByText(/2\.5s/)).toBeTruthy();
        expect(element.queryByText(/10 トークン$/)).toBeTruthy();
    });

});
