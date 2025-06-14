/** @type {import('next').NextConfig} */
const nextConfig = {
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
          hostname: 'placehold.co',
          port: '',
          pathname: '/**',
        },
      ],
    },
  };
  
  export default nextConfig;
  