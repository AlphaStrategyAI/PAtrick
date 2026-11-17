import { expect, test } from 'vitest';
import { parseFeed } from '../../packages/integrations/sources/rss.js';
import { extractPage } from '../../packages/integrations/sources/webpage.js';

const source = 'https://news.example.test/feed';
const utf8 = (text: string) => new TextEncoder().encode(text);

test('feed uses the first canonical item once and emits only inert text', () => {
  const feed = utf8(`<?xml version="1.0"?><rss version="2.0"><channel><title>Start</title>
    <item><guid>first</guid><title>Evidence A</title><link>/posts/1#section</link>
      <description><![CDATA[<p>Read <b>the report</b>.</p><script>steal()</script>]]></description></item>
    <item><guid>first</guid><title>Duplicate copy</title><link>/posts/1?utm_source=feed</link></item>
    <item><title>Another article</title><link>/posts/2#start</link></item>
  </channel></rss>`);
  expect(parseFeed(feed, source)).toEqual([
    { key: 'id:first', title: 'Evidence A', link: 'https://news.example.test/posts/1', text: 'Read the report.' },
    { key: 'url:https://news.example.test/posts/2', title: 'Another article', link: 'https://news.example.test/posts/2', text: '' },
  ]);
});

test('Atom only uses alternate links and rejects links with credentials', () => {
  const feed = utf8(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>urn:one</id><title>中文</title>
    <link rel="enclosure" href="/media"/><link href="/story"/><content>正文</content></entry>
    <entry><id>urn:two</id><link href="https://user:secret-fixture@news.example.test/story"/></entry></feed>`);
  expect(parseFeed(feed, source)).toEqual([
    { key: 'id:urn:one', title: '中文', link: 'https://news.example.test/story', text: '正文' },
    { key: 'id:urn:two', title: '', link: null, text: '' },
  ]);
});

test.each([
  '<!DOCTYPE rss [<!ENTITY x "inline">]><rss><channel><item><guid>a</guid><title>&x;</title></item></channel></rss>',
  '<!DOCTYPE rss SYSTEM "https://other.example.test/external"><rss><channel/></rss>',
])('rejects DTDs without expanding entities', (feed) => {
  expect(() => parseFeed(utf8(feed), source)).toThrow('SOURCE_XML_DTD_DENIED');
});

test('page fingerprints visible main content; navigation and scripted content never become evidence', () => {
  const first = extractPage(utf8('<title>Evidence</title><nav>Old navigation</nav><main><h1>标题</h1><p>Evidence &amp; source.</p><script>steal()</script></main>'));
  const second = extractPage(utf8('<title>Evidence</title><nav>Changed navigation</nav><main><h1>标题</h1><p>Evidence &amp; source.</p></main>'));
  expect(first).toMatchObject({ title: 'Evidence', text: '标题\nEvidence & source.' });
  expect(first.contentHash).toBe(second.contentHash);
  expect(first.responseHash).not.toBe(second.responseHash);
});

test('login forms and HTML redirects do not produce webpage content', () => {
  expect(() => extractPage(utf8('<body><main><form><input type = "PASSWORD"></form><p>Please sign in.</p></main>'))).toThrow('SOURCE_REQUIRES_LOGIN');
  expect(() => extractPage(utf8('<meta http-equiv="Refresh" content="0;url=/login"><main>Redirect</main>'))).toThrow('SOURCE_HTML_REDIRECT');
});
