// *****************************************************************************
// Browser-side rendezvous point for MS13 interactive UI tool calls.
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
import { CancellationToken } from '@theia/core/lib/common/cancellation';
import { Disposable } from '@theia/core/lib/common/disposable';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { Emitter, Event } from '@theia/core/lib/common/event';
import type { ToolCallResult } from '@theia/ai-core/lib/common/language-model';
import { RenderUiToolBackend } from '../common/render-ui-tool-request';
import { UpdateUiToolBackend } from '../common/update-ui-tool-request';
import { CancelledError } from '../common/tool-args';

export interface ArschatUiPatchEvent {
    uiId: string;
    patch: Record<string, unknown>;
}

interface LiveUiSession {
    uiId: string;
    currentToolCallId?: string;
    actionCount: number;
    finished: boolean;
}

const MAX_UI_INTERACTIONS = 50;

@injectable()
export class ArschatUiInteractionService implements RenderUiToolBackend, UpdateUiToolBackend {

    protected readonly pending = new Map<string, Deferred<ToolCallResult>>();
    protected readonly earlyResolved = new Map<string, ToolCallResult>();
    protected readonly liveSessions = new Map<string, LiveUiSession>();
    protected readonly onDidApplyPatchEmitter = new Emitter<ArschatUiPatchEvent>();

    get onDidApplyPatch(): Event<ArschatUiPatchEvent> {
        return this.onDidApplyPatchEmitter.event;
    }

    async awaitInteraction(toolCallId: string, cancellationToken?: CancellationToken): Promise<ToolCallResult> {
        if (cancellationToken?.isCancellationRequested) {
            throw new CancelledError();
        }
        if (this.earlyResolved.has(toolCallId)) {
            const data = this.earlyResolved.get(toolCallId)!;
            this.earlyResolved.delete(toolCallId);
            return data;
        }
        const previous = this.pending.get(toolCallId);
        if (previous) {
            previous.reject(new Error('Superseded by a new UI interaction wait'));
        }
        const deferred = new Deferred<ToolCallResult>();
        this.pending.set(toolCallId, deferred);
        let cancellation: Disposable | undefined;
        if (cancellationToken) {
            cancellation = cancellationToken.onCancellationRequested(() => {
                this.reject(toolCallId, new CancelledError());
            });
        }
        try {
            return await deferred.promise;
        } finally {
            cancellation?.dispose();
            if (this.pending.get(toolCallId) === deferred) {
                this.pending.delete(toolCallId);
            }
        }
    }

    async awaitLiveInteraction(uiId: string, toolCallId: string, cancellationToken?: CancellationToken): Promise<ToolCallResult> {
        const session = this.ensureLiveSession(uiId);
        if (cancellationToken?.isCancellationRequested) {
            throw new CancelledError();
        }
        if (session.finished) {
            return { uiId, status: 'finished' };
        }
        if (session.currentToolCallId && session.currentToolCallId !== toolCallId) {
            this.reject(session.currentToolCallId, new Error('Superseded by a new UI interaction wait'));
        }
        session.currentToolCallId = toolCallId;
        try {
            return await this.awaitInteraction(toolCallId, cancellationToken);
        } finally {
            if (session.currentToolCallId === toolCallId) {
                session.currentToolCallId = undefined;
            }
        }
    }

    resolve(toolCallId: string, data: ToolCallResult): boolean {
        const deferred = this.pending.get(toolCallId);
        if (!deferred) {
            this.earlyResolved.set(toolCallId, data);
            return true;
        }
        this.pending.delete(toolCallId);
        deferred.resolve(data);
        return true;
    }

    reject(toolCallId: string, reason?: unknown): boolean {
        const deferred = this.pending.get(toolCallId);
        if (!deferred) {
            return false;
        }
        this.pending.delete(toolCallId);
        deferred.reject(reason);
        return true;
    }

    rejectAll(reason?: unknown): void {
        const entries = [...this.pending.entries()];
        this.pending.clear();
        this.earlyResolved.clear();
        this.liveSessions.clear();
        for (const [, deferred] of entries) {
            deferred.reject(reason);
        }
    }

    clearLiveSessions(): void {
        this.liveSessions.clear();
    }

    hasPending(toolCallId: string): boolean {
        return this.pending.has(toolCallId);
    }

    resolveLiveAction(uiId: string, action: string, data: Record<string, unknown>): boolean {
        const session = this.liveSessions.get(uiId);
        if (!session || session.finished || !session.currentToolCallId) {
            return false;
        }
        session.actionCount += 1;
        if (session.actionCount > MAX_UI_INTERACTIONS) {
            session.finished = true;
            const result = { uiId, error: 'interaction limit reached', status: 'finished' };
            this.onDidApplyPatchEmitter.fire({ uiId, patch: { status: 'finished' } });
            return this.resolve(session.currentToolCallId, result);
        }
        return this.resolve(session.currentToolCallId, { uiId, action, data });
    }

    applyUiPatch(uiId: string, patch: Record<string, unknown>): { status?: string; error?: string } {
        const session = this.liveSessions.get(uiId);
        if (!session) {
            return { error: 'ui not found', status: 'finished' };
        }
        if (session.finished) {
            return { status: 'finished' };
        }
        this.onDidApplyPatchEmitter.fire({ uiId, patch });
        if (patch.status === 'finished') {
            session.finished = true;
            return { status: 'finished' };
        }
        return {};
    }

    isLiveFinished(uiId: string): boolean {
        return !!this.liveSessions.get(uiId)?.finished;
    }

    hasLiveSession(uiId: string): boolean {
        return this.liveSessions.has(uiId);
    }

    protected ensureLiveSession(uiId: string): LiveUiSession {
        let session = this.liveSessions.get(uiId);
        if (!session) {
            session = { uiId, actionCount: 0, finished: false };
            this.liveSessions.set(uiId, session);
        }
        return session;
    }
}
