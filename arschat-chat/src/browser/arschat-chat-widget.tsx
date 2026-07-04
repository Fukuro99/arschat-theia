// *****************************************************************************
// ArsChat chat widget (PHASE1_DESIGN.md §5, M2 stopgap wiring).
//
// M2 upgrade over the M1 dummy: this ReactWidget now
//   - shows provider + model dropdowns in the header, two-way bound to the
//     ArsChat active-provider/model preferences via ProviderSwitchService;
//   - sends the input through ChatService -> the ArsChat agent and renders the
//     streaming response.
//
// This is intentionally minimal. The production chat UI (think blocks, images,
// tool cards, history, session store) is M3. The point here is only that all
// four providers can be selected from the header and complete a real round-trip.
// *****************************************************************************

import * as React from 'react';
import { injectable, postConstruct, inject } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/lib/browser';
import { ChatService } from '@theia/ai-chat/lib/common/chat-service';
import { ChatAgentService } from '@theia/ai-chat/lib/common/chat-agent-service';
import { ChatResponseModel } from '@theia/ai-chat/lib/common/chat-model';
import { LanguageModel } from '@theia/ai-core';
import {
    ArschatProviderKind,
    PROVIDERS
} from 'arschat-providers/lib/browser/arschat-provider-preferences';
import { ProviderSwitchService, ARSCHAT_CHAT_AGENT_ID } from 'arschat-providers/lib/browser/provider-switch-service';

interface UiMessage {
    id: number;
    author: 'user' | 'assistant';
    text: string;
    streaming?: boolean;
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

    protected sessionId: string | undefined;

    protected messages: UiMessage[] = [];
    protected nextId = 1;
    protected inputValue = '';
    protected sending = false;

    protected provider: ArschatProviderKind = 'anthropic';
    protected model = '';
    protected modelsByProvider: Map<ArschatProviderKind, LanguageModel[]> = new Map();

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

        // If no model chosen yet for the active provider, pick the first available.
        await this.ensureModelSelected();

        // Reflect external preference changes (e.g. edited in settings) in the header.
        this.switchService.onDidChange(sel => {
            this.provider = sel.provider;
            this.model = sel.model;
            this.update();
        });

        this.update();
    }

    protected async refreshModels(): Promise<void> {
        for (const p of PROVIDERS) {
            this.modelsByProvider.set(p.kind, await this.switchService.getModelsForProvider(p.kind));
        }
    }

    /** Model names offered in the dropdown for the current provider. */
    protected currentModelNames(): string[] {
        const provider = PROVIDERS.find(p => p.kind === this.provider);
        const models = this.modelsByProvider.get(this.provider) ?? [];
        if (provider?.fixedModelId) {
            // Custom endpoints expose a single logical model (the endpoint id).
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

    protected getSessionId(): string {
        if (!this.sessionId) {
            const agent = this.chatAgentService.getAgent(ARSCHAT_CHAT_AGENT_ID);
            const session = this.chatService.createSession(undefined, { focus: false }, agent);
            this.sessionId = session.id;
        }
        return this.sessionId;
    }

    protected async send(): Promise<void> {
        const text = this.inputValue.trim();
        if (!text || this.sending) {
            return;
        }
        this.sending = true;
        this.messages.push({ id: this.nextId++, author: 'user', text });
        this.inputValue = '';

        const assistant: UiMessage = { id: this.nextId++, author: 'assistant', text: '', streaming: true };
        this.messages.push(assistant);
        this.update();

        try {
            const modelId = this.switchService.resolveActiveModelId();
            console.log(`[arschat-chat] sending request (provider='${this.provider}', model='${this.model}', resolved LanguageModel id='${modelId ?? '<none>'}')`);
            const invocation = await this.chatService.sendRequest(this.getSessionId(), { text });
            if (!invocation) {
                assistant.text = '(error: no chat session)';
                assistant.streaming = false;
                this.sending = false;
                this.update();
                return;
            }
            const response = await invocation.responseCreated;
            const render = () => {
                assistant.text = this.responseToText(response);
                this.update();
            };
            const sub = response.onDidChange(() => {
                render();
                if (response.isComplete || response.isError) {
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
            this.update();
        }
    }

    protected responseToText(response: ChatResponseModel): string {
        const parts = response.response.content as Array<{ asString?: () => string | undefined; asDisplayString?: () => string | undefined }>;
        return parts.map(c => c.asString?.() ?? c.asDisplayString?.() ?? '').join('');
    }

    render(): React.ReactElement {
        const modelNames = this.currentModelNames();
        return (
            <div id='arschat-chat-root'>
                <div className='arschat-chat-header'>
                    <span className='arschat-chat-header-title'>ArsChat</span>
                    <div className='arschat-chat-header-controls'>
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
                                ArsChat (M2)。ヘッダーのドロップダウンでプロバイダ/モデルを選び、メッセージを送信してください。
                            </div>
                        </div>
                    )}
                    {this.messages.map(msg => (
                        <div key={msg.id} className={`arschat-chat-message arschat-chat-message-${msg.author}`}>
                            <div className='arschat-chat-message-bubble'>
                                {msg.text}
                                {msg.streaming && <span className='arschat-chat-cursor'> ▍</span>}
                            </div>
                        </div>
                    ))}
                </div>
                <div className='arschat-chat-input-bar'>
                    <input
                        id='arschat-chat-input'
                        className='theia-input arschat-chat-input'
                        type='text'
                        placeholder='メッセージを入力...'
                        value={this.inputValue}
                        disabled={this.sending}
                        onChange={e => { this.inputValue = e.target.value; this.update(); }}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); } }}
                    />
                    <button
                        id='arschat-chat-send-button'
                        className='theia-button arschat-chat-send-button'
                        title='Send'
                        disabled={this.sending || this.inputValue.trim().length === 0}
                        onClick={() => this.send()}
                    >
                        {this.sending ? '送信中...' : '送信'}
                    </button>
                </div>
            </div>
        );
    }

    protected onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        const htmlElement = document.getElementById('arschat-chat-input');
        if (htmlElement) {
            htmlElement.focus();
        }
    }
}
