# ShipScope – slide material

> Slides 3–5 (how it works, comparison, summary) described the original serverless model — GitHub Actions,
> JSON files on `live`, "no server, no database, data stays in our repository" — and were removed when
> ShipScope became a hosted multi-tenant service (`server/`). Rewrite them together with the marketing material
> at the launch stage (`context/foundation/prd.md` → "Deferred to the End").

## Slide 1: What ShipScope is

**ShipScope is a single dashboard that shows what is actually running on TEST, QA and PROD.**
It brings three sources of truth together in one place: **deployments (GitHub)**, **feature flags** and **tasks (Jira)**.

- Product view: Epic → Story/Task/Bug, with the real status on each environment
- Technical view: component × environment matrix, deployment history, flags
- Release Notes generated from the same data

## Slide 2: The problem it solves

- "Is this already in production?" – answering it means digging through Jira, GitHub and flag code
- "Deployed" does not mean "visible to users" – the code can be on PROD while the flag is off
- Rollbacks, version drift between environments and flags left on forever are hard to spot
- POs and the business don't read GitHub Actions, and the technical team doesn't live in Jira

**ShipScope answers it at a glance, in language both sides understand.**
