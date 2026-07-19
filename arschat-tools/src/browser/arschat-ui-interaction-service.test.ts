import { CancellationTokenSource } from '@theia/core/lib/common/cancellation';
import { ArschatUiInteractionService } from './arschat-ui-interaction-service';

describe('ArschatUiInteractionService', () => {
    it('resolves submitted data for a pending tool call', async () => {
        const service = new ArschatUiInteractionService();
        const pending = service.awaitInteraction('tc-1');
        expect(service.hasPending('tc-1')).toBe(true);
        expect(service.resolve('tc-1', { action: 'submit', data: { ok: true } })).toBe(true);
        await expect(pending).resolves.toEqual({ action: 'submit', data: { ok: true } });
        expect(service.hasPending('tc-1')).toBe(false);
    });

    it('buffers a resolve that arrives before awaitInteraction starts', async () => {
        const service = new ArschatUiInteractionService();
        expect(service.resolve('tc-early', { action: 'submit', data: { ok: true } })).toBe(true);
        await expect(service.awaitInteraction('tc-early')).resolves.toEqual({ action: 'submit', data: { ok: true } });
        expect(service.hasPending('tc-early')).toBe(false);
    });

    it('rejectAll rejects every pending interaction', async () => {
        const service = new ArschatUiInteractionService();
        const first = service.awaitInteraction('tc-1');
        const second = service.awaitInteraction('tc-2');
        service.rejectAll(new Error('aborted'));
        await expect(first).rejects.toThrow('aborted');
        await expect(second).rejects.toThrow('aborted');
        expect(service.hasPending('tc-1')).toBe(false);
        expect(service.hasPending('tc-2')).toBe(false);
    });

    it('rejects when the cancellation token fires', async () => {
        const service = new ArschatUiInteractionService();
        const source = new CancellationTokenSource();
        const pending = service.awaitInteraction('tc-1', source.token);
        source.cancel();
        await expect(pending).rejects.toThrow('Chat request canceled');
        expect(service.hasPending('tc-1')).toBe(false);
    });

    it('returns live UI actions by ui id through the current tool call wait', async () => {
        const service = new ArschatUiInteractionService();
        const pending = service.awaitLiveInteraction('live-1', 'tc-live');
        expect(service.hasPending('tc-live')).toBe(true);
        expect(service.resolveLiveAction('live-1', 'increment', { amount: 1 })).toBe(true);
        await expect(pending).resolves.toEqual({ uiId: 'live-1', action: 'increment', data: { amount: 1 } });
        expect(service.hasPending('tc-live')).toBe(false);
    });

    it('supersedes an older pending live wait for the same ui id', async () => {
        const service = new ArschatUiInteractionService();
        const first = service.awaitLiveInteraction('live-1', 'tc-first');
        const second = service.awaitLiveInteraction('live-1', 'tc-second');

        await expect(first).rejects.toThrow('Superseded by a new UI interaction wait');
        expect(service.hasPending('tc-first')).toBe(false);
        expect(service.hasPending('tc-second')).toBe(true);
        expect(service.resolveLiveAction('live-1', 'next', { ok: true })).toBe(true);
        await expect(second).resolves.toEqual({ uiId: 'live-1', action: 'next', data: { ok: true } });
    });

    it('applies patches and marks a live UI finished when status is finished', () => {
        const service = new ArschatUiInteractionService();
        const patches: unknown[] = [];
        service.onDidApplyPatch(event => patches.push(event));
        service.awaitLiveInteraction('live-1', 'tc-live').catch(() => undefined);

        expect(service.applyUiPatch('live-1', { score: 1 })).toEqual({});
        expect(service.applyUiPatch('live-1', { status: 'finished' })).toEqual({ status: 'finished' });
        expect(service.isLiveFinished('live-1')).toBe(true);
        expect(patches).toEqual([
            { uiId: 'live-1', patch: { score: 1 } },
            { uiId: 'live-1', patch: { status: 'finished' } }
        ]);
        service.rejectAll(new Error('done'));
    });

    it('clears live session state without requiring pending waits', async () => {
        const service = new ArschatUiInteractionService();
        const pending = service.awaitLiveInteraction('live-1', 'tc-live');
        service.resolveLiveAction('live-1', 'submit', {});
        await pending;
        expect(service.hasLiveSession('live-1')).toBe(true);

        service.clearLiveSessions();
        expect(service.hasLiveSession('live-1')).toBe(false);
        expect(service.applyUiPatch('live-1', { status: 'finished' })).toEqual({ error: 'ui not found', status: 'finished' });
    });

    it('finishes a UI with an error after more than 50 user interactions', async () => {
        const service = new ArschatUiInteractionService();
        for (let i = 0; i < 50; i++) {
            const pending = service.awaitLiveInteraction('live-1', `tc-${i}`);
            expect(service.resolveLiveAction('live-1', 'next', { i })).toBe(true);
            await expect(pending).resolves.toEqual({ uiId: 'live-1', action: 'next', data: { i } });
        }

        const overLimit = service.awaitLiveInteraction('live-1', 'tc-over');
        expect(service.resolveLiveAction('live-1', 'next', { i: 50 })).toBe(true);
        await expect(overLimit).resolves.toEqual({
            uiId: 'live-1',
            error: 'interaction limit reached',
            status: 'finished'
        });
        expect(service.isLiveFinished('live-1')).toBe(true);
        expect(service.resolveLiveAction('live-1', 'ignored', {})).toBe(false);
    });
});
