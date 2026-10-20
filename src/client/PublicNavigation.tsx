import { Fragment, useRef, useState, type ReactNode, type RefObject } from 'react';

import { FooterContent } from './FooterContent.js';
import { HomeNavigation } from './HomeNavigation.js';
import { LoginForm } from './LoginForm.js';
import { filterCategoriesByQuery, splitHighlight } from './navigation-search.js';
import type { PublicBranding } from './api/admin-branding.js';
import type {
  PublicNavigation,
  PublicNavigationCategory,
  PublicNavigationLink,
} from './api/public-navigation.js';

/**
 * Render state for the public homepage.
 *
 * Kept as an explicit discriminated union so each UI state can be rendered and
 * tested independently of the data-loading hook.
 *
 * `unauthenticated` means the server rejected the request with 401 because the
 * site is `login_required`; the client must not hold protected data in that case.
 */
export type PublicNavigationState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'unauthenticated' }
  | { status: 'ready'; data: PublicNavigation };

/** Session summary for header rendering. */
export interface SessionSummary {
  /** True while Better Auth is still resolving the session. */
  isPending: boolean;
  /** Username when authenticated, otherwise null. */
  username: string | null;
}

export interface PublicNavigationViewProps {
  state: PublicNavigationState;
  session: SessionSummary;
  /** Whether the login form should be visible right now. */
  isLoginVisible: boolean;
  login: {
    isSubmitting: boolean;
    errorMessage: string | null;
    onSubmit: (credentials: { username: string; password: string }) => Promise<void>;
  };
  /**
   * Personal navigation section, rendered above public content for an
   * authenticated visitor. `null` for guests, in which case nothing personal is
   * rendered at all — the container never requests or holds personal data for a
   * guest, so this is absence rather than a CSS hide.
   */
  personal: { view: ReactNode } | null;
  /**
   * Admin-only entry into Admin Management. `null` for guests and ordinary
   * users, in which case no admin entry is rendered. Presentation only — every
   * admin API route authorizes on the server, so this entry is a convenience,
   * never a boundary.
   */
  adminEntry: { onOpenAdmin: () => void } | null;
  /** Ordinary signed-in user's entry; data tools live outside Home. */
  settingsEntry: { onOpenSettings: () => void } | null;
  /**
   * Branded site identity. The header, the login-required screen, and the footer
   * all read from this one unauthenticated branding read, which is independent
   * of navigation so a branding failure cannot break navigation and vice versa.
   */
  branding: PublicBranding;
  /**
   * Client-side search state. The query is owned by the container so it can span
   * both the personal and public sections; this view filters public links and
   * renders the shared input and no-results message.
   */
  search: {
    query: string;
    onChange: (query: string) => void;
    /** True only once a resolved non-empty query matched nothing anywhere. */
    showNoResults: boolean;
    resultCount?: number | null;
  };
  onRetry?: () => void;
  onLogout: () => void;
  onShowLogin: () => void;
  onHideLogin: () => void;
}

/**
 * Client-side search control.
 *
 * A single plain input: no filters, sorting, suggestions, history, or command
 * palette. It is an editable control, so the global paste Quick Add shortcut
already ignores it (see `isEditableTarget`) and pasting here behaves normally.
 */
function SearchBar({
  query,
  onChange,
  inputRef,
}: {
  query: string;
  onChange: (query: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="search">
      <label className="search__field">
        <span className="search__label">搜索网址</span>
        <input
          ref={inputRef}
          className="search__input"
          type="search"
          name="search"
          placeholder="输入名称、网址或分类名…"
          autoComplete="off"
          value={query}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    </div>
  );
}

/** Shared destination recognition for both homepage grids; no metadata requests. */
export function DestinationIcon({ title, iconUrl }: { title: string; iconUrl: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const canDisplay = iconUrl !== null && /^(https?:\/\/|\/(?!\/))/i.test(iconUrl);

  return (
    <span className="destination-icon" aria-hidden="true">
      <span>{Array.from(title.trim())[0]?.toLocaleUpperCase() ?? '↗'}</span>
      {canDisplay && iconUrl !== failedUrl ? (
        <img
          src={iconUrl}
          alt=""
          width={44}
          height={44}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(iconUrl)}
        />
      ) : null}
    </span>
  );
}

/** Display only: the destination itself always uses the original validated href. */
export function DestinationHost({ url, query = '' }: { url: string; query?: string }) {
  let host: string;

  try {
    host = new URL(url).hostname;
  } catch {
    return '';
  }

  return query.length === 0 ? host : <SearchHighlight text={host} query={query} />;
}

/**
 * Render `text` with every case-insensitive match of `query` wrapped in `<mark>`.
 *
 * Purely presentational: the visible characters are the ones the caller passed,
 * only their wrapping changes. Exported because the personal section highlights
 * with the same projection — a second implementation there could disagree with
 * the filter that selected the row.
 *
 * An empty query renders the text unchanged and produces no `<mark>`, so
 * clearing the search cannot leave a stale highlight behind.
 */
export function SearchHighlight({ text, query }: { text: string; query: string }) {
  const segments = splitHighlight(text, query);

  return (
    <>
      {segments.map((segment, index) => (
        segment.hit
          ? <mark key={index}>{segment.text}</mark>
          : <Fragment key={index}>{segment.text}</Fragment>
      ))}
    </>
  );
}

/** Category jumps keep the existing home/admin hash routing untouched. */
export function CategoryNavigation({
  categories,
  headingPrefix,
  label,
}: {
  categories: { id: number; name: string }[];
  headingPrefix: string;
  label: string;
}) {
  if (categories.length < 2) return null;

  return (
    <nav className="category-nav" aria-label={label}>
      {categories.map((category) => (
        <button
          key={category.id}
          className="category-nav__item"
          type="button"
          onClick={() => {
            const heading = document.getElementById(`${headingPrefix}${category.id}`);
            heading?.scrollIntoView({ block: 'start' });
            heading?.focus({ preventScroll: true });
          }}
        >
          {category.name}
        </button>
      ))}
    </nav>
  );
}

/**
 * A single public link, rendered as a T4.4 (Beacon A) directory row.
 *
 * Row anatomy is `icon · name · description · host`:
 *
 * - the **name** is the primary text;
 * - the **description** sits on the second line, directly visible — a description
 *   is what a human wrote to say what a link is *for*, and hiding it behind a
 *   tooltip made the directory far less useful than the data already allowed;
 * - the **host** is flush right in a tabular monospace, because a hostname is
 *   data, not prose, and setting it that way lets the eye compare destinations
 *   down the right-hand edge without reading them.
 *
 * A link with no description falls back to the host as its secondary line, so
 * every row still carries the same amount of information and the two lines stay
 * aligned across the column.
 *
 * The description is rendered as its own element rather than being folded into
 * the anchor's `title`: the tooltip is unreachable on touch and invisible to a
 * screenshot, and the brief requires the description to be *seen*.
 */
function LinkCard({ link, query }: { link: PublicNavigationLink; query: string }) {
  const description = link.description !== null && link.description.length > 0
    ? link.description
    : null;

  return (
    <li className="link-card">
      <a
        className="link-card__anchor"
        href={link.url}
        title={link.title}
        target="_blank"
        rel="noopener noreferrer"
      >
        <DestinationIcon title={link.title} iconUrl={link.iconUrl} />
        <span className="destination-copy">
          <span className="link-card__title">
            <SearchHighlight text={link.title} query={query} />
          </span>
          {/*
            The second line is the **secondary information**: the description
            when there is one, otherwise the host. A link with no description
            therefore still carries its destination, and every row has the same
            two-line shape.
          */}
          <span className={description === null ? 'destination-secondary' : 'link-card__description'}>
            {description === null
              ? <DestinationHost url={link.url} query={query} />
              : <SearchHighlight text={description} query={query} />}
          </span>
        </span>
        {/*
          The right-hand host column, rendered **only** when the second line is
          already the description. Otherwise the host would appear twice in the
          same row — once under the name and once at the right edge — and the
          host is already the secondary line in that case.
          *
          * This is also what makes the phone layout safe: the right column can
          * be dropped there, and a link with no description still shows its
          * destination on the second line.
          *
          * `aria-hidden` because the host restates the link's own URL, which
          * the anchor already exposes; reading it twice is noise.
          */}
        {description === null ? null : (
          <span className="destination-secondary link-card__host" aria-hidden="true">
            <DestinationHost url={link.url} query={query} />
          </span>
        )}
      </a>
    </li>
  );
}

/**
 * One public category with its visible links.
 *
 * B2 structure: the heading is a **slot** inside a bordered panel rather than a
 * free-standing label, and the link count is rendered next to the name.
 *
 * The count is derived from `category.links.length` — the same array that is
 * rendered immediately below — so the number can never drift from what the
 * panel actually shows. It is `aria-hidden` because the heading's accessible
 * name is used as the panel's label; announcing "常用工具 60" would otherwise
 * be the only way a screen reader learns the category size.
 */
function CategorySection({ category, query }: { category: PublicNavigationCategory; query: string }) {
  return (
    <section className="category" aria-labelledby={`category-${category.id}`}>
      <div className="category__head">
        <h3 className="category__title" id={`category-${category.id}`} tabIndex={-1} data-home-category="public">
          <span className="category__name">{category.name}</span>
          <span className="category__count" aria-hidden="true">{category.links.length}</span>
        </h3>
      </div>
      <ul className="link-list">
        {category.links.map((link) => (
          <LinkCard key={link.id} link={link} query={query} />
        ))}
      </ul>
    </section>
  );
}

/**
 * Session indicator plus login/logout controls.
 *
 * `adminEntry` is present only for an admin and renders the 管理后台 action in
 * the same header cluster. Exported because the Admin Management page reuses
 * this exact header cluster.
 */
export function SessionBar({
  session,
  isAuthenticated,
  isLoginVisible,
  adminEntry,
  settingsEntry,
  onLogout,
  onShowLogin,
  onHideLogin,
}: {
  session: SessionSummary;
  isAuthenticated: boolean;
  isLoginVisible: boolean;
  /** Present only for an admin. Presentation only; the server authorizes admin routes. */
  adminEntry?: { onOpenAdmin: () => void } | null;
  settingsEntry?: { onOpenSettings: () => void } | null;
  onLogout: () => void;
  onShowLogin: () => void;
  onHideLogin: () => void;
}) {
  if (session.isPending) {
    return (
      <div className="session-bar">
        <span className="session-bar__pending">…</span>
      </div>
    );
  }

  if (isAuthenticated) {
    return (
      <div className="session-bar">
        <span className="session-bar__user">已登录：{session.username}</span>
        {adminEntry ? (
          <button
            className="session-bar__button"
            type="button"
            onClick={adminEntry.onOpenAdmin}
          >
            管理后台
          </button>
        ) : null}
        {settingsEntry ? (
          <button className="session-bar__button" type="button" onClick={settingsEntry.onOpenSettings}>
            个人设置
          </button>
        ) : null}
        <button className="session-bar__button" type="button" onClick={onLogout}>
          退出登录
        </button>
      </div>
    );
  }

  return (
    <div className="session-bar">
      <button
        className="session-bar__button"
        type="button"
        onClick={isLoginVisible ? onHideLogin : onShowLogin}
      >
        {isLoginVisible ? '取消' : '登录'}
      </button>
    </div>
  );
}

/**
 * Branded site header: logo (when set), site name, and tagline.
 *
 * Branding comes from `/api/public/branding` rather than the navigation payload,
 * which is what lets the same header render on the `login_required` login screen
 * where no navigation is available. `siteName`, `tagline`, and `logoPath` are
 * rendered as plain React text/attributes — never as HTML.
 */
export function BrandHeader({ branding }: { branding: PublicBranding }) {
  return (
    <div className="site-header__brand">
      {branding.logoPath !== null ? (
        <img className="site-header__logo" src={branding.logoPath} alt="" width={40} height={40} />
      ) : null}
      <div className="site-header__brand-text">
        <h1 className="site-header__name">{branding.siteName}</h1>
        {branding.tagline !== null && branding.tagline.length > 0 ? (
          <p className="site-header__tagline">{branding.tagline}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Presentational public homepage.
 *
 * Pure: it renders exactly the given props and performs no data fetching or
 * session calls, which keeps it renderable in tests without a browser.
 *
 * Access enforcement is NOT performed here. The server decides via
 * `site_settings.access_mode`; this component only reflects the outcome.
 *
 * Personal and public states are independent: a personal failure (or a public
 * failure) never replaces the other section, and the personal section keeps its
 * own loading/error text.
 */
export function PublicNavigationView({
  state,
  session,
  isLoginVisible,
  login,
  personal,
  adminEntry,
  settingsEntry,
  branding,
  search,
  onLogout,
  onShowLogin,
  onHideLogin,
  onRetry,
}: PublicNavigationViewProps) {
  const contentRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isAuthenticated = session.username !== null;

  // login_required and no valid session: show the login screen only.
  // No navigation data is rendered, and none was accepted from the 401 response.
  // Branding still renders, which is why it has its own unauthenticated read.
  if (state.status === 'unauthenticated') {
    return (
      <div className="app app--home app--login-required">
        <header className="site-header">
          <BrandHeader branding={branding} />
        </header>
        <main className="content" id="main-content" tabIndex={-1}>
          <LoginForm
            title="请登录"
            description="此站点的公共导航需要登录后查看。"
            isSubmitting={login.isSubmitting}
            errorMessage={login.errorMessage}
            onSubmit={login.onSubmit}
          />
        </main>
      </div>
    );
  }

  const categories = state.status === 'ready' ? state.data.categories : null;

  // Display only: empty categories have no destinations or useful jump targets.
  const visibleCategories =
    categories === null ? null : filterCategoriesByQuery(categories, search.query)
      .filter((category) => category.links.length > 0);

  /**
   * The answer to the query: the public navigation projection plus its states.
   *
   * Extracted so the results markup stays in one place regardless of the states
   * around it, without a second search implementation.
   */
  const navigationResults = visibleCategories?.length === 0 ? null : (
    <section className="public-navigation" aria-labelledby="public-navigation-title">
      <h2 className="public-navigation__title" id="public-navigation-title">
        公共导航
      </h2>
      {state.status === 'loading' ? (
        <p className="status" role="status">
          正在加载公共导航…
        </p>
      ) : null}

      {state.status === 'error' ? (
        <div>
        <p className="status status--error" role="alert">
          公共导航暂时无法加载，请稍后重试。
        </p>
        {onRetry ? <button className="personal__button" type="button" onClick={onRetry}>重试加载公共导航</button> : null}
        </div>
      ) : null}

      <CategoryNavigation
        categories={visibleCategories ?? []}
        headingPrefix="category-"
        label="公共分类"
      />

      <div className="public-navigation__categories">
        {visibleCategories?.map((category) => (
          <CategorySection key={category.id} category={category} query={search.query} />
        ))}
      </div>
    </section>
  );

  return (
    <div className="app app--home">
      <header className="site-header">
        <div className="site-header__top">
          <BrandHeader branding={branding} />
          <SessionBar
            session={session}
            isAuthenticated={isAuthenticated}
            isLoginVisible={isLoginVisible}
            adminEntry={adminEntry}
            settingsEntry={settingsEntry}
            onLogout={onLogout}
            onShowLogin={onShowLogin}
            onHideLogin={onHideLogin}
          />
        </div>
      </header>

      <main className="content" id="main-content" ref={contentRef} tabIndex={-1} aria-label="导航首页">
        {!isAuthenticated && isLoginVisible ? (
          <LoginForm
            isSubmitting={login.isSubmitting}
            errorMessage={login.errorMessage}
            onSubmit={login.onSubmit}
          />
        ) : null}

        {/*
          Search sits above the navigation so users do not need to know whether a
          link is personal or public before searching; it spans both sections.
        */}
        <SearchBar query={search.query} onChange={search.onChange} inputRef={searchInputRef} />
        <p className="search__count" aria-live="polite" aria-atomic="true">
          {search.resultCount != null ? `找到 ${search.resultCount} 个网址` : search.showNoResults ? '找到 0 个网址' : ''}
        </p>
        {search.showNoResults ? (
          <div className="search__empty">
            <p className="status">没有找到匹配的网址。试试域名或分类名。</p>
            <button className="personal__button" type="button" onClick={() => {
              search.onChange(''); searchInputRef.current?.focus();
            }}>清空搜索</button>
          </div>
        ) : null}

        {/* Personal navigation is rendered before public navigation. */}
        {personal?.view ?? null}

        {navigationResults}

      </main>

      {branding.footerText !== null && branding.footerText.length > 0 ? (
        <footer className="site-footer">
          <FooterContent text={branding.footerText} />
        </footer>
      ) : null}
      <HomeNavigation key={session.username === null ? 'guest' : `user:${session.username}`} contentRef={contentRef} />
    </div>
  );
}
