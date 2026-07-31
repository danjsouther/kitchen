import type { Routes } from '@angular/router';

import { adminGuard, authGuard, guestGuard } from './core/auth.guard';

/**
 * Every screen is lazily loaded. The paste-and-parse review and the week planner
 * are both heavy and rarely the first thing opened, so making them part of the
 * initial bundle would slow down the screen people actually land on.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'recipes' },

  {
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () => import('./core/login.component').then((m) => m.LoginComponent),
  },

  {
    path: 'recipes',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./recipes/recipe-list.component').then((m) => m.RecipeListComponent),
  },
  {
    path: 'recipes/import',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./recipes/recipe-import.component').then((m) => m.RecipeImportComponent),
  },
  {
    // Ahead of 'recipes/:id', which would otherwise match "new" and try to load
    // a recipe by that id.
    path: 'recipes/new',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./recipes/recipe-form.component').then((m) => m.RecipeFormComponent),
  },
  {
    path: 'recipes/:id',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./recipes/recipe-detail.component').then((m) => m.RecipeDetailComponent),
  },

  {
    path: 'pantry',
    canActivate: [authGuard],
    loadComponent: () => import('./pantry/pantry.component').then((m) => m.PantryComponent),
  },
  {
    // Ahead of any future 'pantry/:id', which would otherwise swallow this and
    // try to load an ingredient list as a lot.
    path: 'pantry/ingredients',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pantry/ingredients.component').then((m) => m.IngredientsComponent),
  },
  {
    path: 'plan',
    canActivate: [authGuard],
    loadComponent: () => import('./plan/plan.component').then((m) => m.PlanComponent),
  },
  {
    path: 'cook',
    canActivate: [authGuard],
    loadComponent: () => import('./cook/cook.component').then((m) => m.CookComponent),
  },
  {
    path: 'shopping',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./shopping/shopping.component').then((m) => m.ShoppingComponent),
  },
  {
    path: 'shopping/:id',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./shopping/shopping-list.component').then((m) => m.ShoppingListComponent),
  },

  {
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./settings/settings.component').then((m) => m.SettingsComponent),
  },
  {
    path: 'settings/ai',
    canActivate: [adminGuard],
    loadComponent: () =>
      import('./settings/ai-settings.component').then((m) => m.AiSettingsComponent),
  },

  { path: '**', redirectTo: 'recipes' },
];
