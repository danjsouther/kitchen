# Working on this repo

Read this before changing code. Everything here is something that has already
gone wrong once, or that is invisible until it bites.

## Read the Angular skill before touching the frontend

There is an Angular skill installed at `~/.claude/skills/angular-developer/` —
a `SKILL.md` plus a `references/` directory covering signals, `linkedSignal`,
`effect`, components, inputs/outputs, routing, forms, DI, styling and
migrations.

**It is not invocable in every host.** The VSCode extension does not load
user-level skills, so it will not appear in your skill list and `Skill(...)`
returns "Unknown skill". Read the files directly instead — they are plain
markdown and always readable.

Consult it before writing components, wiring signals, or running an Angular
upgrade. This is not box-ticking: skipping it produced a real bug in this repo.
A form seeded its fields from an input once in the constructor, so clicking one
pantry lot then another showed the second lot's name above the first lot's
numbers, and saving wrote the wrong quantity onto the wrong lot. `linkedSignal`
— documented in `references/linked-signal.md` for exactly this case — is the
fix.

Treat the skill as a strong default, not gospel: it states that `submit()`
marks every field as touched, and in Angular 22.1 it does not. Check behaviour
in a browser before relying on a claim from it.

## Forms are Signal Forms. Always.

`@angular/forms/signals`, everywhere. There is no `FormsModule`, no `ngModel`,
and no reactive forms in this app — if you find yourself importing any of them,
you are doing it wrong. `references/signal-forms.md` in the skill is the
reference; read it before adding a form.

The shape:

```ts
private readonly model = signal({ name: "", unitId: 0 });   // never null
readonly myForm = form(this.model, (path) => {
  required(path.name, { message: "..." });
  min(path.unitId, 1, { message: "Pick a unit." });         // 0 = not chosen
});
```

```html
<form [formRoot]="myForm" (submit)="onSubmit($event)">
  <input matInput [formField]="myForm.name" />
  @if (firstError(myForm.name()); as message) { <mat-error>{{ message }}</mat-error> }
</form>
```

Things that cost time here, all verified against Angular 22.1 rather than
assumed:

- **Never `null` or `undefined` in a model.** Use `""`, `0`, `[]`. Since a
  select needs a "nothing chosen" state, **`0` is the sentinel** and `min(path,
  1)` rejects it.
- **Bind `[formField]="myForm.field"` — not called.** Calling a field
  (`myForm.field()`) gives its *state*, which is what `errors()` and `touched()`
  come from. Both forms appear above; mixing them up is the usual mistake.
- **`(submit)`, not `(ngSubmit)`.** `ngSubmit` is an `NgForm` output from
  `FormsModule`, which no longer exists here. Left as `(ngSubmit)` it binds a
  custom event that never fires and the button silently does nothing.
- **`submit()` does not mark fields touched** in this version, whatever the
  skill says. Call `theForm().markAsTouched()` first or a blank submit shows no
  errors at all.
- **`[formField]` owns `name`, `min`, `max`, `disabled`, `readonly` and
  `value`.** Setting any of them alongside it is a compile error (NG8022). Use
  schema rules instead. Static `value` on radio/checkbox is the one exception.
- **A validator with nowhere to render is a silent failure.** Every rule needs a
  matching `<mat-error>`, or the form just refuses to submit with nothing on
  screen. Where the control is not a form field at all — the ingredient picker —
  render the error yourself.
- **Use `reset()`, not just clearing the value**, when reopening an editor: it
  clears touched/dirty too, so the form does not reopen already showing errors.
- **Submitting from a button rather than a `<form>`?** Then `FormRoot` has
  nothing to bind to; gate on `theForm().markAsTouched()` plus
  `theForm().invalid()` in the handler.

Angular Material is fully wired up for this: `ErrorStateTracker` accepts a
`FormField`, so `matInput`, `mat-select` and `<mat-error>` all work.

**Search boxes and filters are not forms.** A plain `signal` with
`[value]` + `(input)` is the right tool — no schema, no validation, no
ceremony. The ingredient picker is the clearest case, and keeping it out of a
form is also what stopped Material writing an option *object* back into a
string field, which crashed it twice.

## The rule the whole app rests on

A conversion that cannot be performed returns a typed failure. It never throws,
never guesses, and never quietly becomes zero.

Every consumer must handle `ok: false` explicitly. A pantry balance that could
not be summed shows **"not countable"**, not `0` — those are different claims,
and the UI must keep them different. "We could not measure this" is likewise not
"you have run out": the cook screen keeps `unknown` visually distinct from
`missing` for that reason.

When something cannot be computed, name the missing datum and link to where it
can be supplied. The pantry's "could not be combined" warning links to the
catalog search for that ingredient.

## Money and quantities

Every quantity and price is a `Decimal` server-side and crosses the wire as a
**string**. Do not route one through a JavaScript number on the way to or from
the API — that is how 0.33 cups and $3.99 rot.

Round for display only, never in stored values. Scaling a recipe twice through
rounded values drifts.

## Tenancy

Reads on catalog models see global rows (`householdId IS NULL`) plus the
household's own. **Writes are always scoped strictly to the household.** That
asymmetry is what stops one household editing the shared catalog for everyone;
`packages/backend/src/prisma/tenancy.ts` enforces it.

Editing a shared ingredient therefore forks a private copy first
(`POST /ingredients/:id/customize`) rather than patching in place.

## AI is bring-your-own-key

There is deliberately **no server-wide `ANTHROPIC_API_KEY`**. Each household
supplies its own, stored AES-256-GCM encrypted. No endpoint returns a key — only
`keyLastFour`. Do not add a fallback to a server key "for convenience"; that
would quietly move everyone's costs and data onto one credential.

## Toolchain facts that look like mistakes

- **All three packages share one TypeScript version (6.0.x)**, because Angular's
  compiler pins `>=6.0 <6.1`. Do not "fix" the backend to an older one.
- **Components carry `ChangeDetectionStrategy.Eager`.** Angular 22 defaults to
  `OnPush`; several components hold non-signal fields assigned inside an HTTP
  subscribe and then rendered, which `OnPush` and zoneless would both leave
  stale. Removing the shim breaks rendering silently rather than failing a
  build. Converting that state to signals is the prerequisite.
- **The API serves `/api/*`** (`setGlobalPrefix('api')`). `nginx.conf` must not
  strip the prefix.
- **The backend listens on 3000 in the container**, not the 3001 in `.env` —
  that local default only dodges a host port clash.
- **`.gitattributes` pins LF.** A CRLF `docker-entrypoint.sh` is a syntax error
  to the container's shell, not cosmetic.

## Verify by running it, not by building it

Every serious bug in this repo passed its unit tests and the compiler. The
ordering bug, the unit-agreement bug, the parser/API seam bug, the tenancy hole,
the seed shipping no data, and the wrong-lot save were all found by exercising
the real thing.

So: run the stack and drive it. `npm run dev:up` brings up Postgres, migrations,
the catalog seed and both servers. Check the browser console, not just the
build output. Clean up test households afterwards.

When a check contradicts another check, distrust the cleverer one — a `grep`
pattern reporting CRLF in every committed blob was wrong, and a byte count
settled it.
