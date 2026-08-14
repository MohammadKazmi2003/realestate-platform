// Web Worker for off-thread supercluster computation.
// Keeps the main thread free for 60fps map rendering during pan/zoom.

import Supercluster from 'supercluster';

interface WorkerPoint {
  id: string;
  type: 'property' | 'project';
  title: string;
  price: number;
  image: string;
  location: string;
  latitude: number;
  longitude: number;
  area?: string;
  bedrooms?: string;
  bathrooms?: string;
}

interface ClusterMessage {
  type: 'cluster';
  features: WorkerPoint[];
  bbox: [number, number, number, number];
  zoom: number;
}

interface ClusterResult {
  type: 'ClusterFeature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, any>;
}

self.onmessage = (e: MessageEvent<ClusterMessage>) => {
  const { features, bbox, zoom } = e.data;

  const index = new Supercluster<WorkerPoint, Record<string, never>>({
    radius: 60,
    maxZoom: 16,
    minZoom: 0,
    minPoints: 2,
  });

  const points = features.map((f) => ({
    type: 'Feature' as const,
    geometry: {
      type: 'Point' as const,
      coordinates: [f.longitude, f.latitude] as [number, number],
    },
    properties: { ...f },
  }));

  index.load(points);
  const clusters = index.getClusters(bbox, zoom);

  const results: ClusterResult[] = clusters.map((f) => ({
    type: 'ClusterFeature',
    geometry: f.geometry as { type: 'Point'; coordinates: [number, number] },
    properties: { ...f.properties },
  }));

  self.postMessage({ type: 'clusters', clusters: results });
};
