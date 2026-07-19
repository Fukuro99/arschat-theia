import * as React from 'react';
import { resolveColor } from '../design-tokens';
import type { PrimitiveProps } from '../types';

export default function Badge({ props }: PrimitiveProps) {
  const { content = '', color = 'text', bg = 'surface' } = props || {};

  const resolvedColor = resolveColor(color) || 'var(--theia-foreground, #cccccc)';
  const resolvedBg = resolveColor(bg) || 'var(--theia-editorWidget-background, #252526)';

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: '9999px',
        fontSize: '0.75rem',
        fontWeight: 500,
        color: resolvedColor,
        backgroundColor: resolvedBg,
        border: '1px solid var(--theia-editorGroup-border, #3c3c3c)',
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
      }}
    >
      {content}
    </span>
  );
}
