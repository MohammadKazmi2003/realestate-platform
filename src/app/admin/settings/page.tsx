'use client';

import { withAuth } from '@/utils/withAuth';
import Header from '@/app/components/Header';
import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { platformSettingsSchema, type PlatformSettingsInput } from '@/lib/validation';
import { Loader2, Check, AlertCircle } from 'lucide-react';

function AdminSettingsPage() {
  const [settings, setSettings] = useState<PlatformSettingsInput>({
    company_name: '', primary_color: '#3B82F6', secondary_color: '#1E293B',
    accent_color: '#F59E0B', logo_url: '', logo_dark_url: '', favicon_url: '',
    contact_email: '', contact_phone: '', meta_title: '', meta_description: '',
    footer_text: '',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const fetchSettings = async () => {
      const { data, error } = await supabase.from('platform_settings').select('*').single();
      if (!error && data) {
        setSettings({
          company_name: data.company_name || '',
          primary_color: data.primary_color || '#3B82F6',
          secondary_color: data.secondary_color || '#1E293B',
          accent_color: data.accent_color || '#F59E0B',
          logo_url: data.logo_url || '',
          logo_dark_url: data.logo_dark_url || '',
          favicon_url: data.favicon_url || '',
          contact_email: data.contact_email || '',
          contact_phone: data.contact_phone || '',
          meta_title: data.meta_title || '',
          meta_description: data.meta_description || '',
          footer_text: data.footer_text || '',
        });
      }
      setLoading(false);
    };
    fetchSettings();
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setSettings((prev) => ({ ...prev, [name]: value }));
    setErrors((prev) => ({ ...prev, [name]: '' }));
  };

  const handleSave = async () => {
    setMessage(null);
    setErrors({});

    const result = platformSettingsSchema.safeParse({
      ...settings,
      logo_url: settings.logo_url || null,
      logo_dark_url: settings.logo_dark_url || null,
      favicon_url: settings.favicon_url || null,
      contact_email: settings.contact_email || null,
      contact_phone: settings.contact_phone || null,
      meta_title: settings.meta_title || null,
      meta_description: settings.meta_description || null,
      footer_text: settings.footer_text || null,
    });

    if (!result.success) {
      const flattened = result.error.flatten();
      const fieldErrors: Record<string, string> = {};
      Object.entries(flattened.fieldErrors).forEach(([key, msgs]) => {
        if (msgs && msgs.length > 0) {
          fieldErrors[key] = msgs[0];
        }
      });
      setErrors(fieldErrors);
      return;
    }

    setSaving(true);
    const { error } = await supabase
      .from('platform_settings')
      .update(result.data)
      .eq('id', 1);

    if (error) {
      setMessage({ type: 'error', text: `Failed to save: ${error.message}` });
    } else {
      setMessage({ type: 'success', text: 'Settings saved successfully. Refresh the site to see changes.' });
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="bg-bg-color min-h-screen">
        <Header />
        <div className="flex justify-center items-center h-64"><Loader2 className="animate-spin text-4xl" /></div>
      </div>
    );
  }

  const inputClass = "neumorphic-input w-full";
  const labelClass = "block text-sm font-medium text-text-color-dark mb-1";
  const errorClass = "text-xs text-red-500 mt-1";

  return (
    <div className="bg-bg-color min-h-screen text-text-color-dark">
      <Header />
      <main className="p-6 max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">Platform Settings</h1>
        <p className="text-text-color-light mb-8">Configure your white-label branding, colors, and contact information.</p>

        {message && (
          <div className={`mb-6 p-4 rounded-xl flex items-center gap-2 ${message.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
            {message.type === 'success' ? <Check size={18} /> : <AlertCircle size={18} />}
            {message.text}
          </div>
        )}

        <div className="space-y-8">
          <section className="shadow-neumorphic-outset rounded-3xl p-6 space-y-4">
            <h2 className="text-xl font-semibold">Branding</h2>
            <div>
              <label className={labelClass}>Company Name</label>
              <input name="company_name" value={settings.company_name} onChange={handleChange} className={inputClass} />
              {errors.company_name && <p className={errorClass}>{errors.company_name}</p>}
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className={labelClass}>Primary Color</label>
                <div className="flex items-center gap-2">
                  <input type="color" name="primary_color" value={settings.primary_color} onChange={handleChange} className="h-10 w-16 rounded cursor-pointer" />
                  <input name="primary_color" value={settings.primary_color} onChange={handleChange} className={inputClass} />
                </div>
                {errors.primary_color && <p className={errorClass}>{errors.primary_color}</p>}
              </div>
              <div>
                <label className={labelClass}>Secondary Color</label>
                <div className="flex items-center gap-2">
                  <input type="color" name="secondary_color" value={settings.secondary_color} onChange={handleChange} className="h-10 w-16 rounded cursor-pointer" />
                  <input name="secondary_color" value={settings.secondary_color} onChange={handleChange} className={inputClass} />
                </div>
                {errors.secondary_color && <p className={errorClass}>{errors.secondary_color}</p>}
              </div>
              <div>
                <label className={labelClass}>Accent Color</label>
                <div className="flex items-center gap-2">
                  <input type="color" name="accent_color" value={settings.accent_color} onChange={handleChange} className="h-10 w-16 rounded cursor-pointer" />
                  <input name="accent_color" value={settings.accent_color} onChange={handleChange} className={inputClass} />
                </div>
                {errors.accent_color && <p className={errorClass}>{errors.accent_color}</p>}
              </div>
            </div>
            <div>
              <label className={labelClass}>Logo URL</label>
              <input name="logo_url" value={settings.logo_url || ''} onChange={handleChange} placeholder="https://..." className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Logo URL (Dark Mode)</label>
              <input name="logo_dark_url" value={settings.logo_dark_url || ''} onChange={handleChange} placeholder="https://..." className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Favicon URL</label>
              <input name="favicon_url" value={settings.favicon_url || ''} onChange={handleChange} placeholder="https://..." className={inputClass} />
            </div>
          </section>

          <section className="shadow-neumorphic-outset rounded-3xl p-6 space-y-4">
            <h2 className="text-xl font-semibold">Contact Information</h2>
            <div>
              <label className={labelClass}>Email</label>
              <input name="contact_email" type="email" value={settings.contact_email || ''} onChange={handleChange} className={inputClass} />
              {errors.contact_email && <p className={errorClass}>{errors.contact_email}</p>}
            </div>
            <div>
              <label className={labelClass}>Phone</label>
              <input name="contact_phone" value={settings.contact_phone || ''} onChange={handleChange} className={inputClass} />
            </div>
          </section>

          <section className="shadow-neumorphic-outset rounded-3xl p-6 space-y-4">
            <h2 className="text-xl font-semibold">SEO & Metadata</h2>
            <div>
              <label className={labelClass}>Meta Title</label>
              <input name="meta_title" value={settings.meta_title || ''} onChange={handleChange} placeholder="My Real Estate Platform" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Meta Description</label>
              <textarea name="meta_description" value={settings.meta_description || ''} onChange={handleChange} rows={3} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Footer Text</label>
              <input name="footer_text" value={settings.footer_text || ''} onChange={handleChange} className={inputClass} />
            </div>
          </section>

          <button onClick={handleSave} disabled={saving} className="neumorphic-button bg-cta-gradient w-full py-3 text-lg">
            {saving ? <Loader2 className="animate-spin mx-auto" /> : 'Save Settings'}
          </button>
        </div>
      </main>
    </div>
  );
}

export default withAuth(AdminSettingsPage);
