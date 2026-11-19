import { inject, injectable } from '@theia/core/shared/inversify';
import { PreferenceService } from '@theia/core';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { ChatService } from '@theia/ai-chat/lib/common/chat-service';
import { ChatAgentService } from '@theia/ai-chat/lib/common/chat-agent-service';
import { CliAgentService } from '../common/cli-agents';
import { readCliSettings } from './cli-agent-preferences';
import { ProviderSwitchService, ARSCHAT_CHAT_AGENT_ID } from './provider-switch-service';

@injectable()
export class CliAgentAutotestContribution implements FrontendApplicationContribution {
    @inject(EnvVariablesServer) protected readonly envServer!: EnvVariablesServer;
    @inject(PreferenceService) protected readonly preferences!: PreferenceService;
    @inject(ProviderSwitchService) protected readonly switchService!: ProviderSwitchService;
    @inject(CliAgentService) protected readonly cliService!: CliAgentService;
    @inject(ChatService) protected readonly chatService!: ChatService;
    @inject(ChatAgentService) protected readonly agents!: ChatAgentService;

    async onStart(): Promise<void> {
        if ((await this.envServer.getValue('ARSCHAT_CLI_AGENTS_AUTOTEST'))?.value !== '1') { return; }
        setTimeout(() => void this.run(), 10000);
    }
    protected log(message: string): void { console.log(`[CLI-AGENTS][autotest] ${message}`); }
    protected async run(): Promise<void> {
        let pass = 0, fail = 0;
        const previous = this.switchService.getActiveProvider();
        const previousModel = this.switchService.getActiveModel();
        try {
            await this.preferences.ready;
            const settings = readCliSettings((key, fallback) => this.preferences.get(key, fallback));
            for (const scenario of [
                { kind: 'codex-cli' as const, name: 'codex-pong', prompt: 'Reply with exactly: PONG', expected: 'PONG' },
                { kind: 'codex-cli' as const, name: 'codex-japanese', prompt: '日本の首都を漢字2文字で', expected: '東京' },
                { kind: 'claude-code-cli' as const, name: 'claude-pong-or-key-required', prompt: 'Reply with exactly: PONG', expected: 'PONG' }
            ]) {
                try {
                    const check = await this.cliService.check(scenario.kind, settings);
                    const selection = await this.switchService.setActive(scenario.kind);
                    if (selection?.modelId !== scenario.kind) { throw new Error('selection'); }
                    const expected = scenario.kind === 'claude-code-cli' && check.keyAvailable === false ? 'API キーが必要' : scenario.expected;
                    const reply = await this.roundTrip(scenario.prompt, (settings.timeoutMinutes + 1) * 60000);
                    if (!reply.includes(expected)) { throw new Error('response'); }
                    pass++; this.log(`${scenario.name}: PASS`);
                } catch { fail++; this.log(`${scenario.name}: FAIL`); }
            }
        } catch { fail++; this.log('setup: FAIL'); }
        finally {
            try { await this.switchService.setActive(previous, previousModel); } catch { fail++; this.log('restore: FAIL'); }
            this.log(`SUMMARY ${pass} PASS / ${fail} FAIL`);
        }
    }
    protected async roundTrip(prompt: string, timeoutMs: number): Promise<string> {
        const session = this.chatService.createSession(undefined, { focus: false }, this.agents.getAgent(ARSCHAT_CHAT_AGENT_ID));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const invocation = await this.chatService.sendRequest(session.id, { text: prompt });
            if (!invocation) { throw new Error('No invocation'); }
            const response = await Promise.race([invocation.responseCompleted, new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Timeout')), timeoutMs);
            })]);
            if (response.isError || response.isCanceled) { throw new Error('Failed response'); }
            return response.response.content.map(c => c.asString?.() ?? '').join('');
        } finally { if (timer) { clearTimeout(timer); } }
    }
}
