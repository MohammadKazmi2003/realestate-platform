// src/app/components/CrmKanbanBoard.tsx
'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, DragEndEvent, DragStartEvent, DragOverlay } from '@dnd-kit/core';
import { SortableContext, useSortable, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { createPortal } from 'react-dom';
import { supabase } from '@/lib/supabaseClient';
import { Loader2, GripVertical } from 'lucide-react';

type Lead = {
  id: string;
  name: string;
  property_title: string;
  status: string;
};

type Column = {
  id: string;
  title: string;
};

const columns: Column[] = [
  { id: 'new', title: 'New' },
  { id: 'contacted', title: 'Contacted' },
  { id: 'site_visit', title: 'Site Visit' },
  { id: 'closed', title: 'Closed' },
];

const LeadCard = ({ lead, isOverlay = false }: { lead: Lead, isOverlay?: boolean }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: lead.id, data: { type: 'Lead', lead } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // If the item is being dragged, make the original item semi-transparent
    opacity: isDragging ? 0.3 : 1,
  };

  const overlayStyle = {
    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
    cursor: 'grabbing',
  };

  return (
    <div ref={setNodeRef} style={isOverlay ? overlayStyle : style} {...attributes} className="p-4 mb-3 rounded-2xl shadow-neumorphic-outset bg-bg-color touch-none">
      <div className="flex items-start justify-between">
        <div>
          <p className="font-bold text-text-color-dark">{lead.name}</p>
          <p className="text-sm text-text-color-light">{lead.property_title}</p>
        </div>
        <button {...listeners} className="cursor-grab p-2 text-text-color-light hover:text-text-color-dark active:cursor-grabbing">
          <GripVertical size={16} />
        </button>
      </div>
    </div>
  );
};

const KanbanColumn = ({ column, leads }: { column: Column; leads: Lead[] }) => {
  const { setNodeRef } = useSortable({ id: column.id, data: { type: 'Column' } });

  return (
    <div className="bg-bg-color shadow-neumorphic-inset p-4 rounded-3xl w-full md:w-1/4 flex flex-col">
      <h2 className="text-lg font-semibold mb-4 text-center text-text-color-dark">{column.title}</h2>
      <div ref={setNodeRef} className="flex-1 overflow-y-auto min-h-[200px] p-1">
        <SortableContext items={leads.map(l => l.id)} strategy={rectSortingStrategy}>
          {leads.map(lead => <LeadCard key={lead.id} lead={lead} />)}
        </SortableContext>
      </div>
    </div>
  );
};

export const CrmKanbanBoard = () => {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  // *** NEW: State to hold the currently dragged lead item ***
  const [activeLead, setActiveLead] = useState<Lead | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, {
    activationConstraint: {
      distance: 8, // Require the mouse to move 8px before a drag starts
    },
  }));

  const leadsByColumn = useMemo(() => {
    return columns.reduce((acc, column) => {
      acc[column.id] = leads.filter(lead => lead.status === column.id);
      return acc;
    }, {} as Record<string, Lead[]>);
  }, [leads]);

  useEffect(() => {
    const fetchLeads = async () => {
      setLoading(true);
      const { data, error } = await supabase.rpc('get_agent_leads');
      if (error) {
        console.error('Error fetching leads:', error);
      } else {
        setLeads(data || []);
      }
      setLoading(false);
    };
    fetchLeads();
  }, []);

  const findColumn = (id: string) => {
    if (columns.some(c => c.id === id)) {
      return id;
    }
    return leads.find((l) => l.id === id)?.status;
  };

  // *** NEW: Function to handle when a drag starts ***
  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const lead = leads.find(l => l.id === active.id);
    if (lead) {
      setActiveLead(lead);
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    // Reset the active lead state
    setActiveLead(null);

    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const activeColumn = findColumn(activeId);
    const overColumn = findColumn(overId);

    if (!activeColumn || !overColumn || activeColumn === overColumn) {
      return;
    }

    // Optimistic UI Update
    setLeads((prev) => prev.map(lead => lead.id === activeId ? { ...lead, status: overColumn } : lead));

    // Update the database
    const { error } = await supabase
      .from('leads')
      .update({ status: overColumn })
      .eq('id', active.id);

    if (error) {
      console.error('Error updating lead status:', error);
      // Revert UI on error
      setLeads(leads);
    }
  };

  if (loading) {
    return <div className="flex justify-center items-center h-full"><Loader2 className="animate-spin text-4xl text-text-color-light" /></div>;
  }

  return (
    <DndContext 
      sensors={sensors} 
      collisionDetection={closestCenter} 
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveLead(null)}
    >
      <div className="flex flex-col md:flex-row gap-6 h-full">
        {columns.map((column) => (
          <KanbanColumn
            key={column.id}
            column={column}
            leads={leadsByColumn[column.id] || []}
          />
        ))}
      </div>

      {/* *** NEW: Drag Overlay Implementation *** */}
      {createPortal(
        <DragOverlay>
          {activeLead ? <LeadCard lead={activeLead} isOverlay /> : null}
        </DragOverlay>,
        document.body
      )}
    </DndContext>
  );
};
