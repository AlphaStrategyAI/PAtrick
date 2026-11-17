import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { getLocalStorage } from '../state/browserStorage.js';
import { browserLanguages, isLocaleMode, message, resolveLocale } from './locale.js';
import type { Locale, LocaleMode, MessageKey } from './locale.js';

type Preference = {
  locale: Locale;
  mode: LocaleMode;
  presentation_epoch: number;
  reducedMotion: boolean;
  storageFailed: boolean;
  t: (key: MessageKey) => string;
  setMode: (mode: LocaleMode) => void;
  setReducedMotion: (enabled: boolean) => void;
  applyPreferences: (mode: LocaleMode, reduced: boolean) => void;
};

const LocaleContext = createContext<Preference | null>(null);

function initialPreferences(account: string | null) {
  if (!account) return { mode: 'system' as const, reduced: false };
  try {
    const data: unknown = JSON.parse(getLocalStorage()?.getItem(preferenceKey(account)) ?? 'null');
    if (data && typeof data === 'object' && 'mode' in data && isLocaleMode(data.mode)) {
      return { mode: data.mode, reduced: 'reduced' in data && data.reduced === true };
    }
  } catch { /* Unavailable local preferences fall back to the system. */ }
  return { mode: 'system' as const, reduced: false };
}

function preferenceKey(account: string): string {
  return `patrick:preferences:v1:${encodeURIComponent(account)}`;
}

export function LocaleProvider({ account, children }: { account: string | null; children: ReactNode }) {
  const [local, setLocal] = useState(() => initialPreferences(account));
  const [storageFailed, setStorageFailed] = useState(false);
  const [languages, setLanguages] = useState(() => browserLanguages(navigator));
  const locale = resolveLocale(local.mode, languages);
  const [presentation, setPresentation] = useState({ locale, epoch: 0 });
  if (presentation.locale !== locale) setPresentation({ locale, epoch: presentation.epoch + 1 });
  useEffect(() => {
    const onChange = () => setLanguages(browserLanguages(navigator));
    window.addEventListener('languagechange', onChange);
    return () => window.removeEventListener('languagechange', onChange);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    document.documentElement.dataset.reducedMotion = String(local.reduced);
  }, [locale, local.reduced]);

  function save(mode: LocaleMode, reduced: boolean) {
    setLocal({ mode, reduced });
    try {
      const storage = getLocalStorage();
      if (account && storage) {
        storage.setItem(preferenceKey(account), JSON.stringify({ mode, reduced }));
        setStorageFailed(false);
        return;
      }
    } catch { /* Keep the user's choice in memory for this session. */ }
    setStorageFailed(true);
  }

  return <LocaleContext.Provider value={{
    locale, mode: local.mode, presentation_epoch: presentation.epoch, reducedMotion: local.reduced, storageFailed,
    t: (key) => message(locale, key),
    setMode: (mode) => save(mode, local.reduced),
    setReducedMotion: (reduced) => save(local.mode, reduced),
    applyPreferences: save,
  }}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Preference {
  const context = useContext(LocaleContext);
  if (!context) throw new Error('LocaleProvider is required');
  return context;
}
