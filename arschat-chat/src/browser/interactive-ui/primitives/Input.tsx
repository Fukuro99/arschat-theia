import * as React from 'react';
import { useRef } from 'react';
import type { PrimitiveProps } from '../types';

export default function Input({ props, value, onChange }: PrimitiveProps) {
  const { inputId, placeholder = '', multiline = false } = props || {};
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const initialValue = value === undefined || value === null ? '' : String(value);

  const handleChange = () => {
    onChange?.(ref.current?.value ?? '');
  };

  const commonStyle: React.CSSProperties = {
    width: '100%',
    padding: '6px 10px',
    fontSize: '0.875rem',
    color: 'var(--theia-foreground, #cccccc)',
    backgroundColor: 'var(--theia-input-background, var(--theia-editor-background, #1e1e1e))',
    border: '1px solid var(--theia-editorGroup-border, #3c3c3c)',
    borderRadius: '6px',
    outline: 'none',
    resize: 'vertical',
    fontFamily: 'inherit',
  };

  if (multiline) {
    return (
      <textarea
        ref={ref as React.RefObject<HTMLTextAreaElement>}
        id={inputId}
        placeholder={placeholder}
        defaultValue={initialValue}
        onChange={handleChange}
        style={{ ...commonStyle, minHeight: '80px' }}
        className="iui-input"
      />
    );
  }

  return (
    <input
      ref={ref as React.RefObject<HTMLInputElement>}
      id={inputId}
      type="text"
      placeholder={placeholder}
      defaultValue={initialValue}
      onChange={handleChange}
      style={commonStyle}
      className="iui-input"
    />
  );
}
