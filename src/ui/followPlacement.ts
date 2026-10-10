export type Box = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };

/**
 * Where a dock that follows a selection goes (design/ui-system/README.md, Dock 放置): 14 px under the
 * selection and centred on it; above it when there is no room below; pinned to the bottom of the usable
 * area when neither fits. Never leaves the bounds horizontally. `reserveBottom` keeps another dock clear.
 */
export function followPlacement(anchor: Box, bounds: Size, size: Size,
  { gap = 14, margin = 8, reserveBottom = 0 }: { gap?: number; margin?: number; reserveBottom?: number } = {}) {
  const floor = bounds.height - margin - reserveBottom;
  const below = anchor.y + anchor.height + gap;
  const above = anchor.y - gap - size.height;
  const top = below + size.height <= floor ? below : above >= margin ? above : Math.max(margin, floor - size.height);
  const centred = anchor.x + anchor.width / 2 - size.width / 2;
  const left = Math.max(margin, Math.min(bounds.width - margin - size.width, centred));
  return { left, top };
}
