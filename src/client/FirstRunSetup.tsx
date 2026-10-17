import { useEffect, useState } from 'react';
import { App } from './App.js';
import { fetchSetupStatus, submitSetup, type SetupInput } from './api/setup.js';

export function SetupForm({ onLogin, requiresCode = true }: { onLogin: () => void; requiresCode?: boolean }) {
  const [input, setInput] = useState<SetupInput>({ username: '', email: '', password: '', setupCode: '' });
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [closed, setClosed] = useState(false);
  const [visible, setVisible] = useState(false);
  if (complete || closed) return (
    <section className="login" aria-labelledby="setup-title">
      <h1 className="login__title" id="setup-title">{complete ? '管理员账户已创建' : '初始化入口已关闭'}</h1>
      <p className="login__description" role="status">{complete ? '请使用刚创建的用户名和密码登录。' : '此实例已完成初始化，请使用已有账户登录。'}</p>
      <button className="login__submit" onClick={onLogin}>进入登录页面</button>
    </section>
  );
  return (
    <section className="login" aria-labelledby="setup-title">
      <h1 className="login__title" id="setup-title">欢迎使用 Navlume</h1>
      <p className="login__description">首次使用，请创建管理员账户。</p>
      {!requiresCode && <p className="login__description">局域网快捷安装：无需初始化验证码。HTTP 不加密传输，请只在可信局域网内使用。</p>}
      <form className="login__form" onSubmit={async (event) => {
        event.preventDefault();
        if (submitting) return;
        if (confirmation !== input.password) { setError('两次输入的密码不一致'); return; }
        setError(null); setSubmitting(true);
        const result = await submitSetup({ ...input, username: input.username.trim(), email: input.email.trim(), setupCode: input.setupCode.trim() });
        setSubmitting(false);
        if (result.ok) { setComplete(true); setInput({ username: '', email: '', password: '', setupCode: '' }); setConfirmation(''); }
        else { setError(result.message); if (result.closed) { setClosed(true); setInput({ username: '', email: '', password: '', setupCode: '' }); setConfirmation(''); } }
      }}>
        <label className="login__field"><span className="login__label">管理员用户名</span>
          <input className="login__input" name="username" autoComplete="username" required minLength={3} maxLength={30} pattern="[a-zA-Z0-9_.]{3,30}" title="3–30 位字母、数字、下划线或点" aria-describedby="setup-username-help" disabled={submitting} value={input.username} onChange={(e) => setInput({ ...input, username: e.target.value })} />
          <small id="setup-username-help">3–30 位字母、数字、下划线或点</small>
        </label>
        <label className="login__field"><span className="login__label">电子邮箱</span>
          <input className="login__input" name="email" type="email" autoComplete="email" required maxLength={254} disabled={submitting} value={input.email} onChange={(e) => setInput({ ...input, email: e.target.value })} />
        </label>
        <label className="login__field"><span className="login__label">密码</span>
          <input className="login__input" name="password" type={visible ? 'text' : 'password'} autoComplete="new-password" required minLength={8} maxLength={128} aria-describedby="setup-password-help" disabled={submitting} value={input.password} onChange={(e) => setInput({ ...input, password: e.target.value })} />
          <small id="setup-password-help">8–128 位，请使用强且独立的密码</small>
        </label>
        <label className="login__field"><span className="login__label">确认密码</span>
          <input className="login__input" name="confirmation" type={visible ? 'text' : 'password'} autoComplete="new-password" required disabled={submitting} aria-invalid={confirmation.length > 0 && confirmation !== input.password} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
        </label>
        <label className="setup__visibility"><input type="checkbox" checked={visible} disabled={submitting} onChange={(e) => setVisible(e.target.checked)} />显示密码</label>
        {requiresCode && <label className="login__field"><span className="login__label">一次性初始化验证码</span>
          <input className="login__input" name="setupCode" autoComplete="off" spellCheck={false} required maxLength={128} aria-describedby="setup-code-help" disabled={submitting} value={input.setupCode} onChange={(e) => setInput({ ...input, setupCode: e.target.value })} />
          <small id="setup-code-help">请在 NAS 的 Docker → 容器 → 日志中查看首次初始化验证码。验证码有效期为 60 分钟，请勿分享。</small>
        </label>}
        {error && <p className="login__error" role="alert">{error}</p>}
        <button className="login__submit" type="submit" disabled={submitting}>{submitting ? '创建中…' : '创建管理员账户'}</button>
      </form>
    </section>
  );
}

/** Check before mounting the existing app, so a fresh instance never flashes its login/home. */
export function FirstRunApp() {
  const [state, setState] = useState<'loading' | 'setup' | 'normal' | 'login' | 'error'>('loading');
  const [retry, setRetry] = useState(0);
  const [requiresCode, setRequiresCode] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void fetchSetupStatus(controller.signal, (required) => { if (active) setRequiresCode(required); }).then((needed) => {
      if (active) setState(needed ? 'setup' : 'normal');
    }).catch(() => { if (active) setState('error'); });
    return () => { active = false; controller.abort(); };
  }, [retry]);
  if (state === 'normal' || state === 'login') return <App initialLogin={state === 'login'} />;
  return <main className="app setup" id="main-content" tabIndex={-1}>
    {state === 'setup' ? <SetupForm onLogin={() => setState('login')} requiresCode={requiresCode} /> :
      <section className="login"><p role={state === 'error' ? 'alert' : 'status'}>{state === 'error' ? '无法确认初始化状态，请检查连接后重试。' : '正在检查初始化状态…'}</p>
        {state === 'error' && <button className="login__submit" onClick={() => { setState('loading'); setRetry((value) => value + 1); }}>重试</button>}
      </section>}
  </main>;
}
