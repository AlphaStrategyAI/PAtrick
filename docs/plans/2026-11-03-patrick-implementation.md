# PAtrick Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通一个产品从 `productIdeas` 来源修订到有证据的正式 PRD 合并、反馈和记忆更新，并用持久账本在等待、故障和重启后续办。

**2026-11-08 状态：** 已完成的任务标为完成。未完成的是真实运行器准入、真实合并读回、主机运维准入和真实首链验收。下面各步的复选框保留原计划写法，不以勾选代替实链证据。

**Architecture:** 一个 Node.js 24/TypeScript ESM 常驻服务，Hono SSR/HTML 与普通渐进 JavaScript/CSS，SQLite 事务记录任务、尝试与收发意图，Vault 保存可读事实与标准。worker 只能提出候选或隔离补丁，宿主检查当前授权并通过受控写入器取得可信 CI、合并与读回证据；所有外部前提单独验收。

**Tech Stack:** Node.js 24、TypeScript ESM、Hono、better-sqlite3/FTS5、Chokidar、Zod、官方 Feishu/MCP SDK、dsh ACP、Grok Build CLI、Codex exec、Vitest、Playwright、Lima、launchd、restic。

## Global Constraints

以下引号内容按 [技术方案](../designs/PAtrick技术方案.md) 保留；任务的验收隐含包含这些全局约束。

- “决定采用 Node.js 24＋TypeScript”，“自有代码放在一个项目”。
- “Hono 提供 HTTP 和服务端页面，SQLite 保存任务，Vitest 测试。”
- “外部输入仍须在运行时校验。”
- “模型只提交建议或补丁，正式交付要有远端证据。”
- “入库和调用模型前分别校验资料权限。”
- “一次动作使用一个稳定编号，断电后先查远端再补做。”
- “每轮每个候选最多试一次”；“每次实际切换都主动告知本人。”
- “最多两轮且受任务预算约束”；“一次跑一个 worker”。
- “两种语言都要实际查”；“恰好提供三个入口”。
- “活动数据库、WAL 和凭据放在同步目录外。”
- “条件欠缺就如实标记该链未就绪。”
- “每周维护上限 60 分钟，连续两周超限就暂停扩源”。

除非已有获准凭据和环境，本地测试只能用替身且禁止外写。不能为完成任务修改全局 `CLAUDE.md`、CLI 设置或扩大授权。没有本人答复就持续等待，不自动选择。设计默认值可直接实现，外部身份、额度、仓库政策和网络准入不能用默认值代替证明。

---

## 文件与执行约定

契约唯一来源为 `src/domain.ts`，不要在子模块重新定义同名不同义类型。主要代码边界：

- `src/config.ts`：启动与项目、路径、CI、runner 准入配置。
- `src/store.ts`：账本、事务、FTS、Markdown、备份；`src/intake.ts`、`src/collector.ts`：统一来源修订、稳定读取、补扫。
- `src/knowledge.ts`：提取核实与 `lookup`；`src/standards.ts`：本人决定、观察、规则版本。
- `src/scheduler.ts`、`src/integrations/workers.ts`：角色调度、隔离 runner 和切换。
- `src/orchestrator.ts`：固定状态流程；`src/integrations/{research,github,gitlab,feishu,network}.ts` 和 `src/mcp.ts`：外部边界。
- `src/runtime.ts`、`src/index.ts`、`src/mcp.ts`：组合、HTTP/后台与 MCP 启动；`src/app.ts`、`src/auth.ts`、`src/readiness.ts`、`src/web/`、`public/`：认证 HTTP、SSR 及静态资源。
- `scripts/doctor.ts`、`scripts/backup.ts`、`scripts/report.ts`、`scripts/restore.ts`、`scripts/install-service.ts`、`examples/`：诊断、报表、备份恢复及 launchd/Lima 模板。
- `tests/unit/`、`tests/integration/`、`tests/e2e/`：局部行为、故障链、浏览器语义。
- `docs/designs/PAtrick详细设计.md`、`docs/acceptance.md`：设计和证据。

现有公共契约如下；扩展字段需同时更新 Schema、调用者、替身和对应测试，不得用类型断言绕过输入校验：

```ts
import type {
  Entities, Table, Scope, KnowledgeCard, WorkerInput, WorkerResult,
  DeliveryReceipt, Task, Project, ResearchRecord, OutboxMessage,
} from '../../src/domain.js';

interface LedgerContract {
  get<K extends Table>(table: K, id: string): Entities[K] | undefined;
  list<K extends Table>(table: K): Entities[K][];
  save<K extends Table>(table: K, entity: Entities[K]): void;
  delete(table: Table, id: string): void;
  transaction<T>(fn: () => T): T;
  searchCards(query: string, scope: Scope, limit?: number): KnowledgeCard[];
  indexCard(card: KnowledgeCard): void;
  rebuildIndex(): void;
  backup(path: string): Promise<void>;
  close(): void;
}
interface WorkerContract {
  run(input: WorkerInput, signal?: AbortSignal): Promise<WorkerResult>;
}
interface DeliveryContract {
  deliver(task: Task, project: Project): Promise<DeliveryReceipt>;
  baseline(project: Project): Promise<string>;
}
interface ResearchContract {
  research(question: string, project: Project): Promise<ResearchRecord>;
}
interface NotificationContract {
  send(message: OutboxMessage): Promise<{ remoteId: string }>;
}
```

`Store` 构造参数为 `(databasePath: string, vaultDir?: string)`。`Workbench` 通过 `{ store, config, workers, writer, research, notifier }` 组合，使用 `ingest(IngestInput)`、`answer(QuestionAnswer)`、`withdraw(sourceId)`、`tick()`、`retry(taskId)`、`cancel(taskId)`、`runUntilIdle(maxSteps?)`。`IngestInput` 来自 `src/intake.ts`，问答来自 `src/domain.ts`，不新建并行入口。

以下测试片段保留计划中的行为目标和预期夹具，不表示每个示例测试路径或 `setup()` 已按原名落地。当前回归用例已合并在 `tests/unit/`、`tests/integration/` 和 `tests/e2e/`，实际命令、数量与边界见 [验证报告](../test-report.md)；运行前以当前文件和夹具为准，不借用真实账号。每项完成一次红→绿循环即可，已有绿测试不为形式反复运行。建议每任务形成一次可审查提交；本计划编写阶段不提交代码，执行者也不得覆盖同库其他人的改动。

## Task 1：配置、共享契约与默认拒绝

**状态：完成**

**Files:** `package.json`、`tsconfig.json`、`tsconfig.build.json`、`src/domain.ts`、`src/config.ts`；测试 `tests/unit/domain.test.ts`、`tests/unit/config.test.ts`。

**Interfaces:** 产出 `Scope`、`Project`、`SourceRevision`、`Task`、七角色 Schema、`QuestionAnswer`、`WorkerInput`、外部适配器契约及 `readConfig(env)`。`Project.trustedChecks` 与 `trustedAppIds` 在自动合并时都必须非空；角色准入默认 `admitted: false`。

- [ ] **Step 1：先写拒绝空授权的测试。** 在 `tests/unit/config.test.ts` 加入以下用例：

```ts
it('defaults to a local unconfigured live service without admitted workers', () => {
  const config = readConfig({});
  expect(config.mode).toBe('live');
  expect(config.host).toBe('127.0.0.1');
  expect(config.projects).toEqual([]);
  expect(config.runnerPolicies.every(p => !p.admitted)).toBe(true);
  expect(() => readConfig({ PATRICK_HOST: '0.0.0.0' })).toThrow(/token/i);
});
```

- [ ] **Step 2：确认红灯。** `npm test -- tests/unit/config.test.ts tests/unit/domain.test.ts`；缺配置实现时应失败，不能通过真实 token 绕过。
- [ ] **Step 3：实现严格配置与路径检查。** 采用 `src/domain.ts` 的 Schema；`safeRelativePath` 拒绝绝对路径、反斜线、NUL、`.`/`..`/空段及 `.git`；`pathAllowed` 只允许明确文件或以 `/` 结尾的目录前缀。`readConfig` 从显式环境和配置文件读取，未知字段拒绝；默认无项目、无准入、回环监听。配置不能直接输出凭据到设置页。
- [ ] **Step 4：补齐有效/越界对照。** 用 `projectSchema.safeParse` 验证允许 PRD 路径、空 CI/App、不同 scope ID、超预算和 `../` 失败；自动合并必须同时有可信 checks/App。问答 C 必须非空，A/B 冻结文本不用用户提交文本替换。
- [ ] **Step 5：验证并保存本任务证据。** 同一测试命令全绿；`npm run typecheck` 成功。记录 R001、R006、R052、R070、R071、R075 的代码部分；有真实依赖的部分仍未验收。

## Task 2：持久存储、事务、FTS 与可恢复 Markdown

**状态：完成**

**Files:** `src/store.ts`；测试 `tests/unit/core-store.test.ts`。

**Interfaces:** 消费 `Entities/Table/Scope`，实现上面的 `LedgerContract`；事务必须同步，网络和 `await` 放事务外。相同 `id` 是幂等更新，scope 是检索必要条件；发布与 FTS 不暴露未提交内容。

- [ ] **Step 1：先写事务与撤回测试。** 在 `core-store.test.ts` 使用该文件 `setup/source/card`：

```ts
it('does not resurrect withdrawn cards after rebuilding FTS', () => {
  const { store } = setup();
  const s = source();
  store.save('sources', s);
  store.save('cards', card(s));
  expect(store.searchCards('恢复', s)).toHaveLength(1);
  store.save('sources', { ...s, status: 'withdrawn' });
  store.rebuildIndex();
  expect(store.searchCards('恢复', s)).toEqual([]);
});
```

- [ ] **Step 2：确认红灯。** `npm test -- tests/unit/core-store.test.ts`；缺 FTS/失效过滤时失败。
- [ ] **Step 3：实现账本与发布协议。** 创建 `projects/sources/tasks/cards/rules/cases/questions/events/attempts/outbox/receipts/actions/cursors`，每行存 `id/project_id/domain/data`。事务同时写状态/动作；Markdown 在事务提交后以临时文件+原子改名发布，失败留可恢复意图，冲突保存两侧；撤回记录先于重建。FTS 使用 `unicode61`，入索引与查询使用同一 `tokenize()`，按 scope 过滤后 `bm25()`。
- [ ] **Step 4：加入实质恢复反例。** 测事务中抛错后 DB/Markdown 都未提交；发布意图落账后进程重启可补全；原文已撤回时索引重建不能复活；异项目/异域高相关卡不返回；未知项目为空。`ephemeral` 只在受控内存保留正文，关闭再开、备份字节和 Vault 均找不到其正文/派生摘录。
- [x] **Step 5：验证并保存。** 单测全绿；在线备份打开后可检索同样的有效卡。额外证明“Vault+撤回→重建”与“DB→Vault 投影”是不同能力，前者未实现不能勾 R025。覆盖 R005、R009、R014、R023–R025、R050、R085–R086。

## Task 3：文件与消息来源修订

**状态：完成**

**Files:** `src/intake.ts`、`src/collector.ts`、`src/index.ts`；测试 `tests/unit/intake.test.ts`、`tests/integration/core-flow.test.ts`。

**Interfaces:** `ingestSource(store, config, input: IngestInput): Task | undefined`；`withdrawSource(store, sourceId): void`；输入含 `projectId/externalId/kind/title/content/authorId` 及可选 locator/修订/留存。同一内容同源返回同任务，变更使旧来源/任务与相关问题失效。

- [ ] **Step 1：用真实临时目录写漏通知测试。** 创建一个 `productIdeas` 临时目录，在未发 watcher 回调的情况下写入文件，调用补扫，断言账本只有一来源、一任务。第二次补扫结果相同。再写不同内容，断言旧版失效、新修订单独入账。测试不得监听用户真实目录。
- [ ] **Step 2：确认红灯。** `npm test -- tests/unit/intake.test.ts`，缺补扫/游标事务应失败。
- [ ] **Step 3：实现稳定采集。** Chokidar 只唤醒扫描；读取前后比对文件信息/摘要，未稳定重试；规范路径与真实路径都必须位于配置目录；同步临时文件不入账。来源唯一键由授权域、项目、平台、原对象和修订组成；同源别名必须有证明再归并。来源/任务/游标在事务中提交，接收失败不推进水位。
- [ ] **Step 4：验证双路接收和撤回。** 消息先写持久收件，再分别续办与采集动作；故意让采集失败只重试该路。测试实时/历史/文件镜像只一份、机器人通知不循环、旧问题答复不执行、删除/撤回先停用规则。补扫、实时和重启的组合应产生一次业务效果。
- [ ] **Step 5：验证并保存。** `npm test -- tests/unit/intake.test.ts tests/integration/core-flow.test.ts`。覆盖 R007–R015、R050、R072、R078；真实目录自动捕获在 live 任务另验。

## Task 4：事实核实、知识卡与统一检索

**状态：完成**

**Files:** `src/knowledge.ts`、`src/store.ts`；测试 `tests/unit/knowledge.test.ts`、`tests/unit/core-store.test.ts`。

**Interfaces:** `publishKnowledge(store: Store, source: SourceRevision, output: unknown): KnowledgeCard[]`；模型输出由 `knowledgeOutputSchema` 校验；检索消费 `Store.searchCards(query, scope, limit)`，宿主返回前回读出处。

- [ ] **Step 1：写伪造引文反例。** 用临时 Store 和当前来源，向 `publishKnowledge` 提交正文不含的 `quote`，断言没有发布卡、没有 FTS 命中、Vault 没有该引文；有效原句作为正例。
- [ ] **Step 2：确认红灯。** `npm test -- tests/unit/knowledge.test.ts tests/unit/core-store.test.ts`。
- [ ] **Step 3：实现候选接纳。** 先验来源仍 active/同修订/有权限，再解析候选；逐字检查 quote 属于该修订，稳定卡 ID 防重复。worker 只允许 `reported/inference`；只有宿主独立验证的结构化回执才可设 verified。主题卡保留引用、冲突/反例和解释依据，未经成功证据的排障经验不作可靠解法。
- [ ] **Step 4：实现短词和回读验证。** 以下固定输入是 `tokenize()` 的最小可执行约束：

```ts
it('indexes adjacent Chinese bigrams and English terms', () => {
  const terms = tokenize('草稿恢复 Draft').split(' ');
  expect(terms).toContain('草稿');
  expect(terms).toContain('恢复');
  expect(terms).toContain('draft');
});
```

检索测标题/别名/正文命中、停模型可查、过期卡隐藏、跨域卡不返回、撤回再建索引仍隐藏。原句回读失败应作为证据缺口，不能返回已核结论。

- [x] **Step 5：验证并保存。** 单测全绿；引用/中文/撤回用例分别记录。覆盖 R016–R025、R041、R080。

## Task 5：本人决定、规则范围与版本

**状态：完成**

**Files:** `src/standards.ts`；测试 `tests/unit/standards.test.ts`、`tests/integration/core-flow.test.ts`。

**Interfaces:** `publishObservations(store, source, output): Rule[]`、`frozenAnswer(question, answer): string`、`recordOwnerDecision(store, task, question, answer): DecisionCase`、`applicableRules(store, task): Rule[]`；只接纳已核本人和当前问题的决定。

- [ ] **Step 1：写观察不得升级原则的测试。** 给 `case_extract` 概括输出，断言只有 `kind: 'observation'`；向同题接纳一次已核本人 A/B/C，断言原话/冻结建议、项目/域、原决定 ID 正确，重复补读不多建案例。
- [ ] **Step 2：确认红灯。** `npm test -- tests/unit/standards.test.ts tests/integration/core-flow.test.ts`。
- [ ] **Step 3：实现范围和冻结。** 未明说理由写未知，保存当时目标/证据/候选/初判/选择，不写事后知识；A/B 不使用答复客户端自由文本，C 原样保留。一次决定原则只适用该事项，未有本人扩大范围原话不得扩域。规则记录支持/反对、条件、例外、版本和出处。
- [x] **Step 4：实现三种修订语义。** 明确改主意以生效时间接替旧版；局部例外保留基线；冲突保留两侧并暂停自动引用。撤回/过期/冲突暂停引用并重判域内未决任务；结果以追加关联，不能覆盖原案。
- [ ] **Step 5：验证并保存。** 用同一决定实时/历史/PRD 镜像验证一案一原则；不同项目不得复用；撤回后新任务不引用旧版。覆盖 R026–R036、R040、R042、R064、R066。

## Task 6：调度、预算与自动切换

**状态：完成**

**Files:** `src/scheduler.ts`；测试 `tests/unit/scheduler.test.ts`、`tests/integration/core-flow.test.ts`。

**Interfaces:** `new Scheduler(store, config, workers)`；`run(task: Task, project: Project, input: WorkerInput): Promise<unknown>`；消费 `RunnerPolicy` 和 `WorkerAdapter`，产出经角色 Schema 校验的结果、Attempt、预算和 OutboxMessage。

- [ ] **Step 1：先写同事务切换测试。** `core-flow.test.ts` 的夹具支持 `workerUnavailable/notifierOffline`：

```ts
it('persists fallback notices while a healthy replacement continues', async () => {
  const f = setup({ workerUnavailable: { grok: ['knowledge_extract'] }, notifierOffline: true });
  const task = f.ingest();
  await f.engine.tick();
  expect(f.store.list('attempts').map(a => a.status)).toEqual(['unavailable', 'succeeded']);
  expect(f.store.list('outbox').some(m => m.status === 'pending' && m.text.includes('dsh'))).toBe(true);
  expect(f.store.get('tasks', task.id)?.status).not.toBe('awaiting_answer');
});
```

- [ ] **Step 2：确认红灯。** `npm test -- tests/unit/scheduler.test.ts tests/integration/core-flow.test.ts`。
- [ ] **Step 3：实现角色次序与准入。** 默认提取/初判/执行 Grok→dsh→Codex；显式 dsh 执行 dsh→Grok→Codex；规划/检查/反馈 Codex→Grok→dsh。先过滤角色、域、提供方、权限、额度；预算原子预留并核实实际消耗；一次仅一个 worker。检查优先不同执行 runner，同 runner 必须 independentReview 准入。
- [ ] **Step 4：实现错误分类与 fencing。** 运行器启动/超时/持续限流/失效凭据可切换，测试失败和返修不切换。每轮每候选一次；新尝试与通知同事务，冻结输入 hash 不变；旧尝试迟到不接纳。全不可用保留任务与退避时间，并通知下次探测；可能已远端写入先对账。
- [ ] **Step 5：验证并保存。** 全七角色分别覆盖首选不可用；无备选/域不符/提供方不符/预算不足不调用；通知离线不挡健康 runner；通知重试只一回执。覆盖 R017、R028、R045–R046、R052–R059、R093。

## Task 7：真实 worker 适配器与隔离边界

**状态：未完成** — 适配器和隔离替身已落地。真实 Grok、Codex、dsh 的提供方、权限和费用仍未准入。

**Files:** `src/integrations/workers.ts`、`examples/lima.yaml`；测试 `tests/unit/workers.test.ts`。

**Interfaces:** 实现 `WorkerAdapter.name` 和 `run(input, signal)`；Grok 非交互 CLI、dsh ACP、Codex `codex exec` 只在 Lima 执行。输入/输出都关联 task/version/role，进程外费用/提供方记录进入 Attempt。

- [ ] **Step 1：建立进程协议替身。** 使用临时可执行文件/假 ACP 客户端记录收到的 argv、stdin、环境、工作目录和取消信号，返回角色 Schema；不得调用用户真实 CLI。测试超时后发取消/终止、输出过长或非 JSON 拒收、错误 Schema 失败。
- [ ] **Step 2：确认红灯。** `npm test -- tests/unit/workers.test.ts`，缺隔离/取消/校验应失败。
- [ ] **Step 3：实现只读/执行角色权限。** stdin 提供获准冻结 WorkerInput；不经 shell 拼接用户材料；环境只允许角色必需变量，不继承 GitHub/GitLab/SSH agent；只读角色不挂可写材料，执行只写任务副本。Lima 模板移除默认 home 挂载、关 agent 转发、限网络与会话上传。
- [ ] **Step 4：验证无逃逸能力。** 用含引号、换行、反引号的来源正文验证它只作为数据；检查命令不含凭据；输出中的假 `mergeSha/checks` 不产生 receipt；计划或补丁路径越界由宿主再次拒绝。运行器同名不代表提供方/模型准入一致。
- [ ] **Step 5：保存分层证据。** 本地替身协议测试通过记 `C`；真实 ACP、后台权限/费用/隔离、主机 Lima 记录为独立 `L/O`。覆盖 R045–R047、R075–R076、R081–R083、R093。

## Task 8：双语研究、证据缺口与决策卡

**状态：完成**

**Files:** `src/integrations/research.ts`、`src/orchestrator.ts`；测试 `tests/unit/research.test.ts`、`tests/integration/core-flow.test.ts`。

**Interfaces:** `ResearchAdapter.research(question, project): Promise<ResearchRecord>`；`Decision.action` 是 `proceed/ask/archive`；`Question.options` 只有 A/B，C 是宿主自由输入入口。研究原文记录须含语言、URL/canonicalURL、发表/访问时间、引文、primary、条件。

- [ ] **Step 1：先测少一语言不发问。** 在 `core-flow.test.ts` 加入：

```ts
it('keeps a question closed until both language searches actually occurred', async () => {
  const f = setup({ ask: true, research: { ...research, queries: research.queries.filter(q => q.language === 'en') } });
  const task = f.ingest();
  await f.engine.runUntilIdle();
  expect(f.store.get('tasks', task.id)?.status).not.toBe('awaiting_answer');
  expect(f.store.list('questions')).toEqual([]);
});
```

- [ ] **Step 2：确认红灯。** `npm test -- tests/unit/research.test.ts tests/integration/core-flow.test.ts`。
- [ ] **Step 3：实现研究协议。** 查询前验证词可出域，中文/英文各实际查询问题/备选/反例并打开原文；用 canonicalURL/原发布者归并转载和翻译。优先两语一手并找独立源；某语言缺可靠结果换词并落缺口，若无法支持两可行建议保持补证重试。搜索摘要不算已打开原文。
- [ ] **Step 4：实现卡片和等待。** A/B 冻结做法、理由、代价、适用条件及证据，C 原话；恰好三入口。卡绑定 owner/question/taskVersion/questionVersion，等待无限期释放 worker。版本更新后旧答复触发重判断，不能执行过期选项。
- [ ] **Step 5：验证并保存。** 测仅搜索无原文、同源双语、缺证、出域拒绝、两个真实建议、A/B/C 原话与版本；证据足够不必问。覆盖 R060–R066、R073、R078。

## Task 9：仓库写入、可信 CI 与合并读回

**状态：未完成** — 写入器和可信检查门禁已落地。真实合并 SHA 与读回仍未验收。

**Files:** `src/integrations/github.ts`、`src/integrations/gitlab.ts`；测试 `tests/unit/writer.test.ts`、`tests/integration/writer-recovery.test.ts`。

**Interfaces:** `validateDelivery(task, project): void`、`validateChecks(checks, project, headSha): void`、`GitHubWriter implements DeliveryWriter`；真实凭据只传写入器，不传 WorkerInput。GitLab 使用同样的 `DeliveryReceipt` 语义；首链只验 GitHub。

- [ ] **Step 1：先写非空可信检查的负例。** `writer.test.ts` 的 `project` 夹具要求 `validate`、App 123：

```ts
it('rejects zero, skipped, foreign-app, and stale-head checks', () => {
  expect(() => validateChecks([], project, 'head')).toThrow();
  const check = { name: 'validate', conclusion: 'success', headSha: 'head', appId: 123, url: 'https://github.com/owner/repo/actions/runs/1' };
  expect(() => validateChecks([check], project, 'head')).not.toThrow();
  for (const change of [{ conclusion: 'skipped' }, { appId: 0 }, { headSha: 'old' }]) {
    expect(() => validateChecks([{ ...check, ...change }], project, 'head')).toThrow();
  }
});
```

- [ ] **Step 2：确认红灯。** `npm test -- tests/unit/writer.test.ts tests/integration/writer-recovery.test.ts`。
- [ ] **Step 3：实现发布门禁。** 重新读取来源/授权/基线；核对 taskVersion/sourceRevision/planHash/artifactHash、独立检查与测试，补丁只能触及 allowedPaths。`trustedChecks`、`trustedAppIds` 非空；每个必需检查都须当前 head、可信 App、`success`。缺失、跳过、取消、未知状态、旧 SHA 不通过。head/base 变化重新规划/检查，不复用旧批准。
- [ ] **Step 4：实现远端意图与证明。** 创建分支/提交/PR 前落稳定 ActionRecord，回放先按 repo/branch/marker 查已有对象。超时后查询远端而不是再创建。合并前再查 head/CI/权限；合并后以 mergeSha 读回正式路径并核对内容摘要，再构建 receipt。模型给的 URL、SHA、成功文本一律不是远端证明。仓需独立人审不可绕过。
- [ ] **Step 5：验证并保存。** 假 fetch 精确记录 API 访问次序；模拟 PR 创建成功后响应丢失、合并成功后断网、路径/权限变化、CI 缺项/head 改变，重放均最多一份修改。覆盖 R006、R047–R050、R057、R074–R079；真实 App/head/合并实链留后验。

## Task 10：持久编排与完整闭环

**状态：完成**

**Files:** `src/orchestrator.ts`、`src/runtime.ts`、`src/index.ts`；测试 `tests/integration/core-flow.test.ts`。

**Interfaces:** `Workbench` 使用前述组合参数；`ingest/answer/tick/retry/cancel/withdraw/runUntilIdle` 均以 Store 为事实来源。状态来自 `taskStatuses`：`queued/extracting/deciding/researching/awaiting_answer/planning/executing/checking/publishing/feedback/delivered/archived/blocked/retrying/cancelled`。

- [ ] **Step 1：先写七角色和回执门禁。** 现有 `setup()` 只用临时 DB 和替身：

```ts
it('executes all roles before delivery and refuses absent receipts', async () => {
  const f = setup();
  const task = f.ingest();
  await f.engine.runUntilIdle();
  expect(f.calls.map(c => c.role)).toEqual(['knowledge_extract', 'case_extract', 'decide', 'plan', 'execute', 'check', 'feedback']);
  expect(f.store.get('tasks', task.id)?.status).toBe('delivered');
  const offline = setup({ noReceipt: true });
  const pending = offline.ingest();
  await offline.engine.runUntilIdle();
  expect(offline.store.get('tasks', pending.id)?.status).not.toBe('delivered');
  expect(offline.store.list('receipts')).toEqual([]);
});
```

- [ ] **Step 2：确认红灯。** `npm test -- tests/integration/core-flow.test.ts`。
- [ ] **Step 3：逐阶段实现原子转换。** 每次 tick 读取当前 task/source/project；接纳提取→观察→初判，archive 只归档假设，ask 先研究，proceed 获取基线后规划。执行消费有效 plan；检查消费相同 artifact；repair 计数最多两轮；pass 才可 publishing；receipt 后 feedback，反馈和回送登记成功才 delivered。每步状态与动作同事务，副作用在事务外。
- [ ] **Step 4：实现等待与恢复。** awaiting_answer 不轮询模型、不自动选择；重启载入等待问题，答复只唤醒一次。blocked 保留 `blockedFrom/error/runAfter`；可恢复故障按退避重试，技术错误不转成人问题。重试先核对未决远端，撤回/版本变化取消旧动作，迟到 worker 不推进任务。取消后仍保留必须完成的外部对账。
- [ ] **Step 5：验证并保存。** 运行零问、A/B/C、重复事件、源更新/撤回、所有 runner 故障、通知离线、两轮返修、预算不足、反馈失败、重启、PR 后断网；每一用例断言业务效果数量。覆盖 R007、R010–R015、R048–R059、R064、R066、R072–R078。

## Task 11：飞书、MCP 与受管工具记忆

**状态：完成** — 飞书决策卡可以选择 A、B，或写下 C，并只续办原任务一次。真实飞书租户上的交互卡回执仍未单独验收。

**Files:** `src/integrations/feishu.ts`、`src/mcp.ts`；测试 `tests/unit/feishu.test.ts`、`tests/integration/mcp.test.ts`。

**Interfaces:** Feishu 实现 `NotificationAdapter`，消息入账后调用同一 `Workbench.answer/ingest`；MCP 查询受认证项目身份约束，提供 lookup、提问、按问题编号取答，不允许客户端自行扩大 scope。官方 SDK 承载平台通信。

- [ ] **Step 1：先测重复补读与未知项目。** 同一平台答复经实时和历史各投一次，断言续办一次、来源一条、案例一个；未知项目 lookup 返回空；未授权 tool/session 的问题号无法取答。
- [ ] **Step 2：确认红灯。** `npm test -- tests/unit/feishu.test.ts tests/integration/mcp.test.ts`。
- [ ] **Step 3：实现收发协议。** 验平台事件和 owner 身份，先收件持久化再响应，按水位补读且成功入账才推进；发送前持久化并按稳定 marker 查回执。文件来源主动私聊本人，工具消息关联原发起线程；切换通知独立于待答问题。
- [ ] **Step 4：实现记忆读写。** 受管 Codex 启动只取小量当前有效卡/版本/出处，结束只采获准新会话轮次，剥离注入正文；每次动作前重读当前出处。Cursor sessionStart 与 MCP 后续查询独立记录，不宣称未验证 hook 逐轮支持。
- [ ] **Step 5：验证并保存。** 单测不调用真实飞书；实际私聊、补读、离线通知、MCP 重连、工具确实引用唯一试点标识及撤回新会话均另记实链证据。覆盖 R005、R038–R043、R058–R059、R065–R066、R079。

## Task 12：SSR 工作台与 A/B/C 界面

**状态：完成**

**Files:** `src/app.ts`、`src/auth.ts`、`src/readiness.ts`、`src/web/`、`public/`；测试 `tests/e2e/workbench.spec.ts`。

**Interfaces:** 服务端页面只消费有权限的 TaskView；表单与 API 进入相同业务入口，不能在浏览器推进业务状态。导航路由 `/`、`/knowledge`、`/standards`、`/sources`、`/activity`、`/settings`；任务详情以可关闭抽屉展示，原生链接仍可访问。

- [ ] **Step 1：先测可见业务行为。** 固定种子应包含当前问题，不允许用 `test.skip` 代替 C 验收：

```ts
test('submits a custom answer without changing its original words', async ({ page }) => {
  await page.goto('/');
  const form = page.locator('.question-form').first();
  await expect(form).toBeVisible();
  await form.getByLabel('C · 我自己决定').check();
  await form.getByLabel('你的决定').fill('仅保留到下次成功导出。');
  await form.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.getByText('仅保留到下次成功导出。', { exact: false }).first()).toBeVisible();
});
```

- [ ] **Step 2：确认红灯。** `npm run test:e2e`；无当前问题/不可提交应失败，不跳过。
- [ ] **Step 3：实现页面与渐进增强。** 暖象牙白、森林绿、左栏六视图，三栏工作台区分处理/待答/结果，任务显示最后进展、理由、证据、旁侧技术故障。抽屉给七层轨迹和远端回执。A/B 冻结建议、C 文本框；提交失败保留输入，过期说明版本变化。轮询只读取，不生成任务。
- [ ] **Step 4：补齐可访问与安全行为。** 375/768/1440 宽无横溢；键盘打开/关闭抽屉与导航，焦点可见；纯 HTML 能查询/回答；空结果/无配置/故障/加载状态清楚。文本转义、会话/owner/scope/CSRF 校验，token 不入 DOM。demo 明显标识，演示 receipt 不伪装 live。
- [ ] **Step 5：验证并保存。** `npm run test:e2e` 全绿并记跳过数；检查真实截图与无 JS 流程；不要以单看首屏代替问答/知识/来源/设置验收。覆盖 R067–R070、R080。

## Task 13：本地运维、备份、网络与主机准入

**状态：未完成** — 备份和网络诊断代码已落地。launchd、restic 异机恢复和 VPN 仍未准入。

**Files:** `scripts/doctor.ts`、`scripts/backup.ts`、`scripts/report.ts`、`scripts/restore.ts`、`scripts/install-service.ts`、`src/integrations/network.ts`、`examples/`、`.env.example`、`docs/operations.md`。

**Interfaces:** `npm run doctor` 输出逐项真实就绪/缺口，不打印凭据；`npm run backup` 使用 `Store.backup()`；网络适配器只执行显式获准路径/命令，真实修复须单独准入。

- [ ] **Step 1：先写拒绝假就绪测试。** 未配置 Lima/runner/飞书/CI/研究网关时 doctor 显示未就绪；不给模拟数据标 live。假网络探测覆盖健康、DNS/路由错、TLS、认证失败、限流和 MFA；只有获准故障路径可重连。
- [ ] **Step 2：确认红灯。** `npm test -- tests/unit/network.test.ts tests/unit/operations.test.ts`。
- [ ] **Step 3：实现本地运行和备份。** launchd 模板使用明确 Node24 路径、同步目录外 dataDir、脱敏日志，主服务不依赖 IDE；SQLite 在线备份后 restic 加密每日异机。恢复先撤回/远端对账，吊销旧 writer 再接管，恢复时禁止双写入者。
- [ ] **Step 4：实现网络政策。** 分钟心跳，先网卡/DNS/路由/代理/TLS再对端，内网先企业 DNS/路由；故障路径锁、限次/退避/回退，修复后复验故障与原健康路径及心跳，再对账续办。企业分流、两启动顺序/并发/单路修复未全部通过，双 VPN 不准入；无合格路径挂起。
- [ ] **Step 5：记录边界。** `npm run doctor` 和 `npm run backup` 本地输出可证明脚本；Lima 当前未安装、VPN 命令/企业政策、异机备份和恢复仍需主机证据。覆盖 R070、R081–R094；没有远端 hosting 部署要求，不擅自部署。

## Task 14：禁写回放、复盘与后续角色

**状态：完成** — 漏问和误问仍保持未推断。

**Files:** `tests/integration/evaluation.test.ts`、`src/standards.ts`、`src/orchestrator.ts`、活动/规则视图、`docs/acceptance.md`。

**Interfaces:** 冻结来源截点、角色输入和预算，候选只读回放；报告偏好与业务结果分开，记录样本数/费用/维护分钟；规则生效仍由宿主当前证据约束。

- [ ] **Step 1：先写候选不达标不启用测试。** 构造候选只提高平均分却有一个关键越权或撤回泄漏的题集，断言不能试用；同预算修原错题、关键不退化、三种零容忍均零才可单产品试用。
- [ ] **Step 2：确认红灯。** `npm test -- tests/integration/evaluation.test.ts`。
- [ ] **Step 3：实现维护与规则复核。** 每周统计漏采/错引/漏问误问/交付/费用/维护，推一个真实反例；连续两周超过60分钟暂停扩源。每月同域留出题隐藏本人选择和事后结果，比较旧/候选及有出处行业方法，异常自动回旧并对账。
- [ ] **Step 4：声明扩展边界。** 开发运维从合并 PRD 触发同链、同提交测试/PR/MR/部署错误率/回滚；学习从获准书签/阅读信号输出解释/关联/反例/复核。未实际接入者在来源页列未覆盖，不能增加日常手工转发。memhub 混合检索只有真实漏搜样本后才在原预算只读对照，仍只返回卡 ID。
- [ ] **Step 5：验证并保存。** 禁写回放全绿；未来域仍标 F，不以接口存在冒称通过。覆盖 R032–R044、R051、R096–R105。

## Task 15：本地发布检查与真实首链验收

**状态：未完成** — 本地检查可以运行。真实首链交付仍未验收。

**Files:** `README.md`、`README.zh-CN.md`、`docs/operations.md`、`docs/acceptance.md`；不通过文档假装外部环境具备能力。

**Interfaces:** 交接证据按 E-CODE、E-DIRECT、E-ANSWER-A/B/C、E-FAULTS、E-MEMORY、E-OPS 结构写入验收清单；每条指向任务和真实对象。

- [ ] **Step 1：本地最终检查。** 按确切顺序执行：

```bash
node --version
npm ci
npm run check
npm run test:e2e
npm run doctor
```

`node` 应为 `v24.*`；`check` 的类型、Vitest、构建都成功；e2e 全绿并报告跳过；doctor 允许真实列缺口，不能用“退出码 0”代替全部 live 前提就绪。不改代码时无需重复同一已通过测试。

- [ ] **Step 2：登记真实前提。** 只用获准仓、PRD 路径、非空 trustedChecks/App IDs、本人飞书/历史权限、模型后台额度和逐角色备选准入、Lima/网络出口。默认示例 repo 是已确认的 `AlphaStrategyAI/PAtrick`、路径 `docs/product/PRD.md`；`validate` 与示例 GitHub Actions App ID `15368` 必须从实际 API 检查确认后启用自动合并。
- [ ] **Step 3：先做预期失败门禁。** 在获准试点提交故意不通过必需检查，证明当前 head 无法合并；复核 App/head 后修正再继续。不能为验收删除分支保护或绕过人审。
- [ ] **Step 4：做真实零问和只答一次。** 关闭 IDE/Obsidian/工作台，从文件修改开始各完成一次，收集七层、实际角色、双语研究/问答（需要时）、当前 head CI、合并 SHA、正式文件读回和反馈/回送；A/B/C 分别恢复原题。
- [ ] **Step 5：故障、记忆、恢复验收。** 逐角色首选故障、通知离线、全不可用、漏文件、重复答复、PR 后断网；重放副作用一次。真实精确引文/同源/观察与原则/撤回重建、工具唯一标识、在线备份恢复、获准 VPN 路径分别存证。
- [ ] **Step 6：报告完成范围。** 勾选有证据的 C/L/O/F 子项，列未覆盖来源/动作/领域；外部前提欠缺保留未就绪。36/52/82/100 工时点是修复优先级和投入边界，不能代替真实通过。覆盖 R071–R080、R093–R105。

## 需求覆盖与执行交接

- T1/T2/T3 覆盖 R001–R015、R023–R025、R050、R052、R070、R085–R086。
- T4/T5 覆盖 R016–R036、R040–R042、R064、R066、R080。
- T6/T7 覆盖 R017、R028、R045–R059、R075–R076、R081–R083、R093。
- T8/T10/T11 覆盖 R005、R007、R010–R015、R038–R043、R048–R066、R072–R079。
- T9 覆盖 R006、R047–R050、R057、R074–R079；T12 覆盖 R067–R070、R080。
- T13 覆盖 R070、R081–R094；T14/T15 覆盖 R032–R044、R051、R071–R080、R093–R105。

执行者按任务推进；已在并行写出的代码先对照测试补差距，不重复覆盖。每项到达可独立审查的行为后再进入下一项。当前父任务已经授权本会话实施，无需再次询问执行方式；新的会话可选择按任务内联执行或按明确所有权分工，遵循当时授权。未找到外部前提不妨碍完成本地代码与文档，但不能勾选实链验收。
