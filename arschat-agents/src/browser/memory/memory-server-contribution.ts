import { inject, injectable } from '@theia/core/shared/inversify';
import { DisposableCollection, MessageService, PreferenceService, PreferenceScope } from '@theia/core';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { MCPFrontendNotificationService, MCPFrontendService, MCPServerStatus } from '@theia/ai-mcp/lib/common/mcp-server-manager';
import { WorkspaceTrustService } from '@theia/workspace/lib/browser/workspace-trust-service';
import { ArschatMemoryEnvironment } from './memory-environment';
import { ArschatMemoryService } from './memory-service';
import { addMemoryServer, MCP_SERVERS_PREF, MEMORY_SERVER, MemoryServers, memoryServerEntry } from './memory-preferences';
import { withTimeout } from './memory-utils';

@injectable()
export class ArschatMemoryServerContribution implements FrontendApplicationContribution {
    @inject(PreferenceService) protected readonly preferences!: PreferenceService;
    @inject(MCPFrontendService) protected readonly mcp!: MCPFrontendService;
    @inject(MCPFrontendNotificationService) protected readonly notifications!: MCPFrontendNotificationService;
    @inject(WorkspaceTrustService) protected readonly trust!: WorkspaceTrustService;
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(ArschatMemoryEnvironment) protected readonly environment!: ArschatMemoryEnvironment;
    @inject(ArschatMemoryService) protected readonly memory!: ArschatMemoryService;
    protected readonly disposables = new DisposableCollection();
    private queue = Promise.resolve();
    private notified = false;
    private stopped = false;
    private pendingUpdate = false;
    // Supplied by the re-bound MCP contribution after its initial snapshot is registered.
    synchronizeServers!: () => void;

    async preparePreferences(): Promise<void> {
        await this.preferences.ready;
        if (!this.preferences.get('arschat.memory.enabled', true) || this.environment.autoSaveBlocked) { return; }
        const servers = this.preferences.get<MemoryServers>(MCP_SERVERS_PREF, {});
        const next = addMemoryServer(servers, memoryServerEntry(
            this.preferences.get('arschat.memory.command', 'sqgraph-memory'),
            this.preferences.get('arschat.memory.agentName', 'arschat'),
            this.preferences.get('arschat.memory.group', '')
        ));
        if (next !== servers) { await this.preferences.set(MCP_SERVERS_PREF, next, PreferenceScope.User); }
    }

    onStart(): void {
        this.disposables.push(this.preferences.onPreferenceChanged(event => {
            if (['arschat.memory.command', 'arschat.memory.agentName', 'arschat.memory.group'].includes(event.preferenceName)) {
                this.schedule(true);
            } else if (event.preferenceName === 'arschat.memory.enabled') {
                this.schedule(false);
            }
        }));
        this.disposables.push(this.notifications.onDidUpdateMCPServers(() => { void this.checkStatus().catch(() => this.unavailable()); }));
        this.disposables.push(this.trust.onDidChangeWorkspaceTrust(trusted => { if (trusted) { this.schedule(false); } }));
        this.schedule(false);
    }

    onStop(): void { this.stopped = true; this.disposables.dispose(); }

    private schedule(update: boolean): void {
        this.pendingUpdate ||= update;
        this.queue = this.queue.then(() => {
            const pending = this.pendingUpdate;
            this.pendingUpdate = false;
            return this.configureServer(pending);
        }).catch(() => this.unavailable());
    }

    protected async configureServer(update: boolean): Promise<void> {
        await this.preferences.ready;
        try { await this.environment.ready(); } catch {
            this.memory.setUnavailable(true);
            return;
        }
        if (this.stopped || !this.preferences.get('arschat.memory.enabled', true)) { return; }
        // Other milestones' tests must not even start the personal memory server through this contribution.
        if (this.environment.autoSaveBlocked && !this.environment.m16) { return; }
        const name = this.environment.serverName;
        this.memory.setUnavailable(false);
        const entry = memoryServerEntry(
            this.preferences.get('arschat.memory.command', 'sqgraph-memory'),
            this.preferences.get('arschat.memory.agentName', 'arschat'),
            this.preferences.get('arschat.memory.group', ''), this.environment.testHome
        );
        if (this.environment.m16 && !this.environment.testHome) { throw new Error('missing isolated memory home'); }
        if (update && await this.mcp.hasServer(name)) { await this.mcp.stopServer(name); }
        if (this.environment.m16) {
            // Ephemeral dedicated name: never persist test paths or reuse a user-supplied server definition.
            const previous = await this.mcp.getServerDescription(name);
            if (update || !previous) {
                await this.mcp.addOrUpdateServer({ ...entry, name });
            } else if (!('command' in previous) || previous.command !== entry.command
                || JSON.stringify(previous.args) !== JSON.stringify(entry.args)
                || JSON.stringify(previous.env) !== JSON.stringify(entry.env)) {
                throw new Error('unsafe autotest server definition');
            }
        } else {
            const servers = this.preferences.get<MemoryServers>(MCP_SERVERS_PREF, {});
            const next = update ? { ...servers, [MEMORY_SERVER]: entry } : addMemoryServer(servers, entry);
            if (next !== servers) { await this.preferences.set(MCP_SERVERS_PREF, next, PreferenceScope.User); }
            // Also covers changes while another server's startup delays the parent's
            // preference listener. Only the parent decides which definitions changed.
            this.synchronizeServers();
        }
        const description = await this.mcp.getServerDescription(name);
        if (description?.autostart === false || !(await this.trust.getWorkspaceTrust())) { return; }
        // Theia may still be starting it. startServer is idempotent while Starting/Connecting.
        await withTimeout(this.mcp.startServer(name), 30000);
        await withTimeout(this.waitUntilStarted(name), 30000);
        this.memory.setUnavailable(false);
    }

    private async waitUntilStarted(name: string): Promise<void> {
        const deadline = Date.now() + 30000;
        while (!this.stopped && Date.now() < deadline) {
            const description = await this.mcp.getServerDescription(name);
            if (description?.status === MCPServerStatus.Errored) { throw new Error('memory startup failed'); }
            if (description?.status === MCPServerStatus.Running || description?.status === MCPServerStatus.Connected) {
                // A concurrent Theia autostart can make our first startServer return before tools are available.
                // Now it is running, this idempotent call also registers its tools in the frontend registry.
                await this.mcp.startServer(name);
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('memory startup timeout');
    }

    protected async checkStatus(): Promise<void> {
        if (this.stopped || !this.preferences.get('arschat.memory.enabled', true)) { return; }
        try { await this.environment.ready(); } catch { return; }
        if (!this.environment.accessAllowed) { return; }
        const description = await this.mcp.getServerDescription(this.environment.serverName);
        if (description?.status === MCPServerStatus.Errored) { this.unavailable(); }
    }

    protected unavailable(): void {
        this.memory.setUnavailable(true);
        if (this.notified || this.stopped) { return; }
        this.notified = true;
        void this.messages.warn('ユーザーメモリ (sqgraph) を起動できませんでした。インストール: uv tool install "sqgraph[mcp] @ git+https://github.com/Fukuro99/sqgraph"');
    }
}
