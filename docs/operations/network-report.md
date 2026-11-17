# T21 网络监督与固定修复记录

记录日期：2026-11-17。工作目录为 `.worktrees/impl-patrick-plan`。

本次完成生产代码接线、审查缺陷修复与隔离验证。没有连接真实 VPN，没有变更主机接口、路由、DNS 或代理。真实登记设备的双 VPN 两种启动顺序、企业 DNS 与重连验收仍待登记设备、账号、客户端版本和操作批准；本地 harness 与环回测试不构成这些项目的实测证据。

## 已实现的边界

- `vpn.ts` 严格解析固定设备、目标、路径与修复 ID，拒绝命令字段、重复 ID、越界引用和无界重试。`assessVpnCapability` 绑定设备、策略版本、环境摘要、两种启动顺序与证据时间。缺测返回 `dual_path=null`；冲突只提供已登记的分机或受控轮换建议。
- `probes.ts` 依次记录接口、路由、DNS、代理、TCP、TLS、HTTP 身份与 peer。hub 健康不能代替业务目标健康。401/403 归身份，429 携带退避提示，显式 MFA 保留到监督器。未知代理路径停止后续诊断，不通过直连把登记代理故障显示为健康。
- `node-probes.ts` 提供登记 HTTPS 目标的真实探针：本机接口、macOS 只读路由、DNS 地址固定、TCP/TLS、受限响应体、固定身份检查和独立 peer 回执。DNS 多地址逐项尝试并保留成功地址，TLS 验证始终开启，不跟随重定向；请求不接受调用方提供的 URL。
- `supervisor.ts` 使用 SQLite 同一设备锁管理 DNS、代理与 VPN/路由修复。操作意图在外部调用前落盘，每次动作推进 owner/epoch；重复请求重放持久回执。未知、超时或可能迟到的效果保留锁，不自动接管。
- 回退要求设备锁、原 operation/epoch、当前规则摘要和原规则快照匹配。修复和回退均复测故障目标、原健康目标和 peer；规则被其他操作替换时不恢复旧规则。
- 401/403 返回 `needs_login`，明确本机权限失败返回 `needs_permission`，429 持久保存目标退避时刻；MFA 对每个设备/目标复用待处理问题 ID，健康观察后才清除阻挡。登记目标已经健康时允许重新检查，期间不执行原生变更。

## 原生固定动作

`native.ts` 使用 `/usr/sbin/networksetup` 固定参数管理登记网络服务的 DNS 和 web/secure/SOCKS 代理，使用 `/usr/bin/osascript` 的固定脚本操作已运行的 Tunnelblick 登记配置。没有 shell、任意脚本、任意可执行文件、sudo、凭据接收或自动提权入口。网络服务、DNS/代理配置、VPN 客户端与配置名绑定登记摘要，变更登记内容会使旧确认失效。

DNS 和代理在变更前保存 mode 0600 快照，目录以 mode 0700 创建；读回确认后才报告变更，重新创建适配器仍可读取同一拥有者的回退快照。目录须由安装层登记在运行数据目录，不能放入 Vault 或同步目录。系统工具不提供对绕过监督器的管理员写入的原子 CAS；所有 PAtrick 网络写入必须使用同一监督器。

代理的空服务器/零端口没有经验证的精确清空语义。因此任何 web/secure/SOCKS 项缺少可重建服务器/端口时，原快照在变更前返回 `incompatible`；具有这类值的目标配置在登记时被拒绝。不会通过仅关闭代理、保留新服务器值来宣称原快照已经恢复。这一限制也意味着常见默认空代理状态不能直接使用本适配器修复。

Tunnelblick 仅支持 `{repairId, client:'tunnelblick', configuration:'登记名称'}`，并要求策略路径客户端匹配。配置名通过 osascript 的 argv 传入，绝不插入脚本文本；只读取/连接/断开该名称，不启动客户端、不操作全部配置。`CONNECTED` 可作为已连接快照；`EXITING` 不具备已停止证明，读回时返回不兼容，不能登记为可恢复快照。已连接配置进入固定断开命令后，适配器立即报告未知效果，不继续发起连接，也不报告回退完成；监督器保留设备锁。当前 Tunnelblick API 缺少独立的断开收敛证明，因此不能把这条保守路径计为可用重连验收。OpenVPN 和 Shadowrocket 尚无固定原生绑定，返回不兼容。

实现依据为此前检查的本机只读资料：`/Applications/Tunnelblick.app/Contents/Resources/tunnelblick.sdef`、`/usr/share/man/man1/osascript.1`、`/usr/share/man/man8/networksetup.8` 和 `/usr/share/man/man8/scutil.8`。Tunnelblick 字典明确把 `EXITING` 定义为“断开中或已断开”。本轮仅用命令 fixture 验证保守拒绝与未知留锁，没有执行这些原生命令；不能证明断开已完全收敛、原有 TCP 会话恢复、原连接代次恢复，或同名配置未被管理员重新连接。实际路由、DNS 和连接收敛必须通过真实登记设备验收。

生产原生工厂使用固定 `/sbin/route -n get <登记目标主机>` 进行只读诊断。只有退出码 1 且 stderr 精确为 `route: writing to routing socket: not in table` 时报告路由失败，允许选择匹配的登记 `reconnect_vpn`；权限错误、工具缺失、其他输出或取消均保持未知。选中动作不表示其原生收敛已获支持。

## 登记代理路径

`createNativeNetworkRepairConfiguration` 从 `refresh_proxy` 的原生绑定获得目标的登记网络服务，读取该服务的 HTTPS 代理、PAC 和自动发现设置。一个目标绑定不同代理服务时拒绝组装。没有代理服务绑定的目标按登记直连路径探测，不推断其他系统服务。

支持无凭据的 HTTP CONNECT 隧道承载 HTTPS。代理探针与后续 TCP/TLS/HTTPS 均经过登记代理，CONNECT 目的地固定为已解析目标 IP/端口，TLS 保留原目标身份和登记 CA；DNS 主机保留 SNI，IP 目标不发送 IP SNI，但在实际 HTTPS 的 TLS 连接中显式传入原目标 IP 进行证书身份校验。代理/TCP/TLS 阶段按固定 DNS 地址逐项回退，成功地址供后续阶段使用。CONNECT 响应头上限 16 KiB，HTTPS 响应体上限 64 KiB。不提供直接连接回退、代理认证、PAC 执行或重定向。407、PAC/自动发现或不支持的 SOCKS 路径保持未知；连接拒绝、失败响应或头部完成前关闭属于代理故障，能够选择登记的 `refresh_proxy`。

## T03/T17 与界面

生产应用使用默认关闭的 `CreateAppOptions.networkRepair`。`apps/service/src/settings/network.ts` 组装真实 Node/macOS 适配器与 T03 授权，缺少配置时不注册网络能力。只向同账号、同资料域的 owner 发布登记设备/固定修复选项；不发布策略、端点信任材料、快照路径或原生配置。

`createNetworkSettingsHandler` 的 `repair_network` target 为登记设备 ID，input 只接受 `target_id` 和 `repair_id`。校验绑定网络 epoch、固定配置摘要、设备和调用范围；执行从 T17 持久意图读取控制回执，经当前 T03 控制证明查回提案，不接受 HTTP 调用方提供的批准事实。初始版本校验和每次效果前当前会话/owner/控制有效期复验分别传入，避免操作自身 epoch 前进造成错误重试或跳过授权。

每个原生变更命令在最后一次异步读取或快照准备之后、启动命令之前同步调用监督器传入的 `assertEffect`。该检查重新核对 DB 上的设备 owner/epoch/锁、T03 和设置的业务恢复门禁。门禁在准备期间关闭时不执行 DNS 变更；门禁在多条代理命令之间关闭时停止后续命令，把已进入的局部效果保持为未知并留锁。安全回退同样不会绕过这些检查。`reconcile_network` 是专用只读入口，不提供通用业务写入豁免。

设置与 System 使用同一 T17 回执。界面以中英文显示登录、权限、MFA、退避时刻、不可用/兼容、未知留锁、回退及逐目标证据，并隐藏内部 operation 标记。MFA 显示稳定问题 ID 和“完成验证后重新检查”入口，返回登记修复选项；再次健康观察可清除网络阻挡。该入口没有提交一等业务问题答案，不能据此宣称交互式 MFA 完成已验收。网络修复不会派发业务或创建业务根。

## 中断后的只读对账

通用设置引擎通过 `SettingsHandler.recovery`/`recover` 注册独立固定动作 `reconcile_network`，input 严格只含 `{change_id}`。恢复 offer 的 GET 先读取同账号/资料域原回执；仅有设置读取权限者得到 `unavailable/owner_required`，不会因轮询恢复能力收到 403 而失去读取会话。可用 offer 仅公开原设备、修复标签、当前 epoch 和原 change ID。设置与 System 均提供相同的三步恢复流程：固定目标、新校验、新 T03 确认、只读检查。界面继续显示原 change ID。

服务通过原 `settings_changes → settings_validations → control_receipts → control_proposals → network_repair_operations` 精确 join 重建历史草案，校验原 action/target/domain、双方提案 hash、草案 hash、原 expected epoch、设备身份和当前登记摘要。历史 caller/auth epoch 仅要求链内一致；新授权可以来自当前合法的其他 owner。历史过期时间不授权恢复，也不会被改写。新 proof 的 scope 额外绑定原 change/提案/确认、当前 owner/epoch/锁、最新尝试/规则以及网络回执摘要；这些内部值不返回客户端。

主机监督器的 `reconcileNetwork(proposalId, originalExpectedEpoch)` 使用单独可信 closure 接收 `source` 与 `freshControl`，不会把新确认伪装成原提案续期。只有原操作、设备、策略/修复/目标、当前 owner/epoch/锁全部匹配，最新尝试已持久确认合法 `changed_rule` 且没有 `restore_epoch`，才开始有界只读对账。对账前后读取实际规则并检查全部登记目标（包括 peer）健康，提交前再次核对当前新授权和拥有权。成功时原子更新网络回执并释放其设备锁，不调用 apply/restore。

独立 `settings_recoveries` 通过 `0024_settings_recoveries.sql` 持久记录新的命令 ID、一次性 proof/control、原 change 和 source 摘要。普通设置 apply 无法执行该动作，proof/control 不能在普通 apply 与恢复之间复用。主机提交后，设置引擎再次核验当前会话、owner、权限、proof/T03 有效期及持久网络结果，然后以原 receipt bytes/phase/updated_at 做 CAS，更新同一个 T17 回执；原 validation/control/command 引用保持不变。竞争请求只能有一个 CAS 生效，完成请求重放持久结果，不执行第二次检查或原生操作。

主机已提交但 T17 投影前中断时，新的 proof/T03 可取得 `projection_available`；当前 epoch 未改变时仍有界读回实际规则和全部目标。若已有后续网络 epoch，只投影历史效果并标为 `verified=false/network_superseded`，不采用旧健康证据、不接管其他锁。投影提交不要求主机对账自身释放的锁或新回执仍等于对账前状态，但必须等于本次读取的确切持久结果且保持同一已授权 epoch。

此入口只覆盖“原生 apply 已返回并持久确认，中断发生在后续验证/投影”的情况。未知/未确认效果、缺失原网络意图、回退中断、实际规则改变、撤权和失效新确认均不能释放锁。现有日志不能证明进程中断时原生命令已经停止。SQLite 重开、应用重建、授权竞态和无二次变更已由隔离测试覆盖；没有执行真实进程终止/原生命令中断，因此仍不能作为完整崩溃恢复或 RTO ≤2 小时的证据。

## 时间边界与部署测量

当前策略允许 1–4 次尝试、5–600 秒冷却、5–900 秒总期限，并拒绝无法容纳约定冷却的组合。TCP/TLS 套接字及 CONNECT 使用至多 1.5 秒空闲超时，HTTPS 使用至多 5 秒空闲超时；DNS、慢速持续数据和全部多地址串行重试仍受外层总期限约束。只读路由/scutil 命令为 5 秒，原生命令为 15 秒。对账期限取策略期限与 15 秒较小值。未知效果留锁不能因期限到达被解释为已停止。

Tunnelblick 轮询至多 150 次，每次间隔 100 ms，但每次包含 osascript 调用，不能据此宣称 15 秒墙钟上界；外层取消信号控制实际总期限。代理快照/写入/回退包含多条串行命令，不能把单条命令上界当成完整回退时间。期限不足或取消时保持未知留锁，不能承诺一定完成回退。

这些范围是保守安全约束，尚无生产工作负载或尾延迟校准。部署前须对登记设备采集各目标与代理的 P50/P95/P99 DNS/TCP/TLS/HTTP 时延、原生命令/重连/快照/回退耗时、双路径并发目标数与地址数分布，记录 deadline 比例、未知锁数量和年龄、backoff 比例，并据测量设置期限和告警。当前本地控制流测试不能建立生产 SLO、RTO 或双 VPN 可用率。

## 验证与剩余准入

隔离测试涵盖独立 SQLite 连接竞争锁、epoch/外部规则替换、未知效果与超时留锁、冷却/总期限、MFA 合并与健康重查、原健康目标/peer 退化回退、T03 长提案 ID、错误设备、撤权/退出竞态，以及真实生产 `createApp({networkRepair})` 下的同回执读回和幂等重放。

真实环回测试使用临时本地证书、HTTPS 服务和 CONNECT 代理，实际检查固定 IP、多地址、可信 TLS、代理隧道、身份、429、重定向和代理提前关闭。实际 HTTPS 请求以仅有原 IP SAN 的证书成功，以仅有 localhost SAN 的证书被拒绝。不访问外网；不受信任证书保持 TLS 失败。浏览器覆盖固定修复选择、设置/System 同回执和返回路径、MFA 指引，以及原确认过期后的新恢复流程、不可用原因和退出取消。所有原生命令均为 fixture。

`tests/admission/T21.test.ts` 的本地 harness 仅修改临时配置文件，真实设备 gate 默认跳过。`PATRICK_T21_LIVE_EVIDENCE` 只用于读取真实登记报告，不会连接 VPN，也不能替代现场动作。尚需登记设备、账号、客户端版本及范围批准后验证：两种启动顺序、并发目标、企业 DNS、Tunnelblick 重连/路由收敛、真实 networksetup 权限与精确回退、peer/原健康目标保持，以及冲突时获准的分机或受控轮换。未测保持未知。
