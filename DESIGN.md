# PAtrick interface design

The interface should feel like a quiet editorial workbench: warm paper, forest green navigation, restrained olive accents, readable Chinese text, and evidence that is easy to inspect. Its purpose is to make ongoing work and genuine decisions legible. The canonical implementation tokens live in [public/styles.css](public/styles.css); original inline SVG primitives live in [src/web/components.tsx](src/web/components.tsx).

## Color tokens

Use these current CSS tokens consistently:

- `--paper: #f7f7f2` — main warm ivory page.
- `--sidebar: #eeeee7` — quiet left rail.
- `--white: #fffefa` — cards and readable surfaces.
- `--ink: #252d29` — primary text.
- `--muted: #777e76`, `--faint: #95998f` — supporting text; essential status must retain a text label.
- `--line: #e3e5db` — subtle divisions.
- `--green: #2c5140`, `--green-deep: #203e31` — primary controls, links, focus and active navigation.
- `--green-soft: #eaf0e5`, `--green-line: #d3dec9` — selected and positive backgrounds/borders.
- `--amber: #927032`, `--amber-soft: #f5efdf` — waiting and evidence gaps.
- `--red: #a0483c` — explicit destructive or error actions.

Secondary olive tones appear in navigation, tags and status dots. Keep them subordinate to forest green; do not introduce competing saturated gradients. Success, waiting, and faults must be recognizable through wording and iconography as well as color. A green demo receipt remains explicitly a demo receipt.

## Type and spacing

Body type uses the local stack `'Avenir Next', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif`. Display type uses `Georgia, 'Songti SC', 'STSong', serif`. Monospace is reserved for versions, paths and hashes. These names request installed system fonts; no proprietary font files are copied, bundled or redistributed.

The base CSS uses 13 px body text at line-height 1.65, with larger Chinese headings and compact secondary metadata. Keep primary task meaning and decision text comfortably readable at the supported viewport sizes; metadata should not become the only way to understand state. Prefer a rhythm based on 4/8/12/16/24/32 px, with existing component-specific spacing preserved when it supports the layout.

Cards use `--radius: 12px` and a very light `0 3px 12px rgba(38,48,40,.035)` shadow. Borders and whitespace carry hierarchy. Avoid heavy shadows, decorative dashboards, and excessive pill-shaped panels.

## Navigation and workbench

The desktop left rail is 224 px and the top bar is 73 px in the current CSS. Navigation is workbench, knowledge, standards, sources, activity, and settings. The standards route is `/standards`; the visible Chinese label is “判断标准”.

The main workbench has three clearly named columns:

- **正在处理** — intent, latest progress and what will happen next.
- **等我回答** — only real owner choices, with frozen A/B recommendations and C free input.
- **建议与结果** — useful suggestions, archived hypotheses and verifiable completed work.

Do not place worker switching notices in the waiting column. Show technical faults on the relevant task and in activity. Counts and recent times come from the ledger. Empty and unconfigured states should explain the actual state without fabricated statistics or example tasks in live mode.

Task details open in a side drawer and remain reachable through `/tasks/:id`. Show the source revision, seven-layer trace, attempts, applied rules, research and remote receipt. Make hashes and links secondary to the business result while keeping them inspectable. A merged receipt needs its repository, file, merge SHA and trusted check evidence.

## Decision and evidence interaction

Every question presents exactly A, B and C. A/B include specific action, reason, tradeoff and evidence. C reveals a labeled free-text field. Show the research gap when it exists, preserve custom text after a failed submission, and explain stale versions explicitly. The server decides whether an answer is current; a UI success animation cannot establish acceptance.

Knowledge cards reveal precise original quotations, source locators and revisions. Standards distinguish explicit owner principles, observations and external references, with scope and version. Source pages distinguish covered, unconfigured and unsupported inputs. Settings show admission and connection information, never credential values.

## Responsive behavior and accessibility

At narrow widths, navigation becomes an explicit menu, task groups stack, and the drawer uses the available width. Test 375, 768 and 1440 px without horizontal overflow. Retain group names and evidence links; do not compress the complete desktop grid into unreadable columns.

Use semantic links/forms/buttons, visible keyboard focus, labeled fields, a skip link and status/error announcements. Escape closes dialogs and returns focus. Reduced-motion preferences are respected. Forms and knowledge search remain functional without JavaScript; JavaScript improves navigation, drawers and submission feedback.

Screenshots are supporting visual evidence; behavior requires browser tests. Review blank, waiting, failed, stale, delivered and demo states, not only a populated first screen. No third-party page, logo or proprietary font is copied as a design source. Changes to shared tokens should update this file and the stylesheet together.
