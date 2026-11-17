import { inject, injectable } from '@theia/core/shared/inversify';
import { McpFrontendApplicationContribution } from '@theia/ai-mcp/lib/browser/mcp-frontend-application-contribution';
import { MCPServerDescription } from '@theia/ai-mcp/lib/common/mcp-server-manager';
import { ArschatMemoryEnvironment } from './memory-environment';
import { MCP_SERVERS_PREF, MemoryServers } from './memory-preferences';
import { ArschatMemoryServerContribution } from './memory-server-contribution';

// Theia 1.71.2's filterValidValues/isValue helpers are not exported. Keep these
// checks equivalent so our early synchronization accepts the same preferences.
function isValidServer(obj: unknown): obj is MemoryServers[string] {
    return !!obj && typeof obj === 'object' &&
        ('command' in obj || 'serverUrl' in obj) &&
        (!('command' in obj) || typeof obj.command === 'string') &&
        (!('args' in obj) || Array.isArray(obj.args) && obj.args.every(arg => typeof arg === 'string')) &&
        (!('env' in obj) || !!obj.env && typeof obj.env === 'object' && Object.values(obj.env).every(value => typeof value === 'string')) &&
        (!('autostart' in obj) || typeof obj.autostart === 'boolean') &&
        (!('serverUrl' in obj) || typeof obj.serverUrl === 'string') &&
        (!('serverAuthToken' in obj) || typeof obj.serverAuthToken === 'string') &&
        (!('serverAuthTokenHeader' in obj) || typeof obj.serverAuthTokenHeader === 'string') &&
        (!('headers' in obj) || !!obj.headers && typeof obj.headers === 'object' && Object.values(obj.headers).every(value => typeof value === 'string'));
}

function filterValidValues(servers: unknown): MemoryServers {
    const result: MemoryServers = {};
    if (!servers || typeof servers !== 'object') { return result; }
    for (const [name, value] of Object.entries(servers)) {
        if (isValidServer(value)) { result[name] = value; }
    }
    return result;
}

/** Filter before Theia syncs/autostarts settings, including subsequent preference changes.
 * User preferences stay intact; M16 registers its isolated definition directly.
 */
@injectable()
export class ArschatMemoryMcpContribution extends McpFrontendApplicationContribution {
    @inject(ArschatMemoryEnvironment) protected readonly environment!: ArschatMemoryEnvironment;
    @inject(ArschatMemoryServerContribution) protected readonly memoryServer!: ArschatMemoryServerContribution;

    override onStart(): void {
        void this.start();
    }

    private async start(): Promise<void> {
        try {
            await this.environment.ready();
            // The parent's initial snapshot must include the generated entry.
            await this.memoryServer.preparePreferences();
        } catch {
            // Environment failure blocks memory only. Preserve all other MCP lifecycle hooks.
            console.warn('[arschat-memory] MCP memory initialization unavailable');
        } finally {
            super.onStart();
        }
    }

    protected override syncServers(servers: Map<string, MCPServerDescription>): void {
        super.syncServers(servers);
        // Theia installs its preference listener after autostart completes. During that
        // gap, route our writes through the same diff handler, including prevServers.
        this.memoryServer.synchronizeServers = () => this.handleServerChanges(
            filterValidValues(this.preferenceService.get(MCP_SERVERS_PREF, {}))
        );
        this.memoryServer.onStart();
    }

    onStop(): void { this.memoryServer.onStop(); }

    protected override convertToMap(servers: MemoryServers): Map<string, MCPServerDescription> {
        const entries = super.convertToMap(servers);
        if (this.environment.autoSaveBlocked) {
            for (const [name, description] of entries) {
                // Also exclude aliases and wrapper commands containing sqgraph, and any
                // user-supplied definition under the dedicated test name.
                const command = 'command' in description ? `${description.command} ${(description.args ?? []).join(' ')}` : '';
                if (/sqgraph/i.test(`${name} ${command}`)) { entries.delete(name); }
            }
        }
        return entries;
    }
}
