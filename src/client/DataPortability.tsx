import { useEffect, useRef, useState } from 'react';

import { type PortableDocument, parseDocumentText } from './api/data-portability.js';
import {
  applyFailed,
  applySucceeded,
  canApply as canApplyFlow,
  confirmationChanged,
  documentAccepted,
  hasFreshPreview as hasFreshPreviewFlow,
  initialPortabilityFlow,
  previewFailed,
  previewSucceeded,
  type PortabilityFlowState,
} from './portability-flow.js';

/**
 * Summary shared by both import scopes.
 *
 * Declared locally rather than imported from the server module so the view stays
 * free of server types and can be exercised with plain fixtures.
 */
export interface PortabilitySummary {
  incomingCategories: number;
  incomingLinks: number;
  currentCategories: number;
  currentLinks: number;
  replacementWarning: string;
  /** Site-only: branding text settings are replaced. */
  brandingUpdated?: boolean;
  /** Site-only: image assets are instance-local and are never imported. */
  assetsPreserved?: boolean;
}

/**
 * A completion that arrived after the identity it belonged to was torn down.
 *
 * The request may well have succeeded server-side (an import commits
 * authoritatively); `stale` says only that this **client continuation** must be
 * discarded. It is handled entirely inside the panel and is never rendered as an
 * error, so no session-generation detail reaches the user.
 */
export interface StaleOutcome {
  status: 'stale';
}

/** Outcome of a preview or apply request, flattened for the view. */
export type PortabilityResult =
  | { status: 'ok'; summary: PortabilitySummary }
  | { status: 'invalid'; message: string }
  | { status: 'unauthenticated' }
  | { status: 'forbidden' }
  | { status: 'error' }
  | StaleOutcome;

/** Outcome of an export request. The action itself saves the file. */
export type PortabilityExportResult =
  | { status: 'ok' }
  | { status: 'unauthenticated' }
  | { status: 'forbidden' }
  | { status: 'error' }
  | StaleOutcome;

/** Actions the container implements. The view only triggers them. */
export interface PortabilityPanelActions {
  export(): Promise<PortabilityExportResult>;
  preview(document: PortableDocument): Promise<PortabilityResult>;
  apply(document: PortableDocument): Promise<PortabilityResult>;
}

export interface PortabilityPanelProps {
  scope: 'site' | 'personal';
  title: string;
  description: string;
  /**
   * Explanation of exactly what applying replaces.
   *
   * Rendered next to the confirmation checkbox so the destructive consequence is
   * stated in the UI, not only in documentation.
   */
  warning: string;
  actions: PortabilityPanelActions;
}

/** Human-readable reason for a failed request. */
function failureMessage(result: PortabilityResult | PortabilityExportResult): string {
  if ('message' in result && result.status === 'invalid') {
    return result.message;
  }

  switch (result.status) {
    case 'unauthenticated':
      return '登录状态已失效，请重新登录。';
    case 'forbidden':
      return '没有执行此操作的权限。';
    default:
      return '操作失败，请稍后重试。';
  }
}

/**
 * One import/export panel (either the site scope or the personal scope).
 *
 * ## Flow and its invariants
 *
 * `export → paste/choose → preview → confirm → apply`.
 *
 * - **Preview is bound to a specific document.** The previewed document is stored
 *   by reference and compared with the currently parsed document. Any edit
 *   invalidates the preview and the confirmation, because a preview of document A
 *   is not permission to import document B.
 * - **The apply button requires an explicit confirmation checkbox.** There is no
 *   default-on confirmation and no "remember my choice".
 * - **A successful apply clears the preview.** Re-importing the same content
 *   requires previewing again, so a double click cannot apply twice.
 * - **A completion from a torn-down identity is discarded.** The container's
 *   actions return `stale` when logout invalidated the request while it was in
 *   flight; such a completion never saves a file, never renders a preview, error,
 *   or notice, never re-arms confirmation, and never triggers a refetch.
 * - **Nothing here is an authorization boundary.** Every route is authorized on
 *   the server; this component only avoids offering impossible actions.
 *
 * State is local to the mounted subtree. The container keys this subtree on the
 * session identity and unmounts it synchronously at logout start, so protected
 * state is discarded before the sign-out round trip rather than after it.
 */
export function PortabilityPanel({
  scope,
  title,
  description,
  warning,
  actions,
}: PortabilityPanelProps) {
  const [text, setText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);

  /**
   * Preview/confirmation state.
   *
   * Kept in one object and mutated only through the pure transitions in
   * `portability-flow.ts`, so the destructive-path rules (a preview authorizes one
   * specific document; apply needs a fresh preview *and* explicit confirmation) are
   * defined in one testable place rather than spread across event handlers.
   */
  const [flow, setFlow] = useState<PortabilityFlowState<PortableDocument, PortabilitySummary>>(
    initialPortabilityFlow,
  );

  const [phase, setPhase] = useState<'idle' | 'exporting' | 'previewing' | 'applying'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Guards state updates after unmount (e.g. the panel unmounts on logout). */
  const mountedRef = useRef(true);

  useEffect(() => {
    // React 18+ may run effects twice in development; reset on mount so the
    // cleanup from a discarded pass cannot leave the flag stuck false.
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isBusy = phase !== 'idle';
  const hasFreshPreview = hasFreshPreviewFlow(flow);
  const canApply = canApplyFlow(flow, isBusy);
  /** The parsed document, or null while the textarea is empty or unparseable. */
  const document = flow.document;
  const summary = flow.summary;

  /** Replace the working text and invalidate any previous preview. */
  function acceptText(next: string): void {
    setText(next);
    setNotice(null);
    setErrorMessage(null);

    if (next.trim().length === 0) {
      setParseError(null);
      setFlow((current) => documentAccepted(current, null));
      return;
    }

    const parsed = parseDocumentText(next);

    if (parsed.status === 'invalid') {
      setParseError(parsed.message);
      setFlow((current) => documentAccepted(current, null));
      return;
    }

    setParseError(null);
    // The previous preview described different content, so it is discarded here.
    setFlow((current) => documentAccepted(current, parsed.document));
  }

  async function handleExport(): Promise<void> {
    setPhase('exporting');
    setErrorMessage(null);
    setNotice(null);

    let result: PortabilityExportResult;
    try {
      result = await actions.export();
    } catch {
      result = { status: 'error' };
    }

    // Unmounted, or the identity that started this export was torn down: either
    // way this completion must not touch state or the filesystem.
    if (!mountedRef.current || result.status === 'stale') return;

    if (result.status === 'ok') {
      setNotice('已导出 JSON 文件。');
    } else {
      setErrorMessage(failureMessage(result));
    }

    setPhase('idle');
  }

  async function handlePreview(): Promise<void> {
    if (document === null) {
      return;
    }

    setPhase('previewing');
    setErrorMessage(null);
    setNotice(null);

    // Captured so a response that arrives after the document changed is discarded.
    const requested = document;
    let result: PortabilityResult;

    try {
      result = await actions.preview(requested);
    } catch {
      result = { status: 'error' };
    }

    // A stale preview must not appear, re-enable confirmation, or restore an
    // error from a session that has already been torn down.
    if (!mountedRef.current || result.status === 'stale') return;

    if (result.status === 'ok') {
      // A new preview always re-arms the confirmation step.
      setFlow((current) => previewSucceeded(current, requested, result.summary));
    } else {
      setFlow(previewFailed);
      setErrorMessage(failureMessage(result));
    }

    setPhase('idle');

    setPhase('idle');
  }

  async function handleApply(): Promise<void> {
    if (document === null || !canApply) {
      return;
    }

    setPhase('applying');
    setErrorMessage(null);
    setNotice(null);

    const requested = document;
    let result: PortabilityResult;

    try {
      result = await actions.apply(requested);
    } catch {
      result = { status: 'error' };
    }

    // A stale apply must not report success or failure, and must not alter the
    // flow. The server may legitimately have committed the import already; only
    // this client continuation is discarded.
    if (!mountedRef.current || result.status === 'stale') return;

    if (result.status === 'ok') {
      setNotice('导入完成，数据已替换。');
      // The preview is consumed so the same content cannot be applied twice by
      // accident. The text is kept so the user can still inspect what was sent.
      setFlow(applySucceeded);
    } else {
      // A failed apply changed nothing (the server applies atomically), so the
      // preview may stay visible; only the confirmation is re-armed.
      setFlow(applyFailed);
      setErrorMessage(failureMessage(result));
    }

    setPhase('idle');
  }

  const headingId = `portability-${scope}-title`;

  return (
    <section className="portability" aria-labelledby={headingId}>
      <div className="portability__header">
        <h2 className="portability__title" id={headingId}>
          {title}
        </h2>
        <p className="portability__description">{description}</p>
      </div>

      {errorMessage !== null ? (
        <p className="portability__error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      {notice !== null ? (
        <p className="portability__notice" role="status">
          {notice}
        </p>
      ) : null}

      {/* Step 1: export ---------------------------------------------------- */}
      <div className="portability__step">
        <h3 className="portability__step-title">1. 导出备份</h3>
        <p className="portability__hint">
          下载当前数据的 JSON 备份，可自行保存或迁移。
          {scope === 'site'
            ? '导出内容不包含图片资源（Logo／图标），这些文件仍保留在当前实例。'
            : ''}
        </p>
        <button
          className="portability__button"
          type="button"
          disabled={isBusy}
          onClick={() => void handleExport()}
        >
          {phase === 'exporting' ? '正在导出…' : '导出 JSON'}
        </button>
      </div>

      {/* Step 2: choose a document ---------------------------------------- */}
      <div className="portability__step">
        <h3 className="portability__step-title">2. 选择要导入的 JSON</h3>
        <p className="portability__hint">粘贴 JSON 内容，或选择一个 .json 文件。</p>

        <label className="portability__field">
          <span className="portability__label">JSON 文件</span>
          <input
            ref={fileInputRef}
            className="portability__file"
            type="file"
            name={`portability-${scope}-file`}
            accept="application/json,.json"
            disabled={isBusy}
            aria-label={`${title}文件`}
            onChange={(event) => {
              const file = event.target.files?.[0];

              if (file === undefined) {
                return;
              }

              void file
                .text()
                .then((content) => {
                  if (mountedRef.current) {
                    acceptText(content);
                  }
                })
                .catch(() => {
                  if (mountedRef.current) {
                    setErrorMessage('无法读取所选文件。');
                  }
                })
                .finally(() => {
                  // Allow re-selecting the same file after a failure.
                  if (fileInputRef.current !== null) {
                    fileInputRef.current.value = '';
                  }
                });
            }}
          />
        </label>

        <label className="portability__field">
          <span className="portability__label">JSON 内容</span>
          <textarea
            className="portability__textarea"
            name={`portability-${scope}-text`}
            rows={8}
            spellCheck={false}
            placeholder={'{\n  "schema_version": 1,\n  …\n}'}
            disabled={isBusy}
            aria-label={`${title}JSON 内容`}
            value={text}
            onChange={(event) => {
              acceptText(event.target.value);
            }}
          />
        </label>

        {parseError !== null ? (
          <p className="portability__error" role="alert">
            {parseError}
          </p>
        ) : null}
      </div>

      {/* Step 3: validate and preview ------------------------------------- */}
      <div className="portability__step">
        <h3 className="portability__step-title">3. 校验并预览</h3>
        <p className="portability__hint">校验只读取数据，不会修改任何内容。</p>

        <button
          className="portability__button"
          type="button"
          disabled={isBusy || document === null}
          onClick={() => void handlePreview()}
        >
          {phase === 'previewing' ? '正在校验…' : '校验并预览'}
        </button>

        {hasFreshPreview && summary !== null ? (
          <div className="portability__preview" role="status">
            <p className="portability__preview-line">
              文件中：{summary.incomingCategories} 个分类、{summary.incomingLinks} 个网址
            </p>
            <p className="portability__preview-line">
              当前实例：{summary.currentCategories} 个分类、{summary.currentLinks} 个网址
            </p>
            {summary.assetsPreserved === true ? (
              <p className="portability__preview-line">
                图片资源（Logo／图标）不会被导入或删除。
              </p>
            ) : null}
            <p className="portability__preview-warning">{summary.replacementWarning}</p>
          </div>
        ) : null}
      </div>

      {/* Step 4: confirm and apply ---------------------------------------- */}
      <div className="portability__step">
        <h3 className="portability__step-title">4. 确认导入</h3>

        <p className="portability__warning" id={`portability-${scope}-warning`}>
          {warning}
        </p>

        <label className="portability__checkbox">
          <input
            type="checkbox"
            name={`portability-${scope}-confirm`}
            checked={flow.confirmed}
            disabled={!hasFreshPreview || isBusy}
            onChange={(event) => {
              const { checked } = event.target;
              setFlow((current) => confirmationChanged(current, checked));
            }}
          />
          <span>我已了解此操作会替换现有数据，并确认导入。</span>
        </label>

        <button
          className="portability__button portability__button--danger"
          type="button"
          disabled={!canApply}
          aria-describedby={`portability-${scope}-warning`}
          onClick={() => void handleApply()}
        >
          {phase === 'applying' ? '正在导入…' : '确认导入'}
        </button>
      </div>
    </section>
  );
}

/** Which panels the container is authorized to render. */
export interface DataPortabilityViewProps {
  /** The signed-in user's own panel. `null` for a guest. */
  personal: { actions: PortabilityPanelActions } | null;
  /** The admin-only site panel. `null` for a non-admin. */
  site: { actions: PortabilityPanelActions } | null;
}

/**
 * JSON data portability surface.
 *
 * Renders two independent panels. Neither panel's state is shared, so a site
 * import can never be confused with a personal import. Renders nothing when
 * neither scope is available, so a guest receives no portability markup at all —
 * a render decision, not a security boundary; the server authorizes every route.
 */
export function DataPortabilityView({ personal, site }: DataPortabilityViewProps) {
  if (personal === null && site === null) {
    return null;
  }

  return (
    <section className="portability__group" aria-labelledby="data-portability-title">
      <div className="portability__group-header">
        <h2 className="portability__group-title" id="data-portability-title">
          数据导入导出
        </h2>
        <p className="portability__group-description">
          JSON 备份与恢复。导出可用于保存或迁移；导入会替换对应范围的数据，操作前会先校验并预览。
        </p>
      </div>

      {personal !== null ? (
        <PortabilityPanel
          scope="personal"
          title="我的数据"
          description="导出或导入你自己的个人导航（分类与网址）。其他用户的数据不受影响。"
          warning="导入会替换你当前的全部个人导航（分类与网址）。此操作在单个事务中完成，失败时不会改变现有数据。"
          actions={personal.actions}
        />
      ) : null}

      {site !== null ? (
        <PortabilityPanel
          scope="site"
          title="站点数据"
          description="导出或导入站点的公共导航、站点名称、标签、主色、主题、页脚与访问模式。"
          warning="导入会替换当前的公共导航与品牌文字设置。图片资源（Logo／图标）与用户账号不会被改动。"
          actions={site.actions}
        />
      ) : null}
    </section>
  );
}
