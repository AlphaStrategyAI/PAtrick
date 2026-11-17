import type { Locale } from '../i18n/locale.js';

export type Presentation = {
  locale: Locale;
  presentation_epoch: number;
  businessRevision: number;
  original: string | null;
  display: string;
};

export function createPresentation(locale: Locale, businessRevision: number): Presentation {
  return { locale, presentation_epoch: 0, businessRevision, original: null, display: '' };
}

export function switchPresentation(state: Presentation, locale: Locale): Presentation {
  return locale === state.locale ? state : {
    ...state, locale, presentation_epoch: state.presentation_epoch + 1, display: '',
  };
}

export function addDisplayFragment(state: Presentation, epoch: number, fragment: string): Presentation {
  return epoch === state.presentation_epoch ? { ...state, display: state.display + fragment } : state;
}

export function keepOriginal(state: Presentation, original: string): Presentation {
  return { ...state, original };
}
