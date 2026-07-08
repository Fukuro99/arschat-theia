import { computeMessageStats, hasDisplayableStats } from './arschat-message-stats';

describe('computeMessageStats', () => {

    it('uses real usage when the provider reported it', () => {
        const stats = computeMessageStats('whatever', { inputTokens: 120, outputTokens: 80 }, 4000);
        expect(stats.tokenSource).toBe('usage');
        expect(stats.totalTokens).toBe(200);
        expect(stats.durationSeconds).toBe(4);
        // speed is based on OUTPUT tokens only: 80 / 4s
        expect(stats.tokensPerSec).toBeCloseTo(20);
    });

    it('falls back to a char-based approximation without usage', () => {
        const text = 'a'.repeat(400); // ~100 tokens at 4 chars/token
        const stats = computeMessageStats(text, undefined, 10_000);
        expect(stats.tokenSource).toBe('approx');
        expect(stats.totalTokens).toBe(100);
        expect(stats.tokensPerSec).toBeCloseTo(10);
    });

    it('treats zero-token usage as absent and approximates instead', () => {
        const stats = computeMessageStats('abcd', { inputTokens: 0, outputTokens: 0 }, 1000);
        expect(stats.tokenSource).toBe('approx');
        expect(stats.totalTokens).toBe(1);
    });

    it('omits duration and speed when no duration is known (restored old session)', () => {
        const stats = computeMessageStats('hello world', { inputTokens: 10, outputTokens: 5 }, undefined);
        expect(stats.totalTokens).toBe(15);
        expect(stats.durationSeconds).toBeUndefined();
        expect(stats.tokensPerSec).toBeUndefined();
        expect(hasDisplayableStats(stats)).toBe(true);
    });

    it('omits speed for a zero-length duration (never divides by zero)', () => {
        const stats = computeMessageStats('hi', { inputTokens: 1, outputTokens: 1 }, 0);
        expect(stats.tokensPerSec).toBeUndefined();
        expect(stats.durationSeconds).toBe(0);
    });

    it('reports nothing displayable for an empty message with no usage or duration', () => {
        const stats = computeMessageStats('', undefined, undefined);
        expect(hasDisplayableStats(stats)).toBe(false);
    });
});
