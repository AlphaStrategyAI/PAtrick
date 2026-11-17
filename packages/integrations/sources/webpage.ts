import { createHash } from 'node:crypto';
import { parse, parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

const ignored = new Set(['style', 'script', 'template', 'nav', 'header', 'footer', 'aside', 'noscript', 'svg', 'iframe', 'form']);
const blocks = new Set(['article', 'main', 'section', 'div', 'p', 'blockquote', 'pre', 'li', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr']);
const utf8 = new TextDecoder('utf-8', { fatal: true });
const maxBytes = 2 * 1024 * 1024;
const maxNodes = 100_000;

export function extractPage(bytes: Uint8Array) {
  if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) throw new Error('SOURCE_BODY_SIZE');
  const html = utf8.decode(bytes);
  const tree = parse(html, { scriptingEnabled: false });
  let title = '';
  let body: Element | undefined;
  let main: Element | undefined;
  let article: Element | undefined;
  let count = 0;
  const stack: Node[] = [tree];
  while (stack.length) {
    if (++count > maxNodes) throw new Error('SOURCE_DOCUMENT_LIMIT');
    const node = stack.pop()!;
    if ('tagName' in node) {
      if (node.tagName === 'input' && attr(node, 'type')?.trim().toLowerCase() === 'password') throw new Error('SOURCE_REQUIRES_LOGIN');
      if (node.tagName === 'meta' && attr(node, 'http-equiv')?.trim().toLowerCase() === 'refresh') throw new Error('SOURCE_HTML_REDIRECT');
      if (node.tagName === 'title' && !title) title = readableText(node);
      if (node.tagName === 'body') body = node;
      if (node.tagName === 'main' && !main) main = node;
      if (node.tagName === 'article' && !article) article = node;
    }
    if ('childNodes' in node) for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push(node.childNodes[index]);
  }
  const focus = main ?? article ?? body;
  const text = focus ? readableText(focus) : '';
  if (!text) throw new Error('SOURCE_CONTENT_EMPTY');
  return { title, text, contentHash: sha256(text), responseHash: sha256(bytes) };
}

export function htmlFragmentText(html: string): string {
  return readableText(parseFragment(html, { scriptingEnabled: false }));
}

function readableText(root: Node): string {
  const chunks: string[] = [];
  const stack: (Node | null)[] = [root];
  let count = 0;
  while (stack.length) {
    if (++count > maxNodes * 2) throw new Error('SOURCE_DOCUMENT_LIMIT');
    const node = stack.pop()!;
    if (!node) { chunks.push('\n'); continue; }
    if ('value' in node) { chunks.push(node.value.replace(/\s+/gu, ' ')); continue; }
    if (!('childNodes' in node)) continue;
    if ('tagName' in node) {
      if (ignored.has(node.tagName) || attr(node, 'aria-hidden') === 'true' || attr(node, 'hidden') !== undefined) continue;
      if (blocks.has(node.tagName)) { chunks.push('\n'); stack.push(null); }
    }
    for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push(node.childNodes[index]);
  }
  return chunks.join('').split('\n').map((line) => line.replace(/\s+/gu, ' ').trim()).filter(Boolean).join('\n');
}

function attr(node: Element, name: string): string | undefined {
  return node.attrs.find((item) => item.name === name)?.value;
}
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
