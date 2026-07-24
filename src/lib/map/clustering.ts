import Supercluster from 'supercluster';

export interface ClusterPoint {
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
  slug?: string;
  [key: string]: any;
}

interface ClusterProps {
  cluster?: boolean;
  cluster_id?: number;
  point_count?: number;
  point_count_abbreviated?: string | number;
}

type PointFeature = Supercluster.PointFeature<ClusterPoint>;
type ClusterFeature = Supercluster.ClusterFeature<Record<string, never>>;
export type ResultFeature = PointFeature | ClusterFeature;

const DEFAULT_OPTIONS = {
  radius: 60,
  maxZoom: 16,
  minZoom: 0,
  minPoints: 2,
};

export class MapClustering {
  private instance: Supercluster<ClusterPoint, Record<string, never>>;
  private points: PointFeature[] = [];

  constructor(options?: Partial<typeof DEFAULT_OPTIONS>) {
    this.instance = new Supercluster<ClusterPoint, Record<string, never>>({
      ...DEFAULT_OPTIONS,
      ...options,
    });
  }

  load(features: ClusterPoint[]): void {
    this.points = features.map((f) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        coordinates: [f.longitude, f.latitude] as [number, number],
      },
      properties: { ...f },
    }));
    this.instance.load(this.points);
  }

  getClusters(bbox: [number, number, number, number], zoom: number): ResultFeature[] {
    return this.instance.getClusters(bbox, zoom);
  }

  getLeaves(clusterId: number, limit = 10, offset = 0): PointFeature[] {
    return this.instance.getLeaves(clusterId, limit, offset);
  }

  getClusterExpansionZoom(clusterId: number): number {
    return this.instance.getClusterExpansionZoom(clusterId);
  }

  isCluster(feature: ResultFeature): boolean {
    return !!(feature.properties as ClusterProps).cluster;
  }

  getClusterId(feature: ResultFeature): number | undefined {
    return (feature.properties as ClusterProps).cluster_id;
  }

  getClusterCount(feature: ResultFeature): number {
    return (feature.properties as ClusterProps).point_count || 0;
  }

  getPointProperties(feature: ResultFeature): ClusterPoint | null {
    if (this.isCluster(feature)) return null;
    return feature.properties as unknown as ClusterPoint;
  }
}
