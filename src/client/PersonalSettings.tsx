import { DataPortabilityView, type PortabilityPanelActions } from './DataPortability.js';

/** Session gating and action ownership stay in App, as for Admin Management. */
export function PersonalSettingsView({
  actions,
  onBackToHome,
}: {
  actions: PortabilityPanelActions;
  onBackToHome: () => void;
}) {
  return (
    <section className="personal-settings" aria-labelledby="personal-settings-title">
      {/*
        Title first, back control second: the toolbar lays these out in visual
        order (title left, back right), so the reading order must match it.
        With the back button first, sighted and screen-reader users got opposite
        orders (audit F2).
      */}
      <div className="personal-settings__toolbar">
        <h2 className="personal-settings__title" id="personal-settings-title">个人设置</h2>
        <button className="personal-settings__back" type="button" onClick={onBackToHome}>
          返回导航
        </button>
      </div>
      <DataPortabilityView personal={{ actions }} site={null} />
    </section>
  );
}
