import { calculateNewPermissions, mergeGrantedPermissionsForManifest } from './extension-permission-diff';
import { ExtensionPermissionId } from './extension-manifest';

describe('extension permission diffs', () => {
    it('returns only permissions that are not already granted', () => {
        const requested: ExtensionPermissionId[] = ['storage:read', 'chat:send', 'storage:read', 'notification'];
        const granted: ExtensionPermissionId[] = ['storage:read'];

        expect(calculateNewPermissions(requested, granted)).toEqual(['chat:send', 'notification']);
    });

    it('keeps granted permissions in manifest order and drops removed declarations', () => {
        const requested: ExtensionPermissionId[] = ['chat:send', 'notification'];
        const granted: ExtensionPermissionId[] = ['storage:read', 'chat:send'];

        expect(mergeGrantedPermissionsForManifest(requested, granted)).toEqual(['chat:send']);
    });

    it('adds approved incremental permissions without granting undeclared permissions', () => {
        const requested: ExtensionPermissionId[] = ['storage:read', 'storage:write'];
        const granted: ExtensionPermissionId[] = ['storage:read', 'chat:send'];

        expect(mergeGrantedPermissionsForManifest(requested, granted, ['storage:write'])).toEqual(['storage:read', 'storage:write']);
    });
});
