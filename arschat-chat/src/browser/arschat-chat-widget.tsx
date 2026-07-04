// *****************************************************************************
// ArsChat chat widget (PHASE1_DESIGN.md §5, M3 production implementation).
//
// Replaces the M2 stopgap UI with the real chat surface:
//   - streaming display with requestAnimationFrame-batched repaint (the
//     pendingChunksRef / rafIdRef pattern from the old ArsChat ChatWindow.tsx);
//   - Markdown rendering with syntax-highlighted code blocks (arschat-markdown);
//   - <think>...</think> collapsible blocks (arschat-think, matching the old
//     ArsChat MessageBubble.tsx UX);
//   - image attachment via clipboard paste + drag & drop, sent to the model as
//     ImageContextVariable entries in the ChatRequest (Theia AI's multimodal
//     path - see BUILD_NOTES.md M3 "画像添付");
//   - an abort button that cancels the in-flight request;
//   - the M2 provider/model header dropdowns, preserved;
//   - session persistence via the standard ChatService/ChatSessionStore (the
//     store auto-saves and auto-titles), plus new-session and restore-session
//     wiring driven by the history panel through ArschatChatUiService.
// *****************************************************************************

import * as React from 'react';
import { injectable, postConstruct, inject } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/lib/browser';
import { DisposableCollection } from '@theia/core';
import { ChatService } from '@theia/ai-chat/lib/common/chat-service';
import { ChatAgentService } from '@theia/ai-chat/lib/common/chat-agent-service';
import { ChatResponseModel, ChatRequestModel, ToolCallChatResponseContent } from '@theia/ai-chat/lib/common/chat-model';
import { ToolConfirmationManager } from '@theia/ai-chat/lib/browser/chat-tool-preference-bindings';
import { ToolConfirmationMode } from '@theia/ai-chat/lib/common/chat-tool-preferences';
import { ImageContextVariable } from '@theia/ai-chat/lib/common/image-context-variable';
import { AIVariableResolutionRequest } from '@theia/ai-core';
import { LanguageModel } from '@theia/ai-core';
import {
    ArschatProviderKind,
    PROVIDERS
} from 'arschat-providers/lib/browser/arschat-provider-preferences';
import { ProviderSwitchService, ARSCHAT_CHAT_AGENT_ID } from 'arschat-providers/lib/browser/provider-switch-service';
import { PersonaService } from 'arschat-agents/lib/browser/persona-service';
import { SkillService } from 'arschat-agents/lib/browser/skill-service';
import { Persona } from 'arschat-agents/lib/common/persona';
import { Skill } from 'arschat-agents/lib/common/skill';
import { renderMarkdown } from './arschat-markdown';
import { parseThinkBlocks } from './arschat-think';
import { ArschatChatUiService } from './arschat-chat-ui-service';

interface PendingImage {
    /** base64 data (no data: prefix) */
    data: string;
    mimeType: string;
    name: string;
    /** data: URL for preview */
    previewUrl: string;
}

/**
 * View-model for one tool call rendered as a card in an assistant message.
 *
 * `content` is the live @theia/ai-chat ToolCallChatResponseContent; the actual
 * confirmation state machine (confirm()/deny(), needsUserConfirmation, confirmed,
 * whenFinished) lives on it - we only mirror the derived `state` for rendering
 * and drive the buttons back into `content`. This is the M5 e-3 "tool call card"
 * (PHASE1_DESIGN.md §5): 承認待ち -> 実行中 -> 結果.
 */
interface ToolCallView {
    /** stable card key (the tool call id, or a fallback index). */
    key: string;
    content: ToolCallChatResponseContent;
    /** derived UI state for the card. */
    state: 'confirm' | 'running' | 'done' | 'denied';
    /** whether the (potentially long) result body is expanded. */
    open?: boolean;
    /** subscriptions on `content`'s promises are wired exactly once. */
    wired?: boolean;
}

interface UiMessage {
    id: number;
    author: 'user' | 'assistant';
    text: string;
    /** data: URLs of images attached to a user message (for re-display). */
    images?: string[];
    streaming?: boolean;
    /** open/closed state of the think block for this assistant message. */
    thinkOpen?: boolean;
    /** tool call cards for this assistant message, in response order (M5 e-3). */
    toolCalls?: ToolCallView[];
    /** the live response model backing a streaming/just-finished assistant message. */
    response?: ChatResponseModel;
}

/** How much of a tool result we show before the fold (chars). */
const TOOL_RESULT_PREVIEW_CHARS = 2000;

@injectable()
export class ArschatChatWidget extends ReactWidget {

    static readonly ID = 'arschat-chat:widget';
    static readonly LABEL = 'ArsChat';

    @inject(ProviderSwitchService)
    protected readonly switchService!: ProviderSwitchService;

    @inject(ChatService)
    protected readonly chatService!: ChatService;

    @inject(ChatAgentService)
    protected readonly chatAgentService!: ChatAgentService;

    @inject(PersonaService)
    protected readonly personaService!: PersonaService;

    @inject(SkillService)
    protected readonly skillService!: SkillService;

    @inject(ArschatChatUiService)
    protected readonly uiService!: ArschatChatUiService;

    @inject(ToolConfirmationManager)
    protected readonly toolConfirmationManager!: ToolConfirmationManager;

    protected sessionId: string | undefined;
    /** id of the request currently being generated (for abort). */
    protected inflightRequestId: string | undefined;

    protected messages: UiMessage[] = [];
    protected nextId = 1;
    protected inputValue = '';
    protected sending = false;
    protected pendingImages: PendingImage[] = [];
    protected dragActive = false;

    protected provider: ArschatProviderKind = 'anthropic';
    protected model = '';
    protected modelsByProvider: Map<ArschatProviderKind, LanguageModel[]> = new Map();

    // ---- persona + skills (M4) ----
    protected personas: Persona[] = [];
    protected activePersonaId = '';
    /** slash-command skill suggestions currently shown under the input. */
    protected slashSuggestions: Skill[] = [];
    protected suggestionIndex = 0;

    protected readonly toDispose = new DisposableCollection();

    // ---- streaming rAF batching (from old ArsChat ChatWindow.tsx) ----
    protected pendingRender = false;
    protected rafId: number | undefined;

    @postConstruct()
    protected init(): void {
        this.doInit();
    }

    protected async doInit(): Promise<void> {
        this.id = ArschatChatWidget.ID;
        this.title.label = ArschatChatWidget.LABEL;
        this.title.caption = ArschatChatWidget.LABEL;
        this.title.closable = false;
        this.title.iconClass = 'fa fa-comments';
        this.addClass('arschat-chat-widget');

        this.provider = this.switchService.getActiveProvider();
        this.model = this.switchService.getActiveModel();
        await this.refreshModels();
        await this.ensureModelSelected();

        this.toDispose.push(this.switchService.onDidChange(sel => {
            this.provider = sel.provider;
            this.model = sel.model;
            this.update();
        }));

        // History-panel-driven session control.
        this.toDispose.push(this.uiService.onLoadSessionRequested(id => this.loadSession(id)));
        this.toDispose.push(this.uiService.onNewSessionRequested(() => this.startNewSession()));

        // Personas + skills (M4).
        await this.refreshPersonas();
        this.toDispose.push(this.personaService.onDidChange(() => { this.refreshPersonas(); }));
        await this.skillService.ready();
        this.toDispose.push(this.skillService.onDidChange(() => this.update()));

        this.update();
    }

    protected async refreshPersonas(): Promise<void> {
        await this.personaService.ready();
        this.personas = this.personaService.getPersonas();
        this.activePersonaId = this.personaService.getActivePersonaId();
        this.update();
    }

    protected async onPersonaChange(id: string): Promise<void> {
        await this.personaService.setActivePersona(id);
        this.activePersonaId = id;
        this.update();
    }

    override dispose(): void {
        if (this.rafId !== undefined) {
            cancelAnimationFrame(this.rafId);
        }
        this.toDispose.dispose();
        super.dispose();
    }

    // ---------------------------------------------------------------- models

    protected async refreshModels(): Promise<void> {
        for (const p of PROVIDERS) {
            this.modelsByProvider.set(p.kind, await this.switchService.getModelsForProvider(p.kind));
        }
    }

    protected currentModelNames(): string[] {
        const provider = PROVIDERS.find(p => p.kind === this.provider);
        const models = this.modelsByProvider.get(this.provider) ?? [];
        if (provider?.fixedModelId) {
            return [provider.fixedModelId];
        }
        const prefix = this.provider === 'openai' ? 'openai/' : 'anthropic/';
        return models.map(m => (m.id.startsWith(prefix) ? m.id.substring(prefix.length) : m.id));
    }

    protected async ensureModelSelected(): Promise<void> {
        const names = this.currentModelNames();
        if ((!this.model || !names.includes(this.model)) && names.length > 0) {
            this.model = names[0];
            await this.switchService.setActive(this.provider, this.model);
        }
    }

    protected async onProviderChange(kind: ArschatProviderKind): Promise<void> {
        this.provider = kind;
        await this.refreshModels();
        this.model = '';
        await this.ensureModelSelected();
        this.update();
    }

    protected async onModelChange(model: string): Promise<void> {
        this.model = model;
        await this.switchService.setActive(this.provider, model);
        this.update();
    }

    // ---------------------------------------------------------------- sessions

    protected getSessionId(): string {
        if (!this.sessionId) {
            const agent = this.chatAgentService.getAgent(ARSCHAT_CHAT_AGENT_ID);
            const session = this.chatService.createSession(undefined, { focus: false }, agent);
            this.sessionId = session.id;
            this.uiService.notifySessionChanged(this.sessionId);
        }
        return this.sessionId;
    }

    /** Clear the UI and forget the current session id so the next send starts fresh. */
    startNewSession(): void {
        this.abortIfSending();
        this.sessionId = undefined;
        this.messages = [];
        this.pendingImages = [];
        this.inputValue = '';
        this.uiService.notifySessionChanged(undefined);
        this.update();
        this.focusInput();
    }

    /** Restore a persisted session into the UI. */
    async loadSession(sessionId: string): Promise<void> {
        this.abortIfSending();
        const session = await this.chatService.getOrRestoreSession(sessionId);
        if (!session) {
            return;
        }
        this.sessionId = session.id;
        this.messages = [];
        this.pendingImages = [];
        for (const req of session.model.getRequests()) {
            this.appendRestoredRequest(req);
        }
        this.uiService.notifySessionChanged(this.sessionId);
        this.update();
        this.focusInput();
    }

    protected appendRestoredRequest(req: ChatRequestModel): void {
        const userText = req.request.displayText ?? req.request.text ?? '';
        this.messages.push({ id: this.nextId++, author: 'user', text: userText });
        const assistantText = this.responseToText(req.response);
        const assistant: UiMessage = { id: this.nextId++, author: 'assistant', text: assistantText, thinkOpen: false };
        // Restored responses are already finished; surface their tool calls as
        // completed cards (they never re-enter the confirm state).
        this.syncToolCalls(assistant, req.response);
        this.messages.push(assistant);
    }

    // ---------------------------------------------------------------- images

    protected async addImageFile(file: File): Promise<void> {
        if (!file.type.startsWith('image/')) {
            return;
        }
        const dataUrl = await this.readFileAsDataUrl(file);
        const comma = dataUrl.indexOf(',');
        const base64 = comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl;
        this.pendingImages.push({
            data: base64,
            mimeType: file.type || 'image/png',
            name: file.name || `pasted-image-${Date.now()}.png`,
            previewUrl: dataUrl
        });
        this.update();
    }

    protected readFileAsDataUrl(file: File): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ''));
            reader.onerror = () => reject(new Error('failed to read image'));
            reader.readAsDataURL(file);
        });
    }

    protected removePendingImage(index: number): void {
        this.pendingImages.splice(index, 1);
        this.update();
    }

    protected async handlePaste(event: React.ClipboardEvent): Promise<void> {
        const items = event.clipboardData?.items;
        if (!items) {
            return;
        }
        for (const item of Array.from(items)) {
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) {
                    event.preventDefault();
                    await this.addImageFile(file);
                }
            }
        }
    }

    protected async handleDrop(event: React.DragEvent): Promise<void> {
        event.preventDefault();
        this.dragActive = false;
        const files = event.dataTransfer?.files;
        if (files) {
            for (const file of Array.from(files)) {
                await this.addImageFile(file);
            }
        }
        this.update();
    }

    protected handleDragOver(event: React.DragEvent): void {
        if (event.dataTransfer?.types?.includes('Files')) {
            event.preventDefault();
            if (!this.dragActive) {
                this.dragActive = true;
                this.update();
            }
        }
    }

    protected handleDragLeave(): void {
        if (this.dragActive) {
            this.dragActive = false;
            this.update();
        }
    }

    // ---------------------------------------------------------------- send / abort

    protected abortIfSending(): void {
        if (this.sending && this.sessionId && this.inflightRequestId) {
            this.chatService.cancelRequest(this.sessionId, this.inflightRequestId).catch(() => { /* noop */ });
        }
        this.sending = false;
        this.inflightRequestId = undefined;
    }

    protected async abort(): Promise<void> {
        if (this.sessionId && this.inflightRequestId) {
            await this.chatService.cancelRequest(this.sessionId, this.inflightRequestId).catch(() => { /* noop */ });
        }
    }

    protected async send(): Promise<void> {
        const text = this.inputValue.trim();
        if ((!text && this.pendingImages.length === 0) || this.sending) {
            return;
        }
        this.sending = true;
        this.slashSuggestions = [];

        // Slash-command skill expansion (M4): if the input starts with a known
        // skill trigger, send the skill BODY (+ trailing user text) as the request
        // text while displaying the original `/trigger ...` line.
        const expansion = this.skillService.expandInput(text);
        const requestText = expansion ? expansion.expanded : text;
        const displayText = expansion ? expansion.display : undefined;

        const attachedPreviews = this.pendingImages.map(img => img.previewUrl);
        const variables: AIVariableResolutionRequest[] = this.pendingImages.map(img =>
            ImageContextVariable.createRequest({ data: img.data, mimeType: img.mimeType, name: img.name })
        );
        const imagesForModel = [...this.pendingImages];

        this.messages.push({
            id: this.nextId++,
            author: 'user',
            // Show the original slash line if we expanded, otherwise the raw text.
            text: displayText ?? text,
            images: attachedPreviews.length > 0 ? attachedPreviews : undefined
        });
        this.inputValue = '';
        this.pendingImages = [];

        const assistant: UiMessage = { id: this.nextId++, author: 'assistant', text: '', streaming: true, thinkOpen: false };
        this.messages.push(assistant);
        this.update();

        try {
            const modelId = this.switchService.resolveActiveModelId();
            console.log(`[arschat-chat] sending request (provider='${this.provider}', model='${this.model}', persona='${this.activePersonaId}', skill=${expansion ? 'yes' : 'no'}, resolved LanguageModel id='${modelId ?? '<none>'}', images=${imagesForModel.length})`);
            const invocation = await this.chatService.sendRequest(
                this.getSessionId(),
                { text: requestText, displayText, variables: variables.length > 0 ? variables : undefined }
            );
            if (!invocation) {
                assistant.text = '(error: no chat session)';
                assistant.streaming = false;
                this.sending = false;
                this.update();
                return;
            }
            const requestModel = await invocation.requestCompleted;
            this.inflightRequestId = requestModel.id;

            const response = await invocation.responseCreated;
            assistant.response = response;
            const sub = response.onDidChange(() => {
                assistant.text = this.responseToText(response);
                this.syncToolCalls(assistant, response);
                this.scheduleRender();
                if (response.isComplete || response.isError || response.isCanceled) {
                    assistant.streaming = false;
                    sub.dispose();
                }
            });
            await invocation.responseCompleted;
            assistant.text = this.responseToText(response);
            this.syncToolCalls(assistant, response);
            assistant.streaming = false;
        } catch (e) {
            assistant.text = `(error: ${e instanceof Error ? e.message : String(e)})`;
            assistant.streaming = false;
        } finally {
            this.sending = false;
            this.inflightRequestId = undefined;
            this.flushRender();
            this.uiService.notifySessionsMutated();
        }
    }

    /**
     * Batch streamed-chunk repaints on the next animation frame so a fast token
     * stream does not force a React re-render per token (old ArsChat pattern).
     */
    protected scheduleRender(): void {
        if (this.pendingRender) {
            return;
        }
        this.pendingRender = true;
        this.rafId = requestAnimationFrame(() => {
            this.pendingRender = false;
            this.rafId = undefined;
            this.update();
        });
    }

    protected flushRender(): void {
        if (this.rafId !== undefined) {
            cancelAnimationFrame(this.rafId);
            this.rafId = undefined;
        }
        this.pendingRender = false;
        this.update();
    }

    protected responseToText(response: ChatResponseModel): string {
        // Tool call parts contribute '' to asString(), so they never pollute the
        // visible text; they are rendered as cards separately (syncToolCalls).
        const parts = response.response.content as Array<{ asString?: () => string | undefined; asDisplayString?: () => string | undefined; kind?: string }>;
        return parts
            .filter(c => c.kind !== 'toolCall')
            .map(c => c.asString?.() ?? c.asDisplayString?.() ?? '').join('');
    }

    // ---------------------------------------------------------------- tool call cards (M5 e-3)

    /**
     * Reconcile the assistant message's tool-call cards with the tool call parts
     * currently in the response. New tool calls get a ToolCallView and (once) a
     * subscription to their confirmation/finish promises so the card advances
     * 承認待ち -> 実行中 -> 結果 without us polling. Existing cards keep their UI
     * state (open/denied) across re-renders.
     */
    protected syncToolCalls(msg: UiMessage, response: ChatResponseModel): void {
        const toolParts = (response.response.content as Array<{ kind?: string }>)
            .filter((c): c is ToolCallChatResponseContent => ToolCallChatResponseContent.is(c));
        if (toolParts.length === 0 && !msg.toolCalls) {
            return;
        }
        const existing = new Map((msg.toolCalls ?? []).map(v => [v.content, v]));
        const views: ToolCallView[] = toolParts.map((content, i) => {
            const view = existing.get(content) ?? {
                key: content.id ?? `tc-${msg.id}-${i}`,
                content,
                state: this.deriveToolState(content)
            } as ToolCallView;
            this.wireToolCall(msg, view);
            // Keep the derived state fresh unless the user has already answered
            // (confirm/running/done are promise-driven; only refresh finished flags).
            if (view.state !== 'denied') {
                view.state = this.deriveToolState(content);
            }
            return view;
        });
        msg.toolCalls = views;
    }

    /** Map a tool call's current model state to the card's UI state. */
    protected deriveToolState(content: ToolCallChatResponseContent): ToolCallView['state'] {
        if (content.finished) {
            return ToolCallChatResponseContent.isDenialResult(content.result) ? 'denied' : 'done';
        }
        return 'running';
    }

    /**
     * Wire a card's promises exactly once. `needsUserConfirmation` flips the card
     * into the 承認待ち (confirm) state - this is the interaction the CONFIRM branch
     * of FrontendChatToolRequestService fires. `confirmed`/`whenFinished` advance
     * it to 実行中 / 結果. Repaints are scheduled so the card updates live.
     */
    protected wireToolCall(msg: UiMessage, view: ToolCallView): void {
        if (view.wired) {
            return;
        }
        view.wired = true;
        const content = view.content;
        content.needsUserConfirmation.then(() => {
            if (view.state !== 'denied' && !content.finished) {
                view.state = 'confirm';
                this.scheduleRender();
            }
        });
        content.confirmed.then(confirmed => {
            if (confirmed) {
                if (view.state === 'confirm') {
                    view.state = 'running';
                }
            } else {
                view.state = 'denied';
            }
            this.scheduleRender();
        }).catch(() => {
            // cancelConfirmation (timeout/abort) rejects the promise.
            view.state = 'denied';
            this.scheduleRender();
        });
        content.whenFinished.then(() => {
            if (view.state !== 'denied') {
                view.state = ToolCallChatResponseContent.isDenialResult(content.result) ? 'denied' : 'done';
            }
            this.scheduleRender();
        });
    }

    /** Chat/session id used to scope "このセッション中" tool-confirmation overrides. */
    protected confirmationChatId(): string {
        return this.sessionId ?? '';
    }

    protected onToolAllow(view: ToolCallView, scope: 'once' | 'session' | 'forever'): void {
        const toolId = view.content.name;
        if (toolId && scope === 'forever') {
            this.toolConfirmationManager.setConfirmationMode(toolId, ToolConfirmationMode.ALWAYS_ALLOW);
        } else if (toolId && scope === 'session') {
            this.toolConfirmationManager.setSessionConfirmationMode(toolId, ToolConfirmationMode.ALWAYS_ALLOW, this.confirmationChatId());
        }
        view.state = 'running';
        view.content.confirm();
        this.update();
    }

    protected onToolDeny(view: ToolCallView): void {
        view.state = 'denied';
        view.content.deny();
        this.update();
    }

    protected toggleToolOpen(view: ToolCallView): void {
        view.open = !view.open;
        this.update();
    }

    /** Extract a readable result string from a finished tool call. */
    protected toolResultText(content: ToolCallChatResponseContent): string {
        const result = content.result as unknown;
        if (result === undefined) {
            return '';
        }
        if (typeof result === 'string') {
            return result;
        }
        if (ToolCallChatResponseContent.isDenialResult(result)) {
            const reason = (result as { reason?: string }).reason;
            return reason ? `拒否しました: ${reason}` : '拒否しました。';
        }
        try {
            return JSON.stringify(result, undefined, 2);
        } catch {
            return String(result);
        }
    }

    protected toggleThink(msg: UiMessage): void {
        msg.thinkOpen = !msg.thinkOpen;
        this.update();
    }

    // ---------------------------------------------------------------- slash completion (M4)

    /** Recompute the slash-command skill suggestions from the current input. */
    protected updateSlashSuggestions(value: string): void {
        if (value.startsWith('/') && !value.includes('\n')) {
            const spaceIdx = value.indexOf(' ');
            if (spaceIdx < 0) {
                // still typing the trigger -> show matching skills
                this.slashSuggestions = this.skillService.filterByQuery(value);
                this.suggestionIndex = 0;
                return;
            }
        }
        this.slashSuggestions = [];
        this.suggestionIndex = 0;
    }

    protected onInputChange(value: string): void {
        this.inputValue = value;
        this.updateSlashSuggestions(value);
        this.update();
    }

    /** Accept a suggestion: set the input to `/trigger ` and dismiss the popup. */
    protected selectSuggestion(skill: Skill): void {
        this.inputValue = `${skill.trigger} `;
        this.slashSuggestions = [];
        this.suggestionIndex = 0;
        this.update();
        setTimeout(() => {
            const ta = document.getElementById('arschat-chat-input') as HTMLTextAreaElement | null;
            if (ta) {
                ta.focus();
                ta.setSelectionRange(ta.value.length, ta.value.length);
            }
        }, 0);
    }

    protected onInputKeyDown(e: React.KeyboardEvent): void {
        if (this.slashSuggestions.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.suggestionIndex = Math.min(this.suggestionIndex + 1, this.slashSuggestions.length - 1);
                this.update();
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.suggestionIndex = Math.max(this.suggestionIndex - 1, 0);
                this.update();
                return;
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault();
                this.selectSuggestion(this.slashSuggestions[this.suggestionIndex]);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                this.slashSuggestions = [];
                this.update();
                return;
            }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.send();
        }
    }

    // ---------------------------------------------------------------- render

    render(): React.ReactElement {
        const modelNames = this.currentModelNames();
        return (
            <div
                id='arschat-chat-root'
                className={this.dragActive ? 'arschat-drag-active' : ''}
                onDragOver={e => this.handleDragOver(e)}
                onDragLeave={() => this.handleDragLeave()}
                onDrop={e => this.handleDrop(e)}
            >
                <div className='arschat-chat-header'>
                    <span className='arschat-chat-header-title'>ArsChat</span>
                    <div className='arschat-chat-header-controls'>
                        <button
                            id='arschat-new-chat-button'
                            className='theia-button secondary arschat-new-chat-button'
                            title='新しいチャット'
                            onClick={() => this.startNewSession()}
                        >
                            + 新規
                        </button>
                        <select
                            id='arschat-persona-select'
                            className='theia-select arschat-persona-select'
                            title='ペルソナ'
                            value={this.activePersonaId}
                            onChange={e => this.onPersonaChange(e.target.value)}
                        >
                            {this.personas.length === 0 && <option value=''>(no personas)</option>}
                            {this.personas.map(p => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                        </select>
                        <select
                            id='arschat-provider-select'
                            className='theia-select arschat-provider-select'
                            title='Provider'
                            value={this.provider}
                            onChange={e => this.onProviderChange(e.target.value as ArschatProviderKind)}
                        >
                            {PROVIDERS.map(p => (
                                <option key={p.kind} value={p.kind}>{p.label}</option>
                            ))}
                        </select>
                        <select
                            id='arschat-model-select'
                            className='theia-select arschat-model-select'
                            title='Model'
                            value={this.model}
                            onChange={e => this.onModelChange(e.target.value)}
                        >
                            {modelNames.length === 0 && <option value=''>(no models)</option>}
                            {modelNames.map(name => (
                                <option key={name} value={name}>{name}</option>
                            ))}
                        </select>
                    </div>
                </div>
                <div className='arschat-chat-messages'>
                    {this.messages.length === 0 && (
                        <div className='arschat-chat-message arschat-chat-message-assistant'>
                            <div className='arschat-chat-message-bubble'>
                                ArsChat へようこそ。ヘッダーでプロバイダ/モデルを選び、メッセージを送信してください。画像は貼り付け・ドラッグ&ドロップで添付できます。
                            </div>
                        </div>
                    )}
                    {this.messages.map(msg => this.renderMessage(msg))}
                </div>
                {this.pendingImages.length > 0 && (
                    <div className='arschat-attachments'>
                        {this.pendingImages.map((img, i) => (
                            <div key={i} className='arschat-attachment'>
                                <img src={img.previewUrl} alt={img.name} className='arschat-attachment-thumb' />
                                <button
                                    className='arschat-attachment-remove'
                                    title='添付を削除'
                                    onClick={() => this.removePendingImage(i)}
                                >×</button>
                            </div>
                        ))}
                    </div>
                )}
                <div className='arschat-chat-input-bar'>
                    {this.slashSuggestions.length > 0 && (
                        <div id='arschat-slash-popup' className='arschat-slash-popup'>
                            {this.slashSuggestions.map((skill, idx) => (
                                <button
                                    key={skill.id}
                                    type='button'
                                    className={`arschat-slash-item ${idx === this.suggestionIndex ? 'active' : ''}`}
                                    onMouseDown={e => { e.preventDefault(); this.selectSuggestion(skill); }}
                                >
                                    <span className='arschat-slash-trigger'>{skill.trigger}</span>
                                    <span className='arschat-slash-meta'>
                                        <span className='arschat-slash-name'>{skill.name}</span>
                                        <span className='arschat-slash-desc'>{skill.description}</span>
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                    <textarea
                        id='arschat-chat-input'
                        className='theia-input arschat-chat-input'
                        placeholder='メッセージを入力... (/ でスキル、画像は貼り付け/ドロップ)'
                        value={this.inputValue}
                        disabled={this.sending}
                        rows={1}
                        onChange={e => this.onInputChange(e.target.value)}
                        onPaste={e => this.handlePaste(e)}
                        onKeyDown={e => this.onInputKeyDown(e)}
                    />
                    {this.sending ? (
                        <button
                            id='arschat-chat-abort-button'
                            className='theia-button arschat-chat-abort-button'
                            title='生成を中断'
                            onClick={() => this.abort()}
                        >中断</button>
                    ) : (
                        <button
                            id='arschat-chat-send-button'
                            className='theia-button arschat-chat-send-button'
                            title='Send'
                            disabled={this.inputValue.trim().length === 0 && this.pendingImages.length === 0}
                            onClick={() => this.send()}
                        >送信</button>
                    )}
                </div>
            </div>
        );
    }

    protected renderMessage(msg: UiMessage): React.ReactElement {
        if (msg.author === 'user') {
            return (
                <div key={msg.id} className='arschat-chat-message arschat-chat-message-user'>
                    <div className='arschat-chat-message-bubble'>
                        {msg.images && msg.images.length > 0 && (
                            <div className='arschat-message-images'>
                                {msg.images.map((src, i) => (
                                    <img key={i} src={src} className='arschat-message-image' alt='attachment' />
                                ))}
                            </div>
                        )}
                        {msg.text && <div className='arschat-user-text'>{msg.text}</div>}
                    </div>
                </div>
            );
        }

        // assistant: split <think>, render markdown for the visible part.
        const { thinking, response, isThinkingInProgress } = parseThinkBlocks(msg.text);
        const html = renderMarkdown(response);
        return (
            <div key={msg.id} className='arschat-chat-message arschat-chat-message-assistant'>
                <div className='arschat-chat-message-bubble'>
                    {isThinkingInProgress && (
                        <div className='arschat-think-block'>
                            <div className='arschat-think-toggle'>
                                <span className='arschat-think-spinner' />
                                <span className='arschat-think-label'>思考中…</span>
                            </div>
                        </div>
                    )}
                    {!isThinkingInProgress && thinking && (
                        <div className='arschat-think-block'>
                            <button className='arschat-think-toggle' onClick={() => this.toggleThink(msg)}>
                                <span className={`arschat-think-chevron ${msg.thinkOpen ? 'open' : ''}`}>▶</span>
                                <span className='arschat-think-label'>
                                    {msg.thinkOpen ? '思考プロセス' : '思考プロセスを表示'}
                                </span>
                            </button>
                            {msg.thinkOpen && (
                                <div
                                    className='arschat-think-content'
                                    dangerouslySetInnerHTML={{ __html: renderMarkdown(thinking) }}
                                />
                            )}
                        </div>
                    )}
                    <div className='arschat-markdown' dangerouslySetInnerHTML={{ __html: html }} />
                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                        <div className='arschat-tool-calls'>
                            {msg.toolCalls.map(view => this.renderToolCard(view))}
                        </div>
                    )}
                    {msg.streaming && <span className='arschat-chat-cursor'> ▍</span>}
                </div>
            </div>
        );
    }

    protected renderToolCard(view: ToolCallView): React.ReactElement {
        const { content, state } = view;
        const toolName = content.name ?? 'tool';
        const argsLabel = content.arguments && content.arguments.length > 0 ? content.arguments : '';
        const statusMeta = this.toolStatusMeta(state);
        return (
            <div key={view.key} className={`arschat-tool-card arschat-tool-card-${state}`}>
                <div className='arschat-tool-card-head'>
                    {state === 'running'
                        ? <span className='arschat-tool-card-spinner' />
                        : <span className={`arschat-tool-card-status ${statusMeta.cls}`}>{statusMeta.icon}</span>}
                    <span className='arschat-tool-card-name'>{toolName}</span>
                    <span className='arschat-tool-card-label'>{statusMeta.label}</span>
                </div>
                {argsLabel && (
                    <div className='arschat-tool-card-args' title={argsLabel}>{argsLabel}</div>
                )}
                {state === 'confirm' && (
                    <div className='arschat-tool-card-actions'>
                        <div className='arschat-tool-approve-group'>
                            <button
                                className='theia-button arschat-tool-allow'
                                title='このツール実行を許可'
                                onClick={() => this.onToolAllow(view, 'once')}
                            >許可</button>
                            <button
                                className='theia-button secondary arschat-tool-allow-session'
                                title='このセッション中は毎回許可'
                                onClick={() => this.onToolAllow(view, 'session')}
                            >セッション中</button>
                            <button
                                className='theia-button secondary arschat-tool-allow-forever'
                                title='常に許可 (以後このツールは確認しない)'
                                onClick={() => this.onToolAllow(view, 'forever')}
                            >常に許可</button>
                        </div>
                        <button
                            className='theia-button secondary arschat-tool-deny'
                            title='このツール実行を拒否'
                            onClick={() => this.onToolDeny(view)}
                        >拒否</button>
                    </div>
                )}
                {state === 'done' && this.renderToolResult(view)}
                {state === 'denied' && (
                    <div className='arschat-tool-card-result arschat-tool-card-result-denied'>
                        {this.toolResultText(content) || 'ツール実行を拒否しました。'}
                    </div>
                )}
            </div>
        );
    }

    protected toolStatusMeta(state: ToolCallView['state']): { icon: string; label: string; cls: string } {
        switch (state) {
            case 'confirm': return { icon: '🛡', label: '承認待ち', cls: 'confirm' };
            case 'running': return { icon: '', label: '実行中…', cls: 'running' };
            case 'denied': return { icon: '✕', label: '拒否', cls: 'denied' };
            case 'done':
            default: return { icon: '✓', label: '完了', cls: 'done' };
        }
    }

    protected renderToolResult(view: ToolCallView): React.ReactElement {
        const full = this.toolResultText(view.content);
        const long = full.length > TOOL_RESULT_PREVIEW_CHARS;
        const shown = view.open || !long ? full : full.slice(0, TOOL_RESULT_PREVIEW_CHARS);
        return (
            <div className='arschat-tool-card-result'>
                <pre className='arschat-tool-card-output'>{shown}{!view.open && long ? '\n…' : ''}</pre>
                {long && (
                    <button className='arschat-tool-card-toggle' onClick={() => this.toggleToolOpen(view)}>
                        {view.open ? '折りたたむ' : `すべて表示 (${full.length} 文字)`}
                    </button>
                )}
            </div>
        );
    }

    protected focusInput(): void {
        setTimeout(() => {
            const el = document.getElementById('arschat-chat-input');
            el?.focus();
        }, 0);
    }

    protected onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.focusInput();
    }
}
