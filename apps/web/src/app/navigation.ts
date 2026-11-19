import type { MessageKey } from '../i18n/locale.js';

export type NavigationItem = { path: string; label: MessageKey; summary: MessageKey; icon: string };
export const navigation = [
  { path: '/decisions', label: 'nav.decisions', summary: 'summary.decisions', icon: 'decisions' },
  { path: '/work', label: 'nav.work', summary: 'summary.work', icon: 'work' },
  { path: '/standards', label: 'nav.standards', summary: 'summary.standards', icon: 'standards' },
  { path: '/knowledge', label: 'nav.knowledge', summary: 'summary.knowledge', icon: 'knowledge' },
  { path: '/delegations', label: 'nav.delegations', summary: 'summary.delegations', icon: 'delegations' },
  { path: '/system', label: 'nav.system', summary: 'summary.system', icon: 'system' },
  { path: '/stats', label: 'nav.stats', summary: 'summary.stats', icon: 'stats' },
  { path: '/settings', label: 'nav.settings', summary: 'summary.settingsHome', icon: 'settings' },
] as const satisfies readonly NavigationItem[];

export const settingsNavigation = [
  { path: '/settings/collection', label: 'settings.collection', description: 'settings.description.collection', summary: 'summary.settings', icon: 'settings-collection' },
  { path: '/settings/materials', label: 'settings.materials', description: 'settings.description.materials', summary: 'summary.settings', icon: 'settings-materials' },
  { path: '/settings/execution', label: 'settings.execution', description: 'settings.description.execution', summary: 'summary.settings', icon: 'settings-execution' },
  { path: '/settings/operation', label: 'settings.operation', description: 'settings.description.operation', summary: 'summary.settings', icon: 'settings-operation' },
  { path: '/settings/interaction', label: 'settings.interaction', description: 'settings.description.interaction', summary: 'summary.settings', icon: 'settings-interaction' },
  { path: '/settings/preferences', label: 'settings.preferences', description: 'settings.description.preferences', summary: 'summary.preferences', icon: 'settings-preferences' },
] as const satisfies readonly (NavigationItem & { description: MessageKey })[];

export const workDetailPath = '/work/:id';
