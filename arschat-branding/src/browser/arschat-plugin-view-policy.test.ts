import { createPluginViewContainerGuard, isPluginViewContainerAllowed } from './arschat-plugin-view-policy';

describe('plugin view container policy', () => {
    it.each(['explorer', 'search'])('allows %s', id => {
        expect(isPluginViewContainerAllowed(id)).toBe(true);
    });

    it.each(['scm', 'debug', 'test', 'gitlens', 'workbench.view.extension.gitlens', 'unknown-extension', '', 'Explorer', 'search-extra'])
    ('denies %s by default', id => {
        expect(isPluginViewContainerAllowed(id)).toBe(false);
    });

    it('suppresses repeated log messages per id while continuing to reject every attempt', () => {
        const log = jest.fn();
        const canOpen = createPluginViewContainerGuard(log);
        for (const id of ['scm', 'gitlens', 'scm', 'gitlens']) {
            expect(canOpen(id)).toBe(false);
        }
        expect(log.mock.calls).toEqual([
            ['[arschat-dilution] plugin view container suppressed: scm'],
            ['[arschat-dilution] plugin view container suppressed: gitlens']
        ]);
    });

    it('does not log allowed containers', () => {
        const log = jest.fn();
        const canOpen = createPluginViewContainerGuard(log);
        for (const id of ['explorer', 'search', 'explorer', 'search']) {
            expect(canOpen(id)).toBe(true);
        }
        expect(log).not.toHaveBeenCalled();
    });

    it('keeps logging state local to each registry', () => {
        const log = jest.fn();
        createPluginViewContainerGuard(log)('scm');
        createPluginViewContainerGuard(log)('scm');
        expect(log).toHaveBeenCalledTimes(2);
    });
});
