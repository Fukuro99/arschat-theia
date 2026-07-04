// *****************************************************************************
// ArsChat SkillService (PHASE1_DESIGN.md §6).
//
// Loads skills from `${configDir}/arschat/skills/*.md` (YAML frontmatter + body)
// via the gray-matter-based parser (skill-parser.ts), seeds two sample skills on
// first run (/summarize, /translate), and exposes:
//   - the skill catalogue (for the system-prompt skills section + the slash
//     completion popup);
//   - trigger matching + body expansion for the `/skill` slash-command UX.
//
// Reload: a public `reload()` (bound to a command / the header reload button) so
// edits to the .md files take effect without an app restart - see §6 item 4.
// We chose an explicit reload over a file watcher for implementation cost; the
// watcher path is a trivial future add (FileService.watch on the skills dir).
//
// Frontend-only: uses Theia's FileService (RPC) + EnvVariablesServer, matching
// PersonaService, so arschat-agents needs no custom backend.
// *****************************************************************************

import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Emitter, Event, ILogger, URI } from '@theia/core';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { Skill } from '../common/skill';
import { SkillSummary } from '../common/persona';
import { parseSkillMarkdown, buildSkillMarkdown } from '../common/skill-parser';
import { SkillCatalogProvider } from './persona-service';

/** The two sample skills seeded on first run. */
const SAMPLE_SKILLS: Array<{ id: string; name: string; description: string; trigger: string; body: string }> = [
    {
        id: 'summarize',
        name: '要約',
        description: '与えられたテキストを日本語で簡潔に要約する',
        trigger: '/summarize',
        body: [
            '# 要約スキル',
            '',
            '以下の指示に従って、ユーザーが提供したテキストを要約してください。',
            '',
            '## 手順',
            '1. テキスト全体を読み、主要な論点を把握する',
            '2. 重要なポイントを3〜5個の箇条書きで抽出する',
            '3. 最後に1〜2文の総括を加える',
            '',
            '## 出力形式',
            '- **要点**: 箇条書き',
            '- **総括**: 短い段落',
            '',
            '専門用語は必要に応じてかみ砕いて説明してください。'
        ].join('\n')
    },
    {
        id: 'translate',
        name: '翻訳',
        description: '与えられたテキストを自然な日本語⇄英語に翻訳する',
        trigger: '/translate',
        body: [
            '# 翻訳スキル',
            '',
            'ユーザーが提供したテキストを翻訳してください。',
            '',
            '## 手順',
            '1. 入力テキストの言語を判定する',
            '2. 日本語なら英語へ、それ以外なら日本語へ翻訳する',
            '3. 直訳ではなく、対象言語として自然な表現にする',
            '',
            '## 注意',
            '- 固有名詞・コード・URL は翻訳しない',
            '- 原文のトーン（丁寧/カジュアル）を保つ'
        ].join('\n')
    }
];

@injectable()
export class SkillService implements SkillCatalogProvider {

    @inject(EnvVariablesServer)
    protected readonly envServer!: EnvVariablesServer;

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    protected skills: Skill[] = [];
    protected loadingPromise: Promise<void> | undefined;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    /** Fired when the skill set is (re)loaded. */
    get onDidChange(): Event<void> {
        return this.onDidChangeEmitter.event;
    }

    @postConstruct()
    protected init(): void {
        this.loadingPromise = this.initialLoad();
    }

    async ready(): Promise<void> {
        if (this.loadingPromise) {
            await this.loadingPromise;
        }
    }

    // ---------------------------------------------------------------- storage

    protected async skillsDirUri(): Promise<URI> {
        const configDir = await this.envServer.getConfigDirUri();
        return new URI(configDir).resolve('arschat').resolve('skills');
    }

    protected async initialLoad(): Promise<void> {
        await this.seedIfEmpty();
        await this.reload();
    }

    protected async seedIfEmpty(): Promise<void> {
        try {
            const dir = await this.skillsDirUri();
            const dirExists = await this.fileService.exists(dir);
            let hasMd = false;
            if (dirExists) {
                const stat = await this.fileService.resolve(dir);
                hasMd = !!stat.children?.some(c => c.resource.path.ext === '.md');
            } else {
                await this.fileService.createFolder(dir);
            }
            if (!hasMd) {
                for (const s of SAMPLE_SKILLS) {
                    const uri = dir.resolve(`${s.id}.md`);
                    const content = buildSkillMarkdown({ name: s.name, description: s.description, trigger: s.trigger, body: s.body });
                    await this.fileService.write(uri, content);
                }
                this.logger.info(`[arschat-agents] seeded sample skills: ${SAMPLE_SKILLS.map(s => s.id).join(', ')}`);
            }
        } catch (e) {
            this.logger.warn(`[arschat-agents] failed to seed sample skills: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** Re-read every *.md in the skills dir. Public so a command / reload button can call it. */
    async reload(): Promise<void> {
        const loaded: Skill[] = [];
        try {
            const dir = await this.skillsDirUri();
            if (await this.fileService.exists(dir)) {
                const stat = await this.fileService.resolve(dir);
                for (const child of stat.children ?? []) {
                    if (child.isFile && child.resource.path.ext === '.md') {
                        const id = child.resource.path.name; // basename without ext
                        try {
                            const content = (await this.fileService.read(child.resource)).value;
                            const skill = parseSkillMarkdown(id, child.resource.path.toString(), content);
                            if (skill) {
                                loaded.push(skill);
                            }
                        } catch (e) {
                            this.logger.warn(`[arschat-agents] failed to parse skill '${id}': ${e instanceof Error ? e.message : String(e)}`);
                        }
                    }
                }
            }
        } catch (e) {
            this.logger.warn(`[arschat-agents] failed to reload skills: ${e instanceof Error ? e.message : String(e)}`);
        }
        loaded.sort((a, b) => a.trigger.localeCompare(b.trigger));
        this.skills = loaded;
        this.logger.info(`[arschat-agents] loaded ${loaded.length} skill(s): ${loaded.map(s => s.trigger).join(', ')}`);
        this.onDidChangeEmitter.fire();
    }

    // ---------------------------------------------------------------- queries

    getSkills(): Skill[] {
        return [...this.skills];
    }

    getSkillSummaries(): SkillSummary[] {
        return this.skills.map(s => ({ id: s.id, name: s.name, description: s.description, trigger: s.trigger }));
    }

    /** Skills whose trigger or name matches the given `/query` (used for the slash popup). */
    filterByQuery(query: string): Skill[] {
        const q = query.replace(/^\//, '').toLowerCase();
        return this.skills.filter(s => {
            const t = s.trigger.replace(/^\//, '').toLowerCase();
            return t.startsWith(q) || s.name.toLowerCase().includes(q);
        });
    }

    /** Find the skill whose trigger exactly matches the given token (e.g. "/summarize"). */
    matchTrigger(trigger: string): Skill | undefined {
        return this.skills.find(s => s.trigger === trigger || `/${s.id}` === trigger);
    }

    /**
     * Expand a raw input that starts with a skill trigger into the full prompt.
     * Returns { expanded, display } where `expanded` is the skill body (+ any
     * trailing user text) to send as ChatRequest.text, and `display` is the
     * original input to show as ChatRequest.displayText. Returns undefined when
     * the input is not a recognized skill invocation.
     */
    expandInput(input: string): { expanded: string; display: string } | undefined {
        if (!input.startsWith('/')) {
            return undefined;
        }
        const spaceIdx = input.indexOf(' ');
        const trigger = spaceIdx > 0 ? input.slice(0, spaceIdx) : input;
        const rest = spaceIdx > 0 ? input.slice(spaceIdx + 1).trim() : '';
        const skill = this.matchTrigger(trigger);
        if (!skill) {
            return undefined;
        }
        const expanded = skill.body + (rest ? `\n\n---\n\n${rest}` : '');
        return { expanded, display: input };
    }
}
