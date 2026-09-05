import maplibregl from 'maplibre-gl';

const SOURCE_ID = 'browse-points';
const HIGHLIGHT_SOURCE_ID = 'highlight-point';
const HIGHLIGHT_PIN_IMAGE = 'price-marker-icon';

const LAYERS = {
  unclusteredProperties: 'unclustered-properties',
  unclusteredProjects: 'unclustered-projects',
  markerPrice: 'marker-price',
  highlightedPin: 'highlighted-pin',
} as const;

const PROPERTY_COLOR = '#2563EB';
const PROJECT_COLOR = '#059669';

// Lightweight data available for a map point and its hover preview. This is
// intentionally limited to fields returned by the marker query.
export interface ClusterPoint {
  id: string;
  type: 'property' | 'project';
  title: string;
  price: number;
  latitude: number;
  longitude: number;
  image_url?: string | null;
  bhk_type?: string | null;
  bathrooms?: number | null;
  area_sqft?: number | null;
  area_unit?: string | null;
  location_text?: string | null;
  is_new?: boolean;
}

export interface HoverPointData {
  id?: string;
  lat: number;
  lon: number;
  title?: string;
  price?: number;
  price_label?: string;
  image?: string;
  location?: string;
  type?: 'property' | 'project';
}

// Minimalist dot radius that grows gently with zoom. Small at country zoom
// so dense regions read as density (Zillow-style) instead of one big blob.
function getCircleRadius(zoom: number): number {
  if (zoom < 6) return 5;
  if (zoom < 12) return 7;
  if (zoom < 14) return 8;
  if (zoom < 16) return 9;
  return 10;
}

// Soft dark halo under each dot — gives the markers a subtle lift and depth
// (Zillow-style) without looking flat or low-quality.
const DOT_HALO_RADIUS = 4;
const DOT_HALO_OPACITY = 0.28;
const DOT_HALO_BLUR = 0.5;

function dotPaint(color: string, zoom: number): any {
  return {
    'circle-color': color,
    'circle-radius': getCircleRadius(zoom),
    'circle-stroke-width': 2,
    'circle-stroke-color': '#ffffff',
    'circle-opacity': ['case', ['==', ['feature-state', 'hidden'], true], 0, 0.95],
  };
}

function dotHaloPaint(zoom: number): any {
  return {
    'circle-color': '#0f172a',
    'circle-radius': getCircleRadius(zoom) + DOT_HALO_RADIUS,
    'circle-opacity': ['case', ['==', ['feature-state', 'hidden'], true], 0, DOT_HALO_OPACITY],
    'circle-blur': DOT_HALO_BLUR,
    'circle-stroke-width': 0,
  };
}

// Generate the speech-bubble BACKGROUND image: a standard white rounded
// rectangle with a sharp triangular stem at the bottom whose TIP points at the
// map coordinate. The price is NOT baked into this raster — it is rendered on
// top as a real MapLibre vector text label so it stays crisp at every zoom/DPR.
// The WIDTH hugs the label (a small fixed padding on each side) so the bubble
// stays compact; the HEIGHT is fixed so the stem tip anchor never moves.
const BUBBLE_FONT = "700 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const BUBBLE_PADDING = 6;
const BUBBLE_MIN_WIDTH = 48;
const BUBBLE_HEIGHT = 48;

function createBubbleImageData(width: number, _priceLabel: string): ImageData {
  const W = width;
  const H = BUBBLE_HEIGHT;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new ImageData(W, H);

  const bubbleX = 0;
  const bubbleW = W;
  const bubbleY = 1;
  const bubbleH = 30;
  const bubbleY2 = bubbleY + bubbleH;
  const stemW = 18;
  const tipX = W / 2;
  const tipY = H - 1; // stem tip = the map coordinate anchor
  const radius = 8;
  const stemLeft = tipX - stemW / 2;
  const stemRight = tipX + stemW / 2;

  // Speech-bubble outline: rounded rect + sharp downward stem, drawn as ONE
  // path so the fill, border, and shadow form a single connected marker.
  const bubblePath = () => {
    ctx.beginPath();
    ctx.moveTo(bubbleX + radius, bubbleY);
    ctx.arcTo(bubbleX + bubbleW, bubbleY, bubbleX + bubbleW, bubbleY + bubbleH, radius);
    ctx.arcTo(bubbleX + bubbleW, bubbleY + bubbleH, bubbleX, bubbleY + bubbleH, radius);
    ctx.lineTo(stemRight, bubbleY2);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(stemLeft, bubbleY2);
    ctx.arcTo(bubbleX, bubbleY + bubbleH, bubbleX, bubbleY, radius);
    ctx.arcTo(bubbleX, bubbleY, bubbleX + bubbleW, bubbleY, radius);
    ctx.closePath();
  };

  // Shadow — offsets the whole marker so it floats above the map
  ctx.save();
  ctx.shadowColor = 'rgba(15, 23, 42, 0.35)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = '#ffffff';
  bubblePath();
  ctx.fill();
  ctx.restore();

  // Crisp border — miter join keeps the stem tip a sharp point
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.14)';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 4;
  bubblePath();
  ctx.stroke();

  return ctx.getImageData(0, 0, W, H);
}

// Generate a snug bubble image for the given price label. Returns its key
// (measured width) and ImageData; distinct widths are cached as distinct
// images (map.updateImage requires identical sizes, so per-width addImage is
// the way to vary bubble width per highlight).
function createBubbleImage(priceLabel: string): { width: number; imageData: ImageData } {
  const width = getBubbleWidth(priceLabel);
  return { width, imageData: createBubbleImageData(width, priceLabel) };
}

function getBubbleWidth(priceLabel: string): number {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return 48;
  ctx.font = BUBBLE_FONT;
  const textW = priceLabel ? Math.ceil(ctx.measureText(priceLabel).width) : 0;
  return Math.max(textW + BUBBLE_PADDING * 2, 48);
}

// Ensure a bubble image exists for the given price label; returns the image
// name to use as the highlight feature's `icon_image`.
function getBubbleImage(map: maplibregl.Map, priceLabel: string): string {
  const { width, imageData } = createBubbleImage(priceLabel);
  const name = `bubble-${width}`;
  if (!map.hasImage(name)) {
    map.addImage(name, imageData);
  }
  return name;
}

export function setupMapLayers(map: maplibregl.Map): void {
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      // Markers carry their id in properties.id — promote it so feature-state
      // (used to hide a marker while its speech bubble is showing) works.
      promoteId: 'id',
      // NOTE: no server- or client-side count clustering here on purpose.
      // Density is conveyed by the dots themselves (Zillow-style): the server
      // returns density-proportional sampled points and the browser renders
      // them 1:1. No cluster:true — that collapsed everything into count
      // circles and hid the distribution.
    });
  }

  // High-quality Zillow-style dots: a soft dark halo underneath a crisp,
  // larger dot with a clean white outline. The highlighted listing's own dot
  // (and halo) is hidden while its speech bubble is showing.
  // Each layer is added only if missing, so setupMapLayers is safe to call
  // again after a style reload wipes custom layers.
  const addLayerOnce = (spec: any) => {
    if (!map.getLayer(spec.id)) map.addLayer(spec);
  };
  const propertyHalo = `${LAYERS.unclusteredProperties}-halo`;
  const projectHalo = `${LAYERS.unclusteredProjects}-halo`;

  addLayerOnce({
    id: propertyHalo,
    type: 'circle',
    source: SOURCE_ID,
    filter: ['==', ['get', 'type'], 'property'],
    paint: dotHaloPaint(map.getZoom()),
  });

  addLayerOnce({
    id: projectHalo,
    type: 'circle',
    source: SOURCE_ID,
    filter: ['==', ['get', 'type'], 'project'],
    paint: dotHaloPaint(map.getZoom()),
  });

  addLayerOnce({
    id: LAYERS.unclusteredProperties,
    type: 'circle',
    source: SOURCE_ID,
    filter: ['==', ['get', 'type'], 'property'],
    paint: dotPaint(PROPERTY_COLOR, map.getZoom()),
  });

  addLayerOnce({
    id: LAYERS.unclusteredProjects,
    type: 'circle',
    source: SOURCE_ID,
    filter: ['==', ['get', 'type'], 'project'],
    paint: dotPaint(PROJECT_COLOR, map.getZoom()),
  });

  // Zillow-style price labels on the densest dots. Collision detection hides
  // labels that would overlap, so only the top labels by sort key show.
  addLayerOnce({
    id: LAYERS.markerPrice,
    type: 'symbol',
    source: SOURCE_ID,
    layout: {
      'text-field': ['coalesce', ['get', 'price_label'], ''],
      'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
      'text-size': 11,
      'text-offset': [0, -1.3],
      'text-anchor': 'bottom',
      'symbol-sort-key': ['get', 'sort_key'],
      'text-allow-overlap': false,
      'text-ignore-placement': false,
    },
    paint: {
      'text-color': '#111827',
      'text-halo-color': '#ffffff',
      'text-halo-width': 2,
      'text-halo-blur': 0.5,
    },
  });

  if (!map.getSource(HIGHLIGHT_SOURCE_ID)) {
    map.addSource(HIGHLIGHT_SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
  }

  // Default bubble image (empty label) — fallback for the coalesce below.
  if (!map.hasImage(HIGHLIGHT_PIN_IMAGE)) {
    const { imageData } = createBubbleImage('');
    map.addImage(HIGHLIGHT_PIN_IMAGE, imageData);
  }

  // The speech-bubble marker: white bubble icon (anchored at its stem tip =
  // the listing's exact location) with the PRICE rendered as real vector text
  // centered inside the bubble — crisp at every zoom, never rasterized. The
  // icon image is picked per highlight via `icon_image`, so the bubble width
  // hugs the price label instead of being oversized.
  addLayerOnce({
    id: LAYERS.highlightedPin,
    type: 'symbol',
    source: HIGHLIGHT_SOURCE_ID,
    layout: {
      'icon-image': ['coalesce', ['get', 'icon_image'], HIGHLIGHT_PIN_IMAGE],
      'icon-anchor': 'bottom',
      'icon-size': 1,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'text-field': ['coalesce', ['get', 'price_label'], ''],
      'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
      'text-size': 13,
      'text-anchor': 'center',
      // Bubble body center sits ~32px above the anchor point (icon 48px tall,
      // body 30px) — in ems of the 13px text. Constant because bubble height
      // never changes, only the width.
      'text-offset': [0, -2.4],
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: {
      'text-color': '#0f172a',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1,
      'text-halo-blur': 0.5,
    },
  });
}

export function updateSourceData(
  map: maplibregl.Map,
  data: GeoJSON.FeatureCollection
): void {
  let source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (!source) {
    // Style reloads wipe custom sources/layers — rebuild them on demand.
    try {
      setupMapLayers(map);
    } catch {
      return;
    }
    source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  }
  if (source) {
    source.setData(data);
  }
}

export function updateCircleRadius(map: maplibregl.Map, zoom: number): void {
  const radius = getCircleRadius(zoom);
  const haloRadius = radius + DOT_HALO_RADIUS;
  const dots = [LAYERS.unclusteredProperties, LAYERS.unclusteredProjects];
  const halos = [`${LAYERS.unclusteredProperties}-halo`, `${LAYERS.unclusteredProjects}-halo`];
  for (const layerId of dots) {
    try {
      // setPaintProperty on a missing layer fires a map 'error' event instead
      // of throwing (so try/catch alone can't suppress it) — guard first.
      // Layers vanish on style reload / unmount while a fetch is in flight.
      if (!map.getLayer(layerId)) continue;
      map.setPaintProperty(layerId, 'circle-radius', radius as any);
    } catch {
      // layer might not exist yet
    }
  }
  for (const layerId of halos) {
    try {
      if (!map.getLayer(layerId)) continue;
      map.setPaintProperty(layerId, 'circle-radius', haloRadius as any);
    } catch {
      // layer might not exist yet
    }
  }
}

// While a listing's speech bubble is shown, hide its base dot so the marker
// reads as one clean unit (the stem tip already marks the exact coordinate).
export function setHighlightState(map: maplibregl.Map, id: string | null): void {
  if (!id) {
    map.removeFeatureState({ source: SOURCE_ID });
    return;
  }
  map.setFeatureState({ source: SOURCE_ID, id }, { hidden: true });
}

// Set (or clear) the single highlighted speech-bubble marker. Uses its own
// source so it survives the frequent full-source overwrites of `browse-points`
// during pan/zoom/fetch. `point` carries explicit coordinates, so it works
// even when the hovered listing's marker isn't among the rendered dots. The
// price is carried in `price_label` and rendered as vector text by the layer.
export function setHighlightedPoint(
  map: maplibregl.Map,
  point: HoverPointData | null
): void {
  const source = map.getSource(HIGHLIGHT_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (!source) return;

  if (!point || point.lat == null || point.lon == null) {
    source.setData({ type: 'FeatureCollection', features: [] });
    return;
  }

  // Snug bubble image for this label — cached per measured width.
  const iconImage = getBubbleImage(map, point.price_label || '');

  source.setData({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
      properties: { ...point, icon_image: iconImage },
    }],
  });
}

export function removeMapLayers(map: maplibregl.Map): void {
  // NB: halo layers aren't in LAYERS — include them explicitly, otherwise
  // removeSource throws "cannot be removed while layer X is using it".
  // Layers must ALL go before either source.
  const layerIds = [
    ...Object.values(LAYERS),
    `${LAYERS.unclusteredProperties}-halo`,
    `${LAYERS.unclusteredProjects}-halo`,
  ];
  for (const id of layerIds) {
    try {
      if (map.getLayer(id)) {
        map.removeLayer(id);
      }
    } catch {
      // ignore
    }
  }
  try {
    if (map.getSource(SOURCE_ID) && !map.getLayer(LAYERS.unclusteredProperties)) {
      map.removeSource(SOURCE_ID);
    }
  } catch {
    // A missed layer still references the source — leave it rather than throw.
  }
  try {
    if (map.getSource(HIGHLIGHT_SOURCE_ID) && !map.getLayer(LAYERS.highlightedPin)) {
      map.removeSource(HIGHLIGHT_SOURCE_ID);
    }
  } catch {
    // ignore
  }
}

export { SOURCE_ID, LAYERS };
