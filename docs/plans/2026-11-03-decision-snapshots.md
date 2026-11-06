# Decision snapshot repair implementation plan

> **For agentic workers:** Use the existing subagent-driven review workflow. Root owns the domain, storage, standards, orchestration and regression tests; the UI worker may own the standards view after the contract is fixed. Workers share this checkout and must preserve other edits.

**Goal:** Implement the frozen-case contract in technical proposal §3③/R030 and the judgment-history portion of R032: retain the judgment that existed before the owner answered, its actual rule versions, explicit expectation and receipt-backed outcome history. R032's automatic due review and later correction/product-metric linkage were outside this repair; their local contract was subsequently verified on 2026-11-04 in the [outcome-review follow-up](2026-11-03-outcome-reviews.md). Live acceptance and measured business effects remain separate.

**Architecture:** Save a versioned, host-owned snapshot in the existing action ledger after a successful deciding attempt. The snapshot contains the exact admitted attempt/input hash, goal, decision, only the rules it used, source revision references and available research. Questions bind the snapshot ID; authenticated cases copy that snapshot. Feedback appends a stable receipt-linked result. Retraction removes readable snapshot/result derivatives, and ephemeral snapshots remain in process memory.

**Tech stack:** Existing Node.js 24, TypeScript ESM, SQLite, Vitest and Hono SSR; no new dependency or service.

## Constraints

- Preserve the original technical proposal and its live acceptance gates.
- No remote business writes, default-branch merge or changes to credentials/services.
- Historical records without a snapshot remain explicitly unknown; never reconstruct a historical judgment from current data.
- An optional `expectedOutcome` preserves older worker adapters; an absent expectation is recorded as unknown. CLI prompts request an explicit prediction, not an observed outcome.
- Only rules actually supplied to the successful attempt and named by its decision may enter the snapshot. A rule changed during that attempt invalidates acceptance.
- Permanent tasks cannot persist evidence from a source authorized only for temporary processing.
- Withdrawal removes readable snapshots/results from cases and ledger payloads, clears dependent question/task content and reconciles Markdown projections; dependency cleanup follows older snapshot actions even without a current citation. Stable identifiers may remain for audit, and outcome receipts retain their existing boundary.

## Task 1: Freeze judgments across answer and feedback

**Files:** `src/domain.ts`, `src/standards.ts`, `src/orchestrator.ts`, `src/intake.ts`, `src/store.ts`, `src/integrations/workers.ts`; regression coverage in `tests/integration/decision-snapshots.test.ts`.

**Interfaces:** `DecisionSnapshot` is schema version 1, with `id`, `taskId`, `taskVersion`, `attemptId`, `inputHash`, `sourceId`, `sourceRevision`, frozen goal/decision/rules/source references, nullable explicit expectation, optional research and recording time. `Question.decisionSnapshotId` and `Task.decisionSnapshotId` are optional legacy-compatible references. `DecisionCase.decisionSnapshot` and `DecisionCase.outcomes` are optional legacy-compatible frozen data. An outcome has a stable ID, receipt ID, timestamp and feedback summary.

- [x] Write real-store workflow regressions for A/B/C. Assertions include `case.decisionSnapshot.decision.summary`, `case.decisionSnapshot.rules[0].version`, the explicit expectation and `case.outcomes[0].receiptId` after the task has resumed and the rule has changed.
- [x] Run `npm test -- tests/integration/decision-snapshots.test.ts`; observe failure because historical snapshots are absent. Seven failures were observed before implementation at 18:17 Asia/Shanghai.
- [x] Implement snapshot capture in the same transaction as deciding-state advancement. Associate it with the latest successful deciding attempt and the original `WorkerInput`, copy it to a case only through the frozen question reference, and append feedback using the verified receipt ID.
- [x] Add and run regressions for no-question decisions, rule changes during an attempt, source withdrawal, process restart, temporary data on disk, and permanent-task rejection of temporary evidence. Verify all newly introduced failures before their fixes.
- [x] Extend Markdown case rendering and the standards view to show the frozen judgment, used rule versions, expected/unknown outcome and receipt-linked observed result. Historical missing data gets an explicit unavailable label.
- [x] Run targeted tests, then `npm run check` and `npm run test:e2e`; obtain a focused independent review of the final diff, including retraction and retention paths. Observed 186/186, 14/14 and no unresolved P1/P2.
- [x] Update detailed design, operations and acceptance/test records using observed results.

Publication receipts belong in PR #1: publish an ordinary commit to the existing product branch, retain its exact-head CI evidence and keep full goal/live acceptance pending until the real prerequisites are provided. This plan's local checkboxes do not grant default-branch merge authorization or live acceptance.

## Self-review

The repair covers original judgment, goal, evidence quotes, actual rule versions, explicit/unknown prediction, immutable alternatives and owner wording, append-only outcomes, and authorization-aware removal. It adds no monthly evaluation, new source connector or live acceptance claim before the first pilot passes.
