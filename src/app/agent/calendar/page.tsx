// src/app/agent/calendar/page.tsx
'use client';

import { withAuth } from '@/utils/withAuth';
import Header from '@/app/components/Header';
import { AgentCalendar } from '@/app/components/AgentCalendar';

function AgentCalendarPage() {
  return (
    <div className="bg-bg-color min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 p-6 max-w-full mx-auto w-full">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">My Calendar</h1>
        </div>
        <div className="h-[75vh]">
          <AgentCalendar />
        </div>
      </main>
    </div>
  );
}

export default withAuth(AgentCalendarPage);

