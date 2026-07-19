import { primitiveRegistry } from './primitives';
import { isRegisteredPrimitive, normalizeInteractiveUIBlock } from './schema';
import { mergePatch } from './state-manager';

describe('interactive-ui registry and schema', () => {
  it('registers the 16 primitive UI components', () => {
    expect(Object.keys(primitiveRegistry).sort()).toEqual([
      'badge',
      'box',
      'button',
      'checkbox',
      'chips',
      'clickable',
      'divider',
      'grid',
      'icon',
      'image',
      'input',
      'progress-bar',
      'scroll',
      'select',
      'slider',
      'text',
    ].sort());
    expect(isRegisteredPrimitive('input')).toBe(true);
    expect(isRegisteredPrimitive('unknown')).toBe(false);
  });

  it('normalizes a default UI block and preserves unknown primitives for renderer fallback', () => {
    const block = normalizeInteractiveUIBlock({
      id: 'form',
      mode: 'default',
      state: { form: { name: '' } },
      root: {
        primitive: 'future-widget',
        props: { label: 'Future' },
        children: [{ primitive: 'text', props: { text: 'Hello' } }]
      },
      actions: [{ type: 'submit', label: 'Send' }]
    });
    expect(block).toBeDefined();
    expect(block!.root.primitive).toBe('future-widget');
    expect(block!.actions).toEqual([{ type: 'submit', label: 'Send', variant: undefined, actionId: undefined }]);
  });

  it('rejects live mode in Phase 1 schema normalization', () => {
    expect(normalizeInteractiveUIBlock({
      id: 'live-ui',
      mode: 'live',
      root: { primitive: 'box' }
    })).toBeUndefined();
  });

  it('mergePatch recursively merges objects and replaces arrays', () => {
    expect(mergePatch(
      { a: { b: 1, c: 2 }, list: [1], keep: true },
      { a: { b: 3 }, list: [2, 3] }
    )).toEqual({ a: { b: 3, c: 2 }, list: [2, 3], keep: true });
  });
});
