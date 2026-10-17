import { useEffect, useId, useRef, useState } from 'react';
import { ConfirmDialog, ModalDialog } from './ModalDialog.js';
import { useConfirmation } from './use-confirmation.js';
import { mutationErrorMessage } from './personal-error.js';
import { LinkMove } from './LinkMove.js';
import type { LinkMoveControls, LinkMoveOutcome } from './link-reorder.js';

import type {
  PersonalCategory,
  PersonalLink,
  PersonalNavigation,
  PersonalMutationOutcome,
} from './api/personal-navigation.js';
import {
  acceptQuickAddUrl,
  isEditableTarget,
  readClipboardUrl,
  resolveQuickAddCategoryId,
  resolveQuickAddTitle,
  shouldCloseQuickAdd,
  type QuickAddIntent,
} from './quick-add.js';
import { filterCategoriesByQuery } from './navigation-search.js';
import { CategoryNavigation, DestinationIcon, DestinationHost } from './PublicNavigation.js';

/**
 * Render state for the authenticated personal section.
 *
 * `absent` means "this visitor has no personal navigation" — used for guests and
 * while the session is unresolved. It is a distinct state (not an empty `ready`)
 * so a guest can never be rendered as an empty personal list, and so a stale
 * payload cannot survive a logout by being reinterpreted as `ready`.
 */
export type PersonalNavigationState =
  | { status: 'absent' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: PersonalNavigation };

/** Mutation actions the container implements; the view only triggers them. */
export interface PersonalNavigationActions {
  createCategory(name: string): Promise<PersonalMutationOutcome>;
  renameCategory(categoryId: number, name: string): Promise<PersonalMutationOutcome>;
  deleteCategory(categoryId: number): Promise<PersonalMutationOutcome>;
  moveCategory(categoryId: number, direction: -1 | 1): Promise<PersonalMutationOutcome>;
  createLink(input: {
    categoryId: number;
    title: string;
    url: string;
  }): Promise<PersonalMutationOutcome>;
  updateLink(
    linkId: number,
    input: { title: string; url: string; categoryId: number },
  ): Promise<PersonalMutationOutcome>;
  deleteLink(linkId: number): Promise<PersonalMutationOutcome>;
  moveLink(linkId: number, direction: -1 | 1): Promise<PersonalMutationOutcome>;
  moveLinkTo(linkId: number, position: number): Promise<LinkMoveOutcome>;
}

export interface PersonalNavigationViewProps {
  state: PersonalNavigationState;
  actions: PersonalNavigationActions;
  /** True while any personal mutation is in flight; disables mutation controls. */
  isMutating: boolean;
  /** Non-technical mutation failure text, if any. */
  errorMessage: string | null;
  /**
   * Client-side search query, owned by the container so it can span the personal
   * and public sections. Non-empty queries filter the rendered links only — the
   * payload, ordering, and CRUD controls are untouched.
   */
  searchQuery: string;
  onRetry?: () => void;
}

/**
 * Inline create/edit form for a personal category.
 *
 * Deliberately a plain form rather than a dialog: no dialog library is used in
 * P3, and the same component serves both "new category" and "rename".
 */
function CategoryForm({
  initialName,
  submitLabel,
  isBusy,
  onSubmit,
  onCancel,
}: {
  initialName: string;
  submitLabel: string;
  isBusy: boolean;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);

  return (
    <form
      className="personal__form"
      onSubmit={(event) => {
        event.preventDefault();
        if (isBusy || name.trim().length === 0) {
          return;
        }
        void onSubmit(name);
      }}
    >
      <label className="personal__field">
        <span className="personal__label">分类名称</span>
        <input
          className="personal__input"
          type="text"
          name="categoryName"
          value={name}
          disabled={isBusy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className="personal__form-actions">
        <button className="personal__button personal__button--primary" type="submit" disabled={isBusy}>
          {submitLabel}
        </button>
        <button className="personal__button" type="button" disabled={isBusy} onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

/**
 * Global Quick Add form.
 *
 * This is the MVP's primary "add a URL" affordance, so it optimises for one
 * thing: type or paste a URL, press add. The URL is the first field and the only
 * required one — the title falls back to a hostname suggestion, and the category
 * defaults to the user's `⭐ 我的常用`.
 *
 * All three P4.2 entry points (global add, contextual `＋`, and the paste
 * shortcut) open this one form through a `QuickAddIntent`; they differ only in the
 * URL they pre-fill and the category they preselect. The form never submits
 * itself, so clipboard/paste content is always confirmed by the user.
 *
 * Still not implemented here: duplicate detection and search. There is also no
 * metadata fetch — the title suggestion is computed locally and the server
 * remains the URL validation authority.
 */
function QuickAddForm({
  intent,
  categories,
  defaultCategoryId,
  isBusy,
  returnFocus,
  onSubmit,
  onCancel,
}: {
  intent: QuickAddIntent;
  categories: PersonalCategory[];
  defaultCategoryId: number;
  isBusy: boolean;
  returnFocus: HTMLElement | null;
  onSubmit: (input: { title: string; url: string; categoryId: number }) => Promise<PersonalMutationOutcome>;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState(intent.url);
  const [title, setTitle] = useState('');
  // A contextual `＋` preselects its category; otherwise fall back to the default.
  const [categoryId, setCategoryId] = useState(intent.categoryId ?? defaultCategoryId);
  const [failure, setFailure] = useState<{ field: boolean; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const errorId = useId();
  const busy = isBusy || submitting;

  /**
   * Move focus into the URL field when this form mounts.
   *
   * The form is only ever opened by an explicit user action (`＋ 添加网址`, a
   * contextual `＋`, or a paste), so entering or confirming the URL is the next
   * step. Without this the browser keeps focus on whatever control was clicked,
   * leaving the form's primary input several Tab presses away. The component is
   * keyed on the intent, so each new open remounts it and focuses again.
   */
  const urlInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (failure && !busy) (failure.field ? urlInputRef.current : submitRef.current)?.focus();
  }, [failure, busy]);

  const suggestion = resolveQuickAddTitle('', url);

  /**
   * Plain-language hint about where the URL came from.
   *
   * When clipboard access fails the user simply sees manual-entry guidance — no
   * `NotAllowedError`, no permission jargon. Nothing here reveals whether a
   * clipboard read was attempted or why it failed.
   */
  const sourceHint =
    intent.source === 'clipboard'
      ? '已从剪贴板读取网址，请确认后点击添加。'
      : intent.source === 'paste'
        ? '已从粘贴内容读取网址，请确认后点击添加。'
        : '未能读取剪贴板，请手动粘贴网址';

  return (
    <ModalDialog title="添加网址" busy={busy} returnFocus={returnFocus}
      initialFocusRef={urlInputRef} onDismiss={onCancel}>
    <form
      className="personal__form quick-add"
      aria-describedby={failure && !failure.field ? errorId : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || submittingRef.current) return;
        if (url.trim().length === 0) {
          setFailure({ field: true, message: '请输入或粘贴网址后再添加。' });
          return;
        }
        // A blank title is resolved to the hostname suggestion. The server still
        // validates the URL and owns ownership/normalization.
        submittingRef.current = true;
        setSubmitting(true);
        setFailure(null);
        void onSubmit({ title: resolveQuickAddTitle(title, url), url, categoryId }).then((outcome) => {
          if (!shouldCloseQuickAdd(outcome.status)) {
            const field = outcome.status === 'invalid' || outcome.status === 'conflict';
            setFailure({ field, message: field
              ? `${mutationErrorMessage(outcome, true)}请检查网址或选择其他分类后再试。`
              : '添加失败，内容已保留。请检查连接后重试；若登录已失效，请重新登录。' });
          }
        }).catch(() => setFailure({ field: false, message: '添加失败，内容已保留。请检查连接后重试。' }))
          .finally(() => { submittingRef.current = false; setSubmitting(false); });
      }}
    >
      <p className="quick-add__hint">{sourceHint}</p>
      <label className="personal__field">
        <span className="personal__label">网址</span>
        <input
          ref={urlInputRef}
          className="personal__input"
          type="text"
          name="quickAddUrl"
          placeholder="例如 example.com…"
          autoComplete="off"
          value={url}
          disabled={busy}
          aria-invalid={failure?.field || undefined}
          aria-describedby={failure?.field ? errorId : undefined}
          onChange={(event) => { setUrl(event.target.value); setFailure(null); }}
        />
        {failure?.field ? <span id={errorId} className="personal__error" role="alert">{failure.message}</span> : null}
      </label>

      <label className="personal__field">
        <span className="personal__label">名称（可选）</span>
        <input
          className="personal__input"
          type="text"
          name="quickAddTitle"
          placeholder={suggestion.length > 0 ? suggestion : '留空则使用网址域名'}
          autoComplete="off"
          value={title}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>

      <label className="personal__field">
        <span className="personal__label">分类</span>
        <select
          className="personal__input"
          name="quickAddCategory"
          value={categoryId}
          disabled={busy}
          onChange={(event) => { setCategoryId(Number(event.target.value)); setFailure(null); }}
        >
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>

      {failure && !failure.field ? <p id={errorId} className="personal__error" role="alert">{failure.message}</p> : null}
      <div className="personal__form-actions">
        <button ref={submitRef} className="personal__button personal__button--primary" type="submit" disabled={busy}>
          {busy ? '添加中…' : '添加'}
        </button>
        <button className="personal__button" type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
    </ModalDialog>
  );
}

/**
 * Inline create/edit form for a personal link.
 *
 * The category `<select>` uses only the caller's own categories, so a move can
 * only ever target a category the server will accept as owned. This is the
 * category-local form from P3; the global Quick Add form is separate because it
 * must be reachable without first choosing a category.
 */
function LinkForm({
  initialTitle,
  initialUrl,
  initialCategoryId,
  categories,
  submitLabel,
  isBusy,
  errorMessage = null,
  onSubmit,
  onCancel,
}: {
  initialTitle: string;
  initialUrl: string;
  initialCategoryId: number;
  categories: PersonalCategory[];
  submitLabel: string;
  isBusy: boolean;
  errorMessage?: string | null;
  onSubmit: (input: { title: string; url: string; categoryId: number }) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [url, setUrl] = useState(initialUrl);
  const [categoryId, setCategoryId] = useState(initialCategoryId);
  const errorId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const fieldError = errorMessage !== null && (
    errorMessage === mutationErrorMessage({ status: 'invalid' }, true) ||
    errorMessage === mutationErrorMessage({ status: 'conflict' }, true)
  );

  /**
   * Return the caret to the URL field when the parent reports a failure.
   *
   * Submitting disables the controls, and a disabled element cannot hold focus, so
   * focus falls to `<body>` while the request is in flight. On failure the form stays
   * open with the input preserved, but nothing was focused, so the user had to Tab back
   * to the form to correct or retry. This mirrors the Quick Add form's error focus.
   *
   * The parent only passes a non-null value for the category that submitted, so this
   * runs for the form the user actually used.
   */
  const urlInputRef = useRef<HTMLInputElement>(null);
  const hasMountedRef = useRef(false);

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }

    if (errorMessage !== null && !isBusy) {
      (fieldError ? urlInputRef.current : formRef.current)?.focus();
    }
  }, [errorMessage, fieldError, isBusy]);

  return (
    <form
      ref={formRef}
      tabIndex={-1}
      className="personal__form"
      aria-describedby={errorMessage && !fieldError ? errorId : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (isBusy || title.trim().length === 0 || url.trim().length === 0) {
          return;
        }
        void onSubmit({ title, url, categoryId });
      }}
    >
      <label className="personal__field">
        <span className="personal__label">名称</span>
        <input
          className="personal__input"
          type="text"
          name="linkTitle"
          value={title}
          disabled={isBusy}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>

      <label className="personal__field">
        <span className="personal__label">网址</span>
        <input
          ref={urlInputRef}
          className="personal__input"
          type="text"
          name="linkUrl"
          aria-invalid={fieldError || undefined}
          aria-describedby={fieldError ? errorId : undefined}
          value={url}
          disabled={isBusy}
          onChange={(event) => setUrl(event.target.value)}
        />
        {fieldError ? <span id={errorId} className="personal__error" role="alert">{errorMessage} 请检查网址或选择其他分类后再试。</span> : null}
      </label>

      <label className="personal__field">
        <span className="personal__label">分类</span>
        <select
          className="personal__input"
          name="linkCategory"
          value={categoryId}
          disabled={isBusy}
          onChange={(event) => setCategoryId(Number(event.target.value))}
        >
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>

      {errorMessage && !fieldError ? <p id={errorId} className="personal__error" role="alert">{errorMessage} 内容已保留，请检查连接后重试。</p> : null}
      <div className="personal__form-actions">
        <button className="personal__button personal__button--primary" type="submit" disabled={isBusy}>
          {submitLabel}
        </button>
        <button className="personal__button" type="button" disabled={isBusy} onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

/**
 * A personal link.
 *
 * The anchor uses `normalizedUrl` — the server-validated, navigable form — and
 * never `url`, which is the raw user input (e.g. `example.com:8080/path`) and
 * must not be handed to the browser. The client never re-normalizes.
 */
function PersonalLinkRow({
  linkMove,
  link,
  owningCategoryId,
  index,
  total,
  isBusy,
  isOrganizing,
  isEditing,
  editingCategories,
  errorMessage,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onDelete,
  onMove,
}: {
  link: PersonalLink;
  linkMove: LinkMoveControls;
  owningCategoryId: number;
  index: number;
  total: number;
  isBusy: boolean;
  isOrganizing: boolean;
  isEditing: boolean;
  editingCategories: PersonalCategory[];
  errorMessage: string | null;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (input: { title: string; url: string; categoryId: number }) => Promise<void>;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  return (
    <li className="personal-link">
      <div className="personal-link__main">
        <a
          className="personal-link__anchor"
          href={link.normalizedUrl}
          title={link.title}
          target="_blank"
          rel="noopener noreferrer"
        >
          <DestinationIcon title={link.title} iconUrl={link.iconUrl} />
          <span className="destination-copy">
            <span className="personal-link__title">{link.title}</span>
            <span className="personal-link__description"><DestinationHost url={link.normalizedUrl} /></span>
          </span>
        </a>
        {isOrganizing ? <div className="personal-link__controls">
          <button
            className="personal__button personal__button--icon"
            type="button"
            aria-label={`上移 ${link.title}`}
            disabled={isBusy || index === 0}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            className="personal__button personal__button--icon"
            type="button"
            aria-label={`下移 ${link.title}`}
            disabled={isBusy || index === total - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button
            className="personal__button"
            type="button"
            disabled={isBusy}
            onClick={isEditing ? onCancelEdit : onStartEdit}
          >
            {isEditing ? '取消编辑' : '编辑'}
          </button>
          <button className="personal__button" type="button" disabled={isBusy} onClick={onDelete}>
            删除
          </button>
          <LinkMove id={link.id} title={link.title} index={index} total={total} isBusy={isBusy}
            isEditing={isEditing} scope="personal" controls={linkMove} />
        </div> : null}
      </div>

      {isEditing ? (
        <LinkForm
          initialTitle={link.title}
          initialUrl={link.url}
          initialCategoryId={owningCategoryId}
          categories={editingCategories}
          submitLabel="保存"
          isBusy={isBusy}
          errorMessage={errorMessage}
          onSubmit={onSubmitEdit}
          onCancel={onCancelEdit}
        />
      ) : null}
    </li>
  );
}

/** One personal category: header controls, link list, and inline forms. */
function PersonalCategorySection({
  linkMove,
  category,
  index,
  total,
  allCategories,
  isBusy,
  isOrganizing,
  editingCategoryId,
  editingLinkId,
  editingLinkError,
  creatingLinkCategoryId,
  inlineAddError,
  inlineAddSavedTitle,
  onStartRename,
  onCancelRename,
  onSubmitRename,
  onDeleteCategory,
  onMoveCategory,
  onStartContextualAdd,
  onStartCreateLink,
  onCancelCreateLink,
  onSubmitCreateLink,
  onStartEditLink,
  onCancelEditLink,
  onSubmitEditLink,
  onDeleteLink,
  onMoveLink,
}: {
  category: PersonalCategory;
  linkMove: LinkMoveControls;
  index: number;
  total: number;
  allCategories: PersonalCategory[];
  isBusy: boolean;
  isOrganizing: boolean;
  editingCategoryId: number | null;
  editingLinkId: number | null;
  editingLinkError: string | null;
  creatingLinkCategoryId: number | null;
  /**
   * Error text for an inline add in THIS category, or `null`.
   *
   * Passed down rather than read from the section-level notice because that notice
   * renders above every category: when the inline form is used on a lower category it
   * sits hundreds of pixels out of view, so the user saw no failure feedback at all.
   * Only the category that owns the failed attempt receives it, which also keeps a
   * single `role="alert"` on screen.
   */
  inlineAddError: string | null;
  /**
   * Title of the link this category just gained through the inline form, or `null`.
   *
   * Derived by the parent from the rendered link list, so the confirmation can never
   * claim a link that is not there (the same guarantee UX1.6 applied to Quick Add).
   */
  inlineAddSavedTitle: string | null;
  onStartRename: () => void;
  onCancelRename: () => void;
  onSubmitRename: (name: string) => Promise<void>;
  onDeleteCategory: () => void;
  onMoveCategory: (direction: -1 | 1) => void;
  /** Contextual `＋`: open Quick Add targeting this category. */
  onStartContextualAdd: () => void;
  onStartCreateLink: () => void;
  onCancelCreateLink: () => void;
  onSubmitCreateLink: (input: { title: string; url: string }) => Promise<void>;
  onStartEditLink: (linkId: number) => void;
  onCancelEditLink: () => void;
  onSubmitEditLink: (
    linkId: number,
    input: { title: string; url: string; categoryId: number },
  ) => Promise<void>;
  onDeleteLink: (link: PersonalLink) => void;
  onMoveLink: (linkId: number, direction: -1 | 1) => void;
}) {
  const headingId = `personal-category-${String(category.id)}`;

  /**
   * The inline `新增网址` trigger, so focus can return to it after a successful add.
   *
   * The form unmounts on success, which previously dropped focus to `<body>`: a
   * keyboard user lost their place and had to Tab back into the section. Returning to
   * the control that opened the form is the existing pattern Quick Add already uses.
   */
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const hasConfirmedRef = useRef(false);

  useEffect(() => {
    const hasConfirmation = inlineAddSavedTitle !== null && inlineAddSavedTitle.length > 0;

    // Only act on the transition into a confirmation, so an unrelated re-render cannot
    // steal focus from wherever the user has since moved it.
    if (hasConfirmation && !hasConfirmedRef.current) {
      hasConfirmedRef.current = true;
      addButtonRef.current?.focus();
    } else if (!hasConfirmation) {
      hasConfirmedRef.current = false;
    }
  }, [inlineAddSavedTitle]);

  return (
    <section className="personal-category" aria-labelledby={headingId}>
      <div className="personal-category__header">
        <h3 className="personal-category__title" id={headingId} tabIndex={-1} data-home-category="personal">
          {category.name}
        </h3>
        <div className="personal-category__controls">
          {/*
            Contextual add: opens the same Quick Add form with this category
            preselected. A small `＋` sits next to the category name so the target
            is unambiguous without the user re-selecting it.
          */}
          <button
            className="personal__button personal__button--icon"
            type="button"
            aria-label={`添加网址到 ${category.name}`}
            disabled={isBusy}
            onClick={onStartContextualAdd}
          >
            ＋
          </button>
          {isOrganizing ? <>
          <button
            className="personal__button personal__button--icon"
            type="button"
            aria-label={`上移分类 ${category.name}`}
            disabled={isBusy || index === 0}
            onClick={() => onMoveCategory(-1)}
          >
            ↑
          </button>
          <button
            className="personal__button personal__button--icon"
            type="button"
            aria-label={`下移分类 ${category.name}`}
            disabled={isBusy || index === total - 1}
            onClick={() => onMoveCategory(1)}
          >
            ↓
          </button>
          <button
            className="personal__button"
            type="button"
            disabled={isBusy}
            onClick={editingCategoryId === category.id ? onCancelRename : onStartRename}
          >
            {editingCategoryId === category.id ? '取消编辑' : '编辑'}
          </button>
          {/* The default category is protected: no delete affordance is offered. */}
          {category.isDefault ? null : (
            <button className="personal__button" type="button" disabled={isBusy} onClick={onDeleteCategory}>
              删除
            </button>
          )}
          </> : null}
        </div>
      </div>

      {editingCategoryId === category.id ? (
        <CategoryForm
          initialName={category.name}
          submitLabel="保存"
          isBusy={isBusy}
          onSubmit={onSubmitRename}
          onCancel={onCancelRename}
        />
      ) : null}

      {category.links.length === 0 ? (
        <p className="personal-category__empty">此分类暂无网址</p>
      ) : (
        <ul className="personal-link-list">
          {category.links.map((link) => {
            // Ordering indices come from the full link list, not the filtered
            // one, so search never disables at the wrong boundary or swaps
            // against the wrong neighbour.
            const fullLinks =
              allCategories.find((item) => item.id === category.id)?.links ?? category.links;

            return (
            <PersonalLinkRow
              linkMove={linkMove}
              key={link.id}
              link={link}
              owningCategoryId={category.id}
              index={fullLinks.findIndex((item) => item.id === link.id)}
              total={fullLinks.length}
              isBusy={isBusy}
              isOrganizing={isOrganizing}
              isEditing={editingLinkId === link.id}
              editingCategories={allCategories}
              errorMessage={editingLinkId === link.id ? editingLinkError : null}
              onStartEdit={() => onStartEditLink(link.id)}
              onCancelEdit={onCancelEditLink}
              onSubmitEdit={(input) => onSubmitEditLink(link.id, input)}
              onDelete={() => onDeleteLink(link)}
              onMove={(direction) => onMoveLink(link.id, direction)}
            />
            );
          })}
        </ul>
      )}

      {inlineAddSavedTitle !== null && inlineAddSavedTitle.length > 0 ? (
        <p className="personal__success" role="status">
          已添加「{inlineAddSavedTitle}」。
        </p>
      ) : null}

      {inlineAddError !== null && inlineAddError.length > 0 && creatingLinkCategoryId !== category.id ? (
        <p className="personal__error" role="alert">
          {inlineAddError}
        </p>
      ) : null}

      {creatingLinkCategoryId === category.id ? (
        <LinkForm
          initialTitle=""
          initialUrl=""
          initialCategoryId={category.id}
          categories={allCategories}
          submitLabel="保存"
          isBusy={isBusy}
          errorMessage={inlineAddError}
          onSubmit={onSubmitCreateLink}
          onCancel={onCancelCreateLink}
        />
      ) : isOrganizing ? (
        <button
          ref={addButtonRef}
          className="personal__button"
          type="button"
          disabled={isBusy}
          onClick={onStartCreateLink}
        >
          新增网址
        </button>
      ) : null}
    </section>
  );
}

/**
 * Authenticated personal navigation section.
 *
 * Presentational apart from inline form state. It performs no fetching and no
 * session calls, so it renders in a test environment; the container owns data
 * loading, mutation dispatch, logout clearing, and focus refresh.
 *
 * It renders nothing at all in the `absent` state, so a guest never receives
 * personal markup — this is a render decision, not a CSS hide.
 */
export function PersonalNavigationView({
  state,
  actions,
  isMutating,
  errorMessage,
  searchQuery,
  onRetry,
}: PersonalNavigationViewProps) {
  const [isOrganizing, setIsOrganizing] = useState(false);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [quickAddIntent, setQuickAddIntent] = useState<QuickAddIntent | null>(null);
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null);
  const [creatingLinkCategoryId, setCreatingLinkCategoryId] = useState<number | null>(null);
  const [editingLinkId, setEditingLinkId] = useState<number | null>(null);

  /**
   * The category whose inline add most recently succeeded, with the link identity.
   *
   * The inline form and Quick Add share `actions.createLink`, but their feedback
   * belongs in different places: Quick Add is a section-level flow, while the inline
   * form is per-category and must confirm next to the category the user was editing.
   * Tracking the owning category id is what scopes the message.
   *
   * The identity is `{ categoryId, title, url }`, not the title alone. Personal-link
   * titles are not unique — the server accepts any number of same-title links in one
   * category — so a title-only check would let a *different* same-title sibling keep a
   * confirmation alive after the link it actually described was deleted. `url` is the
   * trimmed value the server stores and returns verbatim (`createLink` persists
   * `validateLinkUrl(input).url`, which is `input.trim()`), so this compares against
   * server-authoritative data without reimplementing any normalization or validation.
   * Duplicate URLs within a category are already prevented server-side, which is what
   * makes the triple unambiguous.
   *
   * Freshness is derived against the rendered list below, so a link that is deleted,
   * renamed, re-url'ed, or moved away stops being confirmed.
   */
  const [inlineAddSaved, setInlineAddSaved] = useState<
    { categoryId: number; title: string; url: string } | null
  >(null);

  /**
   * The category whose inline add most recently failed, or `null`.
   *
   * The message text still comes from the container's single error string, which is
   * already user-facing and correctly localized; only its *placement* is scoped here.
   */
  const [inlineAddErrorCategoryId, setInlineAddErrorCategoryId] = useState<number | null>(null);

  /**
   * The link title just saved through Quick Add, or `null`.
   *
   * Quick Add closes on success, which previously left the user with no
   * confirmation at all: the new row appears somewhere in a possibly long list.
   * This drives one plain `role="status"` line — the same pattern already used by
   * the portability panel — so success is both visible and announced without
   * adding a toast framework.
   *
   * Local, presentational state only: it reflects a mutation the container has
   * already committed to the server, and it is cleared when the next Quick Add
   * opens. It is additionally re-checked against the rendered list below, because
   * clearing on the next add is not sufficient: the link can also disappear by
   * another route (deleted from its row, or removed by a category delete), and the
   * message must never keep claiming a link that is no longer there. Rendering is
   * derived from state that is already server-authoritative, so the notice cannot
   * become false in the first place.
   */
  const [savedLinkTitle, setSavedLinkTitle] = useState<string | null>(null);
  const [movingLinkId, setMovingLinkId] = useState<number | null>(null);
  const confirmation = useConfirmation();
  const [quickAddReturnFocus, setQuickAddReturnFocus] = useState<HTMLElement | null>(null);
  const openingRef = useRef(false);
  const openingEpochRef = useRef(0);

  useEffect(() => () => { openingEpochRef.current += 1; }, []);

  /** The `＋ 添加网址` control, so focus can return to it after a successful add. */
  const quickAddTriggerRef = useRef<HTMLButtonElement>(null);

  const isQuickAddOpen = quickAddIntent !== null;
  const categoriesForQuickAdd = state.status === 'ready' ? state.data.categories : [];
  const quickAddDefaultCategoryId = resolveQuickAddCategoryId(categoriesForQuickAdd);
  const canQuickAdd = state.status === 'ready' && quickAddDefaultCategoryId !== null;
  const hasOrganizationForm =
    creatingCategory || editingCategoryId !== null ||
    editingLinkId !== null || creatingLinkCategoryId !== null ||
    (movingLinkId !== null && state.status === 'ready' &&
      filterCategoriesByQuery(state.data.categories, searchQuery).some((category) => category.links.some((link) => link.id === movingLinkId)));

  /**
   * Page-level paste shortcut.
   *
   * Uses the browser's own `paste` event rather than a background Clipboard API
   * read, so it stays within the user's explicit paste action and works in
   * browsers that gate `readText`. Pasted text that is not an acceptable URL is
   * ignored silently — no form, no error.
   *
   * When focus is inside an editable control the handler returns immediately so
   * normal pasting into the form fields is never hijacked.
   */
  useEffect(() => {
    if (!canQuickAdd) {
      return () => {};
    }

    const handlePaste = (event: ClipboardEvent) => {
      if (isEditableTarget(event.target) || document.querySelector('dialog[open]') || openingRef.current) {
        return;
      }

      const url = acceptQuickAddUrl(event.clipboardData?.getData('text/plain') ?? '');

      if (url === null) {
        return;
      }

      // Opening the form must not also paste into whatever was focused.
      event.preventDefault();
      setQuickAddReturnFocus(document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement : quickAddTriggerRef.current);
      setSavedLinkTitle(null);
      setInlineAddSaved(null);
      setInlineAddErrorCategoryId(null);
      setCreatingCategory(false);
      setMovingLinkId(null);
      setQuickAddIntent({ source: 'paste', url, categoryId: null });
    };

    window.addEventListener('paste', handlePaste);
    return () => {
      window.removeEventListener('paste', handlePaste);
    };
  }, [canQuickAdd]);

  if (state.status === 'absent') {
    return null;
  }

  /** Reset inline form state; used after every successful mutation. */
  const closeForms = () => {
    setMovingLinkId(null);
    setCreatingCategory(false);
    setQuickAddIntent(null);
    setEditingCategoryId(null);
    setCreatingLinkCategoryId(null);
    setEditingLinkId(null);
  };
  /**
   * Open Quick Add from an explicit click, attempting a clipboard read first.
   *
   * Clipboard success pre-fills the URL; every failure mode falls back to the
   * same manual form, so the click is never a dead end. The category is always
   * honoured regardless of clipboard outcome, which is what preserves a
   * contextual `＋` selection through the fallback.
   */
  const openQuickAdd = async (categoryId: number | null) => {
    if (openingRef.current || document.querySelector('dialog[open]')) return;
    openingRef.current = true;
    const epoch = openingEpochRef.current;
    setQuickAddReturnFocus(document.activeElement instanceof HTMLElement
      ? document.activeElement : quickAddTriggerRef.current);
    setMovingLinkId(null);
    setCreatingCategory(false);
    // A previous success message must not survive into the next add. The inline
    // confirmation is cleared too, so only one confirmation can ever be on screen.
    setSavedLinkTitle(null);
    setInlineAddSaved(null);
    setInlineAddErrorCategoryId(null);

    const clipboardUrl = await readClipboardUrl();
    openingRef.current = false;
    if (epoch !== openingEpochRef.current || document.querySelector('dialog[open]')) return;

    setQuickAddIntent({
      source: clipboardUrl === null ? 'manual' : 'clipboard',
      url: clipboardUrl ?? '',
      categoryId,
    });
  };

  const header = (
    <div className="personal__header">
      <h2 className="personal__title" id="personal-title" tabIndex={-1}>
        我的导航
      </h2>
      {canQuickAdd ? (
        <div className="personal__header-actions">
          {/*
            The MVP's primary action. It attempts a clipboard read on this
            explicit click, then always opens the same confirm-then-save form.
          */}
          <button
            ref={quickAddTriggerRef}
            className="personal__button personal__button--primary"
            type="button"
            disabled={isMutating}
            onClick={() => {
              void openQuickAdd(null);
            }}
          >
            ＋ 添加网址
          </button>
          <button
            className="personal__button"
            type="button"
            aria-pressed={isOrganizing}
            disabled={isMutating || hasOrganizationForm}
            onClick={() => { setMovingLinkId(null); setIsOrganizing((current) => !current); }}
          >
            {isOrganizing ? '完成整理' : '整理'}
          </button>
          {isOrganizing && !creatingCategory && !isQuickAddOpen ? (
            <button
              className="personal__button"
              type="button"
              disabled={isMutating}
              onClick={() => { setMovingLinkId(null); setCreatingCategory(true); }}
            >
              新建分类
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  if (state.status === 'loading') {
    return (
      <section className="personal" aria-labelledby="personal-title">
        {header}
        <p className="status" role="status">
          正在加载个人导航…
        </p>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section className="personal" aria-labelledby="personal-title">
        {header}
        <p className="status status--error" role="alert">
          个人导航暂时无法加载，请稍后重试。
        </p>
        {onRetry ? <button className="personal__button" type="button" onClick={onRetry}>重试加载个人导航</button> : null}
      </section>
    );
  }

  const { categories } = state.data;

  // View projection only: filtered copies for display. CRUD controls and the
  // underlying payload keep the full, unfiltered category set so that edits,
  // moves, and reordering still operate on complete data while searching.
  const hasLinks = categories.some((category) => category.links.length > 0);
  const visibleCategories = categories.flatMap((category) => {
    // Keep active forms mounted even if a query stops matching their category.
    const hasActiveForm =
      editingCategoryId === category.id || creatingLinkCategoryId === category.id ||
      category.links.some((link) => link.id === editingLinkId);

    if (hasActiveForm || (isOrganizing && category.links.length === 0)) {
      return [category];
    }

    return filterCategoriesByQuery([category], searchQuery)
      .filter((item) => item.links.length > 0);
  });

  /**
   * Whether the just-saved link is still present in the authoritative payload.
   *
   * The confirmation is deliberately derived rather than stored: if the link is
   * gone (deleted from its row, or its category deleted), the message is no longer
   * true and must not render. Comparing against `categories` — the full server
   * payload, not the search-filtered view — means an active search never hides a
   * still-valid confirmation.
   */
  const savedLinkStillPresent =
    savedLinkTitle !== null &&
    categories.some((category) => category.links.some((link) => link.title === savedLinkTitle));

  /**
   * Whether the inline form's link is still present in ITS OWN category.
   *
   * Scoped by category, title AND url: the same title can legitimately exist several
   * times (and in several categories), so only the exact row that was added may keep the
   * confirmation alive. See `inlineAddSaved` for why `url` is a sound identity here.
   */
  const inlineAddStillPresent =
    inlineAddSaved !== null &&
    categories.some(
      (category) =>
        category.id === inlineAddSaved.categoryId &&
        category.links.some(
          (link) => link.title === inlineAddSaved.title && link.url === inlineAddSaved.url,
        ),
    );

  /**
   * The container's error text for whichever category owns the failed inline attempt.
   *
   * Returning `null` for every other category is what keeps a single message scoped to
   * the form the user actually submitted, instead of showing it above every category.
   */
  const inlineAddErrorFor = (categoryId: number): string | null =>
    inlineAddErrorCategoryId === categoryId ? errorMessage : null;

  return (
    <section className="personal" aria-labelledby="personal-title" data-organizing={isOrganizing}>
      {header}
      <ConfirmDialog request={confirmation.request} onDismiss={confirmation.dismiss} />
      {isOrganizing && hasOrganizationForm ? (
        <p className="personal__organize-hint" role="status">
          请先保存或取消正在编辑的内容，再完成整理。
        </p>
      ) : null}

      {/*
        The container's message is rendered at category level when an inline add owns
        it (see `inlineAddErrorFor`), so it is suppressed here to avoid showing the same
        failure twice — once out of view above every category, and once where the user
        submitted it. Quick Add and category-level failures still use this notice.
      */}
      {errorMessage !== null && errorMessage.length > 0 && inlineAddErrorCategoryId === null && !isQuickAddOpen && editingLinkId === null ? (
        <p className="personal__error" role="alert">
          {errorMessage} 请检查输入或连接后重试。
        </p>
      ) : null}

      {savedLinkStillPresent ? (
        <p className="personal__success" role="status">
          已添加「{savedLinkTitle}」。
        </p>
      ) : null}

      {quickAddIntent !== null && quickAddDefaultCategoryId !== null ? (
        <>
          <QuickAddForm
            // Remount when the entry context changes, so a contextual `＋` or a
            // new paste replaces the pre-filled URL rather than being ignored by
            // the existing field state.
            key={`${quickAddIntent.source}:${String(quickAddIntent.categoryId ?? 'default')}:${quickAddIntent.url}`}
            intent={quickAddIntent}
            categories={categoriesForQuickAdd}
            defaultCategoryId={quickAddDefaultCategoryId}
            isBusy={isMutating}
            returnFocus={quickAddReturnFocus}
            onSubmit={async (input) => {
              const outcome = await actions.createLink(input);

              // Close only on success. On failure the form stays open with the
              // user's input intact so an invalid URL can be corrected and
              // retried — the error message is shown above the form.
              if (shouldCloseQuickAdd(outcome.status)) {
                // Confirm the save before the form disappears. The title shown is
                // the one the server accepted (a blank title resolves to the
                // hostname), matching the row that now renders.
                setSavedLinkTitle(input.title);
                // Only one confirmation may be on screen, so the inline one is cleared.
                setInlineAddSaved(null);
                setInlineAddErrorCategoryId(null);
                closeForms();
              }
              return outcome;
            }}
            onCancel={() => setQuickAddIntent(null)}
          />
        </>
      ) : null}

      {creatingCategory ? (
        <CategoryForm
          initialName=""
          submitLabel="保存"
          isBusy={isMutating}
          onSubmit={async (name) => {
            await actions.createCategory(name);
            closeForms();
          }}
          onCancel={() => setCreatingCategory(false)}
        />
      ) : null}

      {!hasLinks && !isOrganizing && searchQuery.trim().length === 0 ? (
        <div className="personal__empty">
          <p className="status">还没有添加网址。复制常用网址，即可加入我的导航。</p>
          {canQuickAdd ? <button className="personal__button personal__button--primary" type="button"
            disabled={isMutating} onClick={() => { void openQuickAdd(null); }}>＋ 添加第一个网址</button> : null}
        </div>
      ) : null}

      {/*
        No local "no results" message here. One search spans personal and public
        navigation, so a query that matches only public links legitimately leaves
        this section's projection empty — and claiming "no results" here would
        contradict the public matches shown below. The container's combined
        no-results state is the single authority for that message.
      */}

      <CategoryNavigation
        categories={visibleCategories}
        headingPrefix="personal-category-"
        label="我的分类"
      />
      <div className="personal__categories">
      {visibleCategories.map((category) => (
        <PersonalCategorySection
          linkMove={{ activeId: movingLinkId, open: (id) => { closeForms(); setMovingLinkId(id); }, submit: actions.moveLinkTo }}
          key={category.id}
          category={category}
          // Ordering controls must reflect the real category order, not the
          // filtered view, so a search never disables at the wrong boundary or
          // swaps against the wrong neighbour.
          index={categories.findIndex((item) => item.id === category.id)}
          total={categories.length}
          allCategories={categories}
          isBusy={isMutating}
          isOrganizing={isOrganizing}
          editingCategoryId={editingCategoryId}
          editingLinkId={editingLinkId}
          editingLinkError={errorMessage}
          creatingLinkCategoryId={creatingLinkCategoryId}
          onStartRename={() => { setMovingLinkId(null); setEditingCategoryId(category.id); }}
          onCancelRename={() => setEditingCategoryId(null)}
          onSubmitRename={async (name) => {
            await actions.renameCategory(category.id, name);
            closeForms();
          }}
          onDeleteCategory={() => {
            confirmation.confirm({ title: '删除个人分类', actionLabel: '删除分类',
              message: `删除分类「${category.name}」会同时删除其中的网址，确定删除吗？`,
              onConfirm: () => actions.deleteCategory(category.id) });
          }}          onMoveCategory={(direction) => {
            void actions.moveCategory(category.id, direction);
          }}
          onStartContextualAdd={() => {
            void openQuickAdd(category.id);
          }}
          onStartCreateLink={() => {
            setMovingLinkId(null);
            // A new attempt replaces any previous inline feedback.
            setInlineAddSaved(null);
            setInlineAddErrorCategoryId(null);
            setCreatingLinkCategoryId(category.id);
          }}
          onCancelCreateLink={() => {
            setInlineAddErrorCategoryId(null);
            setCreatingLinkCategoryId(null);
          }}
          inlineAddSavedTitle={
            inlineAddStillPresent && inlineAddSaved !== null && inlineAddSaved.categoryId === category.id
              ? inlineAddSaved.title
              : null
          }

          inlineAddError={inlineAddErrorFor(category.id)}
          onSubmitCreateLink={async (input) => {
            const outcome = await actions.createLink({ categoryId: category.id, ...input });

            // Keep the form (and the user's input) on any failure so a duplicate
            // or invalid URL can be corrected instead of retyped.
            if (shouldCloseQuickAdd(outcome.status)) {
              // Confirm next to the category that gained the link. The parent derives
              // whether that exact row (category + title + url) is still present, so the
              // confirmation cannot outlive the link it describes — including when a
              // same-title sibling remains. The section-level Quick Add confirmation is
              // cleared so the two notices can never appear together.
              setSavedLinkTitle(null);
              setInlineAddSaved({ categoryId: category.id, title: input.title.trim(), url: input.url.trim() });
              setInlineAddErrorCategoryId(null);
              closeForms();
            } else {
              // Scope the container's message to this category so the failure is
              // visible where the user submitted it, including for a lower category.
              setInlineAddSaved(null);
              setInlineAddErrorCategoryId(category.id);
            }
          }}
          onStartEditLink={(linkId) => { setMovingLinkId(null); setEditingLinkId(linkId); }}
          onCancelEditLink={() => setEditingLinkId(null)}
          onSubmitEditLink={async (linkId, input) => {
            const outcome = await actions.updateLink(linkId, input);

            // Same rule for edit/move: a duplicate keeps the form open.
            if (shouldCloseQuickAdd(outcome.status)) {
              closeForms();
            }
          }}
          onDeleteLink={(link) => {
            confirmation.confirm({ title: '删除个人网址', actionLabel: '删除网址',
              message: `确定删除网址「${link.title}」吗？`, onConfirm: () => actions.deleteLink(link.id) });
          }}
          onMoveLink={(linkId, direction) => {
            void actions.moveLink(linkId, direction);
          }}
        />
      ))}
      </div>
    </section>
  );
}
