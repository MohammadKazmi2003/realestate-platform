// src/app/layout.tsx
import type { Metadata } from "next";
// import { Geist, Geist_Mono } from "next/font/google"; // COMMENTED OUT
import "./globals.css";
import { AuthProvider } from "@/context/AuthContext";

// COMMENTED OUT FONT DEFINITIONS:
// const geistSans = Geist({
//   variable: "--font-geist-sans",
//   subsets: ["latin"],
// });

// const geistMono = Geist_Mono({
//   variable: "--font-geist-mono",
//   subsets: ["latin"],
// });

export const metadata: Metadata = {
  title: "Real Estate Platform",
  description: "Built with Supabase and Next.js",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        // className={`${geistSans.variable} ${geistMono.variable} antialiased`} // MODIFIED LINE
        className="antialiased" // NEW LINE
      >
        <AuthProvider>
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}