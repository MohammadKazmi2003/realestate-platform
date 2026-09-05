#!/usr/bin/env node

const { execSync } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  try {
    return execSync(cmd, { stdio: 'inherit', ...opts });
  } catch (err) {
    console.error(`Command failed: ${cmd}`);
    if (!opts.ignoreError) process.exit(1);
    return null;
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function validateEnv() {
  const required = ['SUPABASE_ACCESS_TOKEN', 'VERCEL_TOKEN'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    console.error('Set them in your shell or .env file before running.');
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log('Usage: node provision-customer.js <customer-slug> [options]');
    console.log('');
  console.log('Options:');
  console.log('  --name="Company Name"     Display name for the customer');
  console.log('  --domain="example.com"    Custom domain');
  console.log('  --admin-email="a@b.com"   Admin email for the deployment');
  console.log('  --db-password="..."       Database password (auto-generated if not set)');
  console.log('  --region="ap-south-1"     Supabase region (default: ap-south-1)');
  console.log('  Tenant / locale (white-label, zero code changes):');
  console.log('  --tenant="slug"           Tenant slug (default: <slug>); copies tenants/default.json');
  console.log('  --locale="en-IN"          Intl locale for number/date formatting');
  console.log('  --currency="INR"          Default currency code');
  console.log('  --property-currency="INR" Currency for property prices');
  console.log('  --project-currency="AED"  Currency for project prices');
  console.log('  --beds-model="bhk"        bhk (India) or bedrooms (generic)');
  console.log('  --area-unit="sqft"        Default area unit (sqft/sqm/...)');
  console.log('  --map-center="77.0266,28.4595"  Default map center lng,lat');
  console.log('  --map-zoom="4"            Default map zoom');
  console.log('  --geocode-countries=""    MapTiler geocode country filter (e.g. IN,AE or US)');
  console.log('');
    console.log('Required env vars: SUPABASE_ACCESS_TOKEN, VERCEL_TOKEN');
    process.exit(1);
  }

  const slug = args[0].toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const opts = {};
  args.slice(1).forEach((arg) => {
    const match = arg.match(/^--([^=]+)=(.+)$/);
    if (match) opts[match[1]] = match[2];
  });

  const name = opts.name || slug;
  const domain = opts.domain || `${slug}.example.com`;
  const adminEmail = opts['admin-email'] || `admin@${domain}`;
  const region = opts.region || 'ap-south-1';
  const dbPassword = opts['db-password'] || Math.random().toString(36).slice(2, 18) + 'A1!';

  console.log('═══════════════════════════════════════');
  console.log('  White-Label Provisioning Tool');
  console.log('═══════════════════════════════════════');
  console.log(`  Customer: ${name} (${slug})`);
  console.log(`  Domain:   ${domain}`);
  console.log(`  Region:   ${region}`);
  console.log('═══════════════════════════════════════');
  console.log('');

  validateEnv();

  // Step 1: Create Supabase project
  console.log('\n[1/6] Creating Supabase project...');
  const orgs = JSON.parse(execSync('supabase orgs list --output json', { encoding: 'utf-8' }));
  const orgId = orgs[0]?.id;
  if (!orgId) {
    console.error('No Supabase organization found. Run `supabase login` and `supabase orgs list`.');
    process.exit(1);
  }

  run(`supabase projects create "${slug}" --org-id "${orgId}" --db-password "${dbPassword}" --region "${region}"`, { ignoreError: true });

  const projects = JSON.parse(execSync('supabase projects list --output json', { encoding: 'utf-8' }).trim());
  const project = projects.find((p) => p.name === slug);
  if (!project) {
    console.error(`Failed to find project "${slug}". Check Supabase dashboard.`);
    process.exit(1);
  }

  const supabaseUrl = `https://${project.ref}.supabase.co`;
  const anonKey = execSync(`supabase projects api-keys --project-ref ${project.ref} --output json`, { encoding: 'utf-8' }).trim();
  const keys = JSON.parse(anonKey);
  const anonPublicKey = keys.find((k) => k.name === 'anon')?.api_key || '';

  console.log(`  Project ref: ${project.ref}`);
  console.log(`  URL: ${supabaseUrl}`);

  // Step 2: Run database migrations
  console.log('\n[2/6] Running database migrations...');
  run(`supabase link --project-ref ${project.ref}`);
  run(`supabase db push`);

  // Step 3: Seed platform settings
  console.log('\n[3/6] Configuring platform settings...');
  const supabaseServiceKey = execSync(`supabase projects api-keys --project-ref ${project.ref} --output json`, { encoding: 'utf-8' }).trim();
  const serviceKeys = JSON.parse(supabaseServiceKey);
  const serviceKey = serviceKeys.find((k) => k.name === 'service_role')?.api_key || '';

  const updateSettingsSQL = `UPDATE public.platform_settings SET company_name = '${name}', contact_email = '${adminEmail}' WHERE id = 1;`;
  const psqlCmd = `PGPASSWORD="${dbPassword}" psql -h db.${project.ref}.supabase.co -U postgres -d postgres -c "${updateSettingsSQL}"`;
  run(psqlCmd, { ignoreError: true });

  // Step 4: Deploy to Vercel
  console.log('\n[4/6] Deploying to Vercel...');
  const tenantSlug = opts.tenant || slug;
  const envVars = [
    `NEXT_PUBLIC_SUPABASE_URL="${supabaseUrl}"`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY="${anonPublicKey}"`,
    `SUPABASE_SERVICE_KEY="${serviceKey}"`,
    `ELASTICSEARCH_URL="${process.env.ELASTICSEARCH_URL || 'http://localhost:9200'}"`,
    `REDIS_URL="${process.env.REDIS_URL || 'redis://localhost:6379'}"`,
    `NEXT_PUBLIC_MAPTILER_KEY="${process.env.NEXT_PUBLIC_MAPTILER_KEY || ''}"`,
    `NEXT_PUBLIC_TENANT="${tenantSlug}"`,
    `NEXT_PUBLIC_BRAND_NAME="${name}"`,
  ];
  if (opts.locale) envVars.push(`NEXT_PUBLIC_LOCALE="${opts.locale}"`);
  if (opts.currency) envVars.push(`NEXT_PUBLIC_CURRENCY="${opts.currency}"`);
  if (opts['property-currency']) envVars.push(`NEXT_PUBLIC_PROPERTY_CURRENCY="${opts['property-currency']}"`);
  if (opts['project-currency']) envVars.push(`NEXT_PUBLIC_PROJECT_CURRENCY="${opts['project-currency']}"`);
  if (opts['map-center']) envVars.push(`NEXT_PUBLIC_MAP_CENTER="${opts['map-center']}"`);
  if (opts['map-zoom']) envVars.push(`NEXT_PUBLIC_MAP_ZOOM="${opts['map-zoom']}"`);
  if (opts['geocode-countries'] != null) envVars.push(`NEXT_PUBLIC_GEOCODE_COUNTRIES="${opts['geocode-countries']}"`);

  const envArgs = envVars.map((e) => `-e ${e}`).join(' ');
  run(`vercel --prod ${envArgs} --scope "${slug}"`, { ignoreError: true });

  // Step 5: Configure custom domain
  console.log('\n[5/6] Configuring custom domain...');
  run(`vercel domains add "${domain}" --scope "${slug}"`, { ignoreError: true });

  // Step 6: Provision Elasticsearch (if self-managed via Docker)
  console.log('\n[6/6] Provisioning Elasticsearch...');
  const esConfigDir = path.join(process.cwd(), 'deployments', slug);
  if (!fs.existsSync(esConfigDir)) fs.mkdirSync(esConfigDir, { recursive: true });

  const dockerComposeContent = `
version: '3.8'
services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.15.0
    container_name: ${slug}-es
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=true
      - ELASTIC_PASSWORD=\${ES_PASSWORD}
      - "ES_JAVA_OPTS=-Xms1g -Xmx1g"
    ports:
      - "\${ES_PORT:-9200}:9200"
    volumes:
      - ${slug}_es_data:/usr/share/elasticsearch/data
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    container_name: ${slug}-redis
    ports:
      - "\${REDIS_PORT:-6379}:6379"
    volumes:
      - ${slug}_redis_data:/data
    command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
    restart: unless-stopped

volumes:
  ${slug}_es_data:
  ${slug}_redis_data:
`;
  fs.writeFileSync(path.join(esConfigDir, 'docker-compose.yml'), dockerComposeContent.trim());

  // Write env file for this deployment
  const tenantEnvLines = [
    `NEXT_PUBLIC_TENANT=${tenantSlug}`,
    `NEXT_PUBLIC_BRAND_NAME=${name}`,
  ];
  if (opts.locale) tenantEnvLines.push(`NEXT_PUBLIC_LOCALE=${opts.locale}`);
  if (opts.currency) tenantEnvLines.push(`NEXT_PUBLIC_CURRENCY=${opts.currency}`);
  if (opts['property-currency']) tenantEnvLines.push(`NEXT_PUBLIC_PROPERTY_CURRENCY=${opts['property-currency']}`);
  if (opts['project-currency']) tenantEnvLines.push(`NEXT_PUBLIC_PROJECT_CURRENCY=${opts['project-currency']}`);
  if (opts['map-center']) tenantEnvLines.push(`NEXT_PUBLIC_MAP_CENTER=${opts['map-center']}`);
  if (opts['map-zoom']) tenantEnvLines.push(`NEXT_PUBLIC_MAP_ZOOM=${opts['map-zoom']}`);
  if (opts['geocode-countries'] != null) tenantEnvLines.push(`NEXT_PUBLIC_GEOCODE_COUNTRIES=${opts['geocode-countries']}`);
  const envContent = `
# ${name} - White-Label Deployment
# Generated: ${new Date().toISOString()}
# Tenant: copy tenants/default.json to tenants/${tenantSlug}.json and adjust
# locale/currency/bedsModel/areaUnit/map for this market (zero code changes).

# Tenant identity (see tenants/*.json + src/lib/tenant.ts)
${tenantEnvLines.join('\n')}

# Supabase
NEXT_PUBLIC_SUPABASE_URL=${supabaseUrl}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${anonPublicKey}
SUPABASE_SERVICE_KEY=${serviceKey}

# Elasticsearch
ELASTICSEARCH_URL=http://localhost:9200
ELASTICSEARCH_API_KEY=

# Redis
REDIS_URL=redis://localhost:6379

# External Services
NEXT_PUBLIC_MAPTILER_KEY=${process.env.NEXT_PUBLIC_MAPTILER_KEY || ''}

# Deployment
NEXT_PUBLIC_SITE_URL=https://${domain}
`;
  fs.writeFileSync(path.join(esConfigDir, '.env.deployment'), envContent.trim());

  // Stamp tenants/{slug}.json from default so the buyer starts from a working
  // config. Buyers edit locale/currency/bedsModel/areaUnit/map + register the
  // slug in src/lib/tenant.ts registry (one line).
  try {
    const defaultTenantPath = path.join(process.cwd(), 'tenants', 'default.json');
    const tenantOutPath = path.join(process.cwd(), 'tenants', `${tenantSlug}.json`);
    if (fs.existsSync(defaultTenantPath) && !fs.existsSync(tenantOutPath)) {
      const cfg = JSON.parse(fs.readFileSync(defaultTenantPath, 'utf-8'));
      cfg.slug = tenantSlug;
      cfg.brand = { ...(cfg.brand || {}), name };
      if (opts.locale) cfg.locale = opts.locale;
      if (opts.currency) cfg.currency = opts.currency;
      if (opts['property-currency']) cfg.propertyCurrency = opts['property-currency'];
      if (opts['project-currency']) cfg.projectCurrency = opts['project-currency'];
      if (opts['beds-model']) {
        cfg.bedsModel = opts['beds-model'];
        cfg.bedsLabel = opts['beds-model'] === 'bedrooms' ? 'Beds' : 'BHK';
      }
      if (opts['area-unit']) cfg.areaUnit = opts['area-unit'];
      if (opts['map-center']) {
        const [lng, lat] = String(opts['map-center']).split(',').map(Number);
        if (Number.isFinite(lng) && Number.isFinite(lat)) cfg.map = { ...(cfg.map || {}), center: [lng, lat] };
      }
      if (opts['map-zoom']) cfg.map = { ...(cfg.map || {}), zoom: Number(opts['map-zoom']) };
      if (opts['geocode-countries'] != null) cfg.map = { ...(cfg.map || {}), geocodeCountries: opts['geocode-countries'] };
      fs.writeFileSync(tenantOutPath, JSON.stringify(cfg, null, 2) + '\n');
      console.log(`  Tenant config stamped: tenants/${tenantSlug}.json`);
      console.log(`  Next: register "${tenantSlug}" in src/lib/tenant.ts registry + seed locale lookups (bhk_types or bedrooms).`);
    }
  } catch (err) {
    console.warn(`  Tenant stamping skipped: ${err.message}`);
  }

  // Summary
  console.log('\n═══════════════════════════════════════');
  console.log('  Provisioning Complete!');
  console.log('═══════════════════════════════════════');
  console.log(`  Supabase URL:   ${supabaseUrl}`);
  console.log(`  Custom Domain:  https://${domain}`);
  console.log(`  Admin Email:    ${adminEmail}`);
  console.log(`  Config Dir:     ${esConfigDir}`);
  console.log('');
  console.log('  Next steps:');
  console.log(`  1. Run: cd ${esConfigDir} && docker-compose up -d`);
  console.log(`  2. Run: ES_PASSWORD=changeme node scripts/es-indexer.js setup`);
  console.log(`  3. Index data: node scripts/es-indexer.js full-sync  (dual-writes bedrooms alongside bhk_type)`);
  console.log(`  4. Verify: node scripts/es-indexer.js verify`);
  console.log(`  5. Visit https://${domain} to confirm deployment`);
  console.log('═══════════════════════════════════════');
}

main().catch(console.error);
