// *****************************************************************************
// ArsChat PoC-2: chat-first main-area widget.
//
// This repurposes the generator-scaffolded `ArschatCoreWidget` (originally a
// left-panel "sample widget with a button") into a dummy chat UI that occupies
// the main area. It is intentionally static (no real chat backend) - the goal
// of PoC-2 is only to prove that a ReactWidget can be made to look like a
// chat app's primary surface and can take over the main area on startup, not
// to build the real chat feature.
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
    { id: 1, author: 'assistant', text: 'こんにちは。ArsChat PoC-2 のダミーチャット画面です。' },
    { id: 2, author: 'user', text: 'このウィジェットはメインエリアを占有していますか？' },
    { id: 3, author: 'assistant', text: 'はい。起動直後からエディタや Getting Started の代わりにこの画面が表示されています。' },
];

@injectable()
export class ArschatCoreWidget extends ReactWidget {

    static readonly ID = 'arschat-core:widget';
    static readonly LABEL = 'ArsChat';

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @postConstruct()
    protected init(): void {
        this.doInit();
    }

    protected async doInit(): Promise<void> {
        this.id = ArschatCoreWidget.ID;
        this.title.label = ArschatCoreWidget.LABEL;
        this.title.caption = ArschatCoreWidget.LABEL;
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
                        placeholder='メッセージを入力...(PoC ダミー、送信はできません)'
                        readOnly
                    />
                    <button
                        id='arschat-chat-send-button'
                        className='theia-button arschat-chat-send-button'
                        title='Send (PoC dummy)'
                        onClick={() => this.displayMessage()}
                    >
                        送信
                    </button>
                </div>
            </div>
        );
    }

    protected displayMessage(): void {
        this.messageService.info('PoC-2: これはダミーの送信ボタンです（実際の送信機能はありません）');
    }

    protected onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        const htmlElement = document.getElementById('arschat-chat-send-button');
        if (htmlElement) {
            htmlElement.focus();
        }
    }

}
