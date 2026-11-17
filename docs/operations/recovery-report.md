# T22 RecoverySet 与隔离恢复记录

记录日期：2026-11-17。工作目录：`.worktrees/impl-patrick-plan`。本记录覆盖恢复模块与真实临时 SQLite 数据库的本地验证。恢复库第三轮独立复审已通过（Spec PASS / Quality APPROVED），R1 在受支持的异步替换边界关闭，R2 及 C1/C4/H1/H2 的库内关闭结论保持有效；独立远程见证、真实主机 fencing、生产加密备份目标和设备灾难演练尚未验收。

## 已实现的本地行为

`createRecoveryBackup(...).captureRecoverySet(scope)` 在冻结租约内将未决效果记为 uncertain，通过 better-sqlite3 原生 `backup()` 分别导出服务库和 Hub 库，核对前后水位、快照水位、schema 历史与 SQLite 完整性，再捕获显式登记的 Vault、blob、持久交接、vault-kit 和版本锁资源。人工稿、附件、编辑基线/意图/回执、冲突、咨询、渠道、委托、评测与业务关联包含在数据库及登记资源中。缺 blob、缺 Vault、历史撤回未成完整链或保护未确认时写明完整性缺口。

RecoverySet 使用独立注入的签名端口签出 manifest。恢复验证签名、严格字段、文件相对路径、哈希、长度、版本锁和两库水位。拒绝符号链接和路径穿越；恢复复制后的文件再次核对哈希，数据库复制/哈希以原生文件复制和流式读取完成。完成校验前目录保持 pending，不发布为完整集合。目录/文件权限分别限制为 0700/0600。

两库为整体快照，scope 必须列出其中所有实际资料域。若共享库含 company 数据而 scope 只含 personal，捕获会拒绝；不能将这些字节交给仅获准保存 personal 的备份目标。资源根必须由主机可信配置提供，不接受 HTTP 请求指定任意目录。

`createRecoveryRestorer(...).restoreRecoverySet(setId, mode='drill')` 默认建立独立演练目录，不连接同步器，不调用任何外部发送方法。它验证两库/manifest，核对独立见证与完整撤回链，保护幸存 Vault 文件，再按实际 SQL 意图逐项调用只读对账端口并重建投影。遇到不同原稿时保留幸存原稿，旧备份稿单独留在 conflicts；不会覆盖幸存源目录。

备份将每个已登记 Vault 的身份、账号、来源、原始规范物理根和资源前缀写入签名清单，并与数据库快照注册逐一核对；无关同域目录不能代替登记 Vault。同域多个 Vault 按各自身份散列映射到不同隔离根，空 Vault 也保留目录；幸存文件须绑定准确物理根和可选 Vault ID。恢复后的 Vault 映射改为隔离目录，状态为 not_connected；源配置暂停、移除凭据引用并保存新的暂停版本。旧 Web 会话、挑战和 bootstrap ticket 失效；旧 grant 撤销，旧 resume 队列不复活。飞书进入 requires_reauthorization/disabled，采用新的密码学随机安全整数 incarnation，更新 epoch/绑定版本，移除当前配对/测试/owner/chat/凭据引用。旧配对和测试失效，旧 permit 终结，未决通知隔离。原状态保存在 `recovery_quarantined_records`，原始备份仍完整保留。真实旧回调只能得到 audit_only；旧测试回调被现有门禁拒绝。

阶段回执同时持久化到恢复库和受限目录，记录计时、冲突、逐域阻挡原因、activationId 及 epoch。恢复阶段不重发 PR、答案、通知、测试或其他外部效果；`external_writes` 为 0。复核咨询和不确定效果保留原有事实及交接证据，读回不确定就保持阻挡。

## 独立见证与撤回保护

`RecoveryWitnessPort` 要求独立权威目标、线性一致读和精确 revision CAS。它只持有控制记录：domain、writer epoch/identity、open/sealed、撤回 seq/hash、交接证书、activationId 和前一 sealed revision。没有使用恢复库中的 SQL 伪装见证；默认缺端口或缺证书验证即返回 unconfirmed。

候选只能以当前封存 revision 执行 sealed → open，生成新随机 epoch。CAS 成功或响应丢失后都必须从权威目标读回自身 activationId、新 epoch 与父封存 revision。竞争者只会有一个 acquired；旧 revision、其他获胜 ID、open 状态及不可达见证都不能获得新写权限。

`0023_recovery.sql` 在原撤回写事务中由触发器建立 durable pending 项并把本地域置为 protection_pending；历史撤回也进入待核定队列。`createRecoveryWithdrawalJournal(...).protectPending` 先形成完整有序 hash 链，调用独立撤回日志的持久写入/读回，再 CAS 推进权威见证水位并权威读回。仅此后才标 protected，并继续保持 blocked，等待正常准入。外部工具启动成功不等于撤回保护确认。

恢复应用的是完整独立日志，保留原 event ID、版本、epoch 和链，并核对备份水位是当前日志的前缀。若补采或对账过程中出现新的未保护撤回，先前的开放证据失效，禁止领取 epoch。

真正开放还要求封存证明、当前旧写者停止且写凭据撤销的独立 fencing 证明、完整撤回、新稿保护、全部对账，以及获胜 epoch 的实际运行时安装和门禁读回。没有 `activation.enableDomain` 时不会尝试 CAS，也不会开放。实际安装前先持久化关闭的激活代次与精确对账切面；安装和注入回调后重新读权威见证，最终在无回调的 immediate 事务内同时比较 gate、代次、见证和两库切面，再发布准入及权威回执。更新的撤回或后续意图变化会保持关闭；失败会条件撤销旧准入能力，并在提供时调用运行时撤销端口。数据库 gate 不是进程 fencing，主机所有写入口必须实际消费它。

## 加密离机备份端口

`createResticRecoveryBackup` 提供真实的无 shell 子进程与流式输出适配器。只接受明确授权并已确认离机性质的登记远程目标，核对精确 restic 版本、资料域和独立恢复凭据引用。密钥通过凭据端口注入进程环境，不进入 manifest/回执或命令参数。

适配器保留捕获或验证时的原始 manifest 字节、摘要和文件清单，只上传这些明确文件；上传前后及读回均与原始证据核对，替换 envelope 不能获得保护回执。适配器执行 backup，确认 snapshot ID，执行 `check --read-data`，再对签名 manifest 和每一文件执行 dump 并校验哈希及字节数。完成全部读回后才生成离机保护回执。immutable manifest 的状态保留 local_only；经验证的后续保护结果单独记录为 `off-host-receipt.json`，不会重签/改写已备份的原 manifest。未配置备份端口时只声明本地集合。

本次测试仅注入命令 runner，未启动真实 restic，未接触任何备份目标或真实恢复密钥。runner harness 不能证明异地保护、远程独立性、权限或保留期限。仍需 T23/T25 在获准目标上验证实际二进制、加密存储、真实 dump/restore 和独立密钥恢复材料。

## 见证不可达时的本人核定导入

`createOwnerRecoveryImporter(...).importSurvivors(input)` 需要当前所有者本人认证、可信控制回执和明确逐域文件清单；若能读到权威见证记录，拒绝以这条路径绕过正常交接。新随机 epoch、批准文件字节及哈希分别写入独立目录和 `recovery_import_objects` 账本，控制回执不可重复消费。导入未完成时域保持关闭；失败保留 blocked。

`authorizeRead` 单独核定当前所有者与资料域，不能消费一次性写控制证明。相同导入 ID 和全部不可变请求字段匹配时，先读回持久回执，再考虑原始文件或写入；原始文件消失仍可恢复已完成响应。新导入在消费控制证明前先持久预留身份和关闭状态；中断操作返回其持久结果，改变不可变字段的同 ID 请求拒绝。

成功状态为 imported，含义是批准的幸存原稿已进入新账本；不是外部写权限 open。它不采用旧渠道/委托/标准权威，不重发旧效果。后续 Vault/source indexing 必须将这些文件作为新输入，另行通过现有资料准入与外部写门禁。导入计时独立，`orderlyHandoff=false`、`rpoMs=null`，不计入有序交接的两小时 RTO。

## 共享接线与真实验收缺口

控制器交接文件：`/private/tmp/patrick-plan-continuation-20261117/T22-architecture.md`。恢复库修复仅修改库、RecoverySet schema 和两份恢复测试；package export、迁移登记和跨模块组合由控制器维护。

- `0023_recovery.sql` 已登记到迁移清单，T02 表清单已同步。当前 SHA-256：`180e72b7b4c1a8ef3a580850b827104a3e5e290ed68dbc784cb339b657e819f2`；新增八个 recovery 表、索引与触发器。修复后的 SQL 若有变化，需重新核对摘要与兼容检查。
- `@patrick/host/recovery` 已导出 `src/recovery/index.ts`；仍须在本人控制的 T17 backup/restore 设置操作中绑定服务端资源 scope、可信会话/控制证明和持久操作回执。
- 所有 auth、claim、dispatch、effect、source 与渠道写门禁必须查询当前 `recovery_domain_gates` 并绑定真实获准 writer epoch。新主机写者放行前必须从独立权威确认 open 状态；不能因本地没有 gate 行而推断见证已准入。
- 绑定真实冻结/排空/执行树停止与持久入站交接；绑定实际 Hub schema/watermark 读取。默认 reader 只理解本仓库管理的 SQLite schema，不能冒充原生 Autoloop Hub 适配器。
- 绑定独立强一致见证、完整日志、签名及实际 fencing；绑定基于隔离数据库的 `recoverAnswer`、`reconcilePr`、Hub/卡片、配置、通知、咨询、补采与投影/统计重建。缺任一正面证据保持关闭。
- 绑定获胜 epoch 的运行时安装/读回与复核失败后的控制流程。activationId 已在 CAS 前持久化，见证管理器支持原 ID 权威读回；服务重启后的阶段调度/重入由宿主集成负责，不应重新生成 ID 来掩盖未知。
- 原生 Mac 停机/凭据撤销、真实独立存储断连/双候选、加密备份与密钥恢复、两架构与真实飞书重新配对/往返测试/可信启用均未实测。

本地临时数据库及 runner 的耗时只用于测试，不证明 RPO≤24h 或 RTO≤2h。真实 RPO/RTO、撤回无复活、跨域目标一致性与持久断电恢复必须由授权灾难演练提供计时证据。

## 本次验证结果

2026-11-17 16:55:08 CST 开始的最终定向检查：`npm exec -- vitest run tests/recovery/T22.test.ts` 通过 16/16，用时 3.02 秒；`npm exec -- tsc --noEmit` 及恢复目录/测试文件的 ESLint 均退出 0。0023 的 SHA-256 再次核对一致，SQL 已冻结交由控制器登记。

此前表/迁移清单兼容失败已修复：T02 包含新 network/recovery 表，六处精确迁移清单包含 0024。历史候选在允许本机 loopback 和测试进程树访问后通过 54 个文件、629 项单元/契约/集成/恢复测试，并通过 T00、全库 lint、工作区与 Web 类型检查及 Web 生产构建；这些结果不覆盖随后发现的缺陷或当前修复字节。

执行器准入修复已独立复审通过：当前交付证据、采集绑定及注入回调次序均纳入最终围栏，40 项专用测试和独立复现通过。采集源的租约身份绑定及最终回调修复已独立复审通过：114 项定向测试通过，7 项独立复现验证原四条回调漏洞均被拒绝且无新增业务写入，并保留精确回执重放和暂停。

恢复库首轮独立复审发现四项 Critical、两项 High：激活覆盖新撤回闭锁、错误 Vault 完整性、manifest 被替换后的离机认证、漏掉后续未知意图、多 Vault 路径冲突和本人导入回执重放。冻结修复通过 200 项覆盖测试及 27 项原独立复现；最终 25 项回归在原冻结库上有 23 项失败、2 项控制通过。独立复审随后关闭 C1/C4/H1/H2，但复现两个剩余问题：同路径被替换的目录未与登记的实时 dev:ino 比较，影响捕获和幸存稿保护；离机回执在最后一次时钟回调后仍读取可变 manifest 摘要。该轮为 Spec FAIL / Quality NEEDS FIXES，定向复现 3 项失败、2 项控制通过。第二轮修复将实时 dev:ino 与登记值比较，跨异步复制保留并复核物理根绑定，读取时固定文件句柄；离机回执在最终验证前执行时钟回调，并只引用不可变证据。220 项覆盖测试、27 项原独立复现、5 项复审复现均通过；新增 20 项边界回归在旧冻结版本上有 16 项行为失败、4 项控制通过。第二轮独立复审为 Spec FAIL / Quality NEEDS FIXES：R2 已关闭，C1/C4/H1/H2 保持关闭；R1 仍有一项 Critical。定向复现 2 项失败、2 项控制通过：源文件打开前将 Vault 内中间目录替换为指向外部目录的符号链接，根 dev:ino 不变，捕获仍签出可恢复集合，幸存稿复制也接受了外部字节。后续局部修复记录完整祖先目录链及源文件的实际 dev:ino，在源文件打开、句柄读取和最终状态检查等异步边界复核；目录的纳秒变更时间用于识别替换后还原。备份末尾的 Vault 源文件复核也改用同一受约束读取。新增 7 项持久回归包括正常嵌套目录、持续替换、替换后还原及最终哈希阶段替换；原独立复现保持原样，通过导入解析适配后 4 项均通过。库测试 52 项、恢复测试 207 项及原有 5 项和 27 项探针通过。第三轮独立复审确认此局部修复通过，R1 在受支持的异步替换边界关闭。

2026-11-17 19:56:20 CST 开始的控制器历史候选回归（早于上述两个剩余问题的修复）：`node node_modules/vitest/vitest.mjs run tests/unit tests/contract tests/integration tests/recovery --reporter dot`，55 个文件、732 项通过，退出 0；全库 `npm run lint` 和 `npm run typecheck`（含 Web）均退出 0。T00 和 Web 生产构建也已通过；这些本地结果不代表真实 witness、fencing、restic 或原生灾难演练验收完成。

控制器对第二轮修复冻结版本独立执行全量回归：55 个文件、752 项测试通过，退出 0；全库 `npm run lint` 和 `npm run typecheck`（含 Web）均退出 0。日志为 `checkpoint-final2-suite.log`、`checkpoint-final2-lint.log` 和 `checkpoint-final2-typecheck.log`。该全量通过记录早于第二轮独立复审发现的子目录符号链接问题，不能证明该问题已关闭，也不替代上述原生验收。

完整祖先和文件身份复核覆盖受支持的异步替换边界；初始身份准入及任意外部进程并发替换仍依赖真实写者冻结。本轮没有引入原生 descriptor-relative 解析，也没有将 Node 路径采样声称为原生写者 fencing。

控制器对本轮冻结代码重新运行全量单元/契约/集成/恢复检查：55 个文件、759 项测试通过，全库 lint 和工作区与 Web 类型检查均退出 0。对应记录为 `checkpoint-final3-verification.json`；第三轮独立复审为 Spec PASS / Quality APPROVED，18 项当前文件和冻结快照的 SHA-256 在复审前后均一致。该结论只覆盖库内修复，真实写者冻结与原生验收仍待完成。

## T22 Vault 写入与发布门禁增量

连接及确认、原稿补采、编辑草稿和投影发布直接查询当前数据库中的 Vault 资料域和恢复准入。检查覆盖回调后的最终写入、异步扫描与准备之间，以及创建文件、批次目录和索引发布前的边界；最终事务再次核对持久绑定，拒绝将旧资料域的投影指针写到重绑定后的资料域。已完成且身份完全匹配的回执仍可重放；本人撤回及待处理保护记录可在关闭状态下保留，但不会因此获得新的投影权限。

新增 33 项 Vault 恢复测试；最终定向回归 56/56 通过。控制器在相同冻结字节上执行全量单元、契约、集成和恢复检查，56 个文件、792 项测试通过；全库 lint、工作区及 Web 类型检查均退出 0。沙箱内首轮因回环监听和进程树查询权限失败，获准在沙箱外重跑后全量通过。记录为 `T22-vault-root-suite-escalated.json` 和 `T22-vault-root-verification.json`；独立复审结论另行记录。

该增量阻止在观察到门禁关闭后发起新的文件发布，并在 SQL 边界阻止形成新的业务事实。已交给文件系统的操作可能留下暂存或已链接文件，发布证明仍处于 pending，业务指针不前移。已在运行的原生文件 IO、跨进程或跨主机的写者冻结与 fencing、其他领域和 HTTP 入口接线仍须分别完成；本地通过不代表整个 T22 或原生灾难恢复验收完成。
