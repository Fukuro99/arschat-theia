// Wiring-level tests for the three file tools' ToolRequests: each factory must
// yield a ToolRequest with the expected id/schema, and its handler must route
// through the FileToolBackend and format results/errors the way the LLM sees
// them. Theia-DI-free (fake backend), so runs in a plain node jest env like the
// arschat-agents common/ tests.
import { createReadFileTool, createWriteFileTool, createEditFileTool, FileToolBackend } from './file-tool-requests';
import { READ_FILE_TOOL_ID, WRITE_FILE_TOOL_ID, EDIT_FILE_TOOL_ID, ARSCHAT_TOOL_PROVIDER_NAME } from './tool-ids';
import { applyEdit } from './edit-file';

class FakeBackend implements FileToolBackend {
    files = new Map<string, string>();
    async readFile(path: string): Promise<string> {
        if (!this.files.has(path)) {
            throw new Error(`File not found: ${path}`);
        }
        return this.files.get(path)!;
    }
    async writeFile(path: string, content: string): Promise<{ uri: string; created: boolean }> {
        const created = !this.files.has(path);
        this.files.set(path, content);
        return { uri: path, created };
    }
    async editFile(path: string, params: { oldString: string; newString: string; replaceAll?: boolean }): Promise<any> {
        const current = this.files.get(path);
        if (current === undefined) {
            return { ok: false, content: '', replacements: 0, error: `File not found: ${path}`, uri: path };
        }
        const res = applyEdit(current, params);
        if (res.ok) {
            this.files.set(path, res.content);
        }
        return { ...res, uri: path };
    }
}

describe('file tool ToolRequests (factory shape + handler wiring)', () => {

    it('read_file exposes the expected ToolRequest shape and is not confirm-required', () => {
        const tool = createReadFileTool(new FakeBackend());
        expect(tool.id).toBe(READ_FILE_TOOL_ID);
        expect(tool.name).toBe(READ_FILE_TOOL_ID);
        expect(tool.providerName).toBe(ARSCHAT_TOOL_PROVIDER_NAME);
        expect(tool.parameters.required).toContain('path');
        expect(typeof tool.handler).toBe('function');
        // e-2: no confirmAlwaysAllow -> default ALWAYS_ALLOW (unconfirmed).
        expect(tool.confirmAlwaysAllow).toBeUndefined();
    });

    it('read_file handler returns file content and reports missing files / missing args as errors', async () => {
        const be = new FakeBackend();
        be.files.set('a.txt', 'hello');
        const tool = createReadFileTool(be);
        expect(await tool.handler(JSON.stringify({ path: 'a.txt' }))).toBe('hello');
        expect(await tool.handler(JSON.stringify({ path: 'missing.txt' }))).toMatch(/^ERROR: /);
        expect(await tool.handler(JSON.stringify({}))).toMatch(/requires a non-empty "path"/);
        expect(await tool.handler('not json')).toMatch(/requires a non-empty "path"/);
    });

    it('write_file creates then overwrites, and reports the outcome', async () => {
        const be = new FakeBackend();
        const tool = createWriteFileTool(be);
        expect(tool.id).toBe(WRITE_FILE_TOOL_ID);
        expect(tool.parameters.required).toEqual(expect.arrayContaining(['path', 'content']));
        expect(await tool.handler(JSON.stringify({ path: 'new.txt', content: 'x' }))).toMatch(/OK: created/);
        expect(be.files.get('new.txt')).toBe('x');
        expect(await tool.handler(JSON.stringify({ path: 'new.txt', content: 'yy' }))).toMatch(/OK: overwrote/);
        expect(be.files.get('new.txt')).toBe('yy');
        expect(await tool.handler(JSON.stringify({ path: 'new.txt' }))).toMatch(/requires a "content"/);
    });

    it('edit_file applies an in-place replacement and surfaces failures', async () => {
        const be = new FakeBackend();
        be.files.set('code.ts', 'const a = 1;');
        const tool = createEditFileTool(be);
        expect(tool.id).toBe(EDIT_FILE_TOOL_ID);
        expect(await tool.handler(JSON.stringify({ path: 'code.ts', oldString: 'a = 1', newString: 'a = 2' }))).toMatch(/OK: edited/);
        expect(be.files.get('code.ts')).toBe('const a = 2;');
        expect(await tool.handler(JSON.stringify({ path: 'code.ts', oldString: 'nope', newString: 'x' }))).toMatch(/^ERROR: /);
        expect(await tool.handler(JSON.stringify({ path: 'code.ts', oldString: 'a' }))).toMatch(/requires both/);
    });
});
