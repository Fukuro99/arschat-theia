// *****************************************************************************
// ArsChat tool identifiers (PHASE1_DESIGN.md §7, M5 e-2).
//
// Shared by the ToolProviders and the frontend module so the agent-wiring can
// resolve exactly these tools from the ToolInvocationRegistry by id.
// *****************************************************************************

export const ARSCHAT_TOOL_PROVIDER_NAME = 'arschat-file-tools';

export const READ_FILE_TOOL_ID = 'read_file';
export const WRITE_FILE_TOOL_ID = 'write_file';
export const EDIT_FILE_TOOL_ID = 'edit_file';

export const ARSCHAT_FILE_TOOL_IDS = [READ_FILE_TOOL_ID, WRITE_FILE_TOOL_ID, EDIT_FILE_TOOL_ID];
