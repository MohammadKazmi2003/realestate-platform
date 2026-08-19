import maplibregl from 'maplibre-gl';

const SOURCE_ID = 'browse-points';
const HIGHLIGHT_SOURCE_ID = 'highlight-point';

const LAYERS = {
  unclusteredProperties: 'unclustered-properties',
  unclusteredProjects: 'unclustered-projects',
  markerPrice: 'marker-price',
  highlightedPoint: 'highlighted-point',
  highlightedPointRing: 'highlighted-point-ring',
} as const;

const PROPERTY_COLOR = '#2563EB';
const PROJECT_COLOR = '#059669';
const HIGHLIGHT_COLOR = '#EF4444';

// A single map point (marker dot or sidebar-hovered listing). Mirrors the
// former ClusterPoint from clustering.ts.
export interface ClusterPoint {
  id: string;
  type: 'property' | 'project';
  title: string;
  price: number;
  image?: string;
  location?: string;
  area?: string;
  bedrooms?: string;
  latitude: number;
  longitude: number;
  slug?: string;
}

export interface HoverPointData {
  id?: string;
  lat: number;
  lon: number;
  title?: string;
  price?: number;
  image?: string;
  location?: string;
  type?: 'property' | 'project';
}

function getCircleRadius(zoom: number): number {
  if (zoom < 12) return 6;
  if (zoom < 14) return 8;
  if (zoom < 16) return 10;
  return 12;
}

export function setupMapLayers(map: maplibregl.Map): void {
  if (map.getSource(SOURCE_ID)) return;

  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addLayer({
    id: LAYERS.unclusteredProperties,
    type: 'circle',
    source: SOURCE_ID,
    filter: ['==', ['get', 'type'], 'property'],
    paint: {
      'circle-color': PROPERTY_COLOR,
      'circle-radius': getCircleRadius(map.getZoom()),
      'circle-stroke-width': 2.5,
      'circle-stroke-color': '#ffffff',
      'circle-opacity': 0.95,
    },
  });

  map.addLayer({
    id: LAYERS.unclusteredProjects,
    type: 'circle',
    source: SOURCE_ID,
    filter: ['==', ['get', 'type'], 'project'],
    paint: {
      'circle-color': PROJECT_COLOR,
      'circle-radius': getCircleRadius(map.getZoom()),
      'circle-stroke-width': 2.5,
      'circle-stroke-color': '#ffffff',
      'circle-opacity': 0.95,
    },
  });

  // Zillow-style price labels on the densest dots. Collision detection hides
  // labels that would overlap, so only the top labels by sort key show.
  map.addLayer({
    id: LAYERS.markerPrice,
    type: 'symbol',
    source: SOURCE_ID,
    layout: {
      'text-field': ['coalesce', ['get', 'price_label'], ''],
      'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
      'text-size': 11,
      'text-offset': [0, -1.4],
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

  map.addSource(HIGHLIGHT_SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // Soft halo under the highlighted dot so it reads as "pinned".
  map.addLayer({
    id: LAYERS.highlightedPointRing,
    type: 'circle',
    source: HIGHLIGHT_SOURCE_ID,
    paint: {
      'circle-color': HIGHLIGHT_COLOR,
      'circle-radius': 26,
      'circle-opacity': 0.22,
      'circle-stroke-width': 0,
    },
  });

  map.addLayer({
    id: LAYERS.highlightedPoint,
    type: 'circle',
    source: HIGHLIGHT_SOURCE_ID,
    paint: {
      'circle-color': HIGHLIGHT_COLOR,
      'circle-radius': 16,
      'circle-stroke-width': 3,
      'circle-stroke-color': '#ffffff',
      'circle-opacity': 0.95,
    },
  });
}

export function updateSourceData(
  map: maplibregl.Map,
  data: GeoJSON.FeatureCollection
): void {
  const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
  }
}

export function updateCircleRadius(map: maplibregl.Map, zoom: number): void {
  const radius = getCircleRadius(zoom);
  const layers = [LAYERS.unclusteredProperties, LAYERS.unclusteredProjects];
  for (const layerId of layers) {
    try {
      map.setPaintProperty(layerId, 'circle-radius', radius as any);
    } catch {
      // layer might not exist yet
    }
  }
}

// Set (or clear) the single highlighted point. Uses its own source so it
// survives the frequent full-source overwrites of `browse-points` during
// pan/zoom/fetch. `point` carries explicit coordinates, so it works even when
// the hovered listing's marker isn't among the currently rendered dots.
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

  source.setData({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
      properties: { ...point },
    }],
  });
}

export function removeMapLayers(map: maplibregl.Map): void {
  const layerIds = Object.values(LAYERS);
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
    if (map.getSource(SOURCE_ID)) {
      map.removeSource(SOURCE_ID);
    }
    if (map.getSource(HIGHLIGHT_SOURCE_ID)) {
      map.removeSource(HIGHLIGHT_SOURCE_ID);
    }
  } catch {
    // ignore
  }
}

export { SOURCE_ID, LAYERS };
