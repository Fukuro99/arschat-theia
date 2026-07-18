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
import { ChatSessionStore } from '@theia/ai-chat/lib/common/chat-session-store';
import type { ChatModelWithMetadata } from '@theia/ai-chat/lib/common/chat-session-store';
import {
    ChatResponseContent,
    ChatResponseModel,
    ChatRequestModel,
    MutableChatModel,
    TextChatResponseContentImpl,
    ToolCallChatResponseContent
} from '@theia/ai-chat/lib/common/chat-model';
import { SerializedChatModel, SerializableHierarchyBranch } from '@theia/ai-chat/lib/common/chat-model-serialization';
import { ToolConfirmationManager } from '@theia/ai-chat/lib/browser/chat-tool-preference-bindings';
import { ToolConfirmationMode } from '@theia/ai-chat/lib/common/chat-tool-preferences';
import { ImageContextVariable } from '@theia/ai-chat/lib/common/image-context-variable';
import { AIVariableResolutionRequest } from '@theia/ai-core';
import { LanguageModel } from '@theia/ai-core';
import { ToolInvocationRegistry } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { ToolRequest } from '@theia/ai-core/lib/common/language-model';
import { generateUuid } from '@theia/core/lib/common/uuid';
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
import { removeRequestFromModel, RequestTreeModel } from './arschat-request-tree';
import { ArschatStatsStore } from './arschat-stats-store';
import { computeMessageStats, hasDisplayableStats, ResponseTokenUsageLike } from './arschat-message-stats';
import { computeResizeTarget, DEFAULT_IMAGE_MAX_LONG_EDGE, ResizeTarget, shouldResizeImageMimeType } from './arschat-image-resize';

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
    /**
     * Id of the backing ChatRequestModel (a "turn" = one request carrying both the
     * user request and the assistant response). Both the user and assistant
     * UiMessages of a turn share this id, so a hover "削除" removes the whole pair.
     * Undefined only while a just-sent request is still being created.
     */
    requestId?: string;
    /** data: URLs of images attached to a user message (for re-display). */
    images?: string[];
    /** transient "コピーしました" tick shown briefly after a successful copy. */
    copied?: boolean;
    /** measured generation time (ms) for an assistant message, for the stats bar (M6 e-25). */
    durationMs?: number;
    streaming?: boolean;
    /** open/closed state of the think block for this assistant message. */
    thinkOpen?: boolean;
    /** tool call cards for this assistant message, in response order (M5 e-3). */
    toolCalls?: ToolCallView[];
    /** the live response model backing a streaming/just-finished assistant message. */
    response?: ChatResponseModel;
    /** whether this message is currently being edited in-place. */
    editing?: boolean;
}

/** How much of a tool result we show before the fold (chars). */
const TOOL_RESULT_PREVIEW_CHARS = 2000;
const CONTINUE_PROMPT = '続けてください';

interface MutableResponseContentLike {
    clearContent(): void;
    addContents?(contents: ChatResponseContent[]): void;
    addContent(content: ChatResponseContent): void;
}

@injectable()
export class ArschatChatWidget extends ReactWidget {

    static readonly ID = 'arschat-chat:widget';
    static readonly LABEL = 'ArsChat';

    @inject(ProviderSwitchService)
    protected readonly switchService!: ProviderSwitchService;

    @inject(ChatService)
    protected readonly chatService!: ChatService;

    @inject(ChatSessionStore)
    protected readonly chatSessionStore!: ChatSessionStore;

    @inject(ChatAgentService)
    protected readonly chatAgentService!: ChatAgentService;

    @inject(PersonaService)
    protected readonly personaService!: PersonaService;

    @inject(SkillService)
    protected readonly skillService!: SkillService;

    @inject(ArschatChatUiService)
    protected readonly uiService!: ArschatChatUiService;

    @inject(ArschatStatsStore)
    protected readonly statsStore!: ArschatStatsStore;

    @inject(ToolConfirmationManager)
    protected readonly toolConfirmationManager!: ToolConfirmationManager;

    @inject(ToolInvocationRegistry)
    protected readonly toolInvocationRegistry!: ToolInvocationRegistry;

    protected sessionId: string | undefined;
    /** id of the request currently being generated (for abort). */
    protected inflightRequestId: string | undefined;

    protected messages: UiMessage[] = [];
    protected nextId = 1;
    protected inputValue = '';
    protected editDraft = '';
    protected readonly inputRef = React.createRef<HTMLTextAreaElement>();
    protected readonly editTextareaRef = React.createRef<HTMLTextAreaElement>();
    protected sending = false;
    protected sendSeq = 0;
    protected pendingImages: PendingImage[] = [];
    protected dragActive = false;

    protected provider: ArschatProviderKind = 'anthropic';
    protected model = '';
    protected modelsByProvider: Map<ArschatProviderKind, LanguageModel[]> = new Map();
    protected configuredCustomModelsByProvider: Map<ArschatProviderKind, string> = new Map();
    protected liveCustomModelsByProvider: Map<ArschatProviderKind, string[]> = new Map();
    protected customModelLoadStates: Map<ArschatProviderKind, 'idle' | 'loading' | 'error'> = new Map();
    protected customEndpointUrls: Map<ArschatProviderKind, string> = new Map();
    protected customEndpointDraft = '';
    protected readonly endpointInputRef = React.createRef<HTMLInputElement>();
    protected customEndpointError = '';
    protected liveCustomModelRequestSeq = 0;
    protected liveCustomModelRequestTokens: Map<ArschatProviderKind, number> = new Map();
    protected liveCustomModelAbortControllers: Map<ArschatProviderKind, AbortController> = new Map();
    /** Per-provider monotonic tokens: a newer commit for the same provider supersedes an older one. */
    protected customEndpointCommitSeqs: Map<ArschatProviderKind, number> = new Map();
    /** Per-provider chains serializing URL preference writes so they land in start order. */
    protected customEndpointCommitChains: Map<ArschatProviderKind, Promise<void>> = new Map();
    protected composing = false;
    /** A render was requested (from any path) while an IME composition was in flight. */
    protected pendingUpdateWhileComposing = false;

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
        this.model = this.isCustomEndpointProvider(this.provider)
            ? this.switchService.getCustomEndpointModel(this.provider)
            : this.switchService.getActiveModel();
        await this.refreshModels();
        if (this.isCustomEndpointProvider(this.provider)) {
            this.syncCustomEndpointState(this.provider);
            await this.refreshLiveCustomModels(this.provider);
        }
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
        this.abortLiveCustomModelRequests();
        this.toDispose.dispose();
        super.dispose();
    }

    /**
     * Single choke point for every repaint. During an IME composition we must not
     * re-render the controlled textarea/input (React would reset the caret and the
     * partially-composed characters, causing the double-input bug - e-48). Any path
     * that requests a render while composing (onXxxChange, but also the async ones:
     * refreshLiveCustomModels completing, switchService.onDidChange, persona/skill
     * updates, streaming) is coalesced here and flushed on compositionend.
     */
    override update(): void {
        if (this.composing) {
            this.pendingUpdateWhileComposing = true;
            return;
        }
        super.update();
    }

    /**
     * End the composing state and flush a render that was deferred while composing.
     * Called from every compositionend/blur/edit-mode transition so a pending update
     * is never lost when the IME session ends.
     */
    protected flushComposingUpdate(): void {
        this.composing = false;
        if (this.pendingUpdateWhileComposing) {
            this.pendingUpdateWhileComposing = false;
            this.update();
        }
    }

    protected setInputValue(value: string): void {
        this.inputValue = value;
        const el = this.inputRef.current;
        if (el && el.value !== value) {
            el.value = value;
        }
    }

    protected setEditDraft(value: string): void {
        this.editDraft = value;
        const el = this.editTextareaRef.current;
        if (el && el.value !== value) {
            el.value = value;
        }
    }

    protected setCustomEndpointDraft(value: string): void {
        this.customEndpointDraft = value;
        const el = this.endpointInputRef.current;
        if (el && el.value !== value) {
            el.value = value;
        }
    }

    // ---------------------------------------------------------------- models

    protected async refreshModels(): Promise<void> {
        for (const p of PROVIDERS) {
            this.modelsByProvider.set(p.kind, await this.switchService.getModelsForProvider(p.kind));
            if (p.fixedModelId) {
                this.syncCustomEndpointState(p.kind);
            }
        }
    }

    protected isCustomEndpointProvider(kind: ArschatProviderKind = this.provider): boolean {
        return !!PROVIDERS.find(p => p.kind === kind)?.fixedModelId;
    }

    protected syncCustomEndpointState(kind: ArschatProviderKind): void {
        if (!this.isCustomEndpointProvider(kind)) {
            return;
        }
        const url = this.switchService.getCustomEndpointUrl(kind);
        const model = this.switchService.getCustomEndpointModel(kind);
        this.customEndpointUrls.set(kind, url);
        if (model) {
            this.configuredCustomModelsByProvider.set(kind, model);
        }
        if (this.provider === kind) {
            this.setCustomEndpointDraft(url);
            this.customEndpointError = '';
            if (model) {
                this.model = model;
            }
        }
    }

    protected async refreshLiveCustomModels(kind: ArschatProviderKind): Promise<void> {
        if (this.isDisposed) {
            return;
        }
        if (!this.isCustomEndpointProvider(kind)) {
            return;
        }
        this.syncCustomEndpointState(kind);
        const url = this.switchService.getCustomEndpointUrl(kind);
        const token = ++this.liveCustomModelRequestSeq;
        this.liveCustomModelRequestTokens.set(kind, token);
        this.liveCustomModelAbortControllers.get(kind)?.abort();
        const controller = new AbortController();
        this.liveCustomModelAbortControllers.set(kind, controller);
        this.customModelLoadStates.set(kind, 'loading');
        if (!this.isDisposed) {
            this.update();
        }
        try {
            const names = await this.switchService.fetchCustomEndpointModels(kind, { signal: controller.signal });
            if (!this.isCurrentLiveCustomModelRequest(kind, token, url)) {
                return;
            }
            this.liveCustomModelsByProvider.set(kind, names);
            this.customModelLoadStates.set(kind, 'idle');
            const configured = this.switchService.getCustomEndpointModel(kind);
            if (configured) {
                this.configuredCustomModelsByProvider.set(kind, configured);
            }
            const preferred = [this.model, configured].find(candidate => !!candidate && names.includes(candidate));
            const nextModel = preferred ?? names[0] ?? configured;
            if (nextModel) {
                this.model = nextModel;
                await this.switchService.setActive(kind, nextModel);
            }
        } catch (error: unknown) {
            if (!this.isCurrentLiveCustomModelRequest(kind, token, url)) {
                return;
            }
            this.customModelLoadStates.set(kind, 'error');
            console.error(`[arschat-chat] failed to fetch models for ${kind}`, error);
        } finally {
            if (this.liveCustomModelAbortControllers.get(kind) === controller) {
                this.liveCustomModelAbortControllers.delete(kind);
            }
            if (this.isCurrentLiveCustomModelRequest(kind, token, url)) {
                this.update();
            }
        }
    }

    protected isCurrentLiveCustomModelRequest(kind: ArschatProviderKind, token: number, url: string): boolean {
        return !this.isDisposed
            && this.liveCustomModelRequestTokens.get(kind) === token
            && this.provider === kind
            && this.switchService.getCustomEndpointUrl(kind) === url;
    }

    protected abortLiveCustomModelRequests(exceptKind?: ArschatProviderKind): void {
        for (const [kind, controller] of this.liveCustomModelAbortControllers) {
            if (kind !== exceptKind) {
                controller.abort();
                this.liveCustomModelAbortControllers.delete(kind);
                this.liveCustomModelRequestTokens.delete(kind);
            }
        }
    }

    protected currentModelNames(): string[] {
        const provider = PROVIDERS.find(p => p.kind === this.provider);
        const models = this.modelsByProvider.get(this.provider) ?? [];
        if (provider?.fixedModelId) {
            const live = this.liveCustomModelsByProvider.get(this.provider) ?? [];
            if (live.length > 0) {
                return live;
            }
            const configured = this.configuredCustomModelsByProvider.get(this.provider) || this.model;
            return configured ? [configured] : [];
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
        this.abortLiveCustomModelRequests(kind);
        await this.refreshModels();
        // A newer provider switch may have overtaken us during the await above;
        // from here on this run must not touch state the newer switch now owns.
        if (this.provider !== kind) {
            return;
        }
        this.model = '';
        if (this.isCustomEndpointProvider(kind)) {
            this.syncCustomEndpointState(kind);
            if (this.model) {
                await this.switchService.setActive(kind, this.model);
                if (this.provider !== kind) {
                    return;
                }
            }
            await this.refreshLiveCustomModels(kind);
        } else {
            await this.ensureModelSelected();
        }
        if (this.provider !== kind) {
            return;
        }
        this.update();
    }

    protected async onModelChange(model: string): Promise<void> {
        if (!model) {
            return;
        }
        this.model = model;
        await this.switchService.setActive(this.provider, model);
        this.update();
    }

    protected onCustomEndpointDraftChange(value: string): void {
        this.customEndpointDraft = value;
        this.customEndpointError = '';
        this.update();
    }

    protected async commitCustomEndpointUrl(): Promise<void> {
        const kind = this.provider;
        const draft = this.customEndpointDraft;
        if (!this.isCustomEndpointProvider(kind)) {
            return;
        }
        // Per-provider supersede token: a newer commit for the SAME provider makes
        // this one stale (its UI effects are dropped), while commits for another
        // provider stay fully independent (the token map keys by provider).
        const token = (this.customEndpointCommitSeqs.get(kind) ?? 0) + 1;
        this.customEndpointCommitSeqs.set(kind, token);
        const isCurrent = (): boolean => token === this.customEndpointCommitSeqs.get(kind) && this.provider === kind;
        // Serialize the preference writes per provider. The stale check alone can
        // only drop UI effects - it cannot un-write a preference update that already
        // started - so writes must run in start order (the newest write lands last,
        // keeping the stored URL from being reverted by a slow older commit). A
        // commit already superseded when its turn comes skips its write entirely.
        const chain = (this.customEndpointCommitChains.get(kind) ?? Promise.resolve())
            .then(async () => {
                if (token !== this.customEndpointCommitSeqs.get(kind)) {
                    return;
                }
                const normalized = await this.switchService.updateCustomEndpointUrl(kind, draft);
                if (!isCurrent()) {
                    return;
                }
                this.customEndpointUrls.set(kind, normalized);
                this.setCustomEndpointDraft(normalized);
                this.customEndpointError = '';
                await this.refreshLiveCustomModels(kind);
            })
            .catch((error: unknown) => {
                if (!isCurrent()) {
                    return;
                }
                this.customEndpointError = error instanceof Error ? error.message : String(error);
                this.update();
            });
        this.customEndpointCommitChains.set(kind, chain);
        await chain;
    }

    protected onCustomEndpointKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
        if (e.key === 'Enter' && !this.isImeActive(e)) {
            e.preventDefault();
            this.commitCustomEndpointUrl();
        }
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
        this.setInputValue('');
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
        // Durations are looked up synchronously in appendRestoredRequest; make sure
        // the store's cache is loaded first (M6 e-25).
        await this.statsStore.ready();
        for (const req of session.model.getRequests()) {
            this.appendRestoredRequest(req);
        }
        this.uiService.notifySessionChanged(this.sessionId);
        this.update();
        this.focusInput();
    }

    protected appendRestoredRequest(req: ChatRequestModel): void {
        const userText = req.request.displayText ?? req.request.text ?? '';
        const restoredImages = this.pendingImagesFromVariables(req.request.variables);
        this.messages.push({
            id: this.nextId++,
            author: 'user',
            text: userText,
            requestId: req.id,
            images: restoredImages && restoredImages.length > 0 ? restoredImages.map(img => img.previewUrl) : undefined
        });
        const assistantText = this.responseToText(req.response);
        const assistant: UiMessage = {
            id: this.nextId++, author: 'assistant', text: assistantText, thinkOpen: false,
            requestId: req.id,
            // Keep the live response so restored turns can still show token stats;
            // the duration comes from our own store (old sessions without an entry
            // simply render the bar without a time - schema is optional-safe) (M6 e-25).
            response: req.response,
            durationMs: this.statsStore.getDurationMs(req.id)
        };
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

    protected async resizeImageIfNeeded(img: PendingImage): Promise<PendingImage> {
        if (!shouldResizeImageMimeType(img.mimeType)) {
            return img;
        }
        const image = await this.loadImageElement(img.previewUrl);
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        const target = computeResizeTarget(width, height, DEFAULT_IMAGE_MAX_LONG_EDGE);
        if (!target.needsResize) {
            return img;
        }
        return this.drawResizedImage(img, image, target);
    }

    protected loadImageElement(src: string): Promise<HTMLImageElement> {
        return new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('failed to load image'));
            image.src = src;
        });
    }

    protected drawResizedImage(img: PendingImage, source: CanvasImageSource, target: ResizeTarget): PendingImage {
        const canvas = document.createElement('canvas');
        canvas.width = target.width;
        canvas.height = target.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('failed to resize image');
        }
        ctx.drawImage(source, 0, 0, target.width, target.height);
        const previewUrl = canvas.toDataURL(img.mimeType);
        const comma = previewUrl.indexOf(',');
        const mimeType = /^data:([^;,]+)[;,]/.exec(previewUrl)?.[1] ?? img.mimeType;
        return {
            ...img,
            data: comma >= 0 ? previewUrl.substring(comma + 1) : previewUrl,
            mimeType,
            previewUrl
        };
    }

    protected removePendingImage(index: number): void {
        this.pendingImages.splice(index, 1);
        this.update();
    }

    protected getRequestModel(requestId: string): ChatRequestModel | undefined {
        if (!this.sessionId) {
            return undefined;
        }
        return this.chatService.getSession(this.sessionId)?.model.getRequests().find(req => req.id === requestId);
    }

    /**
     * Rebuild the widget's image-send shape from persisted ImageContextVariables.
     * Undefined means an image variable exists but cannot be safely resent.
     */
    protected pendingImagesFromRequest(requestId: string): PendingImage[] | undefined {
        const request = this.getRequestModel(requestId);
        return request ? this.pendingImagesFromVariables(request.request.variables) : undefined;
    }

    protected pendingImagesForUserEdit(msg: UiMessage): PendingImage[] | undefined {
        if (!msg.requestId) {
            return undefined;
        }
        const request = this.getRequestModel(msg.requestId);
        if (!request) {
            return msg.images && msg.images.length > 0 ? undefined : [];
        }
        const images = this.pendingImagesFromVariables(request.request.variables);
        return images && (!msg.images || msg.images.length === images.length) ? images : undefined;
    }

    protected pendingImagesFromVariables(variables: readonly AIVariableResolutionRequest[] | undefined): PendingImage[] | undefined {
        const images: PendingImage[] = [];
        for (const variable of variables ?? []) {
            if (!ImageContextVariable.isImageContextRequest(variable)) {
                continue;
            }
            let parsed: ImageContextVariable | undefined;
            try {
                parsed = ImageContextVariable.parseRequest(variable);
            } catch {
                return undefined;
            }
            if (!parsed) {
                continue;
            }
            if (!parsed.data || !parsed.mimeType) {
                return undefined;
            }
            images.push({
                data: parsed.data,
                mimeType: parsed.mimeType,
                name: parsed.name ?? 'image',
                previewUrl: `data:${parsed.mimeType};base64,${parsed.data}`
            });
        }
        return images;
    }

    protected canEditMessage(msg: UiMessage): boolean {
        if (msg.author !== 'user') {
            return true;
        }
        if (!msg.requestId) {
            return false;
        }
        return this.pendingImagesForUserEdit(msg) !== undefined;
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
        if (this.sending) {
            this.sendSeq++;
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
        const token = ++this.sendSeq;
        const sessionId = this.getSessionId();
        const modelId = this.switchService.resolveActiveModelId();
        const provider = this.provider;
        const model = this.model;
        this.slashSuggestions = [];

        // Slash-command skill expansion (M4): if the input starts with a known
        // skill trigger, send the skill BODY (+ trailing user text) as the request
        // text while displaying the original `/trigger ...` line.
        const expansion = this.skillService.expandInput(text);
        const requestText = expansion ? expansion.expanded : text;
        const displayText = expansion ? expansion.display : undefined;

        const imagesToSend = [...this.pendingImages];
        const attachedPreviews = imagesToSend.map(img => img.previewUrl);

        const userMessage: UiMessage = {
            id: this.nextId++,
            author: 'user',
            // Show the original slash line if we expanded, otherwise the raw text.
            text: displayText ?? text,
            images: attachedPreviews.length > 0 ? attachedPreviews : undefined
        };
        this.messages.push(userMessage);
        this.setInputValue('');
        this.pendingImages = [];

        const assistant: UiMessage = { id: this.nextId++, author: 'assistant', text: '', streaming: true, thinkOpen: false };
        this.messages.push(assistant);
        this.update();

        // Wall-clock generation time for the stats bar (M6 e-25). Theia does not
        // persist durations, so we measure here and store per request id.
        const startedAt = Date.now();

        try {
            const imagesForModel = await Promise.all(imagesToSend.map(img => this.resizeImageFailOpen(img)));
            if (this.isDisposed || token !== this.sendSeq || provider !== this.provider || model !== this.model || modelId !== this.switchService.resolveActiveModelId()) {
                assistant.streaming = false;
                return;
            }
            const variables: AIVariableResolutionRequest[] = imagesForModel.map(img =>
                ImageContextVariable.createRequest({ data: img.data, mimeType: img.mimeType, name: img.name })
            );
            console.log(`[arschat-chat] sending request (provider='${provider}', model='${model}', persona='${this.activePersonaId}', skill=${expansion ? 'yes' : 'no'}, resolved LanguageModel id='${modelId ?? '<none>'}', images=${imagesForModel.length})`);
            const invocation = await this.chatService.sendRequest(
                sessionId,
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
            // Bind both UiMessages of this turn to the backing request id so the
            // hover 削除/再生成 actions can address the whole turn (M6 e-24).
            userMessage.requestId = requestModel.id;
            assistant.requestId = requestModel.id;

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
            // Record the measured duration so the stats bar survives a session
            // reload (tokenUsage is persisted by Theia; the duration is ours).
            assistant.durationMs = Date.now() - startedAt;
            if (assistant.requestId) {
                this.statsStore.record(assistant.requestId, assistant.durationMs).catch(() => { /* noop */ });
            }
        } catch (e) {
            assistant.text = `(error: ${e instanceof Error ? e.message : String(e)})`;
            assistant.streaming = false;
        } finally {
            if (token === this.sendSeq) {
                this.sending = false;
                this.inflightRequestId = undefined;
                if (!this.isDisposed) {
                    this.flushRender();
                    this.uiService.notifySessionsMutated();
                }
            }
        }
    }

    protected async resizeImageFailOpen(img: PendingImage): Promise<PendingImage> {
        try {
            return await this.resizeImageIfNeeded(img);
        } catch (error: unknown) {
            console.warn('[arschat-chat] failed to resize image; sending original image data', error);
            return img;
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

    /**
     * Look up the live ToolRequest for a tool call card by its name. The card's
     * `content.name` is the tool id (arschat-tools register with id === name, and
     * FrontendChatToolRequestService matches on `content.name === toolRequest.id`),
     * so ToolInvocationRegistry.getFunction(name) is the authoritative source for
     * flags like `confirmAlwaysAllow`.
     */
    protected toolRequestFor(view: ToolCallView): ToolRequest | undefined {
        const name = view.content.name;
        return name ? this.toolInvocationRegistry.getFunction(name) : undefined;
    }

    /**
     * Whether a tool call is for a `confirmAlwaysAllow` tool (write_file / edit_file /
     * run_command in arschat-tools). For these, Theia 1.71.2's ToolConfirmationManager
     * treats ALWAYS_ALLOW as the removable default and getConfirmationMode falls back to
     * CONFIRM, so a persisted "常に許可" (setConfirmationMode ALWAYS_ALLOW) does not stick
     * (e-18 verification, BUILD_NOTES). We therefore hide the "常に許可" button for these
     * tools rather than show an ineffective one. "このセッション中"
     * (setSessionConfirmationMode) is NOT subject to this: session overrides are read
     * before the confirmAlwaysAllow fallback in getConfirmationMode, so they do stick.
     */
    protected isConfirmAlwaysAllowTool(view: ToolCallView): boolean {
        return !!this.toolRequestFor(view)?.confirmAlwaysAllow;
    }

    protected onToolAllow(view: ToolCallView, scope: 'once' | 'session' | 'forever'): void {
        const toolId = view.content.name;
        if (toolId && scope === 'forever') {
            // Pass the live ToolRequest so setConfirmationMode computes the correct
            // effective default. The button is hidden for confirmAlwaysAllow tools
            // (see isConfirmAlwaysAllowTool), so this path only runs for tools whose
            // ALWAYS_ALLOW override actually persists.
            this.toolConfirmationManager.setConfirmationMode(toolId, ToolConfirmationMode.ALWAYS_ALLOW, this.toolRequestFor(view));
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

    // ---------------------------------------------------------------- message actions (M6 e-24)

    /** Copy the message's text (assistant markdown source / user text) to the clipboard. */
    protected async copyMessage(msg: UiMessage): Promise<void> {
        const text = msg.text;
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // Fallback for environments without the async clipboard API.
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch { /* noop */ }
            document.body.removeChild(ta);
        }
        msg.copied = true;
        this.update();
        setTimeout(() => { msg.copied = false; this.update(); }, 1200);
    }

    /** True when `msg` is the newest assistant message and nothing is in flight. */
    protected isLastAssistant(msg: UiMessage): boolean {
        if (msg.author !== 'assistant' || this.sending) {
            return false;
        }
        for (let i = this.messages.length - 1; i >= 0; i--) {
            if (this.messages[i].author === 'assistant') {
                return this.messages[i].id === msg.id;
            }
        }
        return false;
    }

    /**
     * Regenerate the last assistant answer: drop its turn (user+assistant) from
     * both the model and the UI, then resend the same user text through the normal
     * send pipeline (re-applying skill expansion, matching the old ArsChat "再生成").
     * The subsequent send auto-saves the model, persisting the drop (M6 e-24).
     */
    protected async regenerate(msg: UiMessage): Promise<void> {
        if (!this.isLastAssistant(msg) || !msg.requestId) {
            return;
        }
        const userMsg = this.messages.find(m => m.author === 'user' && m.requestId === msg.requestId);
        const userText = userMsg?.text;
        if (!userText) {
            return;
        }
        const imagesToResend = this.pendingImagesFromRequest(msg.requestId);
        if (!imagesToResend && userMsg?.images && userMsg.images.length > 0) {
            return;
        }
        // send() drives the resend off `this.inputValue` and clears it once read, so
        // overwriting the input to carry the original user text would silently discard
        // anything the user had started typing. Stash the draft, resend, then restore
        // it so the input box is exactly as the user left it (M6 e-26 review fix).
        const draft = this.inputValue;
        const pendingImageDraft = [...this.pendingImages];
        this.dropTurnFromModel(msg.requestId);
        this.messages = this.messages.filter(m => m.requestId !== msg.requestId);
        this.setInputValue(userText);
        this.pendingImages = imagesToResend ?? [];
        try {
            await this.send();
        } finally {
            this.setInputValue(draft);
            this.pendingImages = pendingImageDraft;
            this.update();
        }
    }

    /** Enter in-place edit mode for one message. */
    protected startEdit(msg: UiMessage): void {
        if (this.sending || msg.streaming) {
            return;
        }
        this.flushComposingUpdate();
        for (const m of this.messages) {
            m.editing = false;
        }
        msg.editing = true;
        this.setEditDraft(msg.text);
        this.update();
        setTimeout(() => {
            const ta = document.getElementById(`arschat-message-edit-${msg.id}`) as HTMLTextAreaElement | null;
            if (ta) {
                ta.focus();
                ta.setSelectionRange(ta.value.length, ta.value.length);
            }
        }, 0);
    }

    /** Leave edit mode without mutating the message/model. */
    protected cancelEdit(msg: UiMessage): void {
        this.flushComposingUpdate();
        msg.editing = false;
        this.setEditDraft('');
        this.update();
    }

    /** Save an edit, using the asymmetric user/assistant behavior required by ms-8. */
    protected async saveEdit(msg: UiMessage): Promise<void> {
        this.flushComposingUpdate();
        const newText = this.editDraft;
        if (msg.author === 'user') {
            await this.saveUserEdit(msg, newText);
        } else {
            await this.saveAssistantEdit(msg, newText);
        }
    }

    /**
     * User edit: drop the edited turn and every following turn, then resend the
     * edited text through the normal send pipeline. The user's current input draft
     * is restored after send(), matching regenerate's draft-preservation behavior.
     */
    protected async saveUserEdit(msg: UiMessage, newText: string): Promise<void> {
        if (!msg.requestId || this.sending || newText.trim().length === 0) {
            return;
        }
        const draft = this.inputValue;
        const pendingImageDraft = [...this.pendingImages];
        const imagesToResend = this.pendingImagesForUserEdit(msg);
        if (!imagesToResend) {
            return;
        }
        const idx = this.messages.findIndex(m => m.id === msg.id);
        if (idx < 0) {
            return;
        }
        const trailingRequestIds = Array.from(new Set(
            this.messages.slice(idx).map(m => m.requestId).filter((id): id is string => !!id)
        ));
        for (const id of trailingRequestIds) {
            this.dropTurnFromModel(id);
            this.statsStore.forget(id).catch(() => { /* noop */ });
        }
        await this.persistCurrentSession();
        this.messages = this.messages.filter(m => !trailingRequestIds.includes(m.requestId ?? ''));
        this.setEditDraft('');
        this.setInputValue(newText);
        this.pendingImages = imagesToResend;
        try {
            await this.send();
        } finally {
            this.setInputValue(draft);
            this.pendingImages = pendingImageDraft;
            this.update();
        }
    }

    /** Assistant edit: replace only the assistant response content and persist. */
    protected async saveAssistantEdit(msg: UiMessage, newText: string): Promise<void> {
        if (!msg.response || msg.streaming) {
            return;
        }
        const mutable = msg.response.response as unknown as MutableResponseContentLike;
        mutable.clearContent();
        mutable.addContent(new TextChatResponseContentImpl(newText));
        msg.text = newText;
        msg.editing = false;
        this.setEditDraft('');
        this.syncToolCalls(msg, msg.response);
        this.update();
        await this.persistCurrentSession();
        this.uiService.notifySessionsMutated();
    }

    /**
     * Continue generation by inserting the explicit follow-up user turn through the
     * regular send path. This is intentionally provider-agnostic and persists as a
     * normal visible turn.
     */
    protected async continueMessage(msg: UiMessage): Promise<void> {
        if (!this.isLastAssistant(msg)) {
            return;
        }
        const draft = this.inputValue;
        this.setInputValue(CONTINUE_PROMPT);
        try {
            await this.send();
        } finally {
            this.setInputValue(draft);
            this.update();
        }
    }

    /** Create a new persisted session containing the active request slice up to msg. */
    protected async branchMessage(msg: UiMessage): Promise<void> {
        if (!this.sessionId || !msg.requestId || this.sending) {
            return;
        }
        const session = this.chatService.getSession(this.sessionId);
        if (!session) {
            return;
        }
        const requests = session.model.getRequests();
        const idx = requests.findIndex(req => req.id === msg.requestId);
        if (idx < 0) {
            return;
        }
        const slice = requests.slice(0, idx + 1);
        if (slice.length === 0) {
            return;
        }

        const branches: { [branchId: string]: SerializableHierarchyBranch } = {};
        let rootBranchId: string | undefined;
        let prevBranchId: string | undefined;
        for (const req of slice) {
            const branchId = `${req.id}-branch`;
            branches[branchId] = { id: branchId, items: [{ requestId: req.id }], activeBranchIndex: 0 };
            if (prevBranchId) {
                branches[prevBranchId].items[0].nextBranchId = branchId;
            }
            rootBranchId = rootBranchId ?? branchId;
            prevBranchId = branchId;
        }

        const newSessionId = generateUuid();
        const serialized: SerializedChatModel = {
            sessionId: newSessionId,
            location: session.model.location,
            hierarchy: { rootBranchId: rootBranchId!, branches },
            requests: slice.map(req => req.toSerializable()),
            responses: slice.map(req => req.response.toSerializable())
        };
        const model = new MutableChatModel(serialized);
        this.restoreBranchResponseContent(model, slice);
        const firstUserText = requests[0]?.request.displayText ?? requests[0]?.request.text ?? '';
        const title = `[分岐] ${firstUserText.slice(0, 50) || '新しい会話'}`;

        await this.chatSessionStore.storeSessions({
            model,
            title,
            pinnedAgentId: session.pinnedAgent?.id
        }).catch(() => { /* noop */ });
        await this.loadSession(newSessionId);
        this.uiService.notifySessionsMutated();
    }

    /**
     * MutableChatModel restores response metadata only. Theia leaves content
     * restoration to ChatService deserializers, so a freshly constructed branch
     * model must be repopulated before storeSessions serializes it.
     */
    protected restoreBranchResponseContent(model: MutableChatModel, sourceRequests: ChatRequestModel[]): void {
        const targets = new Map(model.getRequests().map(req => [req.id, req]));
        for (const source of sourceRequests) {
            const content = source.response.response.content;
            if (content.length === 0) {
                continue;
            }
            const target = targets.get(source.id);
            const mutable = target?.response.response as unknown as MutableResponseContentLike | undefined;
            if (!mutable) {
                continue;
            }
            if (mutable.addContents) {
                mutable.addContents(content);
            } else {
                content.forEach(part => mutable.addContent(part));
            }
        }
    }

    /** Delete a whole turn (user+assistant) from the session and persist the change. */
    protected async deleteMessage(msg: UiMessage): Promise<void> {
        if (this.sending || !msg.requestId) {
            return;
        }
        const requestId = msg.requestId;
        this.dropTurnFromModel(requestId);
        this.messages = this.messages.filter(m => m.requestId !== requestId);
        this.update();
        await this.persistCurrentSession();
        // Drop the recorded duration too - the turn no longer exists (M6 e-25).
        this.statsStore.forget(requestId).catch(() => { /* noop */ });
        this.uiService.notifySessionsMutated();
    }

    /** Remove a turn from the live ChatModel's request hierarchy (no persistence). */
    protected dropTurnFromModel(requestId: string): void {
        if (!this.sessionId) {
            return;
        }
        const session = this.chatService.getSession(this.sessionId);
        if (session) {
            removeRequestFromModel(session.model as unknown as RequestTreeModel, requestId);
        }
    }

    /**
     * Persist the current session's (mutated) model to the chat session store.
     * Theia's auto-save fires on model onDidChange; a manual request-tree edit does
     * not, so we store explicitly after a delete.
     */
    protected async persistCurrentSession(): Promise<void> {
        if (!this.sessionId) {
            return;
        }
        const session = this.chatService.getSession(this.sessionId);
        if (session) {
            const sessionToStore: ChatModelWithMetadata = {
                model: session.model,
                title: session.title,
                pinnedAgentId: session.pinnedAgent?.id
            };
            await this.chatSessionStore.storeSessions(sessionToStore).catch(() => { /* noop */ });
        }
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

    protected onInputCompositionStart(): void {
        this.composing = true;
    }

    protected onInputCompositionEnd(e: React.CompositionEvent<HTMLTextAreaElement>): void {
        this.flushComposingUpdate();
        this.onInputChange(e.currentTarget.value);
    }

    protected onEditDraftChange(value: string): void {
        this.editDraft = value;
        this.update();
    }

    protected onEditCompositionEnd(e: React.CompositionEvent<HTMLTextAreaElement>): void {
        this.flushComposingUpdate();
        this.onEditDraftChange(e.currentTarget.value);
    }

    protected onCustomEndpointCompositionEnd(e: React.CompositionEvent<HTMLInputElement>): void {
        this.flushComposingUpdate();
        this.onCustomEndpointDraftChange(e.currentTarget.value);
    }

    protected isImeActive(e: React.KeyboardEvent): boolean {
        return e.nativeEvent.isComposing || e.keyCode === 229 || this.composing;
    }

    /** Accept a suggestion: set the input to `/trigger ` and dismiss the popup. */
    protected selectSuggestion(skill: Skill): void {
        this.setInputValue(`${skill.trigger} `);
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
        const imeActive = this.isImeActive(e);
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
            if (!imeActive && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
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
        if (e.key === 'Enter' && !e.shiftKey && !imeActive) {
            e.preventDefault();
            this.send();
        }
    }

    protected renderModelOptions(modelNames: string[]): React.ReactNode {
        if (this.isCustomEndpointProvider(this.provider)) {
            const state = this.customModelLoadStates.get(this.provider);
            if (state === 'loading') {
                return <option value='' disabled>(取得中...)</option>;
            }
            if (state === 'error') {
                return <option value='' disabled>(接続できません)</option>;
            }
        }
        if (modelNames.length === 0) {
            return <option value=''>(no models)</option>;
        }
        return modelNames.map(name => (
            <option key={name} value={name}>{name}</option>
        ));
    }

    protected currentModelSelectValue(modelNames: string[]): string {
        if (this.isCustomEndpointProvider(this.provider)) {
            const state = this.customModelLoadStates.get(this.provider);
            if (state === 'loading' || state === 'error') {
                return '';
            }
        }
        return modelNames.includes(this.model) ? this.model : '';
    }

    // ---------------------------------------------------------------- render

    render(): React.ReactElement {
        const modelNames = this.currentModelNames();
        const customModelState = this.customModelLoadStates.get(this.provider);
        const modelSelectDisabled = customModelState === 'loading' || customModelState === 'error';
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
                            value={this.currentModelSelectValue(modelNames)}
                            disabled={modelSelectDisabled}
                            onChange={e => this.onModelChange(e.target.value)}
                        >
                            {this.renderModelOptions(modelNames)}
                        </select>
                    </div>
                </div>
                {this.isCustomEndpointProvider(this.provider) && (
                    <div className='arschat-custom-endpoint-row'>
                        <label className='arschat-custom-endpoint-label' htmlFor='arschat-custom-endpoint-url'>接続先</label>
                        <input
                            id='arschat-custom-endpoint-url'
                            className='theia-input arschat-custom-endpoint-url'
                            type='text'
                            ref={this.endpointInputRef}
                            defaultValue={this.customEndpointDraft}
                            spellCheck={false}
                            onChange={e => this.onCustomEndpointDraftChange(e.currentTarget.value)}
                            onKeyDown={e => this.onCustomEndpointKeyDown(e)}
                            onCompositionStart={() => this.onInputCompositionStart()}
                            onCompositionEnd={e => this.onCustomEndpointCompositionEnd(e)}
                            onBlur={() => {
                                this.flushComposingUpdate();
                                this.commitCustomEndpointUrl();
                            }}
                        />
                        {this.customEndpointError && (
                            <span className='arschat-custom-endpoint-error'>{this.customEndpointError}</span>
                        )}
                    </div>
                )}
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
                        ref={this.inputRef}
                        defaultValue={this.inputValue}
                        disabled={this.sending}
                        rows={1}
                        onChange={e => this.onInputChange(e.target.value)}
                        onPaste={e => this.handlePaste(e)}
                        onKeyDown={e => this.onInputKeyDown(e)}
                        onCompositionStart={() => this.onInputCompositionStart()}
                        onCompositionEnd={e => this.onInputCompositionEnd(e)}
                        onBlur={() => this.flushComposingUpdate()}
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

    protected renderEditForm(msg: UiMessage): React.ReactElement {
        return (
            <div className='arschat-message-edit'>
                <textarea
                    id={`arschat-message-edit-${msg.id}`}
                    className='theia-input arschat-message-edit-textarea'
                    ref={this.editTextareaRef}
                    defaultValue={this.editDraft}
                    onChange={e => this.onEditDraftChange(e.currentTarget.value)}
                    onKeyDown={e => {
                        const imeActive = this.isImeActive(e);
                        if (e.key === 'Enter' && !e.shiftKey && !imeActive) {
                            e.preventDefault();
                            this.saveEdit(msg);
                        } else if (e.key === 'Escape' && !imeActive) {
                            e.preventDefault();
                            this.cancelEdit(msg);
                        }
                    }}
                    onCompositionStart={() => this.onInputCompositionStart()}
                    onCompositionEnd={e => this.onEditCompositionEnd(e)}
                    onBlur={() => this.flushComposingUpdate()}
                />
                <div className='arschat-message-edit-actions'>
                    <button
                        className='theia-button secondary arschat-message-edit-cancel'
                        onClick={() => this.cancelEdit(msg)}
                    >キャンセル</button>
                    <button
                        className='theia-button arschat-message-edit-save'
                        disabled={this.editDraft.trim().length === 0}
                        onClick={() => this.saveEdit(msg)}
                    >保存</button>
                </div>
            </div>
        );
    }

    protected renderMessage(msg: UiMessage): React.ReactElement {
        if (msg.author === 'user') {
            return (
                <div key={msg.id} className='arschat-chat-message arschat-chat-message-user'>
                    <div className='arschat-message-col'>
                    <div className='arschat-chat-message-bubble'>
                        {msg.images && msg.images.length > 0 && (
                            <div className='arschat-message-images'>
                                {msg.images.map((src, i) => (
                                    <img key={i} src={src} className='arschat-message-image' alt='attachment' />
                                ))}
                            </div>
                        )}
                        {msg.editing ? this.renderEditForm(msg) : (msg.text && <div className='arschat-user-text'>{msg.text}</div>)}
                    </div>
                    {!msg.editing && msg.requestId && this.renderMessageActions(msg)}
                    </div>
                </div>
            );
        }

        // assistant: split <think>, render markdown for the visible part.
        const { thinking, response, isThinkingInProgress } = parseThinkBlocks(msg.text);
        const html = renderMarkdown(response);
        return (
            <div key={msg.id} className='arschat-chat-message arschat-chat-message-assistant'>
                <div className='arschat-message-col'>
                <div className='arschat-chat-message-bubble'>
                    {msg.editing ? this.renderEditForm(msg) : (
                    <>
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
                    </>
                    )}
                </div>
                {!msg.editing && !msg.streaming && this.renderStatsBar(msg)}
                {!msg.editing && !msg.streaming && msg.requestId && this.renderMessageActions(msg)}
                </div>
            </div>
        );
    }

    /**
     * Token / speed / elapsed-time bar under a finished assistant message
     * (M6 e-25, old ArsChat MessageBubble.tsx 485-531). Token counts come from the
     * response's persisted tokenUsage when the provider reported usage; otherwise
     * a char-based approximation is shown (indistinguishable in the UI by design -
     * see arschat-message-stats.ts).
     */
    protected renderStatsBar(msg: UiMessage): React.ReactNode {
        // Only real turns get a stats bar (no requestId = error placeholder etc.).
        if (!msg.requestId) {
            return undefined;
        }
        const usage = msg.response?.tokenUsage as ResponseTokenUsageLike | undefined;
        const stats = computeMessageStats(msg.text, usage, msg.durationMs);
        if (!hasDisplayableStats(stats)) {
            return undefined;
        }
        return (
            <div className='arschat-message-stats'>
                {stats.tokensPerSec !== undefined && (
                    <span className='arschat-message-stat'>
                        <svg width='10' height='10' viewBox='0 0 16 16' fill='none' aria-hidden='true'>
                            <path d='M13.5 2.5A6.5 6.5 0 1 0 14.5 8' stroke='currentColor' strokeWidth='1.5' strokeLinecap='round' />
                            <path d='M14.5 2.5v3h-3' stroke='currentColor' strokeWidth='1.5' strokeLinecap='round' strokeLinejoin='round' />
                        </svg>
                        {stats.tokensPerSec.toFixed(2)} トークン/秒
                    </span>
                )}
                {stats.totalTokens !== undefined && (
                    <span className='arschat-message-stat'>
                        <svg width='10' height='10' viewBox='0 0 16 16' fill='none' aria-hidden='true'>
                            <rect x='1' y='7' width='3' height='8' rx='0.5' fill='currentColor' />
                            <rect x='6' y='4' width='3' height='11' rx='0.5' fill='currentColor' />
                            <rect x='11' y='1' width='3' height='14' rx='0.5' fill='currentColor' />
                        </svg>
                        {stats.totalTokens} トークン
                    </span>
                )}
                {stats.durationSeconds !== undefined && (
                    <span className='arschat-message-stat'>
                        <svg width='10' height='10' viewBox='0 0 16 16' fill='none' aria-hidden='true'>
                            <circle cx='8' cy='8' r='6.5' stroke='currentColor' strokeWidth='1.3' />
                            <path d='M8 4.5V8l2.5 2' stroke='currentColor' strokeWidth='1.3' strokeLinecap='round' />
                        </svg>
                        {stats.durationSeconds.toFixed(1)}s
                    </span>
                )}
            </div>
        );
    }

    /**
     * Hover action bar under an assistant message (M6 e-24). Copy is always
     * available; 再生成 only on the newest assistant answer; 削除 removes the whole
     * turn. Visibility is CSS-driven (fade in on message hover) to match the old
     * ArsChat MessageBubble.tsx affordance.
     */
    protected renderMessageActions(msg: UiMessage): React.ReactElement {
        const canRegenerate = this.isLastAssistant(msg);
        return (
            <div className='arschat-message-actions'>
                <button
                    className='arschat-message-action'
                    title={msg.copied ? 'コピーしました' : 'コピー'}
                    onClick={() => this.copyMessage(msg)}
                >
                    {msg.copied ? (
                        <svg width='12' height='12' viewBox='0 0 16 16' fill='none' aria-hidden='true'>
                            <path d='M3 8l3.5 3.5L13 4' stroke='var(--theia-successBackground, #22c55e)'
                                strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' />
                        </svg>
                    ) : (
                        <svg width='12' height='12' viewBox='0 0 16 16' fill='none' aria-hidden='true'>
                            <rect x='5' y='4' width='8' height='10' rx='1.5' stroke='currentColor' strokeWidth='1.2' />
                            <path d='M5 3.5V3A1.5 1.5 0 0 0 3.5 1.5h0A1.5 1.5 0 0 0 2 3v8A1.5 1.5 0 0 0 3.5 12.5H5'
                                stroke='currentColor' strokeWidth='1.2' />
                        </svg>
                    )}
                </button>
                {this.canEditMessage(msg) && (
                    <button
                        className='arschat-message-action arschat-message-action-edit'
                        title='編集'
                        onClick={() => this.startEdit(msg)}
                    >
                        <svg width='12' height='12' viewBox='0 0 16 16' fill='none' aria-hidden='true'>
                            <path d='M11 2.5l2.5 2.5L5 13.5H2.5V11L11 2.5z'
                                stroke='currentColor' strokeWidth='1.2' strokeLinecap='round' strokeLinejoin='round' />
                        </svg>
                    </button>
                )}
                {canRegenerate && (
                    <button
                        className='arschat-message-action arschat-message-action-regenerate'
                        title='再生成'
                        onClick={() => this.regenerate(msg)}
                    >
                        <svg width='12' height='12' viewBox='0 0 16 16' fill='none' aria-hidden='true'>
                            <path d='M13 2.5A6 6 0 1 0 14 8' stroke='currentColor' strokeWidth='1.3' strokeLinecap='round' />
                            <path d='M14 2.5v3h-3' stroke='currentColor' strokeWidth='1.3' strokeLinecap='round' strokeLinejoin='round' />
                        </svg>
                    </button>
                )}
                {canRegenerate && (
                    <button
                        className='arschat-message-action arschat-message-action-continue'
                        title='続きを生成'
                        onClick={() => this.continueMessage(msg)}
                    >
                        <svg width='12' height='12' viewBox='0 0 16 16' fill='none' aria-hidden='true'>
                            <path d='M3 8h10M10 5l3 3-3 3'
                                stroke='currentColor' strokeWidth='1.3' strokeLinecap='round' strokeLinejoin='round' />
                        </svg>
                    </button>
                )}
                <button
                    className='arschat-message-action arschat-message-action-branch'
                    title='ここから分岐'
                    onClick={() => this.branchMessage(msg)}
                >
                    <svg width='12' height='12' viewBox='0 0 16 16' fill='none' aria-hidden='true'>
                        <circle cx='4' cy='3' r='1.5' stroke='currentColor' strokeWidth='1.2' />
                        <circle cx='4' cy='13' r='1.5' stroke='currentColor' strokeWidth='1.2' />
                        <circle cx='12' cy='8' r='1.5' stroke='currentColor' strokeWidth='1.2' />
                        <path d='M4 4.5v7' stroke='currentColor' strokeWidth='1.2' strokeLinecap='round' />
                        <path d='M4 7.5Q4 8 6 8h4.5' stroke='currentColor' strokeWidth='1.2' strokeLinecap='round' />
                    </svg>
                </button>
                <button
                    className='arschat-message-action arschat-message-action-delete'
                    title='削除'
                    onClick={() => this.deleteMessage(msg)}
                >
                    <svg width='12' height='12' viewBox='0 0 16 16' fill='none' aria-hidden='true'>
                        <path d='M3 4.5h10M6 4.5V3h4v1.5M5.5 4.5l.5 8h4l.5-8'
                            stroke='currentColor' strokeWidth='1.2' strokeLinecap='round' strokeLinejoin='round' />
                    </svg>
                </button>
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
                            {/* "常に許可" is only offered for tools whose persisted ALWAYS_ALLOW
                                actually sticks. For confirmAlwaysAllow tools (write_file /
                                edit_file / run_command) Theia 1.71.2 discards it and falls back
                                to CONFIRM, so we hide the button instead of showing a no-op
                                (e-18). "セッション中" stays because session overrides do stick. */}
                            {!this.isConfirmAlwaysAllowTool(view) && (
                                <button
                                    className='theia-button secondary arschat-tool-allow-forever'
                                    title='常に許可 (以後このツールは確認しない)'
                                    onClick={() => this.onToolAllow(view, 'forever')}
                                >常に許可</button>
                            )}
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
