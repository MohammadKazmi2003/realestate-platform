// src/app/admin/page.tsx
'use client';

import { withAuth } from '@/utils/withAuth';
import Header from '@/app/components/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sun, Moon } from 'lucide-react';
import { useState } from 'react';

function AdminDashboard() {
  const [darkMode, setDarkMode] = useState(false);

  const toggleDarkMode = () => {
    setDarkMode(!darkMode);
    // In a real app, you would also save this preference and apply a class to the body
  };

  return (
    <div className={darkMode ? 'dark' : ''}>
      <div className="bg-bg-color min-h-screen text-text-color-dark dark:bg-gray-900 dark:text-gray-100">
        <Header />
        <main className="p-6 max-w-7xl mx-auto">
          <div className="flex justify-between items-center mb-8">
            <h1 className="text-3xl font-bold">Admin Dashboard</h1>
            <button onClick={toggleDarkMode} className="p-2 rounded-full neumorphic-button">
              {darkMode ? <Sun /> : <Moon />}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Total Listings</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">1,234</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Active Agents</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">56</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>User Signups (24h)</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">12</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Total Leads</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">4,567</p>
              </CardContent>
            </Card>
          </div>

          <div className="mt-8">
            <h2 className="text-2xl font-bold mb-4">Usage Logs</h2>
            <div className="bg-white dark:bg-gray-800 shadow-lg rounded-lg p-4">
              <p>Usage logs will be displayed here.</p>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export default withAuth(AdminDashboard);
