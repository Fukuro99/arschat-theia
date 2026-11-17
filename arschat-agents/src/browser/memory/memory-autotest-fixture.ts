export const M16_WORD = 'ArschatM16MemoryQuartz';
// Verified against sqgraph memory/prompts.py AGENT_EXTRACTION_SCHEMA and core.py _extraction_to_work.
export const M16_EXTRACTION = {
    entities: [],
    facts: [{ subject: 'author', object: null, relation: 'PREFERS', fact: `ユーザーは ${M16_WORD} が好きです。`,
        valid_at: null, invalid_at: null, modality: 'definite', confidence: 1, duplicate_of: null, contradicts: [] }]
};
