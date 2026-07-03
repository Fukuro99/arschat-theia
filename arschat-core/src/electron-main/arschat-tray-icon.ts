// *****************************************************************************
// ArsChat PoC-1: system tray icon as an embedded base64 PNG.
// Embedding avoids relying on `tsc` to copy non-.ts assets from src/ to lib/,
// which it does not do by default (see BUILD_NOTES.md PoC-1 section).
// *****************************************************************************

/**
 * 16x16 opaque PNG, solid accent color (#2d8cf0). Generated with a small
 * zlib-based script (no external image dependency needed for a PoC).
 */
export const TRAY_ICON_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGPQ7fnwnxLMMGrAqAGjBgwXAwAn7Kgf27/9gQAAAABJRU5ErkJggg==';
