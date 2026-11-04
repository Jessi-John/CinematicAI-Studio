// vitest-specific entry point that extends VitestMatcher interface globally
import '@testing-library/jest-dom/vitest';

// Polyfill crypto.getRandomValues for jsdom
if (typeof globalThis.crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) {
          arr[i] = Math.floor(Math.random() * 256);
        }
        return arr;
      },
      randomUUID: () =>
        'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          const v = c === 'x' ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        }),
    },
    writable: true,
  });
}

// Mock IntersectionObserver for components that use it
Object.defineProperty(globalThis, 'IntersectionObserver', {
  value: class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    root = null;
    rootMargin = '';
    thresholds = [];
    takeRecords = () => [];
  },
  writable: true,
});

// Mock window.matchMedia for framer-motion and responsive components
Object.defineProperty(globalThis, 'matchMedia', {
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
  writable: true,
});

// Mock scrollTo/scrollIntoView for components that call them
Object.defineProperty(globalThis, 'scrollTo', { value: vi.fn(), writable: true });

// Mock ResizeObserver
Object.defineProperty(globalThis, 'ResizeObserver', {
  value: class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  },
  writable: true,
});
