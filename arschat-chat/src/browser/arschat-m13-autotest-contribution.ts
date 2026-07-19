// *****************************************************************************
// ArsChat M13 autotest: interactive UI tool real-path regression checks.
//
// Enabled only when ARSCHAT_M13_AUTOTEST=1 (read from the BACKEND env via
// EnvVariablesServer). It is a complete no-op otherwise.
//
// The mock LanguageModel drives the same request.tools path as a provider
// adapter: it emits a tool_call, invokes the wrapped ToolRequest handler with
// ToolInvocationContext.create(callId), then streams the tool result back as
// assistant text. UI tools intentionally bypass Theia confirmation, so the test
// resolves ArschatUiInteractionService from the actual rendered widget DOM.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { ApplicationShell, FrontendApplicationContribution, WidgetManager } from '@theia/core/lib/browser';
import { CancellationToken, ILogger } from '@theia/core';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import {
    AISettingsService,
    LanguageModel,
    LanguageModelRegistry,
    LanguageModelResponse,
    LanguageModelStatus,
    LanguageModelStreamResponsePart,
    ToolInvocationContext,
    ToolRequest,
    UserRequest
} from '@theia/ai-core';
import { ChatAgentService } from '@theia/ai-chat/lib/common/chat-agent-service';
import { ChatResponseModel, ToolCallChatResponseContent } from '@theia/ai-chat/lib/common/chat-model';
import { SkillService } from 'arschat-agents/lib/browser/skill-service';
import { ARSCHAT_CHAT_AGENT_ID, ARSCHAT_CHAT_PURPOSE } from 'arschat-providers/lib/browser/provider-switch-service';
import {
    ARSCHAT_BASE_TOOL_IDS,
    ARSCHAT_UI_TOOL_IDS,
    RENDER_HTML_TOOL_ID,
    RENDER_INTERACTIVE_HTML_TOOL_ID,
    RENDER_UI_TOOL_ID,
    UPDATE_UI_TOOL_ID
} from 'arschat-tools/lib/common/tool-ids';
import { ArschatUiInteractionService } from 'arschat-tools/lib/browser/arschat-ui-interaction-service';
import { ArschatChatWidget } from './arschat-chat-widget';
import { SANDBOX_CSP_CONTENT } from './interactive-ui/SandboxRenderer';

const AUTOTEST_ENV_VAR = 'ARSCHAT_M13_AUTOTEST';
const MOCK_MODEL_ID = 'arschat-mock/m13-interactive-ui';

interface ToolCallPlan {
    label: string;
    toolId: string;
    args: string;
    callId: string;
    beforeToolCallDelayMs?: number;
}

class ArschatM13MockLanguageModel implements LanguageModel {
    readonly id = MOCK_MODEL_ID;
    readonly name = 'ArsChat Mock (M13 interactive UI)';
    readonly vendor = 'ArsChat';
    readonly status: LanguageModelStatus = { status: 'ready' };

    readonly seenToolIdsByRequest: string[][] = [];
    readonly results = new Map<string, unknown>();
    plans: ToolCallPlan[] = [];

    constructor(protected readonly log: (message: string) => void) { }

    async request(request: UserRequest, cancellationToken?: CancellationToken): Promise<LanguageModelResponse> {
        const tools = (request.tools ?? []) as ToolRequest[];
        this.seenToolIdsByRequest.push(tools.map(tool => tool.id));
        const plan = this.plans.shift();
        const self = this;
        const stream: AsyncIterable<LanguageModelStreamResponsePart> = {
            async *[Symbol.asyncIterator](): AsyncIterator<LanguageModelStreamResponsePart> {
                if (!plan) {
                    yield { content: `M13_NO_TOOL tools=[${tools.map(tool => tool.id).join(',')}]` };
                    return;
                }
                const tool = tools.find(candidate => candidate.id === plan.toolId || candidate.name === plan.toolId);
                if (!tool) {
                    self.log(`[M13][autotest][mock] tool '${plan.toolId}' NOT present in request.tools `
                        + `(available=[${tools.map(candidate => candidate.id).join(', ')}])`);
                    yield { content: `M13_TOOL_MISSING ${plan.toolId}` };
                    return;
                }
                if (plan.beforeToolCallDelayMs) {
                    await self.delay(plan.beforeToolCallDelayMs);
                }
                if (cancellationToken?.isCancellationRequested) {
                    return;
                }
                self.log(`[M13][autotest][mock] emitting tool_call id='${plan.callId}' tool='${plan.toolId}'`);
                yield { tool_calls: [{ id: plan.callId, function: { name: plan.toolId, arguments: plan.args }, finished: false }] };
                try {
                    const result = await tool.handler(plan.args, ToolInvocationContext.create(plan.callId, cancellationToken));
                    self.results.set(plan.callId, result);
                    const text = JSON.stringify(result);
                    self.log(`[M13][autotest][mock] tool '${plan.toolId}' handler returned: ${text.slice(0, 240)}`);
                    yield { content: `M13_TOOL_RESULT ${plan.label}: ${text}` };
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    self.log(`[M13][autotest][mock] tool '${plan.toolId}' handler THREW: ${message}`);
                    yield { content: `M13_TOOL_ERROR ${plan.label}: ${message}` };
                }
            }
        };
        return { stream };
    }

    protected delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

@injectable()
export class ArschatM13AutotestContribution implements FrontendApplicationContribution {

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

    @inject(SkillService)
    protected readonly skillService!: SkillService;

    @inject(ArschatUiInteractionService)
    protected readonly uiInteractionService!: ArschatUiInteractionService;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    protected mock: ArschatM13MockLanguageModel | undefined;

    protected log(message: string): void {
        console.log(message);
        this.logger.info(message);
    }

    async onStart(): Promise<void> {
        const enabled = await this.getBackendEnv(AUTOTEST_ENV_VAR);
        if (enabled !== '1') {
            return;
        }
        this.mock = new ArschatM13MockLanguageModel(message => this.log(message));
        this.languageModelRegistry.addLanguageModels([this.mock]);
        this.log(`[M13][autotest] registered mock LanguageModel id='${MOCK_MODEL_ID}'`);
        setTimeout(() => this.run().catch(err => this.log(`[M13][autotest] fatal error ${err instanceof Error ? err.message : String(err)}`)), 17000);
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
        this.log('[M13][autotest] enabled (frontend)');
        await this.pointAgentAtMock();
        await this.skillService.ready();

        let pass = 0;
        let fail = 0;
        const tally = (ok: boolean) => { if (ok) { pass++; } else { fail++; } };

        tally(await this.scenarioDefaultFormRoundTrip());
        tally(await this.scenarioLiveRoundTripsAndFinished());
        tally(await this.scenarioRenderHtmlSandbox());
        tally(await this.scenarioNoUiToolsWithoutSkill());
        tally(await this.scenarioInteractiveHtmlRoundTrip());

        this.log(`[M13][autotest] SUMMARY: ${pass} PASS / ${fail} FAIL (of ${pass + fail} scenarios)`);
        this.log('[M13][autotest] done');
    }

    protected async scenarioDefaultFormRoundTrip(): Promise<boolean> {
        const widget = await this.prepareWidget('default-form');
        const mock = this.mock;
        if (!widget || !mock) {
            return false;
        }
        const callId = 'm13-form-1';
        mock.plans = [{
            label: 'default-form',
            toolId: RENDER_UI_TOOL_ID,
            callId,
            beforeToolCallDelayMs: 120,
            args: JSON.stringify({
                id: 'm13-form',
                mode: 'default',
                title: 'M13 Form',
                state: { form: { name: '' } },
                root: {
                    primitive: 'box',
                    props: { gap: 'sm' },
                    children: [
                        { primitive: 'text', props: { content: 'Name' } },
                        { primitive: 'input', bind: 'form.name', props: { inputId: 'm13-name-input', placeholder: 'Name' } }
                    ]
                },
                actions: [{ type: 'submit', label: 'Send', variant: 'primary' }]
            })
        }];

        const sendPromise = this.sendFromWidget(widget, '/ui render a small M13 form');
        const response = await this.waitForAssistantResponse(widget, 5000);
        let interactionNeeded = false;
        const sub = response?.onInteractionNeeded(content => {
            if (ToolCallChatResponseContent.is(content) && content.id === callId) {
                interactionNeeded = true;
            }
        });
        const input = await this.waitForElement<HTMLInputElement>(widget, '#m13-name-input', 10000);
        if (!input) {
            sub?.dispose();
            await this.abortWidget(widget, sendPromise);
            this.log('[M13][autotest] (a) /ui default form: input not rendered -> FAIL');
            return false;
        }
        this.setNativeValue(input, 'Ada-M13');
        const button = this.findButton(widget, 'Send');
        button?.click();
        const completed = await this.awaitSend(sendPromise, 10000);
        sub?.dispose();

        const resultText = JSON.stringify(mock.results.get(callId) ?? {});
        const resultReachedResponse = await this.waitFor(() => {
            const domText = widget.node.textContent ?? '';
            return domText.includes('M13_TOOL_RESULT default-form') && domText.includes('Ada-M13');
        }, 5000);
        const ok = completed && resultText.includes('Ada-M13') && resultReachedResponse && !interactionNeeded;
        this.log(`[M13][autotest] (a) /ui default form: inputRendered=true result=${resultText} `
            + `resultReachedResponse=${resultReachedResponse} onInteractionNeeded=${interactionNeeded} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected async scenarioLiveRoundTripsAndFinished(): Promise<boolean> {
        const widget = await this.prepareWidget('live-round-trips');
        const mock = this.mock;
        if (!widget || !mock) {
            return false;
        }
        const renderCallId = 'm13-live-render-1';
        const updateCallId = 'm13-live-update-1';
        const finishCallId = 'm13-live-finish-1';
        const liveBlock = {
            id: 'm13-live',
            mode: 'live',
            title: 'M13 Live',
            state: { step: 1 },
            root: {
                primitive: 'box',
                props: { gap: 'sm' },
                children: [
                    { primitive: 'text', props: { content: 'Step {state.step}' } },
                    { primitive: 'button', id: 'next-button', props: { label: 'Next', actionId: 'next', variant: 'primary' } }
                ]
            }
        };

        mock.plans = [{
            label: 'live-render',
            toolId: RENDER_UI_TOOL_ID,
            callId: renderCallId,
            beforeToolCallDelayMs: 120,
            args: JSON.stringify(liveBlock)
        }];
        const firstSend = this.sendFromWidget(widget, '/ui start an M13 live UI');
        const firstButton = await this.waitForButton(widget, 'Next', 10000);
        firstButton?.click();
        const firstCompleted = await this.awaitSend(firstSend, 10000);
        const firstResult = JSON.stringify(mock.results.get(renderCallId) ?? {});

        mock.plans = [{
            label: 'live-update',
            toolId: UPDATE_UI_TOOL_ID,
            callId: updateCallId,
            beforeToolCallDelayMs: 80,
            args: JSON.stringify({ ui_id: 'm13-live', patch: { step: 2 } })
        }];
        const secondSend = this.sendFromWidget(widget, 'continue the M13 live UI');
        const patched = await this.waitFor(() => (widget.node.textContent ?? '').includes('Step 2'), 5000);
        const secondButton = await this.waitForButton(widget, 'Next', 10000);
        secondButton?.click();
        const secondCompleted = await this.awaitSend(secondSend, 10000);
        const secondResult = JSON.stringify(mock.results.get(updateCallId) ?? {});

        mock.plans = [{
            label: 'live-finished',
            toolId: UPDATE_UI_TOOL_ID,
            callId: finishCallId,
            beforeToolCallDelayMs: 80,
            args: JSON.stringify({ ui_id: 'm13-live', patch: { status: 'finished' } })
        }];
        const finalSend = this.sendFromWidget(widget, 'finish the M13 live UI');
        const finalCompleted = await this.awaitSend(finalSend, 10000);
        const finishedDom = await this.waitFor(() => !!widget.node.querySelector('.iui-block-finished .iui-block-content-disabled'), 5000);
        const finalResult = JSON.stringify(mock.results.get(finishCallId) ?? {});
        const serviceFinished = this.uiInteractionService.isLiveFinished('m13-live');
        const twoRoundTrips = firstCompleted && secondCompleted && firstResult.includes('"action":"next"') && secondResult.includes('"action":"next"') && patched;
        const finalStatus = finalCompleted && finalResult.includes('"status":"finished"') && serviceFinished && finishedDom;
        const ok = twoRoundTrips && finalStatus;
        this.log(`[M13][autotest] (b) live mode: firstResult=${firstResult} secondResult=${secondResult} `
            + `patched=${patched} finalResult=${finalResult} serviceFinished=${serviceFinished} domDisabled=${finishedDom} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected async scenarioRenderHtmlSandbox(): Promise<boolean> {
        const widget = await this.prepareWidget('render-html');
        const mock = this.mock;
        if (!widget || !mock) {
            return false;
        }
        const callId = 'm13-html-1';
        const html = '<!doctype html><html><head><title>M13</title></head><body><main id="m13-html-root">Sandbox M13</main></body></html>';
        mock.plans = [{
            label: 'render-html',
            toolId: RENDER_HTML_TOOL_ID,
            callId,
            beforeToolCallDelayMs: 120,
            args: JSON.stringify({ id: 'm13-html', title: 'M13 HTML', html, height: '120px' })
        }];
        const sendPromise = this.sendFromWidget(widget, '/ui render sandbox html');
        const completed = await this.awaitSend(sendPromise, 10000);
        const iframe = await this.waitForElement<HTMLIFrameElement>(widget, '.arschat-ui-tool-card iframe', 5000);
        const blobHtml = await this.fetchIframeBlobHtml(iframe);
        const cspInjected = blobHtml.includes(SANDBOX_CSP_CONTENT)
            && blobHtml.indexOf('Content-Security-Policy') < blobHtml.indexOf('<title>M13</title>');
        const resultText = JSON.stringify(mock.results.get(callId) ?? {});
        const iframeOk = !!iframe && iframe.getAttribute('sandbox') === 'allow-scripts' && !!iframe.getAttribute('src')?.startsWith('blob:');
        const ok = completed && iframeOk && cspInjected && resultText.includes('"status":"rendered"');
        this.log(`[M13][autotest] (c) render_html sandbox: iframePresent=${!!iframe} `
            + `sandbox='${iframe?.getAttribute('sandbox') ?? '<none>'}' blobSrc=${!!iframe?.getAttribute('src')?.startsWith('blob:')} `
            + `cspInjected=${cspInjected} result=${resultText} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected async scenarioNoUiToolsWithoutSkill(): Promise<boolean> {
        const widget = await this.prepareWidget('no-ui-tools');
        const mock = this.mock;
        if (!widget || !mock) {
            return false;
        }
        mock.plans = [];
        const beforeCount = mock.seenToolIdsByRequest.length;
        const sendPromise = this.sendFromWidget(widget, 'plain request without slash skill');
        const completed = await this.awaitSend(sendPromise, 10000);
        const afterCount = mock.seenToolIdsByRequest.length;
        const requestReachedMock = afterCount > beforeCount;
        const tools = mock.seenToolIdsByRequest[beforeCount] ?? [];
        const missingBaseTools = ARSCHAT_BASE_TOOL_IDS.filter(id => !tools.includes(id));
        const stray = tools.filter(id => ARSCHAT_UI_TOOL_IDS.includes(id));
        const ok = completed && requestReachedMock && missingBaseTools.length === 0 && stray.length === 0;
        this.log(`[M13][autotest] (d) no skill gate: requestReachedMock=${requestReachedMock} `
            + `requestCount=${beforeCount}->${afterCount} baselinePresent=${missingBaseTools.length === 0} `
            + `missingBaseTools=[${missingBaseTools.join(', ')}] request.tools=[${tools.join(', ')}] `
            + `uiToolsPresent=[${stray.join(', ')}] -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected async scenarioInteractiveHtmlRoundTrip(): Promise<boolean> {
        const widget = await this.prepareWidget('interactive-html');
        const mock = this.mock;
        if (!widget || !mock) {
            return false;
        }
        const renderCallId = 'm13-interactive-html-render-1';
        const updateCallId = 'm13-interactive-html-update-1';
        const uiId = 'm13-interactive-html';
        const html = `<!doctype html>
<html>
<head><title>M13 Interactive</title></head>
<body>
  <button id="m13-html-action" type="button">Ping</button>
  <pre id="m13-html-log">ready</pre>
  <script>
    const uiId = ${JSON.stringify(uiId)};
    const send = (action, data) => window.parent.postMessage({ type: 'interactive-ui-action', uiId, action, data }, '*');
    document.getElementById('m13-html-action').addEventListener('click', () => send('button-click', { via: 'button' }));
    window.addEventListener('message', event => {
      if (!event.data || event.data.type !== 'interactive-ui-update' || event.data.uiId !== uiId) {
        return;
      }
      document.getElementById('m13-html-log').textContent = JSON.stringify(event.data.patch);
      setTimeout(() => send('patched', { patch: event.data.patch }), 100);
    });
    setTimeout(() => send('auto-ready', { via: 'iframe-script' }), 750);
  </script>
</body>
</html>`;

        mock.plans = [{
            label: 'interactive-html-render',
            toolId: RENDER_INTERACTIVE_HTML_TOOL_ID,
            callId: renderCallId,
            beforeToolCallDelayMs: 120,
            args: JSON.stringify({ id: uiId, title: 'M13 Interactive HTML', html, height: '140px' })
        }];
        const firstSend = this.sendFromWidget(widget, '/ui render interactive html');
        const iframe = await this.waitForElement<HTMLIFrameElement>(widget, '.arschat-ui-tool-card iframe', 5000);
        iframe?.contentWindow?.postMessage({ type: 'interactive-ui-action', uiId, action: 'spoofed', data: { rejected: true } }, '*');
        window.postMessage({ type: 'interactive-ui-action', uiId, action: 'spoofed-window', data: { rejected: true } }, '*');
        await this.delay(250);
        const directInjectionRejected = !mock.results.has(renderCallId);
        const firstCompleted = await this.awaitSend(firstSend, 10000);
        const firstResult = JSON.stringify(mock.results.get(renderCallId) ?? {});

        mock.plans = [{
            label: 'interactive-html-update',
            toolId: UPDATE_UI_TOOL_ID,
            callId: updateCallId,
            beforeToolCallDelayMs: 80,
            args: JSON.stringify({ ui_id: uiId, patch: { screen: 'after-update', count: 2 } })
        }];
        const secondSend = this.sendFromWidget(widget, 'patch the M13 interactive html');
        const secondCompleted = await this.awaitSend(secondSend, 10000);
        const secondResult = JSON.stringify(mock.results.get(updateCallId) ?? {});
        const iframeStillPresent = !!widget.node.querySelector('.arschat-ui-tool-card iframe');
        const firstOk = firstCompleted
            && firstResult.includes('"action":"auto-ready"')
            && firstResult.includes('"via":"iframe-script"')
            && !firstResult.includes('spoofed');
        const secondOk = secondCompleted
            && secondResult.includes('"action":"patched"')
            && secondResult.includes('"screen":"after-update"')
            && secondResult.includes('"count":2');
        const ok = !!iframe && iframe.getAttribute('sandbox') === 'allow-scripts' && directInjectionRejected && firstOk && secondOk && iframeStillPresent;
        this.log(`[M13][autotest] (e) interactive_html: iframePresent=${!!iframe} `
            + `sandbox='${iframe?.getAttribute('sandbox') ?? '<none>'}' directInjectionRejected=${directInjectionRejected} `
            + `firstResult=${firstResult} secondResult=${secondResult} iframeStillPresent=${iframeStillPresent} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected async fetchIframeBlobHtml(iframe: HTMLIFrameElement | undefined): Promise<string> {
        const src = iframe?.getAttribute('src');
        if (!src?.startsWith('blob:')) {
            return '';
        }
        try {
            return await fetch(src).then(response => response.text());
        } catch (e) {
            this.log(`[M13][autotest] failed to fetch iframe blob html: ${e instanceof Error ? e.message : String(e)}`);
            return '';
        }
    }

    protected async prepareWidget(label: string): Promise<ArschatChatWidget | undefined> {
        await this.pointAgentAtMock();
        const widget = await this.widgetManager.getWidget<ArschatChatWidget>(ArschatChatWidget.ID);
        if (!widget) {
            this.log(`[M13][autotest] ${label}: ArschatChatWidget not found -> FAIL`);
            return undefined;
        }
        await this.shell.activateWidget(ArschatChatWidget.ID).catch(() => { /* noop */ });
        const w = widget as unknown as { startNewSession: () => void };
        w.startNewSession();
        await this.delay(250);
        const uiExpansion = this.skillService.expandInput('/ui M13 probe');
        if (!uiExpansion) {
            this.log(`[M13][autotest] ${label}: /ui skill is not available (ui.md missing or failed to load)`);
        }
        return widget;
    }

    protected sendFromWidget(widget: ArschatChatWidget, text: string): Promise<void> {
        const w = widget as unknown as { inputValue: string; send: () => Promise<void> };
        w.inputValue = text;
        return w.send();
    }

    protected async abortWidget(widget: ArschatChatWidget, sendPromise: Promise<void>): Promise<void> {
        const w = widget as unknown as { abort: () => Promise<void> };
        await w.abort().catch(() => { /* noop */ });
        await this.awaitSend(sendPromise, 3000).catch(() => { /* noop */ });
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

    protected currentAssistantResponse(widget: ArschatChatWidget): ChatResponseModel | undefined {
        const messages = (widget as unknown as { messages?: Array<{ author?: string; response?: ChatResponseModel }> }).messages ?? [];
        return [...messages].reverse().find(message => message.author === 'assistant' && !!message.response)?.response;
    }

    protected async waitForAssistantResponse(widget: ArschatChatWidget, timeoutMs: number): Promise<ChatResponseModel | undefined> {
        await this.waitFor(() => !!this.currentAssistantResponse(widget), timeoutMs);
        return this.currentAssistantResponse(widget);
    }

    protected async waitForElement<T extends Element>(widget: ArschatChatWidget, selector: string, timeoutMs: number): Promise<T | undefined> {
        await this.waitFor(() => !!widget.node.querySelector(selector), timeoutMs);
        return widget.node.querySelector(selector) as T | null ?? undefined;
    }

    protected async waitForButton(widget: ArschatChatWidget, label: string, timeoutMs: number): Promise<HTMLButtonElement | undefined> {
        await this.waitFor(() => !!this.findButton(widget, label), timeoutMs);
        return this.findButton(widget, label);
    }

    protected findButton(widget: ArschatChatWidget, label: string): HTMLButtonElement | undefined {
        const buttons = Array.from(widget.node.querySelectorAll('button')) as HTMLButtonElement[];
        return buttons.find(button => button.textContent?.trim() === label && !button.disabled);
    }

    protected setNativeValue(input: HTMLInputElement, value: string): void {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    protected async awaitSend(sendPromise: Promise<void>, timeoutMs: number): Promise<boolean> {
        try {
            await Promise.race([
                sendPromise,
                this.delay(timeoutMs).then(() => {
                    throw new Error(`send did not complete within ${timeoutMs}ms`);
                })
            ]);
            return true;
        } catch (e) {
            this.log(`[M13][autotest] send wait failed: ${e instanceof Error ? e.message : String(e)}`);
            return false;
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
