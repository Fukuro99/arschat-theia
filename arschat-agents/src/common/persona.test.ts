import { composeSystemPrompt, composeSkillsSection, currentDateTimeTag, Persona, SkillSummary, DEFAULT_PERSONA } from './persona';

describe('persona system-prompt composition (ported from getEffectiveSystemPrompt)', () => {
    const persona: Persona = { id: 'p1', name: 'アリス', systemPrompt: 'あなたは親切な助手です。', avatarPath: null };
    const fixedDate = new Date(2026, 6, 4, 9, 5); // 2026-07-04 09:05 local

    it('prefixes the persona name and appends the date tag', () => {
        const out = composeSystemPrompt(persona, [], fixedDate);
        expect(out).toContain('あなたの名前は「アリス」です。');
        expect(out).toContain('あなたは親切な助手です。');
        expect(out).toContain('現在日時: [2026:07:04;09:05]');
    });

    it('injects the skills catalogue section when skills are present', () => {
        const skills: SkillSummary[] = [
            { id: 'summarize', name: '要約', description: 'テキストを要約', trigger: '/summarize' },
            { id: 'translate', name: '翻訳', description: 'テキストを翻訳', trigger: '/translate' }
        ];
        const out = composeSystemPrompt(persona, skills, fixedDate);
        expect(out).toContain('## あなたが持つスキル');
        expect(out).toContain('| /summarize | 要約 | テキストを要約 |');
        expect(out).toContain('| /translate | 翻訳 | テキストを翻訳 |');
    });

    it('omits the skills section when there are no skills', () => {
        expect(composeSkillsSection([])).toBe('');
        const out = composeSystemPrompt(persona, [], fixedDate);
        expect(out).not.toContain('## あなたが持つスキル');
    });

    it('different personas produce different prompts (drives the switch test)', () => {
        const a = composeSystemPrompt({ id: 'a', name: 'A', systemPrompt: 'PROMPT_A', avatarPath: null }, [], fixedDate);
        const b = composeSystemPrompt({ id: 'b', name: 'B', systemPrompt: 'PROMPT_B', avatarPath: null }, [], fixedDate);
        expect(a).toContain('PROMPT_A');
        expect(a).toContain('「A」');
        expect(b).toContain('PROMPT_B');
        expect(b).toContain('「B」');
        expect(a).not.toEqual(b);
    });

    it('date tag is zero-padded', () => {
        expect(currentDateTimeTag(new Date(2026, 0, 1, 3, 7))).toBe('[2026:01:01;03:07]');
    });

    it('default persona is well-formed', () => {
        expect(DEFAULT_PERSONA.id).toBe('default');
        expect(DEFAULT_PERSONA.systemPrompt.length).toBeGreaterThan(10);
    });
});
