# Local operations and live admission

This guide covers the local service, launchd operation and the prerequisites for a real workflow. It does not request or perform a public hosting deployment. Use [acceptance.md](acceptance.md) to record evidence; a successful startup or diagnostic is separate from live acceptance.

## Node 24 and commands

From the repository root:

```bash
nvm use 24
node --version
npm ci
```

The version must be `v24.*`, matching `engines.node: >=24 <25`. Native better-sqlite3 dependencies must be installed under the Node version that will run the service. Use the same Node 24 binary in launchd; launchd does not automatically source nvm's interactive shell setup.

Run the local demo in an independent directory:

```bash
PATRICK_HOST=127.0.0.1 PATRICK_DATA_DIR=/tmp/patrick-demo PATRICK_VAULT_DIR=/tmp/patrick-demo/vault npm run demo
```

Run live after preparing the private environment:

```bash
node --env-file=.env --import=tsx src/index.ts
```

The HTTP entry also loads a repository-root `.env` when present. Explicit `--env-file` makes the environment source clear for other entry points:

```bash
node --env-file=.env --import=tsx scripts/doctor.ts
node --env-file=.env --import=tsx scripts/backup.ts
node --env-file=.env --import=tsx scripts/report.ts patrick
node --env-file=.env --import=tsx src/mcp.ts
```

Build once for a persistent process:

```bash
npm run build
node --env-file=.env dist/index.js
```

The normal npm entry points are `dev`, `demo`, `start`, `doctor`, `backup`, `report`, `restore`, `install-service` (also `service`), and `mcp`. `start` runs `dist/index.js` and requires a successful build. Keep the process working directory at the repository root so static assets and any relative configuration paths resolve correctly. `report -- PROJECT_ID` reads the running host's authenticated weekly project report; omitted IDs use the first configured project. Missing maintenance time and missed/unnecessary questions remain `null`. See [deployment.md](deployment.md) for restore assertions and service generation.

`doctor` checks Node24, configuration readiness, `limactl` and `restic`, plus a GitHub authentication probe when a token is configured. It exits `2` if any listed item is unready. That is an expected diagnostic result on an unconfigured host, not a failed unit test or evidence of a successful live chain.

## Private environment and data

Copy [.env.example](../.env.example) into a private `.env`. It is ignored by Git; do not commit actual credentials in a JSON project config either. Omit optional settings rather than setting empty values whose meaning differs from an absent variable. Node's env-file loader does not expand `$HOME` or `~` inside values; use absolute paths.

HTTP configuration:

- `PATRICK_MODE`: `live` by default; `demo` is local replay data, and `test` is for explicit test composition.
- `PATRICK_HOST`: `127.0.0.1` by default. Non-loopback requires an explicit `PATRICK_TOKEN` of at least 24 characters.
- `PATRICK_PORT`: `4317`; the browser suite uses `4318`.
- `PATRICK_CONFIG`: JSON file matching [the example](../examples/patrick.config.json); without one, there are no configured projects and runner admission is false.
- `PATRICK_OWNER_ID`: local owner identity, default `owner`; bind it consistently to project ownership and the verified Feishu identity.
- `PATRICK_DATA_DIR`: macOS defaults to `~/Library/Application Support/PAtrick`; other platforms default to `~/.local/share/patrick`.
- `PATRICK_VAULT_DIR`: defaults to `PATRICK_DATA_DIR/vault`; choose a separately authorized Vault location if needed.
- `PATRICK_SCAN_INTERVAL_MS`: full source scan interval, default `60000`, minimum `1000`.
- `PATRICK_NETWORK_CONFIG`: optional approved network-target JSON, as in [the example](../examples/network.json); when configured in live mode, the host checks it at startup and every 60 seconds.

Runtime files include `patrick.db`, its SQLite WAL/shared-memory files, `host-lease.db`, `writer.lock`, `workspace-mode`, and a generated `access-token` when no local live token was supplied. The host holds a SQLite exclusive transaction in `host-lease.db`; `writer.lock` records PID/lease identity, and `workspace-mode` prevents opening the same directory under a different live/demo/test mode. Keep the active database, leases, token and credentials outside synchronized folders. File sync is for approved business files, not an active SQLite database. Only one host owns a data directory; never remove either lease file to force takeover.

The project JSON also accepts `egressPolicies`, an array of `{domain, research, feishu}` entries. The default enables these two channels for `personal` only; other domains need explicit entries. An explicit `false` blocks its channel. This controls search/Feishu export separately from runner `domains` and network-path admission; it does not configure a VPN or guest firewall.

`PATRICK_TOKEN` may be supplied privately. For local live mode, bootstrap otherwise generates `PATRICK_DATA_DIR/access-token` with restricted permissions and prints its path, not its value. Use it at `/login`. `PATRICK_SESSION_SECRET` defaults to the access token. Web sessions are signed, HttpOnly, SameSite Strict and expire after seven days; HTTPS is needed for a Secure cookie. API clients can use an Authorization Bearer header. Keep the service behind an authenticated private network; binding an address is not a TLS or VPN setup.

## Pilot repository and trustworthy checks

The confirmed pilot is `AlphaStrategyAI/PAtrick`, output `docs/product/PRD.md`. The example allows exactly that file. Keep `autoMerge: false` until every prerequisite is verified; do not broaden `allowedPaths` to include CI, credentials or arbitrary repository files.

The intended required check is `validate`. The example App ID `15368` represents GitHub Actions, but must be confirmed against **the actual current PR head's API result**. Read:

```text
GET /repos/AlphaStrategyAI/PAtrick/pulls/{pull_number}
GET /repos/AlphaStrategyAI/PAtrick/commits/{head_sha}/check-runs
```

Record the PR head SHA and each required check's `name`, `head_sha`, `conclusion`, `app.id` and evidence URL. Set `trustedChecks` and `trustedAppIds` from these authorized results. Both lists must be nonempty for automatic merge. A missing, skipped, stale-head, unknown-App or unsuccessful required check must stop delivery. An expected failing CI run should prove this gate before the first real automatic merge.

Use `PATRICK_GITHUB_TOKEN` for the authorized writer; configuration also reads `GITHUB_TOKEN` or `GH_TOKEN` if the explicit variable is absent. Prefer a short-lived GitHub App installation token with only needed repository permissions. Workers must not receive that token. Repository human-review requirements remain binding; the service cannot turn an independently reviewed repository into an automatic-merge repository.

The writer binds the plan, artifact and review to the same requirement version, baseline and hashes, then checks the current remote head. A changed baseline/head invalidates old evidence. After merge it reads the configured path at the actual merge SHA and compares content. A model-generated check URL, merge SHA, or “success” statement is never proof. Lost responses require a remote lookup of the stable action before retrying.

GitLab uses `repositoryProvider: "gitlab"`, an approved HTTPS `PATRICK_GITLAB_URL`, and `PATRICK_GITLAB_TOKEN`; that integration still needs separate live acceptance. For GitLab, `trustedChecks` names required pipeline jobs, and `trustedAppIds` contains approved triggering service-account **user IDs** (`pipeline.user.id`), not GitHub App IDs. The writer requires the latest successful `merge_request_event` pipeline and matching current-head jobs. Configuration does not establish corporate network authorization.

## Worker admission and Lima

The example includes Grok, dsh and Codex command entries, all with `isolation: "lima"` and `instance: "patrick"`. The later current-MacBook trial used `patrick-local` and a pinned official development build because stable 2.2.1 lacks the template’s required `hostLoopback` option. It booted a real VM and exercised a synthetic runner, without authenticating or admitting Grok/dsh/Codex. Keep the example policies unadmitted and verify each real provider separately. [Deployment prerequisites](deployment.md#lima-worker-isolation) cover build provenance and template validation.

For a dedicated instance store, set optional `LIMA_HOME=/absolute/private/path/lima` in the private service environment and use that same home for operator Lima commands. Node env-files require an absolute path; they do not expand `~` or `$HOME`. Put the reviewed `limactl` binary on the service PATH. The shared CLI/ACP launcher preserves only PATH/HOME/TMPDIR and explicitly named optional `LIMA_HOME`; unset retains normal Lima defaults. It does not forward arbitrary Lima settings, proxies, tokens or SSH agents. Review the home’s global default/override/base configuration and effective instance settings before boot; a selected home does not establish isolation or admission.

On **2026-11-04**, the local trial observed no host directory mounts, `/Users`, SSH agent or named host credential variables; effective SSH disabled agent/X11 forwarding and its control listener was loopback-only. Guest TCP to the special host-loopback hostname/IP on the probe port was denied while host health stayed 200. Three compiled-adapter cases used actual SSH, guest Node, production prepare/tests/cleanup and a synthetic runner: planned-test success, a failing planned test overriding a fabricated pass, and CLI exit 17; all workspaces were removed. No model was called, cost was $0, and the live pilot configuration stayed unchanged/all workers unadmitted. Approved egress/session-upload restrictions, unprivileged execution (the guest admin can sudo), actual provider versions/login/entitlement/billing/fallback, cancellation/offline cleanup, production Mac mini, launchd and off-machine recovery remain unqualified. [The report](test-report.md#bounded-local-lima-trial-and-home-selection) records exact provenance and boundaries; no public probe helper was shipped.

The operator’s current policy permits **only existing included Grok/Codex subscription allowance, with no additional billing**. Record and verify each account’s actual unattended-use entitlement and paid-overflow controls before any real call; those remain unqualified. A configured reservation or provisional budget is not extra-spend authorization. This trial grants no real-call or provider admission.

Each runner policy independently names roles, domains, provider, model, `costPerRunUsd` and `independentReview`. The example `model: "unconfigured"` and `costPerRunUsd: 0` deliberately provide no model or price claim; the scheduler requires a positive cost reservation. It charges that reservation before each attempt, retains it for failed/unavailable attempts, and only increases it if an adapter reports more. The current Lima adapter reports the configured reservation; `spentUsd`, `Attempt.costUsd` and weekly `reservedCostUsd` are conservative budget accounting, not provider invoices. Replace values with verified bounds and record actual entitlement/billing independently before admission.

The seven roles are `knowledge_extract`, `case_extract`, `decide`, `plan`, `execute`, `check`, and `feedback`. Knowledge/case/decision order is Grok→dsh→Codex; plan/feedback order is Codex→Grok→dsh. Set project `executionRunner` to `grok` (default) or `dsh`; execution uses Grok→dsh→Codex or dsh→Grok→Codex respectively. The add-project form's “执行首选” field saves the same choice, and settings display it; older projects without the field retain Grok-first execution. Checking prefers a different runner from the actual successful executor, retaining Codex→Grok→dsh order among distinct candidates. The actual executor is the last fallback only when its independent read-only check configuration is admitted. Role/domain/provider/model admission and positive reserved budgets apply before dispatch. At least one admitted backup is necessary to accept automatic fallback.

Grok uses a noninteractive CLI, dsh uses ACP, and Codex uses `codex exec`. CLI flags and versions must pass the adapter's current protocol test before admission. The adapter prepares a private guest `/tmp/patrick-*` workspace, provides structured input, validates output against the role Schema and runs bounded plan tests in the guest for execute/check. Do not grant arbitrary host execution as a workaround for a CLI failure.

Validate that the Lima instance has no default host filesystem mount and no forwarded SSH agent, only the approved task material, no repository writer credentials, restricted egress and approved session-upload behavior. Installing Lima is only the first step: actual provider permissions, isolation, fees and independent checking still need evidence. A task or review's declared tests do not substitute for remote CI proof.

Unavailable runners may be replaced automatically. Test failures trigger business repair, not fallback. Every real switch records a notice for the owner; notification failure should remain queued. All unavailable candidates retain the task with a future probe. Questions release the worker indefinitely, and no answer means no automatic choice. Repair is bounded to two rounds and the task budget.

## Review a judgment and its result

Open **Standards → Weekly reflection** or expand a rule's decision cases to review the original goal, judgment, used rule contents/versions, citations and expected outcome. Its `decisionSnapshot` copies the question's judgment at the time, even after the task advances and judges again. Task details retain the task's current progress and judgment; no-question judgment snapshots are available in the host action ledger. Published case Markdown separates `Judgment at the time` from `Observed results`; do not substitute today's rule text for the frozen version.

The host records a successful `decide` snapshot in the existing `actions` ledger as `kind: 'decision.snapshot'`, with `payload.snapshot`. Task and Question retain `decisionSnapshotId` references. The snapshot binds a successful attempt and input hash and includes only the rules the decision actually used. Feedback appends a `CaseOutcome` linked to a validated `receiptId`; retrying the same receipt does not add another outcome. That record supports delivery feedback, while prediction accuracy and business impact still need separate observable evidence.

For compatibility, CLI decision output may omit `expectedOutcome` or set it to `null`; the current prompt asks for an explicit prediction with uncertainty, or `null` when unknown. The host normalizes an omitted prediction to `null`. Older cases without a snapshot remain explicitly unknown; do not reconstruct their original judgment from current rules or later feedback. A legacy `outcome` without receipt linkage is displayed with an explicit unverified-result notice. Source withdrawal removes readable snapshots and related case/question/task derivatives while retaining only permitted receipt audit; dependency cleanup also follows older `decision.snapshot` actions when the current judgment no longer cites their sources. `ephemeral` content and its readable derivatives stay in the current process rather than persistent records; a permanent task must reject temporary-source citations or rules that would preserve such evidence.

## Outcome review sources and HTTP contracts

Open **Standards → 结果复核** for the selected project. Each subject preserves its original judgment, goal, rule versions and prediction, with separate delivery, source-reported correction, measurement, engineering failure and abandonment sections. A missing current report shows **交付回执待复核**; only a current report can state which receipts passed review. A connection block, owner cancellation, archival or failed planned test does not establish a measured business failure.

Configure `reviewIntervalDays` in project JSON or the add-project form: integer **1–365**, default **7**. Settings shows the saved value. JSON requires a number; an omitted field or blank form input uses seven, while zero, fractions and out-of-range values are rejected. Each successful judgment snapshot freezes `reviewAt` and `reviewIntervalDays`. Legacy snapshots lacking these fields use `recordedAt + 7 days` and seven-day recurrence, independently of today's project setting.

Accepted failed planned tests are retained before a repair replaces the task buffers. The host records only validated execute/check results, bound to the accepted attempt, snapshot and task version; later repair success does not erase them. Transport faults remain separate. Older failed outputs already overwritten before this feature cannot be reconstructed; the legacy fallback uses only a matching current version/context.

The runtime scans the current owner's projects after startup setup and every **60 seconds**, using the host clock. Before due it appends no report. Scans append local `decision.review` actions; unchanged inputs in the same scheduled round do not duplicate records across retries or restarts. Changed admissible evidence may append a new immutable report in that round; missed rounds are not backfilled with later knowledge. A scheduled storage failure logs a fixed message and retries next minute; an explicit scan failure is returned to its caller. No scan calls a model or remote service or changes tasks, original judgments, rules or preferences.

All four routes below use the running host's authentication. In live mode, send `Authorization: Bearer <private host token>` or use the owner session; cookie-authenticated mutations require a matching `Origin` and reject cross-site requests. Keep credentials in the private environment described above. Bodies shown here are **synthetic offline contract examples**, not live measurements, credentials or a configured feed. Use `Content-Type: application/json`. POST bodies are strict: do not add actor/author identity, `recordedAt`, `at` or a scan clock. The server supplies recorder identity and recording time. Project/domain must match a stored project owned by the configured owner.

1. **`POST /api/reference-sources`** imports approved reference text without an execution task. Required fields: `projectId`, `domain`, `externalId`, `revision`, `title`, exact nonblank `content`, and explicit `retention` (`permanent` or `ephemeral`); `locator` is optional. Content is preserved exactly (maximum 1,000,000 characters, within the 1,100,000-byte HTTP body limit). Returns HTTP 200 `{ "source": ... }` with metadata, including its actual `id`/`revision`/`locator`, and no content. The host sets kind `reading`, purpose `reference` and source author to its configured owner; it does not infer an upstream author. Use the returned metadata in the next request.

```json
{
  "projectId": "offline-example",
  "domain": "personal",
  "externalId": "synthetic-report-1",
  "revision": "r1",
  "title": "Synthetic offline outcome report",
  "content": "{\"schemaVersion\":1,\"name\":\"completion_rate\",\"value\":0.75,\"baseline\":0.6,\"unit\":\"ratio\",\"sampleSize\":40,\"periodStart\":\"2026-10-20T00:00:00.000Z\",\"periodEnd\":\"2026-10-27T00:00:00.000Z\"}\nSynthetic report: direct measurement in the declared cohort.",
  "retention": "permanent",
  "locator": "offline:synthetic-report-1"
}
```

A retry of the same revision returns the same source; changed text under that revision or reuse with a conflicting task/reference purpose is rejected (409). New revisions supersede old evidence. Reference purpose remains authoritative through Vault edits, scans and recovery: editable frontmatter cannot turn a reference into executable work. Recovery uses stored source purpose or a matching pre-existing task/source/scope/revision relation for execution provenance. Valid ordinary intake sources recover before special owner-answer sources, so a genuinely accepted answer can bind its recovered primary independently of filename order. Accepted-answer authority must come from the trusted SQLite question, not projection metadata.

Vault edit copies carry host-recorded parent source revisions, including case/answer dependencies. A superseded or withdrawn parent invalidates its historical and nested copies and their readable evidence/review derivatives. An absent SQLite row with unverifiable intake identity, or a Vault-only copy lacking trusted ancestry, recovers as a **content-free withdrawn reference tombstone**; it does not become executable or retain its readable projection. Editable kind, external ID, revision or ancestry cannot supply the missing authority. Keep the consistent database/Vault backup together; manual frontmatter edits cannot repair missing provenance.

2. **`POST /api/judgments/:id/evidence`** attaches evidence to the host's actual snapshot ID, obtained from a scoped review view. Required fields: `projectId`, `domain`, `kind` (`correction`, `metric`, `failure`, `abandonment`), `sourceId`, `sourceRevision`, exact substantive `quote`, and ISO `observedAt`. Optional `attribution` defaults to `{ "method": "none", "citations": [] }`. Non-`none` methods (`controlled_comparison`, `direct_measurement`) require nonblank, current, same-scope exact citations with `sourceId`, `revision`, `quote`, `locator`. Returns HTTP 200 `{ "evidence": ... }`, preserving source `authorId` separately from owner recorder `actorId`. Identical retries return the original record; conflicting metadata for that evidence identity returns 409.

```json
{
  "projectId": "offline-example",
  "domain": "personal",
  "kind": "metric",
  "sourceId": "REPLACE_WITH_RETURNED_SOURCE_ID",
  "sourceRevision": "r1",
  "quote": "{\"schemaVersion\":1,\"name\":\"completion_rate\",\"value\":0.75,\"baseline\":0.6,\"unit\":\"ratio\",\"sampleSize\":40,\"periodStart\":\"2026-10-20T00:00:00.000Z\",\"periodEnd\":\"2026-10-27T00:00:00.000Z\"}",
  "observedAt": "2026-10-27T00:00:00.000Z",
  "attribution": {
    "method": "direct_measurement",
    "citations": [{
      "sourceId": "REPLACE_WITH_RETURNED_SOURCE_ID",
      "revision": "r1",
      "quote": "Synthetic report: direct measurement in the declared cohort.",
      "locator": "offline:synthetic-report-1"
    }]
  }
}
```

Replace the project and snapshot/source IDs with authorized records. The example dates are usable only for a synthetic judgment before October 20 and an actual verified delivery no later than that measurement start; importing this JSON does not create such a judgment or receipt. Metric evidence has **no free-standing numeric input**: the whole exact quoted JSON is parsed with `schemaVersion: 1`, nonempty `name`/`unit`, finite numeric `value`, optional finite `baseline`, optional positive integer `sampleSize`, and ordered ISO `periodStart`/`periodEnd`. Numeric strings, extra fields and nonfinite values are invalid. `periodEnd` must equal `observedAt` by instant. Observations cannot predate the judgment or lie in the future; measurement start must be on or after the judgment. All quotations and locators are rechecked against the current active source revision.

A result stays **待观察 / `observing`** without a currently verified delivery, known positive sample, post-delivery measurement period and quoted attribution material. **已关联结果依据 / `evidence_linked`** means those materials were associated. Attribution is source-reported; it never certifies causality, prediction accuracy or business improvement. No real metrics feed is configured. Corrections/failure/abandonment reports are source claims, and failed checks are separate host engineering records.

3. **`GET /api/reviews?project=offline-example&domain=personal`** returns HTTP 200 `{ "reviews": [...] }` using server time. Each view includes the frozen `snapshot`, `snapshotId`, `taskId`, scheduled date, cadence, current admissible evidence and optional `latestReview`. Listing does not create a review. A historical report whose inputs no longer match current permitted evidence is not reused as current.

4. **`POST /api/reviews/run`** accepts exactly `{ "projectId": "offline-example", "domain": "personal" }`, scans only that scope with the host clock and returns HTTP 200 `{ "reviews": [...] }`. It cannot force a future due date or invent delivery evidence.

Unknown/mismatched project/domain returns 404 for reference/list/run routes; omitted list query fields also return 404, while missing required POST fields fail Schema validation with 400. A foreign owner returns 403. Explicit state/source-withdraw and generic task/question APIs also enforce the current project owner; aggregate state/readiness omit foreign scopes. Evidence additionally requires a valid original successful host snapshot and same-scope current source revisions. Other Schema failures return 400, and obsolete/retention/conflicting-record conditions can return 409; unauthenticated live API access returns 401. Permanent judgments cannot retain temporary evidence. `ephemeral` evidence and readable reviews remain process-local; withdrawal removes readable derivatives, excludes obsolete citations and prevents their return after restart or index rebuilding. These guards apply again at read/scan time, not only at import.

## Feishu settings and catch-up

Configure the official SDK application-authenticated WebSocket transport with these private environment values:

```text
FEISHU_APP_ID
FEISHU_APP_SECRET
FEISHU_OWNER_OPEN_ID
FEISHU_CHAT_ID
```

App ID, app secret and owner Open ID create the application configuration. The verified private Chat ID and a successful authorized history response are still required before channel readiness; WebSocket startup first performs catch-up. Bind `PATRICK_OWNER_ID` and each project's `ownerId` consistently to that verified person. Obtain owner/chat identities through an authorized environment and set them manually in the private environment file; retain the corresponding permissions and history-reading scopes. Settings and `doctor` label this as **connection configuration**, not a live operational acceptance result.

`FEISHU_VERIFICATION_TOKEN` is optional for WebSocket, sends and history. It is mandatory for the HTTP route `POST /webhooks/feishu`: with otherwise configured application/owner/chat values, a missing, empty or whitespace-only token returns **403** before challenge, signature, decryption or event dispatch. This remains true after WebSocket readiness and for signed/encrypted challenges or events; never synthesize a placeholder token. Set `FEISHU_ENCRYPT_KEY` when HTTP callback encryption is enabled. Configured callbacks retain token checks, encrypted request freshness/signature and exact-body binding. HTTP callback verification is separate from browser login. Choose the tenant's authorized event-delivery mode; a local WebSocket does not require publishing the workbench.

Supported owner business commands are `/status`, `/lookup PROJECT_ID QUERY`, `/task PROJECT_ID CONTENT`, and `/answer QUESTION_ID TASK_VERSION.QUESTION_VERSION A|B|C [YOUR_WORDS]`. A direct reply of A/B/C to the corresponding question message can also bind to that question; C requires original text. In a single configured project, ordinary owner business text can enter that project; with multiple projects, specify `/task`. Owner/chat, project/domain, egress and source-retraction checks still apply.

`/pair` is reserved configuration-only input. Normal routing ignores it, including leading whitespace, case variants, newline payloads and historical replay. It creates no business source, task, case, rule, card or outbox; receive bookkeeping retains only allowed identifiers, digests, timestamps and empty source references. Pairing command bytes must not enter SQLite/WAL/Vault or logs. The release owner's private one-off challenge listener was used for the bounded check below, then closed and its command removed. It is not a shipped generic pairing CLI/API, and the service does not trust the first sender as the owner. Manual private-environment setup remains supported; do not send pairing secrets as ordinary business content.

On **2026-11-04**, an explicitly authorized one-time private challenge bound the verified owner and private chat and saved a private receipt. The actual history API returned **HTTP 200/code 0**. The normal compiled production entrypoint ran on loopback in a separate private live directory, with no admitted runners/workers, `autoMerge: false`, research disabled and no forwarded writer credentials/model keys. One stable configuration notification entered the durable outbox, was sent through the actual Feishu adapter and was remotely read back with exact content, marker and sender-app checks. After a clean restart, complete history showed **2 distinct owner `/status` commands, 2 accepted commands, 2 sent replies, 2 exact remote reply verifications and 0 duplicate markers**. Worker attempts remained **0**. A configuration nonce found in remote history was checked only in process against SQLite/WAL/SHM and Vault bytes and was absent after restart; no command, nonce, private body or IDs were printed. The same live host returned **401** for anonymous `/api/state`, **200** for owner Bearer access and **403** for a missing-token Feishu webhook.

This is bounded transport evidence, not seven-layer or decision-card acceptance. Current-version A/B/C answer/resume, the same answer replayed through real-time/history with one source/case, model execution and paid entitlement/billing, real PRD delivery, launchd installation and off-machine recovery remain unverified. Existing legitimate input remains preserved and blocked awaiting admitted isolated workers. Keep those requirements open in [the checklist](acceptance.md); the full task scope remains active.

Without private chat, verified identity, history access or an active notifier, retain the outbox/question and mark that chain unready. Temporary processing does not authorize archiving its text. Switching notices and bot echoes must not become personal principles or input loops. Do not ask the owner to answer again just because archival projection failed. Protocol tests with fake SDK responses are code evidence, not a live receipt.

## Search gateway contract

Set `PATRICK_RESEARCH_URL` to an approved HTTPS endpoint or a loopback HTTP service. `PATRICK_RESEARCH_TOKEN`, if supplied, is sent as `Authorization: Bearer …`. PAtrick sends a JSON POST for each actual query:

```json
{
  "query": "draft recovery primary source tradeoffs",
  "language": "en",
  "projectId": "patrick",
  "domain": "personal"
}
```

The gateway returns:

```json
{
  "results": [
    {
      "url": "https://example.org/original",
      "title": "Original publication title",
      "publishedAt": "2026-01-01",
      "primary": true,
      "canonicalUrl": "https://example.org/original",
      "conditions": "Where this evidence applies"
    }
  ],
  "summary": "Optional gateway summary"
}
```

The example domain is a contract example, not usable research evidence. The response permits up to ten results. The adapter considers up to five per query, independently opens original/canonical pages, strips scripts/styles/markup, and stores readable excerpts, dates and conditions. Originals must use public HTTPS, with no embedded credentials, private/local address or nonstandard port; DNS and redirects are checked too. Gateway summaries alone are not evidence.

The adapter performs Chinese and English queries, varying terms for originals, tradeoffs and failures. It requires actual query records for both languages and at least two distinct canonical primary sources with readable content. A translation or mirror counts as the same original. Missing originals remain explicit gaps. Do not put confidential material into external search terms unless its domain allows that egress. Without enough support for two viable recommendations, the task remains waiting for evidence rather than fabricating A/B choices.

## MCP and managed tool memory

The `mcp` script starts a stdio MCP client of the already-running HTTP host; it does not open a second database writer. Set `PATRICK_URL` (default `http://127.0.0.1:4317`), `PATRICK_TOKEN`, `PATRICK_MCP_PROJECT`, and `PATRICK_MCP_DOMAIN` privately. The client does not automatically read the host's generated `access-token` file; provide that same token through its environment. Remote URLs require HTTPS, while local loopback HTTP is allowed. Use an explicit Node24/tsx invocation; never put token literals into a committed MCP configuration. An unknown project returns no memory rather than falling back to another project's cards.

The supported tools are `lookup` (current evidence), `ask` (persist a task/question), `get_task`, `get_answer`, and `record_conversation` (an authorized Codex/Cursor turn with session, turn, revision and retention). Query/result tools are read-only; `ask` and conversation capture create ledger work. Tool startup alone does not prove it used current memory. Test a marker only present in one authorized pilot card: the tool must receive and actually cite that version; withdraw it and repeat in a new session. Distinguish Cursor session-start context and subsequent MCP lookups from an unverified per-turn hook. Re-ingestion strips previously injected memory and deduplicates original session/turn/revision.

## Backups and recovery

Run the online backup entry point with the private environment after the host has created its database. It opens the active database read-only and uses SQLite's online backup API. The default destination is `PATRICK_DATA_DIR/backups/<timestamp>`; an explicit CLI directory or `PATRICK_BACKUP_DIR` overrides it. Each destination must be new. For example, after choosing an approved absolute destination:

```bash
node --env-file=.env --import=tsx scripts/backup.ts /absolute/approved/path/new-snapshot
```

The snapshot contains `patrick.db`, `workspace-mode`, approved Vault Markdown (including preserved conflict/independent files), and `manifest.json` with SHA-256 integrity hashes. Published projections are reconciled against the consistent database snapshot; withdrawn evidence is removed. It excludes credentials, machine leases, non-Markdown attachments and temporary files. Copying a live database while ignoring WAL is not acceptable. Retain the matching withdrawal records and verify that a restored index respects them.

With a privately configured `RESTIC_REPOSITORY`, the script also invokes `restic backup` after verifying the local snapshot. Supply restic credentials through a private environment/password file and initialize the approved repository separately. Schedule daily execution and encrypt a copy to an approved second machine; no daily schedule is implied by a single manual command. The presence of a local snapshot does not prove off-machine encrypted backup or a working restore.

Before takeover: stop the old writer, revoke its remote credentials for device handover, replay current permission changes, and reconcile remote PR/message/merge effects before queue resumption. Use the [offline restore procedure](deployment.md#offline-restore-and-writer-takeover), which requires `--writer-revoked --reconciled`, verifies snapshot mode/hashes and withdrawals, and retains the previous directory. The lease code replaces a stale marker only after verifying the prior process is gone; if ownership is unknown, recovery stops. Restored withdrawals must not disappear on FTS rebuild, and replay must not create a second PR/message/change.

The synchronized folder is not a backup: deletion and corrupt edits can propagate. The service's single-writer lock is also not a distributed lease between unrelated copied data directories; device-level handover still needs an explicit ownership procedure.

## Network and host operation

Use the [launchd generator](deployment.md#generate-review-then-load-launchagents) with the actual absolute Node24 path, repository working directory and private environment. Its user LaunchAgents start at login after operator installation; they do not run before login or while the Mac is asleep/powered off. Log paths should be private and outside the synchronization directory; never log environment dumps or source bodies by default.

Only authorized business targets may be probed. Requirements include a one-minute heartbeat, local interface/DNS/route/proxy/TLS diagnosis, and enterprise DNS/route validation before intranet access. Authentication, rate limits and forced MFA need separate handling; repeated VPN reconnects cannot fix authorization.

Tunnelblick/OpenVPN and Shadowrocket operations require host-specific verified commands and permission. Repair must be limited to the failed path, locked, bounded and backed off, then recheck that path, the originally healthy path and heartbeats. Reconcile uncertain remote effects before resuming. Until those commands and permissions are proven, report the path unready; installing an app is not acceptance.

Two simultaneous VPNs require corporate split-tunnel approval plus both startup orders, concurrent traffic and one-path reconnect tests. Verify enterprise DNS/routes and the designated GitHub egress each time. Otherwise use separate approved machines, or drain in-flight writes before a permitted time-sliced switch. With no authorized route, suspend the affected work.

## Validation and handoff

Independent checks are:

```bash
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
npm run check
npm run test:e2e
```

`check` already includes typecheck, all Vitest tests and build; use the individual commands to isolate a failure rather than rerunning everything without a reason. Browser tests are separate and may need `npx playwright install chromium` on a fresh machine. Capture executed commands, time, exit code, test count, skips and artifacts. A configuration-ready indicator is not a live probe result.

Live acceptance needs one no-question and one one-answer real delivery while IDE, Obsidian and workbench are closed, plus per-role fallback, notification outage, all-runner outage, missed file event, duplicate answer, post-PR disconnection, withdrawal/rebuild and backup recovery. Record actual check App/head, merge SHA, file content hash and feedback receipt. [acceptance.md](acceptance.md) has 105 requirements and separate code/live/operations/future evidence; keep unmet prerequisites visible.
