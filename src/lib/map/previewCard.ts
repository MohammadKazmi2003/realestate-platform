import type maplibregl from 'maplibre-gl';
import type { ClusterPoint } from './clustering';

const CARD_CLASS = 'map-preview-card';
const CLUSTER_PANEL_CLASS = 'map-cluster-panel';

let previewEl: HTMLDivElement | null = null;
let clusterPanelEl: HTMLDivElement | null = null;

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

function ensureClusterPanelEl(): HTMLDivElement {
  if (!clusterPanelEl) {
    clusterPanelEl = document.createElement('div');
    clusterPanelEl.className = CLUSTER_PANEL_CLASS;
    clusterPanelEl.style.display = 'none';
    document.body.appendChild(clusterPanelEl);
  }
  return clusterPanelEl;
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
    <a href="/property/${point.id}" target="_blank" rel="noopener noreferrer" class="map-preview-link">
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

export function showClusterPreview(
  map: maplibregl.Map,
  leaves: ClusterPoint[],
  totalCount: number,
  lngLat: maplibregl.LngLat,
  onViewAll: () => void,
  avgPrice?: number,
  minPrice?: number,
  maxPrice?: number
): void {
  const el = ensureClusterPanelEl();

  const priceRange = minPrice && maxPrice && minPrice > 0
    ? `${formatPrice(minPrice)} — ${formatPrice(maxPrice)}`
    : avgPrice
      ? `Avg ${formatPrice(avgPrice)}`
      : '';

  const cardsHtml = leaves
    .slice(0, 5)
    .map((p) => {
      const imgSrc =
        p.image && p.image !== ''
          ? p.image
          : 'https://placehold.co/120x80/DEE4ED/3D4A5C?text=No+Image';
      return `
      <a href="/property/${p.id}" target="_blank" rel="noopener noreferrer" class="map-cluster-card">
        <img src="${imgSrc}" class="map-cluster-card-img" alt="${p.title || ''}" loading="lazy" />
        <div class="map-cluster-card-info">
          <div class="map-cluster-card-price">${formatPrice(p.price)}</div>
          <div class="map-cluster-card-title">${p.title || ''}</div>
        </div>
      </a>
    `;
    })
    .join('');

  el.innerHTML = `
    <div class="map-cluster-header">
      <span class="map-cluster-count">${totalCount} listings</span>
      ${priceRange ? `<span class="map-cluster-price">${priceRange}</span>` : ''}
    </div>
    <div class="map-cluster-cards">${cardsHtml}</div>
    <button class="map-cluster-view-all">View all ${totalCount} properties →</button>
  `;

  const viewAllBtn = el.querySelector('.map-cluster-view-all');
  if (viewAllBtn) {
    viewAllBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onViewAll();
    });
  }

  el.style.display = 'block';
  positionElement(map, el, lngLat, { offsetX: 12, offsetY: -20 });
}

export function hideClusterPreview(): void {
  if (clusterPanelEl) {
    clusterPanelEl.style.display = 'none';
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
  if (clusterPanelEl) {
    clusterPanelEl.remove();
    clusterPanelEl = null;
  }
}
