# Obsidian Desktop 与 Vault 部署

当前准入状态：隔离文件夹和账本的部署及文件往返可复验；现有桌面应用签名、公证、默认 URI 处理器和已锁定 DMG 的临时安装已核验；真实桌面写入与部署服务身份未准入。Obsidian 桌面状态与已登记 Vault 的后台状态分别报告。

## T23 接入

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
