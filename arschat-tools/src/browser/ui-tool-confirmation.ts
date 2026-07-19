import { ToolConfirmationMode } from '@theia/ai-chat/lib/common/chat-tool-preferences';

export function shouldPromoteUiToolConfirmation(
    toolId: string,
    settings: Record<string, ToolConfirmationMode | undefined>
): boolean {
    const mode = settings[toolId] ?? settings['*'];
    return mode === ToolConfirmationMode.CONFIRM;
}
