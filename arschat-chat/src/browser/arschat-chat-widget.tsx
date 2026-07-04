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
import { ChatResponseModel, ChatRequestModel } from '@theia/ai-chat/lib/common/chat-model';
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

interface UiMessage {
    id: number;
    author: 'user' | 'assistant';
    text: string;
    /** data: URLs of images attached to a user message (for re-display). */
    images?: string[];
    streaming?: boolean;
    /** open/closed state of the think block for this assistant message. */
    thinkOpen?: boolean;
}

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
        this.messages.push({ id: this.nextId++, author: 'assistant', text: assistantText, thinkOpen: false });
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
            const sub = response.onDidChange(() => {
                assistant.text = this.responseToText(response);
                this.scheduleRender();
                if (response.isComplete || response.isError || response.isCanceled) {
                    assistant.streaming = false;
                    sub.dispose();
                }
            });
            await invocation.responseCompleted;
            assistant.text = this.responseToText(response);
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
        const parts = response.response.content as Array<{ asString?: () => string | undefined; asDisplayString?: () => string | undefined }>;
        return parts.map(c => c.asString?.() ?? c.asDisplayString?.() ?? '').join('');
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
                    {msg.streaming && <span className='arschat-chat-cursor'> ▍</span>}
                </div>
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
