import { scoreGeoCandidate, queryTokensOf } from '@/lib/geoRank';

const feat = (place_name: string, place_type?: string[], bbox?: number[]) => ({
  place_name,
  place_type,
  bbox,
});

describe('scoreGeoCandidate', () => {
  it('ranks town municipality above county district on name collision', () => {
    const tokens = queryTokensOf('Panvel');
    const town = scoreGeoCandidate(
      feat('Panvel, Maharashtra, India', ['municipality'], [73.0, 18.9, 73.2, 19.1]),
      tokens
    );
    const district = scoreGeoCandidate(
      feat('Panvel Subdistrict, Maharashtra, India', ['county'], [72.9, 18.8, 73.3, 19.2]),
      tokens
    );
    expect(town).toBeGreaterThan(district);
  });

  it('demotes lakes/roads but keeps them above zero-info rows', () => {
    const tokens = queryTokensOf('Kamothe');
    const suburb = scoreGeoCandidate(
      feat('KAMOTHE, Navi Mumbai, India', ['place'], [73.0, 19.0, 73.1, 19.1]),
      tokens
    );
    const lake = scoreGeoCandidate(
      feat('Kamothe Lake, India', ['major_landform'], [73.0, 19.0, 73.01, 19.01]),
      tokens
    );
    const junk = scoreGeoCandidate(feat('Nowhereville, Elsewhere', ['place'], [0, 0, 0, 0]), tokens);
    expect(suburb).toBeGreaterThan(lake);
    expect(lake).toBeGreaterThan(junk);
  });

  it('degenerate point bboxes earn no boundary bonus', () => {
    const tokens = queryTokensOf('Mumbai');
    const point = scoreGeoCandidate(
      feat('Mumbai, Maharashtra, India', ['place'], [72.86, 19.05, 72.86, 19.05]),
      tokens
    );
    const district = scoreGeoCandidate(
      feat('Mumbai Suburban District, Maharashtra, India', ['subregion'], [72.77, 18.99, 72.98, 19.26]),
      tokens
    );
    expect(district).toBeGreaterThan(point);
  });
});
