// src/app/propertyowner/page.tsx
'use client';

import { withAuth } from '@/utils/withAuth';
import Header from '@/app/components/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

function PropertyOwnerDashboard() {
  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <main className="p-6 max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">Property Owner Dashboard</h1>
          <Link href="/add-property">
            <Button>Add New Property</Button>
          </Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>My Properties</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">5</p>
              <Link href="/my-listings">
                <Button variant="link" className="p-0">View My Listings</Button>
              </Link>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Total Leads</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">123</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>WhatsApp Interactions</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">45</p>
            </CardContent>
          </Card>
        </div>

        <div className="mt-8">
          <h2 className="text-2xl font-bold mb-4">My Listings</h2>
          <div className="bg-white shadow-lg rounded-lg p-4">
            <p>A list of my properties will be displayed here.</p>
          </div>
        </div>
      </main>
    </div>
  );
}

export default withAuth(PropertyOwnerDashboard);
