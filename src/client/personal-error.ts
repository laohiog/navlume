/**
 * User-facing text for personal mutation failures.
 *
 * Kept in its own module so the view file exports only components (satisfying
 * the react-refresh rule) and so the container and tests can share one mapping.
 *
 * None of these strings may contain SQL, stack traces, database paths, ids, or
 * raw exception text.
 */

import type { PersonalMutationOutcome } from './api/personal-navigation.js';

/**
 * Map a mutation outcome onto display text.
 *
 * A 400 is reported as a URL problem for link forms because the form already
 * blocks empty title/url client-side, leaving URL format as the remaining cause.
 * The server remains the actual validation authority; this only chooses wording.
 *
 * A 409 on a link form means the target category already contains that URL, so it
 * gets a specific, actionable message. Category forms keep the generic conflict
 * wording (for example the protected default category), so this distinction does
 * not change every 409.
 */
export function mutationErrorMessage(
  outcome: PersonalMutationOutcome,
  isLink: boolean,
): string {
  if (outcome.status === 'invalid') {
    return isLink ? '请输入有效的 HTTP/HTTPS 网址。' : '保存失败，请检查输入。';
  }

  if (outcome.status === 'conflict' && isLink) {
    return '该网址已存在于此分类中。';
  }

  return '操作失败，请稍后重试。';
}
