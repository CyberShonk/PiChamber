/** Fixed native popup stays between the app header and its status-row trigger. */
export const nativeChangedFilesGeometry = (anchor: { top: number; left: number; right: number }, viewport: { left: number; width: number; top: number; bottom: number }, headerBottom: number, align: 'start' | 'end') => {
  const gutter = 8;
  const width = Math.max(0, Math.min(448, viewport.width - gutter * 2));
  const bottom = Math.min(anchor.top - gutter, viewport.bottom - gutter);
  const top = Math.max(viewport.top + gutter, headerBottom + gutter);
  const desiredLeft = align === 'end' ? anchor.right - width : anchor.left;
  return { width, left: Math.max(viewport.left + gutter, Math.min(desiredLeft, viewport.left + viewport.width - width - gutter)), bottom, maxHeight: Math.max(0, bottom - top) };
};
