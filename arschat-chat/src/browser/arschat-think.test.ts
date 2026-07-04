import { parseThinkBlocks } from './arschat-think';

describe('parseThinkBlocks', () => {

    it('extracts a completed think block and leaves the response', () => {
        const r = parseThinkBlocks('<think>reasoning here</think>\n\nHello world');
        expect(r.thinking).toBe('reasoning here');
        expect(r.response).toBe('Hello world');
        expect(r.isThinkingInProgress).toBe(false);
    });

    it('flags an open (still-streaming) think block', () => {
        const r = parseThinkBlocks('<think>still thinking...');
        expect(r.isThinkingInProgress).toBe(true);
        expect(r.response).toBe('');
    });

    it('handles an orphan closing tag', () => {
        const r = parseThinkBlocks('leftover thought</think>\n\nvisible');
        expect(r.thinking).toContain('leftover thought');
        expect(r.response).toBe('visible');
        expect(r.isThinkingInProgress).toBe(false);
    });

    it('returns plain text unchanged when there is no think block', () => {
        const r = parseThinkBlocks('just a normal answer');
        expect(r.thinking).toBe('');
        expect(r.response).toBe('just a normal answer');
        expect(r.isThinkingInProgress).toBe(false);
    });
});
