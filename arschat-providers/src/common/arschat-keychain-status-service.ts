export const ArschatKeychainStatusService = Symbol('ArschatKeychainStatusService');
export const arschatKeychainStatusPath = '/services/arschat/keychain-status';

export interface ArschatKeychainStatusService {
    isPersistent(): Promise<boolean>;
}
