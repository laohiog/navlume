import { describe, expect, it, vi } from 'vitest';
import { confirmationSucceeded } from '../../src/client/use-confirmation.js';

describe('confirmation mutation result', () => {
  it('accepts explicit ok and executes the owning action exactly once', async () => {
    const onConfirm = vi.fn().mockResolvedValue({ status: 'ok', data: { retained: true } });
    await expect(confirmationSucceeded(onConfirm)).resolves.toBe(true);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'forbidden', 'unauthenticated', 'invalid', 'notfound', 'conflict'])(
    'treats fulfilled %s as failure without swallowing the owning action', async (status) => {
      const ownerHandling = vi.fn();
      const onConfirm = vi.fn(async () => {
        ownerHandling(status);
        return { status };
      });
      await expect(confirmationSucceeded(onConfirm)).resolves.toBe(false);
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(ownerHandling).toHaveBeenCalledWith(status);
    },
  );

  it('contains a synchronous throw', async () => {
    await expect(confirmationSucceeded(() => { throw new Error('private detail'); })).resolves.toBe(false);
  });

  it('contains a rejected promise', async () => {
    await expect(confirmationSucceeded(() => Promise.reject(new Error('private detail')))).resolves.toBe(false);
  });

  it('waits for the owning action to settle without executing it again', async () => {
    let resolve!: (result: { status: string }) => void;
    const onConfirm = vi.fn(() => new Promise<{ status: string }>((done) => { resolve = done; }));
    const settled = vi.fn();
    const pending = confirmationSucceeded(onConfirm).then(settled);
    await Promise.resolve();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    resolve({ status: 'error' });
    await pending;
    expect(settled).toHaveBeenCalledExactlyOnceWith(false);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
