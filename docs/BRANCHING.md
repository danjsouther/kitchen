# Branching

Three tiers. `main` is what is deployed, `dev` is what is finished but not yet
released, and everything else is short-lived and branched from `dev`.

```
main   ──●──────────────●  (v0.4.0)        (v0.5.0)
          \             /
dev     ●──●──●──●──●──●──●
            \  /   \  /
feature/a    ●●     ●●  feature/b
```

## The branches

| Branch | Lives | Holds | Written by |
| --- | --- | --- | --- |
| `main` | forever | production; every commit is a tagged release | release merges and hotfixes only |
| `dev` | forever | the integration line — finished work awaiting a release | feature merges |
| `<type>/<summary>` | days | one change | you |

`main` and `dev` are the only long-lived branches. Nothing is ever committed
directly to either.

### Naming

`<type>/<short-kebab-summary>`, where `type` is one of:

- `feature/` — new behaviour
- `fix/` — a bug fix that can wait for the next release
- `chore/` — tooling, docs, dependencies, refactors with no user-visible effect
- `hotfix/` — a fix for production urgent enough to bypass `dev` (see below)

e.g. `feature/pantry-lot-targeted-deduction`. Branches created before this
convention have bare names; leave them, don't rename in flight.

## Feature flow

Branch from `dev`, rebase onto `dev`, merge into `dev`.

```bash
git switch dev && git pull
git switch -c feature/thing

# ... work, committing per the rules in .claude/skills/git/SKILL.md,
#     including a CHANGELOG.md entry under ## Unreleased ...

git fetch origin
git rebase origin/dev          # never `git merge dev`
git push -u origin feature/thing
# open a PR into dev
```

The PR merges with `--no-ff` (GitHub's "Create a merge commit"), so the feature
keeps its own commits and the merge commit records where it landed. Delete the
branch after merging.

**Never merge a long-lived branch into a feature branch.** Rebase. A merge from
`dev` into a feature branch makes the eventual diff unreadable and drags
unrelated commits into the review.

## Release flow

A release is prepared *on `dev`* and merged into `main`. `main` never
accumulates loose commits.

```bash
git switch dev && git pull

# 1. Roll the CHANGELOG: move everything under ## Unreleased beneath a new
#    ## x.y.z heading, above the previous version.
# 2. Bump `version` in package.json across all three packages.
# 3. Commit both together — "Release 0.5.0."
git push

# 4. Merge into main and tag.
git switch main && git pull
git merge --no-ff dev -m "Release 0.5.0."
git tag v0.5.0
git push origin main --follow-tags
git switch dev && git merge --ff-only main   # keep dev level with main
```

The version number follows [semver](https://semver.org/spec/v2.0.0.html), same
as it did before `dev` existed — the `Release 0.4.0.` commit on `main` is the
shape to copy.

## Hotfix flow

Only for something broken in production that cannot wait for whatever is
sitting on `dev`.

```bash
git switch main && git pull
git switch -c hotfix/thing
# ... fix, changelog entry, patch version bump ...
# PR into main, merge --no-ff, tag v0.5.1

git switch dev && git merge main    # or rebase dev onto main if dev is unpushed
```

**The last step is the one that gets forgotten.** A hotfix that lands on `main`
and not on `dev` is reintroduced as a regression by the next release.

## Protecting the branches on GitHub

Neither rule can be enforced from the repo — set both in
**Settings → Rules → Rulesets** (or Settings → Branches → Add branch
protection rule) on `github.com/danjsouther/kitchen`.

For **`main`** and **`dev`** alike:

- **Require a pull request before merging** — with "Allow specified actors to
  bypass" left empty even for yourself, so a stray `git push` cannot land on
  either branch. Approvals can be 0 on a solo repo; the point is that the push
  goes through a PR and therefore through CI.
- **Require status checks to pass** → select **`build-and-test`**, the job in
  [.github/workflows/ci.yml](../.github/workflows/ci.yml). The check only
  appears in that list after it has run once, so open a throwaway PR first if
  the box is empty.
- **Require branches to be up to date before merging** — on `main` only.
  Enabling it on `dev` means every open feature PR needs a rebase whenever
  anything else merges.
- **Block force pushes** and **restrict deletions**.

`main` additionally: nothing merges into it except `dev` or a `hotfix/*` branch.
That one is a convention, not a setting — GitHub cannot restrict a PR by source
branch.

## Why not just `main` and feature branches

That was the setup until now, and it works right up to the point where
something needs to ship while something else is half-finished. With `dev` in
between, `main` answers "what is running in production" and the tag history
answers "since when" without reading commit messages to find the release
boundaries.
