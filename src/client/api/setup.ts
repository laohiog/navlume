export interface SetupInput {
  username: string;
  email: string;
  password: string;
  setupCode: string;
}

export async function fetchSetupStatus(signal?: AbortSignal): Promise<boolean> {
  const response = await fetch('/api/setup/status', { cache: 'no-store', ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error('无法确认初始化状态，请重试');
  const body: unknown = await response.json();
  if (body === null || typeof body !== 'object' || !('needsSetup' in body) ||
      typeof body.needsSetup !== 'boolean') throw new Error('无法确认初始化状态，请重试');
  return body.needsSetup;
}

export async function submitSetup(input: SetupInput): Promise<{ ok: true } | { ok: false; message: string; closed: boolean }> {
  try {
    const response = await fetch('/api/setup/admin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
    if (response.status === 201) return { ok: true };
    const body = await response.json() as { error?: string };
    const messages: Record<string, string> = {
      'Invalid Setup Code': '初始化验证码不正确，请核对容器日志',
      'Setup Code Expired': '验证码已过期，请重启容器后查看新的验证码',
      'Too Many Attempts': '尝试次数过多，请一分钟后重试',
      'Setup Unavailable': '初始化入口已关闭，请进入登录页面',
      'Invalid Origin': '访问网址与实例配置不一致，请使用配置的访问网址',
      'Invalid Input': '请检查用户名、邮箱和密码格式',
    };
    return { ok: false, closed: response.status === 409,
      message: messages[body.error ?? ''] ?? '管理员创建失败，请检查输入后重试' };
  } catch { return { ok: false, closed: false, message: '连接失败，请检查网络后重试' }; }
}
