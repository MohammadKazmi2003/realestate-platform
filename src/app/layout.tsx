import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/context/AuthContext";
import { BrandingProvider, type PlatformSettings } from "@/context/BrandingContext";
import { createSupabaseServerClient } from "@/lib/supabase/serverClient";

async function getPlatformSettings(): Promise<PlatformSettings | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase
      .from('platform_settings')
      .select('*')
      .single();
    return data;
  } catch {
    return null;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getPlatformSettings();
  return {
    title: settings?.meta_title || settings?.company_name || 'Real Estate Platform',
    description: settings?.meta_description || 'Find your perfect property',
    icons: settings?.favicon_url ? { icon: settings.favicon_url } : undefined,
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const settings = await getPlatformSettings();

  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        <AuthProvider>
          <BrandingProvider initialSettings={settings}>
            {children}
          </BrandingProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
