// *****************************************************************************
// ArsChat legacy MCP config importer - pure conversion logic (PHASE1_DESIGN.md
// §7, M5 e-6).
//
// Converts the *current* (Electron) ArsChat `mcp-config.json` shape into the
// value Theia 1.71.2's `@theia/ai-mcp` reads from the `ai-features.mcp.mcpServers`
// preference. This module is deliberately Theia-free (no inversify, no
// FileService) so it can be unit-tested with fixed fixtures under jest.
//
// ---- Source shape (current ArsChat, src/shared/types.ts) --------------------
//   MCPConfig       = { servers: MCPServerConfig[] }
//   MCPServerConfig = {
//     name: string; description?: string;
//     type: 'stdio' | 'http' | 'streamable-http';
//     command?: string; args?: string[]; env?: Record<string,string>;
//     url?: string; headers?: Record<string,string>;
//     enabled: boolean;
//   }
//   - An *array* keyed by `name`, with a `type` discriminator and a hybrid of
//     stdio (command/args/env) and http (url/headers) fields.
//
// ---- Target shape (@theia/ai-mcp preference value) --------------------------
//   Verified against node_modules/@theia/ai-mcp/src/common/mcp-preferences.ts
//   and src/browser/mcp-frontend-application-contribution.ts (the code that
//   actually reads the preference into MCPServerDescription):
//
//     { [name: string]: LocalValue | RemoteValue }
//     LocalValue  = { command: string; args?: string[]; env?: Record<string,string>; autostart?: boolean }
//     RemoteValue = { serverUrl: string; serverAuthToken?: string; serverAuthTokenHeader?: string; headers?: Record<string,string>; autostart?: boolean }
//
//   Key facts pinned from the real @theia/ai-mcp source:
//   - There is NO `type` discriminator and NO stdio/http/streamable-http split.
//     A server is "local" iff it has `command`, "remote" iff it has `serverUrl`
//     (isLocalMCPServerDescription / isRemoteMCPServerDescription). The remote
//     transport (mcp-server.ts) always tries StreamableHTTP first and falls
//     back to SSE, so BOTH legacy `http` and `streamable-http` map cleanly onto
//     one `serverUrl` remote entry - no information is lost by the type merge.
//   - `enabled` has no direct counterpart; the closest concept is `autostart`
//     (default true, "only takes effect after a restart"). We map
//     enabled:false -> autostart:false so a disabled server is imported but not
//     auto-started. enabled:true (or omitted) -> autostart omitted (= default
//     true).
//   - `description` is NOT part of the preference schema and is dropped (with a
//     note in the report, not a hard skip).
//   - `env` / `headers`: string->string maps, carried through verbatim. Empty
//     maps ({}) are dropped so we don't write noise into the preference.
// *****************************************************************************

/** A single server entry in the current ArsChat mcp-config.json. */
export interface LegacyMCPServerConfig {
    name: string;
    description?: string;
    type: 'stdio' | 'http' | 'streamable-http' | string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    enabled?: boolean;
}

/** The current ArsChat mcp-config.json top-level shape. */
export interface LegacyMCPConfig {
    servers: LegacyMCPServerConfig[];
}

/** A local (stdio-spawned) server value in the Theia preference. */
export interface TheiaLocalMCPServerValue {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    autostart?: boolean;
}

/** A remote (http / streamable-http) server value in the Theia preference. */
export interface TheiaRemoteMCPServerValue {
    serverUrl: string;
    serverAuthToken?: string;
    serverAuthTokenHeader?: string;
    headers?: Record<string, string>;
    autostart?: boolean;
}

export type TheiaMCPServerValue = TheiaLocalMCPServerValue | TheiaRemoteMCPServerValue;

/** The `ai-features.mcp.mcpServers` preference value: server name -> config. */
export interface TheiaMCPServersPreference {
    [name: string]: TheiaMCPServerValue;
}

/** One server that could not be converted, with a human-readable reason. */
export interface MCPImportWarning {
    /** The legacy server name (or a placeholder when it was missing). */
    name: string;
    /** Why the server was skipped or partially degraded. */
    reason: string;
}

/** Outcome of converting a legacy config: the preference value + diagnostics. */
export interface MCPImportResult {
    /** The value to write into `ai-features.mcp.mcpServers` (converted servers only). */
    servers: TheiaMCPServersPreference;
    /** Servers that were skipped entirely, with reasons. */
    warnings: MCPImportWarning[];
    /** Non-fatal notes (e.g. dropped `description`, duplicate names) — imported anyway. */
    notes: MCPImportWarning[];
    /** Count of servers successfully written into `servers`. */
    importedCount: number;
}

function nonEmptyMap(map: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!map || typeof map !== 'object') {
        return undefined;
    }
    const entries = Object.entries(map).filter(([k, v]) => typeof k === 'string' && typeof v === 'string');
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function nonEmptyStringArray(arr: unknown): string[] | undefined {
    if (!Array.isArray(arr)) {
        return undefined;
    }
    const strings = arr.filter((a): a is string => typeof a === 'string');
    return strings.length > 0 ? strings : undefined;
}

/**
 * Decide whether a legacy server should be treated as local (stdio) or remote
 * (http/streamable-http). We trust the *fields* over the `type` string, since
 * the Theia side is structural too, but we cross-check `type` for the warning
 * text. Returns 'local' | 'remote' | undefined (undefined => cannot convert).
 */
function classify(server: LegacyMCPServerConfig): 'local' | 'remote' | undefined {
    const hasCommand = typeof server.command === 'string' && server.command.trim().length > 0;
    const hasUrl = typeof server.url === 'string' && server.url.trim().length > 0;
    const type = (server.type ?? '').toLowerCase();

    // Field-driven first (matches how @theia/ai-mcp itself decides).
    if (type === 'stdio') {
        return hasCommand ? 'local' : undefined;
    }
    if (type === 'http' || type === 'streamable-http' || type === 'sse') {
        return hasUrl ? 'remote' : undefined;
    }
    // Unknown/missing type: fall back to whichever field set is present.
    if (hasCommand) {
        return 'local';
    }
    if (hasUrl) {
        return 'remote';
    }
    return undefined;
}

/**
 * Convert a current ArsChat MCPConfig into the Theia `ai-features.mcp.mcpServers`
 * preference value, collecting per-server warnings (skipped) and notes
 * (imported with caveats). Pure and deterministic.
 */
export function convertLegacyMCPConfig(config: unknown): MCPImportResult {
    const result: MCPImportResult = { servers: {}, warnings: [], notes: [], importedCount: 0 };

    const servers = (config as LegacyMCPConfig | undefined)?.servers;
    if (!Array.isArray(servers)) {
        result.warnings.push({
            name: '<config>',
            reason: 'ルート形式が不正です（`servers` 配列が見つかりません）。旧 ArsChat の mcp-config.json ではありません。'
        });
        return result;
    }

    for (let i = 0; i < servers.length; i++) {
        const server = servers[i] as LegacyMCPServerConfig;
        const name = typeof server?.name === 'string' ? server.name.trim() : '';

        if (!name) {
            result.warnings.push({
                name: `<#${i + 1}>`,
                reason: '`name` が空または未指定のためスキップしました（Theia 側はサーバー名をキーにするため必須）。'
            });
            continue;
        }

        const kind = classify(server);
        if (!kind) {
            const typeLabel = server?.type ? `type="${server.type}"` : 'type 未指定';
            result.warnings.push({
                name,
                reason: `変換不能: ${typeLabel} だが command も url も無い（stdio には command、http/streamable-http には url が必要）。`
            });
            continue;
        }

        // Duplicate name: Theia's preference is a name-keyed object, so a later
        // duplicate would clobber the earlier one. Keep the first, note the drop.
        if (Object.prototype.hasOwnProperty.call(result.servers, name)) {
            result.warnings.push({
                name,
                reason: '同名サーバーが既に取り込まれているためスキップしました（Theia 設定はサーバー名で一意）。最初の定義を採用。'
            });
            continue;
        }

        let value: TheiaMCPServerValue;
        if (kind === 'local') {
            const local: TheiaLocalMCPServerValue = { command: (server.command as string).trim() };
            const args = nonEmptyStringArray(server.args);
            if (args) {
                local.args = args;
            }
            const env = nonEmptyMap(server.env);
            if (env) {
                local.env = env;
            }
            value = local;
        } else {
            const remote: TheiaRemoteMCPServerValue = { serverUrl: (server.url as string).trim() };
            const headers = nonEmptyMap(server.headers);
            if (headers) {
                remote.headers = headers;
            }
            value = remote;
        }

        // enabled:false -> autostart:false (imported but not auto-started).
        // enabled:true / omitted -> leave autostart unset (Theia default = true).
        if (server.enabled === false) {
            value.autostart = false;
            result.notes.push({
                name,
                reason: 'enabled:false のため autostart:false で取り込みました（起動は手動: 「MCP: Start MCP Server」）。'
            });
        }

        // description is not part of the Theia preference schema; note the drop.
        if (typeof server.description === 'string' && server.description.trim().length > 0) {
            result.notes.push({
                name,
                reason: 'description は Theia の MCP 設定スキーマに無いため取り込み時に破棄しました（機能への影響なし）。'
            });
        }

        result.servers[name] = value;
        result.importedCount++;
    }

    return result;
}

/**
 * Merge a freshly converted preference value onto an existing one. Existing
 * entries win on name collision (import is additive and non-destructive); the
 * collisions are reported so the caller can surface them. Returns the merged
 * value plus the list of names that were skipped because they already existed.
 */
export function mergeIntoExisting(
    existing: TheiaMCPServersPreference | undefined,
    incoming: TheiaMCPServersPreference
): { merged: TheiaMCPServersPreference; skippedExisting: string[] } {
    const base: TheiaMCPServersPreference = existing && typeof existing === 'object' ? { ...existing } : {};
    const skippedExisting: string[] = [];
    for (const [name, value] of Object.entries(incoming)) {
        if (Object.prototype.hasOwnProperty.call(base, name)) {
            skippedExisting.push(name);
            continue;
        }
        base[name] = value;
    }
    return { merged: base, skippedExisting };
}
