import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PersonalNavigation } from '../../src/client/api/personal-navigation.js';
import {
  PERSONAL_LINKS_ENDPOINT,
  reorderPersonalLinks,
} from '../../src/client/api/personal-navigation.js';
import { planCategoryReorder, planLinkReorder } from '../../src/client/personal-reorder.js';

/**
 * Interaction-level coverage for the link reorder wiring.
 *
 * The P3.3 blocking finding was that the client sent `{ ids }` while the frozen
 * server contract requires `{ categoryId, ids }`. The API unit test asserts the
 * function's request shape; these tests assert the *wiring* — that the owning
 * category id is still available and correct at the point the reorder request is
 * actually made, which is what silently broke before.
 */

const NAVIGATION: PersonalNavigation = {
  categories: [
    {
      id: 1,
      name: '⭐ 我的常用',
      sortOrder: 0,
      isDefault: true,
      links: [
        { id: 10, title: 'A', url: 'https://a.example.com', normalizedUrl: 'https://a.example.com/', iconUrl: null, sortOrder: 0 },
        { id: 11, title: 'B', url: 'https://b.example.com', normalizedUrl: 'https://b.example.com/', iconUrl: null, sortOrder: 1 },
        { id: 12, title: 'C', url: 'https://c.example.com', normalizedUrl: 'https://c.example.com/', iconUrl: null, sortOrder: 2 },
      ],
    },
    {
      id: 7,
      name: '工作',
      sortOrder: 1,
      isDefault: false,
      links: [
        { id: 20, title: 'X', url: 'https://x.example.com', normalizedUrl: 'https://x.example.com/', iconUrl: null, sortOrder: 0 },
        { id: 21, title: 'Y', url: 'https://y.example.com', normalizedUrl: 'https://y.example.com/', iconUrl: null, sortOrder: 1 },
      ],
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('planLinkReorder — owning categoryId is carried', () => {
  it('returns the owning category id for a link in a non-default category', () => {
    const plan = planLinkReorder(NAVIGATION, 21, -1);

    expect(plan).toEqual({ categoryId: 7, ids: [21, 20] });
  });

  it('returns the owning category id for a link in the default category', () => {
    const plan = planLinkReorder(NAVIGATION, 12, -1);

    expect(plan).toEqual({ categoryId: 1, ids: [10, 12, 11] });
  });

  it('never returns a plan without a categoryId', () => {
    for (const linkId of [10, 11, 12, 20, 21]) {
      const plan = planLinkReorder(NAVIGATION, linkId, 1);
      if (plan !== null) {
        expect(plan.categoryId).toBeTypeOf('number');
      }
    }
  });

  it('sends the full link set of that category, not a subset', () => {
    const plan = planLinkReorder(NAVIGATION, 11, 1);

    expect(plan?.ids).toHaveLength(3);
    expect([...plan!.ids].sort()).toEqual([10, 11, 12]);
  });

  it('returns null at the boundary instead of planning an invalid request', () => {
    expect(planLinkReorder(NAVIGATION, 10, -1)).toBeNull();
    expect(planLinkReorder(NAVIGATION, 12, 1)).toBeNull();
  });

  it('returns null for an unknown link id', () => {
    expect(planLinkReorder(NAVIGATION, 999, 1)).toBeNull();
  });
});

describe('planCategoryReorder', () => {
  it('returns the full category id set', () => {
    const plan = planCategoryReorder(NAVIGATION, 7, -1);

    expect(plan).toEqual({ ids: [7, 1] });
  });

  it('returns null at the boundary', () => {
    expect(planCategoryReorder(NAVIGATION, 1, -1)).toBeNull();
    expect(planCategoryReorder(NAVIGATION, 7, 1)).toBeNull();
  });
});

describe('reorder invocation — categoryId reaches the request', () => {
  it('forwards the planned categoryId into the API payload', async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    // Mirror the container: plan from the rendered payload, then invoke the API.
    const plan = planLinkReorder(NAVIGATION, 11, -1);
    expect(plan).not.toBeNull();
    await reorderPersonalLinks(plan!.categoryId, plan!.ids);

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PERSONAL_LINKS_ENDPOINT}/order`);
    expect(init.method).toBe('PUT');

    const body = JSON.parse(String(init.body)) as { categoryId?: unknown; ids?: unknown };
    // The regression that failed review: categoryId was absent here.
    // Link 11 is second; moving it up swaps with link 10.
    expect(body.categoryId).toBe(1);
    expect(body.ids).toEqual([11, 10, 12]);
    // The full owned set is still sent, not a subset.
    expect([...body.ids as number[]].sort()).toEqual([10, 11, 12]);
  });

  it('uses the link\'s own category when the payload has several categories', async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    const plan = planLinkReorder(NAVIGATION, 21, -1);
    await reorderPersonalLinks(plan!.categoryId, plan!.ids);

    const body = JSON.parse(
      String((fetchStub.mock.calls[0] as [string, RequestInit])[1].body),
    ) as { categoryId?: unknown; ids?: unknown };

    // Must be 7 (工作), not the default category 1.
    expect(body.categoryId).toBe(7);
    expect(body.ids).toEqual([21, 20]);
  });
});
