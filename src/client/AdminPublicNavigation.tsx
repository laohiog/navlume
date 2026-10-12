import { useState } from 'react';

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

/** One admin link row with visibility, move, edit and delete controls. */
function AdminLinkRow({
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
  return (
    <li className={link.isVisible ? 'admin-link' : 'admin-link admin-link--hidden'}>
      <div className="admin-link__main">
        <span className="admin-link__title">{link.title}</span>
        {/* Hidden rows are labelled so an admin can tell them apart at a glance. */}
        <span className="admin-link__badge">{link.isVisible ? '显示' : '隐藏'}</span>
        <span className="admin-link__url">{link.url}</span>
      </div>
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
        <button
          className="admin__button"
          type="button"
          disabled={isBusy}
          onClick={() => onToggleVisibility(!link.isVisible)}
        >
          {link.isVisible ? '隐藏' : '显示'}
        </button>
        <button className="admin__button" type="button" disabled={isBusy} onClick={isEditing ? onCancelEdit : onStartEdit}>
          {isEditing ? '取消编辑' : '编辑'}
        </button>
        <button className="admin__button admin__button--danger" type="button" disabled={isBusy} onClick={onDelete}>
          删除
        </button>
      </div>

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
        <h3 className="admin-category__title" id={headingId}>
          {category.name}
        </h3>
        <span className="admin-link__badge">{category.isVisible ? '显示' : '隐藏'}</span>
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
          新增网址
        </button>
      )}
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

  if (state.status === 'absent') {
    return null;
  }

  /** Reset inline form state; used after every successful mutation. */
  const closeForms = () => {
    setCreatingCategory(false);
    setEditingCategoryId(null);
    setCreatingLinkCategoryId(null);
    setEditingLinkId(null);
  };

  const header = (
    <div className="admin__header">
      <h2 className="admin__title" id="admin-title">
        管理公共导航
      </h2>
      {state.status === 'ready' && !creatingCategory ? (
        <button
          className="admin__button admin__button--primary"
          type="button"
          disabled={isMutating}
          onClick={() => setCreatingCategory(true)}
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
          key={category.id}
          category={category}
          index={index}
          total={categories.length}
          allCategories={categories}
          isBusy={isMutating}
          editingCategoryId={editingCategoryId}
          editingLinkId={editingLinkId}
          creatingLinkCategoryId={creatingLinkCategoryId}
          onStartRename={() => setEditingCategoryId(category.id)}
          onCancelRename={() => setEditingCategoryId(null)}
          onSubmitRename={async (input) => {
            if ((await actions.updateCategory(category.id, input)).status === 'ok') {
              closeForms();
            }
          }}
          onDeleteCategory={() => {
            if (window.confirm(`删除分类「${category.name}」会同时删除其中的网址，确定删除吗？`)) {
              void actions.deleteCategory(category.id);
            }
          }}
          onMoveCategory={(direction) => {
            void actions.moveCategory(category.id, direction);
          }}
          onToggleCategoryVisibility={(isVisible) => {
            void actions.toggleCategoryVisibility(category.id, isVisible);
          }}
          onStartCreateLink={() => setCreatingLinkCategoryId(category.id)}
          onCancelCreateLink={() => setCreatingLinkCategoryId(null)}
          onSubmitCreateLink={async (input) => {
            if ((await actions.createLink({ ...input, categoryId: category.id })).status === 'ok') {
              closeForms();
            }
          }}
          onStartEditLink={(linkId) => setEditingLinkId(linkId)}
          onCancelEditLink={() => setEditingLinkId(null)}
          onSubmitEditLink={async (linkId, input) => {
            if ((await actions.updateLink(linkId, input)).status === 'ok') {
              closeForms();
            }
          }}
          onDeleteLink={(link) => {
            if (window.confirm(`确定删除网址「${link.title}」吗？`)) {
              void actions.deleteLink(link.id);
            }
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
