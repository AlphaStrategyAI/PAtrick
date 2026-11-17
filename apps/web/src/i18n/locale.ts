import en from './en.json';
import zh from './zh.json';

export { en, zh };
export type Locale = 'en' | 'zh';
export type LocaleMode = 'system' | Locale;
export type MessageKey = keyof typeof en;
const messages: Record<Locale, Record<MessageKey, string>> = { en, zh };

export function isLocaleMode(value: unknown): value is LocaleMode {
  return value === 'system' || value === 'en' || value === 'zh';
}

export function browserLanguages(source: { languages?: readonly string[]; language?: string }): readonly string[] {
  return source.languages?.length ? source.languages : source.language ? [source.language] : [];
}

export function resolveLocale(mode: LocaleMode, languages: readonly string[]): Locale {
  if (mode !== 'system') return mode;
  for (const language of languages) {
    const primary = language.toLowerCase().split('-')[0];
    if (primary === 'en' || primary === 'zh') return primary;
  }
  return 'en';
}

export function message(locale: Locale, key: MessageKey): string {
  return messages[locale][key];
}

export function errorMessage(locale: Locale, code: string): string {
  const key = `error.${code}` as MessageKey;
  return message(locale, Object.hasOwn(en, key) ? key : 'error.unknown');
}

export function formatDate(locale: Locale, value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : message(locale, 'status.unknown');
}
