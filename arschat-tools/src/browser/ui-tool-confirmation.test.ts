import { ToolConfirmationMode } from '@theia/ai-chat/lib/common/chat-tool-preferences';
import { shouldPromoteUiToolConfirmation } from './ui-tool-confirmation';
import { RENDER_UI_TOOL_ID } from '../common/tool-ids';

describe('shouldPromoteUiToolConfirmation', () => {
    it('respects global disabled instead of overriding it with always allow', () => {
        expect(shouldPromoteUiToolConfirmation(RENDER_UI_TOOL_ID, {
            '*': ToolConfirmationMode.DISABLED
        })).toBe(false);
    });

    it('lets an explicit per-tool disabled setting override global confirm', () => {
        expect(shouldPromoteUiToolConfirmation(RENDER_UI_TOOL_ID, {
            '*': ToolConfirmationMode.CONFIRM,
            [RENDER_UI_TOOL_ID]: ToolConfirmationMode.DISABLED
        })).toBe(false);
    });

    it('promotes confirm-mode UI tools to always allow so custom forms can resolve', () => {
        expect(shouldPromoteUiToolConfirmation(RENDER_UI_TOOL_ID, {
            '*': ToolConfirmationMode.CONFIRM
        })).toBe(true);
    });

    it('does not write an override when there is no effective confirm setting', () => {
        expect(shouldPromoteUiToolConfirmation(RENDER_UI_TOOL_ID, {})).toBe(false);
    });
});
