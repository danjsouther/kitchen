import { Component, inject } from "@angular/core";
import { RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { MatMenuModule } from "@angular/material/menu";
import { MatToolbarModule } from "@angular/material/toolbar";

import { AuthService } from "./core/auth.service";

@Component({
  selector: "app-root",
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
  ],
  template: `
    @if (auth.user(); as user) {
      <mat-toolbar class="shell-bar">
        <a routerLink="/recipes" class="brand">Recipes</a>

        <nav class="links">
          @for (link of links; track link.path) {
            <a
              [routerLink]="link.path"
              routerLinkActive="active"
              class="nav-link"
              [attr.aria-label]="link.label"
            >
              <mat-icon>{{ link.icon }}</mat-icon>
              <span class="nav-text">{{ link.label }}</span>
            </a>
          }
        </nav>

        <span class="grow"></span>

        <button mat-icon-button [matMenuTriggerFor]="menu" aria-label="Account">
          <mat-icon>account_circle</mat-icon>
        </button>
        <mat-menu #menu="matMenu">
          <div class="menu-head">
            <strong>{{ user.displayName }}</strong>
            <div class="muted">{{ user.email }}</div>
          </div>
          <a mat-menu-item routerLink="/settings">
            <mat-icon>settings</mat-icon>
            <span>Settings</span>
          </a>
          <button mat-menu-item (click)="auth.logout()">
            <mat-icon>logout</mat-icon>
            <span>Sign out</span>
          </button>
        </mat-menu>
      </mat-toolbar>
    }

    <router-outlet />
  `,
  styles: `
    .shell-bar {
      position: sticky;
      top: 0;
      z-index: 10;
      gap: 0.5rem;
      background: var(--mat-sys-surface-container);
    }

    .brand {
      font-weight: 600;
      text-decoration: none;
      color: inherit;
      margin-right: 0.5rem;
      white-space: nowrap;
    }

    .links {
      display: flex;
      gap: 0.15rem;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .links::-webkit-scrollbar {
      display: none;
    }

    .nav-link {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.45rem 0.7rem;
      border-radius: 999px;
      text-decoration: none;
      color: inherit;
      white-space: nowrap;
      font-size: 0.9rem;
    }

    .nav-link.active {
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }

    .grow {
      flex: 1 1 auto;
    }

    .menu-head {
      padding: 0.5rem 1rem;
      line-height: 1.35;
    }

    /* On a phone the labels go and the icons carry the navigation. */
    @media (max-width: 720px) {
      .nav-text {
        display: none;
      }
      .brand {
        display: none;
      }
    }
  `,
})
export class AppComponent {
  readonly auth = inject(AuthService);

  readonly links = [
    { path: "/recipes", label: "Recipes", icon: "menu_book" },
    { path: "/pantry", label: "Pantry", icon: "kitchen" },
    { path: "/plan", label: "Plan", icon: "calendar_month" },
    { path: "/cook", label: "Cook", icon: "restaurant" },
    { path: "/shopping", label: "Shopping", icon: "shopping_cart" },
  ];
}
