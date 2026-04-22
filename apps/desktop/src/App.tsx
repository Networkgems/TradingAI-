import { useState } from 'react';
import { WATCHLIST_SIZE } from '@trading-app/shared';

function App() {
  const [status, setStatus] = useState<'idle' | 'live'>('idle');

  return (
    <main style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
      <h1>Trading App</h1>
      <p>Monitoring {WATCHLIST_SIZE} symbols</p>
      <button onClick={() => setStatus(s => s === 'idle' ? 'live' : 'idle')}>
        {status === 'idle' ? 'Go Live' : 'Pause'}
      </button>
      <p>Status: <strong>{status}</strong></p>
    </main>
  );
}

export default App;
