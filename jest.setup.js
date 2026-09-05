// jest.setup.js
import '@testing-library/jest-dom';

// Node globals missing under the jsdom env (needed by undici via
// @elastic/elasticsearch, ioredis, etc.).
const { TextEncoder, TextDecoder } = require('util');
if (typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;
const { ReadableStream, WritableStream, TransformStream } = require('stream/web');
if (typeof global.ReadableStream === 'undefined') global.ReadableStream = ReadableStream;
if (typeof global.WritableStream === 'undefined') global.WritableStream = WritableStream;
if (typeof global.TransformStream === 'undefined') global.TransformStream = TransformStream;

jest.mock('next/navigation', () => ({
  useRouter: jest.fn(() => ({
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn(),
    back: jest.fn(),
  })),
  usePathname: jest.fn(() => '/'),
}));

jest.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
      getUser: jest.fn(() => Promise.resolve({ data: { user: null }, error: null })),
      signOut: jest.fn(() => Promise.resolve({ error: null })),
    },
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          single: jest.fn(() => Promise.resolve({ data: null, error: null })),
          maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })),
        })),
        in: jest.fn(() => Promise.resolve({ data: [], error: null })),
        limit: jest.fn(() => Promise.resolve({ data: [], error: null })),
      })),
      insert: jest.fn(() => ({
        select: jest.fn(() => ({
          single: jest.fn(() => Promise.resolve({ data: { id: 'test-id' }, error: null })),
        })),
      })),
      update: jest.fn(() => ({
        eq: jest.fn(() => ({
          eq: jest.fn(() => Promise.resolve({ error: null })),
        })),
      })),
      delete: jest.fn(() => ({
        eq: jest.fn(() => ({
          eq: jest.fn(() => Promise.resolve({ error: null })),
          in: jest.fn(() => Promise.resolve({ error: null })),
        })),
      })),
      rpc: jest.fn(() => Promise.resolve({ data: [], error: null })),
    })),
    storage: {
      from: jest.fn(() => ({
        upload: jest.fn(() => Promise.resolve({ data: { path: 'test-path' }, error: null })),
        getPublicUrl: jest.fn(() => ({ publicUrl: 'http://mock-url.com/test-path' })),
        remove: jest.fn(() => Promise.resolve({ data: {}, error: null })),
      })),
    },
  },
}));

jest.mock('browser-image-compression', () => ({
  __esModule: true,
  default: jest.fn((file) => Promise.resolve(file)),
}));