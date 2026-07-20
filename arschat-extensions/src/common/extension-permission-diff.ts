import { ExtensionPermissionId } from './extension-manifest';

export function calculateNewPermissions(
    requestedPermissions: readonly ExtensionPermissionId[],
    grantedPermissions: readonly ExtensionPermissionId[]
): ExtensionPermissionId[] {
    const granted = new Set(grantedPermissions);
    return uniquePermissions(requestedPermissions).filter(permission => !granted.has(permission));
}

export function mergeGrantedPermissionsForManifest(
    requestedPermissions: readonly ExtensionPermissionId[],
    grantedPermissions: readonly ExtensionPermissionId[],
    approvedNewPermissions: readonly ExtensionPermissionId[] = []
): ExtensionPermissionId[] {
    const allowed = new Set([...grantedPermissions, ...approvedNewPermissions]);
    return uniquePermissions(requestedPermissions).filter(permission => allowed.has(permission));
}

function uniquePermissions(permissions: readonly ExtensionPermissionId[]): ExtensionPermissionId[] {
    const seen = new Set<ExtensionPermissionId>();
    const result: ExtensionPermissionId[] = [];
    for (const permission of permissions) {
        if (!seen.has(permission)) {
            seen.add(permission);
            result.push(permission);
        }
    }
    return result;
}
