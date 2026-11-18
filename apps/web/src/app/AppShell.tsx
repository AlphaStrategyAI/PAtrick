import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { healthSnapshotSchema } from '@patrick/contracts/resources';
import { asClientError, useScopedSnapshot, useService, useSnapshotEvents } from '../api/query.js';
import { Icon } from '../components/icons.js';
import { ServiceLogo } from '../components/ServiceLogo.js';
import { Dialog, LocalizedError, StatusEvidence } from '../components/shared.js';
import { LocaleProvider, useLocale } from '../i18n/LocaleProvider.js';
import type { LocaleMode, MessageKey } from '../i18n/locale.js';
import { ConsultationPanel } from '../features/consultation/ConsultationPanel.js';
import { CommandSession } from '../features/work/CommandSession.js';
import '../features/work/t15.css';
import { demoScope, isDemo } from './demo.js';
import { navigation, settingsNavigation } from './navigation.js';
import type { NavigationItem } from './navigation.js';

export function AppShell() {
  const { scope, accessGeneration } = useService();
  const identity = isDemo ? 'demo' : scope ? `account:${scope.account_id}` : null;
  const commandScope = JSON.stringify([scope?.account_id, scope?.data_domain, scope?.permission_epoch, accessGeneration]);
  return <LocaleProvider key={identity} account={identity}>
    <CommandSession key={commandScope}><Shell /></CommandSession>
  </LocaleProvider>;
}

function Shell() {
  const { locale, t } = useLocale();
  const { scope, accessError, signOut } = useService();
  const [drawer, setDrawer] = useState(false);
  const [consulting, setConsulting] = useState<string | null>(null);
  const [hidden, setHidden] = useState(document.hidden);
  const { pathname, search } = useLocation();
  const active = [...settingsNavigation, ...navigation].find((item) => item.path === pathname)
    ?? (pathname.startsWith('/work/') ? navigation[1] : undefined);
  const health = useScopedSnapshot('getSystemHealth', {}, healthSnapshotSchema.parse, { enabled: !isDemo, refetchInterval: 15_000, projection: true });
  const connected = useSnapshotEvents(health.data);
  const latestHealth = health.data;
  const healthError = health.error ? asClientError(health.error) : null;
  const liveHealth = !isDemo && !healthError && connected === true && latestHealth?.freshness === 'fresh'
    ? latestHealth.data : undefined;
  const healthStatus: MessageKey = healthError?.code === 'UNAVAILABLE' || connected === false ? 'status.offline'
    : liveHealth?.freshness === 'fresh' ? `status.${liveHealth.service}` : 'status.unknown';
  const lastCheck = healthStatus === 'status.offline' ? latestHealth?.as_of : undefined;

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 48rem)');
    const onWidth = () => { if (!media.matches) setDrawer(false); };
    media.addEventListener('change', onWidth);
    return () => media.removeEventListener('change', onWidth);
  }, []);

  const title = active ? t(active.label) : t('app.name');

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">{t('aria.skip')}</a>
    <aside className="desktop-sidebar"><Sidebar health={liveHealth} status={healthStatus} asOf={lastCheck} hidden={hidden} /></aside>
    {drawer && <Dialog className="mobile-drawer" title={t('aria.navigation')} onClose={() => setDrawer(false)}>
      <Sidebar health={liveHealth} status={healthStatus} asOf={lastCheck} hidden={hidden} onNavigate={() => setDrawer(false)} />
    </Dialog>}
    <div className="main-panel">
      <header className="topbar">
        <button className="icon-button drawer-toggle" type="button" onClick={() => setDrawer(true)}
          aria-expanded={drawer} aria-haspopup="dialog" aria-label={t('aria.openNavigation')}><Icon name="menu" /></button>
        <span className="crumb">{title}</span>
        <div className="topbar-actions">
          <LanguageSelect compact />
          <button type="button" onClick={() => setConsulting(pathname + search)} aria-haspopup="dialog">{t('button.consult')}</button>
          {!!scope && <button type="button" onClick={() => { void signOut(); }}>{t('button.signOut')}</button>}
        </div>
      </header>
      <main id="main-content" className="page" tabIndex={-1} lang={locale === 'zh' ? 'zh-CN' : 'en'}>
        {isDemo && <p className="demo-banner">{t('app.demo')}</p>}
        {scope && accessError && <LocalizedError code={accessError.code} />}
        <Outlet context={{ health, healthStatus }} />
      </main>
    </div>
    {consulting && <ConsultationPanel sourceRoute={consulting} returnTo={() => setConsulting(null)}
      demoDraft={isDemo ? { account: demoScope.account_id, domain: demoScope.data_domain,
        conversation: 'global-consultation', resource: 'global', version: 0, kind: 'consultation' } : undefined} />}
  </div>;
}

function Sidebar({ health, status, asOf, hidden, onNavigate }: {
  health?: ReturnType<typeof healthSnapshotSchema.parse>; status: MessageKey; asOf?: string; hidden: boolean; onNavigate?: () => void;
}) {
  const { locale, t, reducedMotion } = useLocale();
  const slogan = t('app.slogan');
  return <>
    <div className="brand">
      <ServiceLogo label={t('app.name')} health={health} reducedMotion={reducedMotion} pageVisible={!hidden} />
      <StatusEvidence status={status} asOf={asOf} announce />
      <p className="slogan">{locale === 'zh' ? <>{slogan.split('，')[0]}，<wbr />{slogan.split('，')[1]}</> : slogan}</p>
    </div>
    <nav className="navigation" aria-label={t('aria.navigation')}>
      {navigation.map((item) => <NavigationLink key={item.path} item={item} onNavigate={onNavigate} />)}
    </nav>
  </>;
}

export function NavigationLink({ item, onNavigate }: { item: NavigationItem; onNavigate?: () => void }) {
  const { t } = useLocale();
  return <NavLink to={item.path} className={item.path === '/settings' ? 'nav-link settings-link' : 'nav-link'} onClick={onNavigate}>
    <Icon name={item.icon} /><span>{t(item.label)}</span>
  </NavLink>;
}

export function LanguageSelect({ compact = false }: { compact?: boolean }) {
  const { mode, setMode, t } = useLocale();
  const choices: LocaleMode[] = ['system', 'en', 'zh'];
  return <label className="language-select">
    <span className={compact ? 'sr-only' : undefined}>{t('language.label')}</span>
    <select value={mode} onChange={(event) => setMode(event.target.value as LocaleMode)}>
      {choices.map((choice) => <option key={choice} value={choice}>{t(`language.${choice}`)}</option>)}
    </select>
  </label>;
}
