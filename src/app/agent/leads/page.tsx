// src/app/agent/leads/page.tsx
'use client';

import { withAuth } from '@/utils/withAuth';
import Header from '@/app/components/Header';
import { CrmKanbanBoard } from '@/app/components/CrmKanbanBoard';
import { useState } from 'react';
import { AddLeadModal } from '@/app/components/AddLeadModal';
import { Plus } from 'lucide-react';

function AgentLeadsPage() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0); // State to trigger refresh

  const handleLeadCreated = () => {
    // Increment key to force CrmKanbanBoard to re-fetch data
    setRefreshKey(prevKey => prevKey + 1);
  };

  return (
    <>
      <div className="bg-bg-color min-h-screen flex flex-col">
        <Header />
        <main className="flex-1 p-6 max-w-full mx-auto w-full">
          <div className="flex justify-between items-center mb-8">
            <h1 className="text-3xl font-bold">Lead Management</h1>
            <button onClick={() => setIsModalOpen(true)} className="neumorphic-button bg-cta-gradient flex items-center gap-2">
              <Plus size={16} /> Add Lead
            </button>
          </div>
          {/* Pass the refreshKey as a key to the component */}
          <CrmKanbanBoard key={refreshKey} />
        </main>
      </div>
      <AddLeadModal 
        isOpen={isModalOpen} 
        onClose={() => setIsModalOpen(false)}
        onLeadCreated={handleLeadCreated}
      />
    </>
  );
}

export default withAuth(AgentLeadsPage);
