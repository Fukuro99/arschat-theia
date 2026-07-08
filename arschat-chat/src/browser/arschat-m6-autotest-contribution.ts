// *****************************************************************************
// ArsChat M6 autotest (PHASE1_DESIGN.md §9 M6, task e-26 "検証").
//
// Enabled only when ARSCHAT_M6_AUTOTEST=1 (read from the BACKEND env via
// EnvVariablesServer, because the renderer's process.env is shimmed empty - see
// the M3/M5 autotests). Completely no-op otherwise.
//
// It verifies the five M6 "見た目" features end-to-end in the REAL renderer
// (real DOM, real marked/highlight.js/KaTeX, the live chat widget), mirroring the
// [M5] autotest structure and emitting a PASS/FAIL SUMMARY on stdout so a headless
// run can be judged from the log:
//
//   1. 再希釈 (menu bar): the top-level menu bar carries File/Edit/View/Help and
//      NOT Run/Selection/Go/Terminal (queried from MenuModelRegistry).
//   2. 再希釈 (activity bar): no IDE side view (SCM/debug/test/search/explorer/
//      extensions/outline) and no stock @theia/ai-chat-ui chat view are docked in
//      the left/right side panels (queried from ApplicationShell). This also
//      detects a stale persisted layout that restored an IDE view the filter was
//      meant to suppress (the e-21 "永続レイアウトの罠").
//   3. ハイライト: renderMarkdown() emits hljs token spans for ts/python/rust
//      fenced code blocks.
//   4. KaTeX: renderMarkdown() emits `.katex` elements for $...$ and $$...$$.
//   5. アクションボタン + 6. 統計バー: drive a real streaming round-trip through the
//      live ArschatChatWidget (a mock LanguageModel + the ArsChat agent, as in M3),
//      then assert the finished assistant message rendered its hover action bar
//      (and that クリック → navigator.clipboard.writeText fires) and its stats bar
//      (the mock emits a usage part, so the bar shows real usage numbers).
//
// All logs use the [M6] prefix.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { ApplicationShell, FrontendApplicationContribution, WidgetManager } from '@theia/core/lib/browser';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { CancellationToken, ILogger, MAIN_MENU_BAR, MenuModelRegistry } from '@theia/core';
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
import { renderMarkdown } from './arschat-markdown';

const MOCK_MODEL_ID = 'arschat-mock/m6-view-driver';

/**
 * The fixed reply the mock streams: a Markdown answer with a fenced code block
 * and both inline/block math, so the live round-trip also exercises the
 * highlight + KaTeX render paths in the real widget (not just the direct
 * renderMarkdown() checks). Ends with a usage part so the stats bar shows real
 * (mock) token counts.
 */
const MOCK_CHUNKS: string[] = [
    '# 見た目テスト\n\n',
    'これは **ArsChat** M6 検証のモック応答です。\n\n',
    '```ts\nconst answer: number = 42;\n```\n\n',
    'インライン数式 $E = mc^2$ とブロック数式:\n\n',
    '$$\\int_0^1 x\\,dx = \\frac{1}{2}$$\n'
];

/** A minimal streaming LanguageModel used only for the M6 live-widget check. */
class ArschatM6MockLanguageModel implements LanguageModel {
    readonly id = MOCK_MODEL_ID;
    readonly name = 'ArsChat Mock (M6 view driver)';
    readonly vendor = 'ArsChat';
    readonly status: LanguageModelStatus = { status: 'ready' };

    async request(_request: UserRequest, cancellationToken?: CancellationToken): Promise<LanguageModelResponse> {
        const stream: AsyncIterable<LanguageModelStreamResponsePart> = {
            async *[Symbol.asyncIterator](): AsyncIterator<LanguageModelStreamResponsePart> {
                for (const c of MOCK_CHUNKS) {
                    if (cancellationToken?.isCancellationRequested) {
                        return;
                    }
                    await new Promise(resolve => setTimeout(resolve, 30));
                    yield { content: c };
                }
                // Final usage part -> AbstractChatAgent calls response.setTokenUsage(),
                // so the stats bar renders real (mock) input/output token numbers.
                yield { input_tokens: 42, output_tokens: 128 };
            }
        };
        return { stream };
    }
}

@injectable()
export class ArschatM6AutotestContribution implements FrontendApplicationContribution {

    @inject(EnvVariablesServer)
    protected readonly envServer!: EnvVariablesServer;

    @inject(MenuModelRegistry)
    protected readonly menuRegistry!: MenuModelRegistry;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

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
        const enabled = await this.getBackendEnv('ARSCHAT_M6_AUTOTEST');
        if (enabled !== '1') {
            return;
        }
        this.languageModelRegistry.addLanguageModels([new ArschatM6MockLanguageModel()]);
        this.log(`[M6][autotest] registered mock LanguageModel id='${MOCK_MODEL_ID}'`);
        // Let the workbench + agents + layout settle before inspecting/driving.
        setTimeout(() => this.run().catch(err => this.log(`[M6][autotest] fatal error ${err instanceof Error ? err.message : String(err)}`)), 16000);
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
        this.log('[M6][autotest] enabled (frontend)');

        let pass = 0;
        let fail = 0;
        const tally = (ok: boolean) => { if (ok) { pass++; } else { fail++; } };

        tally(this.scenarioMenuBar());
        tally(this.scenarioActivityBar());
        tally(this.scenarioHighlight());
        tally(this.scenarioKatex());
        const live = await this.scenarioLiveWidget();
        tally(live.actions);
        tally(live.stats);

        this.log(`[M6][autotest] SUMMARY: ${pass} PASS / ${fail} FAIL (of ${pass + fail} checks)`);
        this.log('[M6][autotest] done');
    }

    // ---------------------------------------------------------------- (1) menu bar
    protected scenarioMenuBar(): boolean {
        const menu = this.menuRegistry.getMenu(MAIN_MENU_BAR);
        const labels = (menu?.children ?? [])
            .map(c => (c as { label?: string }).label)
            .filter((l): l is string => typeof l === 'string' && l.length > 0);
        const has = (name: string): boolean => labels.some(l => l.toLowerCase() === name.toLowerCase());
        const expectedPresent = ['File', 'Edit', 'View', 'Help'];
        const expectedAbsent = ['Run', 'Selection', 'Go', 'Terminal'];
        const present = expectedPresent.filter(has);
        const strays = expectedAbsent.filter(has);
        const ok = present.length === expectedPresent.length && strays.length === 0;
        this.log(`[M6][autotest] (1) 再希釈/menu bar: labels=[${labels.join(', ')}] `
            + `present=[${present.join(', ')}] (${present.length}/${expectedPresent.length}) strays=[${strays.join(', ')}] -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    // ---------------------------------------------------------------- (2) activity bar
    protected scenarioActivityBar(): boolean {
        const sideIds = [
            ...this.shell.getWidgets('left').map(w => w.id),
            ...this.shell.getWidgets('right').map(w => w.id)
        ];
        // Substrings that only an IDE side view (or the stock AI chat view) would carry.
        // ArsChat's own views are id-prefixed `arschat-` and are excluded.
        const idePatterns = [
            'scm', 'debug', 'test', 'search-in-workspace', 'navigator', 'explorer',
            'files', 'vsx', 'extension', 'outline', 'chat-view-widget'
        ];
        const strays = sideIds.filter(id =>
            !id.startsWith('arschat') && idePatterns.some(p => id.toLowerCase().includes(p)));
        const arschatViews = sideIds.filter(id => id.startsWith('arschat'));
        const ok = strays.length === 0;
        this.log(`[M6][autotest] (2) 再希釈/activity bar: sidePanelWidgets=[${sideIds.join(', ')}] `
            + `arschatViews=[${arschatViews.join(', ')}] strayIdeViews=[${strays.join(', ')}] -> ${ok ? 'PASS' : 'FAIL'}`);
        if (!ok) {
            this.log('[M6][autotest] (2) NOTE: stray IDE/stock-chat views are docked despite the dilution filter '
                + '(likely a stale persisted layout - see e-21 永続レイアウトの罠).');
        }
        return ok;
    }

    // ---------------------------------------------------------------- (3) highlight
    protected scenarioHighlight(): boolean {
        const samples: Array<{ lang: string; code: string }> = [
            { lang: 'ts', code: 'const x: number = 1;\nfunction greet(name: string): string { return name; }' },
            { lang: 'python', code: 'def add(a, b):\n    return a + b' },
            { lang: 'rust', code: 'fn main() { let x: i32 = 1; println!("{}", x); }' }
        ];
        const results = samples.map(({ lang, code }) => {
            const html = renderMarkdown('```' + lang + '\n' + code + '\n```');
            const hasHljs = html.includes('class="hljs');
            const hasToken = /<span class="hljs-[a-z0-9-]+"/.test(html);
            return { lang, ok: hasHljs && hasToken };
        });
        const ok = results.every(r => r.ok);
        this.log(`[M6][autotest] (3) ハイライト: ${results.map(r => `${r.lang}=${r.ok ? 'ok' : 'NO'}`).join(' ')} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    // ---------------------------------------------------------------- (4) KaTeX
    protected scenarioKatex(): boolean {
        const inlineHtml = renderMarkdown('質量エネルギー等価: $E = mc^2$');
        const blockHtml = renderMarkdown('$$\\int_0^1 x\\,dx = \\frac{1}{2}$$');
        const inlineOk = inlineHtml.includes('class="katex"');
        const blockOk = blockHtml.includes('class="katex"');
        const ok = inlineOk && blockOk;
        this.log(`[M6][autotest] (4) KaTeX: inline=${inlineOk ? 'ok' : 'NO'} block=${blockOk ? 'ok' : 'NO'} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    // ---------------------------------------------------- (5)+(6) live widget: actions + stats
    protected async scenarioLiveWidget(): Promise<{ actions: boolean; stats: boolean }> {
        await this.pointAgentAtMock();
        const widget = await this.widgetManager.getWidget<ArschatChatWidget>(ArschatChatWidget.ID);
        if (!widget) {
            this.log('[M6][autotest] (5/6) live widget: ArschatChatWidget not found -> FAIL');
            return { actions: false, stats: false };
        }
        await this.shell.activateWidget(ArschatChatWidget.ID).catch(() => { /* noop */ });

        // Drive one real round-trip through the widget's own send() pipeline.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = widget as any;
        try {
            w.startNewSession();
            w.inputValue = 'M6 見た目検証: コード例と数式を見せて';
            await w.send();
        } catch (e) {
            this.log(`[M6][autotest] (5/6) live widget: send() threw -> FAIL (${e instanceof Error ? e.message : String(e)})`);
            return { actions: false, stats: false };
        }
        // Let the final React repaint (rAF) flush.
        await this.delay(400);

        const root = widget.node;
        const actionsBar = root.querySelector('.arschat-message-actions');
        const statsBar = root.querySelector('.arschat-message-stats');

        // Copy: spy navigator.clipboard.writeText, click the copy button, assert it fired
        // with the message text (per e-26: writeText call check is acceptable).
        let copiedText: string | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const clip = navigator.clipboard as any;
        const originalWriteText = clip?.writeText?.bind(clip);
        if (clip) {
            clip.writeText = async (t: string): Promise<void> => { copiedText = t; };
        }
        const copyButton = actionsBar?.querySelector('button') as HTMLElement | null;
        copyButton?.click();
        await this.delay(80);
        if (clip && originalWriteText) {
            clip.writeText = originalWriteText;
        }

        const copyOk = typeof copiedText === 'string' && copiedText.length > 0;
        const actionsOk = !!actionsBar && !!copyButton && copyOk;
        const statsOk = !!statsBar;
        this.log(`[M6][autotest] (5) アクションボタン: actionBarRendered=${!!actionsBar} copyButtonPresent=${!!copyButton} `
            + `clipboardWriteTextFired=${copyOk} -> ${actionsOk ? 'PASS' : 'FAIL'}`);
        this.log(`[M6][autotest] (6) 統計バー: statsBarRendered=${!!statsBar}${statsBar ? ` text='${(statsBar.textContent ?? '').trim()}'` : ''} -> ${statsOk ? 'PASS' : 'FAIL'}`);
        return { actions: actionsOk, stats: statsOk };
    }

    /** Point the ArsChat agent at the mock model (both paths, per M2 §10 analysis). */
    protected async pointAgentAtMock(): Promise<void> {
        const requirement = { purpose: ARSCHAT_CHAT_PURPOSE, identifier: MOCK_MODEL_ID };
        await this.settingsService.updateAgentSettings(ARSCHAT_CHAT_AGENT_ID, { languageModelRequirements: [requirement] });
        const agent = this.chatAgentService.getAgent(ARSCHAT_CHAT_AGENT_ID) as
            { languageModelRequirements?: Array<{ purpose: string; identifier?: string }> } | undefined;
        if (agent) {
            agent.languageModelRequirements = [requirement];
        }
    }

    protected delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
