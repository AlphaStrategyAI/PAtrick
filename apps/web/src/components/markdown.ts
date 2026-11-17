export type Inline = { kind: 'text' | 'strong' | 'emphasis' | 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

function allowedLink(value: string): string | undefined {
  // Absolute HTTPS links only; no relative navigation, credentials, markup or formatting controls.
  if (!/^https:\/\//i.test(value) || /[\s<>\\]/u.test(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { return; }
}

/** Small Markdown subset; all source content becomes React text or an explicitly allowed URL. */
export function parseInlineMarkdown(source: string): Inline[] {
  const tokens: Inline[] = [];
  let offset = 0;
  for (const match of source.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|(?<!!)\[([^\]\n[]+)\]\(([^()\n]+)\)/g)) {
    if (match.index > offset) tokens.push({ kind: 'text', text: source.slice(offset, match.index) });
    const [, code, strong, emphasis, text, rawHref] = match;
    if (code) tokens.push({ kind: 'code', text: code });
    else if (strong) tokens.push({ kind: 'strong', text: strong });
    else if (emphasis) tokens.push({ kind: 'emphasis', text: emphasis });
    else {
      const href = allowedLink(rawHref);
      tokens.push(href ? { kind: 'link', text, href } : { kind: 'text', text });
    }
    offset = match.index + match[0].length;
  }
  if (offset < source.length) tokens.push({ kind: 'text', text: source.slice(offset) });
  return tokens;
}
