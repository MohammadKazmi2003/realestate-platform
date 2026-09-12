// src/app/components/CrmKanbanBoard.tsx
'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo, useDeferredValue } from 'react';
import Fuse from 'fuse.js';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, DragEndEvent, DragStartEvent, DragOverlay } from '@dnd-kit/core';
import { SortableContext, useSortable, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { createPortal } from 'react-dom';
import { supabase } from '@/lib/supabaseClient';
import { Loader2, GripVertical, ChevronDown, Search, X } from 'lucide-react';
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
  email?: string | null;
  phone?: string | null;
  message?: string | null;
};

/** Digits-only variant so "98765" matches "+91 98765 43210". */
function digitsOnly(v: string | null | undefined): string {
  return (v || '').replace(/\D/g, '');
}

/** Client-side full-text match across name + contact + message + property. */
export function leadMatchesQuery(lead: Lead, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  const haystacks = [
    lead.name,
    lead.email,
    lead.phone,
    lead.message,
    lead.property_title,
  ].map((v) => (v || '').toLowerCase());
  if (haystacks.some((h) => h.includes(q))) return true;
  const qDigits = digitsOnly(q);
  if (qDigits.length >= 3 && digitsOnly(lead.phone).includes(qDigits)) return true;
  return false;
}

function buildLeadFuse(leads: Lead[]): Fuse<Lead> {
  return new Fuse(leads, {
    keys: [
      { name: 'name', weight: 0.35 },
      { name: 'email', weight: 0.2 },
      { name: 'phone', weight: 0.2 },
      { name: 'message', weight: 0.1 },
      { name: 'property_title', weight: 0.15 },
    ],
    threshold: 0.35,
    ignoreLocation: true,
    getFn: (obj, path) => {
      const key = Array.isArray(path) ? path.join('.') : String(path);
      const raw = (obj as any)?.[key];
      if (raw == null) return '';
      const str = String(raw);
      // Index the digits variant alongside so partial phone numbers match.
      return key === 'phone' ? `${str} ${digitsOnly(str)}` : str;
    },
  });
}

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
  totalCount,
  searchActive,
  searchTerm,
  onCardClick,
  onLoadMore,
}: {
  column: Column;
  state: ColumnState;
  totalCount: number;
  searchActive: boolean;
  searchTerm: string;
  onCardClick: (lead: Lead) => void;
  onLoadMore: () => void;
}) => {
  const { setNodeRef } = useSortable({ id: column.id, data: { type: 'Column' } });

  return (
    <div className="bg-bg-color shadow-neumorphic-inset p-4 rounded-3xl w-full md:w-1/4 flex flex-col">
      <h2 className="text-lg font-semibold mb-4 text-center text-text-color-dark">
        {column.title}
        <span className="ml-2 text-sm font-normal text-text-color-light">
          ({searchActive ? `${state.leads.length}/${totalCount}` : `${state.leads.length}`}{!searchActive && state.hasMore ? '+' : ''})
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
          <p className="text-text-color-light text-center py-8 text-sm">
            {searchActive ? <>No matches for &ldquo;{searchTerm}&rdquo;</> : 'No leads'}
          </p>
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
  const strOrEmpty = (v: unknown): string => (v == null ? '' : String(v));
  return {
    leads: (result.leads || []).map((l: LeadRow) => ({
      id: String(l.id),
      name: String(l.name),
      property_title: String(l.property_title),
      status: String(l.status),
      created_at: String(l.created_at),
      email: strOrEmpty(l.email),
      phone: strOrEmpty(l.phone),
      message: strOrEmpty(l.message),
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
  // Client-side full-text search over already-loaded leads: zero server load.
  // Deferred so keystrokes never jank the dnd-kit board.
  const [searchQuery, setSearchQuery] = useState('');
  const deferredQuery = useDeferredValue(searchQuery);
  const searchActive = deferredQuery.trim().length > 0;
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

  // Filtered view: exact substring/digits matcher UNION fuzzy Fuse hits,
  // so deterministic matches always work and typos still resolve.
  const visibleColumnsState = useMemo(() => {
    if (!searchActive) return columnsState;
    const next: Record<string, ColumnState> = {};
    for (const [colId, col] of Object.entries(columnsState)) {
      if (col.leads.length === 0) {
        next[colId] = col;
        continue;
      }
      const fuseHits = new Set(buildLeadFuse(col.leads).search(deferredQuery).map(r => r.item.id));
      next[colId] = {
        ...col,
        leads: col.leads.filter(l => fuseHits.has(l.id) || leadMatchesQuery(l, deferredQuery)),
      };
    }
    return next;
  }, [columnsState, deferredQuery, searchActive]);

  const totalLoaded = useMemo(
    () => Object.values(columnsState).reduce((n, c) => n + c.leads.length, 0),
    [columnsState]
  );
  const totalVisible = useMemo(
    () => Object.values(visibleColumnsState).reduce((n, c) => n + c.leads.length, 0),
    [visibleColumnsState]
  );
  const hasMoreAnywhere = useMemo(
    () => Object.values(columnsState).some(c => c.hasMore),
    [columnsState]
  );

  const handleArchivedLead = useCallback((leadId: string) => {
    setColumnsState(prev => {
      const next = { ...prev };
      for (const [colId, col] of Object.entries(next)) {
        if (col.leads.some(l => l.id === leadId)) {
          next[colId] = { ...col, leads: col.leads.filter(l => l.id !== leadId) };
        }
      }
      return next;
    });
    setSelectedLead(null);
  }, []);

  if (initialLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Loader2 className="animate-spin text-4xl text-text-color-light" />
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-6">
        <div className="relative flex-1 sm:max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-color-light pointer-events-none" size={18} />
          <input
            type="text"
            placeholder="Search leads by name, contact, message, property..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full !pl-10 !pr-10 neumorphic-input"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-text-color-light hover:text-text-color-dark"
            >
              <X size={16} />
            </button>
          )}
        </div>
        {searchActive && (
          <p className="text-sm text-text-color-light whitespace-nowrap">
            Showing {totalVisible} of {totalLoaded}
            {hasMoreAnywhere ? ' loaded leads' : ' leads'}
          </p>
        )}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveLead(null)}
      >
        <div className="flex flex-col md:flex-row gap-6 h-full">
          {columns.map(column => {
            const full = columnsState[column.id];
            return (
              <KanbanColumn
                key={column.id}
                column={column}
                state={
                  visibleColumnsState[column.id] || {
                    leads: [],
                    cursor: null,
                    hasMore: false,
                    loading: false,
                  }
                }
                totalCount={full?.leads.length || 0}
                searchActive={searchActive}
                searchTerm={deferredQuery.trim()}
                onCardClick={setSelectedLead}
                onLoadMore={() => loadMore(column.id)}
              />
            );
          })}
        </div>

        {createPortal(
          <DragOverlay>
            {activeLead ? <LeadCard lead={activeLead} isOverlay onClick={() => {}} /> : null}
          </DragOverlay>,
          document.body
        )}
      </DndContext>

      <LeadDetailModal lead={selectedLead} onClose={() => setSelectedLead(null)} onArchived={handleArchivedLead} />
    </>
  );
};

/** Archived leads: simple list with restore. Fetches p_status='archived'
 * (excluded from the board path by the RPC), paged the same keyset way. */
export const ArchivedLeadsList = () => {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);

  const load = useCallback(async (cur: string | null, reset: boolean) => {
    if (reset) setLoading(true);
    else setLoadingMore(true);
    try {
      const { leads: rows, hasMore: more } = await fetchAgentLeads(cur, PAGE_SIZE, 'archived');
      setLeads(prev => (reset ? rows : [...prev, ...rows]));
      setCursor(rows.length > 0 ? rows[rows.length - 1].created_at : cur);
      setHasMore(more);
    } finally {
      if (reset) setLoading(false);
      else setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    load(null, true);
  }, [load]);

  const handleRestored = useCallback((leadId: string) => {
    setLeads(prev => prev.filter(l => l.id !== leadId));
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Loader2 className="animate-spin text-4xl text-text-color-light" />
      </div>
    );
  }

  if (leads.length === 0) {
    return <p className="text-text-color-light text-center py-12">No archived leads.</p>;
  }

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {leads.map(lead => (
          <button
            key={lead.id}
            onClick={() => setSelectedLead(lead)}
            className="p-4 rounded-2xl shadow-neumorphic-outset bg-bg-color text-left hover:shadow-neumorphic-inset transition-shadow"
          >
            <p className="font-bold text-text-color-dark">{lead.name}</p>
            <p className="text-sm text-text-color-light">{lead.property_title}</p>
            <p className="text-xs text-text-color-light mt-1">
              Archived — click to view or restore
            </p>
          </button>
        ))}
      </div>
      {hasMore && (
        <div className="text-center mt-6">
          <button
            onClick={() => load(cursor, false)}
            disabled={loadingMore}
            className="neumorphic-button"
          >
            {loadingMore ? <Loader2 className="animate-spin" size={16} /> : 'Load more'}
          </button>
        </div>
      )}
      <LeadDetailModal lead={selectedLead} onClose={() => setSelectedLead(null)} archived onRestored={handleRestored} />
    </>
  );
};
