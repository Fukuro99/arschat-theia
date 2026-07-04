// Jest stub for @theia/ai-chat's browser chat-tool-preference-bindings module.
//
// The real module (ToolConfirmationManager) transitively imports @theia/core's
// browser DOM tree (hover-service.tsx etc.), which jest's node/jsdom transform
// cannot process because node_modules are transform-ignored. The ArschatChatWidget
// only needs the class as a DI *token* (its methods are stubbed via a constant
// binding in the test), so a bare class placeholder is sufficient here.
class ToolConfirmationManager {}
module.exports = { ToolConfirmationManager };
