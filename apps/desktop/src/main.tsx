import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import {
  installGlobalErrorHandlers,
  installTraceHeader,
  drainMainProcessCrashes,
} from './lib/telemetry';
import './index.css';

// TRA-413 — desktop error telemetry. Install before the app mounts so an error
// during initial render is still captured, before any React tree exists:
//   * installTraceHeader         — stamp X-Trace-Id on outbound API requests
//   * installGlobalErrorHandlers — catch errors outside React's render path
//   * drainMainProcessCrashes    — flush Rust host-process panic records
installTraceHeader();
installGlobalErrorHandlers();
void drainMainProcessCrashes();

// Auto-reload once the freshly installed PWA service worker takes control,
// so users on mobile pick up new releases without a manual hard refresh.
// Pairs with `skipWaiting: true` + `clientsClaim: true` in vite.config.ts.
if ('serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary label="app">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
