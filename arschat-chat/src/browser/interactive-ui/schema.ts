import { primitiveRegistry } from './primitives';
import type { InteractiveUIBlock, SandboxHTMLBlock, UIAction, UINode } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeNode(value: unknown): UINode | undefined {
  if (!isRecord(value) || typeof value.primitive !== 'string' || !value.primitive.trim()) {
    return undefined;
  }
  const children = Array.isArray(value.children)
    ? value.children.map(normalizeNode).filter((node): node is UINode => !!node)
    : undefined;
  return {
    primitive: value.primitive,
    id: typeof value.id === 'string' ? value.id : undefined,
    props: isRecord(value.props) ? value.props : undefined,
    children,
    showIf: typeof value.showIf === 'string' ? value.showIf : undefined,
    bind: typeof value.bind === 'string' ? value.bind : undefined,
  };
}

function normalizeAction(value: unknown): UIAction | undefined {
  if (!isRecord(value) || (value.type !== 'submit' && value.type !== 'cancel' && value.type !== 'custom')) {
    return undefined;
  }
  return {
    type: value.type,
    label: typeof value.label === 'string' && value.label.trim() ? value.label : value.type,
    variant: value.variant === 'primary' || value.variant === 'secondary' || value.variant === 'danger' ? value.variant : undefined,
    actionId: typeof value.actionId === 'string' ? value.actionId : undefined,
  };
}

export function normalizeInteractiveUIBlock(value: unknown): InteractiveUIBlock | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) {
    return undefined;
  }
  if (value.mode !== undefined && value.mode !== 'default' && value.mode !== 'live') {
    return undefined;
  }
  const root = normalizeNode(value.root);
  if (!root) {
    return undefined;
  }
  return {
    id: value.id,
    mode: value.mode === 'live' ? 'live' : 'default',
    title: typeof value.title === 'string' ? value.title : undefined,
    state: isRecord(value.state) ? value.state : {},
    root,
    actions: Array.isArray(value.actions)
      ? value.actions.map(normalizeAction).filter((action): action is UIAction => !!action)
      : undefined,
  };
}

export function normalizeSandboxHTMLBlock(value: unknown, interactive = false): SandboxHTMLBlock | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) {
    return undefined;
  }
  if (typeof value.html !== 'string' || !value.html.trim()) {
    return undefined;
  }
  return {
    id: value.id,
    title: typeof value.title === 'string' ? value.title : undefined,
    html: value.html,
    width: typeof value.width === 'string' ? value.width : undefined,
    height: typeof value.height === 'string' ? value.height : undefined,
    interactive,
  };
}

export function isRegisteredPrimitive(name: string): boolean {
  return !!primitiveRegistry[name];
}
