import { checkExtensionMethodPermission } from './extension-bridge-protocol';

describe('checkExtensionMethodPermission', () => {
    it('allows a method when the exact permission is granted', () => {
        expect(checkExtensionMethodPermission('storage.get', ['storage:read'])).toEqual({
            ok: true,
            method: 'storage.get',
            permission: 'storage:read'
        });
    });

    it('denies a known method when the permission was declared but not granted', () => {
        const result = checkExtensionMethodPermission('storage.set', ['storage:read']);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe('PERMISSION_DENIED');
        }
    });

    it('reports unknown methods before permission checks', () => {
        const result = checkExtensionMethodPermission('storage.delete', ['storage:read', 'storage:write']);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe('UNKNOWN_METHOD');
        }
    });

    it('does not grant grouped chat access across separate permissions', () => {
        const result = checkExtensionMethodPermission('chat.send', ['chat:read']);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe('PERMISSION_DENIED');
            expect(result.error.message).toContain('chat:send');
        }
    });
});
