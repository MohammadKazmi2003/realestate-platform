import type maplibregl from 'maplibre-gl';
import type { ClusterPoint, HoverPointData } from './mapLayers';
import { formatMoneyCompact, formatArea, formatBedsList, formatPossession, formatProgress } from '@/lib/format';
import { tenant } from '@/lib/tenant';

const CARD_CLASS = 'map-preview-card';
const LISTING_CARD_CLASS = 'map-listing-card';

let previewEl: HTMLDivElement | null = null;
let listingCardEl: HTMLDivElement | null = null;
// Id of the point the hover preview currently shows (dedupe mousemove churn).
let lastHoverId: string | null = null;

function formatPrice(price: number): string {
  return formatMoneyCompact(price, tenant.propertyCurrency);
}

function formatAedPrice(price: number): string {
  return formatMoneyCompact(price, tenant.projectCurrency);
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
    // Single delegated listener for all card controls (close + carousel).
    // Attached once — showListingPreviewCard only rewrites innerHTML.
    listingCardEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('[data-action]') as HTMLElement | null;
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      if (action === 'close') {
        e.preventDefault();
        e.stopPropagation();
        hideListingPreviewCard();
      } else if (action === 'prev') {
        e.preventDefault();
        e.stopPropagation();
        stepListingCarousel(-1);
      } else if (action === 'next') {
        e.preventDefault();
        e.stopPropagation();
        stepListingCarousel(1);
      } else if (action === 'dot') {
        e.preventDefault();
        e.stopPropagation();
        const idx = Number(btn.getAttribute('data-idx') || '0');
        setListingCarouselIndex(idx);
      }
    });
  }
  return listingCardEl;
}

// Carousel + identity state for the currently open click card.
let cardImages: string[] = [];
let cardImageIndex = 0;
let openCardId: string | null = null;
let openCardAnchor: { lon: number; lat: number } | null = null;

/** Id of the listing whose fixed card is open, or null. */
export function listingCardId(): string | null {
  return openCardId;
}

/** Re-anchor the open card after pan/zoom (called on map 'move'). */
export function repositionListingCard(map: maplibregl.Map): void {
  if (!listingCardEl || !openCardAnchor) return;
  if (listingCardEl.style.display === 'none') return;
  positionAnchored(
    map,
    listingCardEl,
    { lng: openCardAnchor.lon, lat: openCardAnchor.lat } as maplibregl.LngLat,
    'right'
  );
}

function paintListingCarousel(): void {
  if (!listingCardEl) return;
  const img = listingCardEl.querySelector('.map-listing-img') as HTMLImageElement | null;
  if (img && cardImages[cardImageIndex]) {
    img.src = cardImages[cardImageIndex];
    img.setAttribute('decoding', 'async');
  }
  // Preload the next image only (not the whole gallery) — cheap lookahead.
  const next = cardImages[(cardImageIndex + 1) % cardImages.length];
  if (next) {
    const pre = new window.Image();
    pre.src = next;
  }
  const dots = listingCardEl.querySelectorAll('.map-listing-dot');
  dots.forEach((d, i) => {
    d.classList.toggle('active', i === cardImageIndex);
  });
  const counter = listingCardEl.querySelector('.map-listing-count');
  if (counter && cardImages.length > 1) {
    counter.textContent = `${cardImageIndex + 1} / ${cardImages.length}`;
  }
}

function setListingCarouselIndex(idx: number): void {
  if (cardImages.length === 0) return;
  cardImageIndex = ((idx % cardImages.length) + cardImages.length) % cardImages.length;
  paintListingCarousel();
}

function stepListingCarousel(delta: number): void {
  setListingCarouselIndex(cardImageIndex + delta);
}

export function showPropertyPreview(
  map: maplibregl.Map,
  point: ClusterPoint,
  lngLat: maplibregl.LngLat
): void {
  const el = ensurePreviewEl();
  // Same point as last mousemove: skip the innerHTML rebuild (prevents
  // flicker and wasted layout), just keep it anchored to the cursor.
  if (lastHoverId === point.id && el.style.display === 'block') {
    positionElement(map, el, lngLat, { offsetX: 12, offsetY: -40 });
    return;
  }
  lastHoverId = point.id;
  const entityLabel = point.type === 'project' ? 'Project' : 'Property';
  const priceText = point.price > 0
    ? (point.type === 'project' ? formatAedPrice(point.price) : formatPrice(point.price))
    : 'Price on request';

  const specs: string[] = [];
  if (point.bhk_type) specs.push(point.bhk_type);
  if (point.bathrooms != null && point.bathrooms > 0) specs.push(`${point.bathrooms} Bath`);
  const hoverArea = formatArea(point.area_sqft, point.area_unit);
  if (hoverArea) specs.push(hoverArea);
  if (point.balconies != null && point.balconies > 0) specs.push(`${point.balconies} Balcony`);
  if (point.furnishing_status) specs.push(point.furnishing_status);
  if (point.listing_purpose) {
    const lp = point.listing_purpose.trim().toLowerCase();
    specs.push(lp === 'rent' ? 'For Rent' : lp === 'sell' || lp === 'sale' ? 'For Sale' : `For ${point.listing_purpose.trim()}`);
  }
  const specsHtml = specs.length ? `<div class="map-preview-specs">${specs.join(' · ')}</div>` : '';
  const imgHtml = point.image_url
    ? `<div class="map-preview-img-wrap"><img src="${point.image_url}" class="map-preview-img" alt="" loading="lazy" onerror="this.style.display='none'" /></div>`
    : '';
  const newHtml = point.is_new ? `<span class="map-preview-new">New</span>` : '';
  const addrHtml = point.location_text ? `<div class="map-preview-addr">${point.location_text}</div>` : '';

  el.innerHTML = `
    <a href="${detailHref(point.type, point.id)}" target="_blank" rel="noopener noreferrer" class="map-preview-link">
      ${imgHtml}
      <div class="map-preview-content">
        <div class="map-preview-type">${entityLabel} ${newHtml}</div>
        <div class="map-preview-price">${priceText}</div>
        <div class="map-preview-title">${point.title || ''}</div>
        ${addrHtml}
        ${specsHtml}
      </div>
    </a>
  `;

  el.style.display = 'block';
  positionElement(map, el, lngLat, { offsetX: 12, offsetY: -40 });
}

export function hidePropertyPreview(): void {
  lastHoverId = null;
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
  /** Full gallery for the click carousel (API caps at 8). Falls back to image_url. */
  all_images?: string[] | null;
  location_text?: string | null;
  area_sqft?: number | null;
  area_unit?: string | null;
  bhk_type?: string | null;
  bathrooms?: number | null;
  balconies?: number | null;
  furnishing_status?: string | null;
  listing_purpose?: string | null;
  property_type?: string | null;
  developer_name?: string | null;
  construction_phase?: string | null;
  delivery_date?: string | null;
  amenities?: string[] | null;
  amenities_total?: number | null;
  bedrooms_list?: number[] | null;
  unit_count?: number | null;
  payment_plan_summary?: string | null;
  construction_progress_percent?: number | null;
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
  // Gallery: full fetched images when available, else the single tile image.
  const gallery = [...(listing.all_images || []), listing.image_url || ''].filter(
    (u): u is string => typeof u === 'string' && u.length > 0
  );
  cardImages = Array.from(new Set(gallery)).slice(0, 8);
  if (cardImages.length === 0) cardImages = [placeholder];
  cardImageIndex = 0;
  const imgSrc = cardImages[0];
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
  const areaLabel = formatArea(listing.area_sqft, listing.area_unit);
  if (areaLabel) specs.push(areaLabel);
  if (listing.balconies != null && listing.balconies > 0) specs.push(`${listing.balconies} Balcony`);
  if (listing.furnishing_status) specs.push(listing.furnishing_status);
  if (listing.listing_purpose) {
    const lp = listing.listing_purpose.trim().toLowerCase();
    specs.push(lp === 'rent' ? 'For Rent' : lp === 'sell' || lp === 'sale' ? 'For Sale' : `For ${listing.listing_purpose.trim()}`);
  }
  if (listing.property_type) specs.push(titleCase(listing.property_type));
  if (isProject && listing.construction_phase) specs.push(titleCase(listing.construction_phase));
  // Project richness: BHK configs, possession, payment plan, progress.
  const bedsSummary = isProject ? formatBedsList(listing.bedrooms_list) : null;
  if (bedsSummary) specs.push(bedsSummary);
  const progress = isProject ? formatProgress(listing.construction_progress_percent) : null;
  if (progress != null) specs.push(`${progress}% complete`);
  const possession = isProject ? formatPossession(listing.delivery_date) : null;
  const projectExtraHtml = isProject
    ? `${possession ? `<div class="map-listing-possession">Possession by ${possession}</div>` : ''}
       ${listing.payment_plan_summary ? `<div class="map-listing-payment">${listing.payment_plan_summary} payment plan</div>` : ''}`
    : '';
  const specsHtml = specs.length
    ? `<div class="map-listing-specs">${specs.map(s => `<span class="map-listing-spec">${s}</span>`).join('')}</div>`
    : '';
  // Amenity highlights live ONLY in this map-click card (not sidebar cards).
  // Shown for both properties and projects once full details are fetched.
  const amenityList = (listing.amenities || []).slice(0, 3);
  const amenityTotal = listing.amenities_total ?? (listing.amenities || []).length;
  const amenityExtra = Math.max(0, amenityTotal - amenityList.length);
  const amenitiesHtml = amenityList.length > 0
    ? `<div class="map-listing-amenities">${amenityList.map(a => `<span class="map-listing-amenity">${a}</span>`).join('')}${amenityExtra > 0 ? `<span class="map-listing-amenity-more">+${amenityExtra} more</span>` : ''}</div>`
    : '';
  const showLocation = listing.location_text && !isDuplicateLabel(listing.title, listing.location_text);

  el.innerHTML = `
    <button class="map-listing-close" title="Close" data-action="close">×</button>
    <div class="map-listing-img-wrap">
      <img src="${imgSrc}" class="map-listing-img" alt="${listing.title || ''}" loading="lazy" draggable="false"
        onerror="this.onerror=null;this.src='${placeholder}';" />
      ${cardImages.length > 1 ? `
        <button class="map-listing-prev" title="Previous" data-action="prev">‹</button>
        <button class="map-listing-next" title="Next" data-action="next">›</button>
        <div class="map-listing-dots">
          ${cardImages.map((_, i) => `<span class="map-listing-dot${i === 0 ? ' active' : ''}" data-action="dot" data-idx="${i}"></span>`).join('')}
        </div>
        <div class="map-listing-count">1 / ${cardImages.length}</div>
      ` : ''}
    </div>
    <div class="map-listing-body">
      <div class="map-listing-price">${priceText}</div>
      <div class="map-listing-title">${listing.title || ''}</div>
      ${showLocation ? `<div class="map-listing-address">${listing.location_text}</div>` : ''}
      ${specsHtml}
      ${amenitiesHtml}
      ${projectExtraHtml}
      ${listing.developer_name ? `<div class="map-listing-dev">${listing.developer_name}</div>` : ''}
      <a href="${detailHref(listing.entity_type, listing.id)}" target="_blank" rel="noopener noreferrer" class="map-listing-view">View Details →</a>
    </div>
  `;

  el.style.display = 'block';
  openCardId = listing.id;
  openCardAnchor = { lon: lngLat.lng, lat: lngLat.lat };
  positionAnchored(map, el, lngLat, 'right');
  paintListingCarousel();
}

export function hideListingPreviewCard(): void {
  if (listingCardEl) {
    listingCardEl.style.display = 'none';
  }
  openCardId = null;
  openCardAnchor = null;
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function isDuplicateLabel(first?: string | null, second?: string | null): boolean {
  if (!first || !second) return false;
  return first.trim().replace(/\s+/g, ' ').toLowerCase()
    === second.trim().replace(/\s+/g, ' ').toLowerCase();
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
