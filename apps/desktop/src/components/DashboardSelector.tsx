// TRA-419 — DashboardSelector component extracted from App.tsx.
import React from 'react';
import { ThemeToggle } from './ThemeToggle';
import { CandlestickIcon, BitcoinIcon } from './Icons';
import type { Theme } from './ThemeToggle';

export function DashboardSelector({ onSelect, onLogout, theme, onToggleTheme }: { onSelect: (mode: 'stocks' | 'crypto') => void; onLogout: () => void; theme: Theme; onToggleTheme: () => void }) {
  return (
    <div className="selector-screen">
      <div className="selector-topbar">
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        <button className="logout-btn" onClick={onLogout}>Sign Out</button>
      </div>
      <div className="selector-header">
        <h1 className="selector-title">TradingAI</h1>
        <p className="selector-subtitle">Select your trading dashboard</p>
      </div>
      <div className="selector-cards">
        <button className="selector-card stocks" onClick={() => onSelect('stocks')}>
          <div className="selector-card-icon"><CandlestickIcon /></div>
          <div className="selector-card-title">Stocks Trading</div>
          <div className="selector-card-desc">Trade US equities with ORB, Reversal, MACD, and Ichimoku strategies</div>
        </button>
        <button className="selector-card crypto" onClick={() => onSelect('crypto')}>
          <div className="selector-card-icon"><BitcoinIcon /></div>
          <div className="selector-card-title">Crypto Trading</div>
          <div className="selector-card-desc">Trade crypto 24/7 with live data and algorithmic strategies</div>
        </button>
      </div>
    </div>
  );
}
