// *****************************************************************************
// ArsChat <think> block parsing (PHASE1_DESIGN.md §5).
//
// The Theia AI stream parser only emits a `thinking` content part when the
// provider returns a native reasoning part (ThinkingResponsePart). Models that
// instead emit literal `<think>...</think>` tags inside their text (common with
// local / OpenAI-compatible models, and what the ArsChat mock model produces)
// arrive as ordinary markdown text. So ArsChat parses `<think>` tags itself in
// the widget, exactly like the old ArsChat MessageBubble did
// (src/renderer/components/MessageBubble.tsx parseThinkBlocks).
//
// Handles the streaming/partial-tag cases:
//   - complete <think>...</think> pairs (any number),
//   - an orphan closing </think> (opening tag arrived in an earlier chunk),
//   - an open <think> with no close yet (thinking still in progress).
// *****************************************************************************

export interface ParsedThink {
    /** Concatenated content of all completed think blocks. */
    thinking: string;
    /** The visible response text with think blocks removed. */
    response: string;
    /** True while a <think> is open but not yet closed (still streaming). */
    isThinkingInProgress: boolean;
}

export function parseThinkBlocks(content: string): ParsedThink {
    const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
    const thinkParts: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = thinkRegex.exec(content)) !== null) {
        const text = match[1].trim();
        if (text) {
            thinkParts.push(text);
        }
    }
    let afterClosed = content.replace(thinkRegex, '');

    const orphanClose = afterClosed.indexOf('</think>');
    if (orphanClose !== -1) {
        const orphanText = afterClosed.slice(0, orphanClose).trim();
        if (orphanText) {
            thinkParts.push(orphanText);
        }
        afterClosed = afterClosed.slice(orphanClose + '</think>'.length);
    }

    const openIdx = afterClosed.lastIndexOf('<think>');
    let response = afterClosed;
    if (openIdx !== -1) {
        response = afterClosed.slice(0, openIdx);
    }
    response = response.trim();

    return {
        thinking: thinkParts.join('\n\n'),
        response,
        isThinkingInProgress: openIdx !== -1
    };
}
