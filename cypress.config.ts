// cypress.config.ts
import { defineConfig } from "cypress";
import * as dotenv from 'dotenv'; // Import dotenv

// Load .env.local for development (adjust path if your .env.local is not in the root)
dotenv.config({ path: '.env.local' });

export default defineConfig({
  e2e: {
    baseUrl: 'http://localhost:3000', // Your local development server URL
    setupNodeEvents(on, config) {
      // Pass environment variables to Cypress tests
      config.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
      config.env.SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      return config;
    },
  },
});