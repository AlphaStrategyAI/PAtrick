export type DraftKey = {
  account: string;
  domain: string;
  conversation: string;
  resource: string;
  version: number;
  kind: 'decision' | 'consultation' | 'message' | 'settings-notes';
};

type DraftStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
const prefix = 'patrick:private-draft:v1:';

function accountPrefix(account: string): string {
  return `${prefix}${encodeURIComponent(account)}:`;
}

function storageKey(key: DraftKey): string {
  if (!['decision', 'consultation', 'message', 'settings-notes'].includes(key.kind)) throw new TypeError('Unsupported draft kind');
  return accountPrefix(key.account) + JSON.stringify([key.domain, key.conversation, key.resource, key.version, key.kind]);
}

/** Store authored drafts only. Credentials and connection form values must stay in form memory. */
export class DraftStore {
  private readonly memory = new Map<string, string | null>();

  constructor(private readonly storage: DraftStorage | undefined) {}

  read(key: DraftKey): string | null {
    const id = storageKey(key);
    if (this.memory.has(id)) return this.memory.get(id) ?? null;
    try { return this.storage?.getItem(id) ?? null; } catch { return null; }
  }

  write(key: DraftKey, text: string): boolean {
    const id = storageKey(key);
    this.memory.set(id, text || null);
    try {
      if (!this.storage) return false;
      if (text) this.storage.setItem(id, text);
      else this.storage.removeItem(id);
      this.memory.delete(id);
      return true;
    } catch { return false; }
  }

  clearAccount(account: string): void {
    const start = accountPrefix(account);
    for (const key of this.memory.keys()) if (key.startsWith(start)) this.memory.delete(key);
    try {
      if (!this.storage) return;
      for (let i = this.storage.length - 1; i >= 0; i--) {
        const key = this.storage.key(i);
        if (key?.startsWith(start)) this.storage.removeItem(key);
      }
    } catch { /* Storage may be unavailable in this browser session. */ }
  }
}
