export interface HomeCategoryTarget {
  heading: HTMLElement;
  scope: 'personal' | 'public';
  name: string;
}

/** Read the committed view, including its search and active-form exceptions. */
export function readHomeCategories(content: HTMLElement): HomeCategoryTarget[] {
  return Array.from(content.querySelectorAll<HTMLElement>('[data-home-category]')).flatMap((heading) => {
    const scope = heading.dataset.homeCategory;
    return scope === 'personal' || scope === 'public'
      ? [{ heading, scope, name: heading.textContent?.trim() ?? '' }]
      : [];
  });
}

/** Focus a non-editable destination, never the search input or a removed node. */
export function focusHomeDestination(content: HTMLElement, heading?: HTMLElement) {
  const target = heading && content.contains(heading) ? heading : content;
  target.focus({ preventScroll: true });
  return target;
}

export function returnHomeToTop(content: HTMLElement) {
  focusHomeDestination(content);
  window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}

export function restoreHomePickerFocus(content: HTMLElement, trigger: HTMLElement | null, heading: HTMLElement | null) {
  if (heading) {
    focusHomeDestination(content, heading).scrollIntoView({ block: 'start' });
  } else if (trigger && trigger.getClientRects().length > 0) {
    trigger.focus({ preventScroll: true });
  } else {
    focusHomeDestination(content);
  }
}

/** Keep Tab within this small dialog, including browsers that tab to chrome. */
export function wrapHomePickerFocus(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>,
  dialog: HTMLDialogElement,
) {
  if (event.key !== 'Tab') return;
  const buttons = dialog.querySelectorAll<HTMLButtonElement>('button');
  const first = buttons[0];
  const last = buttons[buttons.length - 1];
  const active = dialog.ownerDocument.activeElement;
  if (first && last && ((event.shiftKey && active === first) || (!event.shiftKey && active === last))) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
