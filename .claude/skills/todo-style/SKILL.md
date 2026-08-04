---
name: todo-style
description: Formatting and content rules for this repo's docs/TODO.md roadmap file. Trigger whenever adding, editing, checking off, or reorganizing an entry in docs/TODO.md, or when asked to "add a todo" / "add to the roadmap".
metadata:
  version: '1.0'
---

# docs/TODO.md style

`docs/TODO.md` is a backlog of larger initiatives, not a scratch list. Every
entry must follow this shape.

## File header

Keep the file's opening paragraphs intact when editing — they set the
contract for every entry below them:

```markdown
# TODO / Roadmap

Backlog of larger initiatives not yet scheduled. Each is a multi-step effort —
plan it out (explore the relevant code, ask clarifying questions, write an
implementation plan) before starting work on it.

Grouped by priority. High = do next; Medium = queued behind it; Low = deferred,
not now. Priority reflects when it gets picked up, not size or importance —
read an entry's own notes for prerequisites rather than inferring them from the
tier.
```

## Entry shape

```markdown
- [ ] **One-line imperative title, bolded**
  ```
  Detail block in a fenced code block, not prose in the list item itself.
  States current behavior with a specific file/function/line reference,
  names the gap concretely, then says what's wanted. Ends with open
  decisions the implementer still has to make, not a prescribed answer.
  ```
```

A completed item is checked off and kept, never deleted — its block gets a
`Done:` paragraph appended describing what shipped and what was deliberately
left out and why:

```markdown
- [x] **A completed item stays, checked off**
  ```
  Original ask goes here, unedited.

  Done: what actually shipped, in enough detail that a reader doesn't need
  to dig through git log. Call out anything deliberately NOT done and why.
  ```
```

## Rules

1. **Cite real code.** A file path, function name, or schema field the author
   actually checked — never a vague area. Before writing an entry, grep/read
   the relevant code first. If a claim can't be tied to something in the repo,
   it doesn't go in.
2. **State current behavior before the ask.** "X does Y today, which means Z
   is impossible" — written so a future reader can re-verify the premise still
   holds before starting work.
3. **End with open decisions, not a spec.** Name what's unresolved (schema
   shape, which of two flows changes, which system owns the job) instead of
   picking for the future implementer.
4. **Priority tier is about scheduling order, not size or importance.** Don't
   let a Low entry's size imply it's unimportant, or a High entry's brevity
   imply it's small.
5. **Flag adjacent things that are already solved**, so nobody re-proposes
   them. If research turns up an endpoint/feature that already covers part of
   the ask, say so explicitly and scope the entry down to the real gap.
6. **Never delete a checked-off entry.** It's a lightweight decision log, not
   just a task list — history has value.

## When adding a new entry

1. Research the relevant code first (grep for the models/services/components
   involved) — don't write the detail block from memory or assumption.
2. Figure out which existing tier (High/Medium/Low) it belongs in, or ask the
   user if it's unclear.
3. Write the detail block per the shape above, then re-read it against rules
   1–5.
