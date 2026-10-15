import { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState) };
});

import { HomeNavigation } from '../../src/client/HomeNavigation.js';
import { focusHomeDestination, readHomeCategories, restoreHomePickerFocus, returnHomeToTop, wrapHomePickerFocus } from '../../src/client/home-navigation.js';

afterEach(() => {
  vi.mocked(useState).mockReset();
  vi.unstubAllGlobals();
});

function node(id: string, scope = 'public', text = '工作资料') {
  return { id, dataset: { homeCategory: scope }, textContent: text,
    focus: vi.fn(), scrollIntoView: vi.fn(), getClientRects: () => [1] } as unknown as HTMLElement;
}

function content(headings: HTMLElement[]) {
  return { querySelectorAll: () => headings, contains: (node: HTMLElement) => headings.includes(node),
    focus: vi.fn(), scrollIntoView: vi.fn() } as unknown as HTMLElement;
}

function render(headings: HTMLElement[], pastCategories = true, pastScreen = true, editing = false) {
  const targets = readHomeCategories(content(headings));
  [targets, pastCategories, pastScreen, editing, false].forEach((value) => {
    vi.mocked(useState).mockImplementationOnce(() => [value, vi.fn()]);
  });
  return renderToStaticMarkup(<HomeNavigation contentRef={{ current: null }} />);
}

describe('Home navigation: committed category projection and component semantics', () => {
  it('preserves scope, ID, full name and rendered order for duplicate names', () => {
    const headings = [node('personal-category-1', 'personal'), node('category-1')];
    expect(readHomeCategories(content(headings))).toEqual([
      { heading: headings[0], scope: 'personal', name: '工作资料' },
      { heading: headings[1], scope: 'public', name: '工作资料' },
    ]);
    const html = render(headings);
    expect(html).toContain('我的分类');
    expect(html).toContain('公共分类');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="home-category-picker-title"');
    expect(html).toContain('>关闭</button>');
  });

  it('guest projection includes only public headings; never fabricates personal targets', () => {
    const html = render([node('category-1'), node('category-2', 'public', '完整的长中文分类名称与参考资料')]);
    expect(html).not.toContain('我的分类');
    expect(html).toContain('完整的长中文分类名称与参考资料');
  });

  it.each([0, 1])('hides category helper for %i rendered targets, independently of top', (count) => {
    const html = render(Array.from({ length: count }, (_, i) => node(`category-${i}`)));
    expect(html).toMatch(/<button[^>]*hidden=""[^>]*>分类<\/button>/);
    expect(html).toMatch(/<button type="button">顶部<\/button>/);
  });

  it('hides both helpers at top/short page and during editing', () => {
    const headings = [node('category-1'), node('category-2')];
    expect(render(headings, false, false)).toContain('aria-label="页面导航" hidden=""');
    expect(render(headings, true, true, true)).toContain('aria-label="页面导航" hidden=""');
  });

  it('reflects a new search projection without retaining filtered-out headings', () => {
    const first = node('category-1');
    const second = node('category-2', 'public', '学习资料');
    expect(readHomeCategories(content([first, second]))).toHaveLength(2);
    expect(readHomeCategories(content([second]))).toEqual([{ heading: second, scope: 'public', name: '学习资料' }]);
    expect(readHomeCategories(content([]))).toEqual([]);
  });
});

describe('Home navigation focus and close behavior', () => {
  it.each([true, false])('returns to top respecting reduced motion = %s without changing page state', (reduce) => {
    const scrollTo = vi.fn();
    const location = { hash: '#home' };
    vi.stubGlobal('window', { scrollTo, matchMedia: vi.fn(() => ({ matches: reduce })), location });
    const main = content([]);
    returnHomeToTop(main);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: reduce ? 'instant' : 'smooth' });
    expect(main.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(location.hash).toBe('#home');
  });
  it('back to top focuses the non-editable main with preventScroll', () => {
    const main = content([]);
    expect(focusHomeDestination(main)).toBe(main);
    expect(main.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('selection focuses and scrolls its heading; a removed destination falls back to main', () => {
    const heading = node('personal-category-1', 'personal');
    const main = content([heading]);
    restoreHomePickerFocus(main, null, heading);
    expect(heading.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(heading.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    const removed = node('category-removed');
    restoreHomePickerFocus(main, null, removed);
    expect(removed.focus).not.toHaveBeenCalled();
    expect(main.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('cancel/Escape restores the visible trigger or main when the trigger is hidden', () => {
    const main = content([]);
    const trigger = node('trigger');
    restoreHomePickerFocus(main, trigger, null);
    expect(trigger.focus).toHaveBeenCalledWith({ preventScroll: true });
    trigger.getClientRects = () => [] as unknown as DOMRectList;
    restoreHomePickerFocus(main, trigger, null);
    expect(main.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('wraps both Tab boundaries, leaves interior keys and Escape native', () => {
    const first = node('close');
    const middle = node('category-1');
    const last = node('category-2');
    const ownerDocument = { activeElement: first };
    const dialog = { querySelectorAll: () => [first, middle, last], ownerDocument } as unknown as HTMLDialogElement;
    const event = { key: 'Tab', shiftKey: true, preventDefault: vi.fn() };
    wrapHomePickerFocus(event, dialog);
    expect(last.focus).toHaveBeenCalledOnce();
    ownerDocument.activeElement = last;
    wrapHomePickerFocus({ ...event, shiftKey: false }, dialog);
    expect(first.focus).toHaveBeenCalledOnce();
    ownerDocument.activeElement = middle;
    event.preventDefault.mockClear();
    wrapHomePickerFocus(event, dialog);
    wrapHomePickerFocus({ ...event, key: 'Escape' }, dialog);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
