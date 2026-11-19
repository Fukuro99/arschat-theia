if (typeof global.DragEvent === 'undefined') {
    global.DragEvent = class DragEvent extends Event {};
}

// Agent request tests need only the workspace DI token, not the browser shell/CSS.
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({ WorkspaceService: Symbol('WorkspaceService') }));
