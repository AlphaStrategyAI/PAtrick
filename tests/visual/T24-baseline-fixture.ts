/// <reference lib="dom" />
import { createHash } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

export const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function measureSettings(page: Page) {
  return page.evaluate(() => {
    const select = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error('Missing settings landmark ' + selector);
      return element.getBoundingClientRect();
    };
    const grid = '.settings-grid a';
    const links = [...document.querySelectorAll<HTMLAnchorElement>(grid)];
    const edges: Record<string, number> = {
      sidebarRight: select('.desktop-sidebar').right,
      headerBottom: select('.topbar').bottom,
      headingLeft: select('main h1').left,
    };
    for (const a of links) {
      const name = a.pathname.split('/').at(-1)!;
      const { left, right, top, bottom } = a.getBoundingClientRect();
      if (left < 0 || top < 0 || right > innerWidth || bottom > innerHeight ||
          !a.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2))) {
        throw new Error('Settings link clipped or covered: ' + name);
      }
      Object.assign(edges, { [name + 'Left']: left, [name + 'Right']: right, [name + 'Top']: top, [name + 'Bottom']: bottom });
    }
    const categories = links.map(a => {
      const labelledBy = a.getAttribute('aria-labelledby');
      if (labelledBy === null) return { path: a.pathname, label: a.innerText };
      const label = labelledBy.trim().split(/\s+/u).map(id => {
        const source = document.getElementById(id);
        if (!source) throw new Error('Missing Settings link label ' + id);
        return source.innerText.trim();
      }).join(' ');
      return { path: a.pathname, label };
    });
    return { edges, links: categories, clock: new Date().toISOString(),
      width: innerWidth, height: innerHeight, dpr: devicePixelRatio, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      htmlLang: document.documentElement.lang, light: matchMedia('(prefers-color-scheme: light)').matches,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, logoRunners: document.querySelectorAll('.logo-runner').length };
  });
}

export function edgeDeltas(actual: Record<string, number>, reference: Record<string, number>) {
  const deltas: Record<string, number> = {};
  for (const [key, expected] of Object.entries(reference)) {
    expect(Number.isFinite(actual[key]), 'measured ' + key).toBe(true);
    deltas[key] = actual[key]! - expected;
  }
  return deltas;
}

// Compare decoded sRGB RGBA at every viewport pixel (including antialiasing and text).
export async function pixelDiff(page: Page, actual: Buffer, reference: Buffer) {
  return page.evaluate(async ([left, right]) => {
    async function pixels(base64: string) {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, image.width, image.height).data;
      image.close();
      return { data: new Uint32Array(data.buffer), width: canvas.width, height: canvas.height };
    }
    const [a, b] = await Promise.all([pixels(left), pixels(right)]);
    if (a.width !== b.width || a.height !== b.height) throw new Error('Incompatible baseline dimensions');
    let changed = 0;
    for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) changed++;
    return { changed, total: a.data.length, ratio: changed / a.data.length };
  }, [actual.toString('base64'), reference.toString('base64')] as const);
}
