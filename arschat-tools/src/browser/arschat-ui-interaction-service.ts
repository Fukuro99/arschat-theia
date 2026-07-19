// *****************************************************************************
// Browser-side rendezvous point for MS13 interactive UI tool calls.
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
import { CancellationToken } from '@theia/core/lib/common/cancellation';
import { Disposable } from '@theia/core/lib/common/disposable';
import { Deferred } from '@theia/core/lib/common/promise-util';
import type { ToolCallResult } from '@theia/ai-core/lib/common/language-model';
import { RenderUiToolBackend } from '../common/render-ui-tool-request';

@injectable()
export class ArschatUiInteractionService implements RenderUiToolBackend {

    protected readonly pending = new Map<string, Deferred<ToolCallResult>>();
    protected readonly earlyResolved = new Map<string, ToolCallResult>();

    async awaitInteraction(toolCallId: string, cancellationToken?: CancellationToken): Promise<ToolCallResult> {
        if (cancellationToken?.isCancellationRequested) {
            throw new Error('Chat request canceled');
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
                this.reject(toolCallId, new Error('Chat request canceled'));
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
        for (const [, deferred] of entries) {
            deferred.reject(reason);
        }
    }

    hasPending(toolCallId: string): boolean {
        return this.pending.has(toolCallId);
    }
}
