// Mock DragEvent as '@lumino/dragdrop' already requires it at require time
global.DragEvent = class DragEvent { };

// CLI tests replace this with synthetic children. Never launch a real CLI from Jest.
jest.mock('child_process', () => ({
    ...jest.requireActual('child_process'),
    spawn: jest.fn(() => { throw new Error('Real process spawning is forbidden in Jest.'); })
}));

// Unit tests must never reach the actual OS credential manager, even via a new transitive import.
jest.mock('keytar', () => { throw new Error('Native credential access is forbidden in Jest; mock KeyStoreService.'); });
jest.mock('@theia/core/lib/node/key-store-server', () => {
    throw new Error('KeyStoreServiceImpl is forbidden in Jest; use the Map-backed KeyStoreService mock.');
});
