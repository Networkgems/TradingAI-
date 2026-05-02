// Resolve the backend URL.
// In production (non-localhost host), derive from window.location so the
// frontend hits its own origin instead of the dev fallback.
export const SERVER_URL: string = import.meta.env.VITE_SERVER_URL ??
  (typeof window !== 'undefined' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1'
    ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
    : 'ws://localhost:4242');

export const HTTP_URL: string = SERVER_URL.replace(/^ws/, 'http');
