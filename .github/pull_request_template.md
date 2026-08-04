<!--
Base branch: `dev` for anything except a hotfix or a release.
See docs/BRANCHING.md.
-->

## What changed

<!-- The outcome, not the mechanism — the same voice as the commit subject. -->

## Checklist

- [ ] Base branch is `dev` (or this is a release/hotfix PR into `main`)
- [ ] Rebased onto the base branch, not merged from it
- [ ] `CHANGELOG.md` has an entry under `## Unreleased`
- [ ] `npm run build` and `npm test` pass locally
- [ ] **Ran it.** Drove the change in the browser via `npm run dev:up`, checked
      the console, and cleaned up any test households — every serious bug in
      this repo passed its unit tests and the compiler first
- [ ] Failed conversions surface as typed failures, not `0` — "not countable"
      and "missing" stay distinct
- [ ] Quantities and prices stayed `Decimal`/string end to end; no JavaScript
      number in either direction
- [ ] Catalog writes are scoped to the household; no new cross-tenant read
- [ ] Any new form uses `@angular/forms/signals` per docs/SIGNAL-FORMS.md

## How to verify

<!-- The steps a reviewer should take to see this working. -->
