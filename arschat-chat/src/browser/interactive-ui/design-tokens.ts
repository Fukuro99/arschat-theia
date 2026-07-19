export const ALLOWED_SIZES = ['xs', 'sm', 'md', 'lg', 'xl'] as const;
export type SizeToken = (typeof ALLOWED_SIZES)[number];

export const ALLOWED_COLORS = [
  'primary',
  'secondary',
  'success',
  'warning',
  'danger',
  'muted',
  'text',
  'text-inverse',
  'bg',
  'surface',
  'border',
  'black',
  'white',
  'dark',
  'light',
] as const;
export type ColorToken = (typeof ALLOWED_COLORS)[number];

export const ALLOWED_GAP = [0, 2, 4, 8, 12, 16, 24, 32] as const;
export const ALLOWED_PADDING = [0, 4, 8, 12, 16, 24] as const;

export const ALLOWED_ROUNDED = ['none', 'sm', 'md', 'lg', 'full'] as const;
export type RoundedToken = (typeof ALLOWED_ROUNDED)[number];

export const ALLOWED_BORDER = ['none', 'thin', 'medium'] as const;

export const ALLOWED_WEIGHT = ['normal', 'medium', 'bold'] as const;
export type WeightToken = (typeof ALLOWED_WEIGHT)[number];

export const ALLOWED_ALIGN = ['left', 'center', 'right'] as const;

const RAW_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;

export const sizeMap: Record<SizeToken, string> = {
  xs: '0.75rem',
  sm: '0.875rem',
  md: '1rem',
  lg: '1.125rem',
  xl: '1.25rem',
};

export const colorMap: Record<ColorToken, string> = {
  primary: 'var(--theia-button-background, #0e639c)',
  secondary: 'var(--theia-descriptionForeground, #8a8a8a)',
  muted: 'var(--theia-descriptionForeground, #8a8a8a)',
  text: 'var(--theia-foreground, #cccccc)',
  'text-inverse': '#ffffff',
  bg: 'var(--theia-editor-background, #1e1e1e)',
  surface: 'var(--theia-editorWidget-background, #252526)',
  border: 'var(--theia-editorGroup-border, #3c3c3c)',
  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#ef4444',
  black: '#0f172a',
  white: '#f1f5f9',
  dark: '#1e293b',
  light: '#cbd5e1',
};

export const roundedMap: Record<RoundedToken, string> = {
  none: '0',
  sm: '0.25rem',
  md: '0.375rem',
  lg: '0.5rem',
  full: '9999px',
};

export function resolveColor(color: string | undefined): string | undefined {
  if (!color) return undefined;
  if (ALLOWED_COLORS.includes(color as ColorToken)) {
    return colorMap[color as ColorToken];
  }
  if (RAW_COLOR_REGEX.test(color)) {
    return color;
  }
  return undefined;
}

export function resolveSize(size: string | undefined): string | undefined {
  if (!size) return undefined;
  if (ALLOWED_SIZES.includes(size as SizeToken)) {
    return sizeMap[size as SizeToken];
  }
  return undefined;
}

export function resolveSpacing(value: number | undefined, allowed: readonly number[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  const num = Number(value);
  if ((allowed as readonly number[]).includes(num)) {
    return `${num}px`;
  }
  const clamped = [...allowed].sort((a, b) => Math.abs(a - num) - Math.abs(b - num))[0];
  return `${clamped}px`;
}

export function resolveRounded(rounded: string | undefined): string | undefined {
  if (!rounded) return undefined;
  if (ALLOWED_ROUNDED.includes(rounded as RoundedToken)) {
    return roundedMap[rounded as RoundedToken];
  }
  return undefined;
}

export function resolveFontWeight(weight: string | undefined): string | undefined {
  if (!weight) return undefined;
  const weightMap: Record<WeightToken, string> = {
    normal: '400',
    medium: '500',
    bold: '700',
  };
  if (ALLOWED_WEIGHT.includes(weight as WeightToken)) {
    return weightMap[weight as WeightToken];
  }
  return undefined;
}
