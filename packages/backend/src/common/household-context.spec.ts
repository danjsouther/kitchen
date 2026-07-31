import { Role } from '@recipes/shared-types';

import {
  getHouseholdContext,
  isUnscoped,
  requireHouseholdId,
  runUnscoped,
  runWithEmptyContext,
  runWithHousehold,
  setHouseholdContext,
} from './household-context';

const alice = { householdId: 1, userId: 10, role: Role.ADMIN };
const bob = { householdId: 2, userId: 20, role: Role.MEMBER };

describe('runWithHousehold', () => {
  it('exposes the context inside the callback', () => {
    runWithHousehold(alice, () => {
      expect(getHouseholdContext()).toEqual(alice);
      expect(requireHouseholdId()).toBe(1);
    });
  });

  it('does not leak the context outside the callback', () => {
    runWithHousehold(alice, () => undefined);
    expect(getHouseholdContext()).toBeNull();
  });

  it('keeps nested contexts separate', () => {
    runWithHousehold(alice, () => {
      runWithHousehold(bob, () => {
        expect(requireHouseholdId()).toBe(2);
      });
      expect(requireHouseholdId()).toBe(1);
    });
  });

  it('survives awaits inside an async callback', async () => {
    await runWithHousehold(alice, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(requireHouseholdId()).toBe(1);
    });
  });

  // The trap this guards against: Prisma's query builders return a LAZY
  // thenable that does not execute until something calls .then() on it. If the
  // scope closed before that happened, the query would run with no household
  // context at all. runInScope resolves the thenable inside the scope to force
  // it to start there.
  it('starts a lazy thenable inside the scope', async () => {
    let observedInsideLazyWork: number | null = null;

    const lazy = {
      then(onFulfilled: (value: string) => unknown) {
        // Stands in for a PrismaPromise: the real work happens here, on .then(),
        // not when the object was created.
        observedInsideLazyWork = getHouseholdContext()?.householdId ?? null;
        return Promise.resolve('done').then(onFulfilled);
      },
    };

    const result = runWithHousehold(alice, () => lazy);
    await result;

    expect(observedInsideLazyWork).toBe(1);
  });

  it('returns the callback value unchanged for non-thenables', () => {
    expect(runWithHousehold(alice, () => 42)).toBe(42);
    expect(runWithHousehold(alice, () => 'text')).toBe('text');
  });
});

describe('runUnscoped', () => {
  it('reports itself as unscoped with no context', () => {
    runUnscoped(() => {
      expect(isUnscoped()).toBe(true);
      expect(getHouseholdContext()).toBeNull();
    });
  });

  it('also starts lazy thenables inside the scope', async () => {
    let sawUnscoped = false;
    const lazy = {
      then(onFulfilled: (value: string) => unknown) {
        sawUnscoped = isUnscoped();
        return Promise.resolve('done').then(onFulfilled);
      },
    };

    await runUnscoped(() => lazy);
    expect(sawUnscoped).toBe(true);
  });

  it('does not leak the exemption outside', () => {
    runUnscoped(() => undefined);
    expect(isUnscoped()).toBe(false);
  });
});

describe('requireHouseholdId', () => {
  // Failing closed is the point: a query with no context would otherwise touch
  // every household's rows.
  it('throws outside any scope', () => {
    expect(() => requireHouseholdId()).toThrow(/No household context/);
  });

  it('throws inside runUnscoped, which has no household', () => {
    runUnscoped(() => {
      expect(() => requireHouseholdId()).toThrow(/No household context/);
    });
  });
});

describe('runWithEmptyContext / setHouseholdContext', () => {
  it('starts empty and is filled in later, as the request path does', () => {
    runWithEmptyContext(() => {
      expect(getHouseholdContext()).toBeNull();

      setHouseholdContext(alice);

      expect(getHouseholdContext()).toEqual(alice);
      expect(requireHouseholdId()).toBe(1);
    });
  });

  it('propagates the late-set context into async work', async () => {
    await runWithEmptyContext(async () => {
      setHouseholdContext(bob);
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(requireHouseholdId()).toBe(2);
    });
  });

  it('throws if called with no scope open', () => {
    expect(() => setHouseholdContext(alice)).toThrow(
      /HouseholdContextMiddleware registered/,
    );
  });
});
