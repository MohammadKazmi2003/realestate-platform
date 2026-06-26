// src/app/components/CrmKanbanBoard.tsx
'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, DragEndEvent, DragStartEvent, DragOverlay } from '@dnd-kit/core';
import { SortableContext, useSortable, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { createPortal } from 'react-dom';
import { supabase } from '@/lib/supabaseClient';
import { Loader2, GripVertical, ChevronDown } from 'lucide-react';
import { logLeadStatusChange } from '@/lib/actions';
import { LeadDetailModal } from './LeadDetailModal';

const PAGE_SIZE = 30;
const POLL_INTERVAL_MS = 30_000;

type Lead = {
  id: string;
  name: string;
  property_title: string;
  status: string;
  created_at: string;
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

type ColumnState = {
  leads: Lead[];
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
};

const LeadCard = ({ lead, isOverlay = false, onClick }: { lead: Lead; isOverlay?: boolean; onClick: () => void }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: lead.id,
    data: { type: 'Lead', lead },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  const overlayStyle = {
    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
    cursor: 'grabbing',
  };

  return (
    <div
      ref={setNodeRef}
      style={isOverlay ? overlayStyle : style}
      {...attributes}
      className="p-4 mb-3 rounded-2xl shadow-neumorphic-outset bg-bg-color touch-none"
    >
      <div className="flex items-start justify-between">
        <div onClick={onClick} className="cursor-pointer flex-1 pr-2">
          <p className="font-bold text-text-color-dark">{lead.name}</p>
          <p className="text-sm text-text-color-light">{lead.property_title}</p>
        </div>
        <button
          {...listeners}
          className="cursor-grab p-2 text-text-color-light hover:text-text-color-dark active:cursor-grabbing"
        >
          <GripVertical size={16} />
        </button>
      </div>
    </div>
  );
};

const KanbanColumn = ({
  column,
  state,
  onCardClick,
  onLoadMore,
}: {
  column: Column;
  state: ColumnState;
  onCardClick: (lead: Lead) => void;
  onLoadMore: () => void;
}) => {
  const { setNodeRef } = useSortable({ id: column.id, data: { type: 'Column' } });

  return (
    <div className="bg-bg-color shadow-neumorphic-inset p-4 rounded-3xl w-full md:w-1/4 flex flex-col">
      <h2 className="text-lg font-semibold mb-4 text-center text-text-color-dark">
        {column.title}
        <span className="ml-2 text-sm font-normal text-text-color-light">
          ({state.leads.length}{state.hasMore ? '+' : ''})
        </span>
      </h2>
      <div ref={setNodeRef} className="flex-1 overflow-y-auto min-h-[200px] max-h-[70vh] p-1">
        <SortableContext items={state.leads.map(l => l.id)} strategy={rectSortingStrategy}>
          {state.leads.map(lead => (
            <LeadCard key={lead.id} lead={lead} onClick={() => onCardClick(lead)} />
          ))}
        </SortableContext>
        {state.loading && (
          <div className="flex justify-center py-4">
            <Loader2 className="animate-spin text-text-color-light" />
          </div>
        )}
        {!state.loading && state.hasMore && state.leads.length > 0 && (
          <button
            onClick={onLoadMore}
            className="w-full py-2 mt-2 text-sm text-text-color-light hover:text-cta-color flex items-center justify-center gap-1"
          >
            <ChevronDown size={14} /> Load more
          </button>
        )}
        {!state.loading && state.leads.length === 0 && (
          <p className="text-text-color-light text-center py-8 text-sm">No leads</p>
        )}
      </div>
    </div>
  );
};

type LeadRow = Record<string, unknown>;

async function fetchAgentLeads(
  cursor: string | null,
  limit: number,
  status: string | null
): Promise<{ leads: Lead[]; hasMore: boolean }> {
  const { data, error } = await supabase.rpc('get_agent_leads', {
    p_cursor: cursor,
    p_limit: limit,
    p_status: status,
  });

  if (error) {
    console.error('Error fetching leads:', error);
    return { leads: [], hasMore: false };
  }

  const result = data as { leads: LeadRow[]; has_more: boolean };
  return {
    leads: (result.leads || []).map((l: LeadRow) => ({
      id: String(l.id),
      name: String(l.name),
      property_title: String(l.property_title),
      status: String(l.status),
      created_at: String(l.created_at),
    })),
    hasMore: result.has_more,
  };
}

function distributeByStatus(leads: Lead[]): Record<string, Lead[]> {
  const byCol: Record<string, Lead[]> = {};
  columns.forEach(c => { byCol[c.id] = []; });
  leads.forEach(l => {
    if (byCol[l.status]) byCol[l.status].push(l);
  });
  return byCol;
}

function buildColumnState(byCol: Record<string, Lead[]>, hasMore: boolean): Record<string, ColumnState> {
  const state: Record<string, ColumnState> = {};
  columns.forEach(c => {
    const colLeads = byCol[c.id] || [];
    state[c.id] = {
      leads: colLeads,
      cursor: colLeads.length > 0 ? colLeads[colLeads.length - 1].created_at : null,
      hasMore,
      loading: false,
    };
  });
  return state;
}

export const CrmKanbanBoard = ({ refreshKey = 0 }: { refreshKey?: number }) => {
  const [columnsState, setColumnsState] = useState<Record<string, ColumnState>>({});
  const [initialLoading, setInitialLoading] = useState(true);
  const [activeLead, setActiveLead] = useState<Lead | null>(null);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const initialLoadDone = useRef(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isTabVisible = useRef(true);
  const columnsStateRef = useRef(columnsState);
  columnsStateRef.current = columnsState;
  const loadingMoreRef = useRef<Set<string>>(new Set());

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  // Shared re-fetch function used by all refresh strategies
  const refreshLeads = useCallback(async () => {
    const { leads, hasMore } = await fetchAgentLeads(null, PAGE_SIZE, null);
    const byCol = distributeByStatus(leads);
    setColumnsState(prev => {
      const next = buildColumnState(byCol, hasMore);
      // Preserve loading states for columns that are loading more pages
      columns.forEach(c => {
        if (prev[c.id]?.loading) next[c.id].loading = true;
      });
      return next;
    });
  }, []);

  // --- Initial load ---
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;

    (async () => {
      setInitialLoading(true);
      const { leads, hasMore } = await fetchAgentLeads(null, PAGE_SIZE, null);
      const byCol = distributeByStatus(leads);
      setColumnsState(buildColumnState(byCol, hasMore));
      setInitialLoading(false);
    })();
  }, []);

  // --- Background polling ---
  // Polls every POLL_INTERVAL_MS while the tab is visible.
  // Pauses when the tab is hidden. Resumes when the user returns.
  useEffect(() => {
    function startPolling() {
      if (pollingRef.current) return;
      pollingRef.current = setInterval(() => {
        if (isTabVisible.current) {
          refreshLeads();
        }
      }, POLL_INTERVAL_MS);
    }

    function stopPolling() {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    }

    startPolling();
    return stopPolling;
  }, [refreshLeads]);

  // --- Tab visibility ---
  // Refreshes immediately when user returns to the tab, then resumes polling.
  useEffect(() => {
    const handleVisibility = () => {
      isTabVisible.current = !document.hidden;
      if (!document.hidden) {
        refreshLeads();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [refreshLeads]);

  // --- Triggered refresh from parent (e.g., AddLeadModal) ---
  useEffect(() => {
    if (!initialLoadDone.current) return;
    refreshLeads();
  }, [refreshKey, refreshLeads]);

  // --- Load more leads for a specific column ---
  const loadMore = useCallback(async (status: string) => {
    // Guard via ref to prevent duplicate concurrent fetches for the same column
    if (loadingMoreRef.current.has(status)) return;
    loadingMoreRef.current.add(status);

    try {
      const current = columnsStateRef.current[status];
      if (!current || current.loading || !current.hasMore) return;

      setColumnsState(prev => ({
        ...prev,
        [status]: { ...prev[status], loading: true },
      }));

      const { leads, hasMore } = await fetchAgentLeads(current.cursor, PAGE_SIZE, status);

      setColumnsState(prev => {
        const col = prev[status];
        if (!col) return prev;
        return {
          ...prev,
          [status]: {
            leads: [...col.leads, ...leads],
            cursor: leads.length > 0 ? leads[leads.length - 1].created_at : col.cursor,
            hasMore,
            loading: false,
          },
        };
      });
    } finally {
      loadingMoreRef.current.delete(status);
    }
  }, []);

  // --- Drag-and-drop ---
  const handleDragStart = (event: DragStartEvent) => {
    const allLeads = Object.values(columnsState).flatMap(c => c.leads);
    const lead = allLeads.find(l => l.id === event.active.id);
    if (lead) setActiveLead(lead);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveLead(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeId = active.id as string;
    const allLeads = Object.values(columnsState).flatMap(c => c.leads);
    const lead = allLeads.find(l => l.id === activeId);
    if (!lead) return;

    const originalStatus = lead.status;
    const targetColumn = columns.find(c =>
      c.id === over.id || allLeads.find(l => l.id === over.id)?.status === c.id
    )?.id;
    if (!targetColumn || targetColumn === originalStatus) return;

    // Optimistic update
    setColumnsState(prev => {
      const next = { ...prev };
      if (next[originalStatus]) {
        next[originalStatus] = {
          ...next[originalStatus],
          leads: next[originalStatus].leads.filter(l => l.id !== activeId),
        };
      }
      if (next[targetColumn]) {
        next[targetColumn] = {
          ...next[targetColumn],
          leads: [{ ...lead, status: targetColumn }, ...next[targetColumn].leads],
        };
      }
      return next;
    });

    const { error } = await supabase
      .from('leads')
      .update({ status: targetColumn })
      .eq('id', activeId);

    if (error) {
      console.error('Error updating lead status:', error);
      await refreshLeads();
    } else {
      await logLeadStatusChange(activeId, originalStatus, targetColumn);
    }
  };

  if (initialLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Loader2 className="animate-spin text-4xl text-text-color-light" />
      </div>
    );
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveLead(null)}
      >
        <div className="flex flex-col md:flex-row gap-6 h-full">
          {columns.map(column => (
            <KanbanColumn
              key={column.id}
              column={column}
              state={
                columnsState[column.id] || {
                  leads: [],
                  cursor: null,
                  hasMore: false,
                  loading: false,
                }
              }
              onCardClick={setSelectedLead}
              onLoadMore={() => loadMore(column.id)}
            />
          ))}
        </div>

        {createPortal(
          <DragOverlay>
            {activeLead ? <LeadCard lead={activeLead} isOverlay onClick={() => {}} /> : null}
          </DragOverlay>,
          document.body
        )}
      </DndContext>

      <LeadDetailModal lead={selectedLead} onClose={() => setSelectedLead(null)} />
    </>
  );
};
