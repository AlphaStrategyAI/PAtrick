import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useService } from '../api/query.js';
import { useLocale } from '../i18n/LocaleProvider.js';
import type { MessageKey } from '../i18n/locale.js';

export function PasskeySignIn() {
  const { t } = useLocale();
  const { api, recheck } = useService();
  const [registering, setRegistering] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<MessageKey>();
  const active = useRef<AbortController | undefined>(undefined);
  const ticketField = useRef<HTMLInputElement>(null);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (registering) ticketField.current?.focus();
  }, [registering]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current) return;
    const ticket = registering ? ticketField.current?.value.trim() : undefined;
    if (registering && !ticket) return;
    if (ticketField.current) ticketField.current.value = '';
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(undefined);
    try {
      await api.signInWithPasskey(ticket, { signal: controller.signal });
      if (!controller.signal.aborted) recheck();
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error && cause.message === 'PASSKEY_UNAVAILABLE' ? 'session.passkeyUnavailable'
          : registering ? 'session.passkeyRegistrationFailed' : 'session.passkeySignInFailed');
      }
    } finally {
      active.current = undefined;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return <section className="card">
    <p>{t('session.required')}</p>
    <form onSubmit={submit} aria-busy={pending}>
      {registering && <label className="language-select">
        {t('session.bootstrapTicket')}
        <input ref={ticketField} type="password" autoComplete="off" maxLength={128} required disabled={pending} />
      </label>}
      <div className="actions">
        <button type="submit" className="primary" disabled={pending}>
          {t(registering ? 'session.passkeyRegisterSubmit' : 'session.passkeySignIn')}
        </button>
        <button type="button" disabled={pending} onClick={() => { setRegistering(!registering); setError(undefined); }}>
          {t(registering ? 'button.cancel' : 'session.passkeyRegister')}
        </button>
      </div>
      {pending && <p role="status">{t('session.passkeyPending')}</p>}
      {error && <p role="alert">{t(error)}</p>}
    </form>
  </section>;
}
