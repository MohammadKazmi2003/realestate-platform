import maplibregl from 'maplibre-gl';

const SOURCE_ID = 'browse-points';
const HIGHLIGHT_SOURCE_ID = 'highlight-point';

const LAYERS = {
  unclusteredProperties: 'unclustered-properties',
  unclusteredProjects: 'unclustered-projects',
  clusterGlow: 'cluster-glow',
  clusters: 'clusters',
  clusterCount: 'cluster-count',
  highlightedPoint: 'highlighted-point',
} as const;

const PROPERTY_COLOR = '#2563EB';
const PROJECT_COLOR = '#059669';
const HIGHLIGHT_COLOR = '#EF4444';

function getCircleRadius(zoom: number): number {
  if (zoom < 12) return 6;
  if (zoom < 14) return 8;
  if (zoom < 16) return 10;
  return 12;
}

function getClusterColor(): maplibregl.Expression {
  // Property clusters: blue (#2563EB), Project clusters: green (#059669)
  return [
    'case',
    ['==', ['get', 'cluster_type'], 'property'], PROPERTY_COLOR,
    ['==', ['get', 'cluster_type'], 'project'], PROJECT_COLOR,
    // Fallback: legacy combined clusters (no cluster_type)
    ['interpolate', ['linear'], ['get', 'point_count'],
      0,   '#4ade80',
      5,   '#facc15',
      25,  '#fb923c',
      100, '#ef4444',
      500, '#dc2626',
    ],
  ] as unknown as maplibregl.Expression;
}

function getClusterRadius(): maplibregl.Expression {
  return [
    'interpolate', ['linear'], ['get', 'point_count'],
    0,   28,
    1,   30,
    5,   34,
    10,  38,
    25,  44,
    50,  50,
    100, 56,
    250, 62,
    500, 68,
  ] as unknown as maplibregl.Expression;
}

function getClusterTextSize(): maplibregl.Expression {
  return [
    'interpolate', ['linear'], ['get', 'point_count'],
    0,   11,
    25,  13,
    100, 15,
    250, 17,
  ] as unknown as maplibregl.Expression;
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
    filter: [
      'all',
      ['!', ['has', 'point_count']],
      ['==', ['get', 'type'], 'property'],
    ],
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
    filter: [
      'all',
      ['!', ['has', 'point_count']],
      ['==', ['get', 'type'], 'project'],
    ],
    paint: {
      'circle-color': PROJECT_COLOR,
      'circle-radius': getCircleRadius(map.getZoom()),
      'circle-stroke-width': 2.5,
      'circle-stroke-color': '#ffffff',
      'circle-opacity': 0.95,
    },
  });

  map.addLayer({
    id: LAYERS.clusterGlow,
    type: 'circle',
    source: SOURCE_ID,
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': getClusterColor() as any,
      'circle-radius': [
        'interpolate', ['linear'], ['get', 'point_count'],
        0,   32,
        1,   34,
        5,   38,
        10,  42,
        25,  48,
        50,  54,
        100, 60,
        250, 66,
        500, 72,
      ] as any,
      'circle-opacity': 0.25,
      'circle-stroke-width': 0,
    },
  });

  map.addLayer({
    id: LAYERS.clusters,
    type: 'circle',
    source: SOURCE_ID,
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': getClusterColor() as any,
      'circle-radius': getClusterRadius() as any,
      'circle-stroke-width': 2.5,
      'circle-stroke-color': 'rgba(255, 255, 255, 0.9)',
      'circle-opacity': 0.9,
    },
  });

  map.addLayer({
    id: LAYERS.clusterCount,
    type: 'symbol',
    source: SOURCE_ID,
    filter: ['has', 'point_count'],
    layout: {
      'text-field': '{point_count_abbreviated}',
      'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
      'text-size': getClusterTextSize() as any,
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': 'rgba(0, 0, 0, 0.6)',
      'text-halo-width': 2,
      'text-halo-blur': 1,
    },
  });

  map.addSource(HIGHLIGHT_SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addLayer({
    id: LAYERS.highlightedPoint,
    type: 'circle',
    source: HIGHLIGHT_SOURCE_ID,
    paint: {
      'circle-color': HIGHLIGHT_COLOR,
      'circle-radius': 14,
      'circle-stroke-width': 3,
      'circle-stroke-color': '#ffffff',
      'circle-opacity': 0.9,
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

export function highlightFeature(
  map: maplibregl.Map,
  featureId: string | number | null
): void {
  const source = map.getSource(HIGHLIGHT_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (!source) return;

  if (featureId === null) {
    source.setData({ type: 'FeatureCollection', features: [] });
    return;
  }

  const features = map.querySourceFeatures(SOURCE_ID, {
    sourceLayer: '',
  });

  const feature = features.find((f) => f.id === featureId);
  if (feature && feature.geometry) {
    source.setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: feature.geometry,
        properties: {},
      }],
    });
  } else {
    source.setData({ type: 'FeatureCollection', features: [] });
  }
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
