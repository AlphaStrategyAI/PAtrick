# PAtrick web foundation

From the repository root, run `npm run dev:demo -w @patrick/web` for the
bilingual demo. Samples are labeled and do not call the service. Use
`PATRICK_LOCAL_SERVICE=http://127.0.0.1:4194 npm run dev -w @patrick/web`
when the service is listening at that upstream address. Open **http://localhost**
(no explicit port). Live development binds port 80 because the T03 passkey and
session-write gate require that exact browser origin. The Vite proxy forwards
the browser’s Origin unchanged. If port 80 is reserved, serve the build
through an authorized local listener at the same origin; a different port,
`127.0.0.1` as the browser hostname, or an Origin override will not sign out.
A failed write is reported as an error. The release build
(`npm run build -w @patrick/web`) uses the same-origin API. Remaining domain
pages intentionally show that their services are not connected to the shell yet.

The browser client validates T01 request and response contracts. Query keys
include the account, domain and permission epoch. A projection subscription
starts at the snapshot's `stream_cursor` and replays from `Last-Event-ID`.
The client batches notifications and refetches until both watermarks are
covered. Query hooks opt in via `useScopedSnapshot(..., { projection: true })`
only for T13 projections, such as system health or work views. Independent
queries and terminal read errors do not block progress. The stream never
replays commands. A transient transport failure backs off and resumes
the cursor. An explicit reset or authorization denial aborts
reads and removes cached private data. After a reset the browser checks the
session and fetches new scoped snapshots before displaying private data
again. Revalidation clears the prior account’s drafts if access is denied
or the account, domain, or permission epoch has changed. Consultations and
decisions should use distinct draft keys; see `src/state/drafts.ts`.

Locale mode and motion preferences are stored per verified account. They
remain local until preference sync is connected. Locale changes don't issue
commands or change a draft key, receipt, or business revision.

For the foundation test run `npm exec -- vitest run tests/unit/T14.test.ts`.
To run the browser suite, install the pinned Chromium with
`npm exec -- playwright install chromium`, then run `npm run test:e2e`.
The Chromium revision, desktop/mobile viewport, pixel ratio, rendering
options, and font checksums are recorded in `rendering.lock.json`. Screenshots
and final release coverage are a separate T24 deliverable.
