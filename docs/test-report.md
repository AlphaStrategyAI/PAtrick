# Verification report · 2026-11-03

This report records the local release candidate. It does not establish live acceptance of external accounts, model identity, billing, VM isolation, VPN routing, or off-machine recovery.

## Executed checks

- Runtime: Node.js **24.22.2**.
- Parent-executed local runtime smoke: a temporary live workspace returned **401** for unauthenticated `/api/state` and **200** for owner Bearer access, generated an owner-only access token (**600**), rejected a second writer, and restarted after clean lease release. No external calls were made; the temporary directory was removed.
- Parent-executed MCP SDK smoke: an actual stdio client listed **5 tools**; `lookup` for 草稿 returned **3 cards**, all in `demo-studio`/`personal`, and an unknown bound project returned **0**. Both runs exited **0** against an isolated demo host without external calls. This verifies the local MCP transport, not model use of memory in a live session.
- `npm run check`: exit **0**; TypeScript checking, **135 tests in 18 Vitest suites**, production build, and formal PRD structure validation passed. Run began at **17:00:44 Asia/Shanghai**.
- `npm run test:coverage`: exit **0**, **135/135** passed. Statement/line coverage **85.95%**, branch coverage **79.68%**, function coverage **82.81%**. Run began at **17:00:55 Asia/Shanghai**. The configured coverage lane excludes web view files, `index.ts`, and `mcp.ts`; browser tests cover the rendered UI separately. Low coverage in actual Lima/online research paths remains a live acceptance gap.
- `npm run test:e2e`: exit **0**, **14/14 Chromium tests**, no skips, **23.8 seconds**. This run used a separate demo database and synthetic adapters; no remote repository or Feishu mutation occurred.
- Independent code review: verified findings were repaired and rechecked. Covered retraction privacy, source/Vault reverts, cost reservations, scoped egress, lookup relevance, writer reconciliation, branch/head/CI binding, snapshot integrity, and network admission/draining.
- Final built application: `node dist/index.js` with an isolated demo workspace. gstack browser inspection found no horizontal overflow at **375px** and no current-page console errors after clearing unrelated research-page history.
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
