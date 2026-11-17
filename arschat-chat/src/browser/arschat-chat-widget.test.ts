import 'reflect-metadata';
import { ContainerModule, Container } from '@theia/core/shared/inversify';
import { ApplicationShell } from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { ArschatChatWidget } from './arschat-chat-widget';
import { ArschatApiKeysDialogService } from './arschat-api-keys-dialog';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { ChatService } from '@theia/ai-chat/lib/common/chat-service';
import { ChatSessionStore } from '@theia/ai-chat/lib/common/chat-session-store';
import { ChatAgentService } from '@theia/ai-chat/lib/common/chat-agent-service';
import { buildOpenAiModelsUrl, parseOpenAiModelIds, ProviderSwitchService } from 'arschat-providers/lib/browser/provider-switch-service';
import { PersonaService } from 'arschat-agents/lib/browser/persona-service';
import { SkillService } from 'arschat-agents/lib/browser/skill-service';
import { ArschatChatUiService } from './arschat-chat-ui-service';
import { ArschatStatsStore } from './arschat-stats-store';
import { ToolConfirmationManager } from '@theia/ai-chat/lib/browser/chat-tool-preference-bindings';
import { TextChatResponseContentImpl, ToolCallChatResponseContentImpl } from '@theia/ai-chat/lib/common/chat-model';
import { ImageContextVariable } from '@theia/ai-chat/lib/common/image-context-variable';
import { AIVariableResolutionRequest } from '@theia/ai-core';
import { ToolInvocationRegistry } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { ToolRequest } from '@theia/ai-core/lib/common/language-model';
import { ARSCHAT_BASE_TOOL_IDS, RENDER_UI_TOOL_ID } from 'arschat-tools/lib/common/tool-ids';
import { ArschatUiInteractionService } from 'arschat-tools/lib/browser/arschat-ui-interaction-service';
import { fireEvent, render } from '@testing-library/react';
import { act } from 'react';
import { ArschatProviderKind, OPENAI_CUSTOM_ENDPOINTS_PREF, PREF_ACTIVE_MODEL, PREF_ACTIVE_PROVIDER } from 'arschat-providers/lib/browser/arschat-provider-preferences';
import { computeResizeTarget, shouldResizeImageMimeType } from './arschat-image-resize';
import { TerminalCommands } from '@theia/terminal/lib/browser/terminal-frontend-contribution';

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
    let restoredRequests: any[];
    let restoredSessionId: string | undefined;
    /** durations recorded / forgotten via the fake ArschatStatsStore (M6 e-25). */
    let recordedDurations: Array<{ requestId: string; durationMs: number }>;
    let forgottenRequestIds: string[];
    /** what the fake stats store returns from getDurationMs. */
    let storedDurations: Map<string, number>;
    let activeProvider: ArschatProviderKind;
    let activeModel: string;
    let customEndpointModels: Map<ArschatProviderKind, string>;
    let customEndpointUrls: Map<ArschatProviderKind, string>;
    let liveCustomModels: Map<ArschatProviderKind, string[]>;
    let fetchCustomEndpointModels: jest.Mock<Promise<string[]>, [ArschatProviderKind, { signal?: AbortSignal }?]>;
    let updateCustomEndpointUrl: jest.Mock<Promise<string>, [ArschatProviderKind, string]>;
    let getModelsForProvider: jest.Mock<Promise<any[]>, [ArschatProviderKind]>;
    let setActiveCalls: Array<{ provider: ArschatProviderKind; model?: string }>;
    let sendRequestCalls: Array<{ sessionId: string; request: { text: string; displayText?: string; variables?: AIVariableResolutionRequest[] } }>;
    let executeCommand: jest.Mock;
    let openApiKeys: jest.Mock;
    let bottomExpanded: boolean;
    let bottomWidgets: Array<{ id: string; isVisible: boolean }>;
    let collapsePanel: jest.Mock;
    let expandPanel: jest.Mock;
    let activateBottomWidget: jest.Mock;
    let expandInputMock: jest.Mock;
    let agentToolRequests: ToolRequest[][];
    let uiInteractionService: ArschatUiInteractionService;

    beforeEach(async () => {
        registeredTools = new Map<string, ToolRequest>();
        setConfirmationModeCalls = [];
        setSessionConfirmationModeCalls = [];
        removedRequestIds = [];
        storeSessionsCalls = 0;
        storedSessions = [];
        fakeRequests = [];
        restoredRequests = [];
        restoredSessionId = undefined;
        recordedDurations = [];
        forgottenRequestIds = [];
        storedDurations = new Map<string, number>();
        activeProvider = 'anthropic';
        activeModel = '';
        customEndpointModels = new Map<ArschatProviderKind, string>([
            ['lmstudio', 'local-model'],
            ['unsloth', 'local-model']
        ]);
        customEndpointUrls = new Map<ArschatProviderKind, string>([
            ['lmstudio', 'http://localhost:1234/v1'],
            ['unsloth', 'http://localhost:8000/v1']
        ]);
        liveCustomModels = new Map<ArschatProviderKind, string[]>();
        setActiveCalls = [];
        sendRequestCalls = [];
        executeCommand = jest.fn();
        openApiKeys = jest.fn(async () => undefined);
        bottomExpanded = false;
        bottomWidgets = [];
        collapsePanel = jest.fn((area: string) => {
            if (area === 'bottom') {
                bottomExpanded = false;
            }
        });
        expandPanel = jest.fn((area: string) => {
            if (area === 'bottom') {
                bottomExpanded = true;
            }
        });
        activateBottomWidget = jest.fn((widget: { isVisible: boolean }) => {
            widget.isVisible = true;
        });
        expandInputMock = jest.fn(() => undefined);
        agentToolRequests = [];
        uiInteractionService = new ArschatUiInteractionService();
        fetchCustomEndpointModels = jest.fn(async (kind: ArschatProviderKind) => liveCustomModels.get(kind) ?? []);
        getModelsForProvider = jest.fn(async (_kind: ArschatProviderKind) => [] as any[]);
        updateCustomEndpointUrl = jest.fn(async (kind: ArschatProviderKind, rawUrl: string) => {
            const trimmed = rawUrl.trim();
            let parsed: URL;
            try {
                parsed = new URL(trimmed);
            } catch {
                throw new Error('URL must start with http:// or https://');
            }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                throw new Error('URL must start with http:// or https://');
            }
            if (parsed.search || parsed.hash) {
                throw new Error('URL must not include query parameters or fragments');
            }
            const path = parsed.pathname.replace(/\/+$/, '');
            parsed.pathname = /\/v1$/i.test(path) ? path : `${path}/v1`;
            const normalized = parsed.toString();
            customEndpointUrls.set(kind, normalized);
            return normalized;
        });
        const module = new ContainerModule(bind => {
            bind(ArschatApiKeysDialogService).toConstantValue({ open: openApiKeys } as unknown as ArschatApiKeysDialogService);
            // Minimal stubs: doInit() is async and fired from postConstruct, but render()
            // works off the widget's own fields, so a bare stub is enough for rendering.
            bind(CommandRegistry).toConstantValue({
                executeCommand
            } as unknown as CommandRegistry);
            bind(ApplicationShell).toConstantValue({
                isExpanded: (area: string) => area === 'bottom' ? bottomExpanded : false,
                getWidgets: (area: string) => area === 'bottom' ? bottomWidgets : [],
                collapsePanel,
                expandPanel,
                bottomPanel: {
                    activateWidget: activateBottomWidget
                }
            } as unknown as ApplicationShell);
            bind(ProviderSwitchService).toConstantValue({
                getActiveProvider: () => activeProvider,
                getActiveModel: () => activeModel,
                getModelsForProvider,
                resolveActiveModelId: () => undefined,
                setActive: async (provider: ArschatProviderKind, model?: string) => {
                    activeProvider = provider;
                    if (model !== undefined) {
                        activeModel = model;
                        if (provider === 'lmstudio' || provider === 'unsloth') {
                            customEndpointModels.set(provider, model);
                        }
                    }
                    setActiveCalls.push({ provider, model });
                    return undefined;
                },
                getCustomEndpointUrl: (kind: ArschatProviderKind) => customEndpointUrls.get(kind) ?? '',
                getCustomEndpointModel: (kind: ArschatProviderKind) => customEndpointModels.get(kind) ?? '',
                fetchCustomEndpointModels,
                updateCustomEndpointUrl,
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
                    return { id, model: { getRequests: () => restoredRequests } };
                },
                sendRequest: async (sessionId: string, request: { text: string; displayText?: string; variables?: AIVariableResolutionRequest[] }) => {
                    sendRequestCalls.push({ sessionId, request });
                    return {
                        requestCompleted: Promise.resolve({ id: `sent-${sendRequestCalls.length}` }),
                        responseCreated: Promise.resolve({
                            response: { content: [] },
                            isComplete: true,
                            isError: false,
                            isCanceled: false,
                            onDidChange: () => ({ dispose(): void { /* noop */ } })
                        }),
                        responseCompleted: Promise.resolve(undefined)
                    };
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
            bind(ChatAgentService).toConstantValue({
                getAgent: () => ({
                    setToolRequests: (tools: ToolRequest[]) => {
                        agentToolRequests.push(tools);
                    }
                })
            } as unknown as ChatAgentService);
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
                expandInput: expandInputMock,
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
                getFunction: (toolId: string) => registeredTools.get(toolId),
                getFunctions: (...toolIds: string[]) => toolIds
                    .map(toolId => registeredTools.get(toolId))
                    .filter((tool): tool is ToolRequest => !!tool)
            } as unknown as ToolInvocationRegistry);
            bind(ArschatUiInteractionService).toConstantValue(uiInteractionService);
            bind(ArschatChatWidget).toSelf();
        });
        const container = new Container();
        container.load(module);
        await act(async () => {
            widget = container.resolve<ArschatChatWidget>(ArschatChatWidget);
            await new Promise(resolve => setTimeout(resolve, 0));
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

    it('renders the terminal toggle button in the header', () => {
        const element = render(widget.render());
        expect(element.container.querySelector('#arschat-terminal-toggle-button')).toBeTruthy();
    });

    it('delegates to the Theia terminal toggle command when there is no bottom terminal', () => {
        const element = render(widget.render());
        const button = element.container.querySelector('#arschat-terminal-toggle-button') as HTMLButtonElement | null;
        expect(button).toBeTruthy();
        fireEvent.click(button!);
        expect(executeCommand).toHaveBeenCalledWith(TerminalCommands.TOGGLE_TERMINAL.id);
        expect(collapsePanel).not.toHaveBeenCalled();
        expect(expandPanel).not.toHaveBeenCalled();
        expect(activateBottomWidget).not.toHaveBeenCalled();
    });

    it('collapses the bottom panel directly when a terminal is already visible', () => {
        bottomExpanded = true;
        bottomWidgets = [{ id: 'terminal-0', isVisible: true }];

        const element = render(widget.render());
        const button = element.container.querySelector('#arschat-terminal-toggle-button') as HTMLButtonElement | null;
        expect(button).toBeTruthy();
        fireEvent.click(button!);
        expect(collapsePanel).toHaveBeenCalledWith('bottom');
        expect(executeCommand).not.toHaveBeenCalled();
        expect(expandPanel).not.toHaveBeenCalled();
        expect(activateBottomWidget).not.toHaveBeenCalled();
    });

    it('expands and activates an existing terminal when it is hidden or unselected', () => {
        bottomExpanded = true;
        bottomWidgets = [{ id: 'terminal-0', isVisible: false }];

        const element = render(widget.render());
        const button = element.container.querySelector('#arschat-terminal-toggle-button') as HTMLButtonElement | null;
        expect(button).toBeTruthy();
        fireEvent.click(button!);
        expect(expandPanel).toHaveBeenCalledWith('bottom');
        expect(activateBottomWidget).toHaveBeenCalledWith(bottomWidgets[0]);
        expect(executeCommand).not.toHaveBeenCalled();
        expect(collapsePanel).not.toHaveBeenCalled();
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

    it('does not render the pending attachment row when there are no images', () => {
        const element = render(widget.render());
        expect(element.container.querySelector('.arschat-attachments')).toBeFalsy();
    });

    it('renders pending pasted or dropped images as thumbnails above the input', () => {
        const first = pendingImage('one', 'image/png', 'one.png');
        const second = pendingImage('two', 'image/jpeg', 'two.jpg');
        asAny(widget).pendingImages = [first, second];

        const element = render(widget.render());
        const row = element.container.querySelector('.arschat-attachments');
        const thumbs = Array.from(element.container.querySelectorAll('img.arschat-attachment-thumb')) as HTMLImageElement[];

        expect(row).toBeTruthy();
        expect(row?.nextElementSibling?.classList.contains('arschat-chat-input-bar')).toBe(true);
        expect(element.container.querySelectorAll('.arschat-attachment')).toHaveLength(2);
        expect(thumbs.map(img => img.getAttribute('src'))).toEqual([first.previewUrl, second.previewUrl]);
        expect(thumbs.map(img => img.getAttribute('alt'))).toEqual(['one.png', 'two.jpg']);
    });

    it('removes only the clicked pending image and preserves typed input', () => {
        const first = pendingImage('one', 'image/png', 'one.png');
        const second = pendingImage('two', 'image/jpeg', 'two.jpg');
        asAny(widget).pendingImages = [first, second];
        asAny(widget).inputValue = 'typed draft';
        const updateSpy = jest.spyOn(widget, 'update').mockImplementation(() => undefined);

        try {
            const element = render(widget.render());
            const buttons = element.container.querySelectorAll('.arschat-attachment-remove');
            fireEvent.click(buttons[0]);
            element.rerender(widget.render());

            expect(updateSpy).toHaveBeenCalledTimes(1);
            expect(asAny(widget).pendingImages).toEqual([second]);
            expect(asAny(widget).inputValue).toBe('typed draft');
            const thumbs = Array.from(element.container.querySelectorAll('img.arschat-attachment-thumb')) as HTMLImageElement[];
            expect(thumbs).toHaveLength(1);
            expect(thumbs[0].getAttribute('src')).toBe(second.previewUrl);
        } finally {
            updateSpy.mockRestore();
        }
    });

    it('computes resize targets with a long-edge clamp', () => {
        expect(computeResizeTarget(2000, 1000, 1568)).toEqual({ width: 1568, height: 784, needsResize: true });
        expect(computeResizeTarget(1000, 2000, 1568)).toEqual({ width: 784, height: 1568, needsResize: true });
        expect(computeResizeTarget(1568, 1568, 1568)).toEqual({ width: 1568, height: 1568, needsResize: false });
        expect(computeResizeTarget(800, 600, 1568)).toEqual({ width: 800, height: 600, needsResize: false });
        expect(computeResizeTarget(10000, 10000, 1568)).toEqual({ width: 1568, height: 1568, needsResize: true });
        expect(computeResizeTarget(10000, 1, 1568)).toEqual({ width: 1568, height: 1, needsResize: true });
    });

    it('keeps invalid dimensions from dividing by zero', () => {
        expect(computeResizeTarget(0, 600, 1568)).toEqual({ width: 0, height: 600, needsResize: false });
        expect(computeResizeTarget(800, 0, 1568)).toEqual({ width: 800, height: 0, needsResize: false });
        expect(() => computeResizeTarget(800, 600, 0)).toThrow(/maxLongEdge/);
    });

    it('excludes GIF images from send-time resizing', () => {
        expect(shouldResizeImageMimeType('image/gif')).toBe(false);
        expect(shouldResizeImageMimeType('IMAGE/GIF; charset=binary')).toBe(false);
        expect(shouldResizeImageMimeType('image/png')).toBe(true);
    });

    it('resizes oversized images through Image and canvas', async () => {
        const restoreImage = installFakeImage(2000, 1000);
        const originalCreateElement = document.createElement.bind(document);
        const drawImage = jest.fn();
        const fakeCanvas = {
            width: 0,
            height: 0,
            getContext: jest.fn((contextId: string) => contextId === '2d' ? { drawImage } : null),
            toDataURL: jest.fn((type: string) => `data:${type};base64,RESIZED`)
        };
        const createElement = jest.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) =>
            tagName.toLowerCase() === 'canvas'
                ? fakeCanvas as unknown as HTMLElement
                : originalCreateElement(tagName, options)) as typeof document.createElement);

        try {
            const resized = await asAny(widget).resizeImageIfNeeded(pendingImage('ORIGINAL', 'image/jpeg', 'wide.jpg'));

            expect(fakeCanvas.width).toBe(1568);
            expect(fakeCanvas.height).toBe(784);
            expect(drawImage).toHaveBeenCalledTimes(1);
            expect(drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 1568, 784]);
            expect(fakeCanvas.toDataURL).toHaveBeenCalledWith('image/jpeg');
            expect(resized).toEqual({
                data: 'RESIZED',
                mimeType: 'image/jpeg',
                name: 'wide.jpg',
                previewUrl: 'data:image/jpeg;base64,RESIZED'
            });
        } finally {
            createElement.mockRestore();
            restoreImage();
        }
    });

    it('passes through images that are already within the limit', async () => {
        const restoreImage = installFakeImage(800, 600);
        const createElement = jest.spyOn(document, 'createElement');
        const original = pendingImage('SMALL', 'image/png', 'small.png');
        try {
            await expect(asAny(widget).resizeImageIfNeeded(original)).resolves.toBe(original);
            expect(createElement).not.toHaveBeenCalled();
        } finally {
            createElement.mockRestore();
            restoreImage();
        }
    });

    it('passes GIF images through without constructing Image or canvas', async () => {
        const originalImage = (global as any).Image;
        const imageCtor = jest.fn();
        (global as any).Image = imageCtor;
        const createElement = jest.spyOn(document, 'createElement');
        const gif = pendingImage('GIFDATA', 'image/gif', 'animated.gif');
        try {
            await expect(asAny(widget).resizeImageIfNeeded(gif)).resolves.toBe(gif);
            expect(imageCtor).not.toHaveBeenCalled();
            expect(createElement).not.toHaveBeenCalled();
        } finally {
            createElement.mockRestore();
            (global as any).Image = originalImage;
        }
    });

    it('clears pending images before awaiting send-time resize and sends image variables afterward', async () => {
        const img = pendingImage('ORIGINAL', 'image/png', 'large.png');
        asAny(widget).sessionId = 'sess-1';
        asAny(widget).inputValue = 'look';
        asAny(widget).pendingImages = [img];
        let resolveResize: (value: unknown) => void = () => undefined;
        const resizePromise = new Promise(resolve => { resolveResize = resolve; });
        const resizeSpy = jest.spyOn(asAny(widget), 'resizeImageIfNeeded').mockReturnValue(resizePromise);
        const updateSpy = jest.spyOn(widget, 'update').mockImplementation(() => undefined);
        const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);

        try {
            const sendPromise = asAny(widget).send();

            expect(asAny(widget).pendingImages).toEqual([]);
            expect(asAny(widget).messages[0].images).toEqual([img.previewUrl]);
            expect(sendRequestCalls).toHaveLength(0);
            expect(resizeSpy).toHaveBeenCalledWith(img);

            resolveResize(img);
            await sendPromise;

            expect(sendRequestCalls).toHaveLength(1);
            const variables = sendRequestCalls[0].request.variables ?? [];
            expect(variables).toHaveLength(1);
            expect(ImageContextVariable.parseRequest(variables[0])).toMatchObject({
                data: 'ORIGINAL',
                mimeType: 'image/png',
                name: 'large.png'
            });
        } finally {
            resizeSpy.mockRestore();
            updateSpy.mockRestore();
            consoleLog.mockRestore();
        }
    });

    it('sends original image data when send-time resize fails', async () => {
        const img = pendingImage('ORIGINAL', 'image/png', 'large.png');
        asAny(widget).sessionId = 'sess-1';
        asAny(widget).inputValue = 'look';
        asAny(widget).pendingImages = [img];
        const error = new Error('decode failed');
        const resizeSpy = jest.spyOn(asAny(widget), 'resizeImageIfNeeded').mockRejectedValue(error);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const updateSpy = jest.spyOn(widget, 'update').mockImplementation(() => undefined);

        try {
            await asAny(widget).send();

            expect(resizeSpy).toHaveBeenCalledWith(img);
            expect(warnSpy).toHaveBeenCalledWith('[arschat-chat] failed to resize image; sending original image data', error);
            expect(sendRequestCalls).toHaveLength(1);
            const variables = sendRequestCalls[0].request.variables ?? [];
            expect(variables).toHaveLength(1);
            expect(ImageContextVariable.parseRequest(variables[0])).toMatchObject({
                data: 'ORIGINAL',
                mimeType: 'image/png',
                name: 'large.png'
            });
        } finally {
            resizeSpy.mockRestore();
            warnSpy.mockRestore();
            consoleLog.mockRestore();
            updateSpy.mockRestore();
        }
    });

    it('uses the session captured before send-time resize completes', async () => {
        const img = pendingImage('ORIGINAL', 'image/png', 'large.png');
        asAny(widget).sessionId = 'sess-start';
        asAny(widget).inputValue = 'look';
        asAny(widget).pendingImages = [img];
        let resolveResize: (value: unknown) => void = () => undefined;
        const resizePromise = new Promise(resolve => { resolveResize = resolve; });
        const resizeSpy = jest.spyOn(asAny(widget), 'resizeImageIfNeeded').mockReturnValue(resizePromise);
        const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const updateSpy = jest.spyOn(widget, 'update').mockImplementation(() => undefined);

        try {
            const sendPromise = asAny(widget).send();
            asAny(widget).sessionId = 'sess-switched';

            resolveResize(img);
            await sendPromise;

            expect(sendRequestCalls).toHaveLength(1);
            expect(sendRequestCalls[0].sessionId).toBe('sess-start');
        } finally {
            resizeSpy.mockRestore();
            consoleLog.mockRestore();
            updateSpy.mockRestore();
        }
    });

    it('does not send when the selected model changes during send-time resize', async () => {
        const img = pendingImage('ORIGINAL', 'image/png', 'large.png');
        asAny(widget).sessionId = 'sess-1';
        asAny(widget).provider = 'anthropic';
        asAny(widget).model = 'claude-start';
        asAny(widget).inputValue = 'look';
        asAny(widget).pendingImages = [img];
        let resolveResize: (value: unknown) => void = () => undefined;
        const resizePromise = new Promise(resolve => { resolveResize = resolve; });
        const resizeSpy = jest.spyOn(asAny(widget), 'resizeImageIfNeeded').mockReturnValue(resizePromise);
        const updateSpy = jest.spyOn(widget, 'update').mockImplementation(() => undefined);

        try {
            const sendPromise = asAny(widget).send();
            asAny(widget).model = 'claude-next';

            resolveResize(img);
            await sendPromise;

            expect(sendRequestCalls).toHaveLength(0);
            expect(asAny(widget).sending).toBe(false);
        } finally {
            resizeSpy.mockRestore();
            updateSpy.mockRestore();
        }
    });

    it('gates UI tools on skill activation and keeps them sticky for the session', async () => {
        for (const id of [...ARSCHAT_BASE_TOOL_IDS, RENDER_UI_TOOL_ID]) {
            registerTool(id);
        }
        expandInputMock.mockReturnValueOnce({
            expanded: 'expanded ui prompt',
            display: '/ui make a form',
            skill: { id: 'ui', tools: [RENDER_UI_TOOL_ID] }
        });
        asAny(widget).sessionId = 'sess-1';
        asAny(widget).inputValue = '/ui make a form';
        const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const updateSpy = jest.spyOn(widget, 'update').mockImplementation(() => undefined);

        try {
            await asAny(widget).send();
            expect(sendRequestCalls[0].request.text).toBe('expanded ui prompt');
            expect(sendRequestCalls[0].request.displayText).toBe('/ui make a form');
            expect(agentToolRequests[agentToolRequests.length - 1].map(tool => tool.id)).toEqual([...ARSCHAT_BASE_TOOL_IDS, RENDER_UI_TOOL_ID]);

            expandInputMock.mockReturnValueOnce(undefined);
            asAny(widget).inputValue = 'follow-up';
            await asAny(widget).send();
            expect(sendRequestCalls[1].request.text).toBe('follow-up');
            expect(agentToolRequests[agentToolRequests.length - 1].map(tool => tool.id)).toEqual([...ARSCHAT_BASE_TOOL_IDS, RENDER_UI_TOOL_ID]);
        } finally {
            consoleLog.mockRestore();
            updateSpy.mockRestore();
        }
    });

    it('keeps UI tools out of the agent request when no UI skill has been activated', async () => {
        for (const id of [...ARSCHAT_BASE_TOOL_IDS, RENDER_UI_TOOL_ID]) {
            registerTool(id);
        }
        asAny(widget).sessionId = 'sess-1';
        asAny(widget).inputValue = 'plain prompt';
        const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const updateSpy = jest.spyOn(widget, 'update').mockImplementation(() => undefined);

        try {
            await asAny(widget).send();
            expect(agentToolRequests[agentToolRequests.length - 1].map(tool => tool.id)).toEqual(ARSCHAT_BASE_TOOL_IDS);
        } finally {
            consoleLog.mockRestore();
            updateSpy.mockRestore();
        }
    });

    it('clears sticky skill tools when loading a non-UI session', async () => {
        for (const id of [...ARSCHAT_BASE_TOOL_IDS, RENDER_UI_TOOL_ID]) {
            registerTool(id);
        }
        asAny(widget).activeSkillToolIds.add(RENDER_UI_TOOL_ID);
        restoredRequests = [{
            id: 'plain-req',
            request: { text: 'plain prompt', displayText: undefined },
            response: { response: { content: [] } }
        }];
        const updateSpy = jest.spyOn(widget, 'update').mockImplementation(() => undefined);

        try {
            await asAny(widget).loadSession('plain-session');
            expect(restoredSessionId).toBe('plain-session');
            expect(agentToolRequests[agentToolRequests.length - 1].map(tool => tool.id)).toEqual(ARSCHAT_BASE_TOOL_IDS);
        } finally {
            updateSpy.mockRestore();
        }
    });

    it('clears live UI session state when starting a new session', async () => {
        const pending = uiInteractionService.awaitLiveInteraction('live-1', 'tc-live');
        uiInteractionService.resolveLiveAction('live-1', 'start', {});
        await pending;
        expect(uiInteractionService.hasLiveSession('live-1')).toBe(true);
        const updateSpy = jest.spyOn(widget, 'update').mockImplementation(() => undefined);

        try {
            asAny(widget).startNewSession();
            expect(uiInteractionService.hasLiveSession('live-1')).toBe(false);
        } finally {
            updateSpy.mockRestore();
        }
    });

    it('clears live UI session state when loading another session', async () => {
        const pending = uiInteractionService.awaitLiveInteraction('live-1', 'tc-live');
        uiInteractionService.resolveLiveAction('live-1', 'start', {});
        await pending;
        restoredRequests = [];
        const updateSpy = jest.spyOn(widget, 'update').mockImplementation(() => undefined);

        try {
            await asAny(widget).loadSession('next-session');
            expect(uiInteractionService.hasLiveSession('live-1')).toBe(false);
        } finally {
            updateSpy.mockRestore();
        }
    });

    it('restores sticky UI tools when loading a session that activated /ui', async () => {
        for (const id of [...ARSCHAT_BASE_TOOL_IDS, RENDER_UI_TOOL_ID]) {
            registerTool(id);
        }
        expandInputMock.mockImplementation((input: string) => input.startsWith('/ui')
            ? { expanded: 'expanded ui prompt', display: input, skill: { id: 'ui', tools: [RENDER_UI_TOOL_ID] } }
            : undefined);
        restoredRequests = [{
            id: 'ui-req',
            request: { text: 'expanded ui prompt', displayText: '/ui make a form' },
            response: { response: { content: [] } }
        }];
        const updateSpy = jest.spyOn(widget, 'update').mockImplementation(() => undefined);

        try {
            await asAny(widget).loadSession('ui-session');
            expect(restoredSessionId).toBe('ui-session');
            expect(agentToolRequests[agentToolRequests.length - 1].map(tool => tool.id)).toEqual([...ARSCHAT_BASE_TOOL_IDS, RENDER_UI_TOOL_ID]);
        } finally {
            updateSpy.mockRestore();
        }
    });

    it('opens the API key dialog from the header without a focus-dependent command', () => {
        const ui = render(asAny(widget).render());
        fireEvent.click(ui.getByRole('button', { name: 'API キー' }));
        expect(openApiKeys).toHaveBeenCalledTimes(1);
        expect(executeCommand).not.toHaveBeenCalled();
        const button = ui.getByRole('button', { name: 'API キー' });
        expect(button.previousElementSibling?.id).toBe('arschat-terminal-toggle-button');
    });

    it('builds OpenAI-compatible /models URLs and parses model ids', () => {
        expect(buildOpenAiModelsUrl('http://localhost:1234')).toBe('http://localhost:1234/v1/models');
        expect(buildOpenAiModelsUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234/v1/models');
        expect(buildOpenAiModelsUrl('http://localhost:1234/openai')).toBe('http://localhost:1234/openai/v1/models');
        expect(parseOpenAiModelIds({
            data: [
                { id: 'qwen/qwen3' },
                { id: 'llama-3' },
                { id: 'qwen/qwen3' },
                { id: '' },
                { object: 'model' }
            ]
        })).toEqual(['qwen/qwen3', 'llama-3']);
        expect(() => buildOpenAiModelsUrl('localhost:1234')).toThrow(/http/);
        expect(() => buildOpenAiModelsUrl('http://localhost:1234/v1?x=1')).toThrow(/query parameters or fragments/);
        expect(() => buildOpenAiModelsUrl('http://localhost:1234/v1#models')).toThrow(/query parameters or fragments/);
        expect(() => parseOpenAiModelIds({ data: {} })).toThrow(/data array/);
    });

    it('sends custom endpoint API keys when fetching /models', async () => {
        const service = new ProviderSwitchService() as any;
        service.preferenceService = {
            get: () => [{
                id: 'unsloth',
                model: 'local-model',
                url: 'http://localhost:8000/v1',
                apiKey: '  sk-unsloth-test  '
            }]
        };
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({ data: [] })
        }));
        const originalFetch = global.fetch;
        (global as any).fetch = fetchMock;
        try {
            await service.fetchCustomEndpointModels('unsloth', { timeoutMs: 1000 });
            expect(fetchMock).toHaveBeenCalledWith('http://localhost:8000/v1/models', expect.objectContaining({
                headers: { Authorization: 'Bearer sk-unsloth-test' }
            }));
        } finally {
            (global as any).fetch = originalFetch;
        }
    });

    it('sends the global OpenAI API key when a custom endpoint sets apiKey: true', async () => {
        // Theia semantics: `apiKey: true` means "use the global OpenAI API key"
        // (ai-features.openAiOfficial.openAiApiKey), not a literal key string.
        const service = new ProviderSwitchService() as any;
        service.preferenceService = {
            get: (key: string, defaultValue?: unknown) => {
                if (key === OPENAI_CUSTOM_ENDPOINTS_PREF) {
                    return [{ id: 'unsloth', model: 'local-model', url: 'http://localhost:8000/v1', apiKey: true }];
                }
                if (key === 'ai-features.openAiOfficial.openAiApiKey') {
                    return '  sk-global-key  ';
                }
                return defaultValue;
            }
        };
        const fetchMock = jest.fn(async () => ({
            ok: true,
            json: async () => ({ data: [] })
        }));
        const originalFetch = global.fetch;
        (global as any).fetch = fetchMock;
        try {
            await service.fetchCustomEndpointModels('unsloth', { timeoutMs: 1000 });
            expect(fetchMock).toHaveBeenCalledWith('http://localhost:8000/v1/models', expect.objectContaining({
                headers: { Authorization: 'Bearer sk-global-key' }
            }));
        } finally {
            (global as any).fetch = originalFetch;
        }
    });

    it('serializes concurrent custom endpoint updates so neither provider\'s write is lost', async () => {
        // LM Studio and Unsloth share ONE preference array (customOpenAiModels).
        // Two concurrent read-modify-write updates must not both read the old array
        // and have the last write revert the other provider's change (lost update).
        let stored: any[] = [];
        const pendingWrites: Array<{ value: any[]; resolve: () => void }> = [];
        const service = new ProviderSwitchService() as any;
        service.preferenceService = {
            get: (key: string, defaultValue?: unknown) => key === OPENAI_CUSTOM_ENDPOINTS_PREF ? stored : defaultValue,
            updateValue: jest.fn((_key: string, value: any[]) => new Promise<void>(resolve => {
                pendingWrites.push({ value, resolve: () => { stored = value; resolve(); } });
            }))
        };

        const lmstudioUpdate = service.updateCustomEndpointUrl('lmstudio', 'http://192.168.1.149:1234');
        const unslothUpdate = service.updateCustomEndpointUrl('unsloth', 'http://localhost:9999');
        await Promise.resolve();

        // Only the first update's write started; the second is queued behind it and
        // will re-read the array only after the first write has landed.
        expect(pendingWrites).toHaveLength(1);
        pendingWrites[0].resolve();
        await lmstudioUpdate;
        for (let i = 0; i < 10 && pendingWrites.length < 2; i++) {
            await Promise.resolve();
        }
        expect(pendingWrites).toHaveLength(2);
        pendingWrites[1].resolve();
        await unslothUpdate;

        // Both providers' changes survive in the final shared array.
        expect(stored).toHaveLength(2);
        expect(stored).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'lmstudio', url: 'http://192.168.1.149:1234/v1' }),
            expect.objectContaining({ id: 'unsloth', url: 'http://localhost:9999/v1' })
        ]));
    });

    it('serializes setActive so a slow old call cannot revert a newer selection to a mixed state', async () => {
        // setActive writes PREF_ACTIVE_PROVIDER, then the endpoint model, then
        // PREF_ACTIVE_MODEL. Without serialization, an old setActive('lmstudio',
        // 'qwen') resuming after a newer setActive('anthropic', 'claude') completed
        // would land provider='anthropic' + model='qwen'. The service-side chain
        // must make the last-called selection land last.
        const prefs = new Map<string, unknown>();
        const pendingSets: Array<{ key: string; value: unknown; resolve: () => void }> = [];
        const service = new ProviderSwitchService() as any;
        service.preferenceService = {
            get: (key: string, defaultValue?: unknown) => prefs.has(key) ? prefs.get(key) : defaultValue,
            set: jest.fn((key: string, value: unknown) => new Promise<void>(resolve => {
                pendingSets.push({ key, value, resolve: () => { prefs.set(key, value); resolve(); } });
            })),
            updateValue: jest.fn(async (key: string, value: unknown) => { prefs.set(key, value); })
        };
        service.settingsService = { updateAgentSettings: jest.fn(async () => undefined) };
        service.languageModelRegistry = { getLanguageModels: jest.fn(async () => []) };
        service.logger = { info: jest.fn(), warn: jest.fn() };
        const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

        const oldCall = service.setActive('lmstudio', 'qwen');
        const newCall = service.setActive('anthropic', 'claude');
        await flush();

        // The old call's provider write is pending (its resolution is manually
        // deferred = the "slow" call); the new call is queued behind it and has
        // not written anything yet.
        expect(pendingSets.map(w => [w.key, w.value])).toEqual([[PREF_ACTIVE_PROVIDER, 'lmstudio']]);
        pendingSets[0].resolve();
        await flush();
        expect(pendingSets[1]).toMatchObject({ key: PREF_ACTIVE_MODEL, value: 'qwen' });
        pendingSets[1].resolve();
        await flush();
        await oldCall;

        // Only now does the newer call run; resolving its writes lands the final state.
        await flush();
        expect(pendingSets[2]).toMatchObject({ key: PREF_ACTIVE_PROVIDER, value: 'anthropic' });
        pendingSets[2].resolve();
        await flush();
        expect(pendingSets[3]).toMatchObject({ key: PREF_ACTIVE_MODEL, value: 'claude' });
        pendingSets[3].resolve();
        await newCall;

        // No mixed provider/model state: the newest selection is what persists.
        expect(prefs.get(PREF_ACTIVE_PROVIDER)).toBe('anthropic');
        expect(prefs.get(PREF_ACTIVE_MODEL)).toBe('claude');
    });

    it('queues a listener-driven applyActiveSelection behind an in-flight setActive', async () => {
        // The preference-change listener calls applyActiveSelection() outside
        // setActive's own body. Fired between setActive('anthropic', 'claude')'s
        // provider write and model write, it would read the mixed intermediate
        // state (provider='anthropic' + stale model='qwen') and could land that on
        // the agent/onDidChange AFTER the final application. The queued wrapper
        // must defer it until the whole setActive run has finished.
        const prefs = new Map<string, unknown>([
            [PREF_ACTIVE_PROVIDER, 'lmstudio'],
            [PREF_ACTIVE_MODEL, 'qwen']
        ]);
        const pendingSets: Array<{ key: string; value: unknown; resolve: () => void }> = [];
        const updateAgentSettings = jest.fn(async () => undefined);
        const service = new ProviderSwitchService() as any;
        service.preferenceService = {
            get: (key: string, defaultValue?: unknown) => prefs.has(key) ? prefs.get(key) : defaultValue,
            set: jest.fn((key: string, value: unknown) => new Promise<void>(resolve => {
                pendingSets.push({ key, value, resolve: () => { prefs.set(key, value); resolve(); } });
            })),
            updateValue: jest.fn(async (key: string, value: unknown) => { prefs.set(key, value); })
        };
        service.settingsService = { updateAgentSettings };
        service.languageModelRegistry = { getLanguageModels: jest.fn(async () => []) };
        service.logger = { info: jest.fn(), warn: jest.fn() };
        service.agentId = 'ArsChat';
        service.agentInstance = { languageModelRequirements: [] };
        const fired: any[] = [];
        service.onDidChange((selection: any) => { fired.push(selection); });
        const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

        const setActiveCall = service.setActive('anthropic', 'claude');
        await flush();
        expect(pendingSets[0]).toMatchObject({ key: PREF_ACTIVE_PROVIDER, value: 'anthropic' });
        pendingSets[0].resolve();
        await flush();

        // Mid-run (provider written, model not yet): the listener fires. It must
        // NOT apply the mixed anthropic/qwen state now (or ever, last).
        const listenerApply = service.applyActiveSelection();
        await flush();
        expect(fired).toHaveLength(0);
        expect(updateAgentSettings).not.toHaveBeenCalled();

        expect(pendingSets[1]).toMatchObject({ key: PREF_ACTIVE_MODEL, value: 'claude' });
        pendingSets[1].resolve();
        await setActiveCall;
        const listenerSelection = await listenerApply;

        // Both applications ran after the writes finished; nothing ever saw or
        // published the stale intermediate model, and the LAST application is the
        // final anthropic/claude selection.
        expect(fired.length).toBeGreaterThanOrEqual(2);
        expect(fired.every(s => s.model === 'claude' && s.provider === 'anthropic')).toBe(true);
        expect(fired[fired.length - 1]).toEqual({ provider: 'anthropic', model: 'claude', modelId: 'anthropic/claude' });
        expect(listenerSelection).toEqual({ provider: 'anthropic', model: 'claude', modelId: 'anthropic/claude' });
        const requirements = updateAgentSettings.mock.calls.map((call: any[]) => call[1].languageModelRequirements[0].identifier);
        expect(requirements.every((id: string) => id === 'anthropic/claude')).toBe(true);
        expect(requirements[requirements.length - 1]).toBe('anthropic/claude');
    });

    it('uses the fixed provider custom endpoint model before stale active model preference values', async () => {
        const preferences = new Map<string, unknown>([
            [PREF_ACTIVE_PROVIDER, 'lmstudio'],
            [PREF_ACTIVE_MODEL, 'claude-3-5-sonnet'],
            [OPENAI_CUSTOM_ENDPOINTS_PREF, [{
                id: 'lmstudio',
                model: 'qwen/qwen3',
                url: 'http://localhost:1234/v1'
            }]]
        ]);
        const service = new ProviderSwitchService() as any;
        service.preferenceService = {
            get: (key: string, defaultValue: unknown) => preferences.has(key) ? preferences.get(key) : defaultValue
        };
        service.settingsService = { updateAgentSettings: jest.fn(async () => undefined) };
        service.languageModelRegistry = { getLanguageModels: jest.fn(async () => []) };
        service.logger = { info: jest.fn(), warn: jest.fn() };

        let fired: any;
        service.onDidChange((selection: unknown) => { fired = selection; });
        const selection = await service.applyActiveSelection();

        expect(selection).toEqual({ provider: 'lmstudio', model: 'qwen/qwen3', modelId: 'lmstudio' });
        expect(fired).toEqual(selection);
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

    function pendingImage(data: string, mimeType = 'image/png', name = 'image.png') {
        return { data, mimeType, name, previewUrl: `data:${mimeType};base64,${data}` };
    }

    function installFakeImage(width: number, height: number): () => void {
        const originalImage = (global as any).Image;
        class FakeImage {
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            naturalWidth = width;
            naturalHeight = height;
            width = width;
            height = height;

            set src(_src: string) {
                queueMicrotask(() => this.onload?.());
            }
        }
        (global as any).Image = FakeImage;
        return () => {
            (global as any).Image = originalImage;
        };
    }

    /** Register a fake tool so the widget's ToolInvocationRegistry lookup resolves. */
    function registerTool(id: string, confirmAlwaysAllow?: boolean | string): void {
        registeredTools.set(id, {
            id, name: id, confirmAlwaysAllow,
            handler: async () => '', parameters: { type: 'object', properties: {} }
        } as unknown as ToolRequest);
    }

    it('suppresses textarea update during IME composition', () => {
        // Spy the base-class render (super.update): the override defers it while composing.
        const superUpdate = jest.spyOn(ReactWidget.prototype, 'update').mockImplementation(() => undefined);
        superUpdate.mockClear();
        asAny(widget).onInputCompositionStart();
        asAny(widget).onInputChange('に');
        expect(asAny(widget).inputValue).toBe('に');
        expect(superUpdate).not.toHaveBeenCalled();
        expect(asAny(widget).pendingUpdateWhileComposing).toBe(true);
        superUpdate.mockRestore();
    });

    it('updates the mounted chat textarea when a suggestion sets input programmatically', () => {
        const element = render(widget.render());
        const textarea = element.container.querySelector('#arschat-chat-input') as HTMLTextAreaElement | null;
        expect(textarea).toBeTruthy();
        const updateSpy = jest.spyOn(widget, 'update').mockImplementation(() => undefined);

        try {
            asAny(widget).selectSuggestion({ id: 'ask', trigger: '/ask', name: 'Ask', description: 'Ask' });

            expect(updateSpy).toHaveBeenCalledTimes(1);
            expect(asAny(widget).inputValue).toBe('/ask ');
            expect(textarea!.value).toBe('/ask ');
        } finally {
            updateSpy.mockRestore();
        }
    });

    it('does not overwrite user-typed chat textarea DOM value on rerender', () => {
        const element = render(widget.render());
        const textarea = element.container.querySelector('#arschat-chat-input') as HTMLTextAreaElement | null;
        expect(textarea).toBeTruthy();
        textarea!.value = '譌･譛ｬ隱槫・蜉帙・途荳ｭ';
        expect(asAny(widget).inputValue).toBe('');
        const superUpdate = jest.spyOn(ReactWidget.prototype, 'update').mockImplementation(() => undefined);

        try {
            widget.update();
            element.rerender(widget.render());

            expect(superUpdate).toHaveBeenCalledTimes(1);
            expect(textarea!.value).toBe('譌･譛ｬ隱槫・蜉帙・途荳ｭ');
            expect(asAny(widget).inputValue).toBe('');
        } finally {
            superUpdate.mockRestore();
        }
    });

    it('defers async-path renders during IME composition and flushes them once composing ends', () => {
        // Any path (refreshLiveCustomModels completing, switchService.onDidChange,
        // persona/skill updates, streaming) that calls update() directly while an IME
        // composition is in flight must be coalesced, not re-render the textarea (e-48).
        const superUpdate = jest.spyOn(ReactWidget.prototype, 'update').mockImplementation(() => undefined);
        asAny(widget).onInputCompositionStart();
        superUpdate.mockClear();
        widget.update();
        widget.update();
        expect(superUpdate).not.toHaveBeenCalled();
        expect(asAny(widget).pendingUpdateWhileComposing).toBe(true);
        // Ending the composition flushes exactly one coalesced render.
        asAny(widget).flushComposingUpdate();
        expect(asAny(widget).composing).toBe(false);
        expect(asAny(widget).pendingUpdateWhileComposing).toBe(false);
        expect(superUpdate).toHaveBeenCalledTimes(1);
        superUpdate.mockRestore();
    });

    it('syncs and updates the input when IME composition ends', () => {
        const updateSpy = jest.spyOn(widget, 'update').mockImplementation(() => undefined);
        updateSpy.mockClear();
        asAny(widget).composing = true;
        asAny(widget).onInputCompositionEnd({ currentTarget: { value: '日本語' } });
        expect(asAny(widget).inputValue).toBe('日本語');
        expect(updateSpy).toHaveBeenCalledTimes(1);
        updateSpy.mockRestore();
    });

    it('does not send on IME Enter but still sends on normal Enter', () => {
        const send = jest.fn();
        asAny(widget).send = send;
        asAny(widget).onInputKeyDown({
            key: 'Enter',
            shiftKey: false,
            keyCode: 13,
            nativeEvent: { isComposing: true },
            preventDefault: jest.fn()
        });
        asAny(widget).onInputKeyDown({
            key: 'Enter',
            shiftKey: false,
            keyCode: 229,
            nativeEvent: { isComposing: false },
            preventDefault: jest.fn()
        });
        expect(send).not.toHaveBeenCalled();

        const preventDefault = jest.fn();
        asAny(widget).onInputKeyDown({
            key: 'Enter',
            shiftKey: false,
            keyCode: 13,
            nativeEvent: { isComposing: false },
            preventDefault
        });
        expect(preventDefault).toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('shows live LM Studio models in the dropdown', async () => {
        liveCustomModels.set('lmstudio', ['qwen/qwen3', 'llama-3']);
        await act(async () => {
            await asAny(widget).onProviderChange('lmstudio');
        });
        const element = render(widget.render());
        const options = Array.from(element.container.querySelectorAll('#arschat-model-select option')).map(o => o.textContent);
        expect(options).toEqual(['qwen/qwen3', 'llama-3']);
        expect(asAny(widget).model).toBe('qwen/qwen3');
        expect(setActiveCalls[setActiveCalls.length - 1]).toEqual({ provider: 'lmstudio', model: 'qwen/qwen3' });
    });

    it('updates the mounted custom endpoint input when switching custom providers', () => {
        asAny(widget).provider = 'lmstudio';
        asAny(widget).syncCustomEndpointState('lmstudio');
        const element = render(widget.render());
        const input = element.container.querySelector('#arschat-custom-endpoint-url') as HTMLInputElement | null;
        expect(input).toBeTruthy();
        expect(input!.value).toBe('http://localhost:1234/v1');

        customEndpointUrls.set('unsloth', 'http://localhost:9999/v1');
        asAny(widget).provider = 'unsloth';
        asAny(widget).syncCustomEndpointState('unsloth');

        expect(asAny(widget).customEndpointDraft).toBe('http://localhost:9999/v1');
        expect(input!.value).toBe('http://localhost:9999/v1');
    });

    it('shows a disabled connection failure option when live model fetch fails', async () => {
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        fetchCustomEndpointModels.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        await act(async () => {
            await asAny(widget).onProviderChange('lmstudio');
        });
        const element = render(widget.render());
        const option = element.container.querySelector('#arschat-model-select option') as HTMLOptionElement | null;
        expect(option?.textContent).toBe('(接続できません)');
        expect(option?.disabled).toBe(true);
        expect(consoleError).toHaveBeenCalled();
        consoleError.mockRestore();
    });

    it('does not persist the previous provider model when a custom provider fetch fails', async () => {
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        activeModel = 'claude-3-5-sonnet';
        asAny(widget).model = 'claude-3-5-sonnet';
        fetchCustomEndpointModels.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        await act(async () => {
            await asAny(widget).onProviderChange('lmstudio');
        });
        expect(setActiveCalls).not.toContainEqual({ provider: 'lmstudio', model: 'claude-3-5-sonnet' });
        expect(customEndpointModels.get('lmstudio')).toBe('local-model');
        expect(asAny(widget).model).toBe('local-model');
        consoleError.mockRestore();
    });

    it('drops stale live model fetch results for the same provider and URL generation', async () => {
        let resolveOld: (names: string[]) => void = () => undefined;
        let resolveNew: (names: string[]) => void = () => undefined;
        const oldFetch = new Promise<string[]>(resolve => { resolveOld = resolve; });
        const newFetch = new Promise<string[]>(resolve => { resolveNew = resolve; });
        fetchCustomEndpointModels
            .mockImplementationOnce(async () => oldFetch)
            .mockImplementationOnce(async () => newFetch);

        asAny(widget).provider = 'lmstudio';
        customEndpointUrls.set('lmstudio', 'http://localhost:1234/v1');
        let oldRefresh: Promise<void>;
        await act(async () => {
            oldRefresh = asAny(widget).refreshLiveCustomModels('lmstudio');
            await Promise.resolve();
        });

        customEndpointUrls.set('lmstudio', 'http://192.168.1.149:1234/v1');
        let newRefresh: Promise<void>;
        await act(async () => {
            newRefresh = asAny(widget).refreshLiveCustomModels('lmstudio');
            await Promise.resolve();
        });
        expect(fetchCustomEndpointModels.mock.calls[0][1]?.signal?.aborted).toBe(true);

        await act(async () => {
            resolveNew(['new-model']);
            await newRefresh!;
        });
        await act(async () => {
            resolveOld(['old-model']);
            await oldRefresh!;
        });

        expect(asAny(widget).liveCustomModelsByProvider.get('lmstudio')).toEqual(['new-model']);
        expect(asAny(widget).model).toBe('new-model');
        expect(setActiveCalls).toContainEqual({ provider: 'lmstudio', model: 'new-model' });
        expect(setActiveCalls).not.toContainEqual({ provider: 'lmstudio', model: 'old-model' });
    });

    it('aborts live custom model requests for providers left by a provider switch', async () => {
        let lmstudioSignal: AbortSignal | undefined;
        let resolveLmstudio: (names: string[]) => void = () => undefined;
        fetchCustomEndpointModels
            .mockImplementationOnce(async (_kind, options) => {
                lmstudioSignal = options?.signal;
                return new Promise<string[]>(resolve => { resolveLmstudio = resolve; });
            })
            .mockImplementationOnce(async () => ['unsloth-model']);

        asAny(widget).provider = 'lmstudio';
        let oldRefresh: Promise<void>;
        await act(async () => {
            oldRefresh = asAny(widget).refreshLiveCustomModels('lmstudio');
            await Promise.resolve();
        });

        await act(async () => {
            await asAny(widget).onProviderChange('unsloth');
        });

        expect(lmstudioSignal?.aborted).toBe(true);
        await act(async () => {
            resolveLmstudio(['stale-model']);
            await oldRefresh!;
        });
        expect(asAny(widget).liveCustomModelsByProvider.get('lmstudio')).toBeUndefined();
        expect(setActiveCalls).not.toContainEqual({ provider: 'lmstudio', model: 'stale-model' });
    });

    it('aborts and clears live custom model requests on dispose without updating after disposal', async () => {
        let resolveFetch: (names: string[]) => void = () => undefined;
        let signal: AbortSignal | undefined;
        fetchCustomEndpointModels.mockImplementationOnce(async (_kind, options) => {
            signal = options?.signal;
            return new Promise<string[]>(resolve => { resolveFetch = resolve; });
        });
        const updateSpy = jest.spyOn(widget, 'update');

        asAny(widget).provider = 'lmstudio';
        let refresh: Promise<void>;
        await act(async () => {
            refresh = asAny(widget).refreshLiveCustomModels('lmstudio');
            await Promise.resolve();
        });
        updateSpy.mockClear();

        widget.dispose();
        expect(signal?.aborted).toBe(true);
        expect(asAny(widget).liveCustomModelAbortControllers.size).toBe(0);

        await act(async () => {
            resolveFetch(['late-model']);
            await refresh!;
        });
        expect(updateSpy).not.toHaveBeenCalled();
        expect(asAny(widget).liveCustomModelsByProvider.get('lmstudio')).toBeUndefined();
        updateSpy.mockRestore();
    });

    it('updates the LM Studio endpoint URL with /v1 completion and refetches models', async () => {
        liveCustomModels.set('lmstudio', ['old-model']);
        await act(async () => {
            await asAny(widget).onProviderChange('lmstudio');
        });
        fetchCustomEndpointModels.mockClear();
        liveCustomModels.set('lmstudio', ['new-model']);
        asAny(widget).customEndpointDraft = 'http://192.168.1.149:1234';
        await act(async () => {
            await asAny(widget).commitCustomEndpointUrl();
        });
        expect(updateCustomEndpointUrl).toHaveBeenLastCalledWith('lmstudio', 'http://192.168.1.149:1234');
        expect(customEndpointUrls.get('lmstudio')).toBe('http://192.168.1.149:1234/v1');
        expect(fetchCustomEndpointModels).toHaveBeenCalledWith('lmstudio', expect.objectContaining({ signal: expect.any(Object) }));
        expect(asAny(widget).model).toBe('new-model');
    });

    it('does not mix a URL commit into a provider selected after the commit started', async () => {
        let resolveCommit: (url: string) => void = () => undefined;
        updateCustomEndpointUrl.mockImplementationOnce(async (kind: ArschatProviderKind) => new Promise<string>(resolve => {
            resolveCommit = url => {
                customEndpointUrls.set(kind, url);
                resolve(url);
            };
        }));

        asAny(widget).provider = 'lmstudio';
        asAny(widget).customEndpointDraft = 'http://192.168.1.149:1234';
        let commit: Promise<void>;
        await act(async () => {
            commit = asAny(widget).commitCustomEndpointUrl();
            await Promise.resolve();
        });
        asAny(widget).provider = 'unsloth';
        asAny(widget).customEndpointDraft = 'http://localhost:8000/v1';

        await act(async () => {
            resolveCommit('http://192.168.1.149:1234/v1');
            await commit!;
        });

        expect(updateCustomEndpointUrl).toHaveBeenLastCalledWith('lmstudio', 'http://192.168.1.149:1234');
        expect(customEndpointUrls.get('lmstudio')).toBe('http://192.168.1.149:1234/v1');
        expect(asAny(widget).customEndpointDraft).toBe('http://localhost:8000/v1');
        expect(fetchCustomEndpointModels).not.toHaveBeenCalled();
    });

    it('serializes same-provider URL commits so a slow old write cannot revert a newer one', async () => {
        // Re-edit + re-commit the URL for the same provider while the first write is
        // still in flight. The writes must land in start order (new one last), so the
        // backing preference keeps the NEW URL, and only the new commit refetches.
        let resolveOld: (url: string) => void = () => undefined;
        updateCustomEndpointUrl.mockImplementationOnce(async (kind: ArschatProviderKind) => new Promise<string>(resolve => {
            resolveOld = url => { customEndpointUrls.set(kind, url); resolve(url); };
        }));

        asAny(widget).provider = 'lmstudio';
        asAny(widget).customEndpointDraft = 'http://old:1234';
        let oldCommit: Promise<void>;
        await act(async () => {
            oldCommit = asAny(widget).commitCustomEndpointUrl();
            await Promise.resolve();
        });
        asAny(widget).customEndpointDraft = 'http://new:1234';
        let newCommit: Promise<void>;
        await act(async () => {
            newCommit = asAny(widget).commitCustomEndpointUrl();
            await Promise.resolve();
        });
        // The new commit's write is queued behind the in-flight old write, not raced.
        expect(updateCustomEndpointUrl).toHaveBeenCalledTimes(1);

        await act(async () => {
            resolveOld('http://old:1234/v1');
            await Promise.all([oldCommit!, newCommit!]);
        });

        // The old (stale) commit's UI effects were dropped; the new write ran last,
        // so the stored URL is the new one - not reverted by the slow old commit.
        expect(updateCustomEndpointUrl).toHaveBeenCalledTimes(2);
        expect(updateCustomEndpointUrl).toHaveBeenLastCalledWith('lmstudio', 'http://new:1234');
        expect(customEndpointUrls.get('lmstudio')).toBe('http://new:1234/v1');
        expect(asAny(widget).customEndpointDraft).toBe('http://new:1234/v1');
        expect(fetchCustomEndpointModels).toHaveBeenCalledTimes(1);
    });

    it('does not treat an in-flight LM Studio commit as stale when an Unsloth commit runs concurrently', async () => {
        // Commit tokens are per provider: a commit for another provider must not
        // supersede an in-flight commit for this one.
        let resolveLmstudio: (url: string) => void = () => undefined;
        updateCustomEndpointUrl.mockImplementationOnce(async (kind: ArschatProviderKind) => new Promise<string>(resolve => {
            resolveLmstudio = url => { customEndpointUrls.set(kind, url); resolve(url); };
        }));

        asAny(widget).provider = 'lmstudio';
        asAny(widget).customEndpointDraft = 'http://192.168.1.149:1234';
        let lmstudioCommit: Promise<void>;
        await act(async () => {
            lmstudioCommit = asAny(widget).commitCustomEndpointUrl();
            await Promise.resolve();
        });

        // A concurrent Unsloth commit starts and completes first.
        asAny(widget).provider = 'unsloth';
        asAny(widget).customEndpointDraft = 'http://localhost:9999';
        await act(async () => {
            await asAny(widget).commitCustomEndpointUrl();
        });
        expect(customEndpointUrls.get('unsloth')).toBe('http://localhost:9999/v1');

        // The user is back on LM Studio when its slow write resolves: the commit is
        // still the latest for ITS provider, so draft + refetch must apply normally.
        asAny(widget).provider = 'lmstudio';
        fetchCustomEndpointModels.mockClear();
        await act(async () => {
            resolveLmstudio('http://192.168.1.149:1234/v1');
            await lmstudioCommit!;
        });

        expect(asAny(widget).customEndpointDraft).toBe('http://192.168.1.149:1234/v1');
        expect(customEndpointUrls.get('lmstudio')).toBe('http://192.168.1.149:1234/v1');
        expect(fetchCustomEndpointModels).toHaveBeenCalledWith('lmstudio', expect.objectContaining({ signal: expect.any(Object) }));
    });

    it('does not let an overtaken onProviderChange clobber the newer provider selection', async () => {
        // onProviderChange('lmstudio') suspends in refreshModels; the user switches
        // to anthropic meanwhile. When the lmstudio run resumes it must bail out
        // instead of clearing the model / driving setActive for the stale kind.
        let releaseLmstudioRefresh: () => void = () => undefined;
        getModelsForProvider.mockImplementationOnce(async () => new Promise<any[]>(resolve => {
            releaseLmstudioRefresh = () => resolve([]);
        }));

        let lmstudioChange: Promise<void>;
        await act(async () => {
            lmstudioChange = asAny(widget).onProviderChange('lmstudio');
            await Promise.resolve();
        });

        // Overtaken by a switch to anthropic that completes first.
        await act(async () => {
            await asAny(widget).onProviderChange('anthropic');
        });
        asAny(widget).model = 'claude-3-5-sonnet';
        setActiveCalls.length = 0;
        fetchCustomEndpointModels.mockClear();

        await act(async () => {
            releaseLmstudioRefresh();
            await lmstudioChange!;
        });

        // The stale lmstudio run left the current (anthropic) selection untouched.
        expect(asAny(widget).provider).toBe('anthropic');
        expect(asAny(widget).model).toBe('claude-3-5-sonnet');
        expect(setActiveCalls).toEqual([]);
        expect(fetchCustomEndpointModels).not.toHaveBeenCalled();
    });

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

    it('auto-confirms UI tools if Theia confirmation is requested anyway', async () => {
        const tc = new ToolCallChatResponseContentImpl('tc-ui-confirm', RENDER_UI_TOOL_ID, '{}', false, undefined);
        const confirmedProbe = tc.confirmed;
        const msg: any = { id: 1, author: 'assistant', text: '', streaming: true };
        asAny(widget).syncToolCalls(msg, fakeResponseWith(tc));
        tc.requestUserConfirmation();
        await expect(confirmedProbe).resolves.toBe(true);
        expect(msg.toolCalls[0].state).toBe('running');
    });

    it('renders arschat_render_ui as a form and resolves submitted data as the tool result path', async () => {
        const block = {
            id: 'survey',
            mode: 'default',
            title: 'Survey',
            state: { form: { name: '' } },
            root: {
                primitive: 'box',
                children: [
                    { primitive: 'input', bind: 'form.name', props: { inputId: 'name-input', placeholder: 'Name' } }
                ]
            },
            actions: [{ type: 'submit', label: 'Send', variant: 'primary' }]
        };
        const tc = new ToolCallChatResponseContentImpl('tc-ui', RENDER_UI_TOOL_ID, JSON.stringify(block), false, undefined);
        const msg: any = { id: 1, author: 'assistant', text: '', streaming: true };
        asAny(widget).syncToolCalls(msg, fakeResponseWith(tc));
        asAny(widget).messages = [msg];
        const pending = uiInteractionService.awaitInteraction('tc-ui');

        const element = render(widget.render());
        const input = element.container.querySelector('#name-input') as HTMLInputElement | null;
        expect(input).toBeTruthy();
        fireEvent.change(input!, { target: { value: 'Ada' } });
        fireEvent.click(element.getByText('Send'));

        await expect(pending).resolves.toEqual({
            uiId: 'survey',
            action: 'submit',
            data: { form: { name: 'Ada' } }
        });
        expect(msg.toolCalls[0].uiSubmitted).toBe(true);
    });

    it('shows a placeholder for partial streaming arschat_render_ui JSON', () => {
        const tc = new ToolCallChatResponseContentImpl('tc-ui-partial', RENDER_UI_TOOL_ID, '{"id":"survey"', false, undefined);
        const msg: any = { id: 1, author: 'assistant', text: '', streaming: true };
        asAny(widget).syncToolCalls(msg, fakeResponseWith(tc));
        asAny(widget).messages = [msg];
        const element = render(widget.render());
        expect(element.queryByText('Preparing UI...')).toBeTruthy();
        expect(element.queryByText('Invalid UI block.')).toBeFalsy();
    });

    it('falls back instead of throwing for finished invalid arschat_render_ui arguments', () => {
        const tc = new ToolCallChatResponseContentImpl('tc-ui-bad', RENDER_UI_TOOL_ID, '{bad json', true, 'bad args');
        const msg: any = { id: 1, author: 'assistant', text: '', streaming: true };
        asAny(widget).syncToolCalls(msg, fakeResponseWith(tc));
        asAny(widget).messages = [msg];
        const element = render(widget.render());
        expect(element.queryByText('Invalid UI block.')).toBeTruthy();
    });

    it('restores unfinished arschat_render_ui calls as expired and does not buffer stale submits', () => {
        const block = {
            id: 'survey',
            mode: 'default',
            title: 'Survey',
            state: { form: { name: '' } },
            root: {
                primitive: 'box',
                children: [
                    { primitive: 'input', bind: 'form.name', props: { inputId: 'stale-name-input', placeholder: 'Name' } }
                ]
            },
            actions: [{ type: 'submit', label: 'Send', variant: 'primary' }]
        };
        const tc = new ToolCallChatResponseContentImpl('tc-ui-stale', RENDER_UI_TOOL_ID, JSON.stringify(block), false, undefined);
        const req: any = {
            id: 'req-stale-ui',
            request: { text: 'restore ui', displayText: undefined },
            response: fakeResponseWith(tc)
        };

        asAny(widget).appendRestoredRequest(req);
        const assistant = asAny(widget).messages[1];
        const view = assistant.toolCalls[0];
        expect(view.state).toBe('expired');
        expect(view.uiExpired).toBe(true);

        const element = render(widget.render());
        expect(element.queryByText('このフォームは有効期限が切れました。')).toBeTruthy();
        expect(element.queryByText('Send')).toBeFalsy();
        expect(element.container.querySelector('#stale-name-input')).toBeFalsy();

        asAny(widget).onRenderUiSubmit(view, 'survey', 'submit', { form: { name: 'Ada' } });
        expect((uiInteractionService as any).earlyResolved.has('tc-ui-stale')).toBe(false);
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

    it('regenerate resends the original image variables and restores draft images', async () => {
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
        const assistant = asAny(widget).messages[1];
        const draftImage = pendingImage('draft', 'image/jpeg', 'draft.jpg');
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

        await asAny(widget).regenerate(assistant);

        expect(sentText).toBe('old q1');
        expect(sentImages).toEqual([{
            data: 'abc123',
            mimeType: 'image/png',
            name: 'original.png',
            previewUrl: 'data:image/png;base64,abc123'
        }]);
        expect(asAny(widget).pendingImages).toEqual([draftImage]);
        expect(asAny(widget).inputValue).toBe('draft text');
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

    it('does not save edit on IME Enter but saves on normal Enter', () => {
        const assistant = seedTurn('req-1');
        asAny(widget).startEdit(assistant);
        const saveEdit = jest.fn();
        asAny(widget).saveEdit = saveEdit;
        const element = render(widget.render());
        const textarea = element.container.querySelector('.arschat-message-edit-textarea') as HTMLTextAreaElement | null;
        expect(textarea).toBeTruthy();

        fireEvent.keyDown(textarea!, { key: 'Enter', shiftKey: false, keyCode: 229 });
        expect(saveEdit).not.toHaveBeenCalled();

        fireEvent.keyDown(textarea!, { key: 'Enter', shiftKey: false, keyCode: 13 });
        expect(saveEdit).toHaveBeenCalledWith(assistant);
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

    it('saveUserEdit sends restored images through resize before creating image variables', async () => {
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
        const userMessage = asAny(widget).messages[0];
        const draftImage = pendingImage('draft', 'image/jpeg', 'draft.jpg');
        asAny(widget).inputValue = 'draft text';
        asAny(widget).pendingImages = [draftImage];
        const resizeSpy = jest.spyOn(asAny(widget), 'resizeImageIfNeeded').mockImplementation(async (img: any) => ({
            ...img,
            data: `resized-${img.data}`,
            previewUrl: `data:${img.mimeType};base64,resized-${img.data}`
        }));
        const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const updateSpy = jest.spyOn(widget, 'update').mockImplementation(() => undefined);

        try {
            await asAny(widget).saveUserEdit(userMessage, 'edited q1');

            expect(resizeSpy).toHaveBeenCalledTimes(1);
            expect(resizeSpy).toHaveBeenCalledWith(expect.objectContaining({
                data: 'abc123',
                mimeType: 'image/png',
                name: 'original.png',
                previewUrl: 'data:image/png;base64,abc123'
            }));
            expect(sendRequestCalls).toHaveLength(1);
            expect(sendRequestCalls[0].request.text).toBe('edited q1');
            const variables = sendRequestCalls[0].request.variables ?? [];
            expect(variables).toHaveLength(1);
            expect(ImageContextVariable.parseRequest(variables[0])).toMatchObject({
                data: 'resized-abc123',
                mimeType: 'image/png',
                name: 'original.png'
            });
            expect(asAny(widget).pendingImages).toEqual([draftImage]);
            expect(asAny(widget).inputValue).toBe('draft text');
        } finally {
            resizeSpy.mockRestore();
            consoleLog.mockRestore();
            updateSpy.mockRestore();
        }
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
