# ShipScope – slide material

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

## Slide 3: How it works

1. **GitHub Actions workflows** pull data from the GitHub API and Jira on a schedule and after every deployment
2. The data lands in **JSON files** in the repository (the `live` branch)
3. A **static page** (plain JS, no server, no database) joins it in the browser:
   Jira issue → commits in a deployment → flag state → status on the environment

Task status on an environment: *Not deployed → Deployed (hidden) → Partial → Released*.

## Slide 4: Why it beats off-the-shelf tools

| | Typical market tools | ShipScope |
|---|---|---|
| Scope | Separate: deployments, flags or tasks | **One combined task–flag–deployment view** |
| The business question "can the user see it?" | No answer – only "deployed" | **Takes the flag state into account, not just the deploy** |
| Infrastructure | Paid SaaS or your own server and database | **No server – GitHub Actions + GitHub Pages** |
| Cost and maintenance | Licences, integrations, agents | **No licences, no dependencies, a few Node scripts** |
| Data | Outside the organisation | **Stays in our repository** |
| Fit | Generic, configured to a standard | **Tailored to our process: PIs, sprints, teams, environments** |
| Risk signals | Usually none | **Rollbacks, drift between environments, flag "ghosts", open bugs in an Epic** |

## Slide 5: Summary

> **From "we deployed" to "users can already see it" – with no new server, no licences and no manual reporting.**

- Current state, not an archive – history stays in GitHub and Jira
- Adding a component = one config entry + wiring up the workflow
- Ready for POs, dev teams and management
