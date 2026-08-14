require('dotenv').config();
const { createClient } = require('@clickhouse/client');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');

const ch = createClient({
  url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USER || 'default',
  password: process.env.CLICKHOUSE_PASSWORD || '',
  database: process.env.CLICKHOUSE_DB || 'realestate',
});

const supabase = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function parseWKTPoint(wkt) {
  if (!wkt) return { latitude: null, longitude: null };
  if (typeof wkt === 'object' && wkt.coordinates) {
    return { latitude: wkt.coordinates[1], longitude: wkt.coordinates[0] };
  }
  if (typeof wkt === 'string') {
    const hexMatch = wkt.match(/^0101000020E6100000([0-9A-Fa-f]{32})$/i);
    if (hexMatch) {
      const hex = hexMatch[1];
      const lon = Buffer.from(hex.slice(0, 16), 'hex').readDoubleLE(0);
      const lat = Buffer.from(hex.slice(16, 32), 'hex').readDoubleLE(0);
      return { latitude: lat, longitude: lon };
    }
    const wktMatch = wkt.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
    if (wktMatch) {
      return { latitude: parseFloat(wktMatch[2]), longitude: parseFloat(wktMatch[1]) };
    }
  }
  return { latitude: null, longitude: null };
}

async function syncAll() {
  console.log('=== Syncing Properties & Projects to ClickHouse ===\n');

  // 0. Truncate existing data to avoid double-counting (MV is additive)
  console.log('0. Truncating existing ClickHouse data...');
  try {
    await ch.exec({ query: 'TRUNCATE TABLE realestate.property_markers' });
    await ch.exec({ query: 'TRUNCATE TABLE realestate.h3_clusters_precomputed' });
    console.log('   ✓ Tables truncated');
  } catch (err) {
    console.warn('   Truncate warning (may be empty):', err.message);
  }

  // 1. Fetch lookup tables
  const [{ data: bhkTypes }, { data: propTypes }] = await Promise.all([
    supabase.from('bhk_types').select('id, label'),
    supabase.from('property_types').select('id, name'),
  ]);
  const bhkMap = {};
  for (const b of (bhkTypes || [])) {
    bhkMap[b.id] = b.label;
  }
  const propTypeMap = {};
  for (const pt of (propTypes || [])) {
    propTypeMap[pt.id] = pt.name;
  }
  console.log('BHK types loaded:', Object.keys(bhkMap).length);
  console.log('Property types loaded:', Object.keys(propTypeMap).length);

  // 2. Sync Properties with details
  console.log('1. Fetching properties with details from Supabase...');

  // Paginate properties (include property_type_id for real type names)
  let allProperties = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const { data: batch, error } = await supabase
      .from('properties')
      .select('id, title, location_text, price, status, location_point, property_type_id')
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error || !batch || batch.length === 0) break;
    allProperties = allProperties.concat(batch);
    if (batch.length < pageSize) break;
    page++;
  }

  // Fetch details for all properties
  const propIds = allProperties.map(p => p.id);
  let allDetails = [];
  for (let i = 0; i < propIds.length; i += 500) {
    const chunk = propIds.slice(i, i + 500);
    const { data: details } = await supabase
      .from('details_residential')
      .select('property_id, bhk_type_id, bathrooms, carpet_area')
      .in('property_id', chunk);
    if (details) allDetails = allDetails.concat(details);
  }

  const detailsMap = {};
  for (const d of allDetails) {
    detailsMap[d.property_id] = d;
  }

  const propMarkers = [];
  for (const p of allProperties) {
    const coords = parseWKTPoint(p.location_point);
    if (!coords.latitude || !coords.longitude) continue;

    const detail = detailsMap[p.id] || {};
    const bhkLabel = detail.bhk_type_id ? (bhkMap[detail.bhk_type_id] || '') : '';

    propMarkers.push({
      id: p.id,
      title: p.title || '',
      lat: coords.latitude,
      lon: coords.longitude,
      price: p.price || 0,
      property_type: propTypeMap[p.property_type_id] || 'Other',
      bhk_type: bhkLabel,
      entity_type: 'property',
      status: p.status || 'available',
      area_sqft: detail.carpet_area || 0,
      bathrooms: detail.bathrooms || 0,
      bedrooms: parseInt(bhkLabel) || 0,
      location_text: p.location_text || '',
      image_url: '',
    });
  }
  console.log(`   Properties: ${propMarkers.length} valid`);

  // 3. Sync Projects
  console.log('2. Fetching projects from Supabase...');
  let allProjects = [];
  page = 0;

  while (true) {
    const { data: batch, error: projError } = await supabase
      .from('projects')
      .select('id, name, latitude, longitude, low_price, high_price, construction_phase')
      .not('latitude', 'is', null)
      .not('longitude', 'is', null)
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (projError || !batch || batch.length === 0) break;
    allProjects = allProjects.concat(batch);
    if (batch.length < pageSize) break;
    page++;
  }

  const projMarkers = [];
  for (const p of allProjects) {
    if (!p.latitude || !p.longitude) continue;
    projMarkers.push({
      id: p.id,
      title: p.name || '',
      lat: p.latitude,
      lon: p.longitude,
      price: p.low_price || 0,  // B7: match ES (sort_price = low_price)
      property_type: 'Project',
      bhk_type: '',
      entity_type: 'project',
      status: 'available',
      area_sqft: 0,
      bathrooms: 0,
      bedrooms: 0,
      location_text: '',
      image_url: '',
    });
  }
  console.log(`   Projects: ${projMarkers.length} valid`);

  const allMarkers = [...propMarkers, ...projMarkers];
  console.log(`\nTotal markers: ${allMarkers.length}`);

  if (allMarkers.length === 0) {
    console.log('No data to insert.');
    return;
  }

  // 4. Insert into ClickHouse (MV auto-aggregates)
  console.log('\n3. Inserting into ClickHouse...');
  try {
    await ch.insert({ table: 'realestate.property_markers', values: allMarkers, format: 'JSONEachRow' });
    console.log(`   ✓ property_markers: ${allMarkers.length} rows`);
    console.log('   ✓ Materialized views auto-aggregated into h3_clusters_precomputed');
    console.log('\n✅ Sync complete!');
  } catch (err) {
    console.error('ClickHouse insert error:', err.message);
  }
}

syncAll().catch(console.error);
