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

## Writing the message without mangling it
This repo is worked on from two shells with incompatible quoting — Git Bash
(POSIX `sh`) and PowerShell. A multi-line message quoted for the wrong one does
not fail; it commits, with the quoting characters embedded in the message. A
PowerShell here-string (`@'…'@`) run through Bash has produced a commit whose
subject line was a bare `@`, with a second `@` after the trailer.

**Pipe the message in on stdin, using the form that matches the shell you are
actually calling** — never `-m` with a multi-line string:

```bash
# Bash tool — quoted heredoc ('EOF'), so $ and ` stay literal
git commit -F - <<'EOF'
Subject line here.

Co-Authored-By: …
EOF
```

```powershell
# PowerShell tool — single-quoted here-string PIPED in; closing '@ at column 0
@'
Subject line here.

Co-Authored-By: …
'@ | git commit -F -
```

The pipe is not optional. `git commit -F - @'…'@` puts the here-string in
`argv`, where `git` reads it as a pathspec and fails with "did not match any
file(s) known to git" — `-F -` only ever reads stdin.

Either shell can also take `-F <file>`, which is the safest option for a long
message: write it with the Write tool, then point `git commit` at it.

**Then read it back**, with line ends made visible — `git log -1 --format=%B`
alone renders a stray `@` or a swallowed newline as ordinary-looking text:

```bash
git log -1 --format=%B | cat -A                          # Bash
```
```powershell
git log -1 --format=%B | ForEach-Object { "[$_]" }       # PowerShell (no cat -A)
```

Fix a bad message with `--amend` *while the commit is still local* — see the
rule above about commits that have left your hands.

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

# Branches
Three tiers — full rules, including the release and hotfix sequences and the
GitHub protection settings, in [docs/BRANCHING.md](../../../docs/BRANCHING.md).

- `main` and `dev` are the **only** long-lived branches, and nothing is
  committed directly to either. `main` is production: every commit on it is a
  tagged release merge or a hotfix. `dev` is the integration line.
- Everything else is short-lived, named `<type>/<short-kebab-summary>` with
  `type` one of `feature`, `fix`, `chore`, `hotfix`.
- **Branch from `dev` and merge back into `dev`** — not `main`. The one
  exception is `hotfix/*`, which branches from `main`, merges to `main`, and is
  then merged *forward into `dev`*. Skipping that last step reintroduces the
  bug at the next release.
- A release is prepared on `dev` (changelog roll-up + version bump, one commit)
  and merged into `main` with `--no-ff`, then tagged `v<version>`.

# Merges
- **Never merge a long-lived branch into a short-lived one.** Rebase onto it
  instead — `git rebase origin/dev`, never `git merge dev`.
- Merges *into* `dev` and `main` are `--no-ff`, so the merge commit records
  where the work landed.
- **When merging a PR via `gh pr merge`, always pass `-t`/`--subject`** with a
  message in the same style as [Commits](#commits) above (sentence case,
  outcome not mechanism, ending in a period) — never the default "Merge pull
  request #N from owner/branch". Example:
  `gh pr merge 12 --merge -t "Let a shopper delete a shopping list from the list screen."`
  A release-sync PR (e.g. `main` → `dev` to fast-forward after a release) is the
  one exception — its default title is already descriptive enough.

# Line endings
`.gitattributes` pins `eol=lf` project-wide — that's a deliberate override of
whatever `core.autocrlf` your machine has set (this repo assumes
`autocrlf=true` locally, which normalizes on checkout/commit anyway). Never
"fix" line endings on a file by hand or fight `.gitattributes` per-commit; if a
file is showing as fully rewritten, suspect the *attributes*, not the content.
A CRLF shell script or Dockerfile is a syntax error inside the Linux container,
not a cosmetic issue.