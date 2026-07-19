import * as React from 'react';
import { useState } from 'react';
import { resolveColor } from '../design-tokens';
import type { PrimitiveProps } from '../types';

export default function Clickable({ props, onAction, onChange, children }: PrimitiveProps) {
  const {
    actionId,
    cursor = 'pointer',
    hoverBg,
    local = false,
    stateValue,
  } = props || {};

  const [hovered, setHovered] = useState(false);

  const handleClick = (e: React.MouseEvent) => {
    const target = e.currentTarget as HTMLElement;
    const row = target.dataset.row;
    const col = target.dataset.col;
    if (local) {
      const val = stateValue ?? (row !== undefined && col !== undefined ? { row: Number(row), col: Number(col) } : true);
      onChange?.(val);
    } else if (actionId && onAction) {
      const data: Record<string, any> = {};
      if (row !== undefined) data.row = Number(row);
      if (col !== undefined) data.col = Number(col);
      onAction(actionId, data);
    }
  };

  const style: React.CSSProperties = {
    cursor,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
  };

  if (hovered && hoverBg) {
    style.backgroundColor = resolveColor(hoverBg) || hoverBg;
  }

  return (
    <div
      style={style}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
    </div>
  );
}
