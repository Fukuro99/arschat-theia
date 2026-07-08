// *****************************************************************************
// ArsChat per-message elapsed-time store (M6 e-25).
//
// Theia persists a response's tokenUsage but not how long it took to generate.
// This tiny service keeps the measured elapsed time (ms) for each request id in
// the frontend StorageService (localStorage-backed), so the stats bar can show
// the duration again when a session is reopened from history.
//
// The map is versioned and bounded; the schema is intentionally trivial
// (requestId -> ms) so nothing breaks when older sessions - which have no entry -
// are restored (getDurationMs simply returns undefined and the bar shows only the
// token count).
// *****************************************************************************

import { injectable, inject } from '@theia/core/shared/inversify';
import { StorageService } from '@theia/core/lib/browser/storage-service';

/** requestId -> elapsed milliseconds. */
type DurationMap = { [requestId: string]: number };

@injectable()
export class ArschatStatsStore {

    protected static readonly STORAGE_KEY = 'arschat.messageStats.v1';
    /** Cap the map so it cannot grow without bound across many sessions. */
    protected static readonly MAX_ENTRIES = 1000;

    @inject(StorageService)
    protected readonly storageService!: StorageService;

    protected cache: DurationMap = {};
    protected loaded = false;
    protected loading: Promise<void> | undefined;

    /** Load the persisted map once. Safe to await repeatedly. */
    async ready(): Promise<void> {
        if (this.loaded) {
            return;
        }
        if (!this.loading) {
            this.loading = this.storageService
                .getData<DurationMap>(ArschatStatsStore.STORAGE_KEY, {})
                .then(map => { this.cache = map ?? {}; this.loaded = true; })
                .catch(() => { this.cache = {}; this.loaded = true; });
        }
        await this.loading;
    }

    /** Elapsed ms for a request id, or undefined if never recorded. */
    getDurationMs(requestId: string): number | undefined {
        return this.cache[requestId];
    }

    /** Record (and persist) the elapsed ms for a request id. */
    async record(requestId: string, durationMs: number): Promise<void> {
        await this.ready();
        this.cache[requestId] = durationMs;
        this.prune();
        await this.storageService.setData(ArschatStatsStore.STORAGE_KEY, this.cache).catch(() => { /* noop */ });
    }

    /** Drop a request id (e.g. after a message is deleted). Persists lazily. */
    async forget(requestId: string): Promise<void> {
        await this.ready();
        if (requestId in this.cache) {
            delete this.cache[requestId];
            await this.storageService.setData(ArschatStatsStore.STORAGE_KEY, this.cache).catch(() => { /* noop */ });
        }
    }

    /** Evict oldest entries (insertion order) once the cap is exceeded. */
    protected prune(): void {
        const keys = Object.keys(this.cache);
        if (keys.length > ArschatStatsStore.MAX_ENTRIES) {
            for (const key of keys.slice(0, keys.length - ArschatStatsStore.MAX_ENTRIES)) {
                delete this.cache[key];
            }
        }
    }
}
