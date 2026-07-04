// *****************************************************************************
// ArsChat "import legacy MCP config" command (PHASE1_DESIGN.md §7, M5 e-6).
//
// Registers a command-palette command that reads the *current* ArsChat
// `mcp-config.json`, converts it (via the pure ../common/mcp-config-import
// logic) into Theia's `ai-features.mcp.mcpServers` preference value, merges it
// non-destructively onto whatever is already there, writes it with the
// PreferenceService, and reports the outcome (imported / skipped-with-reasons /
// dropped notes) through the MessageService.
//
// This is an explicit user action, so it needs no ToolConfirmationManager
// approval flow (that governs *agent* tool calls, e-3/e-4). It touches the
// legacy file read-only.
//
// ---- Where the file lives ---------------------------------------------------
//   Default path: %APPDATA%\ArsChat\arschat-data\mcp-config.json (resolved via
//   EnvVariablesServer.getValue('APPDATA'); POSIX fallback ~/.config/ArsChat).
//   If it is missing/unreadable, we fall back to an open-file dialog so the user
//   can pick the JSON manually. All reads go through Theia's FileService (in
//   Electron its disk provider serves any local path), same pattern as
//   ArschatFileToolsService.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { Command, CommandContribution, CommandRegistry, MessageService, URI } from '@theia/core';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { PreferenceService, PreferenceScope } from '@theia/core/lib/common/preferences';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService, OpenFileDialogProps } from '@theia/filesystem/lib/browser';
import { MCP_SERVERS_PREF } from '@theia/ai-mcp/lib/common/mcp-preferences';
import {
    convertLegacyMCPConfig,
    mergeIntoExisting,
    MCPImportResult,
    TheiaMCPServersPreference
} from '../common/mcp-config-import';

export const ImportLegacyMCPConfigCommand: Command = {
    id: 'arschat-tools:mcp:import-legacy',
    label: 'ArsChat: 旧 ArsChat から MCP 設定をインポート'
};

/** Sub-path of the legacy config under the OS app-data dir. */
const LEGACY_REL_PATH = ['ArsChat', 'arschat-data', 'mcp-config.json'];

@injectable()
export class ArschatMCPImportContribution implements CommandContribution {

    @inject(EnvVariablesServer)
    protected readonly envServer!: EnvVariablesServer;

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(FileDialogService)
    protected readonly fileDialog!: FileDialogService;

    @inject(PreferenceService)
    protected readonly preferenceService!: PreferenceService;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(ImportLegacyMCPConfigCommand, {
            execute: () => this.run()
        });
    }

    protected async run(): Promise<void> {
        try {
            const uri = await this.resolveConfigUri();
            if (!uri) {
                this.messageService.info('MCP 設定のインポートをキャンセルしました。');
                return;
            }

            let raw: string;
            try {
                const content = await this.fileService.read(uri);
                raw = content.value;
            } catch (e) {
                this.messageService.error(`MCP 設定ファイルを読み込めませんでした: ${uri.path.fsPath()} (${String(e)})`);
                return;
            }

            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch (e) {
                this.messageService.error(`MCP 設定ファイルの JSON を解析できませんでした: ${String(e)}`);
                return;
            }

            const result = convertLegacyMCPConfig(parsed);
            await this.applyAndReport(result);
        } catch (e) {
            this.messageService.error(`MCP 設定のインポート中にエラーが発生しました: ${String(e)}`);
        }
    }

    /**
     * Try the default %APPDATA% path; if it doesn't exist, open a file dialog.
     * Returns undefined if the user cancels the dialog.
     */
    protected async resolveConfigUri(): Promise<URI | undefined> {
        const defaultUri = await this.defaultConfigUri();
        if (defaultUri) {
            try {
                if (await this.fileService.exists(defaultUri)) {
                    return defaultUri;
                }
            } catch {
                // fall through to the dialog
            }
        }
        return this.pickConfigViaDialog(defaultUri);
    }

    protected async defaultConfigUri(): Promise<URI | undefined> {
        // Windows: %APPDATA%. POSIX fallback: $XDG_CONFIG_HOME or ~/.config.
        const appData = await this.envServer.getValue('APPDATA');
        if (appData?.value) {
            return URI.fromFilePath(appData.value).resolve(LEGACY_REL_PATH.join('/'));
        }
        const xdg = await this.envServer.getValue('XDG_CONFIG_HOME');
        if (xdg?.value) {
            return URI.fromFilePath(xdg.value).resolve(LEGACY_REL_PATH.join('/'));
        }
        const home = await this.envServer.getValue('HOME');
        if (home?.value) {
            return URI.fromFilePath(home.value).resolve(['.config', ...LEGACY_REL_PATH].join('/'));
        }
        return undefined;
    }

    protected async pickConfigViaDialog(near?: URI): Promise<URI | undefined> {
        const props: OpenFileDialogProps = {
            title: '旧 ArsChat の mcp-config.json を選択',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false
        };
        let folder;
        if (near) {
            try {
                folder = await this.fileService.resolve(near.parent);
            } catch {
                folder = undefined;
            }
        }
        const chosen = await this.fileDialog.showOpenDialog(props, folder);
        return Array.isArray(chosen) ? chosen[0] : chosen;
    }

    /**
     * Merge the converted servers onto the existing preference (non-destructive:
     * existing entries win), write it back, and report imported/skipped/notes.
     */
    protected async applyAndReport(result: MCPImportResult): Promise<void> {
        const existing = this.preferenceService.get<TheiaMCPServersPreference>(MCP_SERVERS_PREF, {});
        const { merged, skippedExisting } = mergeIntoExisting(existing, result.servers);

        const willWrite = result.importedCount > 0 && Object.keys(merged).length > Object.keys(existing ?? {}).length;
        if (willWrite || Object.keys(result.servers).length > 0) {
            await this.preferenceService.set(MCP_SERVERS_PREF, merged, PreferenceScope.User);
        }

        const lines: string[] = [];
        const added = result.importedCount - skippedExisting.length;
        lines.push(`MCP 設定インポート完了: ${Math.max(added, 0)} サーバーを取り込みました。`);

        if (skippedExisting.length > 0) {
            lines.push(`既存の同名設定があるためスキップ: ${skippedExisting.join(', ')}`);
        }
        for (const w of result.warnings) {
            lines.push(`スキップ [${w.name}]: ${w.reason}`);
        }
        for (const n of result.notes) {
            lines.push(`注記 [${n.name}]: ${n.reason}`);
        }
        lines.push('自動起動対象は再起動後に有効化されます。初回は「MCP: Start MCP Server」で手動起動してください。');

        const message = lines.join('\n');
        if (result.warnings.length > 0) {
            this.messageService.warn(message);
        } else {
            this.messageService.info(message);
        }
    }
}
