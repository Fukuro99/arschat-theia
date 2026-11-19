import type { LanguageModelMessage, LanguageModelStreamResponsePart } from '@theia/ai-core';
import { CliAgentKind, CLI_IMAGE_NOTICE } from '../common/cli-agents';

export function cliTranscript(messages: LanguageModelMessage[]): string {
    const label = { system: 'システム', user: 'ユーザー', ai: 'アシスタント' };
    return messages.map(m => {
        if (m.type === 'text') { return `${label[m.actor]}: ${m.text}`; }
        if (m.type === 'image') { return `${label[m.actor]}: [${CLI_IMAGE_NOTICE}]`; }
        if (m.type === 'tool_result') { return `ツール結果 (${m.name}): ${JSON.stringify(m.content ?? '')}`; }
        if (m.type === 'tool_use') { return `アシスタントのツール使用 (${m.name}): ${JSON.stringify(m.input)}`; }
        return ''; // Private thinking is not replayed as conversation text.
    }).filter(Boolean).join('\n\n');
}

interface ClaudeBlock {
    type: string;
    value: string;
    verified: boolean;
    stopped: boolean;
}

export class CliAgentOutputError extends Error {
    constructor() { super('CLI の出力を解釈できませんでした'); }
}

/** Incremental JSONL decoder. Complete assistant/result snapshots must not duplicate deltas. */
export class CliAgentDecoder {
    done = false;
    private messageId: string | undefined;
    private readonly blocks = new Map<number, ClaudeBlock>();
    private activeIndex: number | undefined;
    constructor(private readonly kind: CliAgentKind) {}

    private startMessage(id?: string): void {
        if (this.hasUnverifiedBlocks()) {
            throw new Error('Claude Code のメッセージの完全版を確認できませんでした。');
        }
        this.messageId = id;
        this.blocks.clear();
        this.activeIndex = undefined;
    }

    private hasUnverifiedBlocks(): boolean {
        return [...this.blocks.values()].some(b => !b.verified && !!b.value);
    }

    private block(type: string, index?: number): ClaudeBlock {
        if (index === undefined) {
            // Older/non-partial records may omit stream indices. Keep their channels
            // separate, while indexed stream events always select the exact block.
            index = [...this.blocks].find(([_, b]) => b.type === type && !b.verified && !b.stopped)?.[0];
            if (index === undefined) { index = this.blocks.size ? Math.max(...this.blocks.keys()) + 1 : 0; }
        }
        let block = this.blocks.get(index);
        if (!block) {
            block = { type, value: '', verified: false, stopped: false };
            this.blocks.set(index, block);
        }
        if (block.type !== type) { throw new Error('Claude Code のブロック種別が一致しません。'); }
        this.activeIndex = index;
        return block;
    }

    private reconcile(block: ClaudeBlock, value: string): LanguageModelStreamResponsePart[] {
        // Already-emitted content cannot be retracted or have text inserted in its middle.
        if (!value.startsWith(block.value)) {
            throw new Error('Claude Code のメッセージが完全版と一致しません。');
        }
        const suffix = value.slice(block.value.length);
        block.value = value;
        block.verified = true;
        return !suffix ? [] : block.type === 'thinking' ? [{ thought: suffix, signature: '' }] : [{ content: suffix }];
    }
    decode(line: string): LanguageModelStreamResponsePart[] {
        if (this.done || !line.trim()) { return []; }
        let e: any;
        try { e = JSON.parse(line); } catch {
            throw new CliAgentOutputError();
        }
        if (!e || typeof e !== 'object') { return []; }
        if (e.type === 'error' || e.type === 'turn.failed') { throw new Error('CLI がエラーを返しました。ログイン・接続・利用枠を確認してください。'); }
        if (this.kind === 'codex-cli') {
            if (e.type === 'turn.completed') { this.done = true; return []; }
            if (e.type !== 'item.completed' || !e.item) { return []; }
            const i = e.item;
            if (i.type === 'agent_message' && typeof i.text === 'string') { return [{ content: i.text }]; }
            if (i.type === 'reasoning' && typeof i.text === 'string') { return [{ thought: i.text, signature: '' }]; }
            if (i.type === 'command_execution' && typeof i.command === 'string') {
                return [{ content: `\nCodex が実行した操作: ${i.command}\n` }];
            }
            if (i.type === 'file_change' && Array.isArray(i.changes)) {
                return [{ content: `\nCodex が実行した操作: ${i.changes.map((c: any) => typeof c?.path === 'string' ? c.path : '').filter(Boolean).join(', ')}\n` }];
            }
        } else {
            if (e.parent_tool_use_id) { return []; }
            if (e.type === 'result') {
                if (e.is_error) { throw new Error('Claude Code がエラーを返しました。API キー・接続・利用枠を確認してください。'); }
                // result repeats the final text block, not earlier text/tool/thinking blocks.
                const textBlock = [...this.blocks.values()].reverse().find(b => b.type === 'text');
                const parts = typeof e.result === 'string' ? this.reconcile(textBlock ?? this.block('text'), e.result) : [];
                if (this.hasUnverifiedBlocks() ||
                    (typeof e.result !== 'string' && !this.blocks.size)) {
                    throw new Error('Claude Code のメッセージの完全版を確認できませんでした。');
                }
                this.done = true;
                return parts;
            }
            if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
                if (this.messageId && e.message.id && this.messageId !== e.message.id) { this.startMessage(e.message.id); }
                const parts: LanguageModelStreamResponsePart[] = [];
                for (const content of e.message.content) {
                    // Claude emits each assistant before that block's content_block_stop.
                    // Its content array usually has one element even when the index is > 0.
                    const active = this.activeIndex === undefined ? undefined : this.blocks.get(this.activeIndex);
                    const index = e.message.content.length === 1 && active?.type === content.type ? this.activeIndex : undefined;
                    const block = this.block(content.type, index);
                    const value = content.type === 'text' ? content.text : content.type === 'thinking' ? content.thinking : '';
                    parts.push(...this.reconcile(block, value));
                }
                this.messageId = e.message.id;
                return parts;
            }
            if (e.type === 'stream_event' && e.event?.type === 'message_start') {
                this.startMessage(e.event.message?.id);
                return [];
            }
            if (e.type === 'stream_event' && e.event?.type === 'content_block_stop') {
                const index = Number.isInteger(e.event.index) ? e.event.index : this.activeIndex;
                const stopped = index === undefined ? undefined : this.blocks.get(index);
                if (stopped) { stopped.stopped = true; }
                if (index === this.activeIndex) { this.activeIndex = undefined; }
                return [];
            }
            const block = e.type === 'stream_event' && e.event?.type === 'content_block_start' ? e.event.content_block : undefined;
            const delta = e.type === 'stream_event' ? e.event?.delta : undefined;
            const text = delta?.type === 'text_delta' ? delta.text : block?.type === 'text' ? block.text : undefined;
            const thought = delta?.type === 'thinking_delta' ? delta.thinking : block?.type === 'thinking' ? block.thinking : undefined;
            const index = Number.isInteger(e.event?.index) ? e.event.index : undefined;
            if (block) { this.block(block.type, index); }
            if (typeof text === 'string' && text) {
                this.block('text', index).value += text;
                return [{ content: text }];
            }
            if (typeof thought === 'string' && thought) {
                this.block('thinking', index).value += thought;
                return [{ thought, signature: '' }];
            }
        }
        return [];
    }
}
