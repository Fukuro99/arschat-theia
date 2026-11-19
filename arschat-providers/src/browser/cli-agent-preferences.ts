import { PreferenceSchema } from '@theia/core/lib/common/preferences/preference-schema';
import { CliAgentSettings, CLI_DEFAULTS, CLI_PREF, CODEX_SANDBOX_MODES, CLAUDE_PERMISSION_MODES, OPENCODE_AGENT_MODES, normalizeCliSettings } from '../common/cli-agents';

export const CLI_PREFERENCE_KEYS: Record<keyof CliAgentSettings, string> = {
    codexCommand: 'codex.command', codexSandbox: 'codex.sandbox', codexModel: 'codex.model',
    claudeCommand: 'claudeCode.command', claudePermissionMode: 'claudeCode.permissionMode', claudeModel: 'claudeCode.model',
    opencodeCommand: 'opencode.command', opencodeAgent: 'opencode.agent', opencodeModel: 'opencode.model',
    workingDirectory: 'workingDirectory', timeoutMinutes: 'timeoutMinutes'
};
export const cliAgentPreferenceSchema: PreferenceSchema = { properties: Object.fromEntries(
    (Object.keys(CLI_PREFERENCE_KEYS) as (keyof CliAgentSettings)[]).map(key => [CLI_PREF + CLI_PREFERENCE_KEYS[key], {
        type: key === 'timeoutMinutes' ? 'number' : 'string', default: CLI_DEFAULTS[key],
        ...(key === 'claudeCommand' ? {
            markdownDescription: 'Claude Code CLI の実行ファイル。事前にターミナルで `claude` を起動してログインしておくと、そのログイン (Claude のサブスクリプション) で動きます。ArsChat は認証情報を読みません。'
        } : {}),
        ...(key === 'codexSandbox' ? {
            enum: [...CODEX_SANDBOX_MODES],
            markdownDescription: 'Codex のサンドボックスモード。**警告:** `danger-full-access` は CLI がファイル削除・コマンド実行を確認なしで行えるモードです。'
        } : {}),
        ...(key === 'claudePermissionMode' ? {
            enum: [...CLAUDE_PERMISSION_MODES],
            markdownDescription: 'Claude Code の権限モード。**警告:** `bypassPermissions` は CLI がファイル削除・コマンド実行を確認なしで行えるモードです。'
        } : {}),
        ...(key === 'timeoutMinutes' ? { exclusiveMinimum: 0, maximum: 1440 } : {}),
        ...(key === 'opencodeAgent' ? {
            enum: [...OPENCODE_AGENT_MODES],
            markdownDescription: 'OpenCode のエージェント。`plan` は読み取り中心で書き込みを拒否します。**警告:** `build` は OpenCode の権限設定に従い、既定ではファイル編集・コマンド実行を確認なしで行います。'
        } : {}),
        description: key === 'opencodeModel'
            ? '`provider/model` 形式 (例: `edgexpert/qwen3.8-flash-next`)。空なら OpenCode の既定モデル。チャットヘッダーのモデル欄からも選べます。'
            : `ArsChat CLI: ${CLI_PREFERENCE_KEYS[key]}`
    }])
) };
export function readCliSettings(get: (key: string, fallback: unknown) => unknown): CliAgentSettings {
    return normalizeCliSettings(Object.fromEntries((Object.keys(CLI_PREFERENCE_KEYS) as (keyof CliAgentSettings)[])
        .map(key => [key, get(CLI_PREF + CLI_PREFERENCE_KEYS[key], CLI_DEFAULTS[key])])));
}
