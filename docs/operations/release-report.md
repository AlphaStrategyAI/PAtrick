# 发布候选包与验签记录

T23 已实现源码候选的打包和验签，以及 macOS arm64 和 x64 部署材料的构建与归档读回。`source-candidate` 的 `installable` 仍为 `false`。目标主机的安装、启动和升级仍待验收。

## 生成候选

使用仓库的完整提交 SHA 和该提交中 `package.json` 的版本；打包读取已提交的 Git blob，工作目录中的未提交文件不会进入候选。

```sh
node scripts/pack-release.mjs . FULL_COMMIT VERSION arm64 SCHEMA_MIN SCHEMA_MAX /private/tmp/patrick-arm64.candidate.json
node scripts/pack-release.mjs . FULL_COMMIT VERSION x64 SCHEMA_MIN SCHEMA_MAX /private/tmp/patrick-x64.candidate.json
```

`FULL_COMMIT`、`VERSION` 和 schema 范围均须替换为本次目标的明确值。CI 当前使用源码版本 `0.0.0` 对应的 schema 声明 `1..1`，这不构成已安装数据库的迁移兼容性证明。可选的第八个位置参数是验收证据目录。输出是 canonical JSON envelope，包含 manifest、空签名数组和 base64 文件。写入使用独占临时文件及 rename；相同提交、架构、schema 和证据内容生成相同字节。

输入包括根配置和依赖锁、apps、packages、deploy、scripts；T09 的 `deploy/lima/executor.yaml` 只打包一份。路径、Git blob、SHA-256、字节数和普通文件权限进入清单。Git symlink、危险或大小写歧义路径、`.node`、`node_modules` 和 `dist` 等输入拒绝打包。SBOM `patrick-lock-sbom-v1` 是锁文件依赖清单，尚未覆盖已安装原生运行时。

## 验签与证据

`deploy/lib/release.mjs` 导出 `verifyRelease(path, { readRoot, policy, expected })`。`policy` 由可信宿主独立提供，包含固定的 Ed25519 身份/公钥和非空 `requiredEvidence` 任务列表。`expected` 精确指定版本、提交、OS、架构、当前 schema，并可指定最终 envelope 的 `packageSha256`。候选提供的公钥不会成为信任来源。

`readRoot` 必须由可信宿主独立登记为绝对、物理 staging 根，路径各级不能经过 symlink；候选必须位于根内。打包器把 `evidenceDirectory` 自身作为独立的物理读取根，检查该目录及其祖先；生产调用方须在调用前独立确定这个目录的可信来源和独占条件。宿主需在整个读包/遍历期间独占这些根及其祖先，阻止不可信进程并发修改；不能从候选内容或未经验证的 CLI 参数取得这一信任。读取会拒绝特殊文件，并在读取前后核对根、祖先与文件描述符身份。当前 Node 的路径 API 不提供原子的 openat 能力，无法单凭前后检查排除恶意进程在系统调用间替换后复原的 ABA 竞争；未能保证 staging 独占时，宿主必须保持受阻。未来原生安装入口仍需单独验收这条边界。

验证检查 canonical 编码、签名、清单与实际文件的一致性、长度/hash、schema 和目标版本。证据报告必须绑定相同 release/commit/OS/arch，每个场景有命令、版本、passed/exit 0 和对应文件摘要。缺少、待验收或摘要不符的证据拒绝准入。包大小上限 64 MiB，解码产物总量 40 MiB，单文件 16 MiB，最多 10,000 个文件。证据树单独限制为共 10,000 个条目（包括根、目录和文件），根深度为零，最多 64 层子目录；逐项枚举、在上限内排序，超限拒绝且不生成候选。

成功验签返回本进程登记的只读 `verified-candidate` 回执，仍不可安装。`requireInstallableRelease` 同时拒绝伪造回执和当前源码候选。签名策略、native bootstrap 或验收缺失时，调用方必须显示具体受阻项。当前没有安装成功或生命周期效果。

源码候选首次增加签名后，envelope 摘要会改变。T25 验收与 T26 发布必须锁定最终已签名 envelope 的精确摘要，并发布同一字节；不能用未签名候选的摘要代替，也不能验收后重建。

### 复验已签名的 Darwin 资产

将 T25 接受的 `deployment-complete` 包的 `expected` 和 `policy` 分别保存到可信目录下的 `trusted-pins.json`。文件顶层含 `arm64` 和 `x64`，每个架构对应一组 `expected` 和 `policy`。两组预期绑定同一提交的源码身份、版本和 schema 范围。`expected` 包含最终签名 envelope 的 `packageSha256`，`policy` 包含可信 Ed25519 公钥、执行报告和必验记录的 SHA-256。

```sh
node scripts/verify-signed-darwin-assets.mjs "$trusted_pins" "$arm64_envelope" "$x64_envelope"
```

发布前对待上传包运行一次，发布后对重新下载的两份资产使用同一份验收文件复验。输入文件须位于物理路径下。两份包都通过后才输出提交、版本和每个架构的包、清单、材料、库存与原生模块摘要。任一包或信任材料不匹配时退出非零。发布决策还需核对 T26 的完整试点及任务证据。

### 从验收产物发布

在受保护的签名和验收流程中，用 `actions/upload-artifact@v4` 上传已审核的发布目录，并保留其 `artifact-id` 和所属运行 ID。目录根包含 `patrick-darwin-arm64.signed.json`、`patrick-darwin-x64.signed.json` 和 `release-evidence/`。证据目录使用 `manifest.json`、`tasks/` 和清单引用的脱敏原始证据。此仓库公开，上传前须完成证据脱敏并核验可公开范围。

在 GitHub 的 `darwin-release` 环境中登记 `PATRICK_DARWIN_PROMOTION_ARTIFACT_ID` 和 `PATRICK_DARWIN_ACCEPTANCE_PINS`，分别保存审核后的产物 ID 和上节所述双架构验收 JSON。手动运行 `release-darwin.yml` 时填入该产物所属的 `promotion_run_id`。作业按登记的产物 ID 下载输入，用签名包的提交 SHA 核对完整证据，再按包版本建立 `v<version>` Release 草稿。留空时运行候选构建。

GitHub 要求默认分支包含该工作流文件才能手动触发。受保护的发布主机也可使用相同的验收文件和已审核目录运行 `node scripts/publish-signed-darwin-assets.mjs "$GITHUB_REPOSITORY" "$trusted_pins" "$promotion_dir"`。

发布作业默认使用 `GITHUB_TOKEN`。若候选相对默认分支修改了 `.github/workflows/`，GitHub 要求发布令牌额外具备 `Workflows: write` 权限。这种情况下通过同一环境的 `PATRICK_DARWIN_RELEASE_TOKEN` 引用已获准的仓库发布令牌。

作业从草稿下载两个资产并复验，通过后才发布。随后重新下载已发布资产，核对版本标签的提交、包摘要和签名，并将复验回执写入作业日志。重跑时会复核同版本的草稿或已发布资产，草稿中缺失的预期文件可以补传。发现资产不符时作业失败，已有资产保留供核查。

## 双架构构建与产物读回

`.github/workflows/release-darwin.yml` 的候选构建使用只读仓库权限。Apple Silicon 和 Intel runner 分别核对本机架构、Node 26.13.0 和匹配的头文件，按依赖锁安装并编译原生 SQLite 扩展。每种架构分别上传源码候选和 `deployment-complete` 部署材料。部署材料包含 `runtime-materials.tar`、`SHA256SUMS` 和 `readback-receipt.json`。工作流在构建时实测加载原生扩展，解包后复验归档内容、文件权限和扩展架构。

新构建将 `runtime/service-bootstrap-v1.mts` 纳入部署材料清单。签名包验签和发布目录读回会核对该文件的固定路径、权限及摘要。登记控制器可以在已校验的目录中取得路径和摘要，用于服务角色启动前的握手。历史候选仍可读取，缺少该文件时没有握手材料回执。三服务启动继续依赖生产控制器接线和目标机验收。

Darwin 候选构建通过 `--autoloop-root` 将固定提交 `45aecbf578289cda72d1fc773dcad069bfe7778b` 的 Hub 源文件和许可证纳入部署材料。构建和签名包准入逐文件核对路径与 SHA-256，SBOM 记录上游提交及完整材料清单。包含这组材料的签名包可直接初始化首个代次的 `hub/hub.db`。历史候选仍支持从登记路径提供固定初始化器。

提交 `bee6c9e9f7eed417aef7d47cc4cd256aac715e50` 的两个托管构建均通过。下载后独立核对了 GitHub ZIP 的摘要、内层 tar 的摘要、每个归档的 452 个载荷文件和清单，以及 SQLite 扩展的 Mach-O 架构。两种架构均记录了 Node ABI 137 和 SQLite 3.53.2。[GitHub Actions 构建记录](https://github.com/AlphaStrategyAI/PAtrick/actions/runs/44285957621)

| 架构 | 部署材料 tar SHA-256 | 运行时清单 SHA-256 |
| --- | --- | --- |
| arm64 | `30248b00eeefb5b1c34a3ae51d8bece5dca53180e1968fecadbaceacb58019ff` | `a9a09478bf2a22706cd1e349abd3bb2c6ab79ac2b3759ee4fbd130b92c898ac0` |
| x64 | `7550e9244cba9a7fcff0bf75b51de29151e98330b2f9c1b51397171cbec3cc36` | `7f5a1602b2e66236fcea66b7f64684d54d610ebc4a008c68fd02a3e52ae566e6` |

这些是交给后续签名和 T25 验收的构建材料。签名由独立的受保护流程执行。T25 记录通过验收的最终签名 envelope 摘要，T26 使用相同字节发布。真实签名人登记、目标主机的空机安装、重启及升级保留数据仍需实测。

## 源码候选回归

本机通过 `tests/admission/T23.test.ts` 的 35 项文件往返与拒绝场景、lint、typecheck 和语法检查。最终回归测试对原始有缺陷的实现重放时出现 7 项预期失败，覆盖 Git replacement/环境重定向、FIFO、祖先链接与目录替换；原始失败与修复验证记录均保留。另有 3 项空目录数量、跨目录总量和目录深度红测，在增加遍历限制后通过。相同 arm64 源码候选重复生成字节一致，x64 也生成了独立候选。

## 2026-11-18 安装初始化后的构建

提交 `c6867783f3f6f2c93c44d3be13b75c4770b033dd` 的 [GitHub Actions 构建](https://github.com/AlphaStrategyAI/PAtrick/actions/runs/44324514306) 中，Intel 任务首次通过；Apple Silicon 任务首次排队后被取消，单独重试后通过。下载两种 `deployment-complete` 产物后，独立核对了 GitHub ZIP 摘要、内层 tar 摘要、各自 452 个载荷的字节与模式，以及原生 SQLite 扩展的 Mach-O 架构。两者均记录 Node 24.9.0、ABI 137 和 SQLite 3.53.2。

| 架构 | GitHub ZIP SHA-256 | 部署材料 tar SHA-256 | 运行时清单 SHA-256 |
| --- | --- | --- | --- |
| arm64 | `6ec0ed70dab427945067e875f8c3be6f580711d9458561ff25c92d004865e94d` | `1d63d9c554f13fd28611dc285e28652d9f021aecbb869432871b411871fc5765` | `b48c7b8bc29a766b879df8a90dcc994686c56eeffe18c179d05f13428a8fc24c` |
| x64 | `ea6497920175379818611e368e915afe1577dbcb69653c737631eff068e0b7c2` | `55d4d4f8e86ae18a012313c79c0a4eed91b6696ced9a54cdc5a662bca0458ea7` | `cee9cf07008d0f80a10b5225fdf4d8d5e542e73bfed1b8d95af0791787a1958a` |

以上为未签名构建材料，不是通过 T25 的发布资产。签名人登记、真实主机安装与启动、重启和升级验收仍待完成。

## 2026-11-20 Node 26 LTS 双架构构建

提交 `d5b894fed0d2c99dc655a1b4d5c5a194d12ea729` 的 [GitHub Actions 构建](https://github.com/AlphaStrategyAI/PAtrick/actions/runs/44674778804) 中，Apple Silicon 与 Intel 两个任务均一次通过，均使用 Node 26.13.0（ABI 147）。下载六份产物后独立核对：工具链观察记录的 Node 头文件归档摘要为 `519e269c3e78bf513fdf53d2ab114b763173a7c9424bd477d4e182d782ea366f`（584092 字节），与工作流固定值一致；部署材料内层 tar 的摘要与随附 `SHA256SUMS` 一致；两个归档各含 456 个载荷文件；`better_sqlite3.node` 分别独立解包并用 `file` 确认为 `Mach-O 64-bit bundle arm64` 与 `Mach-O 64-bit bundle x86_64`，字节摘要与读回回执一致；两者都实测加载成功并记录 SQLite 3.53.2。源码候选的字节摘要与随附 `SHA256SUMS` 一致，清单为 322 个文件、schema `1..1`、无签名、`installable: false`。

| 架构 | GitHub ZIP SHA-256 | 部署材料 tar SHA-256 | 运行时清单 SHA-256 | 源码候选 SHA-256 |
| --- | --- | --- | --- | --- |
| arm64 | `390073de74353943e6e9f21529f94b4085a58ef54571bd49b13520d4902e335f` | `567b21943a027fe8361d488f51e3d109fbeeede8224dbfe5eccce39997e0a34d` | `72788df5c2fc3600748ce806aa3eb89bc712acef0c3ded0040e19d475431c114` | `9a09a4d6bb64cece421f401adc6aa500625bf948605d5415e9e660ded5912368` |
| x64 | `fb2894a3f2ec154b3e2dad45e04af5291f1491fd3614ac0fc7b434f262621d71` | `4002c18604bf37cc04460c3ee0bd00891256a228a17e86c7dd6bfe30e0d9ead8` | `1ff4b5034262575d12587f62f79aa655c6e357cef59e46b426a0113f87d47b75` | `7fe1cffa71fe22ade68f970835fb0dfa1b65c1348d70bbdc72dc966327c7c4ba` |

原生扩展摘要：arm64 `cd436871f37c9db23609f1c52d1ac134d4b0243834139b97e7d7f5d10097ab0d`，x64 `52ee7e68839aef1cb09a5acb1bd3d05e28b7259e8f0c18d9a760500efbf09211`。这是交给 T25 验收的未签名构建材料；签名、发布资产、目标主机的空机安装与升级仍需实测。

上述核对由 `node scripts/verify-hosted-candidates.mjs` 重新执行：脚本下载已登记运行的产物，按各自随附的摘要核对归档、清单、载荷数量与源码候选，并独立解包原生扩展读取 Mach-O 架构，任何一项不符即以非零状态拒绝。登记回执保存在 [darwin-candidates-2026-11-20.json](evidence/darwin-candidates-2026-11-20.json)，作为后续签名、T25 验收与 T26 发布的候选输入。

## 2026-11-24 双架构候选复核

包含本地备份默认配置的提交 `c37654e46e3613b3ee1e4526ed24da04ed93d5b5` 通过两个 Darwin 构建任务。`node scripts/verify-hosted-candidates.mjs 45397001813` 下载并核对两个未签名源码候选和部署归档，验证两套产物对应同一 Actions 提交，并重算各自的源码清单摘要。每套归档包含 458 个载荷文件，原生扩展的 Mach-O 架构分别为 `arm64` 和 `x86_64`。源码候选状态为 `installable: false`。[独立读回回执](evidence/darwin-candidates-2026-11-24.json)

已登记控制器可用 `patrick install --release ID` 预览，再用 `--execute --operation ID` 发布签名部署包。控制器分开登记批准公钥和操作日志公钥。批准签名绑定安装实例、发行 ID、操作 ID 和预览摘要。执行在独占租约内复核空目录、签名包和配置，按包摘要原子发布。完成回执依赖对发布目录的逐文件读回。丢失响应后用 `--readback --operation ID` 查询同一操作，也可用只含公钥的登记读回。若发布目录已经落地且回执尚未写入，用同一批准重新执行可在验证目录后补写回执。补写只读取已发布内容并同步父目录与日志。

`INSTALL_RELEASE_PUBLISHED` 表示发布目录已通过核验。目标机仍需完成可信发布签名、数据库初始化、TLS、所有者通行密钥登记、已认证会话以及服务启动、重启和升级验收。

控制器在批准安装计划之前登记首个代次 ID。发布完成后，为同一操作登记 Autoloop `kernel/evolve.ts` 的物理路径，再运行 `patrick install --release ID --operation ID --prepare-generation`。程序核验 `45aecbf578289cda72d1fc773dcad069bfe7778b` 的内核文件摘要和数据预留空间，在独占租约内应用发布包的服务库迁移，离线初始化 Hub 核心表及本地答案表。数据目录与包含三个数据库摘要的签名回执一起原子发布。重试用公钥核对同一操作的回执和实际文件。若留下暂存目录，命令报告 `INSTALL_GENERATION_INTERRUPTED`，由登记控制器检查。

新代次在权限为 `0700` 的 `hub/` 目录内初始化 `hub/hub.db`，并在签名中绑定目录和数据库的物理身份。旧代次按原签名继续读回直属的 `hub.db` 或 `hub.sqlite`。存在多个布局、Hub 目录被替换或权限过宽时，代次校验拒绝放行。隔离验证为锁定版 Autoloop 指定 `AGENT_AUTOLOOP_HOME` 和合成规则，确认它打开了同一设备和 inode 的预建数据库。生产控制器仍需登记 Hub 角色账号和适用的 `rules.json`。

`INSTALL_GENERATION_PREPARED` 记录三个 SQLite 文件的初始化完成。选择代次仍须独立签名。Hub 启动时安装依赖运行配置的视图和索引，TLS、所有者通行密钥、会话及三服务启动也分别验收。设置 `PATRICK_T23_AUTOLOOP_KERNEL` 为固定版本内核的绝对路径可在安装准入测试中复验数据库初始化。

已安装服务启动后，可信宿主控制器可从监听器调用 `issueOwnerBootstrap()`，通过受控渠道把两分钟有效的一次性口令交给登记账户的所有者。所有者在已登记的 HTTPS 源选择「首次登记通行密钥」。新口令会撤销前一个口令及尚未完成的登记挑战。控制器应将明文留在交付渠道内，安装回执只记录非敏感验证结果。已有通行密钥或当前代次失去写入许可时，服务拒绝签发。

控制器登记会话凭据和安装预览摘要后，可以运行 `patrick install --release ID --check-session`。`INSTALL_SESSION_OBSERVED` 记录固定源的 TLS 校验及账户、调用者、授权版本和资料域的只读核验。输出包含安装计划与凭据绑定摘要。数据库初始化和所有者通行密钥需要各自的验收证据。

2026-11-24 的 T23 准入回归通过 451 项，70 项依赖额外登记或夹具的用例跳过。双进程测试使用真实目录同步竞争同一认领记录，获胜进程退出后，新控制器在独立证据到位时补写同一操作的回执。

下载校验器重新复核构建 `45397001813`。它将包内清单的提交、构建环境和原生扩展记录与构建回执比对，再核验每个载荷的路径、长度、权限模式和 SHA-256。两种架构各有 458 个载荷文件通过，候选摘要与原登记回执一致。

含首次安装发布逻辑的提交 `dc74241fe616bfbd07adf357622b367726f5958d` 在构建 `45409471389` 上通过两种架构的构建。Intel 首次通过，Apple Silicon 首次排队后被取消，单独重试后通过。下载复验通过每套归档的 458 个载荷文件和各自的 Mach-O 架构。两套候选等待正式签名及目标机验收。[双架构下载回执](evidence/darwin-candidates-2026-11-24-dc74241.json)

包含安装会话核验命令的提交 `c3fd14e9e16b3a5f654b747a716c5f4c64175e3c` 在构建 `45417098683` 上通过 Apple Silicon 与 Intel 构建。下载后逐项核对每套归档的 458 个载荷文件、源码清单与原生模块架构。两套未签名候选等待发布签名和目标机验收。[双架构下载回执](evidence/darwin-candidates-2026-11-24-c3fd14e.json)

修复已登记代次答案库打开方式的提交 `c72280e9b66ca2cc15e97ad6f827841cc4d3af1e` 在构建 `45419588750` 上通过 Apple Silicon 与 Intel 构建。下载复验逐项核对了每套归档的 458 个载荷文件、源码清单与原生模块架构。两套候选等待发布签名和目标机验收。[双架构下载回执](evidence/darwin-candidates-2026-11-24-c72280e.json)

提交 `73de2d49752ae8814992f7a0b7e3baa6615261b9` 修复安装完成后只读会话核验重复要求安装预留空间的问题。构建 `45424554179` 在 Apple Silicon 和 Intel 上均通过。独立下载复验核对了两套未签名候选与各自归档中的 458 个载荷文件。[双架构下载回执](evidence/darwin-candidates-2026-11-24-73de2d4.json)

## 2026-11-25 首次安装数据代次

提交 `7b8812e67590c8ec007e2cc6b50f376c70e44d76` 的 T23 本地回归通过 92 项，8 项跳过。固定版本 Autoloop 内核用于实测首次初始化。用例覆盖三个数据库的 schema、本地签名代次回执、回执丢失后的读回、篡改拒绝以及低磁盘门禁。

构建 `45432798408` 的 Intel 任务首次通过。Apple Silicon 任务首次在排队时被取消，单独重试后通过。独立下载复验核对了两套未签名候选、各自归档中的 458 个载荷文件及其原生模块架构。Mac Pro 实机验收和发布签名待完成。[双架构下载回执](evidence/darwin-candidates-2026-11-25-7b8812e.json)

## 2026-11-25 所有者首登候选

构建 `45440694418` 从提交 `11bd94c900922398b56bc9d3c15c8ce713732b62` 生成 Apple Silicon 和 Intel 候选。下载复验逐份核对 458 个载荷文件、归档及清单摘要和原生模块架构。该批候选包含浏览器通行密钥登记、登录和宿主一次性口令签发，待正式发布签名及 Mac Pro 实机验收。[双架构下载回执](evidence/darwin-candidates-2026-11-25-11bd94c.json)

## 2026-11-25 发布作业候选

提交 `bcfb0afa7c9701300a8f4023839dcf17d0ef9780` 的本地 T23/T26 回归通过 123 项，8 项跳过。构建 `45448592602` 的 Apple Silicon 和 Intel 任务均通过，普通推送触发的发布作业跳过。独立下载复验核对了两份未签名候选、各自归档中的 458 个载荷文件及原生模块架构。正式发布仍需签名、实机验收和试点证据。[双架构下载回执](evidence/darwin-candidates-2026-11-25-bcfb0af.json)

## 2026-11-25 服务握手候选

构建 `45455019236` 的 Apple Silicon 和 Intel 任务均通过。独立下载复验重算了两份未签名部署归档的摘要，并逐份核对各自的 459 个载荷文件、Node ABI 及 SQLite 扩展架构。本机合成原生控制器直接执行打包后的握手脚本，12 项用例通过。Mac Pro 上的生产控制器及三服务生命周期待验收。[双架构下载回执](evidence/darwin-candidates-2026-11-25-4466690.json)

候选工作流增加了对两种架构归档中服务握手脚本的实跑。测试按对应 runner 的架构编译合成控制器，将测试 Node 的 SHA-256 写入登记，验证登记摘要不匹配时会在连接控制套接字前退出。本机 Apple Silicon 的独立构建路径和归档解包路径各通过 13 项。

构建 `45458890606` 的 Apple Silicon 和 Intel 各通过 13 项归档握手测试。独立下载复验重算了归档与清单摘要，逐份核对 459 个载荷文件和目标原生模块架构。[双架构下载回执](evidence/darwin-candidates-2026-11-25-284fa06.json)

构建 `45467780071` 为提交 `338869b` 生成两种架构的未签名候选。下载后核对了每份归档的 459 个载荷文件、源码清单摘要及原生模块架构。该批候选包含撤回历史导入与长条目读回，等待可信发布签名和 Mac Pro 实机验收。[双架构下载回执](evidence/darwin-candidates-2026-11-25-338869b.json)

## 2026-11-25 已选代次启动候选

构建 `45473033072` 为提交 `51399d5` 生成两种架构的未签名候选。下载复验核对了每份归档的 458 个载荷文件、源码候选摘要及 SQLite 原生模块架构。本机回归覆盖测试配置下从已确认代次启动、租约失效和启动失败后的排空读回。Mac Pro 的生产控制器、三个 launchd 任务和可信发布签名仍待验收。[双架构下载回执](evidence/darwin-candidates-2026-11-25-51399d5.json)

构建 `45475946208` 为提交 `2bd8651` 生成两种架构的未签名候选。仓库验证脚本复验了每份归档的 458 个载荷文件和运行时清单，以及源码候选摘要和 SQLite 原生模块架构。该批候选包含原生 Hub 数据库命名与旧签名代次读回修复。[双架构下载回执](evidence/darwin-candidates-2026-11-25-2bd8651.json)

构建 `45480586476` 为提交 `4cdda57` 生成两种架构的未签名候选。下载复验核对了每份归档的 459 个文件、源码候选与清单摘要，以及 SQLite 原生模块的 Mach-O 架构。该批候选包含原生 Hub 的备份和恢复校验。[双架构下载回执](evidence/darwin-candidates-2026-11-25-4cdda57.json)

构建 `45482435753` 为提交 `b0f5d5c` 生成两种架构的未签名候选。下载复验核对了每份归档的 459 个文件、源码候选与清单摘要，以及 SQLite 原生模块的 Mach-O 架构。该批候选在独立目录初始化原生 Hub，并兼容两种旧签名代次的读回。[双架构下载回执](evidence/darwin-candidates-2026-11-25-b0f5d5c.json)

构建 `45484958794` 为提交 `9673e20` 生成两种架构的未签名候选。下载复验核对了每份归档的 459 个文件、源码候选与清单摘要，以及 SQLite 原生模块的 Mach-O 架构。该批候选在恢复写者 CAS 前重新核对封存记录、旧写者隔离和本地恢复切面。[双架构下载回执](evidence/darwin-candidates-2026-11-25-9673e20.json)

## 安装控制器的跨进程锁

在本机文件系统上预建紧邻安装根的 `<安装根>.owner/lease.sqlite`，目录权限 `0700`，文件权限 `0600`，由控制器身份持有。新锁库使用 `journal_mode=DELETE` 和 `user_version=1`。在首次安装与代次登记中填写同一个 `ownerLockNode`，记录锁库的设备、inode 和出生时间。安装批准摘要和代次签名均绑定锁库身份。发布、代次选择和启动流程用登记信息打开同一把锁。宿主仍须限制其他进程对安装根和锁路径的修改。已有签名历史继续用原登记读回，切换到新锁须另行确认完整的代次迁移。

控制器在回调期间持有 SQLite 写事务。竞争操作返回 `INSTALLED_ROOT_OWNER_BUSY`，进程退出后系统释放锁。有效租约在各操作边界复核登记的物理身份，路径被替换时以 `INSTALLED_ROOT_OWNER_INVALID` 终止。Mac Pro 上的生产控制器接线和三服务实机验收仍待完成。

构建 `45488254506` 为提交 `dc57b51` 生成两种架构的未签名候选。下载复验逐一核对了每份归档的 459 个文件、源码候选与清单摘要，以及 SQLite 原生模块架构。本机另用锁定版 Autoloop 内核复验首次安装和原生 Hub 数据库初始化。[双架构下载回执](evidence/darwin-candidates-2026-11-25-dc57b51.json)

## 随包初始化 Autoloop Hub

构建 `45494660662` 为提交 `00ce953` 生成 Apple Silicon 和 Intel 未签名候选。下载复验核对了每份归档的 481 个文件、源码候选与清单摘要，以及 SQLite 原生模块架构。两种架构均使用解包后的材料生成测试签名包，并验证首次安装能从包内初始化 `hub/hub.db`。该用例聚焦首次初始化，完整安装故障注入在本机单独验证。Mac Pro 实机安装、重启和升级仍待验收。[双架构下载回执](evidence/darwin-candidates-2026-11-25-00ce953.json)

## 已确认代次的 Hub 启动

运行时入口 `startSelectedHubRole` 从签名包启动 Hub，绑定已确认代次的数据库和登记的规则摘要。进程运行期间使用启动时核验的规则内容，应用新规则需要更新登记并重启 Hub。Hub 在代次验证完成后才开放 HTTP。父进程用带一次性挑战的回环健康检查核对响应来自刚启动的子进程。

启动和代次选择共用角色租约。代次签名绑定 Hub 角色与写者锁的物理身份，Hub 子进程持有 SQLite 写者锁直至退出。代次选择在拿到角色租约和写者锁后才提交。原有签名历史可继续读回。数据库已有事实时，缺少 `master.key` 会阻止启动。

目前的安装准入覆盖同一系统账号下的签名包和合成规则。本机用例强制停止已就绪的 Hub 进程并终止控制器，验证代次选择在写者存活期间持续受阻，并在 Hub 退出后恢复。生产部署还需为独立 Hub 账号配置对发布材料、规则和数据的访问，接通原生控制器与 launchd，并在获准的 Mac Pro 上验收。

构建 `45500908733` 在 Apple Silicon 和 Intel 上通过归档复验与 Hub 启动、规则替换和控制器退出回归。下载后独立核对了每套归档的 481 个载荷文件、源码候选与清单摘要，以及 SQLite 原生模块架构。两份候选均未签名。[双架构下载回执](evidence/darwin-candidates-2026-11-25-2f1c45c.json)

## 原生角色入口

Darwin 控制器的 `run-role service`、`run-role hub` 和 `run-role worker` 共用 `/Library/Application Support/PAtrick/controller-v1` 宿主登记。该目录中的 `node` 为登记的 Node 可执行文件。每个角色目录含 `account` 和 `entry.mjs`。`account` 的一行内容为数字 `UID:GID`，末尾带换行。控制器读取已登记角色的 `account`，发现 UID 重复即拒绝启动。`entry.mjs` 由宿主提供，负责注入已登记的运行时能力和发布验签材料。

控制器逐级检查登记目录的 root 属主、权限及扩展 ACL，核对调用进程的真实与有效 UID/GID。通过后以角色登记目录为工作目录执行对应入口，并清理继承的环境和额外文件描述符。角色入口可从自己的登记设置工作目录和专用 `HOME`。

本机准入以测试宿主登记从 `run-role hub` 启动已选择的签名包。`runInstalledHubRole` 处理 `SIGTERM` 和 `SIGINT`，等待子进程退出和角色租约释放。准入用例验证启动中断、正常关停、子进程异常退出，以及控制器被强杀后写者锁继续阻止代次切换。Mac Pro 的 root 登记、独立账号访问权限和三个 launchd 作业的生命周期需要在生产配置下验证。

提交 `6e3a199` 的构建 `45504186987` 在 Apple Silicon 和 Intel 上通过候选构建与原生控制器准入。该构建早于本机的 Hub 关停回归。

构建 `45507203407` 的 Apple Silicon 准入通过，Intel 初次安装与 Hub 启动取消用例超时。Hub 现在在进入代次读取和验包阶段时检查停止信号。回归在归档尚未读取时发送 `SIGINT`，核对进程正常退出且写者锁可用。归档安装和角色启动用例采用独立的测试时限，运行时的关停时限保持原值。
