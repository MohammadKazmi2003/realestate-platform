// src/app/agent/leads/page.tsx
'use client';

import { withAuth } from '@/utils/withAuth';
import Header from '@/app/components/Header';
import { CrmKanbanBoard, ArchivedLeadsList } from '@/app/components/CrmKanbanBoard';
import { useState } from 'react';
import { AddLeadModal } from '@/app/components/AddLeadModal';
import { Plus } from 'lucide-react';

function AgentLeadsPage() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0); // State to trigger refresh
  const [view, setView] = useState<'board' | 'archived'>('board');

  const handleLeadCreated = () => {
    // Increment key to force CrmKanbanBoard to re-fetch data
    setRefreshKey(prevKey => prevKey + 1);
  };

  return (
    <>
      <div className="bg-bg-color min-h-screen flex flex-col">
        <Header />
        <main className="flex-1 p-6 max-w-full mx-auto w-full">
          <div className="flex justify-between items-center mb-6">
            <h1 className="text-3xl font-bold">Lead Management</h1>
            <button onClick={() => setIsModalOpen(true)} className="neumorphic-button bg-cta-gradient flex items-center gap-2">
              <Plus size={16} /> Add Lead
            </button>
          </div>
          <div className="flex gap-1 p-1 rounded-2xl shadow-neumorphic-inset w-full sm:w-auto sm:min-w-[320px] mb-6">
            {(['board', 'archived'] as const).map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`flex-1 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
                  view === v
                    ? 'shadow-neumorphic-outset bg-bg-color text-text-color-dark'
                    : 'text-text-color-light hover:text-text-color-dark'
                }`}
              >
                {v === 'board' ? 'Board' : 'Archived'}
              </button>
            ))}
          </div>
          {/* Pass the refreshKey to trigger re-fetch without remounting */}
          {view === 'board' ? <CrmKanbanBoard refreshKey={refreshKey} /> : <ArchivedLeadsList />}
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
