/**
 * The mouse POINTER's shape follows what it is over: a resize arrow on a
 * divider, a hand on a pane title, an I-beam over copyable text, an arrow-hand on anything that clicks.
 *
 * OSC 22 — xterm's pointer-shape extension, CSS cursor names — honoured by kitty (the spec's author),
 * Ghostty ≥1.0, foot and xterm; every other terminal ignores an unknown OSC, so emitting is always
 * safe. Under tmux the sequence must ride tmux's DCS passthrough (and the user's tmux needs
 * `allow-passthrough on` — `oak status` says so when it is off); tmux itself cannot set a pointer.
 *
 * Pure: the app decides WHEN (only on a change, never per motion event) and writes the bytes.
 */

export type PointerShape = 'default' | 'pointer' | 'text' | 'grab' | 'grabbing' | 'ew-resize' | 'ns-resize';

/** The bytes that set the pointer, wrapped for tmux when the app runs inside one. ST-terminated, as
 *  the kitty spec writes it; inside the passthrough every ESC is doubled, as tmux requires. */
export function pointerSeq(shape: PointerShape, inTmux: boolean): string {
  const osc = `\x1b]22;${shape}\x1b\\`;
  return inTmux ? `\x1bPtmux;${osc.replace(/\x1b/g, '\x1b\x1b')}\x1b\\` : osc;
}

/** A tree tab's hit → shape. A seam resizes along its axis (a vertical rule drags left/right); a pane's
 *  title row is the grab handle (drag moves the pane); its body is text the reader can drag-copy. */
export function pointerForTreeHit(hit: { kind: 'seam'; axis: 'h' | 'v' } | { kind: 'pane'; titleRow: boolean } | null): PointerShape {
  if (!hit) return 'default';
  if (hit.kind === 'seam') return hit.axis === 'v' ? 'ew-resize' : 'ns-resize';
  return hit.titleRow ? 'grab' : 'text';
}

/** A dock tab's hit → shape. `seamAxis` is the hit seam's own axis from the layout (the Hit carries only
 *  its index); the dock's panes are not draggable, so a title is plain — the click targets are tabs,
 *  chips, twigs and nav buttons. */
export function pointerForDockHit(hit: { t: string } | null, seamAxis?: 'h' | 'v'): PointerShape {
  if (!hit) return 'default';
  switch (hit.t) {
    case 'seam':
      return seamAxis === 'h' ? 'ns-resize' : 'ew-resize';
    case 'tabbar':
    case 'tab':
    case 'tabscroll':
    case 'nav':
    case 'windowbar':
      return 'pointer';
    case 'body':
      return 'text';
    default:
      return 'default';
  }
}

/** Where a dragged pane would land if dropped at (`dx`,`dy`) — the pointer's position inside the
 *  target as fractions of its width and height. The middle half swaps; the rest names the nearest
 *  edge, so a drop by the left rule means "put it to the left of this one". */
export function dropZone(dx: number, dy: number): 'swap' | 'left' | 'right' | 'top' | 'bottom' {
  if (dx >= 0.25 && dx <= 0.75 && dy >= 0.25 && dy <= 0.75) return 'swap';
  const d: [number, 'left' | 'right' | 'top' | 'bottom'][] = [
    [dx, 'left'],
    [1 - dx, 'right'],
    [dy, 'top'],
    [1 - dy, 'bottom'],
  ];
  d.sort((a, b) => a[0] - b[0]);
  return d[0][1];
}
