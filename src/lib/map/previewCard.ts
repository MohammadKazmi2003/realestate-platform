import type maplibregl from 'maplibre-gl';
import type { ClusterPoint, HoverPointData } from './mapLayers';

const CARD_CLASS = 'map-preview-card';
const HOVER_LABEL_CLASS = 'map-hover-label';

let previewEl: HTMLDivElement | null = null;
let hoverLabelEl: HTMLDivElement | null = null;

function formatPrice(price: number): string {
  if (price >= 10000000) return `₹${(price / 10000000).toFixed(1)}Cr`;
  if (price >= 100000) return `₹${(price / 100000).toFixed(0)}L`;
  return `₹${price.toLocaleString('en-IN')}`;
}

function ensurePreviewEl(): HTMLDivElement {
  if (!previewEl) {
    previewEl = document.createElement('div');
    previewEl.className = CARD_CLASS;
    previewEl.style.display = 'none';
    document.body.appendChild(previewEl);
  }
  return previewEl;
}

function ensureHoverLabelEl(): HTMLDivElement {
  if (!hoverLabelEl) {
    hoverLabelEl = document.createElement('div');
    hoverLabelEl.className = HOVER_LABEL_CLASS;
    hoverLabelEl.style.display = 'none';
    document.body.appendChild(hoverLabelEl);
  }
  return hoverLabelEl;
}

function detailLink(point: ClusterPoint | HoverPointData): string {
  const base = point.type === 'project' ? '/projects/' : '/property/';
  return `${base}${point.id}`;
}

export function showPropertyPreview(
  map: maplibregl.Map,
  point: ClusterPoint,
  lngLat: maplibregl.LngLat
): void {
  const el = ensurePreviewEl();
  const imgSrc =
    point.image && point.image !== ''
      ? point.image
      : 'https://placehold.co/300x200/DEE4ED/3D4A5C?text=No+Image';

  const details = [point.bedrooms, point.area].filter(Boolean).join(' · ');

  el.innerHTML = `
    <a href="${detailLink(point)}" target="_blank" rel="noopener noreferrer" class="map-preview-link">
      <img src="${imgSrc}" class="map-preview-image" alt="${point.title || ''}" loading="lazy" />
      <div class="map-preview-content">
        <div class="map-preview-price">${formatPrice(point.price)}</div>
        <div class="map-preview-title">${point.title || ''}</div>
        ${details ? `<div class="map-preview-details">${details}</div>` : ''}
        <div class="map-preview-location">${point.location || ''}</div>
      </div>
    </a>
  `;

  el.style.display = 'block';
  positionElement(map, el, lngLat, { offsetX: 12, offsetY: -40 });
}

export function hidePropertyPreview(): void {
  if (previewEl) {
    previewEl.style.display = 'none';
  }
}

// Slim label shown next to the pinned dot when a sidebar card is hovered.
export function showHoverPinLabel(
  map: maplibregl.Map,
  point: HoverPointData,
  lngLat: maplibregl.LngLat
): void {
  const el = ensureHoverLabelEl();
  el.innerHTML = `
    <a href="${detailLink(point)}" target="_blank" rel="noopener noreferrer" class="map-hover-label-link">
      ${point.price != null && point.price > 0 ? `<span class="map-hover-label-price">${formatPrice(point.price)}</span>` : ''}
      ${point.title ? `<span class="map-hover-label-title">${point.title}</span>` : ''}
    </a>
  `;
  el.style.display = 'block';
  positionElement(map, el, lngLat, { offsetX: 14, offsetY: -46 });
}

export function hideHoverPinLabel(): void {
  if (hoverLabelEl) {
    hoverLabelEl.style.display = 'none';
  }
}

function positionElement(
  map: maplibregl.Map,
  el: HTMLElement,
  lngLat: maplibregl.LngLat,
  offset: { offsetX: number; offsetY: number }
): void {
  const point = map.project(lngLat);
  const mapRect = map.getContainer().getBoundingClientRect();
  const elWidth = el.offsetWidth || 280;
  const elHeight = el.offsetHeight || 120;

  let left = point.x + offset.offsetX;
  let top = point.y + offset.offsetY;

  if (left + elWidth > mapRect.width - 10) {
    left = point.x - elWidth - offset.offsetX;
  }
  if (top + elHeight > mapRect.height - 10) {
    top = point.y - elHeight + Math.abs(offset.offsetY);
  }
  if (top < 10) top = 10;
  if (left < 10) left = 10;

  el.style.position = 'absolute';
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.zIndex = '9999';
  el.style.pointerEvents = 'auto';
}

export function destroyPreviewCards(): void {
  if (previewEl) {
    previewEl.remove();
    previewEl = null;
  }
  if (hoverLabelEl) {
    hoverLabelEl.remove();
    hoverLabelEl = null;
  }
}
