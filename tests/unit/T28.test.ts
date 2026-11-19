import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const designAssets = 'docs/designs/设计资产/v2/';
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const readme = (path: string) => existsSync(resolve(root, path)) ? read(path) : '';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const trackedDesign = JSON.parse(read(designAssets + 'Figma交付记录.json')) as {
  exports: { asset: string; sha256: string }[];
};
const baseline = 'fixtures/screens/baselines/';
const screenManifest = 'fixtures/screens/screen-manifest.json';
const settingsManifest = 'fixtures/screens/visual-environment.json';
const runtime = JSON.parse(read(screenManifest)) as {
  kind: string;
  screens: {
    frame_id: string;
    key: string;
    route: string;
    locale: string;
    scenario: string;
    baseline_asset: string;
    baseline_sha256: string;
    design_comparison: string;
  }[];
};
const settingsRuntime = JSON.parse(read(settingsManifest)) as {
  route: string;
  frames: Record<'en' | 'zh', { id: string; asset: string; baselineSha256: string }>;
};
const runtimeHashes = new Map([
  ...runtime.screens.map(screen => [screen.baseline_asset, screen.baseline_sha256] as const),
  ...Object.values(settingsRuntime.frames).map(frame => [frame.asset, frame.baselineSha256] as const),
]);
const designImage = (locale: string, name: string) => designAssets + `Figma-${locale}-${name}.png`;
const packageScripts = (path: string) => JSON.parse(read(path)).scripts as Record<string, string>;
const nav = ['decisions', 'work', 'standards', 'knowledge', 'delegations', 'system', 'stats'];
const settings = ['collection', 'materials', 'execution', 'operation', 'interaction', 'preferences'];

const fixtures = [
  {
    locale: 'en',
    customDecision: 'Custom decision',
    file: 'README.md',
    other: 'README.zh-CN.md',
    headings: ['What it is for', 'How a piece of work moves', 'The workbench', 'Knowledge and standards',
      'Settings', 'Install and run', 'Repository map', 'This version does not', 'License'],
    workbench: ['conversation', 'ongoing', 'standards', 'knowledge', 'delegation', 'system', 'stats']
      .map(name => designImage('en', name)),
    settingsCaption: 'T24 runtime reference',
    workImage: 'ongoing-updated',
  },
  {
    locale: 'zh',
    customDecision: '自定义决定',
    file: 'README.zh-CN.md',
    other: 'README.md',
    headings: ['适合做什么', '一项工作如何推进', '工作台', '知识与标准', '设置', '安装与运行', '仓库结构', '本版不做', '许可证'],
    workbench: [
      designImage('zh', 'conversation'), designImage('zh', 'ongoing'), designImage('zh', 'edit-standard-adopted'),
      baseline + 'zh-knowledge.png', baseline + 'zh-delegation.png', baseline + 'zh-system.png', designImage('zh', 'stats'),
    ],
    settingsCaption: 'T24 运行界面参考',
    workImage: 'ongoing-updated',
  },
] as const;

const shellBlocks = /^\x60\x60\x60(?:bash|sh)\n([\s\S]*?)^\x60\x60\x60\s*$/gm;

function targets(markdown: string) {
  return [...markdown.matchAll(/(!?)\[([^\]\n]*)\]\(([^\s)]+)\)/g)].map(([, image, caption, file]) => ({
    image: image === '!', caption, file,
  }));
}

function sections(markdown: string, level: 2 | 3) {
  const marker = '#'.repeat(level) + ' ';
  return markdown.split('\n' + marker).slice(1).map(section => {
    const newline = section.indexOf('\n');
    return { title: section.slice(0, newline), body: section.slice(newline + 1) };
  });
}

function pngOrSvg(path: string) {
  if (path.endsWith('.svg')) return /^<svg[\s>]/.test(read(path));
  if (!path.endsWith('.png')) return false;
  const bytes = readFileSync(resolve(root, path));
  const asset = trackedDesign.exports.find(row => designAssets + row.asset === path);
  const expected = runtimeHashes.get(path) ?? asset?.sha256;
  return bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' &&
    bytes.subarray(-8).toString('hex') === '49454e44ae426082' &&
    expected !== undefined && hash(bytes) === expected;
}

for (const fixture of fixtures) {
  it(`${fixture.file} follows the localized section order and links the other language above it`, () => {
    const markdown = readme(fixture.file);
    expect(markdown, fixture.file + ' is missing').not.toBe('');
    expect(markdown.split('\n')[0]).toBe('# PAtrick');
    expect(sections(markdown, 2).map(section => section.title)).toEqual(fixture.headings);
    const hero = markdown.split('\n## ')[0];
    expect(targets(hero)).toEqual(expect.arrayContaining([
      expect.objectContaining({ image: false, file: fixture.other }),
      expect.objectContaining({ image: true, file: designAssets + 'logo-still.svg' }),
    ]));
  });

  it(`${fixture.file} uses the UI labels and the matching runtime or design image for each page`, () => {
    const messages = JSON.parse(read(`apps/web/src/i18n/${fixture.locale}.json`)) as Record<string, string>;
    const document = sections(readme(fixture.file), 2);
    const pages = sections(document[2]?.body ?? '', 3);
    expect(read('apps/web/src/features/work/messages.tsx')).toContain("custom: '" + fixture.customDecision + "'");
    expect(document[0]?.body).toContain('**' + fixture.customDecision + '**');
    expect(pages.map(page => page.title)).toEqual(nav.map(key => messages['nav.' + key]));
    for (const [index, page] of pages.entries()) {
      expect(targets(page.body)).toContainEqual(expect.objectContaining({
        image: true, file: fixture.workbench[index],
      }));
    }
    for (const key of settings) expect(document[4]?.body).toContain(`**${messages['settings.' + key]}**`);
    expect(document[4]?.body).toContain(fixture.settingsCaption);
    const expectedSettings = baseline + fixture.locale + '-settings-overview.png';
    expect(settingsRuntime.route).toBe('/settings');
    expect(settingsRuntime.frames[fixture.locale].asset).toBe(expectedSettings);
    const topicImages = [
      designImage(fixture.locale, fixture.workImage),
      designImage(fixture.locale, 'edit-standard-adopted'),
      expectedSettings,
    ];
    for (const [index, section] of [document[1], document[3], document[4]].entries()) {
      expect(targets(section?.body ?? '')).toContainEqual(expect.objectContaining({
        image: true, file: topicImages[index],
      }));
    }
  });

  it(`${fixture.file} keeps every image and local link readable inside the checkout`, () => {
    const links = targets(readme(fixture.file));
    expect(links.length).toBeGreaterThan(10);
    for (const { image, caption, file } of links) {
      expect(caption.trim(), file).not.toBe('');
      if (!image && file.startsWith('https://')) continue;
      const path = decodeURIComponent(file.split('#')[0]);
      const fullPath = resolve(root, path);
      expect(isAbsolute(path) || relative(root, fullPath).startsWith('..' + sep), file).toBe(false);
      expect(existsSync(fullPath), file).toBe(true);
      const physical = relative(root, realpathSync(fullPath));
      expect(physical === '..' || physical.startsWith('..' + sep), file).toBe(false);
      if (image) {
        expect(statSync(fullPath).isFile(), file).toBe(true);
        expect(pngOrSvg(path), file).toBe(true);
      }
    }
  });

  it(`${fixture.file} lists real npm entry points, repository roots, and the restored license`, () => {
    const document = sections(readme(fixture.file), 2);
    const commands = [...(document[5]?.body ?? '').matchAll(shellBlocks)]
      .flatMap(([, block]) => block.trim().split('\n'));
    expect(commands).toEqual([
      'npm ci', 'npm run dev:demo -w @patrick/web', 'npm run lint', 'npm run typecheck', 'npm run test:unit',
    ]);
    expect(read('.github/workflows/ci.yml')).toContain('run: npm ci');
    expect(existsSync(resolve(root, 'package-lock.json'))).toBe(true);
    const manifests = new Map([
      ['root', packageScripts('package.json')], ['@patrick/web', packageScripts('apps/web/package.json')],
    ]);
    for (const command of commands.slice(1)) {
      const [, script, workspace = 'root'] = /^npm run ([\w:-]+)(?: -w ([\w@/-]+))?$/.exec(command) ?? [];
      expect(manifests.get(workspace)?.[script], command).toBeTruthy();
    }
    const map = targets(document[6]?.body ?? '').map(link => link.file.replace(/\/$/, ''));
    expect(map).toEqual([
      'apps/web', 'apps/service', 'packages/contracts', 'packages/domain', 'packages/storage',
      'packages/integrations', 'packages/executor', 'packages/host', 'docs/designs',
    ]);
    expect(targets(document[8]?.body ?? '')).toContainEqual(expect.objectContaining({ image: false, file: 'LICENSE' }));
  });
}

it('matches each Chinese runtime reference to its T24 route, state, and caption', () => {
  expect(runtime.kind).toBe('runtime-reference');
  const markdown = readme('README.zh-CN.md');
  const pages = sections(sections(markdown, 2)[2]?.body ?? '', 3);
  const expected = [
    { index: 3, key: 'zh-knowledge', route: '/knowledge', frame: '26:1617',
      scenario: 'no-knowledge-in-current-scope', caption: '知识空状态' },
    { index: 4, key: 'zh-delegation', route: '/delegations', frame: '26:1829',
      scenario: 'no-delegated-work-in-current-scope', caption: '委托空状态' },
    { index: 5, key: 'zh-system', route: '/system', frame: '26:2046',
      scenario: 'disconnected-event-stream-with-readable-diagnostics', caption: '事件流断开' },
  ];
  for (const { index, key, route, frame, scenario, caption } of expected) {
    expect(runtime.screens.filter(screen => screen.key === key)).toEqual([expect.objectContaining({
      frame_id: frame, route, locale: 'zh-CN', scenario, baseline_asset: baseline + key + '.png',
      design_comparison: 'export_unavailable',
    })]);
    expect(pages[index]?.body).toContain('T24 运行界面参考');
    expect(pages[index]?.body).toContain(caption);
  }
});

it.each([
  {
    file: 'README.md',
    system: 'Review service health, notifications, change receipts, and a scoped diagnostic preview. Running the checks reports the status of the network, the three executors, the collection sources, the recovery gate and the host with its backup targets.',
    settings: [
      'add RSS feeds and web pages', 'already registered Obsidian Vault connection',
      'runs a check of the three backends',
      'registration and targets for host, network repair, backup, and restore actions',
      'a sample test preview', 'language and reduced motion',
      'Re-pairing an existing connection goes through a trusted change',
    ],
    pending: [
      'Adding GitHub and local-directory sources in Settings', 'work-directory editor',
      'notification preferences', 'native Feishu round trip',
    ],
  },
  {
    file: 'README.zh-CN.md',
    system: '查看服务状态、通知、变更回执以及当前范围的诊断预览。运行检查会分别给出网络、三个执行器、采集来源、恢复门禁以及主机与备份目标的状态。',
    settings: [
      '新增 RSS 订阅和网页', '已登记的 Obsidian 资料库连接', '运行三个后端的检查',
      '主机检查、网络修复、备份与恢复操作的登记状态和目标', '样例测试预览', '语言和减少动效',
      '已有连接重新配对要走可信变更',
    ],
    pending: [
      '设置中新增 GitHub 和本地目录来源', '工作目录编辑器',
      '通知偏好', '飞书原生往返',
    ],
  },
])('$file describes the current System and Settings capabilities and pending controls', ({ file, system, settings, pending }) => {
  const document = sections(readme(file), 2);
  const pages = sections(document[2]?.body ?? '', 3);
  expect.soft(pages[5]?.body).toContain(system);
  for (const text of settings) expect.soft(document[4]?.body).toContain(text);
  for (const text of pending) expect.soft(document[7]?.body).toContain(text);
});

it('ties the documented Settings limits to the current operation and UI entry points', () => {
  const collection = read('apps/web/src/features/collection/CollectionPage.tsx');
  expect(collection).toContain("useState<'rss' | 'webpage'>('rss')");
  expect(collection).toContain('<option value="rss">');
  expect(collection).toContain('<option value="webpage">');
  const builtin = read('apps/service/src/settings/builtin.ts');
  expect(builtin).toContain('connect_vault: existingVault');
  expect(builtin).not.toContain('inspect_executor:');
  expect(builtin).not.toContain('inspect_host:');
  const preferences = read('apps/web/src/features/settings/AccountPreferences.tsx');
  expect(preferences).toContain('changes: { mode, reduced_motion: reducedMotion }');
  expect(read('apps/web/src/features/settings/FeishuSetup.tsx')).toContain('disabled={busy || !transportAvailable}');
});

it('restores the original MIT license and copyright notice byte-for-byte', () => {
  expect(existsSync(resolve(root, 'LICENSE'))).toBe(true);
  expect(hash(readFileSync(resolve(root, 'LICENSE')))).toBe('0436bb31a7b7572c9ba463620a464784d084b5047cc4eece8b9645d5a2e6da8f');
});
