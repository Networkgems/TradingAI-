// TRA-419 — theme types, storage helpers, and ThemeToggle component extracted from App.tsx.
import { useCallback, useEffect, useState } from 'react';
import { logger } from '../lib/logger';

export type Theme = 'light' | 'dark';
export const THEME_STORAGE_KEY = 'tradingai_theme';

export function readInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch (err) { logger.warn('theme', 'could not read stored theme preference', err); }
  return 'light';
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(() => readInitialTheme());

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('theme-light', 'theme-dark');
    root.classList.add(theme === 'dark' ? 'theme-dark' : 'theme-light');
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch (err) { logger.warn('theme', 'could not persist theme preference', err); }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(t => t === 'light' ? 'dark' : 'light');
  }, []);

  return { theme, toggleTheme };
}

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label="Toggle theme"
    >
      <span aria-hidden="true">{isDark ? '☾' : '☀'}</span>
      <span className="theme-toggle-label">{isDark ? 'Dark' : 'Light'}</span>
    </button>
  );
}
