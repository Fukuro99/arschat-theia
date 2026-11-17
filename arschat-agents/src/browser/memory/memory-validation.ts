import Ajv = require('@theia/core/shared/ajv');
import { jsonObject } from './memory-utils';

// Keep the required sqgraph fields even if a server supplies an incomplete schema.
const minimumSchema = {
    type: 'object',
    properties: {
        entities: { type: 'array', items: { type: 'object', required: ['ref', 'name', 'type'],
            properties: { ref: { type: 'string' }, name: { type: 'string' }, type: { type: 'string' } } } },
        facts: { type: 'array', items: { type: 'object', required: ['subject', 'relation', 'fact'],
            properties: { subject: { type: 'string' }, relation: { type: 'string' }, fact: { type: 'string' } } } }
    }
};

export function extractionValidator(schema: Record<string, unknown>): Ajv.ValidateFunction {
    return new Ajv({ logger: false }).compile({ allOf: [minimumSchema, schema] });
}

export class MemoryValidationError extends Error {
    constructor() { super('memory extraction validation failed'); }
}

export function isExtractionValidationError(value: unknown): boolean {
    if (value instanceof Error) { return /invalid extraction|extraction (?:is not valid JSON|must be)/i.test(value.message); }
    const result = jsonObject(value);
    if (!result) { return false; }
    if (result.structuredContent && isExtractionValidationError(result.structuredContent)) { return true; }
    if (!result.isError && !result.error) { return false; }
    const text = typeof result.error === 'string' ? result.error : JSON.stringify(result.content ?? result.error);
    return /invalid extraction|extraction (?:is not valid JSON|must be)/i.test(text);
}
