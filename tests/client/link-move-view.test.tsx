import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LinkMove } from '../../src/client/LinkMove.js';

const props = { id: 3, title: '完整中文网址名称', index: 27, total: 100, isBusy: false, isEditing: false,
  scope: 'personal' as const, controls: { activeId: null as number | null, open: vi.fn(), submit: vi.fn() } };

describe('compact link move control', () => {
  it('renders only the explicit trigger by default', () => {
    const html = renderToStaticMarkup(<LinkMove {...props} />);
    expect(html).toContain('移动 完整中文网址名称');
    expect(html).not.toContain('<form');
  });
  it('shows full position, native input and confirm/cancel only for the active row', () => {
    const html = renderToStaticMarkup(<LinkMove {...props} controls={{ ...props.controls, activeId: 3 }} />);
    expect(html).toContain('当前第 28 位，共 100 条');
    expect(html).toContain('type="number"');
    expect(html).toContain('value="28"');
    for (const label of ['置顶', '置底', '确认移动', '取消']) expect(html).toContain(label);
  });
  it('public management explains that hidden links are counted', () => {
    const html = renderToStaticMarkup(<LinkMove {...props} scope="admin" controls={{ ...props.controls, activeId: 3 }} />);
    expect(html).toContain('包含隐藏网址');
  });
  it.each([{ total: 1 }, { isBusy: true }, { isEditing: true }])('disables unavailable moves %j', (overrides) => {
    expect(renderToStaticMarkup(<LinkMove {...props} {...overrides} />)).toContain('disabled=""');
  });
});
