// *****************************************************************************
// ArsChat PersonaService (PHASE1_DESIGN.md §6).
//
// Persona CRUD + persistence + active-persona tracking + system-prompt
// composition. This is the persona half of arschat-agents.
//
// Persistence: a single JSON file `${configDir}/arschat/personas.json` of shape
//   { personas: Persona[], activePersonaId: string }
// read/written via Theia's frontend FileService (RPC to the backend fs), so the
// whole extension stays frontend-only (no custom backend service needed). The
// configDir is resolved from EnvVariablesServer.getConfigDirUri() = the same
// global scope the chat SessionStore uses (workspace-independent).
//
// On first run, a default persona (persona.ts DEFAULT_PERSONA) is seeded and
// made active.
//
// The composed system prompt (composeSystemPrompt) is consumed by the ArsChat
// chat agent's getSystemMessageDescription(): switching the active persona (or
// editing it) changes the system prompt of every subsequent send with no
// restart, because the agent reads getActiveEffectiveSystemPrompt() at request
// time.
// *****************************************************************************

import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Emitter, Event, ILogger, URI } from '@theia/core';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { Persona, DEFAULT_PERSONA, SkillSummary, composeSystemPrompt } from '../common/persona';

interface PersonaStoreShape {
    personas: Persona[];
    activePersonaId: string;
}

/** Provides the skills catalogue to inject into the composed system prompt. */
export const SkillCatalogProvider = Symbol('SkillCatalogProvider');
export interface SkillCatalogProvider {
    getSkillSummaries(): SkillSummary[];
}

@injectable()
export class PersonaService {

    @inject(EnvVariablesServer)
    protected readonly envServer!: EnvVariablesServer;

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    /** Optional: set by SkillService so composed prompts include the skills section. */
    protected skillCatalog: SkillCatalogProvider | undefined;

    protected personas: Persona[] = [];
    protected activePersonaId = DEFAULT_PERSONA.id;
    protected loaded = false;
    protected loadingPromise: Promise<void> | undefined;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    /** Fired whenever the persona set or the active persona changes. */
    get onDidChange(): Event<void> {
        return this.onDidChangeEmitter.event;
    }

    @postConstruct()
    protected init(): void {
        this.loadingPromise = this.load();
    }

    /** SkillService injects itself here so composed prompts carry the skills catalogue. */
    setSkillCatalog(provider: SkillCatalogProvider): void {
        this.skillCatalog = provider;
    }

    async ready(): Promise<void> {
        if (this.loadingPromise) {
            await this.loadingPromise;
        }
    }

    // ---------------------------------------------------------------- storage

    protected async configFileUri(): Promise<URI> {
        const configDir = await this.envServer.getConfigDirUri();
        return new URI(configDir).resolve('arschat').resolve('personas.json');
    }

    protected async load(): Promise<void> {
        try {
            const uri = await this.configFileUri();
            if (await this.fileService.exists(uri)) {
                const content = (await this.fileService.read(uri)).value;
                const parsed = JSON.parse(content) as Partial<PersonaStoreShape>;
                this.personas = Array.isArray(parsed.personas) ? parsed.personas.filter(p => p && p.id && p.name) : [];
                this.activePersonaId = typeof parsed.activePersonaId === 'string' ? parsed.activePersonaId : DEFAULT_PERSONA.id;
            }
        } catch (e) {
            this.logger.warn(`[arschat-agents] failed to read personas.json: ${e instanceof Error ? e.message : String(e)}`);
        }
        // Seed the default persona on first run (or if the file was empty/corrupt).
        if (this.personas.length === 0) {
            this.personas = [{ ...DEFAULT_PERSONA }];
            this.activePersonaId = DEFAULT_PERSONA.id;
            await this.persist();
            this.logger.info('[arschat-agents] seeded default persona');
        }
        // Repair a dangling activePersonaId.
        if (!this.personas.some(p => p.id === this.activePersonaId)) {
            this.activePersonaId = this.personas[0].id;
        }
        this.loaded = true;
    }

    protected async persist(): Promise<void> {
        try {
            const uri = await this.configFileUri();
            const dir = uri.parent;
            if (!(await this.fileService.exists(dir))) {
                await this.fileService.createFolder(dir);
            }
            const shape: PersonaStoreShape = { personas: this.personas, activePersonaId: this.activePersonaId };
            await this.fileService.write(uri, JSON.stringify(shape, null, 2));
        } catch (e) {
            this.logger.warn(`[arschat-agents] failed to write personas.json: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // ---------------------------------------------------------------- queries

    getPersonas(): Persona[] {
        return [...this.personas];
    }

    getActivePersonaId(): string {
        return this.activePersonaId;
    }

    getActivePersona(): Persona | undefined {
        return this.personas.find(p => p.id === this.activePersonaId) ?? this.personas[0];
    }

    /** The composed system prompt for the currently active persona (skills catalogue included). */
    getActiveEffectiveSystemPrompt(): string {
        const persona = this.getActivePersona();
        if (!persona) {
            return '';
        }
        const skills: SkillSummary[] = this.skillCatalog?.getSkillSummaries() ?? [];
        return composeSystemPrompt(persona, skills);
    }

    // ---------------------------------------------------------------- mutations

    async setActivePersona(id: string): Promise<void> {
        if (!this.personas.some(p => p.id === id)) {
            return;
        }
        this.activePersonaId = id;
        await this.persist();
        this.onDidChangeEmitter.fire();
    }

    async createPersona(fields: { name: string; systemPrompt: string; avatarPath?: string | null }): Promise<Persona> {
        const persona: Persona = {
            id: this.generateId(fields.name),
            name: fields.name,
            systemPrompt: fields.systemPrompt,
            avatarPath: fields.avatarPath ?? null
        };
        this.personas.push(persona);
        await this.persist();
        this.onDidChangeEmitter.fire();
        return persona;
    }

    async updatePersona(id: string, fields: { name?: string; systemPrompt?: string; avatarPath?: string | null }): Promise<Persona | undefined> {
        const persona = this.personas.find(p => p.id === id);
        if (!persona) {
            return undefined;
        }
        if (fields.name !== undefined) {
            persona.name = fields.name;
        }
        if (fields.systemPrompt !== undefined) {
            persona.systemPrompt = fields.systemPrompt;
        }
        if (fields.avatarPath !== undefined) {
            persona.avatarPath = fields.avatarPath;
        }
        await this.persist();
        this.onDidChangeEmitter.fire();
        return persona;
    }

    async deletePersona(id: string): Promise<void> {
        if (this.personas.length <= 1) {
            // Never delete the last persona (there must always be an active one).
            return;
        }
        this.personas = this.personas.filter(p => p.id !== id);
        if (this.activePersonaId === id) {
            this.activePersonaId = this.personas[0].id;
        }
        await this.persist();
        this.onDidChangeEmitter.fire();
    }

    protected generateId(name: string): string {
        const base = name
            .toLowerCase()
            .replace(/[^\w぀-ヿ一-鿿]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40) || 'persona';
        let id = base;
        let counter = 1;
        while (this.personas.some(p => p.id === id)) {
            id = `${base}-${counter++}`;
        }
        return id;
    }
}
