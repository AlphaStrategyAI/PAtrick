# Outcome review implementation plan

> **For agentic workers:** Use subagent-driven implementation with a task review after each ownership handoff. Workers share this checkout and must preserve other edits. Root coordinates integration and publication on `codex/patrick-product`.

**Goal:** Complete the local R032 flow: review frozen judgments when due, associate delivery, later corrections, product measurements, failed checks and abandoned work, and continue observing when results or attribution are missing.

**Architecture:** Reuse the action ledger for immutable outcome evidence and review rounds. Accepted deciding snapshots freeze their first review date. A local background scan creates review records without calling models or remote services. Existing owner-authenticated HTTP accepts source references and quoted evidence from approved integrations; sources intended only as references do not create execution tasks. The standards page reads scoped review views.

**Stack:** Existing Node.js 24, TypeScript ESM, Hono, SQLite, Zod, Vitest and Playwright. No new dependency or service.

## Global constraints

- Preserve the complete original technical proposal, live pilot gates and future phases. No default-branch merge or external model, repository, Feishu, VPN or metrics write.
- A review is an evidence association, not proof that a prediction was correct or that a rule should change. No automatic principle promotion or change of owner preference.
- No required daily tagging, forwarding or export. The import endpoints are for approved programmatic sources; an absent real feed remains unknown.
- Default review interval is 7 days; projects may configure an integer from 1 to 365. New snapshots freeze `reviewAt` and `reviewIntervalDays`; older snapshots without them use `recordedAt + 7 days` and a seven-day interval rather than today's project setting.
- Missing measurements, missing attribution material or measurements before verified delivery keep the result `observing`. `evidence_linked` means current, quoted measurement and attribution materials have been associated; it never claims causal improvement.
- Scope includes project, domain, original snapshot/task, current source revision and authenticated owner. Temporary content cannot enter permanent evidence or reviews. A withdrawal removes readable evidence/review derivatives and cannot resurrect them on restart.
- Preserve immutable initial judgments. Later corrections and results are separate records, never substitutions for what was known then.
- Failed checks are engineering evidence; a blocked connection is not a business failure. Owner cancellation and archival are recorded separately from successful delivery.

## Task 1: Evidence and due-review core

**Owner:** one implementer, exclusively `src/domain.ts`, `src/config.ts`, `src/standards.ts`, `src/intake.ts`, new `src/reviews.ts`, and new `tests/integration/outcome-reviews.test.ts`. Root and other agents must not edit these files while the task is active.

**Contracts:**

```ts
// Additive, optional fields preserve older workspaces.
Project.reviewIntervalDays?: number;
SourceRevision.purpose?: 'task' | 'reference';
DecisionSnapshot.reviewAt?: string;
DecisionSnapshot.reviewIntervalDays?: number;
IngestInput.purpose?: 'task' | 'reference';
```

Reference ingestion keeps the same scoped source identity, revision hash, withdrawal and audit semantics but creates no task. A repeated reference has one source and no task. Reusing the same revision with a different purpose is a conflict; older sources default to `task`. Snapshot capture uses the project's interval, and source/attempt validation is unchanged.

`src/reviews.ts` owns and exports the Zod schemas, input/output types and functions below; other modules import them from this module:

```ts
export function recordOutcomeEvidence(store: Store, config: AppConfig,
  snapshotId: string, raw: unknown, actorId: string, at?: Date): OutcomeEvidence;
export function runOutcomeReviews(store: Store, at?: Date, scope?: Scope): number;
export function outcomeReviewViews(store: Store, scope: Scope, at?: Date): OutcomeReviewView[];
export const outcomeEvidenceInputSchema: z.ZodType; // infer the concrete input type in implementation
export const metricObservationSchema: z.ZodType;
```

Evidence input fields are `projectId`, `domain`, `kind` (`correction`, `metric`, `failure`, `abandonment`), `sourceId`, `sourceRevision`, exact `quote`, `observedAt`, and `attribution` with `method` (`none`, `controlled_comparison`, `direct_measurement`) and `citations: Citation[]`. Omitted attribution defaults to `none` with no citations. Do not accept caller-supplied actor identity. A non-`none` method requires at least one current same-scope exact quotation. Attribution is source-reported material, not host certification of causality.

Metric input does not accept a free-standing numeric value. Parse its quoted JSON through `metricObservationSchema`: `schemaVersion: 1`, `name`, finite `value`, optional finite `baseline`, `unit`, optional positive integer `sampleSize`, ISO `periodStart` and `periodEnd`. A missing sample size stays unknown and keeps the result observing. Require ordered dates, `periodEnd === observedAt`, and no future observation. Other evidence also must not predate the judgment or claim a future observation. Preserve the source author and the owner recorder separately.

Outcome evidence is an action with `kind: 'decision.evidence'`, `status: 'completed'`, task/scope fields and `payload.evidence`. Its stable ID includes snapshot, kind, source revision and quote digest. Identical retries return the original record; conflicting metadata for the same ID is rejected. Validate the original host snapshot, actor/project owner and all source/quotation/retention bounds before writing. Keep task IDs in actions so existing temporary persistence and primary-source withdrawal rules apply.

Review actions use `kind: 'decision.review'` and `payload.review`. Each review includes schema version, ID, snapshot/task/scope, scheduled round, checked/next dates, evidence IDs/source revision references, valid delivery receipt IDs, later owner choices/case IDs, failed planned-test records, cancellation/archive state, `status: 'observing' | 'evidence_linked'`, and explicit gaps. Copy only the evidence needed for review, with its provenance. Keep reviews separate from worker `Review` and never change task execution or rules.

The first due date is the snapshot's frozen `reviewAt` (or legacy default); subsequent rounds use its frozen interval (legacy default seven days). Before due, no review action is created. A round ID includes snapshot, due round and evidence fingerprint; repeated scans/restarts create no duplicate for unchanged inputs. Current evidence changes may append a new report in that round; previous reports remain immutable. A valid `evidence_linked` report requires a current verified delivery receipt, a measurement period starting on/after that receipt, known sample size and valid nonempty attribution quotations. Otherwise preserve `observing` with reasons. Do not label a canceled or technically blocked task as a measured business failure.

Views are scoped, omit withdrawn subjects or readable payloads with withdrawn/obsolete evidence, and expose scheduled date, latest currently valid report and its cited measurements/corrections. Unknown projects return an empty list. Historical reports remain ledger audit subject to withdrawal; they are not reused as currently valid evidence after source changes. The existing generic action withdrawal cleanup must also clear new evidence/review payloads; add only necessary dependency edges and regression coverage.

- [x] Write failing regressions for before/due timing, frozen interval, zero-question and answered subjects, delivery-only observation, attributed/unattributed metrics, temporal causality, exact quotation/JSON validation, scope/owner rejection, duplicate/conflicting evidence, failed checks/cancellation/archive, same-round/restart idempotence, source revision/withdrawal and temporary disk privacy.
- [x] Observe the missing behavior before implementing it, then implement the minimum behavior described above. Use actual Store/snapshots/receipts, not mocks of the function under test.
- [x] Run the focused tests and typecheck, self-review, and write a concise report for a fresh task reviewer. Final core 33/33 plus existing snapshot 14/14 and typecheck passed; the earlier 209-test full run predates the final review fixes.
- [x] Obtain task review for spec compliance and code quality before handoff. Both passed on frozen candidate v2 after blank attribution, per-snapshot choice binding, true delivery-only coverage and repeated action scan findings were repaired.

## Task 2: HTTP and background integration

**Owner:** one integration implementer under root coordination, exclusively `src/app.ts`, `src/runtime.ts`, `src/index.ts`, `src/store.ts` for reference-purpose recovery, new `tests/integration/outcome-reviews-http.test.ts`, new `tests/integration/outcome-reviews-runtime.test.ts` and new `tests/integration/reference-vault.test.ts`.

- `POST /api/reference-sources`: owner authenticated; require project/domain, external ID, revision, title, content, explicit permanent/ephemeral retention. Use `engine.ingest` with `purpose: 'reference'`, kind `reading` and server owner identity. Return the current source metadata, without creating an execution task. Reject wrong scope and purpose conflicts.
- `POST /api/judgments/:id/evidence`: parse and call `recordOutcomeEvidence(..., config.ownerId)`. Return `{ evidence }`; no request field can forge the recorder.
- `GET /api/reviews?project=...&domain=...`: validate configured scope and return `{ reviews: outcomeReviewViews(...) }`; unknown/mismatched scope returns 404.
- `POST /api/reviews/run`: owner authenticated, body project/domain required. Scan only that scope with real server time, never accept a caller clock; return current scoped views. Running a scan is local bookkeeping with no remote/model call.
- Existing `POST /api/projects` forwards a supplied `reviewIntervalDays` through the new project schema, accepting JSON numbers or numeric form values; a missing/blank form field uses seven, while zero, fractions, non-numbers and out-of-range values are rejected.
- Runtime exposes a scoped review scan or calls the core scan, runs it on startup after demo setup, and schedules it once per minute alongside existing timers. Graceful shutdown clears its timer before closing Store. Restore/restart uses the same ledger and does not duplicate rounds.
- Every review route and automatic runtime scan enforces the current project owner. Scheduled scan failures are reported without evidence/error contents and retried on the next minute; explicit scan failures remain visible to callers.
- Independent edits of reference Vault projections preserve the authoritative stored reference purpose across ordinary scans and restart, including when frontmatter is tampered with. Existing task sources keep their prior edit/recovery behavior.

- [x] Write request regressions first; observe new routes returning 404 before implementation. Exercise actual authentication, source import with no task, evidence record/retry, unknown scope, malformed numeric evidence, and rejection of caller time/identity.
- [x] Wire routes and runtime lifecycle, retaining existing CSRF/body limits/error behavior. Final covering verification passed 138 tests in 11 files and typecheck.
- [x] Obtain task review and record results before UI handoff. Frozen v3 passed both gates after owner-boundary, scheduled-error containment and authoritative-purpose recovery fixes; older SQLite/newer Vault, tampered metadata and repeated recovery have regressions.

## Task 3: Readable review UI and documentation

**Owner:** one UI implementer, exclusively `src/web/pages.tsx`, `src/web/components.tsx` and new `tests/integration/outcome-reviews-ui.test.ts`. Existing CSS may be changed only if current layout fails a measured check. Root owns documentation and overall verification.

- Add a project review-interval input (default 7, range 1–365), persist it through project creation and show the saved interval in settings.
- The standards page shows due/scheduled reviews, original judgment title, date, current review state, evidence gaps and separately labeled delivery, reported correction, measurement, failed checks and abandonment information. Use existing surface/layout styles. Hide withdrawn evidence and escape all text.
- Reference source rows are labeled as result evidence, so their purpose is clear without implying an execution task was started.
- Use `outcomeReviewViews` rather than reading raw actions. `evidence_linked` is labeled “已关联结果依据”, with an explicit explanation that it does not prove prediction accuracy or business improvement. Unknown/unattributed outcomes remain “待观察”. No required manual tagging form.
- [ ] Write rendering/request regressions before UI implementation for missing evidence, linked metric, legacy schedule, project isolation, withdrawal and escaping. Add an end-to-end assertion for project interval persistence and review visibility if the existing demo path supplies a real review subject.
- [ ] Run focused tests/typecheck and obtain task review. Root runs full check and Chromium, inspects desktop/mobile and updates English/Chinese README, detailed design, operations, acceptance and test records with observed evidence only.
- [ ] Independently review final source and documents, publish an ordinary commit to the existing product branch and retain exact-head CI evidence in PR #1. Main merge authorization remains pending.

## Source constraints and self-review

The user confirmed there is no existing metrics source and chose to keep business effects observing. The source-reference/evidence contract allows a later approved integration to send reports without generating a PRD task; raw numbers and attribution remain explicitly source-reported. This implementation must be judged by its actual behavior, including unmeasured or unattributable results. Full live, operational, monthly evaluation and expanded-source acceptance remain separate requirements.
