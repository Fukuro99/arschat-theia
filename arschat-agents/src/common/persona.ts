// *****************************************************************************
// ArsChat Persona domain type + system-prompt composition (PHASE1_DESIGN.md §6).
//
// Ported (logic only, Theia-independent) from the old ArsChat
// src/shared/types.ts:
//   - the `Persona` interface;
//   - the persona branch of `getEffectiveSystemPrompt()` (the 130-line composer)
//     reduced to the parts that are in scope for M4: the persona name prefix, the
//     persona's own system prompt, the injected skills catalogue section, and the
//     current-date-time tag. The file-browser / open-files / code-editor / memory
//     sections of the old composer belong to later phases (tools = M5, memory =
//     Phase 2) and are intentionally NOT carried over here.
//
// This module has NO Theia imports so it can be unit-tested in isolation and
// reused from both the frontend agent and the persona-management UI.
// *****************************************************************************

/** A named AI persona: a system prompt plus presentation metadata. */
export interface Persona {
    id: string;
    name: string;
    systemPrompt: string;
    /** Optional avatar image path / data URL. Kept for parity with the old app; unused by the composer. */
    avatarPath: string | null;
}

/** Minimal skill descriptor used when composing the skills catalogue section. */
export interface SkillSummary {
    id: string;
    name: string;
    description: string;
    /** display trigger, e.g. "/summarize" */
    trigger: string;
}

/** Return the current date/time as `[yyyy:MM:DD;hh:mm]` (ported from the old app). */
export function currentDateTimeTag(now: Date = new Date()): string {
    const yyyy = now.getFullYear();
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const DD = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return `[${yyyy}:${MM}:${DD};${hh}:${mm}]`;
}

/**
 * Build the "## あなたが持つスキル" section injected into the system prompt.
 * Ported from `getEffectiveSystemPrompt` in the old app (the skills-catalogue
 * branch). Returns '' when there are no skills.
 */
export function composeSkillsSection(skills: SkillSummary[]): string {
    if (!skills || skills.length === 0) {
        return '';
    }
    const rows = skills.map(s => `| ${s.trigger} | ${s.name} | ${s.description} |`).join('\n');
    return (
        '\n\n## あなたが持つスキル\n\n' +
        'ユーザーは入力欄で `/` に続けてスキル名を打つことでスキルを起動できます。' +
        'スキルが起動されるとその詳細な指示があなたのメッセージとして展開されます。\n\n' +
        '| トリガー | 名前 | 概要 |\n' +
        '|----------|------|------|\n' +
        rows
    );
}

/**
 * Compose the effective system prompt for a persona (ported from the persona
 * branch of the old `getEffectiveSystemPrompt`). Format:
 *
 *   あなたの名前は「<name>」です。
 *
 *   <persona.systemPrompt>
 *   <skills section>
 *
 *   現在日時: <tag>
 */
export function composeSystemPrompt(persona: Persona, skills: SkillSummary[] = [], now: Date = new Date()): string {
    const namePrefix = `あなたの名前は「${persona.name}」です。\n\n`;
    const skillsSection = composeSkillsSection(skills);
    return namePrefix + persona.systemPrompt + skillsSection + `\n\n現在日時: ${currentDateTimeTag(now)}`;
}

/** The default persona seeded on first run (mirrors the old app's DEFAULT_SETTINGS.systemPrompt). */
export const DEFAULT_PERSONA: Persona = {
    id: 'default',
    name: 'ArsChat',
    systemPrompt:
        'あなたはArsChat（アリスチャット）という名前のAIアシスタントです。' +
        'ユーザーの質問に丁寧かつ的確に日本語で回答してください。' +
        'コードを含む回答にはマークダウンを使用してください。',
    avatarPath: null
};
