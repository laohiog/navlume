import { useState } from 'react';

export interface ConfirmationRequest {
  title: string;
  message: string;
  actionLabel: string;
  onConfirm: () => Promise<{ status: string }>;
  trigger: HTMLElement | null;
}

/** A fulfilled mutation can still be a failure; only its explicit status counts. */
export async function confirmationSucceeded(onConfirm: ConfirmationRequest['onConfirm']): Promise<boolean> {
  try {
    return (await onConfirm()).status === 'ok';
  } catch {
    return false;
  }
}

/** Each existing view keeps ownership of the operation it already performed. */
export function useConfirmation() {
  const [request, setRequest] = useState<ConfirmationRequest | null>(null);
  return {
    request,
    dismiss: () => setRequest(null),
    confirm: (options: Omit<ConfirmationRequest, 'trigger'>) => {
      if (document.querySelector('dialog[open]')) return;
      setRequest({ ...options, trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null });
    },
  };
}
