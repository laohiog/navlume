/**
 * Pure reorder planning for personal navigation.
 *
 * Kept separate from the container so the request payloads can be verified
 * without a DOM: the reorder endpoints are the one place where the client must
 * agree with a frozen server contract, and a missing field there fails only at
 * runtime against the real server. Planning is therefore a pure function of the
 * rendered server payload.
 *
 * Both planners return `null` when the move is impossible (unknown target, or
 * already at the boundary). Callers treat `null` as "nothing to do" rather than
 * sending a request the server would reject.
 */

import type { PersonalNavigation } from './api/personal-navigation.js';

/** Payload for `PUT /api/personal/categories/order`. */
export interface CategoryReorderPlan {
  ids: number[];
}

/**
 * Payload for `PUT /api/personal/links/order`.
 *
 * `categoryId` is required by the server, which validates that `ids` is exactly
 * the link set of that category. It is carried alongside the ids here so the
 * owning category can never be dropped from the request.
 */
export interface LinkReorderPlan {
  categoryId: number;
  ids: number[];
}

/** Swap `targetId` with its neighbour in `ids`, or return null if not possible. */
function swap(ids: number[], targetId: number, direction: -1 | 1): number[] | null {
  const index = ids.indexOf(targetId);
  const swapWith = index + direction;

  if (index < 0 || swapWith < 0 || swapWith >= ids.length) {
    return null;
  }

  const next = [...ids];
  [next[index], next[swapWith]] = [next[swapWith] as number, next[index] as number];
  return next;
}

/** Plan a category move over the full owned category set. */
export function planCategoryReorder(
  current: PersonalNavigation,
  categoryId: number,
  direction: -1 | 1,
): CategoryReorderPlan | null {
  const ids = swap(
    current.categories.map((category) => category.id),
    categoryId,
    direction,
  );

  return ids === null ? null : { ids };
}

/**
 * Plan a link move within its owning category.
 *
 * The owning category is looked up from the rendered payload — the same
 * membership the UI displays — so the id sent to the server always matches the
 * category whose links were reordered. Returns null when the link is not found
 * or the move is out of range.
 */
export function planLinkReorder(
  current: PersonalNavigation,
  linkId: number,
  direction: -1 | 1,
): LinkReorderPlan | null {
  const owner = current.categories.find((category) =>
    category.links.some((link) => link.id === linkId),
  );

  if (owner === undefined) {
    return null;
  }

  const ids = swap(
    owner.links.map((link) => link.id),
    linkId,
    direction,
  );

  return ids === null ? null : { categoryId: owner.id, ids };
}
