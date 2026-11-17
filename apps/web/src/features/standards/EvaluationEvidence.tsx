import { ClientError } from '../../api/client.js';
import { asClientError, useScopedSnapshot } from '../../api/query.js';
import { LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { integer, record, string } from '../edits/support.js';

function parseReport(value: unknown) {
  const row = record(value);
  const decision = row.decision;
  if (decision !== 'pass' && decision !== 'fail' && decision !== 'insufficient' && decision !== 'leak') {
    throw new ClientError('INVALID_RESPONSE');
  }
  const trainingCorrect = integer(row.training_correct);
  const trainingTotal = integer(row.training_total);
  const holdoutCorrect = integer(row.holdout_correct);
  const holdoutTotal = integer(row.holdout_total);
  if (trainingCorrect > trainingTotal || holdoutCorrect > holdoutTotal) throw new ClientError('INVALID_RESPONSE');
  return {
    id: string(row.id), candidate: string(row.candidate_id), dataset: string(row.dataset_id), decision,
    trainingCorrect, trainingTotal, holdoutCorrect, holdoutTotal, policy: integer(row.policy_version),
  } as const;
}

export function EvaluationEvidence({ id, candidate }: { id: string; candidate?: string }) {
  const { t } = useLocale();
  const report = useScopedSnapshot('getEvaluation', { id }, parseReport);
  if (report.error) return <LocalizedError code={asClientError(report.error).code} />;
  const data = report.data?.data;
  if (!data) return <p role="status">{t('status.verifying')}</p>;
  if (data.id !== id || (candidate && data.candidate !== candidate)) return <LocalizedError code="INVALID_RESPONSE" />;
  return <section data-testid="evaluation-evidence">
    <h3>{t(`standards.decision.${data.decision}`)}</h3>
    <dl className="edit-progress">
      <div><dt>{t('standards.dataset')}</dt><dd>{data.dataset}</dd></div>
      <div><dt>{t('standards.training')}</dt><dd>{data.trainingCorrect} / {data.trainingTotal}</dd></div>
      <div><dt>{t('standards.holdout')}</dt><dd>{data.holdoutCorrect} / {data.holdoutTotal}</dd></div>
      <div><dt>{t('standards.policy')}</dt><dd>{data.policy}</dd></div>
    </dl>
  </section>;
}
