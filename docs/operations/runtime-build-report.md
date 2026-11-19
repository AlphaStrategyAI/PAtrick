# T23 运行时构建与启动入口验证

本增量提供可搬迁的 Node ESM 产物、可信进程内组合接口和本机运行证据。安装前还需要签名产物准入、主机登记及生命周期编排。

## 构建入口

```sh
npm run build:runtime -- --source-root <physical-checkout> --source-commit <full-sha> --output-root <new-directory>
```

构建与 snapshot 必须使用同一实际 checkout 的脚本和固定仓库 helper；先核对执行配方的路径与摘要，再核对指定 Git 提交和所选 blob、模式，清除 Git 重定向和替换配置，并将输入复制到独立快照。发布产物前再次核对配方身份。工作区存在覆盖时，构建所有者须先执行 `node scripts/build-runtime.mjs snapshot`，独立固定摘要并通过 `--source-snapshot` 提供。构建工具安装和暂存树的祖先目录由可信主机持有者持续控制；路径检查在该边界内核对完整性。

固定 esbuild 0.28.2 一次生成四个入口及共享模块图，保留进程内凭据身份。Web 使用工作区 Vite 7.3.8 的固定配置。迁移文件及原生 SQLite 依赖随产物搬迁；不运行包生命周期脚本。`metadata/runtime-materials.json` 记录源码、锁文件、工具和观察到的运行时，以及每个文件的角色、长度、模式和 SHA-256。

## 入口与资源所有权

独立登记的可信主机控制器通过 `createRuntimeProvisioning` 提供一致的账户、设备、范围、域、配置版本、有效 UID 和可执行能力，再调用 `createInstalledCli`、`createInstalledService` 或 `createInstalledWorker`。复制或序列化的对象不具备原始凭据身份。直接执行未登记的 CLI、service 或 worker 入口返回缺失能力诊断及退出码 3。

服务使用 import-safe factory，在真实连接附加恢复门禁后启动工作。监听器处理请求、正文、流和连接的取消及退出，并与运行时排空一起等待实际工作完成。超时保留未解决的状态和资源。数据库关闭不能充当外部写者停止或 fencing 凭据。登记的 HTTPS origin 与精确 hostname RP ID 贯穿认证、挑战、控制、设置、飞书和 Web 客户端。监听器在 loopback 接收请求，URL 锚定登记 origin，保留来访 Origin，不从 Host 或代理头选择权限。HTTPS cookie 包括清理 cookie 都带 Secure。直接工厂保留 localhost 默认；安装入口仅在显式测试 profile 允许该配置。真实 TLS 和主机激活仍须验收。

worker 连接独立管理的 Autoloop Hub，核对固定提交 `45aecbf578289cda72d1fc773dcad069bfe7778b` 以及相互区分的 owner、worker、source 角色密钥。服务的本地答题 Hub 连接与 operational Hub 各有自己的身份和资源所有者。备份须匹配独立提供的 `OperationalRecoveryHubBinding`、真实 SQLite 文件的设备/inode、原始连接及 schema reader；另一连接或硬链接指向本地答题库也会被拒绝。服务使用实际持有的 main 连接，CLI 核对其实际服务库文件；冻结租约取得前后再次检查，检查失败释放租约并保留不确定结果。CLI 的主库基线在可信登记时记录，并与确切连接关联；构造新 CLI 或执行命令都须核对同一基线。观察到身份中断后原登记持续失效，恢复旧文件也须重新取得可信登记。网络修复配置的账户、域和设备也须匹配登记。

service 独占 PR 交付、生成视图、Hub 观察、HTTP 来源采集、通知维护及 work-stop；consultation worker 使用收窄的存储、凭据、门禁及 Hub 端口。两个入口分别排空所持有的实际工作。

## 本机证据

本次构建基于提交 `998bd2d788dff186788d7ac1b73dc8875c4ba9f0` 的固定快照：

- 源码快照 SHA-256：`deffa98573b15a6e43921516795e492f94bb610444c927a4cd8427e9360a54a9`
- 锁文件 SHA-256：`267674104925a1cbee17c1396d1572dabbbcbf8fcad75641cae4597810cd8259`
- 两次构建的清单 SHA-256：`a0e145d9696b9df49ae312633e96c8fdf9d48afa1445ed699b56f30f041ab41b`

产物含 448 个文件，共 18,156,665 字节：四个入口、一个共享模块、19 个 SQL 迁移及清单、400 个 Web 文件、22 个原生运行依赖文件及总清单。现有文件数和大小上限足够。

执行环境为 macOS 27.2.1 arm64、Node 26.13.0、modules ABI 147、npm 11.20.0。实际加载了 better-sqlite3 12.11.1 的 arm64 addon，并读回 SQLite 3.53.2。addon SHA-256 为 `0000d73c6e2e94318ed2b9339139623d5a0908b195f1e761c16cfd98f9cc6229`。该二进制来自既有受信依赖安装；本次未重建它。

前一修复轮次通过 257 个测试，覆盖构建、CLI、运行时退出、source candidate、认证/控制/飞书、T21 app、T22 设置/恢复及咨询调度。后续主库身份单点修复通过 142 个受影响测试；它只改动组合器和构建测试，其余十四个实现文件身份保持一致。Root 独立重跑 31 个测试，包括 12 个构建验收用例及认证、控制和飞书回归；scoped lint、Root/Web 类型、语法、差异检查均通过。根项目及既有 CI 命令现在持续包含四个 runtime 入口，Root 实际核对了编译器文件图。370 个输入的前后身份一致；Root 另逐项核对了实际产物清单、内容及模式。

搬迁后的普通 Node 子进程验证真实 SQLite/迁移、服务和 Web 资源、会话/Origin、SSE 取消、信号退出、Hub 派发和回执，并拒绝伪造凭据、错误身份及被替换材料。实际 Ed25519 签名备份写入使用干净环境及隔离文件根的普通 Node，完整执行 fsync；Node permission 模式会禁用该操作，因此此写入进程未使用该模式。另一新启动的受限只读进程通过 CLI 读回同 ID 的签名结果和实际 Hub 副本，没有写权限、签名或第二次冻结；另一个严格子进程证明产物本地依赖解析。隔离证明分别覆盖其实际范围。

原始 RED 是构建入口缺失；接手后新增的提交号及初始化凭据回归在修复前复现失败。监听器、worker 和清单的补充验证属于集成覆盖。早期并行运行的 5 个 source-candidate 用例因共享临时目录祖先变化而拒绝读取；使用独立 TMPDIR 的最终串行运行通过。原始失败记录与后续修复记录均保留。独立复审发现的 HTTPS、登记身份、Hub 绑定、CLI 执行、角色所有权、配方来源及持续类型检查问题均进入本轮修复；新回归保留了修复前的实际失败。信号测试会在 finally 中有界终止并回收自己启动的子进程。后续 I3 回归在旧产物上实际发布了错误绑定的签名备份；修复后，在冻结前拒绝旧 CLI 和同一登记新建的 CLI。完整 20 MB 附件和慢速上传经目标代理的超时、拒绝指标与配置回退仍为 lifecycle/T25 的待测项 M2。

Node 24.9 与 x64 的后续托管构建证据见 [发布候选报告](release-report.md)。生产主机登记、真实 TLS/launchd/Lima、原生重启及 T25/T26 验收仍需各自的实际证据。构建清单是后续签名验证的输入；既有 source-candidate 继续保持 `installable: false`。

## T25 Darwin 工具链观察

候选工作流的 `macos-15`（arm64）和 `macos-15-intel`（x64）任务在下载 Node 头文件后执行独立的信息采集。工件名为 `patrick-darwin-<arch>-<commit>-unsigned-toolchain-observation`，包含 `toolchain.json` 与 `SHA256SUMS`。任务日志另存 JSON 文件摘要及部分已观察字段。新的信息步骤允许失败，原有源码候选及部署材料仍执行各自的检查。

同一 Node 进程报告平台、架构、版本与 ABI。uname 和 sysctl 子进程分别报告机器类型、该 sysctl 进程的翻译标志、CPU 厂商及内核构建架构。Intel 上缺失的翻译 OID 以空字符串保留。脚本只在这些结果与目标一致时继续采集。Node 本身的翻译状态记为 unavailable。Git 提交必须等于作业的精确提交，观察器对官方 Node 24.9.0 头文件归档和三份项目源码分别限额读取一次，核对固定 SHA-256 后将同一缓冲中的字节写入专用临时目录，记录结果后清理。归档保持原样。

记录区分实际选定的 Xcode 或 CLT、SDK 选择路径与物理输入目录。若 SDK 选择器是单层链接，记录链接不可读以及单独检查的标准同级 SDK 目录。工具记录保留 xcrun 选择和可读取物理工具的版本、架构与文件身份。链接器图针对宿主架构列出依赖与运行时搜索路径，并在可确定固定目录时逐项检查私有库。系统库保留安装名。观察器直接测量 SDK 设置与两个目标系统库桩，记录规范化文件名、大小及 SHA-256。当前缺少经独立核验的完整 SDK 和编译器资源输入清单，因此跳过预处理，依赖扫描记为 unavailable。工具缺失、布局超出支持范围、链接和超过限额等情况均保留不可用原因。

此 JSON 是未经签名的 CI 观察。每个目标均需独立下载工件、验证 GitHub 工件摘要和精确提交，将解包文件与独立取得的日志摘要、发布头文件和同版工具链逐项核对，并审查完整链接依赖及目标配方。发布方另行批准工具链后，还需使用真实目标主机完成原生双构建字节一致性、模块握手、受保护主机登记、签名及安装服务加载验收。
