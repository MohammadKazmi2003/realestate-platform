import { selectPlacePolygon } from '@/lib/placeGeometry';

// Pure candidate-selection logic for the OSM locality resolver. Fixtures
// mirror the real shapes verified in the field:
//  - Dubai Marina: a large residential relation contains the searched center,
//    a smaller sub-parcel and an address do not (same name, wrong territory).
//  - Dubai Investment Park: a `place=neighbourhood` polygon contains it.
//  - Kharghar: only a station building shares the name — never eligible.
// Containment (even-odd, holes honored) is what makes the difference; without
// it a loose name match would draw a parcel, a station, or a lake.

type Ring = number[][];
function square(lng: number, lat: number, size: number): Ring {
  const s = size / 2;
  return [
    [lng - s, lat - s],
    [lng + s, lat - s],
    [lng + s, lat + s],
    [lng - s, lat + s],
    [lng - s, lat - s],
  ];
}
function polygon(ring: Ring, holes: Ring[] = []) {
  return { type: 'Polygon' as const, coordinates: [ring, ...holes] };
}

const MARINA = { lat: 25.078642, lng: 55.135252 };
const DIP = { lat: 24.973935, lng: 55.210833 };
const KHARGHAR = { lat: 19.05253, lng: 73.073511 };

describe('selectPlacePolygon', () => {
  it('picks the containing community polygon, ignoring same-named sub-parcels/stations', () => {
    const picked = selectPlacePolygon(
      [
        // sub-parcel NE of the center — does NOT contain it
        { osm_type: 'way', osm_id: 1, category: 'landuse', type: 'residential', geojson: polygon(square(55.16, 25.1, 0.01)) },
        // the community relation — contains the center
        { osm_type: 'relation', osm_id: 11912728, category: 'landuse', type: 'residential', geojson: polygon(square(MARINA.lng, MARINA.lat, 0.03)) },
        // a station building share the name — does NOT contain it
        { osm_type: 'way', osm_id: 2, category: 'railway', type: 'station', geojson: polygon(square(55.2, 25.2, 0.002)) },
      ],
      MARINA
    );
    expect(picked).not.toBeNull();
    expect(picked!.osmId).toBe(11912728);
    expect(picked!.rings.length).toBe(1);
  });

  it('picks a place=neighbourhood polygon (Dubai Investment Park)', () => {
    const picked = selectPlacePolygon(
      [{ osm_type: 'way', osm_id: 874795301, category: 'place', type: 'neighbourhood', geojson: polygon(square(DIP.lng, DIP.lat, 0.05)) }],
      DIP
    );
    expect(picked).not.toBeNull();
    expect(picked!.bbox[0]).toBeLessThan(DIP.lng);
    expect(picked!.bbox[2]).toBeGreaterThan(DIP.lng);
  });

  it('rejects everything when only street furniture shares the name (Kharghar)', () => {
    const picked = selectPlacePolygon(
      [
        { osm_type: 'way', osm_id: 562395722, category: 'railway', type: 'station', geojson: polygon(square(73.058, 19.026, 0.003)) },
        { osm_type: 'way', osm_id: 999, category: 'landuse', type: 'industrial', geojson: polygon(square(73.08, 19.06, 0.001)) },
      ],
      KHARGHAR
    );
    expect(picked).toBeNull();
  });

  it('honours holes: a center inside a hole is not contained', () => {
    const outer = square(MARINA.lng, MARINA.lat, 0.03);
    const hole = square(MARINA.lng, MARINA.lat, 0.01);
    expect(selectPlacePolygon([{ osm_type: 'relation', osm_id: 7, type: 'residential', geojson: polygon(outer, [hole]) }], MARINA)).toBeNull();

    // Without the hole (or with the point outside it) the same polygon wins.
    const offCenter = { lat: MARINA.lat + 0.012, lng: MARINA.lng };
    expect(selectPlacePolygon([{ osm_type: 'relation', osm_id: 7, type: 'residential', geojson: polygon(outer, [hole]) }], offCenter)).not.toBeNull();
  });

  it('ranks administrative boundaries above place/landuse polygons', () => {
    const picked = selectPlacePolygon(
      [
        { osm_type: 'way', osm_id: 10, category: 'place', type: 'suburb', geojson: polygon(square(MARINA.lng, MARINA.lat, 0.08)) },
        { osm_type: 'way', osm_id: 11, category: 'boundary', type: 'administrative', geojson: polygon(square(MARINA.lng, MARINA.lat, 0.02)) },
      ],
      MARINA
    );
    expect(picked!.osmId).toBe(11);
  });

  it('rejects polygons outside the sane area band', () => {
    expect(selectPlacePolygon([{ osm_type: 'relation', osm_id: 12, type: 'city', geojson: polygon(square(MARINA.lng, MARINA.lat, 2)) }], MARINA)).toBeNull();
    expect(selectPlacePolygon([{ osm_type: 'way', osm_id: 13, type: 'residential', geojson: polygon(square(MARINA.lng, MARINA.lat, 0.00005)) }], MARINA)).toBeNull();
  });

  it('returns null for empty or malformed input', () => {
    expect(selectPlacePolygon([], MARINA)).toBeNull();
    expect(selectPlacePolygon(null, MARINA)).toBeNull();
    expect(selectPlacePolygon([{ osm_type: 'node', osm_id: 1, type: 'city', geojson: { type: 'Point', coordinates: [55, 25] } }], MARINA)).toBeNull();
    expect(selectPlacePolygon([{ geojson: polygon(square(MARINA.lng, MARINA.lat, 0.02)) }], { lat: NaN, lng: 0 })).toBeNull();
  });
});
