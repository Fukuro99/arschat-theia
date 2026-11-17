import { inject, injectable } from '@theia/core/shared/inversify';
import { KeyStoreService } from '@theia/core/lib/common/key-store';
import { ArschatKeychainStatusService } from '../common/arschat-keychain-status-service';
import { ArschatKeyStoreServiceImpl } from './arschat-key-store-service-impl';

@injectable()
export class ArschatKeychainStatusServiceImpl implements ArschatKeychainStatusService {
    @inject(KeyStoreService)
    protected readonly keyStore!: ArschatKeyStoreServiceImpl;

    isPersistent(): Promise<boolean> {
        return this.keyStore.isPersistent();
    }
}
