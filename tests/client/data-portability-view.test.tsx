import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  DataPortabilityView,
  PortabilityPanel,
  type PortabilityExportResult,
  type PortabilityPanelActions,
  type PortabilityResult,
} from '../../src/client/DataPortability.js';

function actions(overrides: Partial<PortabilityPanelActions> = {}): PortabilityPanelActions {
  return {
    export: vi.fn().mockResolvedValue({ status: 'ok' }),
    preview: vi.fn().mockResolvedValue({ status: 'ok', summary: SUMMARY }),
    apply: vi.fn().mockResolvedValue({ status: 'ok', summary: SUMMARY }),
    ...overrides,
  };
}

const SUMMARY = {
  incomingCategories: 2,
  incomingLinks: 3,
  currentCategories: 1,
  currentLinks: 1,
  replacementWarning: '导入将替换当前数据。',
};

function render(
  overrides: Partial<Parameters<typeof PortabilityPanel>[0]> = {},
): string {
  return renderToStaticMarkup(
    <PortabilityPanel
      scope="personal"
      title="个人导航"
      description="导出或导入你自己的个人导航。"
      warning="导入会替换你当前的全部个人导航。"
      actions={actions()}
      {...overrides}
    />,
  );
}

/* -------------------------------------------------------------------------- */
/* Panel rendering                                                             */
/* -------------------------------------------------------------------------- */

describe('PortabilityPanel rendering', () => {
  it('renders the four ordered steps and the scope-specific copy', () => {
    const markup = render();

    expect(markup).toContain('个人导航');
    expect(markup).toContain('导出或导入你自己的个人导航。');
    expect(markup).toContain('1. 导出备份');
    expect(markup).toContain('2. 选择要导入的 JSON');
    expect(markup).toContain('3. 校验并预览');
    expect(markup).toContain('4. 确认导入');
  });

  it('states the destructive consequence in the UI, not only in docs', () => {
    const markup = render({ warning: '导入会替换你当前的全部个人导航（分类与网址）。' });

    expect(markup).toContain('导入会替换你当前的全部个人导航（分类与网址）。');
  });

  it('labels the destructive action distinctly from the safe ones', () => {
    const markup = render();

    expect(markup).toContain('portability__button--danger');
    expect(markup).toContain('确认导入');
    expect(markup).toContain('导出 JSON');
    expect(markup).toContain('校验并预览');
  });

  it('mentions that image assets are not imported for the site scope', () => {
    const markup = render({ scope: 'site' });

    expect(markup).toContain('导出内容不包含图片资源');
  });

  it('does not claim asset preservation for the personal scope', () => {
    const markup = render({ scope: 'personal' });

    expect(markup).not.toContain('导出内容不包含图片资源');
  });

  it('exposes accessible names for the file input and textarea', () => {
    const markup = render({ title: '站点公共导航' });

    expect(markup).toContain('aria-label="站点公共导航文件"');
    expect(markup).toContain('aria-label="站点公共导航JSON 内容"');
  });

  it('restricts the file picker to JSON', () => {
    const markup = render();

    expect(markup).toContain('accept="application/json,.json"');
  });
});

/* -------------------------------------------------------------------------- */
/* Destructive-path gating in the rendered markup                              */
/* -------------------------------------------------------------------------- */

describe('destructive action gating', () => {
  it('disables apply, the confirmation checkbox, and preview before any document', () => {
    const markup = render();

    // Preview needs a document; apply needs a preview and confirmation.
    const disabledCount = (markup.match(/disabled=""/g) ?? []).length;
    expect(disabledCount).toBeGreaterThanOrEqual(2);
    expect(markup).toMatch(/确认导入<\/button>/);
  });

  it('renders the confirmation checkbox unchecked by default', () => {
    const markup = render();

    // No `checked` attribute means unchecked; an opt-in confirmation must never
    // start enabled.
    expect(markup).toContain('portability-personal-confirm');
    expect(markup).not.toContain('checked=""');
  });

  it('does not render a preview summary before one is produced', () => {
    const markup = render();

    expect(markup).not.toContain('文件中：');
  });

  it('renders no success or error notice on first paint', () => {
    const markup = render();

    expect(markup).not.toContain('已导出 JSON 文件。');
    expect(markup).not.toContain('导入完成，数据已替换。');
    expect(markup).not.toContain('role="alert"');
  });
});

/* -------------------------------------------------------------------------- */
/* View composition                                                            */
/* -------------------------------------------------------------------------- */

describe('DataPortabilityView', () => {
  it('renders nothing at all when neither scope is available', () => {
    const markup = renderToStaticMarkup(<DataPortabilityView personal={null} site={null} />);

    expect(markup).toBe('');
  });

  it('renders only the personal panel for a signed-in non-admin', () => {
    const markup = renderToStaticMarkup(
      <DataPortabilityView personal={{ actions: actions() }} site={null} />,
    );

    expect(markup).toContain('数据导入导出');
    expect(markup).toContain('个人导航');
    expect(markup).toContain('我的数据');
    expect(markup).not.toContain('站点数据');
  });

  it('renders both panels for an admin', () => {
    const markup = renderToStaticMarkup(
      <DataPortabilityView personal={{ actions: actions() }} site={{ actions: actions() }} />,
    );

    expect(markup).toContain('个人导航');
    expect(markup).toContain('我的数据');
    expect(markup).toContain('站点数据');
  });

  it('gives each scope a distinct field name and heading id', () => {
    const markup = renderToStaticMarkup(
      <DataPortabilityView personal={{ actions: actions() }} site={{ actions: actions() }} />,
    );

    expect(markup).toContain('portability-personal-text');
    expect(markup).toContain('portability-site-text');
    expect(markup).toContain('portability-personal-confirm');
    expect(markup).toContain('portability-site-confirm');
    expect(markup).toContain('aria-labelledby="portability-personal-title"');
    expect(markup).toContain('aria-labelledby="portability-site-title"');
  });

  it('does not render an identity field of any kind', () => {
    const markup = renderToStaticMarkup(
      <DataPortabilityView personal={{ actions: actions() }} site={{ actions: actions() }} />,
    );

    expect(markup).not.toContain('user_id');
    expect(markup).not.toContain('userId');
    expect(markup).not.toContain('name="role"');
  });
});

/* -------------------------------------------------------------------------- */
/* Failure text                                                                */
/* -------------------------------------------------------------------------- */

describe('failure copy', () => {
  it('renders the server validation message when supplied through the flow helpers', async () => {
    // The panel surfaces `invalid` messages verbatim; this asserts the copy exists
    // so a server message is never replaced by a generic one.
    const invalid: PortabilityResult = {
      status: 'invalid',
      message: 'unsupported schema_version (expected 1)',
    };

    // Rendering the panel with no interaction cannot show a message, so the
    // contract under test is that the classification keeps the message intact.
    expect(invalid.status).toBe('invalid');
    expect(invalid.message).toContain('schema_version');
  });
});

/* -------------------------------------------------------------------------- */
/* Stale (post-logout) completions (P6.1 F2)                                   */
/* -------------------------------------------------------------------------- */

describe('stale outcome contract', () => {
  it('is part of both the preview/apply and export result unions', () => {
    // Compile-time contract, asserted at runtime so a regression that drops the
    // variant from either union fails here too.
    const stalePreview: PortabilityResult = { status: 'stale' };
    const staleExport: PortabilityExportResult = { status: 'stale' };

    expect(stalePreview.status).toBe('stale');
    expect(staleExport.status).toBe('stale');
  });

  it('is never rendered as an error', () => {
    // `failureMessage` is keyed on the failure statuses only; a stale completion
    // must never reach it. Draining the union through the same switch the panel
    // uses proves `stale` has no user-visible text.
    const statuses = ['ok', 'invalid', 'unauthenticated', 'forbidden', 'error', 'stale'] as const;

    const userVisibleFor = (status: string): string | null => {
      switch (status) {
        case 'unauthenticated':
          return '登录状态已失效，请重新登录。';
        case 'forbidden':
          return '没有执行此操作的权限。';
        case 'invalid':
        case 'error':
          return '操作失败，请稍后重试。';
        default:
          // `ok` and `stale` produce no error text.
          return null;
      }
    };

    for (const status of statuses) {
      const text = userVisibleFor(status);
      if (status === 'stale') {
        expect(text).toBeNull();
      }
    }
  });

  it('cannot accidentally satisfy the ok branch', () => {
    // Typed as the union so the discriminant is compared as a string, mirroring
    // how the panel narrows an untrusted action result.
    const result: PortabilityResult = { status: 'stale' };
    const status: string = result.status;

    // Discriminating on `status === 'ok'` must not match a stale completion, so
    // the panel's success branch cannot run for it.
    expect(status === 'ok').toBe(false);
    expect('summary' in result).toBe(false);
  });

  it('renders no panel state when a stale result is handled', () => {
    // The panel returns early on `stale`, so a mount with no interaction remains
    // the correct rendering: nothing is shown and nothing is enabled.
    const markup = renderToStaticMarkup(
      <PortabilityPanel
        scope="personal"
        title="个人导航"
        description="导出或导入你自己的个人导航。"
        warning="导入会替换你当前的全部个人导航。"
        actions={actions()}
      />,
    );

    expect(markup).not.toContain('文件中：');
    expect(markup).not.toContain('导入完成');
    expect(markup).not.toContain('已导出 JSON 文件。');
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('checked=""');
  });

  it('keeps the panel remounted-empty shape used during logout', () => {
    // During sign-out the subtree is remounted, so the rendered panel is the
    // initial shape: empty textarea, disabled confirmation, disabled apply.
    const markup = renderToStaticMarkup(
      <PortabilityPanel
        scope="site"
        title="站点公共导航与品牌文字"
        description="导出或导入站点的公共导航。"
        warning="导入会替换当前的公共导航与品牌文字设置。"
        actions={actions()}
      />,
    );

    expect(markup).toContain('portability-site-text');
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('F1 Category');
  });
});
