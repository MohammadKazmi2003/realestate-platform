'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';

export type PlatformSettings = {
  company_name: string;
  primary_color: string;
  secondary_color: string;
  accent_color: string;
  logo_url: string | null;
  logo_dark_url: string | null;
  favicon_url: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  meta_title: string | null;
  meta_description: string | null;
  footer_text: string | null;
};

const defaultSettings: PlatformSettings = {
  company_name: 'Real Estate Platform',
  primary_color: '#3B82F6',
  secondary_color: '#1E293B',
  accent_color: '#F59E0B',
  logo_url: null,
  logo_dark_url: null,
  favicon_url: null,
  contact_email: null,
  contact_phone: null,
  meta_title: null,
  meta_description: null,
  footer_text: null,
};

const BrandingContext = createContext<PlatformSettings>(defaultSettings);

export function useBranding() {
  return useContext(BrandingContext);
}

export function BrandingProvider({
  children,
  initialSettings,
}: {
  children: React.ReactNode;
  initialSettings: PlatformSettings | null;
}) {
  const [settings, setSettings] = useState<PlatformSettings>(initialSettings || defaultSettings);

  useEffect(() => {
    if (initialSettings) setSettings(initialSettings);
  }, [initialSettings]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--color-primary', settings.primary_color);
    root.style.setProperty('--color-secondary', settings.secondary_color);
    root.style.setProperty('--color-accent', settings.accent_color);
    document.title = settings.meta_title || settings.company_name;
  }, [settings]);

  useEffect(() => {
    if (settings.favicon_url) {
      let link = document.querySelector("link[rel~='icon']") as HTMLLinkElement;
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = settings.favicon_url;
    }
  }, [settings.favicon_url]);

  return (
    <BrandingContext.Provider value={settings}>
      {children}
    </BrandingContext.Provider>
  );
}
