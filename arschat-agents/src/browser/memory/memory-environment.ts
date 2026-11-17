import { inject, injectable } from '@theia/core/shared/inversify';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { FileUri } from '@theia/core/lib/common/file-uri';
import URI from '@theia/core/lib/common/uri';
import { MEMORY_SERVER, MEMORY_TEST_SERVER } from './memory-preferences';

@injectable()
export class ArschatMemoryEnvironment {
    @inject(EnvVariablesServer) protected readonly env!: EnvVariablesServer;
    private initialization?: Promise<void>;
    // Fail closed until backend environment detection succeeds.
    autoSaveBlocked = true;
    m16 = false;
    serverName = MEMORY_SERVER;
    testHome?: string;

    get accessAllowed(): boolean {
        return !this.autoSaveBlocked || (this.m16 && this.serverName === MEMORY_TEST_SERVER && !!this.testHome);
    }

    ready(): Promise<void> {
        return this.initialization ??= this.initialize();
    }

    private async initialize(): Promise<void> {
        const variables = await this.env.getVariables();
        // EnvVariablesServerImpl normalizes names to lower case on Windows.
        this.autoSaveBlocked = variables.some(v => /^ARSCHAT_.*_AUTOTEST$/i.test(v.name) && v.value === '1');
        this.m16 = variables.some(v => v.name.toUpperCase() === 'ARSCHAT_M16_AUTOTEST' && v.value === '1');
        if (this.m16) {
            // sqgraph gives DB precedence over HOME. Do not start at all if inherited
            // backend configuration could bypass our isolated HOME (never log its value).
            if (variables.some(v => v.name.toUpperCase() === 'SQGRAPH_MEMORY_DB' && v.value)) {
                throw new Error('M16 requires SQGRAPH_MEMORY_DB to be unset');
            }
            this.serverName = MEMORY_TEST_SERVER;
            const config = new URI(await this.env.getConfigDirUri());
            if (config.scheme !== 'file') { throw new Error('M16 requires a local config directory'); }
            this.testHome = FileUri.fsPath(config.resolve(`arschat/m16-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`));
        }
    }
}
