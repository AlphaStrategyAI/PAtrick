// Declaration of the release evidence to collect for the plan in
// docs/plans/PAtrick技术实现计划.md §8.3 and §8.4.
//
// Every scenario names the command that produces the observation. A scenario is
// `passed` only when its command exits zero. A scenario whose prerequisite is
// missing is `blocked` or `pending` instead of `passed`: the prerequisite is
// machine-checked, so the classification cannot drift away from reality.

/** Product and technical design clauses from §8.4, with the tasks that cover them. */
export const productCoverage = [
  {
    id: 'C1',
    clauses: '产品§1、§4；技术§3、§4',
    acceptance: 'T07 冻结 r8 后收录 r9，旧报告只能留档；T25 实际反馈进入原案例，完成当前/候选/外部方法对照、影子及一个退化或样本不足样本；T26 按完整分母报告成果和人工投入',
    tasks: ['T07', 'T08', 'T12', 'T25', 'T26'],
  },
  {
    id: 'C2',
    clauses: '产品§2–3；技术§5.1–§5.2、A2',
    acceptance: 'T10 `answer-once`、`stale-or-deferred`；T13 `stable-work-and-watermark`；T15 `same-work`，显式提交和聊天各走其路，断线重取同一工作及回执',
    tasks: ['T04', 'T08', 'T10', 'T11', 'T13', 'T15', 'T25'],
  },
  {
    id: 'C3',
    clauses: '产品§2.2；技术§5.5',
    acceptance: 'T19 夏令时跨日、域外事实、重复/撤销/重建，活动与当前存量分别验；T25 对账一次真实答复只计一次',
    tasks: ['T13', 'T19', 'T25'],
  },
  {
    id: 'C4',
    clauses: '产品§4.1、§5.4；技术§5.3.1、§5.4.1、§6.1.1、A1',
    acceptance: 'T06 写稿后丢回执、中文检索与撤回；T16 四入口和三轴；T27 真实 Mac 文件往返/关编辑器；T22 保全较新原稿',
    tasks: ['T05', 'T06', 'T07', 'T16', 'T17', 'T22', 'T27'],
  },
  {
    id: 'C5',
    clauses: '产品§5.5；技术§5.4.2、A2、A4',
    acceptance: 'T10 `channel-lifecycle` 和真实双向探针；T17 待启用/排空各有回执；T22 恢复后旧 incarnation 回调和绑定无效',
    tasks: ['T03', 'T10', 'T17', 'T20', 'T22', 'T25'],
  },
  {
    id: 'C6',
    clauses: '产品§5.1–5.3、§7；技术§2.5、§5.3–§5.4',
    acceptance: 'T17 验证后改草稿、部分应用后复查失败；T05/T18 四种来源、启用和首次采集证据；T20 明确发送和脱敏预览',
    tasks: ['T01', 'T03', 'T05', 'T17', 'T18', 'T20'],
  },
  {
    id: 'C7',
    clauses: '产品§6–7；技术§4、§5.7–§5.8、A3–A4',
    acceptance: 'T08 最后额度竞争与旧 grant；T09 三后台身份、坏退出、每收费 attempt 预算；T12 远端成功响应丢失及 source/base 变化；T25 三条真实工作路线',
    tasks: ['T08', 'T09', 'T12', 'T25'],
  },
  {
    id: 'C8',
    clauses: '产品§6–7；技术§6、A4',
    acceptance: 'T21 双 VPN 和原健康依赖复验；T22 两库水位、撤回、Vault 新稿、旧主机未停；T23 空机安装与升级；T25 真实隔离恢复',
    tasks: ['T21', 'T22', 'T23', 'T25'],
  },
  {
    id: 'C9',
    clauses: '产品§8–10；技术§5.6、§7.2',
    acceptance: 'T14 默认语言和覆盖；T15 生成中换语言后保留草稿、焦点、回执；T24 `frame-coverage`、各布局截图、键盘/读屏和动效实测',
    tasks: ['T14', 'T15', 'T16', 'T17', 'T19', 'T24', 'T25'],
  },
];

const vitest = (path) => `npm exec -- vitest run ${path}`;
const playwright = (config) => `npm exec -- playwright test --config ${config} --reporter=line`;

/** Per-task scenarios. The order of the keys is the order the tasks appear in §7. */
export const releaseEvidencePlan = {
  T00: {
    scenarios: [
      { id: 'design-inputs-lock', command: 'npm run test:t00', kind: 'contract' },
      { id: 'design-inputs-recheck', command: 'node scripts/lock-design-inputs.mjs --check', kind: 'probe' },
      {
        id: 'runtime-admission-probes',
        command: 'node scripts/lock-design-inputs.mjs',
        kind: 'probe',
        note: '记录 Node/npm、平台、CLI、飞书与 Obsidian 的真实探针结果；未测到的组合保留 pending/blocked。',
      },
    ],
  },
  T01: {
    scenarios: [
      { id: 'contract-envelope', command: vitest('tests/contract/T01.test.ts'), kind: 'contract' },
      { id: 'lint', command: 'npm run lint', kind: 'lint' },
      { id: 'typecheck', command: 'npm run typecheck', kind: 'build' },
    ],
  },
  T02: { scenarios: [{ id: 'storage-transactions', command: vitest('tests/integration/T02.test.ts'), kind: 'integration' }] },
  T03: { scenarios: [{ id: 'owner-auth-and-control', command: vitest('tests/integration/T03.test.ts'), kind: 'integration' }] },
  T04: { scenarios: [{ id: 'autoloop-lineage', command: vitest('tests/contract/T04.test.ts'), kind: 'contract' }] },
  T05: { scenarios: [{ id: 'github-and-directory-collection', command: vitest('tests/integration/T05.test.ts'), kind: 'integration' }] },
  T06: { scenarios: [{ id: 'vault-and-knowledge-evidence', command: vitest('tests/integration/T06.test.ts'), kind: 'integration' }] },
  T07: { scenarios: [{ id: 'standards-and-evaluation', command: vitest('tests/integration/T07.test.ts'), kind: 'integration' }] },
  T08: { scenarios: [{ id: 'delegation-and-budget', command: vitest('tests/integration/T08.test.ts'), kind: 'integration' }] },
  T09: {
    scenarios: [
      { id: 'executor-terminal-contract', command: vitest('tests/contract/T09.test.ts'), kind: 'contract' },
      {
        id: 'executor-production-admission',
        command: vitest('tests/admission/T09.test.ts'),
        kind: 'admission',
        blockedBy: { type: 'json-entries-incomplete', file: 'docs/operations/evidence/executor-admission-guest.json',
          collection: 'backends', field: 'status', value: 'verified' },
        blockedReason: '这一项只有当隔离来宾内三个后端都标 verified 时才算通过；记录见 docs/operations/evidence/executor-admission-guest.json：Codex CLI 0.163.0、Grok Build 1.0.88 与 DSH 0.2.2-rc.2 都在来宾内完成实时终端回读，模型真实调用 patrick-memory 并经受限 RPC 读回获准证据。',
      },
      {
        id: 'executor-guest-evidence',
        command: vitest('tests/admission/T09-evidence.test.ts'),
        kind: 'admission',
        note: '逐后端记录安装版本、隔离状态与受阻原因；来宾内的运行结果见 docs/operations/evidence/executor-admission-guest.json。',
      },
    ],
  },
  T10: {
    scenarios: [
      { id: 'exact-answer-and-resume', command: vitest('tests/integration/T10.test.ts'), kind: 'integration' },
      {
        id: 'feishu-live-round-trip',
        command: vitest('tests/admission/T10.test.ts'),
        kind: 'admission',
        blockedBy: { type: 'json-status', file: 'fixtures/contracts/admission-matrix.json', path: 'feishu_deferred_card.status', value: 'blocked' },
        blockedReason: '飞书准入探针记录 `feishu_deferred_card` 为 blocked：本机没有真实飞书应用凭据，暂缓后提交决定卡与双向收发未在真实租户验收。',
      },
    ],
  },
  T11: {
    scenarios: [
      { id: 'conversations-and-consultations', command: vitest('tests/integration/T11.test.ts'), kind: 'integration' },
      { id: 'hub-contract', command: vitest('tests/contract/T11.hub.test.ts'), kind: 'contract' },
      { id: 'hub-routing', command: vitest('tests/contract/T11.routing.test.ts'), kind: 'contract' },
    ],
  },
  T12: { scenarios: [{ id: 'pr-delivery-and-outcomes', command: vitest('tests/integration/T12.test.ts'), kind: 'integration' }] },
  T13: { scenarios: [{ id: 'work-and-health-projections', command: vitest('tests/integration/T13.test.ts'), kind: 'integration' }] },
  T14: { scenarios: [{ id: 'bilingual-shell', command: vitest('tests/unit/T14.test.ts'), kind: 'unit' }] },
  T15: {
    scenarios: [
      { id: 'decisions-and-work-browser', command: playwright('tests/e2e/T15.config.ts'), kind: 'browser' },
      { id: 'consultation-scope', command: vitest('tests/integration/T15-consultation-scope.test.ts'), kind: 'integration' },
      { id: 'work-control', command: vitest('tests/integration/T15-control.test.ts'), kind: 'integration' },
      { id: 'command-journal', command: vitest('tests/unit/T15-command-journal.test.ts'), kind: 'unit' },
    ],
  },
  T16: { scenarios: [{ id: 'knowledge-standards-delegation-browser', command: playwright('tests/e2e/T16.config.ts'), kind: 'browser' }] },
  T17: {
    scenarios: [
      { id: 'settings-change-chain', command: vitest('tests/integration/T17.test.ts'), kind: 'integration' },
      { id: 'settings-browser', command: playwright('tests/e2e/T17.config.ts'), kind: 'browser' },
    ],
  },
  T18: {
    scenarios: [
      { id: 'rss-and-webpage-collection', command: vitest('tests/integration/T18'), kind: 'integration' },
      { id: 'collection-browser', command: playwright('tests/e2e/T18.config.ts'), kind: 'browser' },
    ],
  },
  T19: {
    scenarios: [
      { id: 'six-metrics', command: vitest('tests/integration/T19.test.ts'), kind: 'integration' },
      { id: 'stats-browser', command: playwright('tests/e2e/T19.config.ts'), kind: 'browser' },
    ],
  },
  T20: {
    scenarios: [
      { id: 'notifications-and-diagnostics', command: vitest('tests/integration/T20'), kind: 'integration' },
      { id: 'diagnostics-browser', command: playwright('tests/e2e/T20-diagnostics.config.ts'), kind: 'browser' },
      { id: 'diagnostics-client', command: vitest('tests/unit/T20-diagnostics-client.test.ts'), kind: 'unit' },
    ],
  },
  T21: {
    scenarios: [
      { id: 'network-supervisor', command: vitest('tests/integration/T21'), kind: 'integration' },
      { id: 'network-browser', command: playwright('tests/e2e/T21.config.ts'), kind: 'browser' },
      {
        id: 'registered-device-vpn-admission',
        command: vitest('tests/admission/T21.test.ts'),
        kind: 'admission',
        blockedBy: { type: 'env-absent', name: 'PATRICK_T21_LIVE_EVIDENCE' },
        blockedReason: '登记设备的双 VPN 启动顺序、企业 DNS 与重连验收需要实机证据；本机没有登记设备和观测记录，用例按设计跳过。',
      },
    ],
  },
  T22: { scenarios: [{ id: 'recovery-set-and-restore', command: vitest('tests/recovery/T22.test.ts'), kind: 'recovery' }] },
  T23: {
    scenarios: [
      { id: 'release-candidate-admission', command: vitest('tests/admission/T23.test.ts'), kind: 'admission' },
      { id: 'runtime-build-and-relocate', command: vitest('tests/admission/T23-build.test.ts'), kind: 'admission' },
      {
        id: 'empty-host-install-and-upgrade',
        command: vitest('tests/admission/T23-install-preview.test.ts'),
        kind: 'admission',
        blockedBy: { type: 'path-absent', path: '/Applications/PAtrick.app' },
        blockedReason: '空机安装、重启与升级只对真实安装目录有证据；本机没有已安装的 PAtrick.app，候选包的 installable 仍为 false。',
      },
    ],
  },
  T24: {
    scenarios: [
      { id: 'frame-coverage-and-visual-baselines', command: playwright('tests/visual/T24.config.ts'), kind: 'visual' },
      { id: 'motion-and-accessibility', command: playwright('tests/e2e/T24.config.ts'), kind: 'browser' },
      { id: 'responsive-and-zoom', command: playwright('tests/e2e/T24-responsive.config.ts'), kind: 'browser' },
    ],
  },
  T25: {
    scenarios: [
      { id: 'pilot-trace-consistency', command: vitest('tests/admission/T25.test.ts'), kind: 'admission' },
      { id: 'directory-block-browser', command: playwright('tests/e2e/T25-directory-block.config.ts'), kind: 'browser' },
      {
        id: 'provider-backed-work-routes',
        command: vitest('tests/admission/T25.test.ts'),
        kind: 'admission',
        pendingBy: { type: 'json-all-pending', file: 'fixtures/pilot/acceptance.json', collection: 'routes', field: 'status' },
        pendingReason: '三条真实工作路线（直接交付、答后续办、过期或冲突拦截）还没有提供者侧的真实观察，试点清单保持 pending。',
      },
    ],
  },
  T26: {
    scenarios: [
      { id: 'pilot-and-release-policy', command: vitest('tests/unit/T26.test.ts'), kind: 'unit' },
      {
        id: 'observed-pilot-results',
        command: vitest('tests/unit/T26.test.ts'),
        kind: 'admission',
        pendingBy: { type: 'json-all-pending', file: 'fixtures/pilot/acceptance.json', collection: 'routes', field: 'status' },
        pendingReason: '试点成果有效率、引用准确率与人工投入需要真实观察样本；当前没有可分母的试点数据。',
      },
    ],
  },
  T27: {
    scenarios: [
      { id: 'obsidian-install-rehearsal', command: vitest('tests/admission/T27.test.ts'), kind: 'admission' },
      {
        id: 'production-service-identity-round-trip',
        command: vitest('tests/admission/T27-rehearsal.test.ts'),
        kind: 'admission',
        blockedBy: { type: 'path-absent', path: '/Library/Application Support/PAtrick' },
        blockedReason: '生产服务身份下的 Vault 往返、原生重启与跨设备同步需要已安装的服务身份；本机没有该安装目录。',
      },
    ],
  },
  T28: { scenarios: [{ id: 'bilingual-readme', command: vitest('tests/unit/T28.test.ts'), kind: 'unit' }] },
};
