'use client';

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';

export type ThemeMode = 'auto' | 'day' | 'night';

const KEY = 'era_theme';
/** Night shift hours in the property's local time: 21:00 – 07:00. */
const NIGHT_FROM = 21;
const NIGHT_UNTIL = 7;

export function localHour(timezone: string, at = new Date()) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: timezone }).format(at));
  } catch {
    return at.getHours();
  }
}

const isNightHour = (h: number) => h >= NIGHT_FROM || h < NIGHT_UNTIL;

interface ThemeState {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  night: boolean;
}

const ThemeContext = createContext<ThemeState>({ mode: 'auto', setMode: () => undefined, night: false });

/**
 * Staff screens follow the shift, not the computer: in "auto" the night palette starts at
 * 21:00 and ends at 07:00 in the property's time zone. Public guest pages always stay light,
 * because the attribute is removed when the staff app unmounts.
 */
export function ThemeProvider({ timezone, children }: { timezone: string; children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('auto');
  const [hour, setHour] = useState(() => localHour(timezone));

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === 'day' || saved === 'night' || saved === 'auto') setModeState(saved);
    } catch {}
  }, []);

  useEffect(() => {
    setHour(localHour(timezone));
    const timer = setInterval(() => setHour(localHour(timezone)), 60_000);
    return () => clearInterval(timer);
  }, [timezone]);

  const night = mode === 'night' || (mode === 'auto' && isNightHour(hour));

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = night ? 'night' : 'day';
    return () => {
      delete root.dataset.theme;
    };
  }, [night]);

  const value = useMemo<ThemeState>(
    () => ({
      mode,
      night,
      setMode: (m) => {
        setModeState(m);
        try {
          localStorage.setItem(KEY, m);
        } catch {}
      },
    }),
    [mode, night],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
