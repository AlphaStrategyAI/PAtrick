# PAtrick · Product requirements

PAtrick connects authorized source material, attributable knowledge, personal decisions, and verifiable delivery in a private workbench.

## First supported workflow

An owner edits an idea in one configured productIdeas directory. PAtrick captures the revision, retrieves current evidence and applicable standards, and either archives an unsupported hypothesis, proceeds with supported requirements, or researches a real tradeoff before asking the owner once. It plans, prepares a scoped PRD change, independently checks the actual artifact, and follows the remote PR through trusted CI, merge, file readback, and feedback.

## Acceptance criteria

- Source revisions, quotations, knowledge cards and personal principles remain bound to one authorized project and data domain.
- The owner can find a current source quotation with Chinese short words such as 草稿 or 恢复.
- A question offers exactly A, B, and a free-text C; an authenticated current-version answer resumes its original task once.
- Technical failures retry without asking the owner to make a business decision. Worker fallback produces a durable notification.
- A revoked source stops supporting new decisions and is removed from retained derived text and search, including after index recovery.
- A task is delivered only after every named trusted check succeeds on the reviewed head and the merged formal PRD is read back with a matching content hash.
- Missing checks, skipped checks, changed source versions, changed target branches, failed tests and unknown remote outcomes cannot produce a delivery claim.
- The workbench remains usable on desktop and mobile, with accessible native forms, keyboard navigation and clear empty states.
- Demo fixtures use a separate workspace, are visibly labeled and never write to a remote repository.

## Operational boundary

Live acceptance requires operator-approved model runtimes and budgets, an isolated Lima executor, a repository with trusted required CI, a verified owner interaction channel, and approved research/network paths. Configuration status and synthetic test evidence do not establish live acceptance. Current evidence is tracked in `docs/acceptance.md`.
