export type CliAgentKind = 'codex-cli' | 'claude-code-cli';
export const isCliAgent = (id: string): id is CliAgentKind => id === 'codex-cli' || id === 'claude-code-cli';
export const CLI_SETTINGS = 'arschatCliAgents';
export const CLI_PREF = 'arschat.cliAgents.';
export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export const CLAUDE_PERMISSION_MODES = ['plan', 'acceptEdits', 'default', 'bypassPermissions'] as const;
export const CLAUDE_KEY_REQUIRED = 'Claude Code を呼ぶには Anthropic の API キーが必要です。チャットヘッダーの『API キー』から Anthropic のキーを保存してください (Claude のサブスクリプションのログインは、Anthropic の規約によりサードパーティのアプリからは使えません)。';
export const CLI_IMAGE_NOTICE = '画像は CLI プロバイダでは送れません';
export interface CliAgentSettings {
    codexCommand: string;
    codexSandbox: typeof CODEX_SANDBOX_MODES[number];
    codexModel: string;
    claudeCommand: string;
    claudePermissionMode: typeof CLAUDE_PERMISSION_MODES[number];
    claudeModel: string;
    workingDirectory: string;
    timeoutMinutes: number;
}
export const CLI_DEFAULTS: CliAgentSettings = {
    codexCommand: 'codex', codexSandbox: 'read-only', codexModel: '',
    claudeCommand: 'claude', claudePermissionMode: 'plan', claudeModel: '',
    workingDirectory: '', timeoutMinutes: 15
};
export function normalizeCliSettings(raw: unknown): CliAgentSettings {
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const str = (key: keyof CliAgentSettings): string => typeof s[key] === 'string' ? (s[key] as string).trim() : String(CLI_DEFAULTS[key]);
    return {
        codexCommand: str('codexCommand') || 'codex', codexModel: str('codexModel'),
        codexSandbox: CODEX_SANDBOX_MODES.includes(s.codexSandbox as CliAgentSettings['codexSandbox'])
            ? s.codexSandbox as CliAgentSettings['codexSandbox'] : CLI_DEFAULTS.codexSandbox,
        claudeCommand: str('claudeCommand') || 'claude', claudeModel: str('claudeModel'),
        claudePermissionMode: CLAUDE_PERMISSION_MODES.includes(s.claudePermissionMode as CliAgentSettings['claudePermissionMode'])
            ? s.claudePermissionMode as CliAgentSettings['claudePermissionMode'] : CLI_DEFAULTS.claudePermissionMode,
        workingDirectory: str('workingDirectory'),
        timeoutMinutes: typeof s.timeoutMinutes === 'number' && Number.isFinite(s.timeoutMinutes) && s.timeoutMinutes > 0
            ? Math.min(s.timeoutMinutes, 1440) : 15
    };
}
export interface CliAgentCheck { available: boolean; keyAvailable?: boolean; message?: string }
export const CliAgentService = Symbol('CliAgentService');
export const cliAgentServicePath = '/services/arschat/cli-agents';
export interface CliAgentService {
    check(kind: CliAgentKind, settings: CliAgentSettings): Promise<CliAgentCheck>;
}
