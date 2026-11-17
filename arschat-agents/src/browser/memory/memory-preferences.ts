import { PreferenceSchema } from '@theia/core/lib/common/preferences';
import type { LocalMCPServerDescription, RemoteMCPServerDescription } from '@theia/ai-mcp/lib/common/mcp-server-manager';

export const MEMORY_SERVER = 'sqgraph-memory';
export const MEMORY_TEST_SERVER = 'sqgraph-memory-autotest';
export const MCP_SERVERS_PREF = 'ai-features.mcp.mcpServers';
export const memoryPreferenceSchema: PreferenceSchema = {
    properties: {
        'arschat.memory.enabled': { type: 'boolean', default: true, description: 'ユーザーメモリを有効にする' },
        'arschat.memory.autoSave': { type: 'boolean', default: true, description: '会話終了後にユーザーメモリを自動保存する' },
        'arschat.memory.command': { type: 'string', default: 'sqgraph-memory', description: 'sqgraph-memory 実行ファイル' },
        'arschat.memory.agentName': { type: 'string', default: 'arschat', description: 'sqgraph のエージェント名' },
        'arschat.memory.group': { type: 'string', default: '', description: '記憶のグループ (空なら sqgraph の設定)' },
        'arschat.memory.recallLimit': { type: 'number', default: 5, minimum: 1, maximum: 100, description: '自動想起の最大件数' }
    }
};

export type MemoryServerEntry = Omit<LocalMCPServerDescription, 'name'>;
export type MemoryServers = Record<string, MemoryServerEntry | Omit<RemoteMCPServerDescription, 'name'>>;

export function memoryServerEntry(command: string, agent: string, group: string, testHome?: string): MemoryServerEntry {
    return {
        command, args: ['mcp', '--agent', agent, ...(testHome ? ['--extractor', 'agent'] : [])], autostart: true,
        env: {
            ...(group ? { SQGRAPH_MEMORY_GROUP: group } : {}),
            ...(testHome ? { SQGRAPH_MEMORY_HOME: testHome } : {})
        }
    };
}

export function addMemoryServer(servers: MemoryServers, entry: MemoryServerEntry): MemoryServers {
    return Object.prototype.hasOwnProperty.call(servers, MEMORY_SERVER) ? servers : { ...servers, [MEMORY_SERVER]: entry };
}
