// Lightweight hover tooltip for state/emirate polygons.
//
// Mirrors the existing hover-preview pattern (single body-level, non-interactive
// element) but positions against the map container's on-screen rect using the
// event point — no projection needed, and it can't capture pointer events and
// cause hover flicker.
import type { Map as MLMap } from 'maplibre-gl';

let el: HTMLDivElement | null = null;
let lastKey = '';

function ensureEl(): HTMLDivElement {
  if (el) return el;
  el = document.createElement('div');
  el.className = 'map-state-tooltip';
  el.setAttribute('aria-hidden', 'true');
  el.style.display = 'none';
  document.body.appendChild(el);
  return el;
}

function place(map: MLMap, point: { x: number; y: number }) {
  const node = ensureEl();
  const rect = map.getContainer().getBoundingClientRect();
  const pad = 12;
  const width = node.offsetWidth || 160;
  const height = node.offsetHeight || 40;
  let left = rect.left + point.x + pad;
  let top = rect.top + point.y + pad;
  if (left + width > window.innerWidth - 8) left = rect.left + point.x - width - pad;
  if (top + height > window.innerHeight - 8) top = rect.top + point.y - height - pad;
  node.style.left = `${Math.max(8, left)}px`;
  node.style.top = `${Math.max(8, top)}px`;
}

export function showStateTooltip(
  map: MLMap,
  point: { x: number; y: number },
  name: string,
  countText?: string | null
) {
  const node = ensureEl();
  const key = `${name}|${countText ?? ''}`;
  if (key !== lastKey) {
    node.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'map-state-tooltip-name';
    title.textContent = name;
    node.appendChild(title);
    if (countText) {
      const sub = document.createElement('div');
      sub.className = 'map-state-tooltip-count';
      sub.textContent = countText;
      node.appendChild(sub);
    }
    lastKey = key;
  }
  node.style.display = 'block';
  place(map, point);
}

export function hideStateTooltip() {
  if (!el) return;
  el.style.display = 'none';
  lastKey = '';
}

export function destroyStateTooltip() {
  if (el && el.parentNode) el.parentNode.removeChild(el);
  el = null;
  lastKey = '';
}
