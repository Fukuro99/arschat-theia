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

// M5 e-4: run_command is a *backend* (node-spawned) tool. It is confirm-required
// (confirmAlwaysAllow) like the write tools. Its id is tracked separately so the
// frontend module can register it alongside ARSCHAT_FILE_TOOL_IDS.
export const RUN_COMMAND_TOOL_ID = 'run_command';

// M5 e-5: web_search / fetch_page are *backend* (node fetch + Turndown) tools.
// Unlike run_command they are read-only (network read, no local mutation), so
// they carry NO confirmAlwaysAllow and run unconfirmed like read_file.
export const WEB_SEARCH_TOOL_ID = 'web_search';
export const FETCH_PAGE_TOOL_ID = 'fetch_page';

/** Every ArsChat AI tool id the frontend module resolves and attaches to the agent. */
export const ARSCHAT_ALL_TOOL_IDS = [
    ...ARSCHAT_FILE_TOOL_IDS,
    RUN_COMMAND_TOOL_ID,
    WEB_SEARCH_TOOL_ID,
    FETCH_PAGE_TOOL_ID
];
