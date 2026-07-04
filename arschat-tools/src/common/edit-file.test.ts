import { applyEdit, countOccurrences } from './edit-file';

describe('edit_file core logic (applyEdit)', () => {
    it('replaces a single unique occurrence', () => {
        const res = applyEdit('hello world', { oldString: 'world', newString: 'there' });
        expect(res.ok).toBe(true);
        expect(res.content).toBe('hello there');
        expect(res.replacements).toBe(1);
    });

    it('rejects a non-unique oldString unless replaceAll is set', () => {
        const res = applyEdit('a a a', { oldString: 'a', newString: 'b' });
        expect(res.ok).toBe(false);
        expect(res.replacements).toBe(0);
        expect(res.error).toMatch(/not unique/);
        // content is unchanged on failure
        expect(res.content).toBe('a a a');
    });

    it('replaces every occurrence when replaceAll is true', () => {
        const res = applyEdit('a a a', { oldString: 'a', newString: 'b', replaceAll: true });
        expect(res.ok).toBe(true);
        expect(res.content).toBe('b b b');
        expect(res.replacements).toBe(3);
    });

    it('fails when oldString is absent', () => {
        const res = applyEdit('hello', { oldString: 'xyz', newString: 'q' });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/not found/);
    });

    it('fails when oldString equals newString (no-op edit)', () => {
        const res = applyEdit('hello', { oldString: 'hello', newString: 'hello' });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/differ/);
    });

    it('fails on empty oldString', () => {
        const res = applyEdit('hello', { oldString: '', newString: 'x' });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/empty/);
    });

    it('preserves multi-line content and whitespace', () => {
        const src = 'line1\n    indented\nline3\n';
        const res = applyEdit(src, { oldString: '    indented', newString: '    changed' });
        expect(res.ok).toBe(true);
        expect(res.content).toBe('line1\n    changed\nline3\n');
    });

    it('countOccurrences counts non-overlapping matches', () => {
        expect(countOccurrences('aaaa', 'aa')).toBe(2);
        expect(countOccurrences('abcabc', 'bc')).toBe(2);
        expect(countOccurrences('abc', 'x')).toBe(0);
        expect(countOccurrences('abc', '')).toBe(0);
    });
});
