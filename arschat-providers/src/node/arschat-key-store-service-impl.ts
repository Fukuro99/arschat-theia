import { injectable } from '@theia/core/shared/inversify';
import { InMemoryCredentialsProvider, KeyStoreServiceImpl } from '@theia/core/lib/node/key-store-server';

@injectable()
export class ArschatKeyStoreServiceImpl extends KeyStoreServiceImpl {
    private provider?: ReturnType<KeyStoreServiceImpl['getKeytar']>;

    protected override getKeytar(): ReturnType<KeyStoreServiceImpl['getKeytar']> {
        // Theia assigns keytarImplementation before its initial access check finishes.
        // All callers must await that check, including concurrent status/read/write RPCs.
        return this.provider ?? (this.provider = super.getKeytar());
    }

    async isPersistent(): Promise<boolean> {
        // Inspect the provider used by this very instance for all credential operations.
        return !(await this.getKeytar() instanceof InMemoryCredentialsProvider);
    }
}
