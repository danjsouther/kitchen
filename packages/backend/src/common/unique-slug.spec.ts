import { uniqueSlug } from './unique-slug';

/** A `taken` probe backed by a fixed set, recording what it was asked. */
function probe(existing: string[]) {
  const asked: string[] = [];
  const set = new Set(existing);
  return {
    asked,
    taken: (slug: string) => {
      asked.push(slug);
      return Promise.resolve(set.has(slug));
    },
  };
}

describe('uniqueSlug', () => {
  it('uses the plain slug when nothing has claimed it', async () => {
    const { taken } = probe([]);
    await expect(uniqueSlug('Weeknight Chili', taken)).resolves.toBe('weeknight-chili');
  });

  it('appends the first free numeric suffix', async () => {
    const { taken } = probe(['chili', 'chili-2']);
    await expect(uniqueSlug('Chili', taken)).resolves.toBe('chili-3');
  });

  it('stops probing as soon as it finds a free slug', async () => {
    const { asked, taken } = probe(['chili']);
    await uniqueSlug('Chili', taken);
    expect(asked).toEqual(['chili', 'chili-2']);
  });

  // A title of only punctuation or emoji slugifies to nothing, which would give
  // every such recipe the same empty slug.
  it('falls back when the title slugifies to nothing', async () => {
    const { taken } = probe([]);
    await expect(uniqueSlug('!!!', taken)).resolves.toBe('untitled');
    await expect(uniqueSlug('***', taken, 'recipe')).resolves.toBe('recipe');
  });

  it('still numbers the fallback when it collides', async () => {
    const { taken } = probe(['untitled']);
    await expect(uniqueSlug('???', taken)).resolves.toBe('untitled-2');
  });

  it('gives up scanning rather than looping forever', async () => {
    // Every candidate is taken; it must terminate with something unique-ish.
    const result = await uniqueSlug('Chili', () => Promise.resolve(true));
    expect(result).toMatch(/^chili-[a-z0-9]+$/);
    expect(result).not.toBe('chili-2');
  });
});
