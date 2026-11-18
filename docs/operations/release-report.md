# 发布候选包与验签记录

当前 T23 已实现发布候选的打包和验证合同。`source-candidate` 是源码候选，`installable: false`；安装器、服务启动、TLS、launchd、Lima 和目标原生 SQLite 运行时仍待后续实现与主机验收。

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

## CI 与验收边界

`.github/workflows/release-darwin.yml` 分别配置 arm64 与 x64 候选，先核对实际 Node 平台/架构，使用只读仓库权限，checkout 不保留凭据，并上传候选、receipt 和 SHA256SUMS。工作流没有签名或发布密钥。真实签名/发布须由独立、显式调用且受保护的后续流程完成。

本次在当前 Mac 上通过 `tests/admission/T23.test.ts` 的 35 项文件往返与拒绝场景、lint、typecheck 和语法检查。最终回归测试对原始有缺陷的实现重放时出现 7 项预期失败，覆盖 Git replacement/环境重定向、FIFO、祖先链接与目录替换；原始失败与修复验证记录均保留。另有 3 项空目录数量、跨目录总量和目录深度红测，在增加遍历限制后通过。相同 arm64 源码候选重复生成字节一致，x64 也生成了独立候选。这些证据不等于 x64 原生运行、Node 24.9.0 兼容或 GitHub runner 执行。CI 标签的实际可调度性及工作流运行仍未验收。

尚待完成：真实 release signer 的登记与独立 pinned policy、安装 schema 权威范围、可执行 service/hub/worker bootstrap、原生 SQLite 打包、CLI/doctor/生命周期组合、空机安装/重启/升级保数验收、T25/T26 的最终签名包验证与发布。
