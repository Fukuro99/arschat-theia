import { ExtensionBridgeError } from './extension-bridge-protocol';

export const EXTENSION_BRIDGE_MAX_PENDING_REQUESTS = 20;
export const EXTENSION_BRIDGE_REQUEST_TIMEOUT_MS = 60_000;

type TimeoutHandle = ReturnType<typeof setTimeout>;

export class ExtensionBridgeRequestLimiter {

    protected pending = 0;

    constructor(
        protected readonly maxPending = EXTENSION_BRIDGE_MAX_PENDING_REQUESTS,
        protected readonly timeoutMs = EXTENSION_BRIDGE_REQUEST_TIMEOUT_MS,
        protected readonly setTimer: typeof setTimeout = setTimeout,
        protected readonly clearTimer: typeof clearTimeout = clearTimeout
    ) { }

    get pendingCount(): number {
        return this.pending;
    }

    async run<T>(operation: () => Promise<T>): Promise<T> {
        if (this.pending >= this.maxPending) {
            throw createTooManyPendingRequestsError(this.maxPending);
        }
        this.pending++;
        try {
            return await withExtensionRequestTimeout(Promise.resolve().then(operation), this.timeoutMs, this.setTimer, this.clearTimer);
        } finally {
            this.pending--;
        }
    }
}

export function withExtensionRequestTimeout<T>(
    promise: Promise<T>,
    timeoutMs = EXTENSION_BRIDGE_REQUEST_TIMEOUT_MS,
    setTimer: typeof setTimeout = setTimeout,
    clearTimer: typeof clearTimeout = clearTimeout
): Promise<T> {
    let timer: TimeoutHandle | undefined;
    const timeout = new Promise<T>((_, reject) => {
        timer = setTimer(() => reject(createBridgeTimeoutError(timeoutMs)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer !== undefined) {
            clearTimer(timer);
        }
    });
}

export function createTooManyPendingRequestsError(maxPending = EXTENSION_BRIDGE_MAX_PENDING_REQUESTS): ExtensionBridgeError {
    return {
        code: 'INTERNAL',
        message: `Too many pending extension bridge requests (max ${maxPending})`
    };
}

export function createBridgeTimeoutError(timeoutMs = EXTENSION_BRIDGE_REQUEST_TIMEOUT_MS): ExtensionBridgeError {
    return {
        code: 'INTERNAL',
        message: `Extension bridge request timed out after ${timeoutMs}ms`
    };
}
