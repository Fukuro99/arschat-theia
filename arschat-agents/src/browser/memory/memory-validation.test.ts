import { extractionValidator, isExtractionValidationError } from './memory-validation';

describe('sqgraph extraction schema', () => {
    const validate = extractionValidator({ type: 'object' });
    it.each(['ref', 'name', 'type'])('requires entity %s', field => {
        const entity: Record<string, unknown> = { ref: 'e1', name: 'Test', type: 'Person' };
        delete entity[field];
        expect(validate({ entities: [entity] })).toBe(false);
    });
    it.each(['subject', 'relation', 'fact'])('requires fact %s', field => {
        const fact: Record<string, unknown> = { subject: 'author', relation: 'LIKES', fact: 'Test fact' };
        delete fact[field];
        expect(validate({ facts: [fact] })).toBe(false);
    });
    it('allows an empty extraction and enforces server enum constraints', () => {
        expect(validate({})).toBe(true);
        const strict = extractionValidator({ properties: { entities: { items: { properties: { type: { enum: ['Person'] } } } } } });
        expect(strict({ entities: [{ ref: 'e1', name: 'Test', type: 'UnknownType' }] })).toBe(false);
        expect(strict({ entities: [{ ref: 'e1', name: 'Test', type: 'Person' }] })).toBe(true);
    });
    it('does not retry content mentioning validation or unrelated MCP errors', () => {
        expect(isExtractionValidationError({ content: [{ type: 'text', text: 'invalid extraction is a phrase in a fact' }] })).toBe(false);
        expect(isExtractionValidationError({ isError: true, content: [{ type: 'text', text: 'memory database is read-only' }] })).toBe(false);
    });
});
