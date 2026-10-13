import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupForm } from '../../src/client/FirstRunSetup.js';
import { fetchSetupStatus, submitSetup } from '../../src/client/api/setup.js';

afterEach(() => vi.unstubAllGlobals());
describe('setup UI and API', () => {
  it('hides the code field only when LAN mode is explicitly reported', async () => {
    const html = renderToStaticMarkup(<SetupForm onLogin={() => {}} requiresCode={false} />);
    expect(html).toContain('局域网快捷安装');
    expect(html).not.toContain('name="setupCode"');
    expect(html).toContain('不加密传输');
    const onMode = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ needsSetup: true }))
      .mockResolvedValueOnce(Response.json({ needsSetup: true, requiresCode: false })));
    expect(await fetchSetupStatus(undefined, onMode)).toBe(true);
    expect(onMode).toHaveBeenLastCalledWith(true);
    expect(await fetchSetupStatus(undefined, onMode)).toBe(true);
    expect(onMode).toHaveBeenLastCalledWith(false);
  });
  it('renders five labeled fields with limits, code guidance, no persistent secrets', () => {
    const html = renderToStaticMarkup(<SetupForm onLogin={() => {}} />);
    expect(html).toContain('欢迎使用 Navlume');
    for (const label of ['管理员用户名', '电子邮箱', '确认密码', '一次性初始化验证码']) expect(html).toContain(label);
    expect(html).toContain('容器 → 日志');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('创建管理员账户');
  });
  it('fetches status without caching and validates its boolean shape', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ needsSetup: true }))
      .mockResolvedValueOnce(Response.json({ needsSetup: false }))
      .mockResolvedValueOnce(Response.json({ users: [] }));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchSetupStatus()).toBe(true);
    expect(await fetchSetupStatus()).toBe(false);
    await expect(fetchSetupStatus()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledWith('/api/setup/status', { cache: 'no-store' });
  });
  it.each([
    [403, 'Invalid Setup Code', '不正确', false],
    [403, 'Setup Code Expired', '过期', false],
    [429, 'Too Many Attempts', '一分钟', false],
    [409, 'Setup Unavailable', '已关闭', true],
    [403, 'Invalid Origin', '访问网址', false],
    [500, 'secret SQL', '创建失败', false],
  ])('maps error %s/%s without displaying internal text', async (status, error, text, closed) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error }, { status })));
    expect(await submitSetup({ username: 'admin', email: 'a@b.com', password: 'password', setupCode: 'secret' })).toMatchObject({ ok: false, closed, message: expect.stringContaining(text) });
  });
  it('submits JSON only to the same-origin setup endpoint and recognizes success', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ status: 'created' }, { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    const input = { username: 'admin', email: 'a@b.com', password: 'password', setupCode: 'secret' };
    expect(await submitSetup(input)).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith('/api/setup/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  });
});
