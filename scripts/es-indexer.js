const { Client } = require('@elastic/elasticsearch');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

// Load .env from project root (bare Node doesn't auto-load .env)
(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
})();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || process.env.PYTHON_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.PYTHON_SUPABASE_SERVICE_KEY;
const ES_URL = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';
const ES_ALIAS = 'properties_search';
const INDEX_VERSION = process.env.INDEX_VERSION || 'v1';

function parseWKTPoint(wkt) {
  if (!wkt) return { latitude: null, longitude: null };
  // Try WKT format: POINT(lng lat)
  const wktMatch = wkt.match(/POINT\(([-\d.]+) ([-\d.]+)\)/);
  if (wktMatch) {
    return { latitude: parseFloat(wktMatch[2]), longitude: parseFloat(wktMatch[1]) };
  }
  // Try WKB hex format (PostGIS extended: byteOrder(1) + type(4) + srid(4) + x(8) + y(8) = 25 bytes)
  try {
    const hex = wkt.replace(/\s/g, '');
    const buf = Buffer.from(hex, 'hex');
    if (buf.length >= 25) {
      const byteOrder = buf.readUInt8(0); // 0=big, 1=little
      const le = byteOrder === 1;
      const srid = le ? buf.readUInt32LE(5) : buf.readUInt32BE(5);
      if (srid === 4326) {
        const lng = le ? buf.readDoubleLE(9) : buf.readDoubleBE(9);
        const lat = le ? buf.readDoubleLE(17) : buf.readDoubleBE(17);
        return { latitude: lat, longitude: lng };
      }
    }
  } catch {
    // fall through
  }
  return { latitude: null, longitude: null };
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const es = new Client({ node: ES_URL, maxRetries: 3 });

const INDEX_NAME = `properties_${INDEX_VERSION}`;

async function applyIndexTemplate() {
  const templatePath = path.join(__dirname, '..', 'es-config', 'index-template.json');
  if (!fs.existsSync(templatePath)) {
    console.warn('Index template file not found. Skipping.');
    return;
  }
  try {
    const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
    await es.indices.putIndexTemplate({
      name: 'properties_template',
      body: {
        index_patterns: ['properties_v*'],
        priority: 100,
        template,
      },
    });
    console.log('Index template applied successfully.');
  } catch (err) {
    console.warn('Failed to apply index template (will use direct index creation):', err.message.split('\n')[0]);
  }
}

async function createIndex() {
  const exists = await es.indices.exists({ index: INDEX_NAME });
  if (exists) {
    await es.indices.delete({ index: INDEX_NAME });
    console.log(`Deleted existing index: ${INDEX_NAME}`);
  }

  const mappingsPath = path.join(__dirname, '..', 'es-config', 'index-mappings.json');
  let body = {
    settings: { number_of_shards: 1, number_of_replicas: 1 },
  };

  if (fs.existsSync(mappingsPath)) {
    const mappings = JSON.parse(fs.readFileSync(mappingsPath, 'utf-8'));
    body = mappings;
  }

  await es.indices.create({ index: INDEX_NAME, body });
  console.log(`Created index: ${INDEX_NAME} with mappings`);
}

async function setupAlias() {
  const aliases = await es.cat.aliases({ format: 'json' });
  const existingAlias = aliases.find((a) => a.alias === ES_ALIAS);

  const actions = [];
  if (existingAlias) {
    actions.push({ remove: { index: existingAlias.index, alias: ES_ALIAS } });
  }
  actions.push({ add: { index: INDEX_NAME, alias: ES_ALIAS } });

  await es.indices.updateAliases({ body: { actions } });
  console.log(`Alias ${ES_ALIAS} -> ${INDEX_NAME}`);
}

async function buildPropertyDocument(property) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const [amenitiesRes, furnishingsRes, otherRoomsRes, advantagesRes, mediaRes, projectRes, profileRes, typeRes, purposeRes, residentialRes, commercialRes, landRes] = await Promise.all([
    supabase.from('junction_property_amenities').select('amenity_id, lookup_amenities(name)').eq('property_id', property.id),
    supabase.from('junction_property_furnishings').select('furnishing_item_id, lookup_furnishing_items(name)').eq('property_id', property.id),
    supabase.from('junction_property_other_rooms').select('room_id, lookup_other_rooms(name)').eq('property_id', property.id),
    supabase.from('junction_property_location_advantages').select('advantage_id, lookup_location_advantages(name)').eq('property_id', property.id),
    supabase.from('property_media').select('media_url, media_type, display_order').eq('property_id', property.id).order('display_order'),
    supabase.from('projects').select('name, builder_name, developer_id, developers(name)').eq('id', property.project_id).maybeSingle(),
    supabase.from('profiles').select('name, phone_number').eq('id', property.user_id).single(),
    supabase.from('property_types').select('name').eq('id', property.property_type_id).single(),
    supabase.from('lookup_listing_purposes').select('name').eq('id', property.listing_purpose_id).single(),
    supabase.from('details_residential').select('*, bhk_types(label), lookup_furnishing_statuses(name)').eq('property_id', property.id).maybeSingle(),
    supabase.from('details_commercial').select('*, lookup_commercial_sub_types(name)').eq('property_id', property.id).maybeSingle(),
    supabase.from('details_land').select('*').eq('property_id', property.id).maybeSingle(),
  ]);

  const areaData = landRes.data || residentialRes.data || commercialRes.data || {};
  const bhkLabel = residentialRes.data?.bhk_types?.label || null;
  const furnishingStatus = residentialRes.data?.lookup_furnishing_statuses?.name || null;

  const doc = {
    id: property.id,
    title: property.title || '',
    description: property.description || '',
    location_text: property.location_text || '',
    location: property.latitude != null && property.longitude != null
      ? { lat: property.latitude, lon: property.longitude }
      : null,
    price: property.price || 0,
    property_type: typeRes.data?.name || '',
    property_type_id: property.property_type_id,
    listing_purpose: purposeRes.data?.name || '',
    listing_purpose_id: property.listing_purpose_id,
    availability_status: '',
    ownership_type: '',
    bhk_type: bhkLabel || '',
    bhk_type_id: residentialRes.data?.bhk_type_id || null,
    bathrooms: residentialRes.data?.bathrooms || 0,
    balconies: residentialRes.data?.balconies || 0,
    area_sqft: areaData.carpet_area || areaData.plot_area || 0,
    area_unit: landRes.data?.area_unit || 'sqft',
    furnishing_status: furnishingStatus || '',
    amenities: (amenitiesRes.data || []).map((a) => a.lookup_amenities?.name || '').filter(Boolean),
    furnishings: (furnishingsRes.data || []).map((f) => f.lookup_furnishing_items?.name || '').filter(Boolean),
    other_rooms: (otherRoomsRes.data || []).map((r) => r.lookup_other_rooms?.name || '').filter(Boolean),
    location_advantages: (advantagesRes.data || []).map((a) => a.lookup_location_advantages?.name || '').filter(Boolean),
    is_price_negotiable: property.is_price_negotiable || false,
    status: property.status || 'available',
    property_score: property.property_score || 0,
    image_url: mediaRes.data?.[0]?.media_url || null,
    all_images: (mediaRes.data || []).map((m) => m.media_url),
    owner_name: profileRes.data?.name || '',
    owner_phone: profileRes.data?.phone_number || '',
    project_name: projectRes.data?.name || '',
    developer_name: projectRes.data?.builder_name || projectRes.data?.developers?.name || '',
    created_at: property.created_at,
    updated_at: property.updated_at,
    suggest: [
      property.title?.trim(),
      property.location_text?.trim(),
      projectRes.data?.name?.trim(),
    ].filter(Boolean),
  };

  return doc;
}

async function indexProperty(propertyId) {
  const { data: property, error } = await supabase
    .from('properties')
    .select('*')
    .eq('id', propertyId)
    .single();

  if (error || !property) {
    console.warn(`Property ${propertyId} not found. Deleting from ES.`);
    await es.delete({ index: ES_ALIAS, id: propertyId }).catch(() => {});
    return;
  }

  const coords = parseWKTPoint(property.location_point);
  const merged = { ...property, latitude: coords.latitude, longitude: coords.longitude };
  const doc = await buildPropertyDocument(merged);
  await es.index({
    index: ES_ALIAS,
    id: propertyId,
    body: doc,
    refresh: 'wait_for',
  });
  console.log(`Indexed: ${propertyId}`);
}

async function bulkIndex() {
  const BATCH_SIZE = 100;
  let page = 0;
  let total = 0;

  console.log('Starting bulk index...');

  while (true) {
    const { data: properties, error } = await supabase
      .from('properties')
      .select('*')
      .range(page * BATCH_SIZE, (page + 1) * BATCH_SIZE - 1);

    if (error || !properties || properties.length === 0) break;

    const body = [];
    for (const prop of properties) {
      const coords = parseWKTPoint(prop.location_point);
      const merged = { ...prop, latitude: coords.latitude, longitude: coords.longitude };
      const doc = await buildPropertyDocument(merged);

      body.push({ index: { _index: ES_ALIAS, _id: prop.id } });
      body.push(doc);
      total++;
    }

    if (body.length > 0) {
      const bulkRes = await es.bulk({ body, refresh: 'wait_for' });
      if (bulkRes.errors) {
        console.warn('Bulk indexing had errors on some documents.');
      }
    }

    page++;
    console.log(`Indexed batch ${page} (${total} total)`);

    if (properties.length < BATCH_SIZE) break;
  }

  console.log(`Bulk index complete. Total documents: ${total}`);
  return total;
}

async function deleteProperty(propertyId) {
  try {
    await es.delete({ index: ES_ALIAS, id: propertyId });
    console.log(`Deleted from ES: ${propertyId}`);
  } catch (err) {
    if (err.statusCode !== 404) {
      console.error(`Failed to delete ${propertyId}:`, err.message);
    }
  }
}

async function verifyConsistency() {
  const { count: pgCount } = await supabase
    .from('properties')
    .select('*', { count: 'exact', head: true });

  const esCount = await es.count({ index: ES_ALIAS });

  console.log(`PostgreSQL: ${pgCount} | Elasticsearch: ${esCount.count}`);
  console.log(`Consistent: ${pgCount === esCount.count ? 'YES' : 'NO (difference: ' + Math.abs((pgCount || 0) - esCount.count) + ')'}`);

  return { pgCount, esCount: esCount.count };
}

async function main() {
  const command = process.argv[2] || 'full-sync';
  const propertyId = process.argv[3];

  const setupCommands = ['setup', 'full-sync'];
  if (setupCommands.includes(command)) {
    await applyIndexTemplate();
    await createIndex();
    await setupAlias();
  }

  switch (command) {
    case 'full-sync':
      await bulkIndex();
      break;
    case 'index-one':
      if (!propertyId) { console.error('Usage: node es-indexer.js index-one <property-id>'); process.exit(1); }
      await indexProperty(propertyId);
      break;
    case 'delete':
      if (!propertyId) { console.error('Usage: node es-indexer.js delete <property-id>'); process.exit(1); }
      await deleteProperty(propertyId);
      break;
    case 'verify':
      await verifyConsistency();
      break;
    case 'setup':
      console.log('Index and alias setup complete.');
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Commands: full-sync, index-one <id>, delete <id>, verify, setup');
      process.exit(1);
  }
}

main().catch(console.error);
