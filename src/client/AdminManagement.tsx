import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { PublicBranding } from './api/admin-branding.js';

/** The four existing management areas, displayed one at a time. */
export type AdminModule = 'public-navigation' | 'branding' | 'users' | 'data';

/** Static navigation metadata: labels are presentation, so they live with the view. */
const MODULES: { id: AdminModule; label: string }[] = [
  { id: 'public-navigation', label: '公共导航' },
  { id: 'branding', label: '品牌设置' },
  { id: 'users', label: '用户管理' },
  { id: 'data', label: '数据管理' },
];

export interface AdminManagementViewProps {
  /** Navigate back to the navigation Home (session and data are preserved). */
  onBackToHome: () => void;
  /** The ready-made public-navigation management view. */
  publicNavigation: ReactNode;
  /** The ready-made branding management view. */
  branding: ReactNode;
  /** The ready-made user-management view. */
  users: ReactNode;
  /** Independent personal and site data panels, prepared by App. */
  data: ReactNode;
  /**
   * Site identity for the desktop sidebar.
   *
   * The admin page hides the shared header at sidebar widths, so the shell has to
   * carry the same identity itself — otherwise the site name would disappear from
   * the page (and the only `h1` with it).
   */
  siteBranding: PublicBranding;
  /** Signed-in administrator, shown in the sidebar's account block. */
  username: string;
  /** Ends the session. Owned by App; the shell only renders the control. */
  onLogout: () => void;
  /**
   * Module selected on first render. Production always uses the default
   * (公共导航); the prop exists so tests can render each module's initial state.
   */
  initialModule?: AdminModule;
  /**
   * Consulted before anything discards the visible module.
   *
   * Only the branding module has unsaved local state, so this is registered by
   * it and cleared when it unmounts. It resolves `false` when the administrator
   * chooses to stay, which leaves both the selection and the module's own state
   * untouched. `beforeunload` cannot cover these transitions: no page unload
   * happens when the navigation changes, and the draft lives in the module's
   * `useState`, not anywhere durable.
   */
  confirmLeave?: () => Promise<boolean>;
}

/**
 * Presentational Admin Management page.
 *
 * Owns only which management module is currently displayed — exactly one at a
 * time. All business state stays in `App`; each module receives its fully
 * prepared view, so switching never refetches or mutates anything.
 *
 * The shell is one navigation rendered twice by CSS, not two navigations: below
 * the shell breakpoint it is the top tab row under the shared header, above it
 * it becomes the 196px sidebar (brand, account and logout included, because the
 * shared header is hidden there). Keeping a single `<nav>` is what guarantees
 * there is never a second set of module buttons or a second logout entry.
 */
export function AdminManagementView({
  onBackToHome,
  publicNavigation,
  branding,
  users,
  data,
  siteBranding,
  username,
  onLogout,
  initialModule = 'public-navigation',
  confirmLeave,
}: AdminManagementViewProps) {
  const [selected, setSelected] = useState<AdminModule>(initialModule);

  const moduleViews: Record<AdminModule, ReactNode> = {
    'public-navigation': publicNavigation,
    branding,
    users,
    data,
  };

  const currentModule = MODULES.find((module) => module.id === selected) ?? MODULES[0];

  // Mirrored into a ref after commit so the click handlers always read the
  // module that is actually mounted, without re-rendering the navigation.
  const confirmLeaveRef = useRef(confirmLeave);
  useEffect(() => {
    confirmLeaveRef.current = confirmLeave;
  }, [confirmLeave]);

  /**
   * Run `leave` only if nothing is at risk, otherwise let the module ask first.
   *
   * Guarded against re-entry: the prompt is asynchronous, so a second click while
   * it is open would otherwise open a second dialog (which the dialog helper
   * silently ignores, leaving the first click's answer ambiguous).
   */
  const leaveRef = useRef(false);
  const guardedLeave = async (leave: () => void) => {
    if (leaveRef.current) return;
    leaveRef.current = true;
    try {
      const guard = confirmLeaveRef.current;
      if (guard === undefined || await guard()) {
        leave();
      }
    } finally {
      leaveRef.current = false;
    }
  };

  return (
    <section className="admin-management" aria-label="管理后台">
      <div className="admin-shell">
        <div className="admin-shell__aside">
          <div className="admin-shell__brand">
            {siteBranding.logoPath !== null ? (
              <img
                className="admin-shell__brand-logo"
                src={siteBranding.logoPath}
                alt=""
                width={24}
                height={24}
              />
            ) : null}
            {/* The shared header (and its h1) is hidden at sidebar widths, so the
                shell carries the site identity itself — exactly one h1 either way. */}
            <h1 className="admin-shell__brand-name">{siteBranding.siteName}</h1>
          </div>
          <nav className="admin-shell__nav" aria-label="管理模块">
            {MODULES.map((module) => (
              <button
                key={module.id}
                type="button"
                className="admin-shell__navitem"
                aria-current={selected === module.id ? 'page' : undefined}
                onClick={() => {
                  // Re-selecting the visible module discards nothing, so it must not
                  // raise a prompt the administrator did not ask for.
                  if (module.id === selected) {
                    return;
                  }
                  void guardedLeave(() => { setSelected(module.id); });
                }}
              >
                {module.label}
              </button>
            ))}
          </nav>
          <div className="admin-shell__account">
            <div className="admin-shell__identity">
              <span className="admin-shell__user">{username}</span>
              <span className="admin-shell__role">管理员</span>
            </div>
            <button className="admin-shell__logout" type="button" onClick={onLogout}>
              退出登录
            </button>
          </div>
        </div>
        <div className="admin-shell__main">
          <div className="admin-management__toolbar">
            <button className="admin-management__back" type="button" onClick={() => {
              void guardedLeave(onBackToHome);
            }}>
              返回导航
            </button>
            {/* Current module name: the tab row is below the fold on long pages,
                and at desktop the sidebar highlight is far from the content. */}
            <h2 className="admin-management__title">{currentModule.label}</h2>
          </div>
          {/* Only the selected module is rendered; the others stay unmounted. */}
          <div className="admin-management__module">{moduleViews[selected]}</div>
        </div>
      </div>
    </section>
  );
}
