import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { confirmationSucceeded, type ConfirmationRequest } from './use-confirmation.js';

/** Native top-layer modality, with an explicit keyboard loop and return target. */
export function ModalDialog({ title, description, busy, returnFocus, initialFocusRef, onDismiss, children }: {
  title: string;
  description?: string;
  busy: boolean;
  returnFocus: HTMLElement | null;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    initialFocusRef?.current?.focus();
    return () => {
      dialog.close();
      // A successful mutation may remove or briefly disable its original button.
      requestAnimationFrame(() => {
        if (document.querySelector('dialog[open]')) return;
        const target = returnFocus?.isConnected && !returnFocus.matches(':disabled')
          ? returnFocus : document.getElementById('main-content');
        target?.focus({ preventScroll: true });
      });
    };
  }, [returnFocus, initialFocusRef]);

  return <dialog ref={dialogRef} className="modal-dialog" aria-modal="true"
    aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}
    aria-busy={busy} tabIndex={-1}
    onCancel={(event) => { event.preventDefault(); if (!busy) onDismiss(); }}
    onClose={(event) => { if (!event.currentTarget.open && !busy) onDismiss(); }}
    onPaste={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const dialog = event.currentTarget;
      const targets = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href], [tabindex="0"]',
      )).filter((target) => !target.matches(':disabled, [hidden]') && target.getClientRects().length > 0);
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (active === last || active === dialog)) {
        event.preventDefault(); first.focus();
      }
    }}>
    <h2 id={titleId}>{title}</h2>
    {description ? <p id={descriptionId}>{description}</p> : null}
    {children}
  </dialog>;
}

export function ConfirmDialog({ request, onDismiss }: {
  request: ConfirmationRequest | null;
  onDismiss: () => void;
}) {
  return request === null ? null : <Confirmation key={request.title + request.message} request={request} onDismiss={onDismiss} />;
}

function Confirmation({ request, onDismiss }: { request: ConfirmationRequest; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const busyRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (error && !busy) cancelRef.current?.focus();
  }, [error, busy]);

  return <ModalDialog title={request.title} description={request.message} busy={busy}
    returnFocus={request.trigger} initialFocusRef={cancelRef} onDismiss={onDismiss}>
    {error ? <p className="personal__error" role="alert">操作未完成，请稍后再试。</p> : null}
    <div className="modal-dialog__actions">
      <button ref={cancelRef} className="personal__button" type="button" disabled={busy} onClick={onDismiss}>取消</button>
      <button className="personal__button modal-dialog__danger" type="button" disabled={busy} onClick={() => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        setError(false);
        void confirmationSucceeded(request.onConfirm).then((succeeded) => {
          if (succeeded) {
            onDismiss();
            return;
          }
          busyRef.current = false;
          setBusy(false);
          setError(true);
        });
      }}>{busy ? '处理中…' : request.actionLabel}</button>
    </div>
  </ModalDialog>;
}
