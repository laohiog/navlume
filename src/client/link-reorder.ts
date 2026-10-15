/** Final positions are 1-based, after removing the moving link. */
export type LinkMovePlan = { status: 'invalid' } | { status: 'unchanged' } | { status: 'ready'; ids: number[] };

export function planLinkMove(ids: readonly number[], targetId: number, position: number): LinkMovePlan {
  if (!Number.isSafeInteger(position) || position < 1 || position > ids.length ||
    ids.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
    return { status: 'invalid' };
  }
  const index = ids.indexOf(targetId);
  if (index < 0) return { status: 'invalid' };
  if (index === position - 1) return { status: 'unchanged' };
  const next = [...ids];
  next.splice(index, 1);
  next.splice(position - 1, 0, targetId);
  return { status: 'ready', ids: next };
}

export function parseLinkPosition(value: string, total: number): number | null {
  const position = Number(value);
  return value.trim() !== '' && Number.isSafeInteger(position) && position >= 1 && position <= total ? position : null;
}

export type LinkMoveOutcome = { status: 'ok' | 'unchanged' | 'cancelled' } | { status: 'error'; message: string };

export interface LinkMoveControls {
  activeId: number | null;
  open: (linkId: number | null) => void;
  submit: (linkId: number, position: number) => Promise<LinkMoveOutcome>;
}
