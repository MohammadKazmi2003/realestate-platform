// src/app/components/AgentCalendar.tsx
'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Calendar, dateFnsLocalizer, Event as BigCalendarEvent, Views, ToolbarProps } from 'react-big-calendar';
import format from 'date-fns/format';
import parse from 'date-fns/parse';
import startOfWeek from 'date-fns/startOfWeek';
import endOfWeek from 'date-fns/endOfWeek'; // Import endOfWeek
import getDay from 'date-fns/getDay';
import enUS from 'date-fns/locale/en-US';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/context/AuthContext';
import { Loader2, Plus, ChevronLeft, ChevronRight } from 'lucide-react';

const locales = {
  'en-US': enUS,
};

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek,
  getDay,
  locales,
});

type AppointmentEvent = BigCalendarEvent & {
  id: number;
  description: string;
  lead_name: string;
};

type Lead = {
  id: string;
  name: string;
};

// *** UPDATED: Custom Toolbar with smarter labels ***
const CustomToolbar = (toolbar: ToolbarProps) => {
  const goToBack = () => toolbar.onNavigate('PREV');
  const goToNext = () => toolbar.onNavigate('NEXT');
  const goToCurrent = () => toolbar.onNavigate('TODAY');

  const label = () => {
    const date = toolbar.date;
    const view = toolbar.view;

    if (view === 'month') {
      return format(date, 'MMMM yyyy');
    }
    if (view === 'week') {
      const start = startOfWeek(date, { locale: enUS });
      const end = endOfWeek(date, { locale: enUS });
      return `${format(start, 'MMM d')} – ${format(end, 'd, yyyy')}`;
    }
    if (view === 'day') {
      return format(date, 'PPPP'); // e.g., "Saturday, July 12th, 2025"
    }
    if (view === 'agenda') {
        const start = startOfWeek(date, { locale: enUS });
        const end = endOfWeek(date, { locale: enUS });
        return `Agenda: ${format(start, 'MMM d')} – ${format(end, 'd, yyyy')}`;
    }
    return format(date, 'MMMM yyyy');
  };

  return (
    <div className="flex items-center justify-between mb-4 p-2 rounded-2xl shadow-neumorphic-outset">
      <div className="flex items-center gap-2">
        <button type="button" onClick={goToBack} className="neumorphic-button !p-2">
          <ChevronLeft />
        </button>
        <button type="button" onClick={goToCurrent} className="neumorphic-button">
          Today
        </button>
        <button type="button" onClick={goToNext} className="neumorphic-button !p-2">
          <ChevronRight />
        </button>
      </div>
      
      <div className="text-lg md:text-xl font-semibold text-text-color-dark text-center">
        {label()}
      </div>

      <div className="flex items-center gap-2">
        {(toolbar.views as string[]).map((viewName) => (
          <button
            key={viewName}
            type="button"
            onClick={() => toolbar.onView(viewName as any)}
            className={`neumorphic-button capitalize ${toolbar.view === viewName ? 'shadow-neumorphic-inset' : ''}`}
          >
            {viewName}
          </button>
        ))}
      </div>
    </div>
  );
};


export const AgentCalendar = () => {
  const { user } = useAuth();
  const [events, setEvents] = useState<AppointmentEvent[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<AppointmentEvent | null>(null);

  const [date, setDate] = useState(new Date());
  const [view, setView] = useState<any>(Views.MONTH);

  const [newEvent, setNewEvent] = useState({
    title: '',
    lead_id: '',
    appointment_date: '',
    description: '',
  });

  const fetchAppointments = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('get_agent_appointments');
    if (error) {
      console.error('Error fetching appointments:', error);
    } else {
      const formattedEvents = (data || []).map(d => ({
        id: d.id,
        title: `${d.title} (${d.lead_name})`,
        start: new Date(d.start_time),
        end: new Date(d.end_time),
        description: d.description,
        lead_name: d.lead_name,
      }));
      setEvents(formattedEvents);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const fetchLeads = async () => {
      const { data, error } = await supabase.from('leads').select('id, name');
      if (error) console.error('Error fetching leads:', error);
      else setLeads(data || []);
    };

    fetchAppointments();
    fetchLeads();
  }, [fetchAppointments]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setNewEvent({ ...newEvent, [e.target.name]: e.target.value });
  };

  const handleAddAppointment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    const { error } = await supabase.from('appointments').insert({
      agent_id: user.id,
      lead_id: newEvent.lead_id,
      title: newEvent.title,
      description: newEvent.description,
      appointment_date: newEvent.appointment_date,
    });

    if (error) {
      console.error('Error adding appointment:', error);
      alert('Failed to add appointment.');
    } else {
      setIsAddModalOpen(false);
      setNewEvent({ title: '', lead_id: '', appointment_date: '', description: '' });
      fetchAppointments();
    }
  };

  const handleSelectEvent = (event: AppointmentEvent) => {
    setSelectedEvent(event);
  };
  
  const { components } = useMemo(
    () => ({
      components: {
        toolbar: CustomToolbar,
      },
    }),
    []
  );

  if (loading) {
    return <div className="flex justify-center items-center h-full"><Loader2 className="animate-spin text-4xl text-text-color-light" /></div>;
  }

  return (
    <div className="h-full shadow-neumorphic-outset rounded-3xl p-4 bg-bg-color">
      <div className="flex justify-end mb-4">
        <button onClick={() => setIsAddModalOpen(true)} className="neumorphic-button bg-cta-gradient flex items-center gap-2">
          <Plus size={16} /> Add Appointment
        </button>
      </div>
      <Calendar
        localizer={localizer}
        events={events}
        onSelectEvent={handleSelectEvent}
        startAccessor="start"
        endAccessor="end"
        style={{ height: 'calc(100% - 76px)' }}
        className="text-text-color-dark"
        date={date}
        view={view}
        onNavigate={setDate}
        onView={setView}
        components={components}
      />

      {isAddModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-bg-color p-8 rounded-3xl shadow-neumorphic-outset w-full max-w-md">
            <h2 className="text-2xl font-bold mb-6 text-text-color-dark">New Appointment</h2>
            <form onSubmit={handleAddAppointment} className="space-y-4">
              <input type="text" name="title" placeholder="Appointment Title" value={newEvent.title} onChange={handleInputChange} className="neumorphic-input" required />
              <select name="lead_id" value={newEvent.lead_id} onChange={handleInputChange} className="neumorphic-input" required>
                <option value="">Select a Lead</option>
                {leads.map(lead => <option key={lead.id} value={lead.id}>{lead.name}</option>)}
              </select>
              <input type="datetime-local" name="appointment_date" value={newEvent.appointment_date} onChange={handleInputChange} className="neumorphic-input" required />
              <textarea name="description" placeholder="Description..." value={newEvent.description} onChange={handleInputChange} className="neumorphic-input" rows={3}></textarea>
              <div className="flex justify-end gap-4 mt-6">
                <button type="button" onClick={() => setIsAddModalOpen(false)} className="neumorphic-button">Cancel</button>
                <button type="submit" className="neumorphic-button bg-cta-gradient">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {selectedEvent && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setSelectedEvent(null)}>
          <div className="bg-bg-color p-8 rounded-3xl shadow-neumorphic-outset w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-2xl font-bold mb-4 text-text-color-dark">{selectedEvent.title}</h2>
            <div className="space-y-4 text-text-color-dark">
              <p><span className="font-semibold">Lead:</span> {selectedEvent.lead_name}</p>
              <p><span className="font-semibold">Time:</span> {format(selectedEvent.start as Date, 'PPP p')}</p>
              <div>
                <p className="font-semibold">Description:</p>
                <p className="text-text-color-light">{selectedEvent.description || 'No description provided.'}</p>
              </div>
            </div>
            <div className="flex justify-end mt-6">
              <button type="button" onClick={() => setSelectedEvent(null)} className="neumorphic-button">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
