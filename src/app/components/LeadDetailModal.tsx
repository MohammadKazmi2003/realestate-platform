// src/app/components/LeadDetailModal.tsx
'use client';

import React, { useState, useEffect, FormEvent } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/context/AuthContext';
import { Loader2, X, MessageSquare, History } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

type Lead = {
  id: string;
  name: string;
  property_title: string;
  status: string;
};

type Note = {
  id: number;
  note: string;
  created_at: string;
  agent_name: string;
};

type HistoryLog = {
  id: number;
  from_status: string;
  to_status: string;
  changed_at: string;
  agent_name: string;
};

type Props = {
  lead: Lead | null;
  onClose: () => void;
};

export const LeadDetailModal = ({ lead, onClose }: Props) => {
  const { user } = useAuth();
  const [notes, setNotes] = useState<Note[]>([]);
  const [history, setHistory] = useState<HistoryLog[]>([]);
  const [newNote, setNewNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [isSubmittingNote, setIsSubmittingNote] = useState(false);
  const [activeTab, setActiveTab] = useState<'notes' | 'history'>('notes');

  useEffect(() => {
    if (!lead) return;

    const fetchDetails = async () => {
      setLoading(true);
      const [notesRes, historyRes] = await Promise.all([
        supabase.rpc('get_lead_notes', { p_lead_id: lead.id }),
        supabase.rpc('get_lead_status_history', { p_lead_id: lead.id }),
      ]);

      if (notesRes.error) console.error('Error fetching notes:', notesRes.error);
      else setNotes(notesRes.data || []);

      if (historyRes.error) console.error('Error fetching history:', historyRes.error);
      else setHistory(historyRes.data || []);
      
      setLoading(false);
    };

    fetchDetails();
  }, [lead]);

  const handleAddNote = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !lead || !newNote.trim()) return;
    
    setIsSubmittingNote(true);

    // FIX: Removed the problematic embedded select ('profiles(name)')
    const { data, error } = await supabase
      .from('lead_notes')
      .insert({
        lead_id: lead.id,
        agent_id: user.id,
        note: newNote,
      })
      .select('*') // Select only the columns from lead_notes
      .single();

    if (error) {
      console.error('Error adding note:', error);
      alert('Failed to add note.');
    } else if (data) {
      // Manually construct the new note for the UI with the current user's name
      const newNoteEntry: Note = {
        id: data.id,
        note: data.note,
        created_at: data.created_at,
        agent_name: 'You', // Use a default or fetch profile name if available in context
      };
      setNotes([newNoteEntry, ...notes]);
      setNewNote('');
    }
    setIsSubmittingNote(false);
  };

  if (!lead) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-bg-color p-8 rounded-3xl shadow-neumorphic-outset w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-4">
          <div>
            <h2 className="text-2xl font-bold text-text-color-dark">{lead.name}</h2>
            <p className="text-text-color-light">Regarding: {lead.property_title}</p>
          </div>
          <button onClick={onClose} className="neumorphic-button !p-2 !rounded-full">
            <X size={20} />
          </button>
        </div>

        <div className="flex border-b border-shadow-dark/20 mb-4">
          <button onClick={() => setActiveTab('notes')} className={`py-2 px-4 text-sm font-medium ${activeTab === 'notes' ? 'text-cta-color border-b-2 border-cta-color' : 'text-text-color-light'}`}>
            <MessageSquare size={16} className="inline-block mr-2" /> Notes
          </button>
          <button onClick={() => setActiveTab('history')} className={`py-2 px-4 text-sm font-medium ${activeTab === 'history' ? 'text-cta-color border-b-2 border-cta-color' : 'text-text-color-light'}`}>
            <History size={16} className="inline-block mr-2" /> History
          </button>
        </div>

        <div className="flex-1 overflow-y-auto pr-2">
          {loading ? (
            <div className="flex justify-center items-center h-48"><Loader2 className="animate-spin" /></div>
          ) : (
            <>
              {activeTab === 'notes' && (
                <div>
                  <form onSubmit={handleAddNote} className="mb-4">
                    <textarea value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="Add a new note..." rows={3} className="neumorphic-input w-full"></textarea>
                    <button type="submit" disabled={isSubmittingNote} className="neumorphic-button bg-cta-gradient mt-2 float-right">
                      {isSubmittingNote ? <Loader2 className="animate-spin" /> : 'Add Note'}
                    </button>
                  </form>
                  <div className="space-y-4 clear-both pt-4">
                    {notes.length > 0 ? notes.map(n => (
                      <div key={n.id} className="p-3 rounded-xl shadow-neumorphic-inset">
                        <p className="text-text-color-dark">{n.note}</p>
                        <p className="text-xs text-text-color-light text-right mt-2">
                          - {n.agent_name}, {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                        </p>
                      </div>
                    )) : <p className="text-text-color-light text-center py-4">No notes yet.</p>}
                  </div>
                </div>
              )}
              {activeTab === 'history' && (
                <div className="space-y-3">
                  {history.length > 0 ? history.map(h => (
                    <div key={h.id} className="text-sm">
                      <p className="text-text-color-dark">
                        <span className="font-semibold">{h.agent_name}</span> moved from <span className="font-semibold capitalize">{h.from_status?.replace('_', ' ')}</span> to <span className="font-semibold capitalize">{h.to_status?.replace('_', ' ')}</span>
                      </p>
                      <p className="text-xs text-text-color-light">
                        {formatDistanceToNow(new Date(h.changed_at), { addSuffix: true })}
                      </p>
                    </div>
                  )) : <p className="text-text-color-light text-center py-4">No status changes recorded.</p>}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
