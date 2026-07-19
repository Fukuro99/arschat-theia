import * as React from 'react';

export interface UINode {
  primitive: string;
  id?: string;
  props?: Record<string, any>;
  children?: UINode[];
  showIf?: string;
  bind?: string;
}

export interface UIAction {
  type: 'submit' | 'cancel' | 'custom';
  label: string;
  variant?: 'primary' | 'secondary' | 'danger';
  actionId?: string;
}

export interface InteractiveUIBlock {
  id: string;
  mode?: 'default' | 'live';
  title?: string;
  state?: Record<string, any>;
  root: UINode;
  actions?: UIAction[];
  _index?: number;
}

export interface UIUpdatePatch {
  id: string;
  patch: Record<string, any>;
}

export interface SandboxHTMLBlock {
  id: string;
  title?: string;
  html: string;
  width?: string;
  height?: string;
  interactive?: boolean;
}

export interface PrimitiveProps {
  props: Record<string, any>;
  value?: any;
  onChange?: (v: any) => void;
  onAction?: (actionId: string, data?: any) => void;
  state?: Record<string, any>;
  children?: React.ReactNode;
}
