// src/app/agent/leads/page.tsx
'use client';

import { withAuth } from '@/utils/withAuth';
import Header from '@/app/components/Header';
import { CrmKanbanBoard } from '@/app/components/CrmKanbanBoard';

function AgentLeadsPage() {
  return (
    <div className="bg-bg-color min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 p-6 max-w-full mx-auto w-full">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">Lead Management</h1>
        </div>
        <CrmKanbanBoard />
      </main>
    </div>
  );
}

export default withAuth(AgentLeadsPage);
