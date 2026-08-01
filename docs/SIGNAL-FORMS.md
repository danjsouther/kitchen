# Signal Forms in this app

`@angular/forms/signals` everywhere. No `FormsModule`, no `ngModel`, no reactive
forms — if you are importing any of them, you are doing it wrong.

`references/signal-forms.md` in the Angular skill
(`~/.claude/skills/angular-developer/`) is the upstream reference. Everything
below is verified against Angular 22.1 in this repo, and takes precedence over
the skill where the two disagree.

## The shape

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

## Rules

- **Never `null`/`undefined` in a model.** Use `""`, `0`, `[]`. `0` is the
  "nothing chosen" sentinel for selects; `min(path, 1)` rejects it.
- **Bind `[formField]="myForm.field"`, uncalled.** Calling it gives field
  *state* — that's where `errors()` and `touched()` come from. Mixing the two up
  is the usual mistake.
- **`(submit)`, not `(ngSubmit)`.** `ngSubmit` needs `FormsModule`; left in
  place it binds an event that never fires and the button silently does nothing.
- **`submit()` does not mark fields touched.** Call `theForm().markAsTouched()`
  first or a blank submit shows no errors.
- **`[formField]` owns `name`, `min`, `max`, `disabled`, `readonly`, `value`.**
  Setting any alongside it is a compile error (NG8022) — use schema rules.
  Static `value` on radio/checkbox is the exception.
- **`[formField]` needs a real control host.** `<mat-checkbox [formField]>`
  compiles, then throws **NG01914** at render. Use a native
  `<input type="checkbox">` in a `<label>`. `matInput`/`mat-select` are fine.
- **Every validator needs a matching `<mat-error>`,** or the form refuses to
  submit with nothing on screen. Where the control isn't a form field (the
  ingredient picker), render the error yourself.
- **Use `reset()`** when reopening an editor — clearing the value alone leaves
  touched/dirty, so it reopens showing errors.
- **Submitting from a button, not a `<form>`?** `FormRoot` has nothing to bind
  to; gate on `theForm().markAsTouched()` + `theForm().invalid()` in the handler.
- **Seed a form from an input with `linkedSignal`,** never once in the
  constructor — that bug shipped the wrong lot's quantity onto the wrong lot.

Angular Material is fully wired for this: `ErrorStateTracker` accepts a
`FormField`, so `matInput`, `mat-select` and `<mat-error>` all work.

## What is not a form

**Search boxes and filters.** A plain `signal` with `[value]` + `(input)` — no
schema, no validation. Keeping the ingredient picker out of a form is also what
stopped Material writing an option *object* into a string field.

Still always set `displayWith` on a `mat-autocomplete`: selecting an option
makes Material write into the input element directly, so without one it writes
`[object Object]`.
