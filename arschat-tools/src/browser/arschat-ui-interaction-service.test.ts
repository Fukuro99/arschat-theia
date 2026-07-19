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
});
