/** @jest-environment jsdom */
import 'reflect-metadata';
import { ArschatMemoryEnvironment } from './memory-environment';

describe('memory backend environment isolation', () => {
    function environment(variables: { name: string; value: string }[]) {
        const env = new ArschatMemoryEnvironment();
        const backend = { getVariables: jest.fn(async () => variables), getConfigDirUri: async () => 'file:///isolated-theia-config' };
        Object.assign(env, { env: backend });
        return { env, backend };
    }
    it('fails closed until detection succeeds and caches the check', async () => {
        const { env, backend } = environment([]);
        expect(env.autoSaveBlocked).toBe(true);
        expect(env.accessAllowed).toBe(false);
        await Promise.all([env.ready(), env.ready()]);
        expect(env.autoSaveBlocked).toBe(false);
        expect(env.accessAllowed).toBe(true);
        expect(backend.getVariables).toHaveBeenCalledTimes(1);
    });
    it.each(['ARSCHAT_M2_AUTOTEST', 'ARSCHAT_M13_AUTOTEST', 'ARSCHAT_FUTURE_AUTOTEST', 'arschat_m13_autotest'])('blocks all milestone saves: %s', async name => {
        const { env } = environment([{ name, value: '1' }]);
        await env.ready();
        expect(env.autoSaveBlocked).toBe(true);
        expect(env.m16).toBe(false);
        expect(env.accessAllowed).toBe(false);
    });
    it('uses a fresh directory below THEIA_CONFIG_DIR and a dedicated name for M16', async () => {
        const { env } = environment([{ name: 'arschat_m16_autotest', value: '1' }]);
        await env.ready();
        expect(env.autoSaveBlocked).toBe(true);
        expect(env.serverName).toBe('sqgraph-memory-autotest');
        expect(env.accessAllowed).toBe(true);
        expect(env.testHome?.replace(/\\/g, '/')).toMatch(/\/isolated-theia-config\/arschat\/m16-memory-/);
    });
    it('keeps saves blocked on environment RPC failure', async () => {
        const { env, backend } = environment([]);
        backend.getVariables.mockRejectedValue(new Error('offline'));
        await expect(env.ready()).rejects.toThrow('offline');
        expect(env.autoSaveBlocked).toBe(true);
    });
    it('refuses M16 startup when an inherited DB override could escape HOME', async () => {
        const { env } = environment([{ name: 'ARSCHAT_M16_AUTOTEST', value: '1' }, { name: 'sqgraph_memory_db', value: 'personal.db' }]);
        await expect(env.ready()).rejects.toThrow('SQGRAPH_MEMORY_DB');
        expect(env.accessAllowed).toBe(false);
        expect(env.testHome).toBeUndefined();
    });
});
