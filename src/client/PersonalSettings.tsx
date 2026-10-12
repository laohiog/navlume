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
      <div className="personal-settings__toolbar">
        <button className="personal-settings__back" type="button" onClick={onBackToHome}>
          返回导航
        </button>
        <h2 className="personal-settings__title" id="personal-settings-title">个人设置</h2>
      </div>
      <DataPortabilityView personal={{ actions }} site={null} />
    </section>
  );
}
