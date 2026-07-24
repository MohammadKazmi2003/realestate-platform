require('dotenv').config();
const { createClient } = require('@clickhouse/client');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');
const h3 = require('h3-js');

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

  // 1. Sync Properties
  console.log('1. Fetching properties from Supabase...');
  const { data: properties, error: propError } = await supabase
    .from('properties')
    .select('id, title, location_text, price, status, location_point')
    .limit(5000);

  if (propError) {
    console.error('Supabase properties error:', propError);
    return;
  }

  const propMarkers = [];
  for (const p of properties) {
    if (!p.price || p.price <= 0) continue;
    const coords = parseWKTPoint(p.location_point);
    if (!coords.latitude || !coords.longitude) continue;
    propMarkers.push({
      id: p.id,
      title: p.title || '',
      lat: coords.latitude,
      lon: coords.longitude,
      price: p.price,
      property_type: 'Property',
      bhk_type: '',
      entity_type: 'property',
      status: p.status || 'available',
      area_sqft: 0,
      bathrooms: 0,
      bedrooms: 0,
      location_text: p.location_text || '',
      image_url: '',
    });
  }
  console.log(`   Properties: ${propMarkers.length} valid`);

  // 2. Sync Projects (paginate to get ALL records)
  console.log('2. Fetching projects from Supabase...');
  let allProjects = [];
  let page = 0;
  const pageSize = 1000;
  
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
      price: p.low_price || p.high_price || 0,
      property_type: p.construction_phase || 'Project',
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

  // 3. Generate H3 rows
  const h3Rows = [];
  for (const m of allMarkers) {
    for (const res of [5, 7, 8]) {
      h3Rows.push({
        ...m,
        h3_resolution: res,
        h3_index: Number(h3.latLngToCell(m.lat, m.lon, res)),
      });
    }
  }

  // 4. Insert into ClickHouse
  console.log('\n3. Inserting into ClickHouse...');
  try {
    await ch.insert({ table: 'realestate.property_markers', values: allMarkers, format: 'JSONEachRow' });
    console.log(`   ✓ property_markers: ${allMarkers.length} rows`);

    await ch.insert({ table: 'realestate.property_h3', values: h3Rows, format: 'JSONEachRow' });
    console.log(`   ✓ property_h3: ${h3Rows.length} rows`);

    console.log('\n✅ Sync complete!');
  } catch (err) {
    console.error('ClickHouse insert error:', err.message);
  }
}

syncAll().catch(console.error);
