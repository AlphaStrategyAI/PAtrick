# Obsidian Desktop 与 Vault 部署

当前准入状态：隔离文件夹和账本的部署及文件往返可复验；现有桌面应用签名、公证、默认 URI 处理器和已锁定 DMG 的临时安装已核验。2026-11-17 已在操作者选定的当前账户中完成合成 Vault 的桌面界面保存、编辑器退出后的补采和演练进程重启后的继续补采。独立服务身份、生产 launchd、macOS 重启及升级/卸载保留仍未准入。Obsidian 桌面状态与已登记 Vault 的后台状态分别报告。

## T23 接入

新构建的完整部署包使用 v4／v5 材料清单，要求 Vault kit 的清单和七项模板及视图齐备。签名与安装读回覆盖这八个文件。迁移到独立目录后，服务从签名包读取这些文件，用于安装 kit、创建草稿和生成采纳视图。旧签名包按其材料清单版本验签，`runtime-only` 使用原资源路径。更新 kit 时，在同一提交更新清单及部署资产摘要。

登记 `patrick init` 时，宿主控制器可在 `withPublishedDeployment` 验证通过后登记 `publishedKit`。登记绑定发布目录身份、控制器 UID、资源根身份和清单摘要。预览、执行与读回检查这个登记及资源摘要，再由 Service 执行 Vault 写入。

- `deploy/obsidian/doctor.mjs` 提供 `inspectObsidian(deviceId)`。默认只检查本机 hostname；如部署使用独立的设备 ID，应由受信本机配置将 ID 与本机绑定，使用 `createObsidianInspector` 绑定 `readMacObsidianState`。探针不打开应用。应用、版本、签名、安装器 SHA-256 锁、LaunchServices 默认 URI 处理器及进程状态是独立事实。
- `createObsidianDoctor` 复用 T06 的 `loadVault`/`inspectVault`。以明确登记的 service UID、editor UID 和 capture host 调用，核对本地根身份后报告 Reader/DraftWriter/Projector 各自权限、剩余磁盘空间，及通过 `createVaultActivityReader(db)` 取得的最近来源修订和导回指针。`allowed` 是当前身份的文件权限预检；完整往返仍须实测。当前只接受服务与桌面编辑共用同一个已核验的 UNIX UID；独立账户即使声明组或 ACL，也必须先增加双身份查验，不得猜测。
- 向本人展示报告中的作用域：人工区只读，知识/标准草稿只准新建，系统区是生成视图。绑定由部署配置提供受信的 `vaultId`、`deviceId`、本机 Vault alias 和映射版本，并使用 T06 已确认的配置证明。缺少映射、版本不符、应用未准入或 URI 未登记时，`obsidianEditTarget` 仅提供隔离在 Vault 中的相对路径。URI 打开不是保存回执。
- `createVaultKitInstaller({ deviceId, captureHost, serviceUid, editorUid, loadVault, inspectVault }).installVaultKit(vaultId)` 只接收已登记 Vault ID。设备、作用域或根身份变化时重新审阅。安装只补缺项；模板和索引样例写完并核验后才发布版本化清单。本人旧模板允许与发行 hash 不同，收据保留实际 hash 和 `preserved` 状态。只有 kit 新建并记录 inode、内容 hash 和接通范围的索引样例可被首个投影替换；本人索引，即使与样例内容相同，或本人修改过的样例产生命令冲突，原样保留。
- 暂存使用系统临时根和 Vault 内保留的隐藏 `.patrick-staging`；两处都不是采集目录。部署期间独占这些管理目录，避免人为或同步器并发搬移。中断后先重跑，不能拿现有 Vault 目录整体覆盖或清除。若已写入种子索引但缺少来源证明，安装返回 `KIT_INDEX_PROOF_REPAIR_REQUIRED` 并保留原件，交由本人核查；不能按样例内容猜测来源。若投影索引已发布但 SQLite 尚无指针，只在当前接通范围、待处理意图、索引文件身份与整个批次字节都匹配时补记原指针。由管理员在确认服务和安装进程都停止后，离线复查并清理对应的废弃暂存文件。

## 首次安装及设备验收

1. 只在获准的目标 Mac 上部署。用 [Obsidian 官方 macOS 安装配方](https://obsidian.md/help/install) 获取已锁定版本的 Universal DMG。先独立建立可信 SHA-256，再用 `verifyObsidianInstaller` 比对本地文件，禁止缺锁或不匹配时继续。经明确批准后，`createMacObsidianInstaller().install({ dmgPath, lock, authorizedDestination: "/Applications/Obsidian.app" })` 使用核验过的私有 DMG 副本进行只读挂载，分别检查源与暂存副本的 Bundle ID、版本、两种 Mach-O 架构、深度签名和 Apple 锚定的 Obsidian 签名。卸载镜像成功后才发布到该精确地址；拒绝覆盖已存在应用。若镜像未能卸载，为防止删除已挂载卷，保留临时挂载目录供授权管理员排查。DMG hash 合格不等于挂载后应用签名合格。
2. 为每个资料域选单独的获准目录，确认没有嵌套 Vault、没有放进应用数据目录。业务库、SQLite/WAL、blob、凭据、执行器目录及恢复集放在 Vault 和同步根之外。由部署层确认 T06 作用域后，以实际服务账户运行 kit 安装及 doctor；隔离试验不计入业务指标。
3. 在 Obsidian 的桌面会话里以隔离目录打开 Vault，在设置中按需启用 Properties、Templates、Bases、Backlinks/Graph、Canvas。复查恢复的本机别名和 URI 处理器，用带中文、空格和 `#` 的样例验证可打开指定文件。
4. 创建知识笔记及标准稿，保存后记录准确来源修订、标准候选和导回批次；没有验证及采纳证据时不得替换生效标准。关闭 Obsidian 后修改隔离样本，确认实际服务进程继续补采；重复验证服务重启与服务权限不足。读取模板和原稿 hash 确认内容未变。升级前保存原稿、附件及 kit manifest，升级后重复验收；卸载应用或服务时默认保留 Vault 和业务数据。
5. 未配置时 doctor 报告同步状态未知；安装配置可明确登记单设备。Baidu 网盘与 Obsidian Sync 各需独立资料域许可，再验证离线、占位文件、改名和冲突，只选一种。这里没有启用同步，也没有验证任一同步供应商。

## 本机观测（T27）

- 测试主机：macOS 27.2.1 (26B131)，arm64；开发机探针，不是已登记的 Mac mini 服务身份。
- `/Applications/Obsidian.app` 存在：`plutil` 报告 1.15.1，`file` 报告 x86_64、arm64 Universal。系统 LaunchServices 的只读查询将 `obsidian://open` 解析到 `/Applications/Obsidian.app`，确认了当前默认处理器。查询未启动应用，也没有验证 Vault 打开或保存。
- 本人确认现有应用来自 Obsidian 官方 GitHub 安装包。主机上的只读复查 `codesign --verify --deep --strict --verbose=3 /Applications/Obsidian.app` 退出 0，输出 `valid on disk` 和 `satisfies its Designated Requirement`。早期沙箱检查曾报告 arm64 签名无效；两者范围不同，应以主机复查作为已安装签名证据。主机上的 `spctl --assess --type execute --verbose=4` 同样退出 0，并报告 `accepted` 与 `source=Notarized Developer ID`。未改变安装器签名或哈希政策。
- 官方 [GitHub 发行记录](https://github.com/obsidianmd/obsidian-releases/releases/tag/v1.15.1) 的 [资产 API](https://api.github.com/repos/obsidianmd/obsidian-releases/releases/tags/v1.15.1) 为 `Obsidian-1.15.1.dmg` 发布了 SHA-256 `e05c7e3e2262b14c965bb246dcb74a30fc9098bd669e42957c4d9f788d04fdf4`，大小 233346990 字节。2026-11-17，本机安装包与两项一致，`hdiutil verify` 通过。DMG 容器自身未提供 Gatekeeper 可用签名；核验对象是已锁定镜像内的应用。
- 同日使用安装配方，在新建的临时应用目录完成只读挂载、复制、卸载镜像及发布，现场验证版本、双架构、Apple Developer ID 和已公证状态。第二次安装按预期拒绝覆盖。临时应用随后清除。生产目录未更改，测试未启动 Obsidian，也未访问任何 Vault。
- 目标环境的完整准入还需要获准的 Mac 桌面会话、专用隔离 Vault/账本、获准的部署服务 UID 和设备映射。用该环境补做真实编辑、后台补采、重启、升级/卸载保留及可选同步验收。隔离自动测试不证明 GUI 或后台常驻已通过。

## macOS 测试登录的 GUI 与后台演练

先确认测试登录短名和数字 UID，再在该登录的前台桌面开 Terminal。优先使用独立账号。如果操作者明确选择当前登录，只在合成 Vault 中测试，并由操作者控制何时切换和退出 Obsidian；这不证明账号间的权限隔离。两种方式都不使用个人或公司 Vault、同步账户、生产 token 或应用凭据。把本仓库及依赖放入该登录可用的独立开发目录；不要使用 sudo、修改其它账号的文件权限，或复制现有 Vault。脚本核对真实 UID、有效 UID、短名和前台桌面登录。写目录前检查规范主目录及其祖先，禁止在既有 Vault 内创建演练。每阶段在读写前重新核对隔离账本 inode、Vault 根及其 inode、账户、资料域、采集主机与隔离目录。它只支持服务演练进程与测试桌面共用一个非 root UID；独立服务 UID 的生产权限仍需验证。

macOS 默认 zsh 示例。填入操作者事先确认的短名和 UID。脚本不会自动选择账号：

```zsh
T27_TEST_USER='<已确认的测试账号短名>'
T27_TEST_UID='<该账号数字 UID>'
T27_ARGS=(--test-user "$T27_TEST_USER" --test-uid "$T27_TEST_UID" --service-uid "$T27_TEST_UID")
node deploy/obsidian/rehearsal.mjs init "${T27_ARGS[@]}"
```

1. 记录输出的 `sessionId` 并设为 `T27_SESSION`。生成目录固定在测试登录的 `~/PAtrick-T27-Rehearsals/<sessionId>/` 内，Vault、SQLite、blob、隔离目录和暂存路径分别独立。查看输出中的 `vaultPath` 和 `guiEdits`。脚本不启动、退出或切换 Obsidian；在**测试桌面**手动打开已验证的应用，选择“打开文件夹为仓库”，只选这次新生成的目录，不开启同步。
2. 在终端 A 启动 `editor-open`。等看到“正在等待”，在 Obsidian 源码模式打开指定的两个文件，分别在原文末尾留一个空行，逐字粘贴对应标记并保存。确认含中文、空格和 `#` 的笔记路径，随后在 GUI 中确认系统索引和候选投影。若需验证 URI，先在同一测试登录中核对本机别名，再由操作者打开受控 URI。收据保留 `manualGuiSave: operator_confirmation_required`；AppKit 观察和文件变化不能证明 GUI 写入来源。
3. 手动完全退出这个测试登录的 Obsidian。终端 A 跑 `editor-closed` 并等待，终端 B 运行对应 `sample-save`。它只向此次合成笔记追加固定标记。观察进程读取实际文件、提交 SQLite 修订并导回；收据区分开始与收集时的桌面进程状态。已验证的 Obsidian bundle 路径、AppKit PID 与按测试 UID 核对的进程 PID/可执行路径需要一致；打不开探针或结果矛盾时不出具通过收据。停用编辑器阶段另外记录合成写入者和活动观察者的进程身份、阶段、写入时间及前后 hash；仅靠复制标记不能冒充停用写入证据。
4. 前一观察退出后，在终端 A 启动新的 `after-restart` 观察，在 B 执行对应 `sample-save`。这验证演练进程重启后继续使用同一隔离账本，不代表生产 launchd 常驻已验证。如果另行获准并确实完成了主机重启，回到同一测试桌面，保持 Obsidian 退出，再运行这一步；只有 `bootComparedToPrior: changed` 才记录为不同 macOS 启动会话，`unchanged` 和 `unknown` 不能证明重启。

```zsh
# 两个终端都先设置相同的 T27_ARGS 和 T27_SESSION。
T27_SESSION='<init 返回的 sessionId>'
node deploy/obsidian/rehearsal.mjs watch "${T27_ARGS[@]}" --session "$T27_SESSION" --phase editor-open --seconds 180

# 在测试桌面手动退出 Obsidian 后，终端 A：
node deploy/obsidian/rehearsal.mjs watch "${T27_ARGS[@]}" --session "$T27_SESSION" --phase editor-closed
# 等 A 显示正在等待，终端 B：
node deploy/obsidian/rehearsal.mjs sample-save "${T27_ARGS[@]}" --session "$T27_SESSION" --phase editor-closed

# 第三阶段，终端 A（新进程）：
node deploy/obsidian/rehearsal.mjs watch "${T27_ARGS[@]}" --session "$T27_SESSION" --phase after-restart
# 等 A 显示正在等待，终端 B：
node deploy/obsidian/rehearsal.mjs sample-save "${T27_ARGS[@]}" --session "$T27_SESSION" --phase after-restart

node deploy/obsidian/rehearsal.mjs status "${T27_ARGS[@]}" --session "$T27_SESSION"
```

每阶段把 `evidence-<phase>.json` 写在 Vault 旁边。收据记录 `vault_revisions.revision_id`、观察序号和实际原始字节 SHA-256；可按 hash 找到 `blobs/<前两位>/<完整 hash>` 并复核。候选记录指向 T07 的开放候选，没有采纳或外部调用。导回记录给出 T06 的真实批次和指针、manifest SHA-256 与本阶段索引 hash。此前批次由 T06 放入本会话的隔离目录；历史收据不是当前状态。可用 `sqlite3 -readonly <databasePath>` 查询 `vault_revisions`、`standard_candidates`、`projection_batches` 与 `projection_pointers` 独立核对。没有收据、只做过自动 fixture 或未经操作者确认的 GUI 步骤不可记为真机通过。观察被中止或只完成部分阶段时，保留原会话供复核，用 `init` 新建合成会话重演，无需覆盖或删除任何已有 Vault。

此演练不改系统权限或卸载程序。真实账号权限不足（包括独立服务 UID 或 macOS 审批拒绝）和卸载后 Vault/账本保留，仍需另行获准的隔离真机验收。


## 2026-11-17 当前账户原生演练记录

操作者最终选定 `fengpengcheng`（UID 501），与前台桌面 UID 一致。本次使用新建的 `~/PAtrick-T27-Rehearsals/t27-82633658-936d-46dc-ad32-adafbe569121/`，其中 Vault、SQLite、blob、暂存和隔离区分别独立，服务演练进程与编辑器共用 UID。合成 Vault 名为 `PAtrick T27 adafbe569121`，编辑器为已验证的 `/Applications/Obsidian.app` 1.15.1。

| 阶段 | 实际观察 | 账本及导回 |
|---|---|---|
| `editor-open` | 观察进程 41043 等待后，通过 CUA 原生界面以源码模式在中文/空格/`#` 笔记及标准修订末尾追加各自标记并保存；GUI 读到索引修订 1 及“合成候选（未采纳）” | 两份原稿各入第 2 修订；批次 1 已应用 |
| `editor-closed` | 界面退出 Obsidian；开始与收录时均核对编辑器进程不存在；独立写入进程 41617 在观察进程 41515 等待后追加固定标记 | 知识笔记第 3 修订；同一开放候选；批次 2 已应用 |
| `after-restart` | 新观察进程 41991 与前次 `processInstance` 不同；写入进程 42073 在它等待后追加下一标记，编辑器持续退出 | 知识笔记第 4 修订；同一开放候选；批次 3 已应用 |

独立只读复核 `PRAGMA quick_check` 为 `ok`，四份归档修订均与 blob 的 SHA-256 一致，候选始终 `open`，三份批次 manifest 与已应用账本相符。结构化摘要与原始回执摘要见 [原生演练证据](evidence/obsidian-native-2026-11-17.json)。原始 `evidence-*.json` 及停用写入收据留在上述专用会话目录。后续导回可能将旧批次移入本会话隔离区，历史收据不代表旧文件仍在活动生成区。

GUI 保存由 CUA 执行并从原生无障碍树读回，没有伪造人工确认；原始回执的 `manualGuiSave: operator_confirmation_required` 保持原样。三阶段 macOS boot ID 相同，`freshWorkerProcess: true` 只证明演练进程已重新启动，不能据此声称主机重启或生产常驻服务通过。独立服务 UID、权限拒绝、URI 打开、升级/卸载保留和同步仍需后续验收。

首次会话 `t27-79f1310c-ccfd-4a50-af03-73af6f008001` 因 CUA 粘贴多出一行空行触发精确格式拒绝，未生成通过回执，现场保留。切换会话时误选 Downloads，产生的 `.obsidian` 设置经创建时间、文件列表和逐项摘要核对后移入本次演练目录留存，并只撤销该次新增 Vault 登记；未打开或编辑 Downloads 文档。成功会话另行新建，未放宽脚本的身份或内容校验。

## 2026-11-18 隔离配置下的 URI 检查

在同一 `fengpengcheng` 登录和上述合成 Vault 上，使用独立临时应用资料目录启动官方 Obsidian 1.15.1。临时目录仅登记该合成 Vault。macOS 的 `obsidian://open` 处理器接收到中文路径的 URI，带中文目录的 `标准修订/native-rehearsal.md` 成功打开，原生界面标题及合成正文均可读回。

同一入口对 `知识笔记/演练笔记 #1.md` 将井号编码为 `%23`。系统成功投递 URI，Obsidian 保持在之前的标准文稿，目标笔记未打开。把井号双重编码后也未打开。从同一 Vault 的文件列表选择该笔记可以正常打开，界面读回全部合成阶段标记。应用在此版本将解码后的井号作为子路径分隔符处理，当前普通 URI 无法作为该文件的成功打开证据。

验收前后合成笔记的 SHA-256 相同，普通应用资料目录中 `obsidian.json` 的摘要也相同。测试后正常退出应用。初次尝试附加文件访问沙箱时，应用子进程无法初始化自己的沙箱，启动失败；成功的观察使用独立资料目录和应用自身的正常进程沙箱。测试记录在 [URI 观察摘要](evidence/obsidian-uri-2026-11-18.json)，原生访问树观察和应用日志保留在本次执行记录中。含 `#` 文件名的 URI 处理仍待兼容方案，主机重启、独立服务身份和升级/卸载保留仍需验收。

## macOS 双账号权限实测

在获准的 Apple M1 MacBook Pro（macOS 27.2.1，`26B131`）上，使用 `ac7fe49` 的运行时代码与 Node `v26.13.0`，以管理员权限执行 `tests/admission/T27-native-access.test.ts`，通过 1 项。合成 Vault 位于独立临时目录。测试中独立 Service UID 65 使用实际 Vault API 发布索引和批次，并以仅新建方式发布标准草稿。桌面 UID 501 通过 Darwin ACL 读取全部投影文件并就地编辑草稿。投影写入和删除、草稿删除、暂存目录访问与私有 SQLite 库读取均被拒绝。测试日志 SHA-256 为 `10625c99486c1ef211d99afbd035c522cc959833bb19920e010879425845171e`。

本次使用桌面身份的独立进程验证文件权限。正式 `vault-init` 和 kit 安装器仍要求编辑者与 Service 共用 UID。独立 UID 下的正式 kit 安装、Obsidian 保存、补采和卸载保留仍待验收。

在同一台目标 MacBook Pro 上，将 `PATRICK_T27_SERVICE_USER` 设为系统 `launchd` 登记的 Service 账号，以 UID 402 和桌面 UID 501 重跑权限用例，1 项通过。合成 Vault 中的投影读取、草稿编辑和越权拒绝均通过。正式 kit 安装、桌面应用保存和退出后的后台补采仍待实测。

2026-11-26，桌面 UID 501 在 Obsidian 1.15.1 中保存由 Service UID 402 创建的合成标准草稿。Service 演练进程复核了草稿与归档 blob 的字节摘要，创建开放候选并发布投影版本 1。Obsidian 显示了该版本的生成索引。

退出 Obsidian 并确认进程结束后，桌面账号向合成笔记追加标记。独立的 Service 演练进程采集了新修订，核对磁盘与归档 blob 摘要一致。版本 2 的批次目录已生成，但投影返回 `failed`，索引指针仍为 1。正式 kit 安装、常驻 Service 的补采和卸载保留仍待验收。[双账号桌面演练回执](evidence/t27-dual-uid-desktop-2026-11-26.json)

演练现场的 Vault 父目录由桌面用户持有，Service 仅可穿越，同级 `isolation` 目录缺失。本机集成测试复现了这种目录条件。版本 2 保留版本 1 的指针和旧批次字节。预建归档目录后，在父目录仍不可写的情况下重试同一请求，指针推进到 2，旧批次字节在归档中完整读回。`doctor` 将归档位置纳入 Projector 权限检查，报告实际 Service 身份能否创建归档或写入已有归档目录。双账号现场仍需要回放验证。
