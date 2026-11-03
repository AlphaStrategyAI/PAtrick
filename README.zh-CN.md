# PAtrick

PAtrick 把项目证据、你的明确决定和可核交付连起来。第一条工作链是：你在一个产品的 `productIdeas` 中正常修改想法，它把有依据的验收条件补入正式 PRD；确实需要你取舍时，只问一个有证据的问题，答复后自动续办原任务。

[English](README.md) · [运行手册](docs/operations.md) · [主机部署](docs/deployment.md) · [界面设计](DESIGN.md) · [详细设计](docs/designs/PAtrick详细设计.md) · [验收证据](docs/acceptance.md) · [验证报告](docs/test-report.md)

工作台分“正在处理／等我回答／建议与结果”三栏，并提供知识、判断标准、来源、活动和设置视图。任务抽屉把原文、来源修订、worker 尝试、问题版本和交付回执放在一起。

![PAtrick 本地演示工作台](docs/screenshots/workbench-desktop.png)

项目使用 Node.js 24、TypeScript ESM、Hono 服务端 HTML、普通渐进 JavaScript/CSS、better-sqlite3/FTS5、Zod、Vitest 和 Playwright。宿主管理权限、状态和写入；worker 只提交候选或隔离产物。模型说“完成”不能代替 CI、合并和文件读回证据。

## 本地体验

```bash
nvm use 24
npm ci
PATRICK_HOST=127.0.0.1 PATRICK_DATA_DIR=/tmp/patrick-demo PATRICK_VAULT_DIR=/tmp/patrick-demo/vault npm run demo
```

打开启动日志中的地址，默认端口是 `4317`。这条命令显式使用独立临时数据目录。演示使用样例材料、回放 worker 和模拟交付，不修改远端仓库。样例回执不等于 GitHub、飞书或模型实链已通过。Playwright 使用另一个 demo 服务和 `4318` 端口。

未传 `--demo` 或 `PATRICK_MODE=demo` 时默认为 live。能打开页面、本地测试通过、外部前提就绪和真实任务验收是不同结论；以 [验收清单](docs/acceptance.md) 记录为准。

## 配置真实工作空间

把 [.env.example](.env.example) 复制为私有 `.env`，以 [示例配置](examples/patrick.config.json) 为起点。示例中的 `autoMerge` 为 `false`，所有 worker 的 `admitted` 为 `false`，不会因复制文件就获得外写权限。来源目录、本人身份、模型/提供方、费用和 Lima 实例必须换成已核验值。

试点目标为已确认的 `AlphaStrategyAI/PAtrick`，只允许写 `docs/product/PRD.md`，预期必需检查名为 `validate`。示例 `trustedAppIds: [15368]` 是 GitHub Actions 的示例 ID，启用自动合并前必须从实际仓库 API 确认检查的 App ID、当前 PR head 和合并政策。仓库要求独立人审时不能绕过。

数据库、WAL、凭据和活动运行状态放在同步目录外。macOS 默认数据目录是 `~/Library/Application Support/PAtrick`；自定义 `PATRICK_DATA_DIR` 时使用绝对路径。HTTP 入口会读取当前目录的 `.env`；其他入口也可统一显式加载：

```bash
node --env-file=.env --import=tsx src/index.ts
```

生产构建：

```bash
npm run build
node --env-file=.env dist/index.js
```

本地 live 未设置 `PATRICK_TOKEN` 时，启动会在数据目录生成权限受限的 `access-token` 文件，私下读取后在 `/login` 登录。也可自行生成并写进私有 `.env`：

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex') + '\n')"
```

`PATRICK_SESSION_SECRET` 可单独设置，省略时使用访问令牌。非回环监听必须预先提供至少 24 字符的 token，并通过认证私网访问。网页使用 HttpOnly 会话；API 使用 `Authorization: Bearer …` 头。不要把 token 放进 URL、任务材料、截图或 Git。

## live 的前提

- 已授权仓库、准确允许路径、非空必需检查与可信 App 列表，以及允许相应合并方式的仓库政策。
- 按角色、数据域、模型/提供方、工具权限和费用逐一准入的后台 runner；自动切换至少需要一个已准入备选。
- 执行主机上的 Lima，移除默认主机挂载、禁 SSH agent 转发、限制出口及会话上传，仅交付任务材料。本次检查的主机尚未安装 Lima，真实 worker 仍需安装及准入。
- 飞书应用、本人 Open ID、私聊 Chat ID、可信回调与历史补读权限。
- 获准双语检索网关；宿主实际查询中英文，并独立打开公开 HTTPS 原文。完整请求格式见 [运行手册](docs/operations.md#search-gateway-contract)。
- 已授权网络路径、异机备份及恢复接管流程；不确定的远端副作用先对账再重试。

默认分工是 Grok 整理知识、提取案例及初判，Codex 规划，Grok 执行，Codex 检查和反馈，各角色按准入名单自动换手。问题恰好 A 首选、B 第二建议、C 自己决定；等待本人时释放 worker，不自动代选。最多两轮返修，需求或基线变化重新规划/检查。

只有绑定同版需求与产物的检查、当前 PR head 的可信必需 CI 全部成功、实际合并及按 merge SHA 读回正式文件，才能支持交付。反馈基于真实回执。写入器在外写前重验权限与路径，网络结果未知时先查远端。

## 开发与验证

```bash
npm run dev
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
npm run check
```

`check` 包含类型检查、Vitest、构建与正式 PRD 结构检查，浏览器测试单独运行：

```bash
npx playwright install chromium
npm run test:e2e
```

Playwright 按配置启动 demo 服务；不要把无关的现有 `4318` 服务当成验证证据。记录失败和跳过数量。本地禁写回放不能替代真实零问交付、只答一次交付和故障恢复验收。

其他入口：

```bash
npm run doctor
npm run backup
npm run report -- patrick
npm run mcp
```

`doctor` 反映配置及本机能力，不能证明远端合并、后台订阅额度或企业网络授权。`report` 读取运行中宿主的项目周报，费用是保守预留值，不能当作提供方账单。[运行手册](docs/operations.md) 包含显式加载私有环境、备份和 MCP；[主机部署](docs/deployment.md) 说明 `restore`、`install-service` 及其 `service` 别名。

stdio MCP 连接已经运行的 HTTP 服务，在私有客户端环境设置 `PATRICK_URL`、`PATRICK_TOKEN`、`PATRICK_MCP_PROJECT`、`PATRICK_MCP_DOMAIN`。工具为 `lookup`、`ask`、`get_task`、`get_answer`、`record_conversation`，按绑定项目工作。

## 代码与文档

`src/domain.ts` 定义共享契约；`store/intake/knowledge/standards` 管理账本、修订、检索和本人标准；`scheduler/orchestrator/integrations` 负责角色与外部边界；`src/app.ts`、`src/web/`、`public/` 提供认证 SSR 与交互；`scripts/`、`examples/` 提供本地运维与 [launchd 模板](examples/launchd/README.md)。

[技术方案](docs/designs/PAtrick技术方案.md)、[实施计划](docs/plans/2026-11-03-patrick-implementation.md)、[正式 PRD](docs/product/PRD.md) 分别保存来源要求、计划和试点产出；105 条要求及分层证据见验收清单。

当前交接范围是本地运行和 launchd 运维，没有要求公共托管部署。开发运维、学习及更多来源可沿同一契约扩展，但需分别真实验收。无自动入口的来源应显示未覆盖。

使用本机系统字体，不分发专有字体文件。引入第三方源码时保留许可证、固定来源及改动说明。许可证见 [LICENSE](LICENSE)。
