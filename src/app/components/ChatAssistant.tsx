// src/app/components/ChatAssistant.tsx
'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Loader2, User, Sparkles, X } from 'lucide-react';
import { ChatPropertyCard } from './ChatPropertyCard';
import ReactMarkdown from 'react-markdown';
import './ChatAssistant.css';

type Message = {
  role: 'user' | 'assistant';
  content: string;
  properties?: any[];
};

type SessionState = {
  page?: number;
  last_search_type?: string;
  structured_criteria?: Record<string, any>;
};

type ChatAssistantProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function ChatAssistant({ isOpen, onClose }: ChatAssistantProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [excludeIds, setExcludeIds] = useState<string[]>([]);
  // --- FIX: Add state to hold the session context from the backend ---
  const [sessionState, setSessionState] = useState<SessionState>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(scrollToBottom, [messages]);

  // Reset state when the chat is opened
  useEffect(() => {
    if (isOpen) {
        setMessages([
            {
                role: 'assistant',
                content: "Hello! How can I help you find your next property today?"
            }
        ]);
        setInput('');
        setIsLoading(false);
        setExcludeIds([]);
        // --- FIX: Reset session state on open ---
        setSessionState({});
    }
  }, [isOpen]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = { role: 'user', content: input };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    setIsLoading(true);

    try {
        const response = await fetch('/api/chat_langchain', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: newMessages.map(({ role, content, properties }) => ({ role, content, properties })),
                exclude_ids_context: excludeIds,
                // --- FIX: Send the current session state back to the backend ---
                session_state: sessionState,
            }),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ detail: 'Network response was not ok' }));
            throw new Error(errorData.detail || 'An unknown error occurred');
        }
        
        const data = await response.json();
        const assistantMessage: Message = {
            role: 'assistant',
            content: data.text_response,
            properties: data.properties || [],
        };
        setMessages(prev => [...prev, assistantMessage]);

        // --- FIX: Update the local session state with the new state from the backend ---
        setSessionState(data.session_state || {});

        if (data.properties && data.properties.length > 0) {
            const newIds = data.properties.map((p: any) => p.id);
            setExcludeIds(prev => [...new Set([...prev, ...newIds])]);
        }

    } catch (error: any) {
        console.error("Failed to fetch AI response:", error);
        const errorMessage: Message = {
            role: 'assistant',
            content: `Sorry, I'm having trouble connecting. (Error: ${error.message})`,
        };
        setMessages(prev => [...prev, errorMessage]);
    } finally {
        setIsLoading(false);
    }
  }, [input, isLoading, messages, excludeIds, sessionState]);
  
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-0">
    <div 
      className="bg-white/80 backdrop-blur-lg rounded-2xl shadow-2xl 
                 w-[90vw] md:w-[80vw] lg:w-[70vw] 
                 h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-gray-200/80 flex justify-between items-center">
          <h2 className="text-lg font-bold text-gray-800">AI Property Assistant</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-800"><X size={24} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((msg, index) => (
            <div key={index}>
              <div className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'assistant' && <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white shrink-0"><Sparkles size={16} /></div>}
                <div className={`max-w-[90%] md:max-w-[70%] lg:max-w-[75%] 
                ${msg.role === 'user' ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-800'} 
                rounded-2xl p-3`}>
                <ReactMarkdown
                  components={{
                    a: ({node, ...props}) => (
                      <a 
                        className="text-blue-600 underline font-medium" 
                        {...props} 
                        target="_blank" 
                        rel="noopener noreferrer" 
                      />
                    ),
                    p: ({node, ...props}) => <p className="m-0" {...props} />
                  }}
                >
                  {msg.content}
                </ReactMarkdown>
                </div>
                {msg.role === 'user' && <div className="w-8 h-8 rounded-full bg-gray-300 flex items-center justify-center text-gray-600 shrink-0"><User size={16} /></div>}
              </div>
              {msg.role === 'assistant' && msg.properties && msg.properties.length > 0 && (
                <div className="flex overflow-x-auto space-x-4 pb-2 mt-3 snap-x snap-mandatory">
                  {msg.properties.map((prop: any) => (
                    <ChatPropertyCard key={prop.id} property={prop} />
                  ))}
                </div>
              )}
            </div>
          ))}
          {isLoading && (
             <div className="flex gap-3 justify-start">
              <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white shrink-0"><Loader2 className="animate-spin" size={16} /></div>
              <div className="max-w-xs md:max-w-sm bg-gray-200 text-gray-800 rounded-2xl p-3">
                <p className="text-sm">Searching...</p>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="p-4 border-t border-gray-200/80">
          <div className="relative">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleSend()}
              placeholder="e.g., Show Me Villas In Dubai"
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
