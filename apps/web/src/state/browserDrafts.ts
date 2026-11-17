import { getLocalStorage } from './browserStorage.js';
import { DraftStore } from './drafts.js';

export const browserDrafts = new DraftStore(getLocalStorage());
