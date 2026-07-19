import * as React from 'react';
import { ALLOWED_GAP, resolveColor, resolveSpacing } from '../design-tokens';
import type { PrimitiveProps } from '../types';

export default function Grid({ props, children }: PrimitiveProps) {
  const { cols = 3, rows, gap, cellWidth, cellHeight, bg, borderColor } = props || {};

  const style: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `repeat(${cols}, ${cellWidth ? `${cellWidth}px` : '1fr'})`,
    gap: gap !== undefined ? resolveSpacing(gap, ALLOWED_GAP) ?? '0' : '0',
  };
  if (rows) {
    style.gridTemplateRows = `repeat(${rows}, ${cellHeight ? `${cellHeight}px` : '1fr'})`;
  }
  const resolvedBg = resolveColor(bg);
  if (resolvedBg) {
    style.backgroundColor = resolvedBg;
  }
  if (borderColor) {
    style.border = `1px solid ${resolveColor(borderColor) || borderColor}`;
  }

  const cellStyle: React.CSSProperties = {
    minWidth: cellWidth ? `${cellWidth}px` : '32px',
    minHeight: cellHeight ? `${cellHeight}px` : '32px',
    overflow: 'hidden',
  };
  if (cellWidth) {
    cellStyle.width = `${cellWidth}px`;
  }
  if (cellHeight) {
    cellStyle.height = `${cellHeight}px`;
  } else if (!cellWidth) {
    cellStyle.aspectRatio = '1';
  }
  if (borderColor) {
    cellStyle.border = `0.5px solid ${resolveColor(borderColor) || borderColor}`;
  }

  const childrenArray = React.Children.toArray(children);
  const totalCells = cols * (rows || 1);

  if (childrenArray.length === 1 && totalCells > 1) {
    const template = childrenArray[0];
    return (
      <div style={style}>
        {Array.from({ length: totalCells }, (_, i) => {
          const row = Math.floor(i / cols);
          const col = i % cols;
          return (
            <div key={i} style={cellStyle} data-row={row} data-col={col}>
              {React.cloneElement(template as React.ReactElement, { key: i })}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div style={style}>
      {childrenArray.map((child, i) => (
        <div key={i} style={cellStyle}>
          {child}
        </div>
      ))}
    </div>
  );
}
