# Obsidian Desktop 与 Vault 部署

当前准入状态：隔离文件夹和账本的部署及文件往返可复验；现有桌面应用签名、公证和默认 URI 处理器已核验；真实桌面写入、安装包和部署服务身份未准入。Obsidian 桌面状态与已登记 Vault 的后台状态分别报告。

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
- T00 的 Universal installer 版本是 1.15.1，`packageHashSha256` 为空。本次没有取得或安装 DMG，也没有打开任何已有或真实 Vault。
- 真实准入需要本地路径明确获准的、Apple 签名通过的官方 1.15.1 Universal DMG 和独立记录的 SHA-256，以及目标 Mac 桌面会话、专用隔离 Vault/账本、获准的部署服务 UID 和设备映射。用该环境补做真实编辑、后台补采、重启、升级/卸载保留及可选同步验收。隔离自动测试不证明 GUI 或后台常驻已通过。
