import { CliAgentKind } from '../common/cli-agents';

// Deliberately allow individual runtime variables, never provider/authentication prefixes.
const RUNTIME_VARIABLES = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
    'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
    'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432',
    'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'OS',
    'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE', 'LC_NUMERIC',
    'LC_MONETARY', 'LC_TIME', 'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE',
    'LC_MEASUREMENT', 'LC_IDENTIFICATION', 'TERM', 'COLORTERM',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS'
]);

const OPENCODE_VARIABLES = new Set([
    'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'
]);

export function cliEnvironment(kind: CliAgentKind, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(source)) {
        if (RUNTIME_VARIABLES.has(name.toUpperCase()) || (kind === 'codex-cli' && name === 'CODEX_HOME')
            || (kind === 'claude-code-cli' && name === 'CLAUDE_CONFIG_DIR')
            || (kind === 'opencode-cli' && OPENCODE_VARIABLES.has(name))) {
            env[name] = value;
        }
    }
    return env;
}
