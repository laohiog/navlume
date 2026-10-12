import { useState, type ReactNode } from 'react';

/** The four existing management areas, displayed one at a time. */
export type AdminModule = 'public-navigation' | 'branding' | 'users' | 'data';

/** Static tab metadata: labels are presentation, so they live with the view. */
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
   * Module selected on first render. Production always uses the default
   * (公共导航); the prop exists so tests can render each module's initial state.
   */
  initialModule?: AdminModule;
}

/**
 * Presentational Admin Management page.
 *
 * Owns only which management module is currently displayed — exactly one at a
 * time, behind a minimal button tab row. All business state stays in `App`; each
 * module receives its fully prepared view, so switching tabs never refetches or
 * mutates anything. There is deliberately no sidebar and no dashboard shell: the
 * tabs are plain buttons (keyboard-activatable natively) that wrap on narrow
 * viewports instead of scrolling horizontally.
 */
export function AdminManagementView({
  onBackToHome,
  publicNavigation,
  branding,
  users,
  data,
  initialModule = 'public-navigation',
}: AdminManagementViewProps) {
  const [selected, setSelected] = useState<AdminModule>(initialModule);

  const moduleViews: Record<AdminModule, ReactNode> = {
    'public-navigation': publicNavigation,
    branding: branding,
    users: users,
    data: data,
  };

  return (
    <section className="admin-management" aria-label="管理后台">
      <div className="admin-management__toolbar">
        <button className="admin-management__back" type="button" onClick={onBackToHome}>
          返回导航
        </button>
        <h2 className="admin-management__title">管理后台</h2>
      </div>
      <nav className="admin-tabs" aria-label="管理模块">
        {MODULES.map((module) => (
          <button
            key={module.id}
            type="button"
            className="admin-tabs__tab"
            aria-current={selected === module.id ? 'true' : undefined}
            onClick={() => setSelected(module.id)}
          >
            {module.label}
          </button>
        ))}
      </nav>
      {/* Only the selected module is rendered; the others stay unmounted. */}
      <div className="admin-management__module">{moduleViews[selected]}</div>
    </section>
  );
}
