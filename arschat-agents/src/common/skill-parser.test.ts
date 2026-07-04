import { parseSkillMarkdown, buildSkillMarkdown } from './skill-parser';
import { skillTrigger } from './skill';

describe('skill markdown parser (gray-matter based)', () => {
    it('parses frontmatter name/description/trigger and body', () => {
        const md = [
            '---',
            'name: 要約',
            'description: テキストを要約する',
            'trigger: /summarize',
            '---',
            '',
            '# 要約スキル',
            '本文の指示です。'
        ].join('\n');
        const skill = parseSkillMarkdown('summarize', '/cfg/skills/summarize.md', md);
        expect(skill).toBeDefined();
        expect(skill!.name).toBe('要約');
        expect(skill!.description).toBe('テキストを要約する');
        expect(skill!.trigger).toBe('/summarize');
        expect(skill!.body).toContain('# 要約スキル');
        expect(skill!.body).toContain('本文の指示です。');
        expect(skill!.id).toBe('summarize');
    });

    it('defaults the trigger to /<id> when frontmatter omits it', () => {
        const md = '---\nname: 翻訳\ndescription: 翻訳する\n---\n本文';
        const skill = parseSkillMarkdown('translate', '/x/translate.md', md);
        expect(skill!.trigger).toBe('/translate');
    });

    it('prepends a slash to a bare trigger', () => {
        expect(skillTrigger('foo', 'bar')).toBe('/bar');
        expect(skillTrigger('foo', '/bar')).toBe('/bar');
        expect(skillTrigger('foo')).toBe('/foo');
    });

    it('returns undefined when name or description is missing', () => {
        expect(parseSkillMarkdown('x', '/x.md', '---\nname: only name\n---\nbody')).toBeUndefined();
        expect(parseSkillMarkdown('x', '/x.md', 'no frontmatter at all')).toBeUndefined();
    });

    it('round-trips through buildSkillMarkdown', () => {
        const content = buildSkillMarkdown({ name: 'N', description: 'D', trigger: '/t', body: 'BODY' });
        const skill = parseSkillMarkdown('t', '/t.md', content);
        expect(skill).toBeDefined();
        expect(skill!.name).toBe('N');
        expect(skill!.description).toBe('D');
        expect(skill!.trigger).toBe('/t');
        expect(skill!.body).toBe('BODY');
    });
});
