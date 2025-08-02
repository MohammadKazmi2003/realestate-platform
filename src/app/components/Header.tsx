// src/app/components/Header.tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Search, Menu, X } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { ChatAssistant } from './ChatAssistant'; // Import the new component

export default function Header() {
  const { user, signOut } = useAuth();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false); // State for the chat modal

  const navLinks = [
    { href: '/browse', label: 'Browse' },
    { href: '/newprojects', label: 'New Projects' },
    { href: '/map', label: 'Map View' },
    user ? { href: '/my-listings', label: 'My Listings' } : null,
    user ? { href: '/favorites', label: 'Favorites' } : null,
  ].filter(Boolean);

  return (
    <>
      <header className="bg-bg-color shadow-neumorphic-outset sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center">
              <Link href="/" className="text-2xl font-bold text-text-color-dark">
                PropertyPlatform
              </Link>
            </div>

            {/* AI Search Bar - Desktop */}
            <div className="hidden md:block w-1/3">
              <div 
                className="relative cursor-pointer"
                onClick={() => setIsChatOpen(true)}
              >
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Search className="h-5 w-5 text-gray-400" />
                </div>
                <div className="block w-full neumorphic-input !pl-10 !py-2">
                  Ask AI to find your dream property...
                </div>
              </div>
            </div>

            <div className="flex items-center">
              <nav className="hidden md:flex items-center space-x-4">
                {navLinks.map((link) => (
                  <Link key={link!.href} href={link!.href} className="text-text-color-light hover:text-text-color-dark px-3 py-2 rounded-md text-sm font-medium">
                    {link!.label}
                  </Link>
                ))}
                {user ? (
                  <button onClick={signOut} className="neumorphic-button">Sign Out</button>
                ) : (
                  <Link href="/sign-in" className="neumorphic-button">Sign In</Link>
                )}
              </nav>
              <div className="md:hidden">
                <button onClick={() => setIsMenuOpen(!isMenuOpen)} className="neumorphic-button !p-2">
                  {isMenuOpen ? <X /> : <Menu />}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Mobile Menu */}
        {isMenuOpen && (
          <div className="md:hidden p-4 space-y-2">
            {/* AI Search Bar - Mobile */}
            <div 
              className="relative cursor-pointer mb-4"
              onClick={() => { setIsChatOpen(true); setIsMenuOpen(false); }}
            >
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Search className="h-5 w-5 text-gray-400" />
              </div>
              <div className="block w-full neumorphic-input !pl-10 !py-2">
                Ask AI...
              </div>
            </div>

            {navLinks.map((link) => (
              <Link key={link!.href} href={link!.href} className="block text-text-color-light hover:text-text-color-dark px-3 py-2 rounded-md text-base font-medium">
                {link!.label}
              </Link>
            ))}
             {user ? (
                <button onClick={signOut} className="w-full text-left neumorphic-button">Sign Out</button>
              ) : (
                <Link href="/sign-in" className="block neumorphic-button">Sign In</Link>
              )}
          </div>
        )}
      </header>
      
      {/* Chat Assistant Modal */}
      <ChatAssistant isOpen={isChatOpen} onClose={() => setIsChatOpen(false)} />
    </>
  );
}
