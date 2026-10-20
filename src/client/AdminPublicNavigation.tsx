import { useEffect, useId, useRef, useState } from 'react';
import { ConfirmDialog } from './ModalDialog.js';
import { useConfirmation } from './use-confirmation.js';
import { LinkMove } from './LinkMove.js';
import type { LinkMoveControls, LinkMoveOutcome } from './link-reorder.js';

import type {
  AdminMutationOutcome,
  AdminPublicCategory,
  AdminPublicLink,
  AdminPublicNavigation,
} from './api/admin-public-navigation.js';

/**
 * Render state for the admin section.
 *
 * `absent` means "this visitor has no admin surface" — a guest, a normal user, or
 * an unresolved session. It is a distinct state from `error` so a non-admin is
 * never shown a failure message, and no admin markup is rendered for them at all.
 */
export type AdminPublicNavigationState =
  | { status: 'absent' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: AdminPublicNavigation };

/** Mutations the container implements; the view only triggers them. */
export interface AdminPublicNavigationActions {
  createCategory(input: { name: string; isVisible: boolean }): Promise<AdminMutationOutcome>;
  updateCategory(
    categoryId: number,
    input: { name: string; isVisible: boolean },
  ): Promise<AdminMutationOutcome>;
  deleteCategory(categoryId: number): Promise<AdminMutationOutcome>;
  moveCategory(categoryId: number, direction: -1 | 1): Promise<AdminMutationOutcome>;
  createLink(input: {
    categoryId: number;
    title: string;
    url: string;
    description: string;
    isVisible: boolean;
  }): Promise<AdminMutationOutcome>;
  updateLink(
    linkId: number,
    input: {
      title: string;
      url: string;
      description: string;
      isVisible: boolean;
      categoryId: number;
    },
  ): Promise<AdminMutationOutcome>;
  deleteLink(linkId: number): Promise<AdminMutationOutcome>;
  moveLink(linkId: number, direction: -1 | 1): Promise<AdminMutationOutcome>;
  moveLinkTo(linkId: number, position: number): Promise<LinkMoveOutcome>;
  toggleLinkVisibility(linkId: number, isVisible: boolean): Promise<AdminMutationOutcome>;
  toggleCategoryVisibility(
    categoryId: number,
    isVisible: boolean,
  ): Promise<AdminMutationOutcome>;
}

export interface AdminPublicNavigationViewProps {
  state: AdminPublicNavigationState;
  actions: AdminPublicNavigationActions;
  /** True while an admin mutation is in flight; disables mutation controls. */
  isMutating: boolean;
  /** Non-technical mutation failure text, if any. */
  errorMessage: string | null;
}

/** Inline category form, used for both create and edit. */
function CategoryForm({
  initialName,
  initialVisible,
  submitLabel,
  isBusy,
  onSubmit,
  onCancel,
}: {
  initialName: string;
  initialVisible: boolean;
  submitLabel: string;
  isBusy: boolean;
  onSubmit: (input: { name: string; isVisible: boolean }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [isVisible, setIsVisible] = useState(initialVisible);

  return (
    <form
      className="admin__form"
      onSubmit={(event) => {
        event.preventDefault();
        if (isBusy || name.trim().length === 0) {
          return;
        }
        void onSubmit({ name, isVisible });
      }}
    >
      <label className="admin__field">
        <span className="admin__label">分类名称</span>
        <input
          className="admin__input"
          type="text"
          name="adminCategoryName"
          value={name}
          disabled={isBusy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="admin__checkbox">
        <input
          type="checkbox"
          name="adminCategoryVisible"
          checked={isVisible}
          disabled={isBusy}
          onChange={(event) => setIsVisible(event.target.checked)}
        />
        <span>显示（取消勾选则隐藏）</span>
      </label>
      <div className="admin__form-actions">
        <button className="admin__button admin__button--primary" type="submit" disabled={isBusy}>
          {submitLabel}
        </button>
        <button className="admin__button" type="button" disabled={isBusy} onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

/** Inline link form, used for both create and edit (including category moves). */
function LinkForm({
  initialTitle,
  initialUrl,
  initialDescription,
  initialVisible,
  initialCategoryId,
  categories,
  submitLabel,
  isBusy,
  onSubmit,
  onCancel,
}: {
  initialTitle: string;
  initialUrl: string;
  initialDescription: string;
  initialVisible: boolean;
  initialCategoryId: number;
  categories: AdminPublicCategory[];
  submitLabel: string;
  isBusy: boolean;
  onSubmit: (input: {
    title: string;
    url: string;
    description: string;
    isVisible: boolean;
    categoryId: number;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [url, setUrl] = useState(initialUrl);
  const [description, setDescription] = useState(initialDescription);
  const [isVisible, setIsVisible] = useState(initialVisible);
  const [categoryId, setCategoryId] = useState(initialCategoryId);

  return (
    <form
      className="admin__form"
      onSubmit={(event) => {
        event.preventDefault();
        if (isBusy || title.trim().length === 0 || url.trim().length === 0) {
          return;
        }
        void onSubmit({ title, url, description, isVisible, categoryId });
      }}
    >
      <label className="admin__field">
        <span className="admin__label">名称</span>
        <input
          className="admin__input"
          type="text"
          name="adminLinkTitle"
          value={title}
          disabled={isBusy}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>

      <label className="admin__field">
        <span className="admin__label">网址</span>
        <input
          className="admin__input"
          type="text"
          name="adminLinkUrl"
          placeholder="example.com"
          value={url}
          disabled={isBusy}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>

      <label className="admin__field">
        <span className="admin__label">描述（可选）</span>
        <input
          className="admin__input"
          type="text"
          name="adminLinkDescription"
          value={description}
          disabled={isBusy}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>

      <label className="admin__field">
        <span className="admin__label">分类</span>
        <select
          className="admin__input"
          name="adminLinkCategory"
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

      <label className="admin__checkbox">
        <input
          type="checkbox"
          name="adminLinkVisible"
          checked={isVisible}
          disabled={isBusy}
          onChange={(event) => setIsVisible(event.target.checked)}
        />
        <span>显示（取消勾选则隐藏）</span>
      </label>

      <div className="admin__form-actions">
        <button className="admin__button admin__button--primary" type="submit" disabled={isBusy}>
          {submitLabel}
        </button>
        <button className="admin__button" type="button" disabled={isBusy} onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

/**
 * Which row's overflow panel is open, and how to open one.
 *
 * Mirrors `LinkMoveControls` (in `link-reorder.ts`) so the two disclosures in a
 * row behave identically and are managed the same way. `open(null)` closes.
 */
export interface RowMenuControls {
  activeId: number | null;
  open: (id: number | null) => void;
}

/** One admin link row with visibility, move, edit and delete controls. */
function AdminLinkRow({
  linkMove,
  rowMenu,
  link,
  index,
  total,
  allCategories,
  isBusy,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onDelete,
  onMove,
  onToggleVisibility,
}: {
  link: AdminPublicLink;
  linkMove: LinkMoveControls;
  /** Which overflow panel is open, and how to open one (T4.2). */
  rowMenu: RowMenuControls;
  index: number;
  total: number;
  allCategories: AdminPublicCategory[];
  isBusy: boolean;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (input: {
    title: string;
    url: string;
    description: string;
    isVisible: boolean;
    categoryId: number;
  }) => Promise<void>;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
  onToggleVisibility: (isVisible: boolean) => void;
}) {
  const menuId = useId();
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const menuOpen = rowMenu.activeId === link.id;
  // `rowMenu` is a fresh object on every render, so the Escape listener reads
  // the latest `open` through a ref instead of re-subscribing on each one.
  const openRowMenu = useRef(rowMenu.open);
  useEffect(() => { openRowMenu.current = rowMenu.open; });

  /*
   * Close the panel and hand focus back where it came from.
   *
   * This is the same close path `LinkMove` already uses in this very row —
   * `aria-expanded` / `aria-controls`, Escape, and a focus return that survives
   * the trigger being re-rendered. Reusing the project's own idiom rather than
   * reaching for a menu library is the point: the hard parts (focus restoration,
   * the trigger disappearing after a mutation) are already solved and already
   * covered by this page's behaviour.
   *
   * The `isConnected` check matters after a destructive action: the row may be
   * gone by the time the panel closes, and focusing a detached node silently
   * drops focus to `<body>`.
   */
  const closeMenu = () => {
    openRowMenu.current(null);
    requestAnimationFrame(() => {
      if (menuTrigger.current?.isConnected) {
        menuTrigger.current.focus({ preventScroll: true });
        menuTrigger.current.scrollIntoView({ block: 'nearest' });
      }
    });
  };

  /*
   * Escape closes the panel **wherever focus is**.
   *
   * The first version hung the handler on the panel element, which only fires
   * for key presses *inside* it. Measured: opening the panel with the mouse —
   * focus stays on the trigger, which is a sibling — and Escape then did
   * nothing at all. That is the common path, and it is exactly what AC5 asks
   * about. The escape scope is the panel's open state, not its DOM subtree, so
   * the listener lives on the document for as long as the panel is open.
   */
  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isBusy) {
        return;
      }
      /*
       * A native modal dialog outranks this panel (T4.2.1).
       *
       * The delete confirmations are native `<dialog>`s opened with
       * `showModal()`, and they close on Escape as the **default action** of
       * the keydown — through the dialog's own `cancel` event. With the panel
       * still open behind the dialog, this listener used to call
       * `preventDefault()` on that keydown: the default action never ran, the
       * dialog could not be closed with Escape at all, and the panel closed
       * underneath it. Measured on the real page before the fix: Escape left
       * `dialog.open === true` and dropped the panel.
       *
       * While any dialog is open this handler therefore yields completely —
       * no `preventDefault`, no state change, no focus move — so the dialog
       * keeps its own Escape path and its own focus return untouched. The
       * panel stays open behind it; when the dialog closes, the next Escape
       * closes the panel again, because this listener is subscribed exactly
       * as long as the panel is open.
       *
       * The check is the one `PersonalNavigation` and `useConfirmation`
       * already make: every `<dialog>` in this app is opened with
       * `showModal()`, so `dialog[open]` *is* "a native modal owns the
       * keyboard". No second keyboard framework, and `ModalDialog` itself is
       * unchanged.
       */
      if (document.querySelector('dialog[open]')) {
        return;
      }
      event.preventDefault();
      openRowMenu.current(null);
      requestAnimationFrame(() => {
        menuTrigger.current?.focus({ preventScroll: true });
      });
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); };
  }, [menuOpen, isBusy]);

  return (
    <li className={link.isVisible ? 'admin-link' : 'admin-link admin-link--hidden'}>
      <div className="admin-link__main">
        <span className="admin-link__title">{link.title}</span>
        {/*
          State badge only when the row is hidden.

          It used to render 「显示」 on every row, which on a 161-link site meant
          161 identical chips repeating the default. The chip carried information
          exactly when it contradicted the default: a dashed, muted row with no
          explanation is the thing an admin has to stop and work out. Silence for
          the normal case, a label for the case that needs one — and the dashed
          treatment already carries the rest.
        */}
        {!link.isVisible ? <span className="admin-link__badge">隐藏</span> : null}
        <span className="admin-link__url">{link.url}</span>
      </div>
      {/*
        Three controls stay put; three move into the panel.

        Reorder keeps a permanent place because it is what a launchpad is for and
        it is the operation an administrator repeats most — burying it behind a
        disclosure would trade the page's main job for tidiness. Edit stays for the
        same reason. Hide, move-to-position and delete are occasional, reversible
        or already guarded, so they belong one click away rather than in the face
        of every row: measured, the six permanent controls wrapped onto two lines
        on a 375px screen and made each row 168px tall.

        Delete losing its permanent seat is a safety gain, not a loss — it can no
        longer be hit by a stray tap, and its confirmation dialog is unchanged.
      */}
      <div className="admin-link__controls">
        <button
          className="admin__button admin__button--icon"
          type="button"
          aria-label={`上移 ${link.title}`}
          disabled={isBusy || index === 0}
          onClick={() => onMove(-1)}
        >
          ↑
        </button>
        <button
          className="admin__button admin__button--icon"
          type="button"
          aria-label={`下移 ${link.title}`}
          disabled={isBusy || index === total - 1}
          onClick={() => onMove(1)}
        >
          ↓
        </button>
        <button className="admin__button" type="button" disabled={isBusy} onClick={isEditing ? onCancelEdit : onStartEdit}>
          {isEditing ? '取消编辑' : '编辑'}
        </button>
        <button
          ref={menuTrigger}
          className="admin__button admin-link__more"
          type="button"
          aria-label={`更多操作：${link.title}`}
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          disabled={isBusy || isEditing}
          onClick={() => {
            if (menuOpen) closeMenu();
            else rowMenu.open(link.id);
          }}
        >
          更多
        </button>
      </div>

      {menuOpen ? (
        <div className="admin-row-menu" id={menuId}>
          <button
            className="admin__button"
            type="button"
            disabled={isBusy}
            onClick={() => { closeMenu(); onToggleVisibility(!link.isVisible); }}
          >
            {link.isVisible ? '隐藏此网址' : '显示此网址'}
          </button>
          <LinkMove id={link.id} title={link.title} index={index} total={total} isBusy={isBusy}
            isEditing={isEditing} scope="admin" controls={linkMove} />
          {/*
            Delete last inside the panel too, so the separation rule that
            `.admin__button--danger { margin-inline-start }` gives it applies here
            as well — the destructive action is never adjacent to a neutral one.
          */}
          <button className="admin__button admin__button--danger" type="button" disabled={isBusy} onClick={onDelete}>
            删除此网址
          </button>
        </div>
      ) : null}

      {isEditing ? (
        <LinkForm
          initialTitle={link.title}
          initialUrl={link.url}
          initialDescription={link.description ?? ''}
          initialVisible={link.isVisible}
          initialCategoryId={link.categoryId}
          categories={allCategories}
          submitLabel="保存"
          isBusy={isBusy}
          onSubmit={onSubmitEdit}
          onCancel={onCancelEdit}
        />
      ) : null}
    </li>
  );
}

/** One admin category with its controls and links. */
function AdminCategorySection({
  linkMove,
  rowMenu,
  category,
  index,
  total,
  allCategories,
  isBusy,
  editingCategoryId,
  editingLinkId,
  creatingLinkCategoryId,
  onStartRename,
  onCancelRename,
  onSubmitRename,
  onDeleteCategory,
  onMoveCategory,
  onToggleCategoryVisibility,
  onStartCreateLink,
  onCancelCreateLink,
  onSubmitCreateLink,
  onStartEditLink,
  onCancelEditLink,
  onSubmitEditLink,
  onDeleteLink,
  onMoveLink,
  onToggleLinkVisibility,
}: {
  category: AdminPublicCategory;
  linkMove: LinkMoveControls;
  rowMenu: RowMenuControls;
  index: number;
  total: number;
  allCategories: AdminPublicCategory[];
  isBusy: boolean;
  editingCategoryId: number | null;
  editingLinkId: number | null;
  creatingLinkCategoryId: number | null;
  onStartRename: () => void;
  onCancelRename: () => void;
  onSubmitRename: (input: { name: string; isVisible: boolean }) => Promise<void>;
  onDeleteCategory: () => void;
  onMoveCategory: (direction: -1 | 1) => void;
  onToggleCategoryVisibility: (isVisible: boolean) => void;
  onStartCreateLink: () => void;
  onCancelCreateLink: () => void;
  onSubmitCreateLink: (input: {
    title: string;
    url: string;
    description: string;
    isVisible: boolean;
    categoryId: number;
  }) => Promise<void>;
  onStartEditLink: (linkId: number) => void;
  onCancelEditLink: () => void;
  onSubmitEditLink: (
    linkId: number,
    input: {
      title: string;
      url: string;
      description: string;
      isVisible: boolean;
      categoryId: number;
    },
  ) => Promise<void>;
  onDeleteLink: (link: AdminPublicLink) => void;
  onMoveLink: (linkId: number, direction: -1 | 1) => void;
  onToggleLinkVisibility: (linkId: number, isVisible: boolean) => void;
}) {
  const headingId = `admin-category-${String(category.id)}`;

  return (
    <section
      className={category.isVisible ? 'admin-category' : 'admin-category admin-category--hidden'}
      aria-labelledby={headingId}
    >
      <div className="admin-category__header">
        {/*
          The band is the answer to "where does this category start".

          Before, the header was a row of the same kind as every link row: same
          weight, same alignment, same hairline under it. Inside a 120-entry
          category there was nothing to tell a reader they had reached the end and
          a new one had begun. A tone step plus a size step makes the header
          recognisable from across the list without reading it, which is the one
          thing this page has to do.
        */}
        <div className="admin-category__identity">
          <h3 className="admin-category__title" id={headingId} tabIndex={-1}>
            {category.name}
          </h3>
          {/*
            The count answers AC2 before scrolling: without it, the size of a
            category is only knowable by counting rows.
          */}
          <span className="admin-category__count">{category.links.length} 个网址</span>
        </div>
        {/* Same rule as the rows: a badge only when it contradicts the default. */}
        {!category.isVisible ? <span className="admin-link__badge">隐藏</span> : null}
        <div className="admin-category__controls">
          <button
            className="admin__button admin__button--icon"
            type="button"
            aria-label={`上移分类 ${category.name}`}
            disabled={isBusy || index === 0}
            onClick={() => onMoveCategory(-1)}
          >
            ↑
          </button>
          <button
            className="admin__button admin__button--icon"
            type="button"
            aria-label={`下移分类 ${category.name}`}
            disabled={isBusy || index === total - 1}
            onClick={() => onMoveCategory(1)}
          >
            ↓
          </button>
          <button
            className="admin__button"
            type="button"
            disabled={isBusy}
            onClick={() => onToggleCategoryVisibility(!category.isVisible)}
          >
            {category.isVisible ? '隐藏' : '显示'}
          </button>
          <button
            className="admin__button"
            type="button"
            disabled={isBusy}
            onClick={editingCategoryId === category.id ? onCancelRename : onStartRename}
          >
            {editingCategoryId === category.id ? '取消编辑' : '编辑'}
          </button>
          <button className="admin__button admin__button--danger" type="button" disabled={isBusy} onClick={onDeleteCategory}>
            删除
          </button>
        </div>
      </div>

      {editingCategoryId === category.id ? (
        <CategoryForm
          initialName={category.name}
          initialVisible={category.isVisible}
          submitLabel="保存"
          isBusy={isBusy}
          onSubmit={onSubmitRename}
          onCancel={onCancelRename}
        />
      ) : null}

      {category.links.length === 0 ? (
        <p className="admin-category__empty">此分类暂无网址</p>
      ) : (
        <ul className="admin-link-list">
          {category.links.map((link, linkIndex) => (
            <AdminLinkRow
              linkMove={linkMove}
              rowMenu={rowMenu}
              key={link.id}
              link={link}
              index={linkIndex}
              total={category.links.length}
              allCategories={allCategories}
              isBusy={isBusy}
              isEditing={editingLinkId === link.id}
              onStartEdit={() => onStartEditLink(link.id)}
              onCancelEdit={onCancelEditLink}
              onSubmitEdit={(input) => onSubmitEditLink(link.id, input)}
              onDelete={() => onDeleteLink(link)}
              onMove={(direction) => onMoveLink(link.id, direction)}
              onToggleVisibility={(isVisible) => onToggleLinkVisibility(link.id, isVisible)}
            />
          ))}
        </ul>
      )}

      {/*
        The list terminates here, deliberately.

        「新增网址」 used to sit inside the list area with the same left alignment
        as every entry above it, so the eye read it as another item — and with
        nothing between it and the last entry, a 120-link category had no visible
        bottom. The strip under the last rule is where a category's own action
        goes, and it is also what makes the drawer recognisably closed.
      */}
      <div className="admin-category__footer">
        {creatingLinkCategoryId === category.id ? (
          <LinkForm
            initialTitle=""
            initialUrl=""
            initialDescription=""
            initialVisible
            initialCategoryId={category.id}
            categories={allCategories}
            submitLabel="保存"
            isBusy={isBusy}
            onSubmit={onSubmitCreateLink}
            onCancel={onCancelCreateLink}
          />
        ) : (
          <button className="admin__button admin__button--add" type="button" disabled={isBusy} onClick={onStartCreateLink}>
            ＋ 新增网址
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * Admin management of Public Navigation.
 *
 * Presentational apart from inline form state: it performs no fetching and no
 * session calls, so it renders in a test environment. The container owns data
 * loading, authorization state, mutation dispatch, and refetching.
 *
 * It renders nothing at all in the `absent` state, so a guest or normal user
 * never receives admin markup. That is a render decision, not a security
 * boundary — every admin API call is authorized on the server.
 */
export function AdminPublicNavigationView({
  state,
  actions,
  isMutating,
  errorMessage,
}: AdminPublicNavigationViewProps) {
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null);
  const [creatingLinkCategoryId, setCreatingLinkCategoryId] = useState<number | null>(null);
  const [editingLinkId, setEditingLinkId] = useState<number | null>(null);
  const [movingLinkId, setMovingLinkId] = useState<number | null>(null);
  /*
   * Which row's overflow panel is open (T4.2).
   *
   * Lifted to the view rather than kept inside each row for the same reason
   * `movingLinkId` lives here: one at a time. Two menus open on a 161-row page is
   * untidy, and — more importantly — a row that disappears under an open panel
   * (it was just deleted, or moved) must not leave an orphaned trigger holding
   * focus. One piece of state also means `closeForms()` after a mutation can
   * clear it in the same place as everything else.
   */
  const [rowMenuId, setRowMenuId] = useState<number | null>(null);
  const confirmation = useConfirmation();

  if (state.status === 'absent') {
    return null;
  }

  /**
   * Close every inline panel except the row's overflow panel.
   *
   * Split out because the move form now lives *inside* that panel (T4.2), so
   * opening it must not take the panel away with it — the first version did
   * exactly that and the move form became unreachable.
   */
  const closeFormsExceptRowMenu = () => {
    setMovingLinkId(null);
    setCreatingCategory(false);
    setEditingCategoryId(null);
    setCreatingLinkCategoryId(null);
    setEditingLinkId(null);
  };

  /** Reset inline form state; used after every successful mutation. */
  const closeForms = () => {
    setRowMenuId(null);
    closeFormsExceptRowMenu();
  };

  const header = (
    <div className="admin__header">
      <h2 className="admin__title" id="admin-title" tabIndex={-1}>
        管理公共导航
      </h2>
      {state.status === 'ready' && !creatingCategory ? (
        <button
          className="admin__button admin__button--primary"
          type="button"
          disabled={isMutating}
          onClick={() => { setMovingLinkId(null); setCreatingCategory(true); }}
        >
          新建分类
        </button>
      ) : null}
    </div>
  );

  if (state.status === 'loading') {
    return (
      <section className="admin" aria-labelledby="admin-title">
        {header}
        <p className="status" role="status">
          正在加载公共导航管理…
        </p>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section className="admin" aria-labelledby="admin-title">
        {header}
        <p className="status status--error" role="alert">
          公共导航管理暂时无法加载，请稍后重试。
        </p>
      </section>
    );
  }

  const { categories } = state.data;

  return (
    <section className="admin" aria-labelledby="admin-title">
      {header}

      <ConfirmDialog request={confirmation.request} onDismiss={confirmation.dismiss} />
      {errorMessage !== null && errorMessage.length > 0 ? (
        <p className="admin__error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      {creatingCategory ? (
        <CategoryForm
          initialName=""
          initialVisible
          submitLabel="保存"
          isBusy={isMutating}
          onSubmit={async (input) => {
            // Keep the form open on failure so the input can be corrected.
            if ((await actions.createCategory(input)).status === 'ok') {
              closeForms();
            }
          }}
          onCancel={() => setCreatingCategory(false)}
        />
      ) : null}

      {categories.length === 0 ? (
        <p className="status">暂无公共导航内容</p>
      ) : null}

      {categories.map((category, index) => (
        <AdminCategorySection
          linkMove={{
            activeId: movingLinkId,
            /*
             * Two different intents behind one callback, because `LinkMove` uses
             * it for both opening and closing:
             *
             *  - `id !== null` → open the form, which renders *inside* the row's
             *    overflow panel, so the panel must stay.
             *  - `id === null` → the move finished or was cancelled; the whole
             *    interaction is over, so the panel closes too. Leaving it open
             *    meant that the next click on 更多 silently *closed* it instead
             *    of opening it — the panel looked broken rather than merely stale.
             */
            open: (id) => {
              if (id === null) {
                closeForms();
                return;
              }
              closeFormsExceptRowMenu();
              setMovingLinkId(id);
            },
            submit: actions.moveLinkTo,
          }}
          rowMenu={{ activeId: rowMenuId, open: (id) => { closeForms(); setRowMenuId(id); } }}

          key={category.id}
          category={category}
          index={index}
          total={categories.length}
          allCategories={categories}
          isBusy={isMutating}
          editingCategoryId={editingCategoryId}
          editingLinkId={editingLinkId}
          creatingLinkCategoryId={creatingLinkCategoryId}
          onStartRename={() => { setMovingLinkId(null); setEditingCategoryId(category.id); }}
          onCancelRename={() => setEditingCategoryId(null)}
          onSubmitRename={async (input) => {
            if ((await actions.updateCategory(category.id, input)).status === 'ok') {
              closeForms();
            }
          }}
          onDeleteCategory={() => {
            confirmation.confirm({ title: '删除公共分类', actionLabel: '删除分类',
              message: `删除分类「${category.name}」会同时删除其中的网址，确定删除吗？`,
              onConfirm: () => actions.deleteCategory(category.id) });
          }}
          onMoveCategory={(direction) => {
            void actions.moveCategory(category.id, direction);
          }}
          onToggleCategoryVisibility={(isVisible) => {
            void actions.toggleCategoryVisibility(category.id, isVisible);
          }}
          onStartCreateLink={() => { setMovingLinkId(null); setCreatingLinkCategoryId(category.id); }}
          onCancelCreateLink={() => setCreatingLinkCategoryId(null)}
          onSubmitCreateLink={async (input) => {
            if ((await actions.createLink({ ...input, categoryId: category.id })).status === 'ok') {
              closeForms();
            }
          }}
          onStartEditLink={(linkId) => { setMovingLinkId(null); setEditingLinkId(linkId); }}
          onCancelEditLink={() => setEditingLinkId(null)}
          onSubmitEditLink={async (linkId, input) => {
            if ((await actions.updateLink(linkId, input)).status === 'ok') {
              closeForms();
            }
          }}
          onDeleteLink={(link) => {
            confirmation.confirm({ title: '删除公共网址', actionLabel: '删除网址',
              message: `确定删除网址「${link.title}」吗？`, onConfirm: () => actions.deleteLink(link.id) });
          }}
          onMoveLink={(linkId, direction) => {
            void actions.moveLink(linkId, direction);
          }}
          onToggleLinkVisibility={(linkId, isVisible) => {
            void actions.toggleLinkVisibility(linkId, isVisible);
          }}
        />
      ))}
    </section>
  );
}
