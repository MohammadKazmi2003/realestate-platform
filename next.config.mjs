/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'kueunpcwzvytbyaogyqs.supabase.co',
        port: '',
        pathname: '/storage/v1/object/public/property-images/**',
      },
      {
        protocol: 'https',
        hostname: '**.propertyfinder.com',
      },
      {
        protocol: 'https',
        hostname: 'placehold.co',
        port: '',
        pathname: '/**',
      },
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
  async rewrites() {
    return [
      {
        source: '/api/chat',
        destination: 'http://localhost:8000/api/chat',
      },
      {
        source: '/api/chat_langchain',
        destination: 'http://localhost:8000/api/chat_langchain',
      },
      {
        source: '/api/health',
        destination: 'http://localhost:8000/health',
      },
    ];
  },
};

// This validation check is also preserved from your old config.
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  console.error('Error: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables are required!');
  process.exit(1);
}

// ✅ Use ESM export syntax
export default nextConfig;
