import { expect, it } from 'vitest';
import { sourceCoverage } from '../../src/readiness.js';

it('keeps channels without an automatic entry uncovered even when the project and Feishu are configured', () => {
  const items = sourceCoverage({ sourceDir: '/tmp/productIdeas' }, true);
  const uncovered = items.filter(item => item.state === 'uncovered').map(item => item.name);
  expect(uncovered).toEqual(['公众号', '个人微信', '第三方 Grok']);
  expect(items.filter(item => item.state === 'uncovered').every(item => item.detail.includes('不增加转发、贴标签或导出'))).toBe(true);
  expect(items.map(item => item.name)).not.toEqual(expect.arrayContaining(['转发', '贴标签', '导出']));
  expect(items.find(item => item.name === '飞书')?.state).toBe('ready');
  expect(items.filter(item => item.state === 'unconnected').map(item => item.name)).toEqual(['GitHub 远端分支', 'X 书签', '邮箱', 'Grok Bot']);
  expect(items.filter(item => item.state === 'unconnected').every(item => item.detail.includes('还没有接入') && item.detail.includes('不能算已覆盖'))).toBe(true);
  const scanned = sourceCoverage({ sourceDir: '/tmp/productIdeas' }, true, true);
  expect(scanned.find(item => item.name === 'GitHub 远端分支')?.state).toBe('ready');
  expect(scanned.filter(item => item.state === 'unconnected').map(item => item.name)).toEqual(['X 书签', '邮箱', 'Grok Bot']);
  expect(sourceCoverage({ sourceDir: '/tmp/productIdeas' }, true, { xBookmarks: true }).find(item => item.name === 'X 书签')?.state).toBe('ready');
  expect(sourceCoverage({ sourceDir: '/tmp/productIdeas' }, true, { gmail: true }).find(item => item.name === '邮箱')?.state).toBe('ready');
});
