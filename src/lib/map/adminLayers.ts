// Interactive admin-1 (state/emirate) layers for the browse map.
//
// One GeoJSON source, `promoteId: 'id'` so hover/selected state can use
// MapLibre feature-state. Layers are visual only — selection still filters
// through the server `?state=<id>` path so the outline and the ES polygon are
// the same geometry (AD3/AD5).
import type { Map as MLMap, GeoJSONSource, GeoJSONSourceSpecification, LayerSpecification } from 'maplibre-gl';

export const ADMIN_SOURCE_ID = 'admin-states';
// Canonical MapTiler geometry for the hovered/selected state only, fetched per
// state from /api/admin-geo?state=<ID> (cache-busted by the manifest sha). The
// overview layer stays simplified so first paint stays light (~1.2 MB gzipped
// for 43 states); interactions always render the exact shape the server
// filters by, holes and islands included.
export const ADMIN_DETAIL_SOURCE_ID = 'admin-states-detail';
export const ADMIN_HOVER_DETAIL_SOURCE_ID = 'admin-states-hover-detail';
export const ADMIN_LAYERS = {
  fill: 'admin-states-fill',
  line: 'admin-states-line',
  hoverLine: 'admin-states-hover-line',
  selectedLine: 'admin-states-selected-line',
  selectedDetail: 'admin-states-selected-detail',
  hoverDetailFill: 'admin-states-hover-detail-fill',
  hoverDetailLine: 'admin-states-hover-detail-line',
} as const;

const ALL_LAYERS = Object.values(ADMIN_LAYERS);

// The fill layer is the hit-test surface. It stays effectively invisible at
// rest (0.01) but must remain a rendered layer, otherwise pointer events would
// fall through to the basemap and states would not be selectable.
const HIT_OPACITY = 0.01;

function addLayerOnce(map: MLMap, layer: LayerSpecification, beforeId?: string) {
  if (map.getLayer(layer.id)) return;
  if (beforeId && map.getLayer(beforeId)) map.addLayer(layer, beforeId);
  else map.addLayer(layer);
}

export function setupAdminLayers(map: MLMap, data: GeoJSON.GeoJSON, beforeId?: string) {
  const src = map.getSource(ADMIN_SOURCE_ID) as GeoJSONSource | undefined;
  if (src) {
    src.setData(data);
  } else {
    map.addSource(ADMIN_SOURCE_ID, { type: 'geojson', data, promoteId: 'id' } as GeoJSONSourceSpecification);
  }

  // Hover = blue fill; selected = NO fill (outline only, see selectedLine).
  // This separation is what keeps the hover highlight from reading as part of
  // the selection: clicking clears hover, so only the outline remains.
  // `detail` is set while the canonical hover fill is drawn, so the coarse
  // overview fill does not stack a second layer of blue underneath it.
  addLayerOnce(map, {
    id: ADMIN_LAYERS.fill,
    type: 'fill',
    source: ADMIN_SOURCE_ID,
    paint: {
      'fill-color': '#2563eb',
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], 0,
        ['boolean', ['feature-state', 'detail'], false], HIT_OPACITY,
        ['boolean', ['feature-state', 'hover'], false], 0.1,
        HIT_OPACITY,
      ],
    },
  }, beforeId);

  addLayerOnce(map, {
    id: ADMIN_LAYERS.line,
    type: 'line',
    source: ADMIN_SOURCE_ID,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#475569',
      'line-opacity': 0.5,
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 7, 1, 10, 1.4],
    },
  }, beforeId);

  addLayerOnce(map, {
    id: ADMIN_LAYERS.hoverLine,
    type: 'line',
    source: ADMIN_SOURCE_ID,
    layout: { 'line-join': 'round', 'line-cap': 'round', 'visibility': 'none' },
    paint: {
      'line-color': '#2563eb',
      'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.95, 0],
      'line-width': 2.2,
    },
  }, beforeId);

  addLayerOnce(map, {
    id: ADMIN_LAYERS.selectedLine,
    type: 'line',
    source: ADMIN_SOURCE_ID,
    layout: { 'line-join': 'round', 'line-cap': 'round', 'visibility': 'none' },
    paint: {
      'line-color': '#1d4ed8',
      'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0],
      'line-width': 2.8,
    },
  }, beforeId);
}

// Show (or clear) the full-resolution outline of the selected region. Also
// suppresses the coarse overview line for the same id so the two can't draw
// alongside each other.
export function setSelectedDetail(map: MLMap, feature: GeoJSON.Feature | null, beforeId?: string) {
  const src = map.getSource(ADMIN_DETAIL_SOURCE_ID) as GeoJSONSource | undefined;
  const data: GeoJSON.GeoJSON = feature
    ? { type: 'FeatureCollection', features: [feature] }
    : { type: 'FeatureCollection', features: [] };
  if (src) {
    src.setData(data);
  } else {
    map.addSource(ADMIN_DETAIL_SOURCE_ID, { type: 'geojson', data } as GeoJSONSourceSpecification);
  }
  addLayerOnce(map, {
    id: ADMIN_LAYERS.selectedDetail,
    type: 'line',
    source: ADMIN_DETAIL_SOURCE_ID,
    layout: { 'line-join': 'round', 'line-cap': 'round', visibility: feature ? 'visible' : 'none' },
    paint: {
      'line-color': '#1d4ed8',
      'line-opacity': 1,
      // Slightly wider than the overview line: at 6-dp detail the geometry is
      // essentially exact, and the width makes the selection unambiguous.
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2.2, 8, 2.6, 12, 3.2],
    },
  }, beforeId);
  if (map.getLayer(ADMIN_LAYERS.selectedDetail)) {
    map.setLayoutProperty(ADMIN_LAYERS.selectedDetail, 'visibility', feature ? 'visible' : 'none');
  }
}

// The overview selected line draws every selected region from the simplified
// asset; once the detail outline is shown, exclude that id to avoid a double
// line. Pass null to restore the layer to all regions.
export function setOverviewSelectedExcluded(map: MLMap, id: string | null) {
  if (!map.getLayer(ADMIN_LAYERS.selectedLine)) return;
  map.setFilter(ADMIN_LAYERS.selectedLine, id ? ['!=', ['get', 'id'], id] : null);
}

// Canonical hover rendering: the exact geometry replaces the coarse overview
// hover for the hovered id as soon as it is cached/fetched. Inserted beneath
// the selected outline so a selection always draws on top.
export function setHoverDetail(map: MLMap, data: GeoJSON.GeoJSON | null, beforeId?: string) {
  const payload: GeoJSON.GeoJSON = data ?? { type: 'FeatureCollection', features: [] };
  const src = map.getSource(ADMIN_HOVER_DETAIL_SOURCE_ID) as GeoJSONSource | undefined;
  if (src) {
    src.setData(payload);
  } else {
    map.addSource(ADMIN_HOVER_DETAIL_SOURCE_ID, { type: 'geojson', data: payload } as GeoJSONSourceSpecification);
  }
  const insertBefore = beforeId ?? (map.getLayer(ADMIN_LAYERS.selectedLine) ? ADMIN_LAYERS.selectedLine : undefined);
  addLayerOnce(map, {
    id: ADMIN_LAYERS.hoverDetailFill,
    type: 'fill',
    source: ADMIN_HOVER_DETAIL_SOURCE_ID,
    paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.1 },
  }, insertBefore);
  addLayerOnce(map, {
    id: ADMIN_LAYERS.hoverDetailLine,
    type: 'line',
    source: ADMIN_HOVER_DETAIL_SOURCE_ID,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#2563eb', 'line-opacity': 0.95, 'line-width': 2.2 },
  }, insertBefore);
  const visible = data ? 'visible' : 'none';
  for (const id of [ADMIN_LAYERS.hoverDetailFill, ADMIN_LAYERS.hoverDetailLine]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible);
  }
}

// Draw the coarse hover styling from the overview asset for the hovered id
// only — restores/clears the overview hover when the canonical hover outline
// takes over (or when the hover ends). Only the line is filtered: the fill is
// the pointer-events surface and must keep rendering the hovered feature.
export function setOverviewHoverExcluded(map: MLMap, id: string | null) {
  if (!map.getLayer(ADMIN_LAYERS.hoverLine)) return;
  map.setFilter(ADMIN_LAYERS.hoverLine, id ? ['!=', ['get', 'id'], id] : null);
}

// Marks the overview feature whose canonical geometry is currently drawn as
// the hover fill, so the overview fill can stand down (feature-state survives
// filtering, unlike a layer filter which would kill pointer events).
export function setAdminDetailState(map: MLMap, id: string | number | null, previous?: string | number | null) {
  try {
    if (previous != null) {
      map.setFeatureState({ source: ADMIN_SOURCE_ID, id: previous }, { detail: false });
    }
    if (id != null) {
      map.setFeatureState({ source: ADMIN_SOURCE_ID, id }, { detail: true });
    }
  } catch {
    /* feature may not be loaded yet */
  }
}

export function setAdminHover(map: MLMap, id: string | number) {
  try {
    map.setFeatureState({ source: ADMIN_SOURCE_ID, id }, { hover: true });
  } catch {
    /* feature may not be loaded yet */
  }
}

export function clearAdminHover(map: MLMap, id: string | number | null | undefined) {
  if (id == null) return;
  try {
    map.setFeatureState({ source: ADMIN_SOURCE_ID, id }, { hover: false });
  } catch {
    /* feature may not be loaded yet */
  }
}

export function setAdminSelected(map: MLMap, id: string | number | null, previous?: string | number | null) {
  try {
    if (previous != null) {
      map.setFeatureState({ source: ADMIN_SOURCE_ID, id: previous }, { selected: false });
    }
    if (id != null) {
      map.setFeatureState({ source: ADMIN_SOURCE_ID, id }, { selected: true });
    }
  } catch {
    /* feature may not be loaded yet */
  }
}

// Zoom tiers:
//  overview   → state outlines only (markers hidden and skipped server-side)
//  outline    → subtle state outlines + normal markers + state hit surface
//  city       → map/property browsing: NO state hit surface or hover, only the
//               selected state's outline remains
export function applyAdminTier(
  map: MLMap,
  tier: 'overview' | 'outline' | 'city',
  hasSelection: boolean
) {
  const outlineVisible = tier !== 'city';
  // State hover/click stops at the city tier even with an active selection:
  // above outlineMaxZoom users interact with properties, not whole states.
  const hitSurfaceVisible = outlineVisible;
  const setVis = (id: string, visible: boolean) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  };
  setVis(ADMIN_LAYERS.fill, hitSurfaceVisible);
  setVis(ADMIN_LAYERS.line, outlineVisible);
  // Hover styling follows the hit surface, so it disappears with it.
  setVis(ADMIN_LAYERS.hoverLine, hitSurfaceVisible);
  // The selected outline stays visible at every zoom so the active state filter
  // is never invisible on the map.
  setVis(ADMIN_LAYERS.selectedLine, hasSelection);
  setVis(ADMIN_LAYERS.selectedDetail, hasSelection);
}

export function removeAdminLayers(map: MLMap) {
  for (const id of ALL_LAYERS) {
    if (map.getLayer(id)) {
      try { map.removeLayer(id); } catch { /* style may already be gone */ }
    }
  }
  for (const source of [ADMIN_SOURCE_ID, ADMIN_DETAIL_SOURCE_ID]) {
    if (map.getSource(source)) {
      try { map.removeSource(source); } catch { /* still referenced */ }
    }
  }
}

export { ALL_LAYERS as ADMIN_ALL_LAYERS };
