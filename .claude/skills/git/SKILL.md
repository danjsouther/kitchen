---
name: git
description: Rules on commits, branches, and merges in this repo
license: MIT
---

# Commits
- update changelog before a every commit
- version bump must be in a separate commit, with updated changelog, readme, todo, and package files.
- **Message format**: a single line, sentence-case, ending in a period, describing
  the outcome (not the mechanism) — e.g. "Allow shopping put-away across
  locations and undo a mistaken receive." Match the style already in `git log`;
  don't add a body unless the change genuinely needs one.
- **Never** `--no-verify`, `--no-gpg-sign`, or force-push `main`.
- Prefer a new commit over `--amend` once a commit has left your hands (pushed,
  or reviewed) — amending rewrites history someone else may already have.

## Changelog entries
`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html): newest-first
under `## Unreleased`, one entry per change:

```
### Category — Title (YYYY-MM-DD)

Prose description of what changed and why, written for someone reading the
history later, not for the PR.
```

`Category` is `Added`, `Changed`, `Fixed`, or `Removed`. Date is the day the
work landed. A version bump moves `## Unreleased` entries under a new
`## x.y.z` heading (semver — matches the `version` field bumped in
`package.json` across all three packages), inserted above the previous
version heading, in the same commit as the version files. **Tag the release
`v<version>`** (e.g. `v0.2.0`) once that commit lands.

# Merges
- **Never merge `main` into a feature branch.** Always rebase instead.

# Branches
- `main` is the only long-lived branch. All others are short-lived feature branches.
- always create a feature branch from `main` and rebase it onto `main` before merging back.

# Line endings
`.gitattributes` pins `eol=lf` project-wide — that's a deliberate override of
whatever `core.autocrlf` your machine has set (this repo assumes
`autocrlf=true` locally, which normalizes on checkout/commit anyway). Never
"fix" line endings on a file by hand or fight `.gitattributes` per-commit; if a
file is showing as fully rewritten, suspect the *attributes*, not the content.
A CRLF shell script or Dockerfile is a syntax error inside the Linux container,
not a cosmetic issue.