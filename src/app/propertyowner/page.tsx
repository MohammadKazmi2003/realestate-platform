// src/app/propertyowner/page.tsx
'use client';

import { withAuth } from '@/utils/withAuth';
import Header from '@/app/components/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { Loader2, Eye } from 'lucide-react'; // Import Eye icon
import { formatDistanceToNow } from 'date-fns';

// NEW: Updated OwnerStats type
type OwnerStats = {
  total_my_listings: number;
  total_leads_on_my_properties: number;
  total_whatsapp_interactions: number;
  total_property_views: number; // New metric
};

// NEW: Type for a single activity log item
type ActivityLog = {
  activity_description: string;
  activity_timestamp: string;
};

function PropertyOwnerDashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState<OwnerStats | null>(null);
  // NEW: State for activity logs
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;

    const fetchDashboardData = async () => {
      setLoading(true);
      
      // Fetch stats and activity logs in parallel for better performance
      const [statsRes, activityRes] = await Promise.all([
        supabase.rpc('get_property_owner_dashboard_stats', { p_user_id: user.id }).single(),
        supabase.rpc('get_user_recent_activity', { p_user_id: user.id })
      ]);

      if (statsRes.error) {
        console.error("Error fetching owner stats:", statsRes.error);
      } else {
        setStats(statsRes.data);
      }

      if (activityRes.error) {
        console.error("Error fetching activity logs:", activityRes.error);
      } else {
        setActivityLogs(activityRes.data || []);
      }

      setLoading(false);
    };
    fetchDashboardData();
  }, [user]);

  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <main className="p-6 max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">My Dashboard</h1>
          <Link href="/add-property">
            <Button>Add New Property</Button>
          </Link>
        </div>

        {loading ? (
          <div className="flex justify-center items-center h-32">
              <Loader2 className="animate-spin text-4xl text-text-color-light" />
          </div>
        ) : (
          // UPDATED: Changed grid to 4 columns to accommodate the new card
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <Card>
              <CardHeader><CardTitle>My Properties</CardTitle></CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{stats?.total_my_listings}</p>
                <Link href="/my-listings">
                  <Button variant="link" className="p-0">View My Listings</Button>
                </Link>
              </CardContent>
            </Card>
            {/* FIX: Updated card structure to match the others for consistency */}
            <Card>
              <CardHeader>
                <CardTitle>Total Views</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{stats?.total_property_views}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Total Leads</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-bold">{stats?.total_leads_on_my_properties}</p></CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>WhatsApp Interactions</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-bold">{stats?.total_whatsapp_interactions}</p></CardContent>
            </Card>
          </div>
        )}

        {/* Recent Activity Section */}


        <div className="mt-8">
          <h2 className="text-2xl font-bold mb-4">Recent Activity</h2>
          <div className="bg-bg-color shadow-neumorphic-outset rounded-3xl p-6 space-y-4">
            {loading ? (
              <div className="flex justify-center items-center h-24">
                <Loader2 className="animate-spin text-2xl text-text-color-light" />
              </div>
            ) : activityLogs.length > 0 ? (
              activityLogs.map((log, index) => (
                <div key={index} className="flex justify-between items-center text-sm pb-2 border-b border-shadow-dark/10">
                  <p className="text-text-color-dark">{log.activity_description}</p>
                  <p className="text-text-color-light flex-shrink-0 ml-4">
                    {formatDistanceToNow(new Date(log.activity_timestamp), { addSuffix: true })}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-text-color-light text-center py-4">No recent activity found.</p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default withAuth(PropertyOwnerDashboard);
