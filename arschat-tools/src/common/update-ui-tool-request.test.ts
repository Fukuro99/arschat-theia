import { ToolInvocationContext } from '@theia/ai-core/lib/common/language-model';
import { CancellationTokenSource } from '@theia/core/lib/common/cancellation';
import { ArschatUiInteractionService } from '../browser/arschat-ui-interaction-service';
import { createUpdateUiTool, validateUpdateUiArgs } from './update-ui-tool-request';
import { UPDATE_UI_TOOL_ID } from './tool-ids';

describe('arschat_update_ui tool request', () => {
    it('defines an always-allowed patch tool schema', () => {
        const tool = createUpdateUiTool({
            applyUiPatch: () => ({}),
            awaitLiveInteraction: async () => ({})
        });
        expect(tool.id).toBe(UPDATE_UI_TOOL_ID);
        expect(tool.parameters.required).toEqual(['ui_id', 'patch']);
        expect(tool.checkAutoAction?.('{}')).toEqual({ action: 'allow' });
    });

    it('validates ui_id and patch', () => {
        expect(validateUpdateUiArgs({ ui_id: 'live-1', patch: { score: 2 } })).toEqual({
            ok: true,
            uiId: 'live-1',
            patch: { score: 2 }
        });
        expect(validateUpdateUiArgs({ id: 'legacy-id', patch: {} })).toEqual({
            ok: true,
            uiId: 'legacy-id',
            patch: {}
        });
        expect(validateUpdateUiArgs({ ui_id: 'x', patch: [] as any })).toEqual({
            ok: false,
            error: 'arschat_update_ui requires an object "patch".'
        });
    });

    it('applies a patch and waits for the next action', async () => {
        const service = new ArschatUiInteractionService();
        const patches: unknown[] = [];
        service.onDidApplyPatch(event => patches.push(event));
        const first = service.awaitLiveInteraction('live-1', 'tc-render');
        service.resolveLiveAction('live-1', 'start', {});
        await first;

        const tool = createUpdateUiTool(service);
        const pending = tool.handler(
            JSON.stringify({ ui_id: 'live-1', patch: { score: 1 } }),
            ToolInvocationContext.create('tc-update')
        );
        expect(service.hasPending('tc-update')).toBe(true);
        expect(patches).toContainEqual({ uiId: 'live-1', patch: { score: 1 } });
        service.resolveLiveAction('live-1', 'next', { value: 2 });
        await expect(pending).resolves.toEqual({ uiId: 'live-1', action: 'next', data: { value: 2 } });
    });

    it('returns cancelled when the next-action wait rejects with the chat cancellation reason', async () => {
        const tool = createUpdateUiTool({
            applyUiPatch: () => ({}),
            awaitLiveInteraction: async () => {
                throw new Error('Chat request canceled');
            }
        });

        await expect(tool.handler(
            JSON.stringify({ ui_id: 'live-1', patch: { score: 1 } }),
            ToolInvocationContext.create('tc-update-cancel')
        )).resolves.toEqual({ cancelled: true });
    });

    it('returns immediately when the patch finishes the UI', async () => {
        const service = new ArschatUiInteractionService();
        service.awaitLiveInteraction('live-1', 'tc-render').catch(() => undefined);
        const tool = createUpdateUiTool(service);

        await expect(tool.handler(
            JSON.stringify({ ui_id: 'live-1', patch: { status: 'finished' } }),
            ToolInvocationContext.create('tc-update')
        )).resolves.toEqual({ uiId: 'live-1', status: 'finished' });
        expect(service.isLiveFinished('live-1')).toBe(true);
        service.rejectAll(new Error('done'));
    });

    it('returns cancelled for pre-cancelled live update waits', async () => {
        const service = new ArschatUiInteractionService();
        const first = service.awaitLiveInteraction('live-1', 'tc-render');
        service.resolveLiveAction('live-1', 'start', {});
        await first;
        const tool = createUpdateUiTool(service);
        const source = new CancellationTokenSource();
        source.cancel();

        await expect(tool.handler(
            JSON.stringify({ ui_id: 'live-1', patch: { score: 1 } }),
            ToolInvocationContext.create('tc-update-cancel', source.token)
        )).resolves.toEqual({ cancelled: true });
    });
});
