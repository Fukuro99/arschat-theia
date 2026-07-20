import { validateManifest, ExtensionManifestValidationError, isValidExtensionName } from './extension-manifest';

describe('validateManifest', () => {
    it('accepts a valid manifest and deduplicates permissions', () => {
        const manifest = validateManifest({
            name: 'arschat-ext-hello',
            displayName: 'Hello Sample',
            version: '0.1.0',
            description: 'sample',
            permissions: ['chat:send', 'storage:read', 'storage:read'],
            entry: 'main.html'
        });

        expect(manifest.name).toBe('arschat-ext-hello');
        expect(manifest.permissions).toEqual(['chat:send', 'storage:read']);
    });

    it('rejects missing required fields', () => {
        expect(() => validateManifest({ permissions: [], entry: 'main.html' }))
            .toThrow(ExtensionManifestValidationError);
    });

    it('rejects invalid names', () => {
        expect(() => validateManifest({
            name: 'Bad_Name',
            displayName: 'Bad',
            version: '0.1.0',
            permissions: [],
            entry: 'main.html'
        })).toThrow(/name must match/);
    });

    it('exposes the same name pattern for registry restore filtering', () => {
        expect(isValidExtensionName('arschat-ext-hello')).toBe(true);
        expect(isValidExtensionName('Bad_Name')).toBe(false);
        expect(isValidExtensionName('../escape')).toBe(false);
    });

    it('rejects unknown permissions', () => {
        expect(() => validateManifest({
            name: 'ok',
            displayName: 'Ok',
            version: '0.1.0',
            permissions: ['storage:read', 'network:any'],
            entry: 'main.html'
        })).toThrow(/unknown permission: network:any/);
    });

    it('rejects entry traversal', () => {
        expect(() => validateManifest({
            name: 'ok',
            displayName: 'Ok',
            version: '0.1.0',
            permissions: [],
            entry: '../main.html'
        })).toThrow(/without \.\./);
    });
});
