export const PERMISSION_DEFINITIONS = [
    {
        id: 'chat:read',
        label: '現在のチャットの会話内容を読み取る'
    },
    {
        id: 'chat:send',
        label: 'あなたの代わりに AI へメッセージを送る'
    },
    {
        id: 'storage:read',
        label: 'この拡張専用の保存領域を読む'
    },
    {
        id: 'storage:write',
        label: 'この拡張専用の保存領域に書き込む'
    },
    {
        id: 'notification',
        label: '画面右下に通知を表示する'
    }
] as const;

export type ExtensionPermissionId = typeof PERMISSION_DEFINITIONS[number]['id'];

export const KNOWN_EXTENSION_PERMISSIONS: readonly string[] = PERMISSION_DEFINITIONS.map(def => def.id);

export interface ArschatExtensionManifest {
    readonly name: string;
    readonly displayName: string;
    readonly version: string;
    readonly description?: string;
    readonly permissions: ExtensionPermissionId[];
    readonly entry: string;
}

export class ExtensionManifestValidationError extends Error {
    readonly issues: readonly string[];

    constructor(issues: readonly string[]) {
        super(`Invalid ArsChat extension manifest: ${issues.join('; ')}`);
        this.name = 'ExtensionManifestValidationError';
        this.issues = issues;
    }
}

export const EXTENSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isKnownPermission(permission: string): permission is ExtensionPermissionId {
    return (KNOWN_EXTENSION_PERMISSIONS as readonly string[]).includes(permission);
}

export function permissionLabel(permission: ExtensionPermissionId): string {
    return PERMISSION_DEFINITIONS.find(def => def.id === permission)?.label ?? permission;
}

export function isValidExtensionName(name: string): boolean {
    return EXTENSION_NAME_PATTERN.test(name);
}

export function parseManifestText(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new ExtensionManifestValidationError([`manifest must be valid JSON (${message})`]);
    }
}

export function validateManifest(input: unknown): ArschatExtensionManifest {
    const issues: string[] = [];
    const obj = isRecord(input) ? input : undefined;
    if (!obj) {
        throw new ExtensionManifestValidationError(['manifest must be a JSON object']);
    }

    const name = readString(obj, 'name', issues, true);
    const displayName = readString(obj, 'displayName', issues, true);
    const version = readString(obj, 'version', issues, true);
    const entry = readString(obj, 'entry', issues, true);
    const description = readString(obj, 'description', issues, false);

    if (name && !isValidExtensionName(name)) {
        issues.push('name must match ^[a-z0-9][a-z0-9-]*$');
    }
    if (entry) {
        if (!entry.endsWith('.html')) {
            issues.push('entry must end with .html');
        }
        if (entry.includes('..') || entry.startsWith('/') || entry.startsWith('\\') || /^[a-zA-Z]:/.test(entry)) {
            issues.push('entry must be a relative .html path without ..');
        }
        if (entry.includes('\\')) {
            issues.push('entry must use forward slashes');
        }
    }

    const permissionsInput = obj.permissions;
    const permissions: ExtensionPermissionId[] = [];
    if (!Array.isArray(permissionsInput)) {
        issues.push('permissions must be an array');
    } else {
        const seen = new Set<string>();
        for (const permission of permissionsInput) {
            if (typeof permission !== 'string') {
                issues.push('permissions entries must be strings');
                continue;
            }
            if (!isKnownPermission(permission)) {
                issues.push(`unknown permission: ${permission}`);
                continue;
            }
            if (!seen.has(permission)) {
                seen.add(permission);
                permissions.push(permission);
            }
        }
    }

    if (issues.length > 0) {
        throw new ExtensionManifestValidationError(issues);
    }

    return {
        name: name!,
        displayName: displayName!,
        version: version!,
        description,
        permissions,
        entry: entry!
    };
}

function readString(obj: Record<string, unknown>, key: string, issues: string[], required: boolean): string | undefined {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
    }
    if (required || value !== undefined) {
        issues.push(`${key} must be a non-empty string`);
    }
    return undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === 'object' && input !== null && !Array.isArray(input);
}
