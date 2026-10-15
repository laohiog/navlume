import { describe, expect, it } from 'vitest';
import { parseLinkPosition, planLinkMove } from '../../src/client/link-reorder.js';

describe('final-position planning from the complete category', () => {
  for (const size of [1, 2, 10, 50, 100]) {
    const ids = Array.from({ length: size }, (_, i) => i + 101);
    const middle = Math.ceil(size / 2);
    for (const [from, to] of [[1, size], [size, 1], [middle, 1], [middle, size], [middle, Math.max(1, middle - 1)], [middle, middle]]) {
      it(`${size}: ${from} → final ${to}`, () => {
        const source = Object.freeze([...ids]);
        const result = planLinkMove(source, ids[from - 1]!, to);
        expect(source).toEqual(ids);
        if (from === to) { expect(result.status).toBe('unchanged'); return; }
        expect(result.status).toBe('ready');
        if (result.status !== 'ready') return;
        expect(result.ids[to - 1]).toBe(ids[from - 1]);
        expect([...result.ids].sort()).toEqual([...ids].sort());
        expect(result.ids.filter((id) => id !== ids[from - 1])).toEqual(ids.filter((id) => id !== ids[from - 1]));
      });
    }
  }
  it.each([0, -1, 4, 1.5, NaN, Infinity])('rejects invalid final position %s', (position) => {
    expect(planLinkMove([1, 2, 3], 2, position).status).toBe('invalid');
  });
  it.each([[], [1, 1], [1, -2], [1, NaN], [1, 2.1]].map((ids) => ({ ids })))('rejects inconsistent complete IDs %j', ({ ids }) => {
    expect(planLinkMove(ids, 1, 1).status).toBe('invalid');
  });
  it('rejects missing targets', () => expect(planLinkMove([1, 2], 3, 1).status).toBe('invalid'));
  it.each(['', ' ', 'abc', '0', '-1', '11', '1.5'])('rejects invalid text %j', (text) => {
    expect(parseLinkPosition(text, 10)).toBeNull();
  });
  it('accepts only integer positions within the full category', () => {
    expect(parseLinkPosition('10', 10)).toBe(10);
    expect(parseLinkPosition(' 3 ', 10)).toBe(3);
  });
});
