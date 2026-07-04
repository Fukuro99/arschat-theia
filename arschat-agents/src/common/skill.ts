// *****************************************************************************
// ArsChat Skill domain type (PHASE1_DESIGN.md §6).
//
// A skill is a Markdown file with YAML frontmatter under
//   ${configDir}/arschat/skills/*.md
// The frontmatter carries `name` / `description` (and optionally `trigger`); the
// body after the frontmatter is the detailed instruction that gets expanded into
// the chat prompt when the user invokes the skill via a `/` slash command.
//
// Theia-independent so it can be shared / unit-tested.
// *****************************************************************************

export interface Skill {
    /** Stable id = the markdown filename without extension. */
    id: string;
    /** Human-facing name (frontmatter `name`). */
    name: string;
    /** One-line summary (frontmatter `description`). */
    description: string;
    /** Slash trigger, e.g. "/summarize". Defaults to `/${id}` when absent in frontmatter. */
    trigger: string;
    /** The instruction body (everything after the frontmatter) that gets expanded into the prompt. */
    body: string;
    /** Absolute path to the source markdown file (for editing / reload). */
    filePath: string;
}

/** Derive the display trigger for a skill given its id and an optional frontmatter override. */
export function skillTrigger(id: string, frontmatterTrigger?: unknown): string {
    const t = typeof frontmatterTrigger === 'string' ? frontmatterTrigger.trim() : '';
    if (t) {
        return t.startsWith('/') ? t : `/${t}`;
    }
    return `/${id}`;
}
