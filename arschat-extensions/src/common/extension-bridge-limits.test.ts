import { ExtensionBridgeRequestLimiter, EXTENSION_BRIDGE_REQUEST_TIMEOUT_MS } from './extension-bridge-limits';
import { ExtensionBridgeError } from './extension-bridge-protocol';

describe('ExtensionBridgeRequestLimiter', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('rejects immediately when the pending request limit is exceeded', async () => {
        const limiter = new ExtensionBridgeRequestLimiter(2);
        let releaseFirst: (() => void) | undefined;
        let releaseSecond: (() => void) | undefined;

        const first = limiter.run(() => new Promise<void>(resolve => { releaseFirst = resolve; }));
        const second = limiter.run(() => new Promise<void>(resolve => { releaseSecond = resolve; }));
        await expect(limiter.run(() => Promise.resolve('overflow'))).rejects.toMatchObject({
            code: 'INTERNAL',
            message: expect.stringContaining('Too many pending')
        });
        expect(limiter.pendingCount).toBe(2);

        releaseFirst?.();
        releaseSecond?.();
        await Promise.all([first, second]);
    });

    it('times out a single bridge call after 60 seconds', async () => {
        jest.useFakeTimers();
        const limiter = new ExtensionBridgeRequestLimiter();
        const call = limiter.run(() => new Promise<never>(() => undefined));

        jest.advanceTimersByTime(EXTENSION_BRIDGE_REQUEST_TIMEOUT_MS);

        await expect(call).rejects.toMatchObject<Partial<ExtensionBridgeError>>({
            code: 'INTERNAL',
            message: expect.stringContaining('60000ms')
        });
        expect(limiter.pendingCount).toBe(0);
    });
});
