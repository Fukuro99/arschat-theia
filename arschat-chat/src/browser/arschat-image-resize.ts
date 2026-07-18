export interface ResizeTarget {
    width: number;
    height: number;
    needsResize: boolean;
}

export const DEFAULT_IMAGE_MAX_LONG_EDGE = 1568;

export function shouldResizeImageMimeType(mimeType: string): boolean {
    return mimeType.trim().toLowerCase().split(';', 1)[0] !== 'image/gif';
}

export function computeResizeTarget(width: number, height: number, maxLongEdge = DEFAULT_IMAGE_MAX_LONG_EDGE): ResizeTarget {
    if (maxLongEdge <= 0) {
        throw new Error('maxLongEdge must be greater than zero');
    }
    if (width <= 0 || height <= 0) {
        return { width, height, needsResize: false };
    }
    const longEdge = Math.max(width, height);
    if (longEdge <= maxLongEdge) {
        return { width, height, needsResize: false };
    }
    const scale = maxLongEdge / longEdge;
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        needsResize: true
    };
}
