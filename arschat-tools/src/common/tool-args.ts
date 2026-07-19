// *****************************************************************************
// Small helpers shared by the file ToolProviders (M5 e-2).
//
// The language model passes tool arguments as a JSON string; parseToolArgs
// tolerates empty/invalid input by returning {}. toolError formats a uniform
// string result the LLM can read (ToolCallResult accepts plain strings).
// *****************************************************************************

export function parseToolArgs<T extends object = Record<string, unknown>>(argString: string | undefined): Partial<T> {
    if (!argString) {
        return {};
    }
    try {
        const parsed = JSON.parse(argString);
        return typeof parsed === 'object' && parsed !== null ? parsed as Partial<T> : {};
    } catch {
        return {};
    }
}

export function toolError(message: string): string {
    return `ERROR: ${message}`;
}

export class CancelledError extends Error {
    static readonly messageText = 'Chat request canceled';

    constructor(message = CancelledError.messageText) {
        super(message);
        this.name = 'CancelledError';
    }
}

export function isCancelledError(reason: unknown): boolean {
    if (reason instanceof CancelledError) {
        return true;
    }
    if (reason instanceof Error) {
        return reason.message === CancelledError.messageText || reason.name === 'CancelledError';
    }
    return reason === CancelledError.messageText;
}
