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

## 双架构构建与产物读回

`.github/workflows/release-darwin.yml` 使用只读仓库权限。Apple Silicon 和 Intel runner 分别核对本机架构、Node 26.13.0 和匹配的头文件，按依赖锁安装并编译原生 SQLite 扩展。每种架构分别上传源码候选和 `deployment-complete` 部署材料。部署材料包含 `runtime-materials.tar`、`SHA256SUMS` 和 `readback-receipt.json`。工作流在构建时实测加载原生扩展，解包后复验归档内容、文件权限和扩展架构。

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

控制器登记会话凭据和安装预览摘要后，可以运行 `patrick install --release ID --check-session`。`INSTALL_SESSION_OBSERVED` 记录固定源的 TLS 校验及账户、调用者、授权版本和资料域的只读核验。输出包含安装计划与凭据绑定摘要。数据库初始化和所有者通行密钥需要各自的验收证据。

2026-11-24 的 T23 准入回归通过 451 项，70 项依赖额外登记或夹具的用例跳过。双进程测试使用真实目录同步竞争同一认领记录，获胜进程退出后，新控制器在独立证据到位时补写同一操作的回执。

下载校验器重新复核构建 `45397001813`。它将包内清单的提交、构建环境和原生扩展记录与构建回执比对，再核验每个载荷的路径、长度、权限模式和 SHA-256。两种架构各有 458 个载荷文件通过，候选摘要与原登记回执一致。

含首次安装发布逻辑的提交 `dc74241fe616bfbd07adf357622b367726f5958d` 在构建 `45409471389` 上通过两种架构的构建。Intel 首次通过，Apple Silicon 首次排队后被取消，单独重试后通过。下载复验通过每套归档的 458 个载荷文件和各自的 Mach-O 架构。两套候选等待正式签名及目标机验收。[双架构下载回执](evidence/darwin-candidates-2026-11-24-dc74241.json)
