// *****************************************************************************
// ArsChat history panel (PHASE1_DESIGN.md §5, M3).
//
// Left-sidebar View listing persisted chat sessions (title + date, newest
// first), matching the old ArsChat Sidebar HistoryPanel UX:
//   - click a row  -> load/restore that session into the main chat widget;
//   - "+ 新規"     -> start a new empty session;
//   - trash icon   -> delete that session.
//
// Session metadata comes from ChatService.getPersistedSessions() (which is
// ChatSessionStore.getSessionIndex under the hood). Session control is routed to
// the chat widget through ArschatChatUiService so this panel never imports the
// widget directly.
// *****************************************************************************

import * as React from 'react';
import { injectable, postConstruct, inject } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { DisposableCollection } from '@theia/core';
import { ChatService } from '@theia/ai-chat/lib/common/chat-service';
import { ChatSessionMetadata } from '@theia/ai-chat/lib/common/chat-session-store';
import { ArschatChatUiService } from './arschat-chat-ui-service';

@injectable()
export class ArschatHistoryWidget extends ReactWidget {

    static readonly ID = 'arschat-chat:history';
    static readonly LABEL = '履歴';

    @inject(ChatService)
    protected readonly chatService!: ChatService;

    @inject(ArschatChatUiService)
    protected readonly uiService!: ArschatChatUiService;

    protected sessions: ChatSessionMetadata[] = [];
    protected activeSessionId: string | undefined;
    protected loading = true;

    protected readonly toDispose = new DisposableCollection();

    @postConstruct()
    protected init(): void {
        this.id = ArschatHistoryWidget.ID;
        this.title.label = ArschatHistoryWidget.LABEL;
        this.title.caption = ArschatHistoryWidget.LABEL;
        this.title.iconClass = 'fa fa-history';
        this.title.closable = true;
        this.addClass('arschat-history-widget');

        this.toDispose.push(this.uiService.onSessionsMutated(() => this.refresh()));
        this.toDispose.push(this.uiService.onSessionChanged(id => {
            this.activeSessionId = id;
            this.refresh();
        }));

        // Defer the first disk-backed refresh off the widget-creation / layout-init
        // path so restoring the shell layout never blocks on session storage I/O.
        setTimeout(() => this.refresh(), 0);
    }

    override dispose(): void {
        this.toDispose.dispose();
        super.dispose();
    }

    async refresh(): Promise<void> {
        try {
            const index = await this.chatService.getPersistedSessions();
            this.sessions = Object.values(index).sort((a, b) => b.saveDate - a.saveDate);
        } catch (e) {
            console.warn('[arschat-chat] failed to load persisted sessions', e);
            this.sessions = [];
        }
        this.loading = false;
        this.update();
    }

    protected onActivate(): void {
        this.refresh();
    }

    protected async onDelete(sessionId: string, event: React.MouseEvent): Promise<void> {
        event.stopPropagation();
        await this.chatService.deleteSession(sessionId).catch(() => { /* noop */ });
        if (this.activeSessionId === sessionId) {
            this.uiService.requestNewSession();
        }
        this.uiService.notifySessionsMutated();
        this.refresh();
    }

    protected formatDate(ms: number): string {
        try {
            return new Date(ms).toLocaleString();
        } catch {
            return '';
        }
    }

    render(): React.ReactElement {
        return (
            <div className='arschat-history-root'>
                <div className='arschat-history-toolbar'>
                    <button
                        className='theia-button arschat-history-new'
                        title='新しいチャット'
                        onClick={() => this.uiService.requestNewSession()}
                    >+ 新規チャット</button>
                </div>
                <div className='arschat-history-list'>
                    {this.loading && <div className='arschat-history-empty'>読み込み中…</div>}
                    {!this.loading && this.sessions.length === 0 && (
                        <div className='arschat-history-empty'>まだ履歴がありません。</div>
                    )}
                    {this.sessions.map(s => (
                        <div
                            key={s.sessionId}
                            className={`arschat-history-item${s.sessionId === this.activeSessionId ? ' active' : ''}`}
                            title={s.title}
                            onClick={() => this.uiService.requestLoadSession(s.sessionId)}
                        >
                            <div className='arschat-history-item-main'>
                                <div className='arschat-history-item-title'>{s.title || '(無題のチャット)'}</div>
                                <div className='arschat-history-item-date'>{this.formatDate(s.saveDate)}</div>
                            </div>
                            <button
                                className='arschat-history-item-delete'
                                title='削除'
                                onClick={e => this.onDelete(s.sessionId, e)}
                            >🗑</button>
                        </div>
                    ))}
                </div>
            </div>
        );
    }
}
