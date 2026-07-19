import * as React from 'react';
import type { PrimitiveProps } from '../types';

export default function Checkbox({ props, value, onChange }: PrimitiveProps) {
  const { inputId, label = '', checked } = props || {};

  // value が bind から来る場合は boolean として使う
  const isChecked = value !== undefined ? Boolean(value) : Boolean(checked);

  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        cursor: 'pointer',
        fontSize: '0.875rem',
        color: 'var(--theia-foreground, #cccccc)',
        userSelect: 'none',
      }}
    >
      <input
        id={inputId}
        type="checkbox"
        checked={isChecked}
        onChange={(e) => onChange?.(e.target.checked)}
        style={{ cursor: 'pointer', accentColor: 'var(--theia-button-background, #0e639c)' }}
      />
      {label}
    </label>
  );
}
