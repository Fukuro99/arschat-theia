// *****************************************************************************
// ArsChat edit_file core logic (PHASE1_DESIGN.md §7, M5 e-2).
//
// Theia-free, pure string transformation so it can be unit-tested without any
// DI container / filesystem (mirrors arschat-agents/common/skill-parser.ts).
// The Theia-wired EditFileToolProvider (browser/) reads the file via FileService,
// calls applyEdit(), and writes the result back.
//
// Semantics (deliberately close to the familiar "exact string replace" edit tool
// contract):
//   - `oldString` must occur in the content. If it does not -> error.
//   - When `replaceAll` is false (default), `oldString` must be UNIQUE, otherwise
//     the edit is ambiguous and is rejected (safer than silently editing the
//     first match).
//   - `newString` must differ from `oldString`.
// *****************************************************************************

export interface EditFileParams {
    oldString: string;
    newString: string;
    replaceAll?: boolean;
}

export interface EditFileResult {
    /** true if the edit succeeded and `content` holds the new file content. */
    ok: boolean;
    /** The transformed content (only meaningful when ok === true). */
    content: string;
    /** Number of occurrences replaced (0 when ok === false). */
    replacements: number;
    /** Human-readable error message when ok === false. */
    error?: string;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
    if (needle.length === 0) {
        return 0;
    }
    let count = 0;
    let from = 0;
    for (;;) {
        const idx = haystack.indexOf(needle, from);
        if (idx === -1) {
            break;
        }
        count++;
        from = idx + needle.length;
    }
    return count;
}

/**
 * Apply an exact-string edit to `content`. Pure function; performs no I/O.
 */
export function applyEdit(content: string, params: EditFileParams): EditFileResult {
    const { oldString, newString, replaceAll = false } = params;

    if (oldString.length === 0) {
        return { ok: false, content, replacements: 0, error: 'oldString must not be empty.' };
    }
    if (oldString === newString) {
        return { ok: false, content, replacements: 0, error: 'newString must differ from oldString.' };
    }

    const occurrences = countOccurrences(content, oldString);
    if (occurrences === 0) {
        return { ok: false, content, replacements: 0, error: 'oldString was not found in the file.' };
    }
    if (occurrences > 1 && !replaceAll) {
        return {
            ok: false,
            content,
            replacements: 0,
            error: `oldString is not unique (found ${occurrences} occurrences). `
                + 'Provide a longer, unambiguous oldString, or set replaceAll=true to replace every occurrence.'
        };
    }

    let next: string;
    let replacements: number;
    if (replaceAll) {
        next = content.split(oldString).join(newString);
        replacements = occurrences;
    } else {
        const idx = content.indexOf(oldString);
        next = content.slice(0, idx) + newString + content.slice(idx + oldString.length);
        replacements = 1;
    }

    return { ok: true, content: next, replacements };
}
