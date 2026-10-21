import { useState } from 'react';
import { ConfirmDialog } from './ModalDialog.js';
import { useConfirmation } from './use-confirmation.js';

import { ADMIN_USERS_PAGE_SIZE, type AdminUser, type AdminUserMutationOutcome } from './api/admin-users.js';

/**
 * Render state for the admin user-management section.
 *
 * `absent` means "no admin surface here" — guest, ordinary user, or unresolved
 * session. Distinct from `error` so a non-admin never sees a failure message, and
 * no admin markup is rendered for them.
 */
export type AdminUsersState =
  | { status: 'absent' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; users: AdminUser[] };

/** Mutations the container implements; the view only triggers them. */
export interface AdminUsersActions {
  createUser(input: {
    username: string;
    name: string;
    email: string;
    password: string;
  }): Promise<AdminUserMutationOutcome>;
  disableUser(userId: string): Promise<AdminUserMutationOutcome>;
  enableUser(userId: string): Promise<AdminUserMutationOutcome>;
  resetPassword(userId: string, newPassword: string): Promise<AdminUserMutationOutcome>;
  deleteUser(userId: string): Promise<AdminUserMutationOutcome>;
}

export interface AdminUsersViewProps {
  state: AdminUsersState;
  actions: AdminUsersActions;
  /** True while any account operation is in flight. */
  isMutating: boolean;
  /** Non-technical failure text, if any. */
  errorMessage: string | null;
  /**
   * The currently authenticated admin's id, used only to hide destructive actions
   * on their own row. Better Auth rejects self-ban and self-delete server-side, so
   * this is convenience, not enforcement.
   */
  currentUserId: string | null;
  pagination: { page: number; total: number | null; onPageChange(page: number): void };
}

/** Inline create-user form. Role is intentionally not selectable. */
function CreateUserForm({
  isBusy,
  onSubmit,
  onCancel,
}: {
  isBusy: boolean;
  onSubmit: (input: {
    username: string;
    name: string;
    email: string;
    password: string;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const canSubmit =
    username.trim().length > 0 &&
    name.trim().length > 0 &&
    email.trim().length > 0 &&
    password.length > 0;

  return (
    <form
      className="users__form"
      onSubmit={(event) => {
        event.preventDefault();
        if (isBusy || !canSubmit) {
          return;
        }
        void onSubmit({ username, name, email, password });
      }}
    >
      <label className="users__field">
        <span className="users__label">用户名</span>
        <input
          className="users__input"
          type="text"
          name="newUsername"
          autoComplete="off"
          value={username}
          disabled={isBusy}
          onChange={(event) => setUsername(event.target.value)}
        />
      </label>

      <label className="users__field">
        <span className="users__label">显示名称</span>
        <input
          className="users__input"
          type="text"
          name="newName"
          autoComplete="off"
          value={name}
          disabled={isBusy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <label className="users__field">
        <span className="users__label">邮箱</span>
        <input
          className="users__input"
          type="email"
          name="newEmail"
          autoComplete="off"
          value={email}
          disabled={isBusy}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>

      <label className="users__field">
        <span className="users__label">初始密码</span>
        <input
          className="users__input"
          type="password"
          name="newPassword"
          autoComplete="new-password"
          value={password}
          disabled={isBusy}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>

      <div className="users__form-actions">
        <button className="users__button users__button--primary" type="submit" disabled={isBusy || !canSubmit}>
          保存
        </button>
        <button className="users__button" type="button" disabled={isBusy} onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

/** Inline reset-password form. The new password is never echoed back. */
function ResetPasswordForm({
  username,
  isBusy,
  onSubmit,
  onCancel,
}: {
  username: string;
  isBusy: boolean;
  onSubmit: (newPassword: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [newPassword, setNewPassword] = useState('');

  return (
    <form
      className="users__form"
      onSubmit={(event) => {
        event.preventDefault();
        if (isBusy || newPassword.length === 0) {
          return;
        }
        void onSubmit(newPassword);
      }}
    >
      <p className="users__hint">为「{username}」设置新密码</p>
      <label className="users__field">
        <span className="users__label">新密码</span>
        <input
          className="users__input"
          type="password"
          name="resetPassword"
          autoComplete="new-password"
          value={newPassword}
          disabled={isBusy}
          onChange={(event) => setNewPassword(event.target.value)}
        />
      </label>
      <div className="users__form-actions">
        <button className="users__button users__button--primary" type="submit" disabled={isBusy || newPassword.length === 0}>
          保存
        </button>
        <button className="users__button" type="button" disabled={isBusy} onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

/** One account row with its available actions. */
function UserRow({
  user,
  isSelf,
  isBusy,
  isResetting,
  onStartReset,
  onCancelReset,
  onSubmitReset,
  onDisable,
  onEnable,
  onDelete,
}: {
  user: AdminUser;
  isSelf: boolean;
  isBusy: boolean;
  isResetting: boolean;
  onStartReset: () => void;
  onCancelReset: () => void;
  onSubmitReset: (newPassword: string) => Promise<void>;
  onDisable: () => void;
  onEnable: () => void;
  onDelete: () => void;
}) {
  const displayName = user.username ?? user.name;

  return (
    <li className={user.banned ? 'user-row user-row--disabled' : 'user-row'}>
      <div className="user-row__main">
        <div className="user-row__identity">
          <span className="user-row__name">{displayName}</span>
          <span className="user-row__meta">{user.name}</span>
          <span className="user-row__meta">{user.email}</span>
        </div>
        <div className="user-row__status">
          <span className="user-row__badge">{user.role === 'admin' ? '管理员' : '普通用户'}</span>
          {/* Disabled state is explicit, not just a CSS dimming. */}
          <span className={user.banned ? 'user-row__state user-row__state--disabled' : 'user-row__state'}>
            {user.banned ? '已停用' : '已启用'}
          </span>
          {isSelf ? <span className="user-row__badge">当前账号</span> : null}
        </div>
      </div>

      <div className="user-row__controls">
        {/*
          Every action names its target. These controls repeat per row, so the
          visible text alone gives a screen reader four identical "删除" buttons
          with no way to tell which user each one deletes (audit F3). The visible
          label stays as-is; the accessible name carries the row's own user.
        */}
        {user.banned ? (
          <button
            className="users__button"
            type="button"
            disabled={isBusy}
            aria-label={`启用 ${displayName}`}
            onClick={onEnable}
          >
            启用
          </button>
        ) : (
          // Self-disable is not offered; Better Auth also rejects it server-side.
          !isSelf && (
            <button
              className="users__button"
              type="button"
              disabled={isBusy}
              aria-label={`停用 ${displayName}`}
              onClick={onDisable}
            >
              停用
            </button>
          )
        )}
        <button
          className="users__button"
          type="button"
          disabled={isBusy}
          aria-label={`${isResetting ? '取消重置' : '重置密码'} ${displayName}`}
          onClick={isResetting ? onCancelReset : onStartReset}
        >
          {isResetting ? '取消重置' : '重置密码'}
        </button>
        {/* Self-delete is not offered; Better Auth also rejects it server-side. */}
        {!isSelf && (
          <button
            className="users__button users__button--danger"
            type="button"
            disabled={isBusy}
            aria-label={`删除 ${displayName}`}
            onClick={onDelete}
          >
            删除
          </button>
        )}
      </div>

      {isResetting ? (
        <ResetPasswordForm
          username={displayName}
          isBusy={isBusy}
          onSubmit={onSubmitReset}
          onCancel={onCancelReset}
        />
      ) : null}
    </li>
  );
}

/**
 * Admin user management.
 *
 * Presentational apart from inline form state: no fetching, no session calls. The
 * container owns loading, authorization state, dispatch, and refetching.
 *
 * Renders nothing in the `absent` state, so guest and ordinary-user sessions
 * receive no user-management markup. That is a render decision, not a security
 * boundary — every operation is authorized by Better Auth on the server.
 */
export function AdminUsersView({
  state,
  actions,
  isMutating,
  errorMessage,
  currentUserId,
  pagination,
}: AdminUsersViewProps) {
  const [creating, setCreating] = useState(false);
  const [resettingUserId, setResettingUserId] = useState<string | null>(null);
  const confirmation = useConfirmation();

  if (state.status === 'absent') {
    return null;
  }

  const closeForms = () => {
    setCreating(false);
    setResettingUserId(null);
  };

  const header = (
    <div className="users__header">
      <h2 className="users__title" id="users-title">
        用户管理
      </h2>
      {state.status === 'ready' && !creating ? (
        <button
          className="users__button users__button--primary"
          type="button"
          disabled={isMutating}
          onClick={() => setCreating(true)}
        >
          ＋ 创建用户
        </button>
      ) : null}
    </div>
  );

  const pageCount = pagination.total === null ? null : Math.max(1, Math.ceil(pagination.total / ADMIN_USERS_PAGE_SIZE));
  const pager = (
    <nav className="users__pagination" aria-label="用户列表分页">
      <button className="users__button" type="button"
        disabled={isMutating || pagination.page === 0}
        onClick={() => pagination.onPageChange(pagination.page - 1)}>上一页</button>
      <span aria-live="polite">第 {pagination.page + 1} / {pageCount ?? '…'} 页 · 共 {pagination.total ?? '…'} 个用户</span>
      <button className="users__button" type="button"
        disabled={isMutating || pageCount === null || pagination.page + 1 >= pageCount}
        onClick={() => pagination.onPageChange(pagination.page + 1)}>下一页</button>
    </nav>
  );

  if (state.status === 'loading') {
    return (
      <section className="users" aria-labelledby="users-title">
        {header}
        <p className="status" role="status">
          正在加载用户列表…
        </p>
        {pager}
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section className="users" aria-labelledby="users-title">
        {header}
        <p className="status status--error" role="alert">
          用户列表暂时无法加载，请稍后重试。
        </p>
        {pager}
      </section>
    );
  }

  return (
    <section className="users" aria-labelledby="users-title">
      {header}

      <ConfirmDialog request={confirmation.request} onDismiss={confirmation.dismiss} />
      {errorMessage !== null && errorMessage.length > 0 ? (
        <p className="users__error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      {creating ? (
        <CreateUserForm
          isBusy={isMutating}
          onSubmit={async (input) => {
            // Keep the form (and the typed password) only on failure, so the
            // admin can correct the input; never persist it after success.
            if ((await actions.createUser(input)).status === 'ok') {
              closeForms();
            }
          }}
          onCancel={() => setCreating(false)}
        />
      ) : null}

      {state.users.length === 0 ? (
        <p className="status">暂无用户</p>
      ) : (
        <ul className="users__list">
          {state.users.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              isSelf={currentUserId !== null && user.id === currentUserId}
              isBusy={isMutating}
              isResetting={resettingUserId === user.id}
              onStartReset={() => setResettingUserId(user.id)}
              onCancelReset={() => setResettingUserId(null)}
              onSubmitReset={async (newPassword) => {
                if ((await actions.resetPassword(user.id, newPassword)).status === 'ok') {
                  closeForms();
                }
              }}
              onDisable={() => {
                void actions.disableUser(user.id);
              }}
              onEnable={() => {
                void actions.enableUser(user.id);
              }}
              onDelete={() => {
                // Deletion is irreversible: require explicit confirmation naming
                // the account.
                const label = user.username ?? user.name;
                confirmation.confirm({ title: '删除用户', actionLabel: '删除用户',
                  message: `确定删除用户「${label}」（${user.email}）吗？此操作不可恢复。`,
                  onConfirm: () => actions.deleteUser(user.id) });
              }}
            />
          ))}
        </ul>
      )}
      {pager}
    </section>
  );
}
