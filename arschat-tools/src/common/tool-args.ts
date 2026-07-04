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
