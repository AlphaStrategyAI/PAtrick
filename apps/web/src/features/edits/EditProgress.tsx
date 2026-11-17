import { editReceiptSchema } from '@patrick/contracts/resources';
import { useLocale } from '../../i18n/LocaleProvider.js';
import type { MessageKey } from '../../i18n/locale.js';

export type EditReceipt = ReturnType<typeof editReceiptSchema.parse>;

export function projectionMessage(receipt: Pick<EditReceipt, 'business' | 'projection'>): MessageKey {
  return receipt.business.state === 'adopted' && receipt.projection.state === 'failed'
    ? 'edits.projection.adopted_pending'
    : `edits.projection.${receipt.projection.state}`;
}

export function EditProgress({ receipt }: { receipt: EditReceipt }) {
  const { t } = useLocale();
  return <dl className="edit-progress" data-testid="edit-progress" aria-live="polite">
    <div><dt>{t('receipt.file')}</dt><dd data-testid="file-state">{t(`edits.file.${receipt.file.state}`)}</dd></div>
    <div><dt>{t('receipt.business')}</dt><dd data-testid="business-state">{t(`edits.business.${receipt.business.state}`)}</dd></div>
    <div><dt>{t('receipt.projection')}</dt><dd data-testid="projection-state">{t(projectionMessage(receipt))}</dd></div>
  </dl>;
}
