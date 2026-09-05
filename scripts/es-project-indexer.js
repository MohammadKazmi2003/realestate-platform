const { Client } = require('@elastic/elasticsearch');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

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

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ES_URL = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';
const ES_ALIAS = 'projects_search';
const INDEX_VERSION = process.env.PROJECTS_INDEX_VERSION || 'v1';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const es = new Client({ node: ES_URL, maxRetries: 3 });

const INDEX_NAME = `projects_${INDEX_VERSION}`;

async function applyIndexTemplate() {
  const templatePath = path.join(__dirname, '..', 'es-config', 'projects-index-template.json');
  if (!fs.existsSync(templatePath)) {
    console.warn('Project index template file not found. Skipping.');
    return;
  }
  try {
    const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
    await es.indices.putIndexTemplate({
      name: 'projects_template',
      body: {
        index_patterns: ['projects_v*'],
        priority: 100,
        template,
      },
    });
    console.log('Project index template applied successfully.');
  } catch (err) {
    console.warn('Failed to apply project index template:', err.message.split('\n')[0]);
  }
}

async function createIndex() {
  const exists = await es.indices.exists({ index: INDEX_NAME });
  if (exists) {
    await es.indices.delete({ index: INDEX_NAME });
    console.log(`Deleted existing index: ${INDEX_NAME}`);
  }

  const mappingsPath = path.join(__dirname, '..', 'es-config', 'projects-mappings.json');
  let body = {
    settings: { number_of_shards: 1, number_of_replicas: 1 },
  };

  if (fs.existsSync(mappingsPath)) {
    body = JSON.parse(fs.readFileSync(mappingsPath, 'utf-8'));
  }

  await es.indices.create({ index: INDEX_NAME, body });
  console.log(`Created index: ${INDEX_NAME} with project mappings`);
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

async function buildProjectDocument(project, unitsByProject) {
  const unitsPromise = unitsByProject
    ? Promise.resolve({ data: unitsByProject[project.id] || [] })
    : supabase.from('unit_configurations').select('bedrooms').eq('project_id', project.id);
  const [developerRes, imageRes, locationRes, amenityRes, unitsRes] = await Promise.all([
    supabase.from('developers').select('name').eq('id', project.developer_id).maybeSingle(),
    // Full gallery (primary first, cap 10) — the click carousel needs every
    // photo, not just the cover. Was limit(1): the reason project cards and
    // the map gallery showed a single image despite ~6.5 photos per project.
    supabase.from('project_images').select('storage_path_original').eq('project_id', project.id).order('is_primary', { ascending: false }).order('id', { ascending: true }).limit(10),
    supabase.from('project_locations').select('locations(name)').eq('project_id', project.id).order('level', { referencedTable: 'locations', ascending: false }).limit(1).maybeSingle(),
    supabase.from('project_amenities').select('amenities(name)').eq('project_id', project.id),
    unitsPromise,
  ]);

  const amenities = (amenityRes.data || [])
    .map((a) => a.amenities?.name || '')
    .filter(Boolean);

  const gallery = (imageRes.data || [])
    .map((r) => r.storage_path_original)
    .filter((u) => typeof u === 'string' && u.length > 0);

  // Unit summary for cards: distinct bedroom counts + total configs.
  // Display formatting (BHK vs Beds) happens per tenant at render time.
  const bedrooms_list = Array.from(
    new Set(
      (unitsRes.data || [])
        .map((u) => u.bedrooms)
        .filter((b) => Number.isInteger(b) && b >= 0)
    )
  ).sort((a, b) => a - b);
  const unit_count = (unitsRes.data || []).length;

  const doc = {
    id: project.id,
    name: project.name || '',
    slug: project.slug || '',
    description: project.description_html || project.description || '',
    developer_name: developerRes.data?.name || project.builder_name || '',
    low_price: project.low_price || 0,
    high_price: project.high_price || 0,
    sort_price: project.low_price || 0,
    entity_type: 'project',
    status: 'available',
    construction_phase: project.construction_phase || '',
    delivery_date: project.delivery_date || null,
    location_text: locationRes.data?.locations?.name || '',
    location: project.latitude != null && project.longitude != null
      ? { lat: Number(project.latitude), lon: Number(project.longitude) }
      : null,
    amenities,
    image_url: gallery[0] || null,
    all_images: gallery,
    bedrooms_list,
    unit_count,
    payment_plan_summary: project.payment_plan_summary || null,
    construction_progress_percent: project.construction_progress_percent ?? null,
    created_at: project.created_at,
    suggest: [
      project.name?.trim(),
      locationRes.data?.locations?.name?.trim(),
      developerRes.data?.name?.trim(),
    ].filter(Boolean),
  };

  return doc;
}

async function indexProject(projectId) {
  const { data: project, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single();

  if (error || !project) {
    console.warn(`Project ${projectId} not found. Deleting from ES.`);
    await es.delete({ index: ES_ALIAS, id: projectId }).catch(() => {});
    return;
  }

  const doc = await buildProjectDocument(project);
  await es.index({
    index: ES_ALIAS,
    id: projectId,
    body: doc,
    refresh: 'wait_for',
  });
  console.log(`Indexed project: ${projectId} (${project.name})`);
}

async function bulkIndex() {
  const BATCH_SIZE = 100;
  let page = 0;
  let total = 0;

  console.log('Starting bulk project index...');

  // One paginated prefetch for all unit configs instead of one query per
  // project. NOTE: PostgREST caps a single response at 1000 rows and there
  // are 4000+ unit rows — an unpaginated select silently drops every project
  // past row 1000 (empty bedrooms_list). Always page to exhaustion.
  // null = fetch failed → buildProjectDocument falls back per project.
  let unitsByProject = null;
  try {
    const allUnits = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: page, error: pageError } = await supabase
        .from('unit_configurations')
        .select('project_id, bedrooms')
        .range(from, from + PAGE - 1);
      if (pageError) throw pageError;
      allUnits.push(...(page || []));
      if (!page || page.length < PAGE) break;
    }
    if (allUnits.length > 0) {
      unitsByProject = {};
      for (const u of allUnits) {
        (unitsByProject[u.project_id] = unitsByProject[u.project_id] || []).push(u);
      }
    }
    console.log(`Prefetched ${allUnits.length} unit configurations.`);
  } catch (err) {
    console.warn('Unit prefetch failed, falling back to per-project fetch:', err.message?.split('\n')[0]);
    unitsByProject = null;
  }

  while (true) {
    const { data: projects, error } = await supabase
      .from('projects')
      .select('*')
      .range(page * BATCH_SIZE, (page + 1) * BATCH_SIZE - 1);

    if (error || !projects || projects.length === 0) break;

    const body = [];
    for (const proj of projects) {
      const doc = await buildProjectDocument(proj, unitsByProject);
      body.push({ index: { _index: ES_ALIAS, _id: proj.id } });
      body.push(doc);
      total++;
    }

    if (body.length > 0) {
      const bulkRes = await es.bulk({ body, refresh: 'wait_for' });
      if (bulkRes.errors) {
        console.warn('Bulk project indexing had errors on some documents.');
      }
    }

    page++;
    console.log(`Indexed batch ${page} (${total} total)`);

    if (projects.length < BATCH_SIZE) break;
  }

  console.log(`Bulk project index complete. Total documents: ${total}`);
  return total;
}

async function deleteProject(projectId) {
  try {
    await es.delete({ index: ES_ALIAS, id: projectId });
    console.log(`Deleted from ES: ${projectId}`);
  } catch (err) {
    if (err.statusCode !== 404) {
      console.error(`Failed to delete ${projectId}:`, err.message);
    }
  }
}

async function verifyConsistency() {
  const { count: pgCount } = await supabase
    .from('projects')
    .select('*', { count: 'exact', head: true });

  const esCount = await es.count({ index: ES_ALIAS });

  console.log(`PostgreSQL: ${pgCount} | Elasticsearch: ${esCount.count}`);
  console.log(`Consistent: ${pgCount === esCount.count ? 'YES' : 'NO (difference: ' + Math.abs((pgCount || 0) - esCount.count) + ')'}`);

  return { pgCount, esCount: esCount.count };
}

async function main() {
  const command = process.argv[2] || 'full-sync';
  const projectId = process.argv[3];

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
      if (!projectId) { console.error('Usage: node es-project-indexer.js index-one <project-id>'); process.exit(1); }
      await indexProject(projectId);
      break;
    case 'delete':
      if (!projectId) { console.error('Usage: node es-project-indexer.js delete <project-id>'); process.exit(1); }
      await deleteProject(projectId);
      break;
    case 'verify':
      await verifyConsistency();
      break;
    case 'setup':
      console.log('Project index and alias setup complete.');
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Commands: full-sync, index-one <id>, delete <id>, verify, setup');
      process.exit(1);
  }
}

main().catch(console.error);
