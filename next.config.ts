// next.config.ts

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'kueunpcwzvytbyaogyqs.supabase.co', // Your Supabase domain
        port: '', 
        // Updated to be more specific to your 'property-images' bucket
        pathname: '/storage/v1/object/public/property-images/**', 
      },
      {
        protocol: 'https',
        hostname: 'placehold.co', // For placeholder images during development
        port: '',
        pathname: '/**', 
      },
      // If you use other external image domains, add their patterns here
    ],
  },
  webpack: (config) => {
    config.resolve.fallback = { fs: false, net: false, tls: false };
    return config;
  },
  env: {
    SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },
  eslint: { 
    ignoreDuringBuilds: true,
  },
  typescript: { 
    ignoreBuildErrors: true,
  },
};

// Check for environment variables *outside* the config object
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  console.error('Error: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables are required!');
  process.exit(1); // Exit the process to prevent the server from starting with missing env vars
}

module.exports = nextConfig;
