// Only the shell DI tokens are needed; avoid loading Theia's DOM/CSS in Node.
jest.mock('@theia/core/lib/browser', () => ({
    ApplicationShell: class {},
    WidgetManager: class {}
}));
jest.mock('@theia/scm/lib/browser/scm-contribution', () => ({
    SCM_VIEW_CONTAINER_ID: 'scm-view-container'
}));

import type { ApplicationShell } from '@theia/core/lib/browser';
import { ArschatStaleIdeViewCleanup, isStaleIdeViewId, selectStaleIdeViewIds } from './arschat-stale-ide-view-cleanup';

describe('stale plugin view cleanup', () => {
    const denied = [
        'plugin-view-container:gitlens', 'plugin-view-container:workbench.view.extension.gitlens',
        'plugin-view-container:unknown-extension', 'plugin-view-container:scm',
        'scm-view-container', 'debug-view-container', 'test-view-container', 'chat-view-widget'
    ];
    const retained = [
        'plugin-view-container:explorer', 'plugin-view-container:search',
        'explorer-view-container', 'search-in-workspace', 'outline-view', 'vsx-extensions-view-container',
        'arschat-chat', 'arschat-test', 'editor-webview'
    ];

    it.each(denied)('removes %s', id => {
        expect(isStaleIdeViewId(id)).toBe(true);
    });

    it.each(retained)('retains %s', id => {
        expect(isStaleIdeViewId(id)).toBe(false);
    });

    it('selects only diluted containers from a mixed restored layout', () => {
        expect(selectStaleIdeViewIds([...denied, ...retained])).toEqual(denied);
    });

    it('closes and disposes rejected widgets on both sides without touching allowed views or editors', () => {
        const widget = (id: string) => ({ id, close: jest.fn(), dispose: jest.fn() });
        const scm = widget('scm-view-container');
        const gitlens = widget('plugin-view-container:gitlens');
        const explorer = widget('plugin-view-container:explorer');
        const search = widget('plugin-view-container:search');
        const editor = widget('plugin-view-container:editor-webview');
        const getWidgets = jest.fn((area: string) => area === 'left' ? [scm, explorer]
            : area === 'right' ? [gitlens, search] : [editor]);
        class TestCleanup extends ArschatStaleIdeViewCleanup {
            protected override readonly shell = { getWidgets } as unknown as ApplicationShell;
        }
        const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            expect(new TestCleanup().removeStaleIdeViews()).toEqual([scm.id, gitlens.id]);
            for (const removed of [scm, gitlens]) {
                expect(removed.close).toHaveBeenCalledTimes(1);
                expect(removed.dispose).toHaveBeenCalledTimes(1);
            }
            for (const kept of [explorer, search, editor]) {
                expect(kept.close).not.toHaveBeenCalled();
                expect(kept.dispose).not.toHaveBeenCalled();
            }
            expect(getWidgets.mock.calls).toEqual([['left'], ['right']]);
        } finally {
            log.mockRestore();
        }
    });
});
