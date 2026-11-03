# Verification report · 2026-11-03

The current [judgment-history repair](#judgment-history-repair) passed 186 local tests and 14 browser tests. Earlier initial-candidate and runner-selection checks remain historical evidence below. This report does not establish live acceptance of external accounts, model identity, billing, VM isolation, VPN routing, or off-machine recovery.

## Initial-candidate checks

- Runtime: Node.js **24.22.2**.
- Parent-executed local runtime smoke: a temporary live workspace returned **401** for unauthenticated `/api/state` and **200** for owner Bearer access, generated an owner-only access token (**600**), rejected a second writer, and restarted after clean lease release. No external calls were made; the temporary directory was removed.
- Parent-executed MCP SDK smoke: an actual stdio client listed **5 tools**; `lookup` for 草稿 returned **3 cards**, all in `demo-studio`/`personal`, and an unknown bound project returned **0**. Both runs exited **0** against an isolated demo host without external calls. This verifies the local MCP transport, not model use of memory in a live session.
- `npm run check`: exit **0**; TypeScript checking, **135 tests in 18 Vitest suites**, production build, and formal PRD structure validation passed. Run began at **17:00:44 Asia/Shanghai**.
- `npm run test:coverage`: exit **0**, **135/135** passed. Statement/line coverage **85.95%**, branch coverage **79.68%**, function coverage **82.81%**. Run began at **17:00:55 Asia/Shanghai**. The configured coverage lane excludes web view files, `index.ts`, and `mcp.ts`; browser tests cover the rendered UI separately. Low coverage in actual Lima/online research paths remains a live acceptance gap.
- `npm run test:e2e`: exit **0**, **14/14 Chromium tests**, no skips, **23.8 seconds**. This run used a separate demo database and synthetic adapters; no remote repository or Feishu mutation occurred.
- Independent code review: verified findings were repaired and rechecked. Covered retraction privacy, source/Vault reverts, cost reservations, scoped egress, lookup relevance, writer reconciliation, branch/head/CI binding, snapshot integrity, and network admission/draining.
- Initial-candidate built application: `node dist/index.js` with an isolated demo workspace. gstack browser inspection found no horizontal overflow at **375px** and no current-page console errors after clearing unrelated research-page history.
- `npm run doctor`: exit **2**, as expected for the unconfigured live environment. Node 24 is present; live project settings, repository credentials for the service, admitted isolated workers, Feishu, research gateway, Lima, and restic are not configured together.

## What the automated tests prove

The suites exercise source revision deduplication, missed file notifications, A→B→A file/Vault updates, source withdrawal and retained-text cleanup, temporary-data expiry, Chinese bigrams and scoped retrieval, authenticated A/B/C answers, stale/duplicate answers, release of waiting workers, reserved budgets after failed/stale calls, worker fallback notifications, independent checks and bounded repairs, exact-head trusted CI, changed branches/artifacts, interrupted PR/MR/merge responses, readback mismatch, notification replay, online snapshots, recovery leases and credential exclusion.

Browser tests exercise task creation, exact quotations, task drawers and seven-layer traces, custom answers and stale-answer drafts, native forms without JavaScript, scoped weekly reflections, project setup, source retraction, keyboard navigation, and 375/768/1440px layouts.

## Visual artifacts

- [Desktop workbench](screenshots/workbench-desktop.png)
- [Mobile workbench](screenshots/workbench-mobile.png)
- [Knowledge search](screenshots/knowledge-desktop.png)

## Live acceptance still required

The user authorized `AlphaStrategyAI/PAtrick` as the pilot repository. `docs/product/PRD.md` is the formal target, and the included workflow exposes a `validate` job. The trusted application identity and head-bound check results must be read from an actual workflow run before enabling automatic delivery.

No Grok/Codex/dsh Lima run, Feishu owner round trip, bilingual online research round trip, dual-VPN qualification, launchd installation, restic upload, or isolated-machine takeover has been claimed. See [the requirement checklist](acceptance.md), [deployment guide](deployment.md), and [operations guide](operations.md).

## Runner-selection follow-up

At 17:42:23 Asia/Shanghai, `npm run check` passed **166 tests in 19 suites**, typecheck, build and PRD validation. The 31 added tests cover explicit dsh-first execution, actual-executor-aware independent checking, admission/budget preservation and HTTP preference persistence. Chromium **14/14** passed again in **18.9 seconds**, including owner selection of dsh in the project form. Independent follow-up review found no P1/P2 issues and passed 54 related tests. The earlier coverage figures above remain the measured initial-candidate record; they are not a new coverage measurement for this follow-up.

A release-owner read-only probe through the actual Node 24 `GitHubWriter.baseline/readBaseline` succeeded against `AlphaStrategyAI/PAtrick`: `main` baseline `895e8575248ef774427f7a3efd734c482159f469`, formal PRD absent (`404` handled as a new file), **0 remote mutations**. This verifies authenticated transport and baseline reading, not worker execution or delivery.

Initial commit `ac442a50634b22d1852551b47dd224cbaffc48ab` passed both [push CI](https://github.com/AlphaStrategyAI/PAtrick/actions/runs/41610890461) and [PR CI](https://github.com/AlphaStrategyAI/PAtrick/actions/runs/41612244871). Runner-selection commit `b4731af93d1a55b8aecd8953fe07436a11511560` subsequently passed its own [push CI](https://github.com/AlphaStrategyAI/PAtrick/actions/runs/41616272079) and [PR CI](https://github.com/AlphaStrategyAI/PAtrick/actions/runs/41616278964). Every check is named `validate`, belongs to GitHub Actions App ID `15368`, and is bound to its exact head. [PR #1](https://github.com/AlphaStrategyAI/PAtrick/pull/1) remains open; automatic approval review rejected the default-branch merge because explicit authorization was missing, and the user decision is pending. No merge was performed. These CI results do not establish live model/Feishu/Lima acceptance.

## Judgment-history repair

At **18:31 Asia/Shanghai**, `npm run check` exited **0**: **186 tests in 21 suites**, typecheck, build and PRD validation passed. `npm run test:e2e` exited **0**, **14/14 Chromium tests**, no skips, **20.1 seconds**. The evidence helper recognized the Vitest count as 186; it reports the browser count as unavailable, while the Playwright output records 14 passed. Coverage was not resampled; the initial-candidate percentages above remain historical.

The repair adds **14 workflow/storage regressions** and **6 Hono request/rendering regressions**. A/B/C cases preserve the pre-answer judgment and actual rule content/version after answer, delivery and restart; no-question judgments also retain a host snapshot. Explicit predictions and unknown predictions remain separate from receipt-linked feedback. Feedback replay retains one appended result per receipt. Tests also cover a rule changed during judgment, older questions without snapshots, HTML escaping, withdrawn projections and temporary evidence rejected by permanent tasks.

Regression proof: the first seven history tests failed before implementation; two permanent-task temporary-evidence paths initially delivered instead of blocking; a further historical-action-only withdrawal test retained an artifact/feedback sentinel. Each was observed failing before its fix and passing afterwards. The dependency closure now follows earlier judgment snapshots even when the current judgment no longer cites that source. The related 47-test workflow/store/UI lane passed, and independent final review passed the focused 20-test lane with no unresolved P1/P2 findings. A separate in-memory fallback probe bound the snapshot to the actual successful dsh attempt; raw SQLite serialization of the temporary flow contained no body sentinel. These are isolated adapter tests and do not verify an actual model provider.

The published judgment-history head needs its own exact-head CI check. R030's local frozen-case contract is verified; R032 still lacks automatic due review and later correction/product-metric linkage. Live pilot, operational and future-phase acceptance remain pending.
