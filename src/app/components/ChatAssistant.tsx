// src/app/components/ChatAssistant.tsx
'use client';

import { useState, useRef, useEffect } from 'react';
import { Send, Loader2, User, Sparkles, X } from 'lucide-react';
import { ChatPropertyCard } from './ChatPropertyCard';

type Message = {
  role: 'user' | 'assistant';
  content: string;
  properties?: any[];
};

// Add this type for session state
type SessionState = {
  [key: string]: any;
};


type ChatAssistantProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function ChatAssistant({ isOpen, onClose }: ChatAssistantProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // ++ Add this new state variable ++
  const [sessionState, setSessionState] = useState<SessionState>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(scrollToBottom, [messages]);

  const handleSend = async () => {
    if (!input.trim()) return;

    const userMessage: Message = { role: 'user', content: input };
    setMessages(prev => [...prev, userMessage]);
    const currentInput = input;
    setInput('');
    setIsLoading(true);

    // Implement a "clear" command on the frontend
    if (currentInput.toLowerCase().trim() === 'clear' || currentInput.toLowerCase().trim() === 'new search') {
      setSessionState({});
      setMessages(prev => [...prev, {role: 'assistant', content: "Starting a new search! What are you looking for?"}]);
      setIsLoading(false);
      return;
    }


    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // ++ Include the session_state in the request body ++
        body: JSON.stringify({ messages: [...messages, userMessage], session_state: sessionState }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: 'Network response was not ok' }));
        throw new Error(errorData.detail || 'An unknown error occurred');
      }

      const data = await response.json();
      
      // ++ Set the new session state from the response ++
      setSessionState(data.session_state);

      const assistantMessage: Message = {
        role: 'assistant',
        content: data.text_response,
        properties: data.properties || [],
      };
      setMessages(prev => [...prev, assistantMessage]);

    } catch (error: any) {
      console.error("Failed to fetch AI response:", error);
      const errorMessage: Message = {
        role: 'assistant',
        content: `Sorry, I'm having trouble connecting. Please try again in a moment. (Error: ${error.message})`,
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };
  
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4">
      <div 
        className="bg-white/80 backdrop-blur-lg rounded-2xl shadow-2xl w-full max-w-md h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b border-gray-200/80 flex justify-between items-center">
          <h2 className="text-lg font-bold text-gray-800">AI Property Assistant</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-800"><X size={24} /></button>
        </div>

        {/* Message List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {messages.map((msg, index) => (
            <div key={index} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {msg.role === 'assistant' && <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white shrink-0"><Sparkles size={16} /></div>}
              <div className={`max-w-xs md:max-w-sm ${msg.role === 'user' ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-800'} rounded-2xl p-3`}>
                <p className="text-sm">{msg.content}</p>
              </div>
               {msg.role === 'user' && <div className="w-8 h-8 rounded-full bg-gray-300 flex items-center justify-center text-gray-600 shrink-0"><User size={16} /></div>}
            </div>
          ))}
          {isLoading && (
            <div className="flex gap-3 justify-start">
              <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white shrink-0"><Loader2 className="animate-spin" size={16} /></div>
              <div className="max-w-xs md:max-w-sm bg-gray-200 text-gray-800 rounded-2xl p-3">
                <p className="text-sm">Searching for properties...</p>
              </div>
            </div>
          )}
          {messages.length > 0 && messages[messages.length - 1].properties && messages[messages.length - 1].properties!.length > 0 && (
            <div className="flex overflow-x-auto space-x-4 pb-2 snap-x snap-mandatory">
              {messages[messages.length - 1].properties!.map((prop: any) => (
                <ChatPropertyCard key={prop.id} property={prop} />
              ))}
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Form */}
        <div className="p-4 border-t border-gray-200/80">
          <div className="relative">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleSend()}
              placeholder="e.g., 2 bed villas in Arabian Ranches"
              className="w-full p-3 pr-12 rounded-full border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
            <button
              onClick={handleSend}
              disabled={isLoading}
              className="absolute right-2 top-1/2 -translate-y-1/2 bg-blue-600 text-white rounded-full w-9 h-9 flex items-center justify-center hover:bg-blue-700 disabled:bg-gray-400"
            >
              <Send size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
