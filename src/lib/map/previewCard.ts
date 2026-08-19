import type maplibregl from 'maplibre-gl';
import type { ClusterPoint, HoverPointData } from './mapLayers';

const CARD_CLASS = 'map-preview-card';
const LISTING_CARD_CLASS = 'map-listing-card';

let previewEl: HTMLDivElement | null = null;
let listingCardEl: HTMLDivElement | null = null;

function formatPrice(price: number): string {
  if (price >= 10000000) return `₹${(price / 10000000).toFixed(1)}Cr`;
  if (price >= 100000) return `₹${(price / 100000).toFixed(0)}L`;
  return `₹${price.toLocaleString('en-IN')}`;
}

function formatAedPrice(price: number): string {
  if (price >= 1000000) return `AED ${(price / 1000000).toFixed(2)}M`;
  return `AED ${price.toLocaleString()}`;
}

function detailHref(type?: string, id?: string): string {
  const base = type === 'project' ? '/projects/' : '/property/';
  return `${base}${id ?? ''}`;
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

function ensureListingCardEl(): HTMLDivElement {
  if (!listingCardEl) {
    listingCardEl = document.createElement('div');
    listingCardEl.className = LISTING_CARD_CLASS;
    listingCardEl.style.display = 'none';
    document.body.appendChild(listingCardEl);
  }
  return listingCardEl;
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
    <a href="${detailHref(point.type, point.id)}" target="_blank" rel="noopener noreferrer" class="map-preview-link">
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

export interface ListingPreviewData {
  id: string;
  entity_type: 'property' | 'project';
  lat: number | null;
  lon: number | null;
  title?: string;
  price?: number;
  low_price?: number | null;
  high_price?: number | null;
  image_url?: string | null;
  location_text?: string | null;
  area_sqft?: number | null;
  area_unit?: string | null;
  bhk_type?: string | null;
  bathrooms?: number | null;
  balconies?: number | null;
  property_type?: string | null;
  developer_name?: string | null;
  construction_phase?: string | null;
  delivery_date?: string | null;
}

// Zillow-style listing card shown when a map marker is clicked.
export function showListingPreviewCard(
  map: maplibregl.Map,
  listing: ListingPreviewData,
  lngLat: maplibregl.LngLat
): void {
  const el = ensureListingCardEl();
  const isProject = listing.entity_type === 'project';
  const placeholder = 'https://placehold.co/600x340/DEE4ED/3D4A5C?text=No+Image';
  const imgSrc = listing.image_url || placeholder;
  const priceText = isProject
    ? (listing.low_price
        ? (listing.high_price && listing.high_price !== listing.low_price
            ? `${formatAedPrice(listing.low_price)} — ${formatAedPrice(listing.high_price)}`
            : formatAedPrice(listing.low_price))
        : 'Price on request')
    : (listing.price ? formatPrice(listing.price) : 'Price on request');

  const specs: string[] = [];
  if (listing.bhk_type) specs.push(`${listing.bhk_type}`);
  if (listing.bathrooms != null && listing.bathrooms > 0) specs.push(`${listing.bathrooms} Bath`);
  if (listing.area_sqft && listing.area_sqft > 0) specs.push(`${Math.round(listing.area_sqft)} ${listing.area_unit || 'sqft'}`);
  if (listing.property_type) specs.push(titleCase(listing.property_type));
  if (isProject && listing.construction_phase) specs.push(titleCase(listing.construction_phase));
  const specsHtml = specs.length
    ? `<div class="map-listing-specs">${specs.map(s => `<span class="map-listing-spec">${s}</span>`).join('')}</div>`
    : '';

  el.innerHTML = `
    <button class="map-listing-close" title="Close">×</button>
    <div class="map-listing-img-wrap">
      <img src="${imgSrc}" class="map-listing-img" alt="${listing.title || ''}" loading="lazy"
        onerror="this.onerror=null;this.src='${placeholder}';" />
    </div>
    <div class="map-listing-body">
      <div class="map-listing-price">${priceText}</div>
      <div class="map-listing-title">${listing.title || ''}</div>
      ${listing.location_text ? `<div class="map-listing-address">${listing.location_text}</div>` : ''}
      ${specsHtml}
      ${listing.developer_name ? `<div class="map-listing-dev">${listing.developer_name}</div>` : ''}
      <a href="${detailHref(listing.entity_type, listing.id)}" target="_blank" rel="noopener noreferrer" class="map-listing-view">View Details →</a>
    </div>
  `;

  const closeBtn = el.querySelector('.map-listing-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideListingPreviewCard();
    });
  }

  el.style.display = 'block';
  positionAnchored(map, el, lngLat, 'right');
}

export function hideListingPreviewCard(): void {
  if (listingCardEl) {
    listingCardEl.style.display = 'none';
  }
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Anchor the listing card NEXT TO the marker: vertically centered on the
// marker's screen position and horizontally adjacent (flips to the other side
// when it would overflow the map container).
function positionAnchored(
  map: maplibregl.Map,
  el: HTMLElement,
  lngLat: maplibregl.LngLat,
  side: 'right' | 'left'
): void {
  const point = map.project(lngLat);
  const mapRect = map.getContainer().getBoundingClientRect();
  const elWidth = el.offsetWidth || 300;
  const elHeight = el.offsetHeight || 300;

  let left: number;
  const gap = 16;
  if (side === 'right') {
    left = mapRect.left + point.x + gap;
    if (left + elWidth > mapRect.left + mapRect.width - 10) {
      left = mapRect.left + point.x - elWidth - gap;
    }
  } else {
    left = mapRect.left + point.x - elWidth - gap;
    if (left < mapRect.left + 10) {
      left = mapRect.left + point.x + gap;
    }
  }

  let top = mapRect.top + point.y - elHeight / 2;
  if (top < mapRect.top + 10) top = mapRect.top + 10;
  if (top + elHeight > mapRect.top + mapRect.height - 10) {
    top = mapRect.top + mapRect.height - elHeight - 10;
  }

  el.style.position = 'absolute';
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.zIndex = '9999';
  el.style.pointerEvents = 'auto';
}

function positionElement(
  map: maplibregl.Map,
  el: HTMLElement,
  lngLat: maplibregl.LngLat,
  offset: { offsetX: number; offsetY: number }
): void {
  // map.project() returns coordinates relative to the map CONTAINER, but the
  // element is appended to document.body — so add the container's offset to
  // anchor the card/tag exactly next to the marker.
  const point = map.project(lngLat);
  const mapRect = map.getContainer().getBoundingClientRect();
  const elWidth = el.offsetWidth || 280;
  const elHeight = el.offsetHeight || 120;

  let left = mapRect.left + point.x + offset.offsetX;
  let top = mapRect.top + point.y + offset.offsetY;

  if (left + elWidth > mapRect.left + mapRect.width - 10) {
    left = mapRect.left + point.x - elWidth - offset.offsetX;
  }
  if (top + elHeight > mapRect.top + mapRect.height - 10) {
    top = mapRect.top + point.y - elHeight + Math.abs(offset.offsetY);
  }
  if (top < mapRect.top + 10) top = mapRect.top + 10;
  if (left < mapRect.left + 10) left = mapRect.left + 10;

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
  if (listingCardEl) {
    listingCardEl.remove();
    listingCardEl = null;
  }
}
