export type CliAgentKind = 'codex-cli' | 'claude-code-cli' | 'opencode-cli';
export const isCliAgent = (id: string): id is CliAgentKind => id === 'codex-cli' || id === 'claude-code-cli' || id === 'opencode-cli';
export const CLI_SETTINGS = 'arschatCliAgents';
export const CLI_PREF = 'arschat.cliAgents.';
export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export const CLAUDE_PERMISSION_MODES = ['plan', 'acceptEdits', 'default', 'bypassPermissions'] as const;
export const OPENCODE_AGENT_MODES = ['plan', 'build'] as const;
export const CLAUDE_LOGIN_REQUIRED = 'Claude Code にログインしていません。ターミナルで `claude` を起動し、/login で Claude のサブスクリプションのアカウントにログインしてから、もう一度送ってください。';
export const CLAUDE_SUBSCRIPTION_REQUIRED = 'Claude Code が API キーまたは他社クラウドの認証で設定されています。ArsChat は Claude のサブスクリプションのログインでのみ Claude Code を動かします。Claude Code の設定から API キー (apiKeyHelper や env の ANTHROPIC_API_KEY) を外し、ターミナルで `claude` → /login でログインしてください。';
export const CLI_IMAGE_NOTICE = '画像は CLI プロバイダでは送れません';
export interface CliAgentSettings {
    codexCommand: string;
    codexSandbox: typeof CODEX_SANDBOX_MODES[number];
    codexModel: string;
    claudeCommand: string;
    claudePermissionMode: typeof CLAUDE_PERMISSION_MODES[number];
    claudeModel: string;
    opencodeCommand: string;
    opencodeAgent: typeof OPENCODE_AGENT_MODES[number];
    opencodeModel: string;
    workingDirectory: string;
    timeoutMinutes: number;
}
export const CLI_DEFAULTS: CliAgentSettings = {
    codexCommand: 'codex', codexSandbox: 'read-only', codexModel: '',
    claudeCommand: 'claude', claudePermissionMode: 'plan', claudeModel: '',
    opencodeCommand: 'opencode', opencodeAgent: 'plan', opencodeModel: '',
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
        opencodeCommand: str('opencodeCommand') || 'opencode', opencodeModel: str('opencodeModel'),
        opencodeAgent: OPENCODE_AGENT_MODES.includes(s.opencodeAgent as CliAgentSettings['opencodeAgent'])
            ? s.opencodeAgent as CliAgentSettings['opencodeAgent'] : CLI_DEFAULTS.opencodeAgent,
        workingDirectory: str('workingDirectory'),
        timeoutMinutes: typeof s.timeoutMinutes === 'number' && Number.isFinite(s.timeoutMinutes) && s.timeoutMinutes > 0
            ? Math.min(s.timeoutMinutes, 1440) : 15
    };
}
export interface CliAgentCheck { available: boolean; loggedIn?: boolean; message?: string }
export const CliAgentService = Symbol('CliAgentService');
export const cliAgentServicePath = '/services/arschat/cli-agents';
export interface CliAgentService {
    check(kind: CliAgentKind, settings: CliAgentSettings): Promise<CliAgentCheck>;
    listModels(kind: CliAgentKind, settings: CliAgentSettings): Promise<string[]>;
}
