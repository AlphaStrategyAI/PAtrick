import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { expect, test, vi } from 'vitest';
import en from '../../apps/web/src/i18n/en.json';
import zh from '../../apps/web/src/i18n/zh.json';
import { ChangeReceipt } from '../../apps/web/src/features/settings/SettingsGroup.js';

const ui = vi.hoisted(() => ({ locale: 'en' as 'en' | 'zh', effects: [] as { item: string; outcome: string; revision: number | null }[],
  recovery: undefined as unknown }));
const id = 'settings_12345678-1234-1234-1234-123456789abc';
const question = '12345678-1234-1234-1234-123456789abc';
vi.mock('../../apps/web/src/i18n/LocaleProvider.js', () => ({
  useLocale: () => ({ locale: ui.locale, t: (key: keyof typeof en) => (ui.locale === 'en' ? en : zh)[key] }),
}));
vi.mock('../../apps/web/src/api/query.js', () => ({
  asClientError: () => ({ code: 'UNAVAILABLE' }),
  useScopedSnapshot: (operation: string) => operation === 'getSettingsRecovery' ? { data: { data: ui.recovery } } : ({ data: { data: { change_id: 'settings_12345678-1234-1234-1234-123456789abc',
    operation: 'repair_network', verified: false, phase: 'observed', applied_revision: 1,
    checked_at: '2026-11-17T07:00:00.000Z', effects: ui.effects } } }),
}));
vi.mock('../../apps/web/src/features/settings/SettingsChangeWizard.js', () => ({
  SettingsChangeWizard: ({ operation, recoveryChangeId }: { operation: string; recoveryChangeId: string }) =>
    createElement('button', { 'data-operation': operation, 'data-change': recoveryChangeId }, 'Recovery wizard'),
}));

test.each([
  ['needs_login', 'Sign in to the registered target', '登录已登记目标'],
  ['mfa_required', 'Complete MFA in the target app', '在目标应用中完成多重验证'],
  ['needs_permission', 'Host permission is required', '需要主机权限'],
  ['rate_limited', 'Wait before checking again', '请等待后再检查'],
  ['unavailable', 'This registered repair is unavailable or incompatible', '此登记修复不可用或不兼容'],
] as const)('settings and System localize actionable network state %s from the same receipt', (state, english, chinese) => {
  for (const locale of ['en', 'zh'] as const) {
    ui.recovery = undefined;
    ui.locale = locale;
    ui.effects = [{ item: 'network:' + state, outcome: 'blocked', revision: 1 },
      { item: 'network:verify:work:proxy', outcome: 'blocked', revision: 1 },
      { item: 'network:operation:internal-proposal', outcome: 'unchanged', revision: 1 }];
    if (state === 'mfa_required') ui.effects.push({ item: 'network:question:' + question, outcome: 'blocked', revision: 1 });
    if (state === 'rate_limited') ui.effects.push({ item: 'network:retry_at:1794898860000', outcome: 'blocked', revision: 1 });
    for (const system of [false, true]) {
      const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/system?change=' + id] },
        createElement(ChangeReceipt, { system })));
      expect(html).toContain(locale === 'en' ? english : chinese);
      expect(html).toContain('work');
      expect(html).toContain(locale === 'en' ? 'Proxy path failed' : '代理路径失败');
      expect(html).toContain(id);
      expect(html).not.toContain('internal-proposal');
      if (state === 'mfa_required') {
        expect(html).toContain('/settings/operation?network_question=' + question);
        expect(html).toContain(locale === 'en' ? 'After completing MFA, check again' : '完成多重验证后重新检查');
      }
      if (state === 'rate_limited') expect(html).toContain(locale === 'en' ? 'Retry after' : '可重试时间');
    }
  }
});

test.each([false, true])('the original interrupted receipt exposes fixed read-only recovery in System=%s', (system) => {
  ui.locale = 'en';
  ui.effects = [{ item: 'network:unresolved', outcome: 'uncertain', revision: 1 }];
  ui.recovery = { change_id: id, status: 'readback_available', action: 'reconcile_network',
    target: { target: 'fixture-mac', device: 'fixture-mac', revision: 1, label: 'work / fixed-dns', input: { change_id: id } } };
  const render = () => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/system?change=' + id] },
    createElement(ChangeReceipt, { system })));
  expect(render()).toContain('Check interrupted network change');
  expect(render()).toContain('data-operation="reconcile_network"');
  expect(render()).toContain('data-change="' + id + '"');
  ui.recovery = { change_id: id, status: 'unavailable', reason: 'network_effect_unsettled' };
  expect(render()).toContain('An effect may still be running. The device remains locked.');
  expect(render()).not.toContain('Recovery wizard');
});
