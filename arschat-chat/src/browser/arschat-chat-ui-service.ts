// *****************************************************************************
// ArsChat chat-UI coordination service (PHASE1_DESIGN.md §5).
//
// A tiny singleton that lets the history panel (a separate View) drive the main
// chat widget without a hard reference cycle:
//   - the history panel fires `requestLoadSession(id)` / `requestNewSession()`;
//   - the chat widget subscribes and reacts (restore session / start fresh);
//   - the chat widget fires `onSessionChanged` so the history panel can refresh
//     its list + highlight the active row.
//
// Both live in arschat-chat, but going through this service keeps the widget and
// the panel decoupled (either can be created first; neither imports the other).
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core';

@injectable()
export class ArschatChatUiService {

    protected readonly onLoadSessionEmitter = new Emitter<string>();
    /** History panel -> widget: load/restore this persisted session. */
    readonly onLoadSessionRequested: Event<string> = this.onLoadSessionEmitter.event;

    protected readonly onNewSessionEmitter = new Emitter<void>();
    /** History panel (or command) -> widget: start a brand-new empty session. */
    readonly onNewSessionRequested: Event<void> = this.onNewSessionEmitter.event;

    protected readonly onSessionChangedEmitter = new Emitter<string | undefined>();
    /** Widget -> history panel: the active session changed (id, or undefined for a fresh unsaved one). */
    readonly onSessionChanged: Event<string | undefined> = this.onSessionChangedEmitter.event;

    protected readonly onSessionsMutatedEmitter = new Emitter<void>();
    /** Anyone -> history panel: the persisted session set changed (created/deleted/renamed). */
    readonly onSessionsMutated: Event<void> = this.onSessionsMutatedEmitter.event;

    requestLoadSession(sessionId: string): void {
        this.onLoadSessionEmitter.fire(sessionId);
    }

    requestNewSession(): void {
        this.onNewSessionEmitter.fire();
    }

    notifySessionChanged(sessionId: string | undefined): void {
        this.onSessionChangedEmitter.fire(sessionId);
    }

    notifySessionsMutated(): void {
        this.onSessionsMutatedEmitter.fire();
    }
}
