// *****************************************************************************
// Pure ToolRequest factories for the file tools (PHASE1_DESIGN.md §7, M5 e-2).
//
// These build the read_file / write_file / edit_file ToolRequests (id, schema,
// description, handler) given a plain "file operations" backend. They are
// Theia-DI-free (they only touch @theia/ai-core's ToolRequest *type*, no browser
// runtime), so the tool shape and the handler routing/formatting are unit-tested
// in a plain node jest env - mirroring the arschat-agents common/ split.
//
// The browser ToolProviders (browser/*.ts) are thin @injectable wrappers that
// delegate getTool() to these, passing the FileService-backed
// ArschatFileToolsService as the FileToolBackend.
// *****************************************************************************

import type { ToolRequest } from '@theia/ai-core/lib/common/language-model';
import { ARSCHAT_TOOL_PROVIDER_NAME, READ_FILE_TOOL_ID, WRITE_FILE_TOOL_ID, EDIT_FILE_TOOL_ID } from './tool-ids';
import { EditFileParams, EditFileResult } from './edit-file';
import { parseToolArgs, toolError } from './tool-args';

/** The filesystem operations the tools need; implemented by ArschatFileToolsService. */
export interface FileToolBackend {
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<{ uri: string; created: boolean }>;
    editFile(path: string, params: EditFileParams): Promise<EditFileResult & { uri: string }>;
}

/**
 * Upper bound on how much file content read_file feeds back to the model. A giant
 * file would otherwise blow the context window; we truncate and mark it so the
 * model knows the content is incomplete. (Review nit from e-2; done in e-3.)
 */
export const READ_FILE_MAX_CHARS = 50_000;

/**
 * Human/LLM-facing warning shown on write_file / edit_file when the user is asked
 * to enable "always allow". Passed as the `confirmAlwaysAllow` string so Theia's
 * confirmation manager treats these tools as confirm-required (not ALWAYS_ALLOW)
 * and surfaces this text in the always-allow escalation. See PHASE1_DESIGN.md §5.
 */
export const WRITE_TOOL_CONFIRM_WARNING =
    'This tool writes to disk. Enabling auto-approval lets the assistant modify files without asking. '
    + 'Only enable this if you trust the current task.';

export function createReadFileTool(backend: FileToolBackend): ToolRequest {
    return {
        id: READ_FILE_TOOL_ID,
        name: READ_FILE_TOOL_ID,
        providerName: ARSCHAT_TOOL_PROVIDER_NAME,
        description: 'Read the full text content of a file. `path` may be absolute or relative to the '
            + 'workspace root. Returns the file content as a string, or an error if the file does not exist.',
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Path of the file to read (absolute, or relative to the workspace root).'
                }
            },
            required: ['path']
        },
        handler: async (argString: string) => {
            try {
                const { path } = parseToolArgs<{ path: string }>(argString);
                if (!path) {
                    return toolError('read_file requires a non-empty "path" argument.');
                }
                const content = await backend.readFile(path);
                if (content.length > READ_FILE_MAX_CHARS) {
                    return content.slice(0, READ_FILE_MAX_CHARS)
                        + `\n\n...(truncated: file is ${content.length} chars, showing first ${READ_FILE_MAX_CHARS})`;
                }
                return content;
            } catch (e) {
                return toolError(e instanceof Error ? e.message : String(e));
            }
        }
    };
}

export function createWriteFileTool(backend: FileToolBackend): ToolRequest {
    return {
        id: WRITE_FILE_TOOL_ID,
        name: WRITE_FILE_TOOL_ID,
        providerName: ARSCHAT_TOOL_PROVIDER_NAME,
        // e-3: write_file mutates the disk, so it is confirm-required. The string form
        // of confirmAlwaysAllow (a) forces Theia's ToolConfirmationManager into CONFIRM
        // mode instead of the default ALWAYS_ALLOW, so every call raises the ArsChat
        // approval card, and (b) is shown as the warning when the user enables
        // "always allow". See arschat-chat-widget.tsx (tool call cards).
        confirmAlwaysAllow: WRITE_TOOL_CONFIRM_WARNING,
        description: 'Write text content to a file, overwriting it if it already exists and creating '
            + 'parent folders as needed. `path` may be absolute or relative to the workspace root. '
            + 'Use edit_file for small in-place changes to an existing file.',
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Path of the file to write (absolute, or relative to the workspace root).'
                },
                content: {
                    type: 'string',
                    description: 'The full new content of the file.'
                }
            },
            required: ['path', 'content']
        },
        handler: async (argString: string) => {
            try {
                const { path, content } = parseToolArgs<{ path: string; content: string }>(argString);
                if (!path) {
                    return toolError('write_file requires a non-empty "path" argument.');
                }
                if (content === undefined) {
                    return toolError('write_file requires a "content" argument.');
                }
                const { uri, created } = await backend.writeFile(path, content);
                return `OK: ${created ? 'created' : 'overwrote'} ${uri} (${content.length} chars).`;
            } catch (e) {
                return toolError(e instanceof Error ? e.message : String(e));
            }
        }
    };
}

export function createEditFileTool(backend: FileToolBackend): ToolRequest {
    return {
        id: EDIT_FILE_TOOL_ID,
        name: EDIT_FILE_TOOL_ID,
        providerName: ARSCHAT_TOOL_PROVIDER_NAME,
        // e-3: edit_file mutates the disk, so it is confirm-required (see write_file above).
        confirmAlwaysAllow: WRITE_TOOL_CONFIRM_WARNING,
        description: 'Make an exact in-place edit to an existing file by replacing `oldString` with '
            + '`newString`. `oldString` must occur exactly once unless `replaceAll` is true. `path` may '
            + 'be absolute or relative to the workspace root.',
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Path of the file to edit (absolute, or relative to the workspace root).'
                },
                oldString: {
                    type: 'string',
                    description: 'The exact text to replace. Must be unique in the file unless replaceAll is true.'
                },
                newString: {
                    type: 'string',
                    description: 'The text to insert in place of oldString. Must differ from oldString.'
                },
                replaceAll: {
                    type: 'boolean',
                    description: 'Replace every occurrence of oldString instead of requiring a unique match. Defaults to false.'
                }
            },
            required: ['path', 'oldString', 'newString']
        },
        handler: async (argString: string) => {
            try {
                const { path, oldString, newString, replaceAll } =
                    parseToolArgs<{ path: string; oldString: string; newString: string; replaceAll?: boolean }>(argString);
                if (!path) {
                    return toolError('edit_file requires a non-empty "path" argument.');
                }
                if (oldString === undefined || newString === undefined) {
                    return toolError('edit_file requires both "oldString" and "newString" arguments.');
                }
                const result = await backend.editFile(path, { oldString, newString, replaceAll });
                if (!result.ok) {
                    return toolError(result.error ?? 'edit_file failed.');
                }
                return `OK: edited ${result.uri} (${result.replacements} replacement(s)).`;
            } catch (e) {
                return toolError(e instanceof Error ? e.message : String(e));
            }
        }
    };
}
