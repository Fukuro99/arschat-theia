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

// MS13: interactive UI tools are registered globally but only attached to the
// ArsChat agent when a skill frontmatter declares them (the built-in /ui skill).
export const RENDER_UI_TOOL_ID = 'arschat_render_ui';
export const UPDATE_UI_TOOL_ID = 'arschat_update_ui';
export const RENDER_HTML_TOOL_ID = 'arschat_render_html';
export const RENDER_INTERACTIVE_HTML_TOOL_ID = 'arschat_render_interactive_html';

/** Every ArsChat AI tool id the frontend module resolves and attaches to the agent. */
export const ARSCHAT_ALL_TOOL_IDS = [
    ...ARSCHAT_FILE_TOOL_IDS,
    RUN_COMMAND_TOOL_ID,
    WEB_SEARCH_TOOL_ID,
    FETCH_PAGE_TOOL_ID
];

/** M5 baseline tools that stay available without a skill gate. */
export const ARSCHAT_BASE_TOOL_IDS = [...ARSCHAT_ALL_TOOL_IDS];

/** Interactive UI tools exposed only by skill frontmatter. */
export const ARSCHAT_UI_TOOL_IDS = [
    RENDER_UI_TOOL_ID,
    UPDATE_UI_TOOL_ID,
    RENDER_HTML_TOOL_ID,
    RENDER_INTERACTIVE_HTML_TOOL_ID
];
