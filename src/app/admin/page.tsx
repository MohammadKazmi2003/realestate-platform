// src/app/admin/page.tsx
'use client';

import { withAuth } from '@/utils/withAuth';
import Header from '@/app/components/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sun, Moon, Loader2, Settings } from 'lucide-react';
import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import Link from 'next/link';

type AdminStats = {
  total_listings: number;
  active_agents: number;
  new_user_signups_24h: number;
  total_leads: number;
};

function AdminDashboard() {
  const [darkMode, setDarkMode] = useState(false);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStats = async () => {
      setLoading(true);
      const { data, error } = await supabase.rpc('get_admin_dashboard_stats').single();
      if (error) {
        console.error("Error fetching admin stats:", error);
      } else {
        setStats(data);
      }
      setLoading(false);
    };
    fetchStats();
  }, []);

  const toggleDarkMode = () => {
    setDarkMode(!darkMode);
  };
  
  const chartData = [
      { name: 'Listings', value: stats?.total_listings || 0 },
      { name: 'Agents', value: stats?.active_agents || 0 },
      { name: 'Leads', value: stats?.total_leads || 0 },
  ];

  return (
    <div className={darkMode ? 'dark' : ''}>
      <div className="bg-bg-color min-h-screen text-text-color-dark dark:bg-gray-900 dark:text-gray-100">
        <Header />
        <main className="p-6 max-w-7xl mx-auto">
          <div className="flex justify-between items-center mb-8">
            <h1 className="text-3xl font-bold">Admin Dashboard</h1>
            <div className="flex items-center gap-3">
              <Link href="/admin/settings" className="p-2 rounded-full neumorphic-button" title="Platform Settings">
                <Settings />
              </Link>
              <button onClick={toggleDarkMode} className="p-2 rounded-full neumorphic-button">
                {darkMode ? <Sun /> : <Moon />}
              </button>
            </div>
          </div>

          {loading ? (
            <div className="flex justify-center items-center h-32">
                <Loader2 className="animate-spin text-4xl" />
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <Card>
                <CardHeader><CardTitle>Total Listings</CardTitle></CardHeader>
                <CardContent><p className="text-2xl font-bold">{stats?.total_listings}</p></CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Active Agents</CardTitle></CardHeader>
                <CardContent><p className="text-2xl font-bold">{stats?.active_agents}</p></CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>User Signups (24h)</CardTitle></CardHeader>
                <CardContent><p className="text-2xl font-bold">{stats?.new_user_signups_24h}</p></CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Total Leads</CardTitle></CardHeader>
                <CardContent><p className="text-2xl font-bold">{stats?.total_leads}</p></CardContent>
              </Card>
            </div>
          )}

          <div className="mt-8">
            <Card>
              <CardHeader><CardTitle>Platform Overview</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="value" fill="#8884d8" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    </div>
  );
}

export default withAuth(AdminDashboard);
