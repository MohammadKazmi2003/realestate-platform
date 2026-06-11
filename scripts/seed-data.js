const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
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

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || process.env.PYTHON_SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.PYTHON_SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_SERVICE_KEY is required for seeding.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const LOCATIONS = [
  { city: 'Mumbai', areas: ['Bandra West', 'Andheri East', 'Powai', 'Juhu', 'Worli', 'Lower Parel', 'Malad', 'Goregaon'], lat: 19.0760, lng: 72.8777 },
  { city: 'Bangalore', areas: ['Koramangala', 'Indiranagar', 'Whitefield', 'JP Nagar', 'HSR Layout', 'Marathahalli', 'Electronic City', 'Sarjapur'], lat: 12.9716, lng: 77.5946 },
  { city: 'Delhi', areas: ['Dwarka', 'Vasant Kunj', 'Greater Kailash', 'Lajpat Nagar', 'Saket', 'Pitampura', 'Rohini', 'Mayur Vihar'], lat: 28.6139, lng: 77.2090 },
  { city: 'Hyderabad', areas: ['Gachibowli', 'Madhapur', 'Kondapur', 'HITEC City', 'Begumpet', 'Jubilee Hills', 'Banjara Hills', 'Manikonda'], lat: 17.3850, lng: 78.4867 },
  { city: 'Pune', areas: ['Hinjewadi', 'Kharadi', 'Viman Nagar', 'Wakad', 'Baner', 'Hadapsar', 'Kothrud', 'Aundh'], lat: 18.5204, lng: 73.8567 },
];

const PROPERTY_NAMES = [
  'Skyline Residences', 'Green Valley Apartments', 'Prestige Towers', 'Suncity Gardens',
  'Lake View Heights', 'Royal Palm Estate', 'Silver Oak Villas', 'Maple Enclave',
  'Golden Gate Plaza', 'Crystal Court', 'Emerald Greens', 'The Palm Springs',
  'Oasis Retreat', 'Cloud Nine Homes', 'Citrus County', 'Ivory Towers',
  'The Serenity', 'Blossom Fields', 'Harmony Heights', 'Sunrise Avenue',
];

const DEVELOPERS = [
  'Prestige Group', 'DLF Limited', 'Godrej Properties', 'Sobha Limited',
  'Brigade Group', 'Tata Housing', 'Mahindra Lifespaces', 'Hiranandani',
  'Lodha Group', 'Puravankara', 'Shapoorji Pallonji', 'Embassy Group',
];

const AMENITY_IDS = Array.from({ length: 15 }, (_, i) => i + 1);
const FURNISHING_IDS = Array.from({ length: 10 }, (_, i) => i + 1);

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomPick(arr, count = 1) {
  const shuffled = [...arr].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

function randomFloat(min, max, decimals = 2) {
  return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
}

async function createTestUser(email, password, roleId) {
  const { data: existingUser } = await supabase.auth.admin.listUsers();
  const exists = existingUser?.users?.find((u) => u.email === email);

  if (exists) {
    const profile = await supabase.from('profiles').select('id').eq('email', email).single();
    if (profile.data) {
      await supabase.from('profiles').update({ role_id: roleId, phone_number: `+91${randomInt(7000000000, 9999999999)}` }).eq('id', profile.data.id);
    }
    return profile.data?.id;
  }

  const { data: user, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error) {
    console.error(`Failed to create user ${email}:`, error.message);
    return null;
  }

  await supabase.from('profiles').update({ role_id: roleId, phone_number: `+91${randomInt(7000000000, 9999999999)}` }).eq('id', user.user.id);

  return user.user.id;
}

async function seedProperties(count = 1000, ownerIds = []) {
  console.log(`Seeding ${count} properties...`);

  const propertyTypeMap = { 1: 'residential', 2: 'residential', 3: 'commercial', 4: 'commercial', 5: 'land' };

  for (let i = 0; i < count; i++) {
    const location = LOCATIONS[randomInt(0, LOCATIONS.length - 1)];
    const area = location.areas[randomInt(0, location.areas.length - 1)];
    const propertyTypeId = randomInt(1, 5);
    const listingPurposeId = randomInt(1, 3);
    const name = `${randomPick(PROPERTY_NAMES, 1)[0]} - Phase ${randomInt(1, 4)}`;
    const developer = randomPick(DEVELOPERS, 1)[0];
    const userId = ownerIds[randomInt(0, ownerIds.length - 1)] || null;

    const isResidential = propertyTypeId <= 2;
    const isCommercial = propertyTypeId === 3 || propertyTypeId === 4;
    const isLand = propertyTypeId === 5;

    const lat = location.lat + randomFloat(-0.05, 0.05, 6);
    const lng = location.lng + randomFloat(-0.05, 0.05, 6);

    let price;
    if (isLand) {
      price = randomFloat(500000, 50000000);
    } else if (isCommercial) {
      price = randomFloat(1000000, 100000000);
    } else {
      price = randomFloat(1500000, 50000000);
    }

    const property = {
      title: `${randomInt(1, 5)} BHK ${name} in ${area}, ${location.city}`,
      description: `${name} by ${developer}. Located in the prime area of ${area}, ${location.city}. This ${randomInt(1000, 3000)} sqft property offers world-class amenities and modern living.`,
      price,
      location_text: `${area}, ${location.city}`,
      location_point: `POINT(${lng} ${lat})`,
      property_type_id: propertyTypeId,
      listing_purpose_id: listingPurposeId,
      availability_status_id: randomInt(1, 3),
      ownership_type_id: randomInt(1, 4),
      is_price_negotiable: Math.random() > 0.5,
      property_score: randomInt(1, 100),
      status: 'available',
      user_id: userId,
    };

    const { data: prop, error: propError } = await supabase
      .from('properties')
      .insert(property)
      .select('id')
      .single();

    if (propError) {
      console.error(`Failed to insert property ${i}:`, propError.message);
      continue;
    }

    const propertyId = prop.id;

    if (isResidential) {
      const bhkTypeId = randomInt(1, 10);
      const furnishingStatusId = randomInt(1, 3);
      await supabase.from('details_residential').insert({
        property_id: propertyId,
        bhk_type_id: bhkTypeId,
        bathrooms: Math.min(bhkTypeId, 4),
        balconies: randomInt(0, 3),
        carpet_area: randomFloat(500, 3000),
        built_up_area: randomFloat(600, 3500),
        super_built_up_area: randomFloat(700, 4000),
        total_floors: randomInt(1, 30),
        property_on_floor: randomInt(1, 30),
        furnishing_status_id: furnishingStatusId,
        power_backup_status: Math.random() > 0.3 ? 'full' : 'partial',
      });
    } else if (isCommercial) {
      await supabase.from('details_commercial').insert({
        property_id: propertyId,
        min_seats: randomInt(4, 50),
        max_seats: randomInt(50, 200),
        cabins: randomInt(1, 10),
        meeting_rooms: randomInt(1, 5),
        private_washrooms: randomInt(1, 4),
        shared_washrooms: randomInt(2, 8),
        passenger_lifts: randomInt(1, 6),
        service_lifts: randomInt(0, 2),
        carpet_area: randomFloat(500, 10000),
        total_floors: randomInt(1, 20),
        property_on_floor: randomInt(1, 20),
      });
    } else if (isLand) {
      await supabase.from('details_land').insert({
        property_id: propertyId,
        plot_area: randomFloat(500, 10000),
        area_unit: randomPick(['sqft', 'sqyd', 'acre'])[0],
        is_boundary_wall_made: Math.random() > 0.4,
      });
    }

    const selectedAmenities = randomPick(AMENITY_IDS, randomInt(3, 10));
    const selectedFurnishings = randomPick(FURNISHING_IDS, randomInt(2, 6));

    await Promise.all([
      ...selectedAmenities.map((aid) =>
        supabase.from('junction_property_amenities').insert({ property_id: propertyId, amenity_id: aid }).then(({ error }) => error && console.warn('amenity err'))
      ),
      ...selectedFurnishings.map((fid) =>
        supabase.from('junction_property_furnishings').insert({ property_id: propertyId, furnishing_item_id: fid }).then(({ error }) => error && console.warn('furnishing err'))
      ),
    ]);

    await supabase.from('property_media').insert([
      { property_id: propertyId, media_url: `https://placehold.co/800x600/DEE4ED/3D4A5C?text=${encodeURIComponent(name)}`, media_type: 'image', display_order: 0 },
      { property_id: propertyId, media_url: `https://placehold.co/800x600/E2E8F0/475569?text=Living+Room`, media_type: 'image', display_order: 1 },
      { property_id: propertyId, media_url: `https://placehold.co/800x600/CBD5E1/1E293B?text=Bedroom`, media_type: 'image', display_order: 2 },
    ]).then(({ error }) => error && console.warn('media err'));

    if (i % 50 === 0) {
      console.log(`  Seeded ${i}/${count} properties...`);
    }
  }

  console.log(`Seeded ${count} properties complete.`);
}

async function main() {
  const numProperties = parseInt(process.argv[2], 10) || 1000;

  console.log('Creating test users...');
  await createTestUser('admin@test.com', 'password123', 1);
  const ownerId = await createTestUser('owner@test.com', 'password123', 2);
  await createTestUser('agent@test.com', 'password123', 3);
  await createTestUser('user@test.com', 'password123', 4);

  const ownerIds = [ownerId].filter(Boolean);
  if (ownerIds.length === 0) {
    console.error('Failed to create any property owner. Check user creation.');
    process.exit(1);
  }

  console.log('Seeding properties...');
  await seedProperties(numProperties, ownerIds);

  console.log('\nSeed complete!');
  console.log('Test accounts:');
  console.log('  admin@test.com / password123 (Admin)');
  console.log('  owner@test.com / password123 (Property Owner)');
  console.log('  agent@test.com / password123 (Agent)');
  console.log('  user@test.com / password123   (Regular User)');
}

main().catch(console.error);
