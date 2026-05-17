// TRA-419 — SVG icon components extracted from App.tsx.

export function CandlestickIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="8" y="18" width="8" height="16" rx="1" fill="#3fb950" />
      <line x1="12" y1="10" x2="12" y2="18" stroke="#3fb950" strokeWidth="2" />
      <line x1="12" y1="34" x2="12" y2="42" stroke="#3fb950" strokeWidth="2" />
      <rect x="22" y="12" width="8" height="20" rx="1" fill="#f85149" />
      <line x1="26" y1="6" x2="26" y2="12" stroke="#f85149" strokeWidth="2" />
      <line x1="26" y1="32" x2="26" y2="40" stroke="#f85149" strokeWidth="2" />
      <rect x="36" y="16" width="8" height="14" rx="1" fill="#3fb950" />
      <line x1="40" y1="8" x2="40" y2="16" stroke="#3fb950" strokeWidth="2" />
      <line x1="40" y1="30" x2="40" y2="38" stroke="#3fb950" strokeWidth="2" />
    </svg>
  );
}

export function BitcoinIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="24" cy="24" r="20" stroke="#f7931a" strokeWidth="2.5" />
      <text x="24" y="31" textAnchor="middle" fontSize="22" fontWeight="bold" fill="#f7931a" fontFamily="monospace">₿</text>
    </svg>
  );
}
