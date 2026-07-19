import * as React from 'react';
import { resolveColor } from '../design-tokens';
import type { PrimitiveProps } from '../types';

export default function Divider({ props }: PrimitiveProps) {
  const { direction = 'horizontal', color = 'border' } = props || {};

  const resolvedColor = resolveColor(color) || 'var(--theia-editorGroup-border, #3c3c3c)';

  if (direction === 'vertical') {
    return (
      <div
        style={{
          width: '1px',
          alignSelf: 'stretch',
          backgroundColor: resolvedColor,
          margin: '0 4px',
        }}
      />
    );
  }

  return (
    <hr
      style={{
        border: 'none',
        borderTop: `1px solid ${resolvedColor}`,
        margin: '4px 0',
        width: '100%',
      }}
    />
  );
}
