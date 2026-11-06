# Zero additional spending cap implementation plan

> **For agentic workers:** Use `subagent-driven-development` to implement and independently review this task. Parent owns live configuration, Git checkpoints and publication.

**Goal:** Let the owner reliably express a zero-dollar additional-spending cap through configuration and project creation, while retaining the scheduler's denial of unverified zero-cost or paid calls.

**Architecture:** Keep project money limits in the existing shared Zod schema. Normalize HTTP number fields without converting a real zero or invalid JSON value into the five-dollar default. The project form starts with zero and explains that subscription entitlement remains a separate admission requirement. Existing scheduler reservation checks remain intact.

**Tech stack:** Node24, TypeScript, Hono, Zod, Vitest and Playwright; no new dependency.

## Global constraints

- The user permits existing included Grok/Codex subscription allowance only, with no additional billing. A zero-dollar cap is not proof of included entitlement or disabled paid overflow.
- Accept finite project budgets from 0 through 10000 inclusive. Missing or blank HTTP budget retains the existing five-dollar default; a new browser form explicitly starts at zero.
- JSON numeric `0` and decimal strings such as `'0'` remain zero. Reject negative, nonfinite, malformed, hexadecimal/binary, boolean, null, array and object values. Preserve finite decimal/scientific numeric strings accepted by number inputs.
- All roles, fallback and retry continue requiring the existing positive reservation until a separate host-verified subscription admission path exists. Do not admit a worker merely because its claimed cost is zero.
- Keep owner/authentication/scope, frozen task history, source revisions, paid reservation accounting, role order and independent checking unchanged. No live model, guest, Feishu, remote write, billing portal or credential operation in implementation tests.
- Worktree base is `9217be76431db22e809d10ac07a40f36bf8240b0`. Preserve other work; no source changes outside the owned files.

## Task 1: Preserve and enforce zero-dollar caps end to end

**Files:**

- Modify `src/config.ts`, `src/app.ts`, `src/web/components.tsx`.
- Extend `tests/unit/config.test.ts`, `tests/unit/runner-preferences.test.ts`, `tests/integration/http.test.ts`, `tests/e2e/workbench.spec.ts`.
- Do not modify `src/scheduler.ts`: its current paid reservation gate is the behavior this prerequisite retains and tests.

**Interfaces:** `projectSchema` continues returning `Project`; `POST /api/projects` continues returning the created project and redirect; `ProjectForm` retains existing field names; `Scheduler.run` continues blocking before worker/attempt creation when either cap is zero.

- [x] Write failing schema and HTTP regressions before implementation. Exercise real `projectSchema`, Hono requests and Store persistence, not a reimplementation of the parser. Example critical expectations:

```ts
expect(projectSchema.parse({ ...base, budgetUsd: 0 }).budgetUsd).toBe(0);
expect(projectSchema.parse(base).budgetUsd).toBe(5);
// Use the existing authenticated/demo request fixture with a complete valid project.
expect(response.status).toBe(200);
expect(data.project.budgetUsd).toBe(0);
expect(store.get('projects', data.project.id)?.budgetUsd).toBe(0);
```

Cover numeric zero and string zero with JSON/form submissions, missing/blank default five, ordinary positive/maximum values, invalid input families, and no project record on rejection. Reload settings for the newly created project and verify displayed zero. Assert form minimum and initial value are zero, with explanatory pending-entitlement text.

- [x] Add scheduler regressions through the existing real scheduler fixture: project cap zero with an older positive task cap; task cap zero with a positive project cap; zero-cost admitted policy without subscription proof. Each returns no result, calls no worker, creates no attempt/reservation and leaves the original task blocked with spent amount unchanged. Keep all existing paid/fallback/role tests passing.
- [x] Run the focused tests on unchanged implementation and capture meaningful RED failures for zero schema/HTTP/UI behavior. Existing scheduler denial controls may already pass; do not weaken them to manufacture RED.

```sh
npm test -- tests/unit/config.test.ts tests/unit/runner-preferences.test.ts tests/integration/http.test.ts
```

- [x] Allow the shared schema's finite zero value:

```ts
budgetUsd: z.number().finite().nonnegative().max(10000).default(5)
```

- [x] Replace only the HTTP budget coercion. Keep invalid JSON types intact for Zod rejection, and convert only valid decimal/scientific strings:

```ts
const rawBudget = value.budgetUsd;
const budgetUsd = rawBudget === undefined ||
  (typeof rawBudget === 'string' && rawBudget.trim() === '')
  ? 5
  : typeof rawBudget === 'string'
    ? /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(rawBudget.trim())
      ? Number(rawBudget)
      : Number.NaN
    : rawBudget;
// Pass budgetUsd to projectSchema.parse; never use rawBudget || 5.
```

- [x] Change the existing budget input to `min="0"`, keep maximum/step/field name, and set initial `value="0"`. Add the field hint: `0 将阻止需要费用预留的运行器；订阅权限仍需单独核验。` Do not label zero as free or admitted.
- [x] Add one meaningful browser case: create a complete project with the default zero-dollar field, verify native input validity and successful persisted creation, reload scoped settings and verify zero. Use the existing synthetic demo server on4318, never the live4320 service. Run that case once with Playwright's grep and report result; parent owns the final whole declared lane.
- [x] Run focused tests, `npm run typecheck` and `npm run build`. Write `.superpowers/sdd/zero-cap-report.md` with RED/GREEN, commands/counts, ownership, hashes and limitations; return ownership for independent spec+quality review. Parent commits after review; no Git mutation by the implementer.

## Parent operational verification and remaining work

After code review and declared checks, root may atomically set the private pilot project's budget to zero and cleanly restart its normal host. `startRuntime` saves configured projects before loading the persisted list, so this applies to the existing project without creating a duplicate through the create-only HTTP endpoint. Preserve old task budgets/history, all legitimate inputs, unadmitted workers and private credentials. Verify the current project cap is zero and no model attempt occurred.

This prerequisite does not complete subscription-only dispatch. Provider-specific unprivileged execution, approved egress/session controls, actual guest authentication/account allowance/paid-overflow prevention, host-bound admission evidence and bounded zero-cost retries remain separate requirements before any real model call. No API billing fallback, credit purchase or account-wide billing change is authorized.
