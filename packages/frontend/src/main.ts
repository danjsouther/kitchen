import { provideZoneChangeDetection } from "@angular/core";
import { provideHttpClient, withFetch } from "@angular/common/http";
import { bootstrapApplication } from "@angular/platform-browser";
import { provideRouter, withComponentInputBinding } from "@angular/router";

import { AppComponent } from "./app/app.component";
import { routes } from "./app/app.routes";

// Two deliberate choices, both about change detection, both revisited at the
// Angular 22 upgrade:
//
//   * No animations provider — Angular Material animates in CSS, so pulling in
//     @angular/animations would add a package whose version has to be kept in
//     lockstep with the rest of Angular for no visible gain.
//
//   * Zone-based, not zoneless. provideZoneChangeDetection() is explicit here
//     because Angular 22 defaults to zoneless. Staying on zones is a real
//     decision, not inertia: several components hold plain (non-signal) fields
//     that are assigned inside an HTTP subscribe and then rendered — the
//     receive-location select on the shopping list is the clearest case.
//     Zoneless would leave those stale on screen with nothing to point at.
//     Going zoneless means converting that state to signals first; until then
//     this line is what keeps the app correct.
bootstrapApplication(AppComponent, {
  providers: [
    provideZoneChangeDetection(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch()),
  ],
}).catch((error: unknown) => console.error(error));
