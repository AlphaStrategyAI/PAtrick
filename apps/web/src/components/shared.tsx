import { Fragment, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useLocale } from '../i18n/LocaleProvider.js';
import { errorMessage, formatDate } from '../i18n/locale.js';
import type { MessageKey } from '../i18n/locale.js';
import { parseInlineMarkdown } from './markdown.js';

export function SafeMarkdown({ children }: { children: string }) {
  return <div className="markdown">{parseInlineMarkdown(children).map((part, index) => {
    switch (part.kind) {
      case 'strong': return <strong key={index}>{part.text}</strong>;
      case 'emphasis': return <em key={index}>{part.text}</em>;
      case 'code': return <code key={index}>{part.text}</code>;
      case 'link': return <a key={index} href={part.href} rel="noreferrer">{part.text}</a>;
      case 'text': return <Fragment key={index}>{part.text}</Fragment>;
    }
  })}</div>;
}

/** Keep the same modal element when locale changes, preserving typing and focus. */
export function Dialog({ title, className, children, onClose }: {
  title: string; className?: string; children: ReactNode; onClose: () => void;
}) {
  const { t } = useLocale();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const previous = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={ref} className={className} aria-label={title} onCancel={(event) => {
    event.preventDefault();
    onClose();
  }}>
    <header className="dialog-head">
      <h2>{title}</h2>
      <button type="button" className="icon-button" aria-label={t('aria.closeDialog')} onClick={onClose}>
        <span aria-hidden="true">×</span>
      </button>
    </header>
    {children}
  </dialog>;
}

export function ConfirmDialog({ title, detail, pending, onClose, onConfirm }: {
  title: MessageKey; detail: ReactNode; pending?: boolean; onClose: () => void; onConfirm: () => void;
}) {
  const { t } = useLocale();
  return <Dialog title={t(title)} onClose={onClose}>
    {detail}
    <footer className="actions">
      <button type="button" onClick={onClose}>{t('button.cancel')}</button>
      <button type="button" className="primary" disabled={pending} onClick={onConfirm}>{t('button.confirm')}</button>
    </footer>
  </Dialog>;
}

export function StatusEvidence({ status, asOf, current = false, announce = false }: {
  status: MessageKey; asOf?: string; current?: boolean; announce?: boolean;
}) {
  const { locale, t } = useLocale();
  return <div className="status-evidence">
    <span className="status-pill" role={announce ? 'status' : undefined}>{t(status)}</span>
    {asOf && <span className="muted">{t(current ? 'status.projectionAsOf' : 'status.lastProjectionAsOf')}{' '}
      <time dateTime={asOf}>{formatDate(locale, asOf)}</time></span>}
  </div>;
}

export function LocalizedError({ code, onRetry }: { code: string; onRetry?: () => void }) {
  const { locale, t } = useLocale();
  return <div className="error-panel">
    <p role="alert">{errorMessage(locale, code)}</p>
    {onRetry && <button type="button" onClick={onRetry}>{t('button.retry')}</button>}
  </div>;
}

export function ScopePreview({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  return <details className="scope-preview">
    <summary>{t('scope.details')}</summary>
    {children}
  </details>;
}

export function ConnectionWizard({ steps, current, canContinue, children, onStep }: {
  steps: readonly MessageKey[]; current: number; canContinue: boolean; children: ReactNode; onStep: (index: number) => void;
}) {
  const { t } = useLocale();
  return <section className="card">
    <ol className="wizard-steps">{steps.map((step, index) =>
      <li key={step} aria-current={index === current ? 'step' : undefined}>{t(step)}</li>)}</ol>
    {children}
    <footer className="actions">
      <button type="button" disabled={current <= 0} onClick={() => onStep(current - 1)}>{t('wizard.previous')}</button>
      {current < steps.length - 1 &&
        <button type="button" className="primary" disabled={!canContinue} onClick={() => onStep(current + 1)}>{t('wizard.next')}</button>}
    </footer>
  </section>;
}

export function EditProgress({ file, business, projection }: { file: MessageKey; business: MessageKey; projection: MessageKey }) {
  const { t } = useLocale();
  return <dl className="edit-progress">{([
    ['receipt.file', file], ['receipt.business', business], ['receipt.projection', projection],
  ] as const).map(([axis, state]) => <div key={axis}><dt>{t(axis)}</dt><dd>{t(state)}</dd></div>)}</dl>;
}
