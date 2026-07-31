import { provideZonelessChangeDetection } from "@angular/core";
import { provideHttpClient, withFetch } from "@angular/common/http";
import { bootstrapApplication } from "@angular/platform-browser";
import { provideRouter, withComponentInputBinding } from "@angular/router";

import { AppComponent } from "./app/app.component";
import { routes } from "./app/app.routes";

// Two deliberate choices, both about change detection:
//
//   * No animations provider — Angular Material animates in CSS, so pulling in
//     @angular/animations would add a package whose version has to be kept in
//     lockstep with the rest of Angular for no visible gain.
//
//   * Zoneless via provideZonelessChangeDetection(). Angular 22 defaults to
//     OnPush and zoneless; components rely on signal writes (and Signal Forms)
//     to mark views dirty. Do not reintroduce plain fields mutated inside an
//     HTTP subscribe and then read in the template — those stay stale with
//     nothing to point at.
bootstrapApplication(AppComponent, {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch()),
  ],
}).catch((error: unknown) => console.error(error));
