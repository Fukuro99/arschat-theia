// *****************************************************************************
// ArsChat chat widget: chat-first main-area ReactWidget.
//
// Moved here from arschat-core (PoC-2's `ArschatCoreWidget`) during the M1
// package re-org. Still the PoC's static dummy chat UI - the real chat
// backend (streaming, sessions, history) lands in M3 (PHASE1_DESIGN.md §5).
// The goal at this stage is unchanged: prove a ReactWidget can be the app's
// primary surface and take over the main area on startup.
//
// Renamed ArschatCoreWidget -> ArschatChatWidget and the widget id
// 'arschat-core:widget' -> 'arschat-chat:widget' so the DI class name, the
// widget id string and the owning package are all consistent (a stale
// 'arschat-core:widget' id in a persisted layout would otherwise break
// startup layout restoration - see BUILD_NOTES.md M1 notes).
// *****************************************************************************

import * as React from 'react';
import { injectable, postConstruct, inject } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core';
import { Message } from '@theia/core/lib/browser';

interface DummyMessage {
    id: number;
    author: 'user' | 'assistant';
    text: string;
}

const DUMMY_MESSAGES: DummyMessage[] = [
    { id: 1, author: 'assistant', text: 'こんにちは。ArsChat のチャット画面です（M1 時点ではダミー UI）。' },
    { id: 2, author: 'user', text: 'このウィジェットはメインエリアを占有していますか？' },
    { id: 3, author: 'assistant', text: 'はい。起動直後からエディタや Getting Started の代わりにこの画面が表示されています。' },
];

@injectable()
export class ArschatChatWidget extends ReactWidget {

    static readonly ID = 'arschat-chat:widget';
    static readonly LABEL = 'ArsChat';

    @inject(MessageService)
    protected readonly messageService!: MessageService;

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
        this.update();
    }

    render(): React.ReactElement {
        return (
            <div id='arschat-chat-root'>
                <div className='arschat-chat-header'>
                    <span className='arschat-chat-header-title'>ArsChat</span>
                </div>
                <div className='arschat-chat-messages'>
                    {DUMMY_MESSAGES.map(msg => (
                        <div key={msg.id} className={`arschat-chat-message arschat-chat-message-${msg.author}`}>
                            <div className='arschat-chat-message-bubble'>{msg.text}</div>
                        </div>
                    ))}
                </div>
                <div className='arschat-chat-input-bar'>
                    <input
                        id='arschat-chat-input'
                        className='theia-input arschat-chat-input'
                        type='text'
                        placeholder='メッセージを入力...(M1 ダミー、送信はできません)'
                        readOnly
                    />
                    <button
                        id='arschat-chat-send-button'
                        className='theia-button arschat-chat-send-button'
                        title='Send (dummy)'
                        onClick={() => this.displayMessage()}
                    >
                        送信
                    </button>
                </div>
            </div>
        );
    }

    protected displayMessage(): void {
        this.messageService.info('M1: これはダミーの送信ボタンです（実際の送信機能は M3 で実装）');
    }

    protected onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        const htmlElement = document.getElementById('arschat-chat-send-button');
        if (htmlElement) {
            htmlElement.focus();
        }
    }

}
