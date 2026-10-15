import { useEffect, useRef, useState, type RefObject } from 'react';

import { readHomeCategories, restoreHomePickerFocus, returnHomeToTop, wrapHomePickerFocus, type HomeCategoryTarget } from './home-navigation.js';

/** Home-only helpers: no data fetching, routing, or second search projection. */
export function HomeNavigation({ contentRef }: { contentRef: RefObject<HTMLElement | null> }) {
  const markerRef = useRef<HTMLSpanElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pickerListRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const destinationRef = useRef<HTMLElement | null>(null);
  const [targets, setTargets] = useState<HomeCategoryTarget[]>([]);
  const [pastCategories, setPastCategories] = useState(false);
  const [pastScreen, setPastScreen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const content = contentRef.current;
    const marker = markerRef.current;
    if (!content || !marker) return;

    let entries: Element[] = [];
    const updateCategoryVisibility = () => {
      setPastCategories(entries.some((entry) => entry.getBoundingClientRect().bottom <= 0));
    };
    const categoryObserver = new IntersectionObserver(updateCategoryVisibility);
    const updateEditing = () => {
      const focused = document.activeElement;
      setIsEditing(content.querySelector('form') !== null ||
        (focused instanceof HTMLElement && content.contains(focused) &&
          focused.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')));
    };
    const syncView = () => {
      const next = readHomeCategories(content);
      setTargets((current) => current.length === next.length && current.every((target, index) =>
        target.heading === next[index].heading && target.name === next[index].name &&
        target.scope === next[index].scope) ? current : next);

      // A scope with only one category has no nav row; its section heading is
      // the original entry point instead. No scrollspy or active-category state.
      const nextEntries = Array.from(content.querySelectorAll('.personal, .public-navigation'))
        .map((section) => section.querySelector('.category-nav') ?? section.querySelector('h2'))
        .filter((entry): entry is Element => entry !== null);
      if (entries.length !== nextEntries.length || entries.some((entry, index) => entry !== nextEntries[index])) {
        categoryObserver.disconnect();
        entries = nextEntries;
        entries.forEach((entry) => categoryObserver.observe(entry));
      }
      updateCategoryVisibility();
      updateEditing();
    };
    const viewObserver = new MutationObserver(syncView);
    viewObserver.observe(content, { childList: true, subtree: true, characterData: true });
    syncView();

    let topObserver: IntersectionObserver;
    const observeScreen = () => {
      topObserver?.disconnect();
      topObserver = new IntersectionObserver(([entry]) => {
        setPastScreen(!entry.isIntersecting && entry.boundingClientRect.top < 0);
      }, { rootMargin: `${window.innerHeight}px 0px 0px 0px` });
      topObserver.observe(marker);
      updateCategoryVisibility();
    };
    observeScreen();
    // focusout fires before the browser installs the next active element.
    const onFocusOut = () => queueMicrotask(updateEditing);
    content.addEventListener('focusin', updateEditing);
    content.addEventListener('focusout', onFocusOut);
    window.addEventListener('resize', observeScreen);
    return () => {
      viewObserver.disconnect();
      categoryObserver.disconnect();
      topObserver.disconnect();
      content.removeEventListener('focusin', updateEditing);
      content.removeEventListener('focusout', onFocusOut);
      window.removeEventListener('resize', observeScreen);
    };
  }, [contentRef]);

  useEffect(() => {
    if (isOpen && (isEditing || targets.length < 2)) dialogRef.current?.close();
  }, [isEditing, targets, isOpen]);

  const closePicker = () => {
    setIsOpen(false);
    const content = contentRef.current;
    if (!content) return;
    const heading = destinationRef.current;
    destinationRef.current = null;
    restoreHomePickerFocus(content, triggerRef.current, heading);
  };

  const showCategories = !isEditing && pastCategories && targets.length >= 2;
  const showTop = !isEditing && pastScreen;
  return (
    <>
      <span className="home-navigation__marker" ref={markerRef} aria-hidden="true" />
      <div className="home-navigation" role="group" aria-label="页面导航" hidden={!showCategories && !showTop}>
        <button ref={triggerRef} type="button" hidden={!showCategories} aria-haspopup="dialog"
          aria-expanded={isOpen} aria-controls="home-category-picker" onClick={() => {
            dialogRef.current?.showModal();
            pickerListRef.current?.scrollTo({ top: 0, behavior: 'instant' });
            setIsOpen(true);
          }}>分类</button>
        <button type="button" hidden={!showTop} onClick={() => {
          const content = contentRef.current;
          if (content) returnHomeToTop(content);
        }}>顶部</button>
      </div>
      <dialog ref={dialogRef} id="home-category-picker" className="home-category-picker"
        aria-labelledby="home-category-picker-title" aria-modal="true" onClose={closePicker}
        onKeyDown={(event) => wrapHomePickerFocus(event, event.currentTarget)}
        onPaste={(event) => event.stopPropagation()}>
        <div className="home-category-picker__header">
          <h2 id="home-category-picker-title">切换分类</h2>
          <button type="button" autoFocus onClick={() => dialogRef.current?.close()}>关闭</button>
        </div>
        <div className="home-category-picker__list" ref={pickerListRef}>
          {(['personal', 'public'] as const).map((scope) => {
            const group = targets.filter((target) => target.scope === scope);
            if (group.length === 0) return null;
            return <section key={scope} aria-labelledby={`home-picker-${scope}`}>
              <h3 id={`home-picker-${scope}`}>{scope === 'personal' ? '我的分类' : '公共分类'}</h3>
              {group.map(({ heading, name }) => <button type="button" key={heading.id} onClick={() => {
                destinationRef.current = heading;
                dialogRef.current?.close();
              }}>{name}</button>)}
            </section>;
          })}
        </div>
      </dialog>
    </>
  );
}
