import { expect, it } from 'vitest';
import { sourceCoverage } from '../../src/readiness.js';

it('keeps channels without an automatic entry uncovered even when the project and Feishu are configured', () => {
  const items = sourceCoverage({ sourceDir: '/tmp/productIdeas' }, true);
  const uncovered = items.filter(item => item.state === 'uncovered').map(item => item.name);
  expect(uncovered).toEqual(['公众号', '个人微信', '第三方 Grok']);
  expect(items.filter(item => item.state === 'uncovered').every(item => item.detail.includes('不增加转发、贴标签或导出'))).toBe(true);
  expect(items.map(item => item.name)).not.toEqual(expect.arrayContaining(['转发', '贴标签', '导出']));
  expect(items.find(item => item.name === '飞书')?.state).toBe('ready');
});
