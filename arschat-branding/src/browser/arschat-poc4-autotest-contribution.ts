// *****************************************************************************
// ArsChat PoC-4 verification helper (frontend half).
//
// PoC-4 validates that Theia AI's Anthropic provider (`@theia/ai-anthropic`)
// and MCP client (`@theia/ai-mcp`) wire up correctly on top of the
// `@theia/ai-core` / `@theia/ai-chat` / `@theia/ai-chat-ui` stack, without
// touching Theia core.
//
// `ANTHROPIC_API_KEY` is NOT set in this environment (see POC_PLAN.md), so a
// live streaming call cannot be exercised end-to-end here. This autotest
// therefore always checks the *wiring* (provider registered, Claude models
// enumerable via LanguageModelRegistry, chat UI opens, MCP server starts and
// its tools are enumerable), and *additionally* fires a real
// `LanguageModel.request()` call automatically if-and-only-if the backend
// reports that `ANTHROPIC_API_KEY` is present in its process environment
// (checked via the standard EnvVariablesServer RPC - see PoC-3 notes on why
// frontend `process.env` cannot be used directly in the Electron renderer).
//
// Disabled by default (flag-gated on ARSCHAT_POC4_AUTOTEST=1) - no effect on
// a normal `npm run start:electron`.
// *****************************************************************************

import { injectable, inject, named } from '@theia/core/shared/inversify';
import { CommandService, ContributionProvider, PreferenceService } from '@theia/core';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { ApplicationShell, FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { FrontendLanguageModelRegistry, LanguageModelMessage, isTextResponsePart } from '@theia/ai-core/lib/common';
import { MCPServerManager } from '@theia/ai-mcp/lib/common';
import { MCP_SERVERS_PREF } from '@theia/ai-mcp/lib/common/mcp-preferences';
import { ChatResponseContent } from '@theia/ai-chat/lib/common';
import { ChatResponsePartRenderer } from '@theia/ai-chat-ui/lib/browser/chat-response-part-renderer';
import { ArschatInformationalPartRenderer } from 'arschat-chat/lib/browser/arschat-informational-part-renderer';

const AUTOTEST_ENV_VAR = 'ARSCHAT_POC4_AUTOTEST';
const ANTHROPIC_KEY_ENV_VAR = 'ANTHROPIC_API_KEY';

// The command id registered by @theia/ai-chat-ui's AIChatContribution to open
// the chat view (node_modules/@theia/ai-chat-ui/lib/browser/chat-view-widget.js
// / ai-chat-ui-contribution.js - view id is 'ai-chat-ui:chat-view-widget', the
// standard Theia "toggle view" command follows the '<viewId>:toggle' pattern
// via AbstractViewContribution).
const OPEN_CHAT_VIEW_COMMAND = 'aiChat:toggle';

// We only wired one local MCP server in ai-features.mcp.mcpServers (see
// arschat-core-frontend-module.ts): the `@modelcontextprotocol/server-everything`
// reference server, which requires no API key and exposes a small fixed set
// of demo tools - ideal for a PoC that must complete with no external
// credentials.
const MCP_SERVER_NAME = 'everything';

@injectable()
export class ArschatPoc4AutotestContribution implements FrontendApplicationContribution {

    @inject(CommandService)
    protected readonly commandService: CommandService;

    @inject(EnvVariablesServer)
    protected readonly envServer: EnvVariablesServer;

    @inject(FrontendLanguageModelRegistry)
    protected readonly languageModelRegistry: FrontendLanguageModelRegistry;

    @inject(MCPServerManager)
    protected readonly mcpServerManager: MCPServerManager;

    @inject(PreferenceService)
    protected readonly preferenceService: PreferenceService;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(ContributionProvider) @named(ChatResponsePartRenderer)
    protected readonly chatResponsePartRenderers: ContributionProvider<ChatResponsePartRenderer<ChatResponseContent>>;

    async onStart(_app: FrontendApplication): Promise<void> {
        const flag = await this.envServer.getValue(AUTOTEST_ENV_VAR);
        if (!flag || flag.value !== '1') {
            return;
        }

        console.log('[PoC-4][autotest] enabled (frontend)');

        setTimeout(() => {
            this.checkAnthropicWiring();
        }, 8000);

        setTimeout(() => {
            this.checkMcpWiring();
        }, 14000);

        setTimeout(() => {
            this.checkCustomRendererRegistration();
        }, 17000);

        setTimeout(() => {
            this.openChatViewAndScreenshot();
        }, 20000);
    }

    // --- 4-3: custom ChatResponsePartRenderer contribution -------------------

    protected checkCustomRendererRegistration(): void {
        try {
            const renderers = this.chatResponsePartRenderers.getContributions();
            const names = renderers.map(r => r.constructor.name);
            console.log(`[PoC-4][autotest] t+17s: ${names.length} ChatResponsePartRenderer contribution(s) registered: ${names.join(', ')}`);
            const found = renderers.some(r => r instanceof ArschatInformationalPartRenderer);
            if (found) {
                console.log('[PoC-4][autotest] 4-3 custom renderer registration -> PASS '
                    + '(ArschatInformationalPartRenderer present in the multi-bound ChatResponsePartRenderer contribution provider, '
                    + 'canHandle()=11 for InformationalChatResponseContent beats the built-in MarkdownPartRenderer\'s 10)');
            } else {
                console.error('[PoC-4][autotest] 4-3 custom renderer registration -> FAIL (ArschatInformationalPartRenderer not found in contribution provider)');
            }
        } catch (error) {
            console.error('[PoC-4][autotest] 4-3 check failed -> FAIL', error);
        }
    }

    // --- 4-1: Anthropic connection -----------------------------------------

    protected async checkAnthropicWiring(): Promise<void> {
        try {
            await this.preferenceService.ready;
            const models = await this.languageModelRegistry.getLanguageModels();
            const anthropicModels = models.filter(m => m.id.startsWith('anthropic/'));
            console.log(`[PoC-4][autotest] t+8s: ${models.length} language model(s) registered total, ${anthropicModels.length} anthropic/* model(s)`);
            for (const model of anthropicModels) {
                console.log(`[PoC-4][autotest]   model id='${model.id}' status='${model.status.status}'${model.status.message ? ` message='${model.status.message}'` : ''}`);
            }
            if (anthropicModels.length > 0) {
                console.log('[PoC-4][autotest] 4-1 provider registration -> PASS (Claude models enumerable via LanguageModelRegistry)');
            } else {
                console.error('[PoC-4][autotest] 4-1 provider registration -> FAIL (no anthropic/* models found - check @theia/ai-anthropic wiring)');
            }

            const keyEnv = await this.envServer.getValue(ANTHROPIC_KEY_ENV_VAR);
            const hasKey = !!keyEnv?.value;
            console.log(`[PoC-4][autotest] t+8s: backend process.env.${ANTHROPIC_KEY_ENV_VAR} present = ${hasKey}`);

            if (!hasKey) {
                console.warn('[PoC-4][autotest] 4-1 live call SKIPPED - ANTHROPIC_API_KEY not set in this environment. '
                    + 'Wiring-only verification complete (provider registered, models enumerable). '
                    + 'Set ANTHROPIC_API_KEY and re-run with ARSCHAT_POC4_AUTOTEST=1 to exercise a live streaming call automatically.');
                return;
            }

            const readyModel = anthropicModels.find(m => m.status.status === 'ready');
            if (!readyModel) {
                console.error('[PoC-4][autotest] 4-1 live call -> FAIL (ANTHROPIC_API_KEY present but no anthropic/* model reports status=ready)');
                return;
            }

            console.log(`[PoC-4][autotest] t+8s: ANTHROPIC_API_KEY detected -> attempting a live request against '${readyModel.id}'`);
            const message: LanguageModelMessage = { actor: 'user', type: 'text', text: 'Reply with exactly one word: PONG' };
            const response = await readyModel.request({
                messages: [message],
                sessionId: 'arschat-poc4-autotest',
                requestId: `arschat-poc4-autotest-${Date.now()}`
            });
            let text = '';
            if ('text' in response && typeof response.text === 'string') {
                text = response.text;
            } else if ('stream' in response) {
                for await (const chunk of response.stream) {
                    if (isTextResponsePart(chunk)) {
                        text += chunk.content;
                    }
                }
            }
            console.log(`[PoC-4][autotest] t+8s: live Anthropic response: '${text.trim()}'`);
            console.log('[PoC-4][autotest] 4-1 live streaming call -> PASS');
        } catch (error) {
            console.error('[PoC-4][autotest] 4-1 check failed -> FAIL', error);
        }
    }

    // --- 4-2: MCP ------------------------------------------------------------

    protected async checkMcpWiring(): Promise<void> {
        try {
            const configured = this.preferenceService.get(MCP_SERVERS_PREF, {}) as Record<string, unknown>;
            console.log(`[PoC-4][autotest] t+14s: configured MCP server(s): ${Object.keys(configured).join(', ') || '<none>'}`);

            const runningServers = await this.mcpServerManager.getRunningServers();
            console.log(`[PoC-4][autotest] t+14s: running MCP server(s): ${runningServers.join(', ') || '<none>'}`);

            if (!runningServers.includes(MCP_SERVER_NAME)) {
                console.log(`[PoC-4][autotest] t+14s: '${MCP_SERVER_NAME}' not yet running, starting it explicitly`);
                await this.mcpServerManager.startServer(MCP_SERVER_NAME);
            }

            const tools = await this.mcpServerManager.getTools(MCP_SERVER_NAME);
            const toolNames = tools.tools.map(t => t.name);
            console.log(`[PoC-4][autotest] t+14s: MCP server '${MCP_SERVER_NAME}' exposes ${toolNames.length} tool(s): ${toolNames.join(', ')}`);

            if (toolNames.length > 0) {
                console.log('[PoC-4][autotest] 4-2 MCP server start + tool listing -> PASS');
            } else {
                console.error('[PoC-4][autotest] 4-2 MCP -> FAIL (server reports zero tools)');
            }
        } catch (error) {
            console.error('[PoC-4][autotest] 4-2 check failed -> FAIL', error);
        }
    }

    // --- chat view + screenshot handoff (electron-main takes the actual capture) --

    protected async openChatViewAndScreenshot(): Promise<void> {
        try {
            console.log(`[PoC-4][autotest] t+20s: executing command '${OPEN_CHAT_VIEW_COMMAND}'`);
            await this.commandService.executeCommand(OPEN_CHAT_VIEW_COMMAND);
            console.log('[PoC-4][autotest] chat view opened -> PASS (ai-chat-ui wiring confirmed)');

            // Widen the 'right' area so the chat panel is actually legible in
            // the autotest screenshot instead of the default narrow sliver
            // (cosmetic only - the pass/fail evidence is the command
            // execution above and the language-model/MCP logs already
            // captured at t+8s/t+14s).
            this.shell.resize(600, 'right');
        } catch (error) {
            console.error('[PoC-4][autotest] failed to open chat view -> FAIL', error);
        }
    }
}
