if (typeof global.DragEvent === 'undefined') {
    global.DragEvent = class DragEvent extends Event {};
}
