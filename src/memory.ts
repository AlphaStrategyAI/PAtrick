import { now, stableId, type Scope } from './domain.js';
import type { Store } from './store.js';

const block = /<patrick-memory>[\s\S]*?<\/patrick-memory>/g;

export function injectionBlock(quotes: string[]): string {
  const lines = uniqueQuotes(quotes);
  return lines.length ? `<patrick-memory>\n${lines.join('\n')}\n</patrick-memory>` : '';
}

export function rememberInjection(store: Store, scope: Scope, quotes: string[]): string {
  const fresh = uniqueQuotes(quotes);
  if (!fresh.length) return '';
  const id = stableId('memory-injection', scope.projectId, scope.domain);
  const merged = [...new Set([...injectedQuotes(store, scope), ...fresh])].slice(-30);
  store.save('cursors', { projectId: scope.projectId, domain: scope.domain, id, value: JSON.stringify({ quotes: merged }), updatedAt: now() });
  return injectionBlock(fresh);
}

export function injectedQuotes(store: Store, scope: Scope): string[] {
  const saved = store.get('cursors', stableId('memory-injection', scope.projectId, scope.domain));
  if (!saved || saved.projectId !== scope.projectId || saved.domain !== scope.domain) return [];
  try {
    const parsed = JSON.parse(saved.value) as { quotes?: unknown };
    return Array.isArray(parsed.quotes) ? uniqueQuotes(parsed.quotes.filter((quote): quote is string => typeof quote === 'string')) : [];
  } catch { return []; }
}

/** Drop a host-injected card quote only when it occupies a whole line. A sentence that merely contains it stays. */
export function stripInjectedMemory(content: string, quotes: string[]): string {
  const exact = new Set(uniqueQuotes(quotes));
  return content.replace(block, '').split('\n').filter(line => !exact.has(line.trim())).join('\n').trim();
}

function uniqueQuotes(quotes: string[]): string[] {
  return [...new Set(quotes.map(quote => quote.trim()).filter(quote => quote.length >= 2))];
}
