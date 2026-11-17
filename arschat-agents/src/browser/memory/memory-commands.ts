import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, MessageService, PreferenceScope, PreferenceService, QuickPickService } from '@theia/core';
import { QuickInputService } from '@theia/core/lib/browser/quick-input/quick-input-service';
import { ArschatMemoryService } from './memory-service';

@injectable()
export class ArschatMemoryCommands implements CommandContribution {
    @inject(ArschatMemoryService) protected readonly memory!: ArschatMemoryService;
    @inject(PreferenceService) protected readonly preferences!: PreferenceService;
    @inject(QuickInputService) protected readonly input!: QuickInputService;
    @inject(QuickPickService) protected readonly pick!: QuickPickService;
    @inject(MessageService) protected readonly messages!: MessageService;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand({ id: 'arschat-memory:search', label: 'ArsChat: ユーザーメモリを検索' }, {
            execute: async () => {
                const query = await this.input.input({ prompt: 'ユーザーメモリを検索' });
                if (!query?.trim()) { return; }
                const facts = await this.memory.recall(query, 20);
                await this.pick.show(facts.map(fact => ({ label: fact.fact, description: `${fact.valid_at?.slice(0, 10) || '日付不明'}、${fact.status || '不明'}` })),
                    { placeholder: facts.length ? 'ユーザーメモリ (読み取り専用)' : '該当する記憶はありません' });
            }
        });
        commands.registerCommand({ id: 'arschat-memory:toggle-auto-save', label: 'ArsChat: ユーザーメモリの自動保存を切り替え' }, {
            execute: async () => {
                const enabled = !this.preferences.get('arschat.memory.autoSave', true);
                await this.preferences.set('arschat.memory.autoSave', enabled, PreferenceScope.User);
                await this.messages.info(`ユーザーメモリの自動保存: ${enabled ? 'ON' : 'OFF'}`);
            }
        });
    }
}
