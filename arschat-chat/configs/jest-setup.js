// Mock DragEvent as '@lumino/dragdrop' already requires it at require time
global.DragEvent = class DragEvent { };

// Unit tests must never reach the actual OS credential manager, even via a new transitive import.
jest.mock('keytar', () => { throw new Error('Native credential access is forbidden in Jest; mock KeyStoreService.'); });
jest.mock('@theia/core/lib/node/key-store-server', () => {
    throw new Error('KeyStoreServiceImpl is forbidden in Jest; use the Map-backed KeyStoreService mock.');
});
