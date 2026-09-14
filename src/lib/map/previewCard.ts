import type maplibregl from 'maplibre-gl';
import type { ClusterPoint, HoverPointData } from './mapLayers';
import { formatMoneyCompact, formatArea, formatBedsList, formatPossession, formatProgress } from '@/lib/format';
import { tenant } from '@/lib/tenant';
import { highlightAmenities } from '@/lib/amenityHighlight';

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
/** Max visible dots — longer galleries scroll the track. */
const MAX_DOTS = 5;
/** Fixed px width of one dot slot — the track translates in slot steps. */
const MAP_DOT_SLOT = 10;
const PLACEHOLDER_IMG = 'https://placehold.co/600x340/DEE4ED/3D4A5C?text=No+Image';
// Bare white chevrons (no button chrome) — minimal affordance next to the
// invisible side tap zones. Drop-shadow keeps them readable on any photo.
const CHEVRON_LEFT = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,0.85))"><path d="M15 18l-6-6 6-6"/></svg>`;
const CHEVRON_RIGHT = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,0.85))"><path d="M9 18l6-6-6-6"/></svg>`;

/** Arrows + invisible side tap zones. Zones (32% each edge) let users tap
 * either side without precision-aiming; arrows are the visual affordance. */
function carouselControlsHtml(count: string): string {
  return `
    <button class="map-listing-zone map-listing-zone-prev" data-action="prev" aria-label="Previous image"></button>
    <button class="map-listing-zone map-listing-zone-next" data-action="next" aria-label="Next image"></button>
    <button class="map-listing-prev" title="Previous" aria-label="Previous image" data-action="prev">${CHEVRON_LEFT}</button>
    <button class="map-listing-next" title="Next" aria-label="Next image" data-action="next">${CHEVRON_RIGHT}</button>
    <div class="map-listing-dots"></div>
    <div class="map-listing-count">${count}</div>`;
}
// Two stacked <img> layers enable true slide transitions: the incoming photo
// slides in while the outgoing slides out, and the old photo stays visible
// until the new one has decoded — never a blank frame between images.
let imgLayerA: HTMLImageElement | null = null;
let imgLayerB: HTMLImageElement | null = null;
let frontLayer: HTMLImageElement | null = null;
/** Raw URL currently shown on the front layer (for upgrade comparison). */
let frontSrc = '';
/** Guards against out-of-order preloads when swiping rapidly. */
let slideToken = 0;

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

function parkedTransform(dir: number): string {
  return `translateX(${dir * 100}%)`;
}

function dotWindowStart(): number {
  return galleryDotWindowStart(cardImageIndex, cardImages.length);
}

/** Sliding dot-window start: keeps ~5 dots visible with the selected one
 * travelling through the window; clamps at both ends and resets on loop. */
export function galleryDotWindowStart(selected: number, total: number, max: number = MAX_DOTS): number {
  if (total <= max) return 0;
  return Math.min(Math.max(selected - 2, 0), total - max);
}

/** Repaints the sliding dot window + counter without touching the photos.
 * Dots live on an animated track inside a fixed 5-slot viewport: advancing
 * translates the track one slot (old dot exits, new dot enters) while the
 * active dot also travels within the window near the edges. The track is
 * rebuilt only when the gallery itself changes; selection only moves it. */
let dotsTrackKey = '';
function paintDotsAndCounter(): void {
  if (!listingCardEl) return;
  const dotsEl = listingCardEl.querySelector('.map-listing-dots') as HTMLElement | null;
  if (dotsEl && cardImages.length > 1) {
    const key = `${cardImages.length}|${cardImages[0]}|${cardImages[cardImages.length - 1]}`;
    if (dotsTrackKey !== key) {
      dotsTrackKey = key;
      dotsEl.innerHTML = `<div class="map-listing-track">${cardImages
        .map(
          (_, i) =>
            `<span class="map-listing-slot"><span class="map-listing-dot" data-action="dot" data-idx="${i}"></span></span>`
        )
        .join('')}</div>`;
    }
    const start = dotWindowStart();
    const trackEl = dotsEl.querySelector('.map-listing-track') as HTMLElement | null;
    if (trackEl) {
      trackEl.style.width = `${cardImages.length * MAP_DOT_SLOT}px`;
      trackEl.style.transform = `translateX(${-start * MAP_DOT_SLOT}px)`;
    }
    dotsEl.style.width = `${Math.min(cardImages.length, MAX_DOTS) * MAP_DOT_SLOT}px`;
    dotsEl.querySelectorAll('.map-listing-dot').forEach((d, i) => {
      d.classList.toggle('active', i === cardImageIndex);
    });
  }
  const counter = listingCardEl.querySelector('.map-listing-count');
  if (counter && cardImages.length > 1) {
    counter.textContent = `${cardImageIndex + 1} / ${cardImages.length}`;
  }
}

/** Preloads only the adjacent slides — cheap lookahead, bounded memory. */
function preloadAdjacent(): void {
  if (typeof window === 'undefined' || cardImages.length <= 1) return;
  const n = cardImages.length;
  [cardImageIndex + 1, cardImageIndex - 1].forEach((i) => {
    const src = cardImages[((i % n) + n) % n];
    if (src && src !== PLACEHOLDER_IMG) {
      const pre = new window.Image();
      pre.decoding = 'async';
      pre.src = src;
    }
  });
}

/**
 * True sliding transition: the target photo is decoded offscreen first, then
 * slides in while the current photo slides out. The old photo stays visible
 * until the new one is ready, so swiping never shows a blank frame. Cached
 * (already-decoded) targets transition immediately.
 *
 * Calm, clearly-visible slide (0.55s ease-out) — deliberately more relaxed
 * than the grid carousels' snappy 0.3–0.5s Embla feel.
 */
function showSlide(idx: number, dir: 1 | -1): void {
  if (!listingCardEl || cardImages.length === 0) return;
  const n = cardImages.length;
  idx = ((idx % n) + n) % n;
  const reduceMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const incoming = frontLayer === imgLayerA ? imgLayerB : imgLayerA;
  const outgoing = frontLayer;
  // First paint / missing layers / reduced motion: instant, no animation.
  if (!incoming || !outgoing || !outgoing.src || reduceMotion) {
    cardImageIndex = idx;
    if (incoming) {
      incoming.style.transition = 'none';
      incoming.style.transform = 'translateX(0)';
      incoming.style.opacity = '1';
      incoming.style.zIndex = '1';
      incoming.src = cardImages[idx];
    }
    if (outgoing && outgoing !== incoming) {
      outgoing.style.transition = 'none';
      outgoing.style.opacity = '0';
      outgoing.style.zIndex = '0';
    }
    frontLayer = incoming;
    frontSrc = cardImages[idx];
    paintDotsAndCounter();
    preloadAdjacent();
    return;
  }

  const myToken = ++slideToken;
  const commit = () => {
    if (myToken !== slideToken || !listingCardEl) return;
    cardImageIndex = idx;
    frontSrc = cardImages[idx];
    incoming.style.transition = 'none';
    incoming.src = cardImages[idx];
    incoming.style.transform = parkedTransform(dir);
    incoming.style.opacity = '1';
    incoming.style.zIndex = '2';
    outgoing.style.zIndex = '1';
    // Force reflow so the parked position applies before transitioning.
    void incoming.offsetWidth;
    incoming.style.transition = 'transform 0.55s cubic-bezier(0.25, 1, 0.5, 1)';
    outgoing.style.transition = 'transform 0.55s cubic-bezier(0.25, 1, 0.5, 1)';
    incoming.style.transform = 'translateX(0)';
    outgoing.style.transform = parkedTransform(-dir);
    let finished = false;
    const finish = () => {
      if (finished || myToken !== slideToken) return;
      finished = true;
      outgoing.style.transition = 'none';
      outgoing.style.opacity = '0';
      outgoing.style.transform = 'translateX(0)';
      outgoing.style.zIndex = '0';
      frontLayer = incoming;
    };
    // transitionend is unreliable if the card closes mid-flight — the timer wins.
    incoming.addEventListener('transitionend', finish, { once: true });
    window.setTimeout(finish, 650);
    paintDotsAndCounter();
    preloadAdjacent();
  };

  // Decode offscreen first; the visible photo is untouched until load.
  const probe = new window.Image();
  probe.decoding = 'async';
  probe.onload = commit;
  // Broken target still slides (to the error placeholder) rather than hanging.
  probe.onerror = commit;
  probe.src = cardImages[idx];
}

function setListingCarouselIndex(idx: number): void {
  if (cardImages.length === 0) return;
  const n = cardImages.length;
  const next = ((idx % n) + n) % n;
  if (next === cardImageIndex) {
    paintDotsAndCounter();
    return;
  }
  // Loop-aware direction so wrap-around slides the short way.
  let dir: 1 | -1;
  if (cardImageIndex === n - 1 && next === 0) dir = 1;
  else if (cardImageIndex === 0 && next === n - 1) dir = -1;
  else dir = next > cardImageIndex ? 1 : -1;
  showSlide(next, dir);
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
  /** Full gallery (uncapped). Only the visible slide + adjacent preloads
   * ever hit the network — 20+ photos cost ~1 download until swiped. */
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

// Full gallery, uncapped — only the visible slide + adjacent preloads ever
// hit the network, so 20+ photos cost ~1 download until the user swipes.
function listingGallery(listing: ListingPreviewData): string[] {
  const gallery = [...(listing.all_images || []), listing.image_url || ''].filter(
    (u): u is string => typeof u === 'string' && u.length > 0
  );
  const deduped = Array.from(new Set(gallery));
  return deduped.length > 0 ? deduped : [PLACEHOLDER_IMG];
}

function listingBodyHtml(listing: ListingPreviewData, isProject: boolean): string {
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
  // Curated premium names first (tenant config), remainder in index order.
  const amenityList = highlightAmenities(listing.amenities);
  const amenityTotal = listing.amenities_total ?? (listing.amenities || []).length;
  const amenityExtra = Math.max(0, amenityTotal - amenityList.length);
  const amenitiesHtml = amenityList.length > 0
    ? `<div class="map-listing-amenities">${amenityList.map(a => `<span class="map-listing-amenity">${a}</span>`).join('')}${amenityExtra > 0 ? `<span class="map-listing-amenity-more">+${amenityExtra} more</span>` : ''}</div>`
    : '';
  const showLocation = listing.location_text && !isDuplicateLabel(listing.title, listing.location_text);

  return `
      <div class="map-listing-price">${priceText}</div>
      <div class="map-listing-title">${listing.title || ''}</div>
      ${showLocation ? `<div class="map-listing-address">${listing.location_text}</div>` : ''}
      ${specsHtml}
      ${amenitiesHtml}
      ${projectExtraHtml}
      ${listing.developer_name ? `<div class="map-listing-dev">${listing.developer_name}</div>` : ''}
      <a href="${detailHref(listing.entity_type, listing.id)}" target="_blank" rel="noopener noreferrer" class="map-listing-view">View Details →</a>
  `;
}

// Zillow-style listing card shown when a map marker is clicked.
export function showListingPreviewCard(
  map: maplibregl.Map,
  listing: ListingPreviewData,
  lngLat: maplibregl.LngLat
): void {
  const el = ensureListingCardEl();
  const isProject = listing.entity_type === 'project';

  // Same card already open (instant tile render → fetched upgrade, or repeat
  // click): patch text content in place WITHOUT destroying the photo layers.
  // The visible first image never flashes and its download never restarts —
  // this is what keeps the card feeling instant.
  if (openCardId === listing.id && el.style.display !== 'none' && imgLayerA && imgLayerB) {
    cardImages = listingGallery(listing);
    openCardAnchor = { lon: lngLat.lng, lat: lngLat.lat };
    const body = el.querySelector('.map-listing-body');
    if (body) body.innerHTML = listingBodyHtml(listing, isProject);
    // The gallery can grow (tile 1 → fetched N) or shrink: rebuild controls
    // to match, then repaint. Photo layers are untouched — no flash.
    el.querySelectorAll('.map-listing-prev,.map-listing-next,.map-listing-dots,.map-listing-count')
      .forEach((n) => n.remove());
    if (cardImages.length > 1) {
      el.querySelector('.map-listing-img-wrap')?.insertAdjacentHTML(
        'beforeend',
        carouselControlsHtml(`${cardImageIndex + 1} / ${cardImages.length}`)
      );
    }
    const keepIdx = cardImages.indexOf(frontSrc);
    if (keepIdx >= 0) {
      cardImageIndex = keepIdx;
      paintDotsAndCounter();
      preloadAdjacent();
    } else {
      showSlide(0, 1);
    }
    return;
  }

  cardImages = listingGallery(listing);
  cardImageIndex = 0;
  const imgSrc = cardImages[0];
  // Invalidate any in-flight slide from the previously open card.
  slideToken++;

  el.innerHTML = `
    <button class="map-listing-close" title="Close" data-action="close">×</button>
    <div class="map-listing-img-wrap">
      <img src="${imgSrc}" class="map-listing-img map-listing-slide" alt="${listing.title || ''}" loading="eager" fetchpriority="high" decoding="async" draggable="false"
        onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}';" />
      <img class="map-listing-img map-listing-slide" alt="" decoding="async" draggable="false" style="opacity:0"
        onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}';" />
      ${cardImages.length > 1 ? carouselControlsHtml(`1 / ${cardImages.length}`) : ''}
    </div>
    <div class="map-listing-body">
      ${listingBodyHtml(listing, isProject)}
    </div>
  `;

  const layers = el.querySelectorAll('.map-listing-slide');
  imgLayerA = layers[0] as HTMLImageElement;
  imgLayerB = (layers[1] as HTMLImageElement) || null;
  frontLayer = imgLayerA;
  frontSrc = imgSrc;
  dotsTrackKey = ''; // fresh DOM — force track rebuild below

  el.style.display = 'block';
  openCardId = listing.id;
  openCardAnchor = { lon: lngLat.lng, lat: lngLat.lat };
  positionAnchored(map, el, lngLat, 'right');
  paintDotsAndCounter();
  preloadAdjacent();
}

export function hideListingPreviewCard(): void {
  // Cancel any in-flight slide so a late preload can't commit to a hidden card.
  slideToken++;
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
  slideToken++;
  if (previewEl) {
    previewEl.remove();
    previewEl = null;
  }
  if (listingCardEl) {
    listingCardEl.remove();
    listingCardEl = null;
  }
  imgLayerA = imgLayerB = frontLayer = null;
  frontSrc = '';
  cardImages = [];
  cardImageIndex = 0;
}
