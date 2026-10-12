import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  AdminManagementView,
  type AdminModule,
} from '../../src/client/AdminManagement.js';

/** Marker views so each test can see exactly which module is mounted. */
const MODULE_VIEWS = {
  publicNavigation: <span id="module-public-navigation">公共导航视图</span>,
  branding: <span id="module-branding">品牌视图</span>,
  users: <span id="module-users">用户视图</span>,
  data: <span id="module-data">数据视图</span>,
} as const;

const ALL_MODULE_IDS = [
  'module-public-navigation',
  'module-branding',
  'module-users',
  'module-data',
] as const;

function html(initialModule?: AdminModule): string {
  return renderToStaticMarkup(
    <AdminManagementView
      onBackToHome={vi.fn()}
      publicNavigation={MODULE_VIEWS.publicNavigation}
      branding={MODULE_VIEWS.branding}
      users={MODULE_VIEWS.users}
      data={MODULE_VIEWS.data}
      {...(initialModule === undefined ? {} : { initialModule })}
    />,
  );
}

describe('AdminManagementView', () => {
  it('renders the back control and one tab per management module', () => {
    const markup = html();

    expect(markup).toContain('返回导航');
    expect(markup).toContain('公共导航');
    expect(markup).toContain('品牌设置');
    expect(markup).toContain('用户管理');
    expect(markup).toContain('数据管理');
  });

  it('defaults to the public-navigation module (UX-IA AC4 default)', () => {
    const markup = html();

    expect(markup).toContain('module-public-navigation');
    expect(markup).not.toContain('module-branding');
    expect(markup).not.toContain('module-users');
    expect(markup).not.toContain('module-data');
  });

  it.each<AdminModule>(['branding', 'users', 'data'])(
    'renders only the selected module when %s is active',
    (selected) => {
      const markup = html(selected);

      // Exactly one of the four module markers is present.
      const present = ALL_MODULE_IDS.filter((id) => markup.includes(id));
      expect(present).toEqual([`module-${selected}`]);
    },
  );

  it('marks exactly one tab as current', () => {
    const markup = html('users');

    expect(markup).toContain('aria-current="true"');
    expect(markup.split('aria-current="true"').length - 1).toBe(1);
  });

  it('renders the management page inside a labelled section', () => {
    const markup = html();

    expect(markup).toContain('aria-label="管理后台"');
    expect(markup).toContain('aria-label="管理模块"');
  });
});
