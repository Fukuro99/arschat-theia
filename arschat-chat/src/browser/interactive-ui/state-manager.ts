import { useCallback, useRef, useState } from 'react';

export interface LiveUIAction {
  uiId: string;
  action: string;
  data: Record<string, any>;
  timestamp: number;
}

export function useLiveUIState(blockId: string, initialState: Record<string, any>) {
  const [state, setState] = useState<Record<string, any>>(initialState);
  const blockIdRef = useRef(blockId);
  blockIdRef.current = blockId;

  const updateState = useCallback((patch: Record<string, any>) => {
    setState(prev => mergePatch(prev, patch));
  }, []);

  return { state, setState, updateState };
}

export function mergePatch(current: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  const result = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = mergePatch(result[key] as Record<string, any>, value as Record<string, any>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
