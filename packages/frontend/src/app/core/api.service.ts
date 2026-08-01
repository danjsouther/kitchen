import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';

import type * as M from './models';

/**
 * The single place the API is described.
 *
 * Every call goes through here rather than components reaching for HttpClient
 * directly, so a route change is one edit and the response shapes stay in
 * `models.ts` where both sides can see them.
 *
 * `withCredentials` is on for every request: the session lives in an httpOnly
 * cookie that page JavaScript deliberately cannot read.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api';

  private get<T>(path: string, params?: Record<string, string | number | undefined>): Observable<T> {
    let httpParams = new HttpParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== '') httpParams = httpParams.set(key, String(value));
    }
    return this.http.get<T>(`${this.base}${path}`, {
      params: httpParams,
      withCredentials: true,
    });
  }

  private post<T>(path: string, body?: unknown): Observable<T> {
    return this.http.post<T>(`${this.base}${path}`, body ?? {}, { withCredentials: true });
  }

  private patch<T>(path: string, body: unknown): Observable<T> {
    return this.http.patch<T>(`${this.base}${path}`, body, { withCredentials: true });
  }

  private put<T>(path: string, body: unknown): Observable<T> {
    return this.http.put<T>(`${this.base}${path}`, body, { withCredentials: true });
  }

  private delete<T>(path: string, body?: unknown): Observable<T> {
    return this.http.delete<T>(`${this.base}${path}`, { withCredentials: true, body });
  }

  // -- Auth ----------------------------------------------------------------

  register(body: {
    email: string;
    password: string;
    displayName: string;
    householdName: string;
  }) {
    return this.post<M.AuthUser>('/auth/register', body);
  }

  login(body: { email: string; password: string }) {
    return this.post<M.AuthUser>('/auth/login', body);
  }

  logout() {
    return this.post<void>('/auth/logout');
  }

  me() {
    return this.get<M.AuthUser>('/auth/me');
  }

  // -- Catalog -------------------------------------------------------------

  units() {
    return this.get<M.Unit[]>('/units');
  }

  categories() {
    return this.get<M.IngredientCategory[]>('/ingredient-categories');
  }

  searchIngredients(q: string, limit = 20, categoryId?: number) {
    return this.get<M.Ingredient[]>('/ingredients', { q, limit, categoryId });
  }

  ingredient(id: number) {
    return this.get<M.Ingredient>(`/ingredients/${id}`);
  }

  createIngredient(body: M.IngredientWrite & { name: string }) {
    return this.post<M.Ingredient>('/ingredients', body);
  }

  customizeIngredient(id: number) {
    return this.post<M.Ingredient>(`/ingredients/${id}/customize`);
  }

  updateIngredient(id: number, body: M.IngredientWrite) {
    return this.patch<M.Ingredient>(`/ingredients/${id}`, body);
  }

  // -- Products ------------------------------------------------------------
  //
  // The Open Food Facts mirror is global and import-owned. Writes here are only
  // household category overrides. The default category is live ranked consensus.

  /** Product, override, consensus, and effective category for a barcode. */
  lookupBarcode(code: string) {
    return this.get<M.BarcodeLookup>(`/products/by-barcode/${encodeURIComponent(code)}`);
  }

  searchProducts(q: string, limit = 20) {
    return this.get<M.Product[]>('/products', { q, limit });
  }

  productBindings() {
    return this.get<M.ProductBindingRow[]>('/products/bindings');
  }

  /** Pins this household's category override for a barcode. */
  bindProduct(barcode: string, ingredientId: number) {
    return this.put<M.BarcodeLookup>(
      `/products/${encodeURIComponent(barcode)}/binding`,
      { ingredientId },
    );
  }

  /** Clears the override so this household follows consensus again. */
  unbindProduct(barcode: string) {
    return this.delete<M.BarcodeLookup>(`/products/${encodeURIComponent(barcode)}/binding`);
  }

  // -- Recipes -------------------------------------------------------------

  recipes(query: { q?: string; tag?: string; status?: string; limit?: number } = {}) {
    return this.get<M.Paged<M.RecipeSummary>>('/recipes', query);
  }

  recipe(id: number) {
    return this.get<M.Recipe>(`/recipes/${id}`);
  }

  recipeScaled(id: number, servings: number) {
    return this.get<M.Recipe>(`/recipes/${id}/scaled`, { servings });
  }

  createRecipe(body: unknown) {
    return this.post<M.Recipe>('/recipes', body);
  }

  updateRecipe(id: number, body: unknown) {
    return this.patch<M.Recipe>(`/recipes/${id}`, body);
  }

  archiveRecipe(id: number) {
    return this.delete<M.Recipe>(`/recipes/${id}`);
  }

  restoreRecipe(id: number) {
    return this.post<M.Recipe>(`/recipes/${id}/restore`);
  }

  parseRecipe(text: string) {
    return this.post<M.ParseResult>('/recipes/parse', { text });
  }

  // -- Pantry --------------------------------------------------------------

  pantry(query: { locationId?: number; expiringWithinDays?: number } = {}) {
    return this.get<M.PantryLot[]>('/pantry', query);
  }

  balances() {
    return this.get<M.Balance[]>('/pantry/balances');
  }

  addPantryItem(body: M.PantryItemWrite & { ingredientId: number }) {
    return this.post<M.PantryLot>('/pantry', body);
  }

  updatePantryItem(id: number, body: M.PantryItemWrite & { reason?: string }) {
    return this.patch<M.PantryLot>(`/pantry/${id}`, body);
  }

  pantryItem(id: number) {
    return this.get<M.PantryLot>(`/pantry/${id}`);
  }

  discardPantryItem(id: number, reason?: string) {
    return this.delete<{ id: number; discarded: string }>(`/pantry/${id}`, { reason });
  }

  /** Barcodes queued from a multi-item scan session, not yet turned into lots. */
  scanQueue() {
    return this.get<M.ScanQueueEntry[]>('/pantry/scan-queue');
  }

  addToScanQueue(barcode: string) {
    return this.post<M.ScanQueueEntry>('/pantry/scan-queue', { barcode });
  }

  removeFromScanQueue(id: number) {
    return this.delete<void>(`/pantry/scan-queue/${id}`);
  }

  clearScanQueue() {
    return this.delete<void>('/pantry/scan-queue');
  }

  locations() {
    return this.get<M.StorageLocation[]>('/storage-locations');
  }

  createLocation(name: string) {
    return this.post<M.StorageLocation>('/storage-locations', { name });
  }

  // -- Planner -------------------------------------------------------------

  planner(from: string, to: string) {
    return this.get<M.PlannedMeal[]>('/planner', { from, to });
  }

  addPlannedMeal(body: M.PlannedMealWrite) {
    return this.post<M.PlannedMeal>('/planner', body);
  }

  updatePlannedMeal(id: number, body: unknown) {
    return this.patch<M.PlannedMeal>(`/planner/${id}`, body);
  }

  removePlannedMeal(id: number) {
    return this.delete<{ id: number }>(`/planner/${id}`);
  }

  cookMeal(id: number, body: { servings?: number } = {}) {
    return this.post<M.CookReport>(`/planner/${id}/cook`, body);
  }

  undoCook(cookSessionId: number) {
    return this.delete<{ cookSessionId: number }>(`/cook-sessions/${cookSessionId}`);
  }

  // -- Suggestions ---------------------------------------------------------

  pantrySuggestions(query: { missingMax?: number; servings?: number } = {}) {
    return this.get<M.PantrySuggestions>('/suggestions/pantry', query);
  }

  aiSuggestions(body: { servings?: number } = {}) {
    return this.post<M.AiSuggestionResult>('/suggestions/ai', body);
  }

  aiConfig() {
    return this.get<M.AiConfig>('/households/me/ai-config');
  }

  saveAiConfig(body: { apiKey?: string; model?: string; effort?: string; enabled?: boolean }) {
    return this.put<M.AiConfig>('/households/me/ai-config', body);
  }

  clearAiConfig() {
    return this.delete<M.AiConfig>('/households/me/ai-config');
  }

  // -- Shopping ------------------------------------------------------------

  stores() {
    return this.get<M.Store[]>('/stores');
  }

  createStore(name: string) {
    return this.post<M.Store>('/stores', { name });
  }

  store(id: number) {
    return this.get<M.Store>(`/stores/${id}`);
  }

  updateStore(id: number, body: { name?: string; note?: string; sortOrder?: number }) {
    return this.patch<M.Store>(`/stores/${id}`, body);
  }

  /**
   * Replaces a store's aisle order wholesale, which is how the API models it:
   * the walk is one ordered thing, not a set of rows to nudge individually.
   */
  setStoreAisles(id: number, aisles: Array<{ categoryId: number; sortOrder: number }>) {
    return this.put<M.Store>(`/stores/${id}/aisles`, { aisles });
  }

  shoppingLists() {
    return this.get<M.ShoppingListSummary[]>('/shopping-lists');
  }

  shoppingList(id: number) {
    return this.get<M.ShoppingList>(`/shopping-lists/${id}`);
  }

  generateList(body: { from: string; to: string; storeId?: number }) {
    return this.post<M.Proposal>('/shopping-lists/generate', body);
  }

  createList(body: { from: string; to: string; storeId?: number; name?: string }) {
    return this.post<M.ShoppingList>('/shopping-lists', body);
  }

  addListItem(listId: number, body: unknown) {
    return this.post<M.ShoppingList>(`/shopping-lists/${listId}/items`, body);
  }

  updateListItem(listId: number, itemId: number, body: unknown) {
    return this.patch<M.ShoppingList>(`/shopping-lists/${listId}/items/${itemId}`, body);
  }

  receiveList(
    listId: number,
    body: {
      locationId: number;
      items?: Array<{ itemId: number; locationId: number }>;
    },
  ) {
    return this.post<{
      listId: number;
      receiveSessionId: number;
      stocked: unknown[];
      priced: number[];
      skipped: Array<{ itemId: number; reason: string }>;
    }>(`/shopping-lists/${listId}/receive`, body);
  }

  unreceiveList(listId: number) {
    return this.delete<{
      listId: number;
      receiveSessionId: number | null;
      restored: Array<{ lotId: number; by: string }>;
      lostLots: Array<{ lotId: number; wouldRestore: string }>;
      list: M.ShoppingList;
    }>(`/shopping-lists/${listId}/receive`);
  }
}
