/**
 * Bottom sheet with three snap points (peek / half / full). Drag the handle
 * (touch or mouse via Pointer Events) or tap it to cycle. On wide screens the
 * CSS turns it into a fixed side panel and snapping is disabled.
 */
export type Snap = 'peek' | 'half' | 'full';

export function initSheet(sheet: HTMLElement, handle: HTMLElement, onInset?: (px: number) => void) {
  const wide = window.matchMedia('(min-width: 900px)');
  const order: Snap[] = ['peek', 'half', 'full'];
  let snap: Snap = 'peek';

  const heightFor = (s: Snap) => {
    const vh = window.innerHeight;
    return s === 'peek' ? 184 : s === 'half' ? Math.round(vh * 0.5) : Math.round(vh * 0.9);
  };
  const apply = (s: Snap) => {
    snap = s;
    sheet.dataset.snap = s;
    if (wide.matches) { sheet.style.height = ''; onInset?.(0); return; }
    sheet.style.height = `${heightFor(s)}px`;
    onInset?.(heightFor(s));
    handle.setAttribute('aria-expanded', String(s !== 'peek'));
  };

  let startY = 0, startH = 0, dragging = false, moved = false;
  handle.addEventListener('pointerdown', (e) => {
    if (wide.matches) return;
    dragging = true; moved = false;
    startY = e.clientY; startH = sheet.getBoundingClientRect().height;
    handle.setPointerCapture(e.pointerId);
    sheet.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    if (Math.abs(dy) > 6) moved = true;
    const h = Math.min(window.innerHeight * 0.95, Math.max(80, startH + dy));
    sheet.style.height = `${h}px`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove('dragging');
    if (!moved) { apply(order[(order.indexOf(snap) + 1) % order.length]); return; }
    const h = sheet.getBoundingClientRect().height;
    let best: Snap = 'peek';
    for (const s of order) if (Math.abs(heightFor(s) - h) < Math.abs(heightFor(best) - h)) best = s;
    apply(best);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(order[(order.indexOf(snap) + 1) % order.length]); }
  });
  wide.addEventListener('change', () => apply(snap));
  window.addEventListener('resize', () => apply(snap));
  apply('peek');
  return { open: (s: Snap) => apply(s), get snap() { return snap; } };
}
