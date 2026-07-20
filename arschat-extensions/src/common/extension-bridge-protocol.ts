import { ExtensionPermissionId } from './extension-manifest';

export const EXTENSION_REQUEST_TYPE = 'arschat-ext-request';
export const EXTENSION_RESPONSE_TYPE = 'arschat-ext-response';

export type ExtensionMethod =
    | 'chat.read'
    | 'chat.send'
    | 'storage.get'
    | 'storage.set'
    | 'notification.show';

export const METHOD_PERMISSION_MAP: Record<ExtensionMethod, ExtensionPermissionId> = {
    'chat.read': 'chat:read',
    'chat.send': 'chat:send',
    'storage.get': 'storage:read',
    'storage.set': 'storage:write',
    'notification.show': 'notification'
};

export type ExtensionBridgeErrorCode = 'PERMISSION_DENIED' | 'UNKNOWN_METHOD' | 'INTERNAL';

export interface ExtensionBridgeError {
    readonly code: ExtensionBridgeErrorCode;
    readonly message: string;
}

export interface ExtensionRequestMessage {
    readonly type: typeof EXTENSION_REQUEST_TYPE;
    readonly extId: string;
    readonly requestId: string;
    readonly method: string;
    readonly params?: unknown;
}

export interface ExtensionResponseMessage {
    readonly type: typeof EXTENSION_RESPONSE_TYPE;
    readonly extId: string;
    readonly requestId: string;
    readonly ok: boolean;
    readonly result?: unknown;
    readonly error?: ExtensionBridgeError;
}

export interface ExtensionPermissionGateAllowed {
    readonly ok: true;
    readonly method: ExtensionMethod;
    readonly permission: ExtensionPermissionId;
}

export interface ExtensionPermissionGateDenied {
    readonly ok: false;
    readonly error: ExtensionBridgeError;
}

export type ExtensionPermissionGateResult = ExtensionPermissionGateAllowed | ExtensionPermissionGateDenied;

export function isExtensionRequestMessage(input: unknown): input is ExtensionRequestMessage {
    if (!input || typeof input !== 'object') {
        return false;
    }
    const msg = input as Partial<ExtensionRequestMessage>;
    return msg.type === EXTENSION_REQUEST_TYPE
        && typeof msg.extId === 'string'
        && typeof msg.requestId === 'string'
        && typeof msg.method === 'string';
}

export function checkExtensionMethodPermission(method: string, grantedPermissions: readonly string[]): ExtensionPermissionGateResult {
    if (!isExtensionMethod(method)) {
        return {
            ok: false,
            error: {
                code: 'UNKNOWN_METHOD',
                message: `Unknown extension method: ${method}`
            }
        };
    }
    const permission = METHOD_PERMISSION_MAP[method];
    if (!grantedPermissions.includes(permission)) {
        return {
            ok: false,
            error: {
                code: 'PERMISSION_DENIED',
                message: `Permission '${permission}' is required for '${method}'`
            }
        };
    }
    return { ok: true, method, permission };
}

export function createExtensionResponse(
    extId: string,
    requestId: string,
    result: unknown
): ExtensionResponseMessage {
    return { type: EXTENSION_RESPONSE_TYPE, extId, requestId, ok: true, result };
}

export function createExtensionErrorResponse(
    extId: string,
    requestId: string,
    error: ExtensionBridgeError
): ExtensionResponseMessage {
    return { type: EXTENSION_RESPONSE_TYPE, extId, requestId, ok: false, error };
}

function isExtensionMethod(method: string): method is ExtensionMethod {
    return Object.prototype.hasOwnProperty.call(METHOD_PERMISSION_MAP, method);
}
