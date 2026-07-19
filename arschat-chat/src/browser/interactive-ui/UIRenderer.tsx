import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { primitiveRegistry } from './primitives';
import type { InteractiveUIBlock, UIAction, UINode } from './types';

function resolveKeyPath(obj: Record<string, any>, keyPath: string): any {
  const keys = keyPath.split('.');
  let current: any = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function updateKeyPath(obj: Record<string, any>, keyPath: string, value: any): Record<string, any> {
  const keys = keyPath.split('.');
  const result = { ...obj };
  let current: Record<string, any> = result;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    current[key] = { ...(current[key] || {}) };
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
  return result;
}

function UnknownPrimitive({ name }: { name: string }) {
  return (
    <span className="iui-unknown-primitive">
      [unknown: {name}]
    </span>
  );
}

interface UIRendererProps {
  node: UINode;
  state: Record<string, any>;
  onAction: (nodeId: string | undefined, actionId: string, data?: any) => void;
  onStateChange: (keyPath: string, value: any) => void;
}

export function UIRenderer({ node, state, onAction, onStateChange }: UIRendererProps) {
  const Component = primitiveRegistry[node.primitive];
  const boundValue = node.bind ? resolveKeyPath(state, node.bind) : undefined;

  const handleChange = useCallback((v: any) => {
    if (node.bind) {
      onStateChange(node.bind, v);
    }
  }, [node.bind, onStateChange]);

  const handleAction = useCallback((actionId: string, data?: any) => {
    onAction(node.id, actionId, data);
  }, [node.id, onAction]);

  const renderedChildren = node.children?.map((child, i) => (
    <UIRenderer
      key={child.id || i}
      node={child}
      state={state}
      onAction={onAction}
      onStateChange={onStateChange}
    />
  ));

  if (node.showIf && !resolveKeyPath(state, node.showIf)) {
    return null;
  }

  if (!Component) {
    return <UnknownPrimitive name={node.primitive} />;
  }

  return (
    <Component
      props={node.props || {}}
      value={boundValue}
      onChange={handleChange}
      onAction={handleAction}
      state={state}
    >
      {renderedChildren}
    </Component>
  );
}

interface BlockRendererProps {
  block: InteractiveUIBlock;
  onSubmit: (uiId: string, action: string, data: Record<string, any>) => void;
  onAction?: (uiId: string, actionId: string, data?: any) => void;
  onLiveAction?: (uiId: string, action: string, data: Record<string, any>, currentState: Record<string, any>) => void;
  onLocalStateChange?: (uiId: string, keyPath: string, value: any) => void;
  liveState?: Record<string, any>;
  isLoading?: boolean;
  disabled?: boolean;
}

export function BlockRenderer({
  block,
  onSubmit,
  onAction,
  onLiveAction,
  onLocalStateChange,
  liveState,
  isLoading,
  disabled,
}: BlockRendererProps) {
  const isLive = block.mode === 'live';
  const [localState, setLocalState] = useState<Record<string, any>>(block.state || {});
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (isLive && liveState !== undefined) {
      setLocalState(liveState);
    }
  }, [isLive, liveState]);

  const currentState = isLive && liveState !== undefined ? liveState : localState;
  const isFinished = disabled || (isLive && currentState.status === 'finished');

  const handleStateChange = useCallback((keyPath: string, value: any) => {
    if (!isLive) {
      setLocalState(prev => updateKeyPath(prev, keyPath, value));
    } else if (onLocalStateChange) {
      onLocalStateChange(block.id, keyPath, value);
    }
  }, [isLive, block.id, onLocalStateChange]);

  const handleAction = useCallback((nodeId: string | undefined, actionId: string, data?: any) => {
    if (isFinished || submitted) {
      return;
    }
    if (isLive && onLiveAction) {
      onLiveAction(block.id, actionId, { ...data, nodeId }, currentState);
    } else if (onAction) {
      onAction(block.id, actionId, { ...data, nodeId });
    }
  }, [block.id, onAction, onLiveAction, isLive, isFinished, submitted, currentState]);

  const handleSubmit = useCallback((actionType: string, actionId?: string) => {
    if (submitted || isFinished) {
      return;
    }
    setSubmitted(true);
    onSubmit(block.id, actionType, localState);
    if (actionId && onAction) {
      onAction(block.id, actionId, localState);
    }
  }, [block.id, localState, onSubmit, onAction, submitted, isFinished]);

  if (isLoading) {
    return (
      <div className="iui-block iui-block-loading">
        <div className="iui-spinner" />
      </div>
    );
  }

  return (
    <div className={`iui-block${isLive ? ' iui-block-live' : ''}${isFinished ? ' iui-block-finished' : ''}`}>
      {block.title && (
        <div className="iui-block-title">
          {block.title}
          {isLive && (
            <span className={`iui-live-badge${isFinished ? ' iui-live-badge-finished' : ''}`}>
              {isFinished ? 'Finished' : 'LIVE'}
            </span>
          )}
        </div>
      )}

      <div className={`iui-block-content${isFinished || submitted ? ' iui-block-content-disabled' : ''}`}>
        <UIRenderer node={block.root} state={currentState} onAction={handleAction} onStateChange={handleStateChange} />
      </div>

      {!isLive && block.actions && block.actions.length > 0 && !submitted && !isFinished && (
        <div className="iui-block-actions">
          {block.actions.map((action: UIAction, i: number) => (
            <ActionButton key={i} action={action} onSubmit={handleSubmit} />
          ))}
        </div>
      )}

      {!isLive && submitted && (
        <div className="iui-block-submitted">
          <span>Submitted</span>
        </div>
      )}

      {isLive && isFinished && (
        <div className="iui-block-submitted">
          <span>Finished</span>
        </div>
      )}
    </div>
  );
}

interface ActionButtonProps {
  action: UIAction;
  onSubmit: (actionType: string, actionId?: string) => void;
}

function ActionButton({ action, onSubmit }: ActionButtonProps) {
  const variant = action.variant || (action.type === 'submit' ? 'primary' : 'secondary');
  const className = `iui-action-btn iui-action-btn-${variant}`;
  const handleClick = () => {
    onSubmit(action.type === 'cancel' ? 'cancel' : action.type, action.actionId);
  };
  return (
    <button className={className} onClick={handleClick} type="button">
      {action.label}
    </button>
  );
}
