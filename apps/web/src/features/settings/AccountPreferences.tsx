import { useEffect, useRef, useState, type ReactNode } from 'react';
import { storedPreferences } from '@patrick/contracts/resources';
import { asClientError, useScopedSnapshot, useService } from '../../api/query.js';
import { LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { safeEnvelope } from './envelope.js';

export function AccountPreferences({ children }: { children: ReactNode }) {
  const { api } = useService();
  const { t, mode, reducedMotion, setReducedMotion, applyPreferences } = useLocale();
  const prefs = useScopedSnapshot('getPreferences', {}, storedPreferences.parse);
  const server = prefs.data?.data;
  const [pending, setPending] = useState(false);
  const active = useRef(false);
  const [error, setError] = useState<string>();
  const [savedRevision, setSavedRevision] = useState<number>();
  const initialized = useRef(false);
  const initialLocal = useRef({ mode, reducedMotion });
  const editedLocally = useRef(false);
  const version = Math.max(savedRevision ?? 0, server?.revision ?? 0);

  useEffect(() => {
    if (!server || initialized.current) return;
    initialized.current = true;
    if (!editedLocally.current && mode === initialLocal.current.mode && reducedMotion === initialLocal.current.reducedMotion) {
      applyPreferences(server.mode, server.reduced_motion);
    }
  }, [applyPreferences, mode, reducedMotion, server]);

  async function save() {
    const identity = prefs.data?.scope;
    if (active.current || !server || !identity) return;
    active.current = true;
    setPending(true);
    setError(undefined);
    try {
      const payload = { account_id: identity.account_id, auth_epoch: identity.permission_epoch,
        changes: { mode, reduced_motion: reducedMotion } };
      const saved = await api.write('patchPreferences', {}, await safeEnvelope(payload, version)) as { data: { revision: number } };
      setSavedRevision(saved.data.revision);
      await prefs.refetch();
    } catch (cause) {
      setError(asClientError(cause).code);
    } finally {
      active.current = false;
      setPending(false);
    }
  }

  return <section className="card preference-card" onChangeCapture={() => { editedLocally.current = true; }}>
    {children}
    <label className="check-control"><input type="checkbox" checked={reducedMotion}
      onChange={(event) => setReducedMotion(event.target.checked)} /> {t('motion.label')}</label>
    {prefs.error && <LocalizedError code={asClientError(prefs.error).code} onRetry={() => { void prefs.refetch(); }} />}
    {error && <LocalizedError code={error} onRetry={error === 'CONFLICT' ? () => { void prefs.refetch(); } : undefined} />}
    <p role="status">{t(server && mode === server.mode && reducedMotion === server.reduced_motion
      ? 'settings.saved' : 'language.unsynced')}</p>
    <button type="button" className="primary" onClick={() => { void save(); }} disabled={pending || !server || prefs.isFetching}>
      {t('settings.saveAccount')}
    </button>
  </section>;
}
