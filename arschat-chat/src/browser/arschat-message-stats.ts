// *****************************************************************************
// ArsChat assistant message statistics (M6 e-25).
//
// Renders the token / speed / elapsed-time bar under a finished assistant message
// (old ArsChat MessageBubble.tsx §485-531). Two data sources:
//
//   - Token counts come from Theia's ChatResponseModel.tokenUsage
//     (ResponseTokenUsage { inputTokens, outputTokens }). The @theia/ai-anthropic
//     and @theia/ai-openai language models both yield a usage part which
//     AbstractChatAgent stores via response.setTokenUsage(); it is serialized with
//     the session, so restored turns keep their counts for free. OpenAI-compatible
//     providers (LM Studio / Unsloth) expose usage too when the server returns it.
//   - Elapsed time is measured by the widget around the request. Theia does NOT
//     persist it, so the widget keeps it in ArschatStatsStore keyed by request id.
//
// When usage is absent we fall back to a character-based token *approximation*
// (~4 chars/token). Per the M6 spec this is shown as a plain token count in the
// UI (no "approx" badge); the distinction is captured here in `tokenSource` for
// internal/testing purposes only.
// *****************************************************************************

export interface ResponseTokenUsageLike {
    readonly inputTokens: number;
    readonly outputTokens: number;
}

export interface MessageStats {
    /** Wall-clock seconds the response took, if measured. */
    durationSeconds?: number;
    /** input + output tokens (or the char-based approximation when usage is absent). */
    totalTokens?: number;
    /** Generation speed = output tokens / durationSeconds, when both are known. */
    tokensPerSec?: number;
    /** Where totalTokens came from - 'usage' (real) or 'approx' (char-based). Internal. */
    tokenSource: 'usage' | 'approx';
}

/** ~4 characters per token is a rough but serviceable heuristic for display. */
const CHARS_PER_TOKEN = 4;

/**
 * Compute the stats bar model for a finished assistant message.
 *
 * @param text        the assistant message text (used only for the approximation)
 * @param usage       response.tokenUsage, if the provider reported it
 * @param durationMs  measured elapsed time in ms, if known
 */
export function computeMessageStats(
    text: string,
    usage: ResponseTokenUsageLike | undefined,
    durationMs: number | undefined
): MessageStats {
    const durationSeconds = durationMs !== undefined && durationMs >= 0 ? durationMs / 1000 : undefined;

    let totalTokens: number | undefined;
    let outputTokens: number | undefined;
    let tokenSource: MessageStats['tokenSource'];

    if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
        outputTokens = usage.outputTokens;
        totalTokens = usage.inputTokens + usage.outputTokens;
        tokenSource = 'usage';
    } else {
        // Char-based approximation; treated as output tokens for the speed figure.
        outputTokens = text ? Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN)) : 0;
        totalTokens = outputTokens;
        tokenSource = 'approx';
    }

    const tokensPerSec = outputTokens && durationSeconds && durationSeconds > 0
        ? outputTokens / durationSeconds
        : undefined;

    return { durationSeconds, totalTokens: totalTokens || undefined, tokensPerSec, tokenSource };
}

/** True when there is anything worth rendering in the stats bar. */
export function hasDisplayableStats(stats: MessageStats): boolean {
    return stats.durationSeconds !== undefined
        || stats.totalTokens !== undefined
        || stats.tokensPerSec !== undefined;
}
