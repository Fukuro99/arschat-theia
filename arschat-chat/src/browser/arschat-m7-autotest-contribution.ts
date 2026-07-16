// *****************************************************************************
// ArsChat M7/MS8 autotest: edit / continue / branch live DOM checks.
//
// Enabled only when ARSCHAT_M7_AUTOTEST=1. This mirrors the M6 autotest shape:
// register a mock LanguageModel, drive the real ArschatChatWidget in the renderer,
// click the actual hover action buttons, and emit a SUMMARY line with [M7] prefix.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { CancellationToken, ILogger } from '@theia/core';
import {
    AISettingsService,
    LanguageModel,
    LanguageModelRegistry,
    LanguageModelResponse,
    LanguageModelStreamResponsePart,
    LanguageModelStatus,
    UserRequest
} from '@theia/ai-core';
import { ChatAgentService } from '@theia/ai-chat/lib/common/chat-agent-service';
import { ARSCHAT_CHAT_AGENT_ID, ARSCHAT_CHAT_PURPOSE } from 'arschat-providers/lib/browser/provider-switch-service';
import { ArschatChatWidget } from './arschat-chat-widget';

const MOCK_MODEL_ID = 'arschat-mock/m7-edit-continue-branch';

class ArschatM7MockLanguageModel implements LanguageModel {
    readonly id = MOCK_MODEL_ID;
    readonly name = 'ArsChat Mock (M7 edit/continue/branch)';
    readonly vendor = 'ArsChat';
    readonly status: LanguageModelStatus = { status: 'ready' };

    async request(request: UserRequest, cancellationToken?: CancellationToken): Promise<LanguageModelResponse> {
        const messages = typeof request === 'string' ? undefined : (request as { messages?: Array<{ content?: unknown }> }).messages;
        const prompt = typeof request === 'string'
            ? request
            : String(messages && messages.length > 0 ? messages[messages.length - 1].content ?? 'request' : 'request');
        const chunks = [`M7 mock answer: ${prompt.slice(0, 80)}`];
        const stream: AsyncIterable<LanguageModelStreamResponsePart> = {
            async *[Symbol.asyncIterator](): AsyncIterator<LanguageModelStreamResponsePart> {
                for (const c of chunks) {
                    if (cancellationToken?.isCancellationRequested) {
                        return;
                    }
                    await new Promise(resolve => setTimeout(resolve, 20));
                    yield { content: c };
                }
                yield { input_tokens: 8, output_tokens: 12 };
            }
        };
        return { stream };
    }
}

@injectable()
export class ArschatM7AutotestContribution implements FrontendApplicationContribution {

    @inject(EnvVariablesServer)
    protected readonly envServer!: EnvVariablesServer;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    @inject(LanguageModelRegistry)
    protected readonly languageModelRegistry!: LanguageModelRegistry;

    @inject(AISettingsService)
    protected readonly settingsService!: AISettingsService;

    @inject(ChatAgentService)
    protected readonly chatAgentService!: ChatAgentService;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    protected log(message: string): void {
        console.log(message);
        this.logger.info(message);
    }

    async onStart(): Promise<void> {
        const enabled = await this.getBackendEnv('ARSCHAT_M7_AUTOTEST');
        if (enabled !== '1') {
            return;
        }
        this.languageModelRegistry.addLanguageModels([new ArschatM7MockLanguageModel()]);
        this.log(`[M7][autotest] registered mock LanguageModel id='${MOCK_MODEL_ID}'`);
        setTimeout(() => this.run().catch(err => this.log(`[M7][autotest] fatal error ${err instanceof Error ? err.message : String(err)}`)), 16000);
    }

    protected async getBackendEnv(key: string): Promise<string | undefined> {
        try {
            const v = await this.envServer.getValue(key);
            return v?.value;
        } catch {
            return undefined;
        }
    }

    protected async run(): Promise<void> {
        this.log('[M7][autotest] enabled (frontend)');
        let pass = 0;
        let fail = 0;
        const tally = (ok: boolean) => { if (ok) { pass++; } else { fail++; } };

        tally(await this.scenarioEdit());
        tally(await this.scenarioContinue());
        tally(await this.scenarioBranch());

        this.log(`[M7][autotest] SUMMARY: ${pass} PASS / ${fail} FAIL (of ${pass + fail} checks)`);
        this.log('[M7][autotest] done');
    }

    protected async scenarioEdit(): Promise<boolean> {
        const widget = await this.prepareWidget('M7 edit scenario');
        if (!widget) {
            return false;
        }
        const root = widget.node;
        const edit = root.querySelector('.arschat-chat-message-assistant .arschat-message-action-edit') as HTMLElement | null;
        edit?.click();
        await this.delay(80);
        const ta = root.querySelector('.arschat-message-edit-textarea') as HTMLTextAreaElement | null;
        const save = root.querySelector('.arschat-message-edit-save') as HTMLElement | null;
        if (!ta || !save) {
            this.log('[M7][autotest] edit: textarea/save missing -> FAIL');
            return false;
        }
        const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        valueSetter?.call(ta, 'M7 edited assistant answer');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        await this.delay(40);
        save.click();
        await this.delay(160);
        const text = root.textContent ?? '';
        const ok = text.includes('M7 edited assistant answer') && !root.querySelector('.arschat-message-edit-textarea');
        this.log(`[M7][autotest] edit: editedTextRendered=${text.includes('M7 edited assistant answer')} editClosed=${!root.querySelector('.arschat-message-edit-textarea')} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected async scenarioContinue(): Promise<boolean> {
        const widget = await this.prepareWidget('M7 continue scenario');
        if (!widget) {
            return false;
        }
        const root = widget.node;
        const before = root.querySelectorAll('.arschat-chat-message').length;
        const cont = root.querySelector('.arschat-chat-message-assistant .arschat-message-action-continue') as HTMLElement | null;
        cont?.click();
        await this.waitFor(() => root.querySelectorAll('.arschat-chat-message').length > before, 5000);
        const text = root.textContent ?? '';
        const ok = text.includes('続けてください') && root.querySelectorAll('.arschat-chat-message').length >= before + 2;
        this.log(`[M7][autotest] continue: promptInserted=${text.includes('続けてください')} messageCount=${root.querySelectorAll('.arschat-chat-message').length} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected async scenarioBranch(): Promise<boolean> {
        const widget = await this.prepareWidget('M7 branch scenario');
        if (!widget) {
            return false;
        }
        const root = widget.node;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = widget as any;
        const beforeSessionId = w.sessionId;
        const branch = root.querySelector('.arschat-chat-message-assistant .arschat-message-action-branch') as HTMLElement | null;
        branch?.click();
        await this.waitFor(() => !!w.sessionId && w.sessionId !== beforeSessionId, 5000);
        const ok = !!beforeSessionId && !!w.sessionId && w.sessionId !== beforeSessionId && !!root.textContent?.includes('M7 branch scenario');
        this.log(`[M7][autotest] branch: before=${beforeSessionId ?? '<none>'} after=${w.sessionId ?? '<none>'} switched=${!!w.sessionId && w.sessionId !== beforeSessionId} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected async prepareWidget(prompt: string): Promise<ArschatChatWidget | undefined> {
        await this.pointAgentAtMock();
        const widget = await this.widgetManager.getWidget<ArschatChatWidget>(ArschatChatWidget.ID);
        if (!widget) {
            this.log(`[M7][autotest] ${prompt}: ArschatChatWidget not found -> FAIL`);
            return undefined;
        }
        await this.shell.activateWidget(ArschatChatWidget.ID).catch(() => { /* noop */ });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = widget as any;
        w.startNewSession();
        w.inputValue = prompt;
        await w.send();
        await this.delay(400);
        return widget;
    }

    protected async pointAgentAtMock(): Promise<void> {
        const requirement = { purpose: ARSCHAT_CHAT_PURPOSE, identifier: MOCK_MODEL_ID };
        await this.settingsService.updateAgentSettings(ARSCHAT_CHAT_AGENT_ID, { languageModelRequirements: [requirement] });
        const agent = this.chatAgentService.getAgent(ARSCHAT_CHAT_AGENT_ID) as
            { languageModelRequirements?: Array<{ purpose: string; identifier?: string }> } | undefined;
        if (agent) {
            agent.languageModelRequirements = [requirement];
        }
    }

    protected async waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            if (predicate()) {
                return true;
            }
            await this.delay(100);
        }
        return predicate();
    }

    protected delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
