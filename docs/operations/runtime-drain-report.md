# Service runtime ownership and drain

This report records the finite T23 service-factory and resource-drain prerequisite, verified locally on November 18, 2026. It does not establish installed-service, independent writer-fencing, operational Autoloop Hub, native package, or production lifecycle acceptance.

## Import and composition

Installed composition imports `@patrick/service/factory`. Importing this subpath does not create the application singleton, open a database or credential store, register timers, or start workers. The existing `app.ts` module remains the compatibility entry that exports the named singleton and `createApp`.

`createServiceRuntime(options)` returns an application and its owned lifetime:

```ts
const runtime = createServiceRuntime(options);
// The listener owns its own admission and socket lifetime.
runtime.stop();
const result = await runtime.drain({ timeoutMs: 5000 });
// result.status: running | draining | closed | close_failed
```

`stop()` synchronously closes request admission, requests cancellation of owned work, and prevents new worker turns. It preserves caller cancellation by combining it with internal signals. `drain()` begins the same shutdown if necessary, joins actual work and asynchronous cleanup, and then closes owned resources. Repeated calls share one shutdown and close operation. Invalid timeout bounds reject before shutdown begins. Results include the active-task count and a bounded list of generic error codes; application error details are not copied into this public result.

The default bound is 5000 ms. A timeout returns `draining` while the unfinished work and its database resources remain alive. Later completion can close those resources automatically; `read()` or another `drain()` observes that outcome. Cancellation by itself is not completion. `close_failed` reports an actual resource-close error and conservatively retains the remaining main connection. Successful closure closes the local answer Hub before the main service database, once each.

## Owned work

The runtime tracks admitted Hono handlers and response-body producers. New requests receive 503 once stopping begins. Admitted handlers that ignore cancellation may finish their receipt or finalizer SQL before resource closure. SSE cancellation joins the actual authentication/poll promise, avoids awaiting itself, and never rearms the stopped poll timer. A custom stream supplied by trusted composition must make its cancellation represent the cleanup of its producer.

All seven loops expose their actual completion through `stop`, `join`, `errors`, and `active`: consultation, PR delivery, product-view sweep, Hub observation, HTTP collection, notification maintenance, and work-stop observation. Raw Hub/backend calls and notification transports remain owned when they outlive logical deadline or cancellation races. Source DNS and HTTP promises are tracked before the existing cancellation race through the optional trusted `trackAsync` capability, including the default native port. Request-owned source-preview calls and worker-owned collection calls reach their respective lifetime trackers.

This API owns no HTTP listener. The installed bridge must stop listener admission, propagate request and stream cancellation, retain sockets and response producers until they settle, and aggregate its own completion with runtime drain. A listener timeout cannot certify writer stop or external fencing.

## Exact resource handoff and startup failures

The optional trusted callback has this signature:

```ts
bindRecoveryOperations?: (resources: {
  database: SqliteDatabase;
  hub: LocalHubPort;
  hubDatabase: SqliteDatabase;
}) => RecoverySettingsConfiguration | undefined;
```

It receives the exact runtime-owned main connection and the exact connection backing the local answer Hub. It runs after `recoveryRuntime.attach` installs the main connection's recovery gate and before workers start. Its returned recovery settings configuration is shared by settings handlers and target enumeration. Existing static `recoveryOperations` remains supported. This callback is an in-process capability supplied by trusted composition.

`createLocalHubPort(filePath, onDatabase?)` keeps one-argument callers compatible. The optional owner callback receives the actual opened connection before Hub table and statement initialization. A callback or initialization failure closes that handle. The runtime captures it early enough to retain a partial-startup cleanup path. It does not open a substitute connection.

A resource-owning startup failure throws `ServiceStartupError` with the original trusted `cause` and `cleanup.stop/drain/read`. Composition can therefore await or report unresolved cleanup. The compatibility `createApp` wrapper rethrows the original cause. Early validation failures that own no resources retain their existing errors. A lazy recovery-attachment failure is terminal: the runtime records `RECOVERY_RUNTIME_ATTACHMENT_FAILED`, initiates shutdown, rejects later requests, and prevents already-queued contexts from using the failed connection. It retains the handle exclusively for ordered cleanup; a failed close stays visible as `close_failed`. Once attachment has succeeded, lazy credential initialization may retry on the same retained, already-gated main connection.

The exposed Hub is the existing local answer database. Its schema and behavior remain those of `LocalHubPort`; it does not acquire a recovery-gate schema. It is separate from the independently pinned and provisioned operational Autoloop Hub. Later production composition must report missing operational-Hub or recovery authority explicitly and retain existing backup/restore admission. Exact handle access does not supply those authorities.

Drain closes connections after joining. A future backup/freeze controller must respect that close boundary, coordinate the actual listener and writer owners, and use the separately reviewed recovery/fencing protocols. This increment does not prove a complete backup-before-migration lifecycle.

## Verification and limits

The final 16-file implementation adds 29 runtime admission cases covering import safety, lazy shutdown, ignored cancellation and finalizer SQL, repeated and self-initiated drains, late admission denial, caller cancellation, exact main/Hub identity, gate/bind/worker order, once-only ordered closure, startup callback/initialization failure, awaitable cleanup, credential retry, close errors, deferred SSE authentication, all seven loops, raw port lifetimes, and terminal recovery-attachment failure. Hub identity tests write through each API and read through the other on the same actual SQLite connection. The attachment regression covers queued and successive lazy requests with both successful and failed resource closure; no credential initialization or protected route is admitted afterward.

The first independent review found that a cached connection could be reused after lazy recovery attachment threw. Its focused experiment and FAIL report remain preserved. The regression reproduced an incorrectly admitted queued route before the repair; the repaired cases now pass alongside the successful-gate credential retry case.

An earlier final run also exposed the existing `tests/admission/T10.test.ts:23` assumption that the SDK import must fail with `ERR_MODULE_NOT_FOUND`, although the installed SDK imports successfully. The failure reproduced with the baseline Hub constructor before Hub construction. The portability repair isolates and restores the four credential environment inputs, checks the actual SDK import outcome/diagnostic independently of missing-credential admission, and persists the simulated observation in a temporary fixture copy. It retains actual probe execution, blocked channel/message ID assertions, evidence hashing, and durable web-answer readback. It does not rewrite the tracked admission matrix. The old failing logs remain historical evidence.

Final implementer runs pass 44 selected cases: 29 runtime admission, two T10 portability, three source projection, six recovery-runtime, two direct one-argument Hub replay/reopen, and two recovery answer-return cases. Final scoped ESLint and root/Web TypeScript checks pass. Root independently repeats the 40-case runtime/T10/source/recovery selection, scoped lint, root/Web types and whitespace checks on the frozen final files before rereview.

The preceding 14-file milestone passed 192 selected cases across the directly affected service, projection/SSE, source, notification, work-stop, PR, contract and recovery boundaries. Those are historical results on the preceding frozen bytes. Those historical results do not replace the fresh checks on the repaired factory.

Initial lifecycle, raw-source tracking, startup-cleanup and exact Hub-owner regressions have preserved behavioral RED/GREEN evidence. The SSE old-code reproduction and some expanded edge-case tests were added after implementation and are recorded as regression/coverage evidence. Intermediate test-setup failures are retained separately and are not claimed as behavioral REDs.

All runtime cases use temporary databases and controlled finite test ports. No external provider calls, real messages, personal/company Vault changes, installed service enrollment, launchd changes, native packaging, independent fencing, reboot, or production recovery activation was performed by this increment. Whole T23 and the later T25/T26 acceptance gates remain open.
