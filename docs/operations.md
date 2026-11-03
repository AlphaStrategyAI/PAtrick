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

The example includes Grok, dsh and Codex command entries, all with `isolation: "lima"` and `instance: "patrick"`. **Lima was missing on the inspected host.** The example is not proof that a VM exists or any CLI is authenticated. Install and validate the host runtime before changing `admitted`.

Each runner policy independently names roles, domains, provider, model, `costPerRunUsd` and `independentReview`. The example `model: "unconfigured"` and `costPerRunUsd: 0` deliberately provide no model or price claim; the scheduler requires a positive cost reservation. It charges that reservation before each attempt, retains it for failed/unavailable attempts, and only increases it if an adapter reports more. The current Lima adapter reports the configured reservation; `spentUsd`, `Attempt.costUsd` and weekly `reservedCostUsd` are conservative budget accounting, not provider invoices. Replace values with verified bounds and record actual entitlement/billing independently before admission.

The seven roles are `knowledge_extract`, `case_extract`, `decide`, `plan`, `execute`, `check`, and `feedback`. Current knowledge/case/decision/execute order is Grok→dsh→Codex; plan/check/feedback order is Codex→Grok→dsh. The scheduler excludes the execution runner from checking unless `independentReview` is admitted, then retains role order. There is currently no explicit dsh-first execution option or additional different-runner sort. Those remain design requirements to verify before claiming full role-selection acceptance. At least one admitted backup is necessary to accept automatic fallback.

Grok uses a noninteractive CLI, dsh uses ACP, and Codex uses `codex exec`. CLI flags and versions must pass the adapter's current protocol test before admission. The adapter prepares a private guest `/tmp/patrick-*` workspace, provides structured input, validates output against the role Schema and runs bounded plan tests in the guest for execute/check. Do not grant arbitrary host execution as a workaround for a CLI failure.

Validate that the Lima instance has no default host filesystem mount and no forwarded SSH agent, only the approved task material, no repository writer credentials, restricted egress and approved session-upload behavior. Installing Lima is only the first step: actual provider permissions, isolation, fees and independent checking still need evidence. A task or review's declared tests do not substitute for remote CI proof.

Unavailable runners may be replaced automatically. Test failures trigger business repair, not fallback. Every real switch records a notice for the owner; notification failure should remain queued. All unavailable candidates retain the task with a future probe. Questions release the worker indefinitely, and no answer means no automatic choice. Repair is bounded to two rounds and the task budget.

## Feishu settings and catch-up

Required environment names are:

```text
FEISHU_APP_ID
FEISHU_APP_SECRET
FEISHU_VERIFICATION_TOKEN
FEISHU_OWNER_OPEN_ID
FEISHU_CHAT_ID
```

Set `FEISHU_ENCRYPT_KEY` when event encryption is enabled. Use the same verified owner across `PATRICK_OWNER_ID`, project `ownerId`, and the bound Feishu Open ID. Configure private-chat delivery and authorized history-reading scopes. Verify callbacks at `POST /webhooks/feishu` with the platform verification/encryption contract; it is separate from the browser login.

The transport supports the official SDK WebSocket event connection as well as a verified webhook endpoint; choose the tenant's authorized event-delivery mode. A local WebSocket connection does not require publishing the whole workbench. Supported owner text commands are `/status`, `/lookup PROJECT_ID QUERY`, `/task PROJECT_ID CONTENT`, and `/answer QUESTION_ID TASK_VERSION.QUESTION_VERSION A|B|C [YOUR_WORDS]`. A direct reply of A/B/C to the corresponding question message can also bind to that question; C requires original text. In a single configured project, ordinary owner business text can enter that project; with multiple projects, specify `/task`.

One successful send does not prove two-way operation. Record a verified callback, an A/B/C reply at the current task/card version, and an offline catch-up using history watermarks. Replaying the same original reply through real-time and history must resume once and create one source revision and case. Temporary processing does not authorize archiving its text. Switching notices and bot echoes must not become personal principles or new input loops.

Without private chat, verified identity, history access or an active notifier, retain the outbox/question and mark that chain unready. Do not ask the owner to answer again just because archival projection failed. Protocol tests with fake SDK responses remain code evidence, not a live Feishu receipt.

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
