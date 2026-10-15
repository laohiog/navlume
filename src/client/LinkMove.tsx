import { useId, useRef, useState } from 'react';
import { parseLinkPosition, type LinkMoveControls } from './link-reorder.js';

/** One inline form shared by personal organization and public administration. */
export function LinkMove({ id, title, index, total, isBusy, isEditing, scope, controls }: {
  id: number; title: string; index: number; total: number; isBusy: boolean; isEditing: boolean;
  scope: 'personal' | 'admin'; controls: LinkMoveControls;
}) {
  const formId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const [position, setPosition] = useState(String(index + 1));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const active = controls.activeId === id;
  const busy = isBusy || pending;
  const buttonClass = `${scope}__button`;
  const close = () => {
    controls.open(null);
    requestAnimationFrame(() => {
      if (trigger.current?.isConnected) {
        trigger.current.focus({ preventScroll: true });
        trigger.current.scrollIntoView({ block: 'nearest' });
      }
    });
  };
  return <div className="link-move">
    <button ref={trigger} type="button" className={buttonClass} aria-label={`移动 ${title}`}
      aria-expanded={active} aria-controls={active ? formId : undefined}
      disabled={busy || isEditing || total < 2} onClick={() => {
        if (active) close();
        else {
          setPosition(String(index + 1));
          setError(null);
          controls.open(id);
        }
      }}>移动</button>
    {active ? <div className="link-move__panel"><form id={formId} className="link-move__form" noValidate aria-label={`移动「${title}」`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); close(); }
      }} onSubmit={(event) => {
        event.preventDefault();
        if (busy || submitting.current) return;
        const value = parseLinkPosition(position, total);
        if (value === null) { setError(`请输入 1 到 ${total} 之间的整数。`); input.current?.focus(); return; }
        submitting.current = true;
        setPending(true);
        setError(null);
        void controls.submit(id, value).then((result) => {
          if (!trigger.current?.isConnected || result.status === 'cancelled') return;
          if (result.status === 'ok' || result.status === 'unchanged') close();
          else if (result.status === 'error') { setError(result.message); requestAnimationFrame(() => input.current?.focus({ preventScroll: true })); }
        }).catch(() => {
          if (trigger.current?.isConnected) { setError('未能确认保存结果，请重新读取后重试。'); requestAnimationFrame(() => input.current?.focus()); }
        }).finally(() => { submitting.current = false; setPending(false); });
      }}>
      <strong>移动「{title}」</strong>
      <p>当前第 {index + 1} 位，共 {total} 条。{scope === 'admin' ? '包含隐藏网址。' : '位置按完整分类计算。'}</p>
      <label className="link-move__position">移动到第
        <input ref={input} autoFocus type="number" inputMode="numeric" aria-label="最终位置"
          min={1} max={total} step={1} value={position} disabled={busy}
          aria-invalid={error !== null} aria-describedby={error ? `${formId}-error` : undefined}
          onChange={(event) => { setPosition(event.target.value); setError(null); }} />位
      </label>
      <div className="link-move__actions">
        <button className={buttonClass} type="button" disabled={busy} onClick={() => setPosition('1')}>置顶</button>
        <button className={buttonClass} type="button" disabled={busy} onClick={() => setPosition(String(total))}>置底</button>
        <button className={`${buttonClass} ${buttonClass}--primary`} type="submit" disabled={busy}>{busy ? '正在保存…' : '确认移动'}</button>
        <button className={buttonClass} type="button" disabled={busy} onClick={close}>取消</button>
      </div>
      {error ? <p id={`${formId}-error`} className="link-move__error" role="alert">{error}</p> : null}
    </form></div> : null}
  </div>;
}
