import { useEffect, useRef, useState } from 'react';

/** Outcome the form reports to its container. */
export interface LoginFormProps {
  onSubmit: (credentials: { username: string; password: string }) => Promise<void>;
  /** True while a sign-in request is in flight. */
  isSubmitting: boolean;
  /** Generic error message to show, if any. */
  errorMessage: string | null;
  /** Optional heading override for the login-required screen. */
  title?: string;
  description?: string;
}

/**
 * Username/password login form.
 *
 * Deliberately minimal: no signup path, no password reset, no social login.
 * Error text is supplied by the container so the same generic message is used
 * for every credential failure (no username/password discrimination).
 */
export function LoginForm({
  onSubmit,
  isSubmitting,
  errorMessage,
  title = '登录',
  description,
}: LoginFormProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  /**
   * Focus the first editable control when the form appears.
   *
   * The form is only rendered after the user asks to sign in (`登录`, or a
   * `login_required` screen whose sole purpose is signing in), so the username
   * field is the next thing they intend to use. Without this the browser keeps
   * focus on the `取消` toggle that was just activated, leaving the credential
   * fields an extra Tab away and giving no visible cue of where to type.
   */
  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    usernameRef.current?.focus();
  }, []);

  /**
   * Return the caret to the password field after a failed attempt.
   *
   * Submitting disables the controls, and a disabled element cannot hold focus,
   * so focus falls to `<body>` while the request is in flight. When the attempt
   * fails there is no longer a focused field to correct, which is why retrying
   * previously required pressing Tab to find the form again. The container clears
   * `errorMessage` at the start of every attempt, so this effect runs again on
   * each failure rather than only the first.
   *
   * The password field is the useful target: the username is preserved across a
   * failure, so the password is what normally needs retyping. The error itself is
   * already announced independently through `role="alert"`.
   */
  const passwordRef = useRef<HTMLInputElement>(null);

  /**
   * Whether the error effect has already run once.
   *
   * The container does not clear `loginError` when the form is reopened, so a
   * previous failure can still be present on mount. This guard keeps the initial
   * focus on the username field in that case and reserves the password focus for
   * an error that actually appears while this form instance is on screen.
   */
  const hasMountedRef = useRef(false);

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }

    if (errorMessage !== null && errorMessage.length > 0) {
      passwordRef.current?.focus();
    }
  }, [errorMessage]);

  return (
    <section className="login" aria-labelledby="login-title">
      <h2 className="login__title" id="login-title">
        {title}
      </h2>
      {description !== undefined && description.length > 0 ? (
        <p className="login__description">{description}</p>
      ) : null}

      <form
        className="login__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (isSubmitting) {
            return;
          }
          void onSubmit({ username, password });
        }}
      >
        <label className="login__field">
          <span className="login__label">用户名</span>
          <input
            ref={usernameRef}
            className="login__input"
            type="text"
            name="username"
            autoComplete="username"
            value={username}
            disabled={isSubmitting}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>

        <label className="login__field">
          <span className="login__label">密码</span>
          <input
            ref={passwordRef}
            className="login__input"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            disabled={isSubmitting}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {errorMessage !== null && errorMessage.length > 0 ? (
          <p className="login__error" role="alert">
            {errorMessage}
          </p>
        ) : null}

        <button className="login__submit" type="submit" disabled={isSubmitting}>
          {isSubmitting ? '登录中…' : '登录'}
        </button>
      </form>
    </section>
  );
}
