import { Icon } from '../components/icons.js';
import { StatsPage } from '../features/stats/StatsPage.js';
import { NotificationPanel } from '../features/system/NotificationPanel.js';
import { SystemCategories } from '../features/system/SystemCategories.js';
import { DiagnosticsPanel } from '../features/system/DiagnosticsPanel.js';
import { CollectionPage } from '../features/collection/CollectionPage.js';
import { AccountPreferences } from '../features/settings/AccountPreferences.js';
import { SettingsOverview } from '../features/settings/SettingsOverview.js';
import { SettingsReadiness } from '../features/settings/SettingsReadiness.js';
import { ChangeReceipt, SettingsGroup } from '../features/settings/SettingsGroup.js';
import { WorkMaterials } from '../features/settings/WorkMaterials.js';
import { DecisionsPage } from '../features/decisions/DecisionsPage.js';
import { WorkPage as LiveWorkPage } from '../features/work/WorkPage.js';
import { WorkDetail } from '../features/work/WorkDetail.js';
import { safeResource } from '../features/work/contracts.js';
import { Link, Navigate, useOutletContext, useParams } from 'react-router';
import type { RouteObject } from 'react-router';
import type { ReactNode } from 'react';
import { useService, asClientError } from '../api/query.js';
import { LocalizedError, SafeMarkdown, ScopePreview, StatusEvidence } from '../components/shared.js';
import { KnowledgePage } from '../features/knowledge/KnowledgePage.js';
import { StandardsPage } from '../features/standards/StandardsPage.js';
import { DelegationsPage } from '../features/delegation/DelegationsPage.js';
import { useLocale } from '../i18n/LocaleProvider.js';
import type { MessageKey } from '../i18n/locale.js';
import { AppShell, LanguageSelect } from './AppShell.js';
import type { ShellHealthContext } from './AppShell.js';
import { demoWork, isDemo } from './demo.js';
import { navigation, settingsNavigation, workDetailPath } from './navigation.js';
import type { NavigationItem } from './navigation.js';

function PageFrame({ item, action, children }: { item: Pick<NavigationItem, 'label' | 'summary'>; action?: ReactNode; children?: ReactNode }) {
  const { t } = useLocale();
  return <>
    <div className={action ? 'page-title settings-page-title' : 'page-title'}>
      <h1>{t(item.label)}</h1><p>{t(item.summary)}</p>{action}
    </div>
    {children}
  </>;
}

function Authenticated({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const { scope, verifying, accessError, recheck } = useService();
  if (isDemo || scope) return children;
  if (verifying) return <p role="status">{t('session.checking')}</p>;
  return accessError && accessError.code !== 'UNAUTHENTICATED'
    ? <LocalizedError code={accessError.code} onRetry={recheck} />
    : <section className="card"><p>{t('session.required')}</p><button type="button" onClick={recheck}>{t('button.retry')}</button></section>;
}

function UnconnectedPage({ item, empty }: { item: NavigationItem; empty?: MessageKey }) {
  const { t } = useLocale();
  return <PageFrame item={item}><Authenticated>
    <section className="card">
      <p>{t(isDemo ? empty ?? 'empty.demo' : 'empty.unavailable')}</p>
      {isDemo && item.path === '/decisions' && <Link className="primary" to="/work">{t('button.openWork')}</Link>}
    </section>
  </Authenticated></PageFrame>;
}

function WorkPage() {
  const { t } = useLocale();
  return <PageFrame item={navigation[1]}><Authenticated>
    {isDemo
      ? <section className="card"><Link to={`/work/${demoWork.id}`}>{t(demoWork.title)}</Link><p>{t(demoWork.state)}</p></section>
      : <LiveWorkPage />}
  </Authenticated></PageFrame>;
}

function WorkDetailPage() {
  const { id } = useParams();
  const { t } = useLocale();
  const workId = safeResource(id);
  const sample = isDemo && id === demoWork.id;
  return <>
    <div className="page-title">
      <h1>{t(sample ? demoWork.title : 'nav.work')}</h1>
      <p>{t(sample ? demoWork.state : 'summary.work')}</p>
    </div>
    <Authenticated>
      {sample
        ? <section className="card">
          <SafeMarkdown>{t('demo.note')}</SafeMarkdown>
          <ScopePreview><p>{t('demo.scope')}</p></ScopePreview>
        </section>
        : !isDemo && workId ? <WorkDetail workId={workId} /> : <LocalizedError code="NOT_FOUND" />}
      <Link className="secondary" to="/work">{t('button.backWork')}</Link>
    </Authenticated>
  </>;
}

function SystemPage() {
  const { t } = useLocale();
  const { health, healthStatus, projectionCurrent, verifiedAsOf } = useOutletContext<ShellHealthContext>();
  return <PageFrame item={navigation[5]}><Authenticated>
    <section className="card">
      {isDemo ? <p>{t('empty.demo')}</p> : <>
        <StatusEvidence status={healthStatus} asOf={verifiedAsOf} current={projectionCurrent} />
        {health.error && <LocalizedError code={asClientError(health.error).code} />}
        <button type="button" className="primary" disabled={health.isFetching} onClick={() => { void health.refetch(); }}>
          {t(health.isFetching ? 'status.refreshing' : 'button.refreshStatus')}
        </button>
        <ChangeReceipt system />
        <SystemCategories />
        <NotificationPanel />
        <DiagnosticsPanel writeAttachment={(api, request, signal) =>
          api.writeAttachment('exportDiagnostics', {}, request, { signal })} />
      </>}
    </section>
  </Authenticated></PageFrame>;
}

function SettingsPage() {
  const { t } = useLocale();
  const { scope } = useService();
  // The home keeps the locked design's unavailable action. The checks themselves run
  // from the execution and operation groups, where the backend and host status live.
  const action = (isDemo || !!scope) ? <div className="settings-checks-action">
    <button className="primary" type="button" disabled aria-describedby="settings-checks-unavailable">{t('settings.overview.checks')}</button>
    <p id="settings-checks-unavailable">{t('settings.overview.checksUnavailable')}</p>
  </div> : undefined;
  return <PageFrame item={navigation[7]} action={action}><Authenticated>
    <SettingsOverview />
    <nav className="settings-grid" aria-label={t('aria.settings')}>
      {settingsNavigation.map(item => <Link key={item.path} to={item.path} className="settings-row"
        aria-labelledby={item.label} aria-describedby={item.description}>
        <Icon name={item.icon} />
        <span className="settings-row-copy">
          <strong id={item.label}>{t(item.label)}</strong>
          <span id={item.description}>{t(item.description)}</span>
        </span>
        <span aria-hidden="true">→</span>
      </Link>)}
    </nav>
    <SettingsReadiness />
  </Authenticated></PageFrame>;
}

function PreferencesPage() {
  const { t, reducedMotion, setReducedMotion, storageFailed } = useLocale();
  return <PageFrame item={settingsNavigation[5]}><Authenticated>
    {!isDemo ? <AccountPreferences><LanguageSelect /></AccountPreferences> : <section className="card preference-card">
      <LanguageSelect />
      <label className="check-control"><input type="checkbox" checked={reducedMotion}
        onChange={(event) => setReducedMotion(event.target.checked)} /> {t('motion.label')}</label>
      <p role="status">{t(storageFailed ? 'language.memoryOnly' : 'language.unsynced')}</p>
    </section>}
  </Authenticated></PageFrame>;
}

function NotFound() {
  const { t } = useLocale();
  return <div className="page-title"><h1>{t('page.notFound')}</h1><Link to="/work">{t('button.backWork')}</Link></div>;
}

export const appRoutes: RouteObject[] = [{
  path: '/', element: <AppShell />, children: [
    { index: true, element: <Navigate to="/decisions" replace /> },
    { path: '/decisions', element: isDemo ? <UnconnectedPage item={navigation[0]} empty="empty.decisions" />
      : <PageFrame item={navigation[0]}><Authenticated><DecisionsPage /></Authenticated></PageFrame> },
    { path: '/work', element: <WorkPage /> },
    { path: workDetailPath, element: <WorkDetailPage /> },
    { path: '/standards', element: isDemo ? <UnconnectedPage item={navigation[2]} empty="empty.standards" />
      : <PageFrame item={navigation[2]}><Authenticated><StandardsPage /></Authenticated></PageFrame> },
    { path: '/knowledge', element: isDemo ? <UnconnectedPage item={navigation[3]} empty="empty.knowledge" />
      : <PageFrame item={navigation[3]}><Authenticated><KnowledgePage /></Authenticated></PageFrame> },
    { path: '/delegations', element: isDemo ? <UnconnectedPage item={navigation[4]} empty="empty.delegations" />
      : <PageFrame item={navigation[4]}><Authenticated><DelegationsPage /></Authenticated></PageFrame> },
    { path: '/system', element: <SystemPage /> },
    { path: '/stats', element: isDemo ? <UnconnectedPage item={navigation[6]} />
      : <PageFrame item={navigation[6]}><Authenticated><StatsPage /></Authenticated></PageFrame> },
    { path: '/settings', element: <SettingsPage /> },
    ...settingsNavigation.slice(0, 5).map((item) => ({ path: item.path, element: isDemo ? <UnconnectedPage item={item} />
      : <PageFrame item={item}><Authenticated>{item.path === '/settings/collection' ? <CollectionPage />
        : item.path === '/settings/materials' ? <><WorkMaterials /><SettingsGroup group="materials" /></>
        : <SettingsGroup group={item.path.split('/').at(-1)!} />}</Authenticated></PageFrame> })),
    { path: '/settings/preferences', element: <PreferencesPage /> },
    { path: '*', element: <NotFound /> },
  ],
}];
