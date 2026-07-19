/**
 * @jest-environment jsdom
 */
import 'reflect-metadata';
import { URI } from '@theia/core';
import { SkillService } from './skill-service';

class TestSkillService extends SkillService {
    constructor(
        readonly dir: URI,
        readonly files: Map<string, string>,
        readonly folders: Set<string>
    ) {
        super();
        (this as any).fileService = {
            exists: async (uri: URI) => this.folders.has(uri.toString()) || this.files.has(uri.toString()),
            createFolder: async (uri: URI) => { this.folders.add(uri.toString()); },
            resolve: async (uri: URI) => ({
                children: [...this.files.keys()]
                    .filter(key => key.startsWith(`${uri.toString()}/`))
                    .map(key => {
                        const resource = new URI(key);
                        return { isFile: true, resource };
                    })
            }),
            write: async (uri: URI, content: string) => { this.files.set(uri.toString(), content); },
            read: async (uri: URI) => ({ value: this.files.get(uri.toString()) ?? '' })
        };
        (this as any).logger = { info: jest.fn(), warn: jest.fn() };
    }

    protected override async skillsDirUri(): Promise<URI> {
        return this.dir;
    }

    seed(): Promise<void> {
        return (this as any).seedIfEmpty();
    }
}

describe('SkillService seeding', () => {
    const dir = new URI('file:///config/arschat/skills');

    it('adds the built-in /ui skill to an existing skills directory without overwriting user skills', async () => {
        const files = new Map<string, string>([
            [dir.resolve('summarize.md').toString(), 'custom summarize']
        ]);
        const service = new TestSkillService(dir, files, new Set([dir.toString()]));

        await service.seed();

        expect(files.get(dir.resolve('summarize.md').toString())).toBe('custom summarize');
        expect(files.get(dir.resolve('ui.md').toString())).toContain('trigger: /ui');
        expect(files.has(dir.resolve('.ui-seed-v1').toString())).toBe(true);
    });

    it('does not recreate ui.md after the once-only marker exists', async () => {
        const files = new Map<string, string>([
            [dir.resolve('summarize.md').toString(), 'custom summarize'],
            [dir.resolve('.ui-seed-v1').toString(), 'seeded\n']
        ]);
        const service = new TestSkillService(dir, files, new Set([dir.toString()]));

        await service.seed();

        expect(files.has(dir.resolve('ui.md').toString())).toBe(false);
    });

    it('does not recreate any seeded markdown after the marker exists and the user deleted all skills', async () => {
        const files = new Map<string, string>([
            [dir.resolve('.ui-seed-v1').toString(), 'seeded\n']
        ]);
        const service = new TestSkillService(dir, files, new Set([dir.toString()]));

        await service.seed();

        expect(files.has(dir.resolve('summarize.md').toString())).toBe(false);
        expect(files.has(dir.resolve('translate.md').toString())).toBe(false);
        expect(files.has(dir.resolve('ui.md').toString())).toBe(false);
    });
});
