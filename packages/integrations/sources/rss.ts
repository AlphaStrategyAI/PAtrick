import { SaxesParser, type SaxesTagNS } from 'saxes';
import { sourceUrl } from './http-read.js';
import { htmlFragmentText } from './webpage.js';

const reader = new TextDecoder('utf-8', { fatal: true });
const atom = 'http://www.w3.org/2005/Atom';
const contentNamespace = 'http://purl.org/rss/1.0/modules/content/';
export const rssFeedMaxBytes = 2 * 1024 * 1024;
export const rssFeedMaxItems = 500;
const omitText = new Set(['script', 'style', 'template', 'iframe']);
type ItemDraft = Partial<Record<'id' | 'title' | 'link' | 'summary' | 'content' | 'published', string>>;
export type FeedItem = { key: string; title: string; link: string | null; text: string; publishedAt?: string };

export function parseFeed(bytes: Uint8Array, pageUrl: string, options: { includePublishedAt?: boolean } = {}): FeedItem[] {
  if (bytes.byteLength < 1 || bytes.byteLength > rssFeedMaxBytes) throw new Error('SOURCE_BODY_SIZE');
  const base = sourceUrl(pageUrl);
  let format: 'rss' | 'atom' | undefined;
  const stack: SaxesTagNS[] = [];
  const items = new Map<string, FeedItem>();
  let count = 0;
  let channel = false;
  let draft: ItemDraft | undefined;
  let itemDepth = 0;
  let field: { name: keyof ItemDraft; text: string[]; depth: number; invalid?: boolean } | undefined;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => { throw new Error('SOURCE_XML_DTD_DENIED'); });
  parser.on('error', () => { throw new Error('SOURCE_FEED_INVALID'); });
  parser.on('opentag', (tag) => {
    stack.push(tag);
    if (stack.length > 64) throw new Error('SOURCE_DOCUMENT_LIMIT');
    if (field?.name === 'published' && stack.length > field.depth) field.invalid = true;
    if (stack.length === 1) {
      if (!tag.uri && tag.local === 'rss') format = 'rss';
      else if (tag.uri === atom && tag.local === 'feed') format = 'atom';
      else throw new Error('SOURCE_FEED_INVALID');
    }
    if (format === 'rss' && stack.length === 2 && !tag.uri && tag.local === 'channel') channel = true;
    const isItem = format === 'atom' ? stack.length === 2 && tag.uri === atom && tag.local === 'entry'
      : stack.length === 3 && !stack[1].uri && stack[1].local === 'channel' && !tag.uri && tag.local === 'item';
    if (isItem) {
      if (++count > rssFeedMaxItems) throw new Error('SOURCE_DOCUMENT_LIMIT');
      draft = {};
      itemDepth = stack.length;
    }
    if (!draft || stack.length !== itemDepth + 1) return;
    if (format === 'atom' && tag.uri === atom && tag.local === 'link') {
      const rel = tag.attributes.rel?.value;
      if ((!rel || rel === 'alternate') && !draft.link) draft.link = tag.attributes.href?.value;
      return;
    }
    const name = fieldName(format, tag);
    if (name === 'published') {
      if (!options.includePublishedAt) return;
      if (Object.hasOwn(draft, name)) { draft.published = ''; return; }
    }
    if (name && !Object.hasOwn(draft, name)) field = { name, text: [], depth: stack.length };
  });
  function text(value: string) {
    if (field && !stack.slice(field.depth).some((entry) => omitText.has(entry.local))) field.text.push(value);
  }
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => {
    if (draft && field?.depth === stack.length) {
      draft[field.name] = field.invalid ? '' : field.text.join('').trim();
      field = undefined;
    }
    if (draft && stack.length === itemDepth) {
      const link = canonicalLink(draft.link, base);
      const id = typeof draft.id === 'string' && draft.id.length <= 1024 ? draft.id : '';
      const key = id ? 'id:' + id : link ? 'url:' + link : '';
      if (key) {
        const publishedAt = options.includePublishedAt && draft.published
          ? publicationInstant(draft.published, format) : undefined;
        const prior = items.get(key);
        if (!prior) items.set(key, {
          key, link, title: htmlFragmentText(draft.title ?? ''), text: htmlFragmentText(draft.content || draft.summary || ''),
          ...(publishedAt ? { publishedAt } : {}),
        });
        // Duplicate keys keep the first item's content; contradictory dates cannot place it in history.
        else if (prior.publishedAt !== publishedAt) delete prior.publishedAt;
      }
      draft = undefined;
    }
    stack.pop();
  });
  parser.write(reader.decode(bytes)).close();
  if (!format || (format === 'rss' && !channel)) throw new Error('SOURCE_FEED_INVALID');
  return [...items.values()];
}

function fieldName(format: 'rss' | 'atom' | undefined, tag: SaxesTagNS): keyof ItemDraft | undefined {
  if (format === 'atom' && tag.uri === atom) {
    if (tag.local === 'published') return 'published';
    if (tag.local === 'id' || tag.local === 'title' || tag.local === 'summary' || tag.local === 'content') return tag.local;
  }
  if (format !== 'rss') return;
  if (!tag.uri) {
    if (tag.local === 'guid') return 'id';
    if (tag.local === 'pubDate') return 'published';
    if (tag.local === 'link' || tag.local === 'title') return tag.local;
    if (tag.local === 'description') return 'summary';
  }
  if (tag.uri === contentNamespace && tag.local === 'encoded') return 'content';
}

function canonicalLink(raw: string | undefined, base: URL): string | null {
  try { return raw ? sourceUrl(new URL(raw, base).href).href : null; }
  catch { return null; }
}


// Only unambiguous publication fields participate in history. Never substitute build,
// update, ingestion time, a local timezone, or date parsing's component rollovers.
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function publicationInstant(text: string, format: 'rss' | 'atom' | undefined): string | undefined {
  if (format === 'atom') {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u.exec(text);
    if (!match) return;
    const [, year, month, day, hour, minute, second, fractional, zone] = match;
    return fromCivil(+year, +month, +day, +hour, +minute, +second, Number((fractional ?? '').padEnd(3, '0')), zone);
  }
  if (format !== 'rss') return;
  const match = /^(?:(Sun|Mon|Tue|Wed|Thu|Fri|Sat), )?(\d{1,2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2})(?::(\d{2}))? (GMT|UT|UTC|[+-]\d{4})$/u.exec(text);
  if (!match) return;
  const [, weekday, day, month, year, hour, minute, second, zone] = match;
  return fromCivil(+year, months.indexOf(month) + 1, +day, +hour, +minute, +(second ?? 0), 0, zone, weekday);
}

function fromCivil(
  year: number, month: number, day: number, hour: number, minute: number, second: number,
  millisecond: number, zone: string, weekday?: string,
): string | undefined {
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return;
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  if (local.getUTCDate() !== day || (weekday && weekdays[local.getUTCDay()] !== weekday)) return;
  const offset = /^(?:GMT|UT|UTC|Z)$/u.test(zone) ? '+0000' : zone.replace(':', '');
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(3));
  if (offset === '-0000' || hours > 23 || minutes > 59) return;
  const iso = new Date(local.getTime() - (offset.startsWith('-') ? -1 : 1) * (hours * 60 + minutes) * 60_000).toISOString();
  return iso.length === 24 ? iso : undefined;
}
