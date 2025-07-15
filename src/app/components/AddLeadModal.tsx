// src/app/components/AddLeadModal.tsx
'use client';

import React, { useState, useEffect, FormEvent } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { Loader2, X } from 'lucide-react';
import { createLead } from '@/lib/actions';

type Property = {
  id: string;
  title: string;
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onLeadCreated: () => void; // Callback to refresh the Kanban board
};

export const AddLeadModal = ({ isOpen, onClose, onLeadCreated }: Props) => {
  const [properties, setProperties] = useState<Property[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    message: '',
    property_id: '',
  });

  useEffect(() => {
    // Fetch properties to populate the dropdown when the modal is opened
    if (isOpen) {
      const fetchProperties = async () => {
        const { data, error } = await supabase
          .from('properties')
          .select('id, title');
        if (error) {
          console.error('Error fetching properties:', error);
        } else {
          setProperties(data || []);
        }
      };
      fetchProperties();
    }
  }, [isOpen]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    const result = await createLead(formData);

    if (result.success) {
      onLeadCreated(); // Trigger refresh on the parent component
      onClose(); // Close the modal
    } else {
      setError(result.message);
    }
    setIsSubmitting(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-bg-color p-8 rounded-3xl shadow-neumorphic-outset w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-text-color-dark">Create New Lead</h2>
          <button onClick={onClose} className="neumorphic-button !p-2 !rounded-full">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input type="text" name="name" placeholder="Lead Name" value={formData.name} onChange={handleChange} className="neumorphic-input" required />
          <input type="email" name="email" placeholder="Email Address" value={formData.email} onChange={handleChange} className="neumorphic-input" />
          <input type="tel" name="phone" placeholder="Phone Number" value={formData.phone} onChange={handleChange} className="neumorphic-input" />
          <select name="property_id" value={formData.property_id} onChange={handleChange} className="neumorphic-input" required>
            <option value="">Select a Property</option>
            {properties.map(prop => <option key={prop.id} value={prop.id}>{prop.title}</option>)}
          </select>
          <textarea name="message" placeholder="Initial Message or Note..." value={formData.message} onChange={handleChange} rows={4} className="neumorphic-input"></textarea>
          
          {error && <p className="text-sm text-danger-color">{error}</p>}

          <div className="flex justify-end gap-4 mt-6">
            <button type="button" onClick={onClose} className="neumorphic-button">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="neumorphic-button bg-cta-gradient">
              {isSubmitting ? <Loader2 className="animate-spin" /> : 'Create Lead'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
