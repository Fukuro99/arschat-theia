// *****************************************************************************
// ArsChat skill markdown parser (PHASE1_DESIGN.md §6).
//
// Parses a skill Markdown file (YAML frontmatter + body) into a Skill. Uses the
// `gray-matter` library rather than the old app's hand-rolled YAML parser
// (skill-manager.ts `parseFrontmatter`), per §6 ("パーサは自前実装をやめ
// gray-matter 等の既存ライブラリに置換").
//
// gray-matter is a CommonJS module; this workspace's tsconfig has no
// esModuleInterop, so it is imported with `import matter = require(...)` (the
// same normalization the M3 markdown util uses for its CJS deps).
// *****************************************************************************

import matter = require('gray-matter');
import { Skill, skillTrigger } from './skill';

function parseTools(value: unknown): string[] {
    const values = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
    return values
        .map(v => typeof v === 'string' ? v.trim() : '')
        .filter(v => !!v);
}

/**
 * Parse one skill markdown document.
 * @param id       the skill id (filename without .md)
 * @param filePath absolute path to the source file
 * @param content  the raw file content
 * @returns the Skill, or undefined if `name`/`description` are missing.
 */
export function parseSkillMarkdown(id: string, filePath: string, content: string): Skill | undefined {
    let parsed: { data: Record<string, unknown>; content: string };
    try {
        parsed = matter(content) as unknown as { data: Record<string, unknown>; content: string };
    } catch {
        return undefined;
    }
    const data = parsed.data ?? {};
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    const description = typeof data.description === 'string' ? data.description.trim() : '';
    if (!name || !description) {
        return undefined;
    }
    return {
        id,
        name,
        description,
        trigger: skillTrigger(id, data.trigger),
        body: (parsed.content ?? '').trim(),
        tools: parseTools(data.tools),
        filePath
    };
}

/** Build a skill markdown file's content from fields (frontmatter + body). */
export function buildSkillMarkdown(fields: { name: string; description: string; trigger?: string; tools?: string[]; body: string }): string {
    let frontmatter = `name: ${fields.name}\ndescription: ${fields.description}`;
    if (fields.trigger) {
        frontmatter += `\ntrigger: ${fields.trigger}`;
    }
    if (fields.tools && fields.tools.length > 0) {
        frontmatter += '\ntools:';
        for (const tool of fields.tools) {
            frontmatter += `\n  - ${tool}`;
        }
    }
    return `---\n${frontmatter}\n---\n\n${fields.body}\n`;
}
