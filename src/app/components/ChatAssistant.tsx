// src/app/components/ChatAssistant_Persistent.tsx
'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Loader2, User, Sparkles, X } from 'lucide-react';
import { ChatPropertyCard } from './ChatPropertyCard';
import ReactMarkdown from 'react-markdown';
import './ChatAssistant.css';

// Defines the shape of a message in the chat history
type Message = {
  role: 'user' | 'assistant';
  content: string;
  properties?: any[]; // Holds properties to be displayed
};

// Defines the shape of the session state object
type SessionState = {
  page?: number;
  last_successful_search?: Record<string, any>;
  search_criteria?: Record<string, any>;
  properties_in_context?: any[];
  focused_property_id?: string;
  focused_property_details?: Record<string, any>;
};

type ChatAssistantProps = {
  isOpen: boolean;
  onClose: () => void;
};

/**
 * --- PRODUCTION-GRADE PERSISTENT SESSION ---
 * This implementation uses localStorage to persist the session ID
 * across page loads and browser sessions, similar to ChatGPT or Claude.
 */
export function ChatAssistant({ isOpen, onClose }: ChatAssistantProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  
  // This state holds the entire conversational context received from the backend
  const [sessionState, setSessionState] = useState<SessionState>({});
  
  // --- MODIFICATION 1: Session ID is now retrieved from localStorage ---
  const [sessionId, setSessionId] = useState<string>('');
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(scrollToBottom, [messages]);

  // --- MODIFICATION 2: This effect now runs ONCE on mount to get/set the session ID ---
  useEffect(() => {
    const CHAT_SESSION_KEY = 'chat_session_id';
    
    // Try to get the session ID from localStorage
    let storedSessionId = localStorage.getItem(CHAT_SESSION_KEY);
    
    if (storedSessionId) {
      // If it exists, use it.
      setSessionId(storedSessionId);
    } else {
      // If not, create a new one and store it.
      const newSessionId = crypto.randomUUID();
      localStorage.setItem(CHAT_SESSION_KEY, newSessionId);
      setSessionId(newSessionId);
    }
    
    // Note: We no longer reset the session ID when `isOpen` changes.
    // The session is now persistent for the user's browser.
    
  }, []); // Empty dependency array ensures this runs only once.

  // --- MODIFICATION 3: Reset chat state, but NOT session ID, when opening ---
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
        setSessionState({});
        // We no longer generate a new ID here.
    }
  }, [isOpen]);

  const handleSend = useCallback(async () => {
    // Check for session ID is still important
    if (!input.trim() || isLoading || !sessionId) {
      if (!sessionId) {
        console.error("Chat Error: Attempted to send a message without a session ID.");
      }
      return;
    }

    const userMessage: Message = { role: 'user', content: input };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    setIsLoading(true);

    try {
        const apiUrl = process.env.NEXT_PUBLIC_CHAT_API_URL || 'http://localhost:8000';
        const response = await fetch(`${apiUrl}/api/chat_langchain`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: newMessages.map(({ role, content, properties }) => ({ role, content, properties })),
                session_state: sessionState,
                // Pass the persistent session ID
                session_id: sessionId,
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
        setSessionState(data.session_state || {});

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
  // sessionId is now stable after the first mount, but we include it.
  }, [input, isLoading, messages, sessionState, sessionId]);
  
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
                <div className={`max-w-[90%] md:max-w-[70%] lg:w-fit lg:max-w-[75%]
                ${msg.role === 'user' ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-800'} 
                rounded-2xl p-3 chat-markdown`}>
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
              onKeyPress={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSend())}
              placeholder="e.g., Show Me Villas In Dubai"
              className="w-full p-3 pr-12 rounded-full border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
            <button
              onClick={handleSend}
              disabled={isLoading || !input.trim()}
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