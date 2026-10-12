import { describe, expect, it } from 'vitest';

import {
  applyFailed,
  applySucceeded,
  canApply,
  captureGeneration,
  confirmationChanged,
  documentAccepted,
  hasFreshPreview,
  initialPortabilityFlow,
  isCurrentGeneration,
  previewFailed,
  previewSucceeded,
  type PortabilityFlowState,
} from '../../src/client/portability-flow.js';

interface Summary {
  incomingLinks: number;
}

type Flow = PortabilityFlowState<Record<string, unknown>, Summary>;

const SUMMARY: Summary = { incomingLinks: 3 };

function initial(): Flow {
  return initialPortabilityFlow<Record<string, unknown>, Summary>();
}

/** A flow sitting at "previewed, confirmed, ready to apply" for `doc`. */
function ready(doc: Record<string, unknown> = { type: 'personal' }): Flow {
  const accepted = documentAccepted(initial(), doc);
  const previewed = previewSucceeded(accepted, doc, SUMMARY);
  return confirmationChanged(previewed, true);
}

describe('initial state', () => {
  it('authorizes nothing', () => {
    const state = initial();

    expect(state.document).toBeNull();
    expect(state.previewOf).toBeNull();
    expect(state.summary).toBeNull();
    expect(state.confirmed).toBe(false);
    expect(hasFreshPreview(state)).toBe(false);
    expect(canApply(state, false)).toBe(false);
  });
});

describe('preview binding', () => {
  it('marks a preview fresh only for the exact previewed document', () => {
    const doc = { type: 'personal' };
    const state = previewSucceeded(documentAccepted(initial(), doc), doc, SUMMARY);

    expect(hasFreshPreview(state)).toBe(true);
  });

  it('invalidates the preview when the document changes, even to equal content', () => {
    const first = { type: 'personal', value: 1 };
    const previewed = previewSucceeded(documentAccepted(initial(), first), first, SUMMARY);

    // A structurally identical but distinct object: content equality must not be
    // mistaken for identity, because the summary may have been computed from a
    // different payload that merely serializes the same way.
    const second = { type: 'personal', value: 1 };
    const replaced = documentAccepted(previewed, second);

    expect(hasFreshPreview(replaced)).toBe(false);
    expect(replaced.summary).toBeNull();
    expect(replaced.confirmed).toBe(false);
  });

  it('clears document, preview, and confirmation on empty input', () => {
    const cleared = documentAccepted(ready(), null);

    expect(cleared.document).toBeNull();
    expect(cleared.previewOf).toBeNull();
    expect(cleared.summary).toBeNull();
    expect(cleared.confirmed).toBe(false);
  });
});

describe('confirmation', () => {
  it('cannot be satisfied by a preview alone', () => {
    const doc = { type: 'personal' };
    const state = previewSucceeded(documentAccepted(initial(), doc), doc, SUMMARY);

    expect(hasFreshPreview(state)).toBe(true);
    expect(state.confirmed).toBe(false);
    expect(canApply(state, false)).toBe(false);
  });

  it('is cleared by every new preview', () => {
    const confirmed = confirmationChanged(initial(), true);
    const doc = { type: 'personal' };
    const previewed = previewSucceeded(documentAccepted(confirmed, doc), doc, SUMMARY);

    expect(previewed.confirmed).toBe(false);
  });

  it('is toggled explicitly', () => {
    const on = confirmationChanged(initial(), true);
    expect(on.confirmed).toBe(true);

    const off = confirmationChanged(on, false);
    expect(off.confirmed).toBe(false);
  });
});

describe('apply gating', () => {
  it('allows apply only with a fresh preview and confirmation', () => {
    expect(canApply(ready(), false)).toBe(true);
  });

  it('is blocked while a request is in flight', () => {
    expect(canApply(ready(), true)).toBe(false);
  });

  it('is blocked after a failed preview', () => {
    const failed = previewFailed(documentAccepted(initial(), { type: 'personal' }));

    expect(hasFreshPreview(failed)).toBe(false);
    expect(canApply(confirmationChanged(failed, true), false)).toBe(false);
  });

  it('is blocked once the preview was consumed', () => {
    const after = applySucceeded(ready());

    expect(hasFreshPreview(after)).toBe(false);
    expect(canApply(after, false)).toBe(false);
  });
});

describe('apply outcomes', () => {
  it('consumes the preview and the confirmation on success', () => {
    const doc = { type: 'personal' };
    const state = applySucceeded(ready(doc));

    expect(state.document).toBe(doc);
    expect(state.previewOf).toBeNull();
    expect(state.summary).toBeNull();
    expect(state.confirmed).toBe(false);
  });

  it('prevents a replay of the same document after success', () => {
    const doc = { type: 'personal' };
    const after = applySucceeded(ready(doc));

    // Ticking the box again is not enough: a new preview is mandatory.
    const rearmed = confirmationChanged(after, true);
    expect(canApply(rearmed, false)).toBe(false);

    // Only re-previewing the same document re-authorizes it.
    const repreviewed = previewSucceeded(after, doc, SUMMARY);
    expect(canApply(confirmationChanged(repreviewed, true), false)).toBe(true);
  });

  it('keeps the preview but re-arms confirmation on failure', () => {
    const doc = { type: 'personal' };
    const state = applyFailed(ready(doc));

    // Nothing changed server-side (apply is atomic), so the summary stays usable.
    expect(state.summary).toEqual(SUMMARY);
    expect(hasFreshPreview(state)).toBe(true);
    // But a retry is a deliberate act.
    expect(state.confirmed).toBe(false);
    expect(canApply(state, false)).toBe(false);
  });

  it('allows a deliberate retry after a failure', () => {
    const retried = confirmationChanged(applyFailed(ready()), true);

    expect(canApply(retried, false)).toBe(true);
  });
});

describe('transitions preserve the working document', () => {
  it('keeps the document across preview success, failure, apply success, and failure', () => {
    const doc = { type: 'personal' };
    const accepted = documentAccepted(initial(), doc);

    expect(previewSucceeded(accepted, doc, SUMMARY).document).toBe(doc);
    expect(previewFailed(accepted).document).toBe(doc);
    expect(applySucceeded(ready(doc)).document).toBe(doc);
    expect(applyFailed(ready(doc)).document).toBe(doc);
  });

  it('never lets a transition produce an unauthorized ready state out of nothing', () => {
    // Every transition applied to the initial state must keep apply disabled.
    const transitions = [
      previewFailed(initial()),
      applySucceeded(initial()),
      applyFailed(initial()),
      confirmationChanged(initial(), true),
      documentAccepted(initial(), null),
    ];

    for (const state of transitions) {
      expect(canApply(state, false), JSON.stringify(state)).toBe(false);
    }
  });
});

describe('summary is not carried across documents', () => {
  it('drops the summary when the document is replaced', () => {
    const first = { type: 'personal', version: 1 };
    const previewed = previewSucceeded(documentAccepted(initial(), first), first, {
      incomingLinks: 9,
    });

    const replaced = documentAccepted(previewed, { type: 'personal', version: 2 });

    expect(replaced.summary).toBeNull();
    expect(hasFreshPreview(replaced)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Identity generation guard (P6.1 F2)                                         */
/* -------------------------------------------------------------------------- */

describe('identity generation guard', () => {
  it('accepts work whose generation is unchanged', () => {
    const captured = captureGeneration(7);

    expect(isCurrentGeneration(captured, 7)).toBe(true);
  });

  it('rejects work once a logout advanced the generation', () => {
    const captured = captureGeneration(7);

    // Logout increments the generation before any await.
    expect(isCurrentGeneration(captured, 8)).toBe(false);
  });

  it('keeps rejecting after further identity changes', () => {
    const captured = captureGeneration(7);

    expect(isCurrentGeneration(captured, 9)).toBe(false);
    expect(isCurrentGeneration(captured, 100)).toBe(false);
  });

  it('accepts work started by a later login', () => {
    // A new session captures whatever the current generation is at that time.
    const afterLogout = captureGeneration(8);

    expect(isCurrentGeneration(afterLogout, 8)).toBe(true);
  });

  it('is monotonic: a captured generation never matches an older value', () => {
    // Guards against a wrap/reset implementation that would re-accept stale work.
    const stale = captureGeneration(5);

    for (const current of [6, 7, 8, 9]) {
      expect(isCurrentGeneration(stale, current)).toBe(false);
    }
  });

  it('distinguishes capture-before-await from capture-after-await', () => {
    // Models the F2 defect precisely: if the capture happened after the request
    // resolved, an intervening logout would be folded into the captured value and
    // the stale completion would be wrongly accepted.
    let generation = 7;

    const correctCapture = captureGeneration(generation); // before await
    generation += 1; // logout during the await

    const buggyCapture = captureGeneration(generation); // after await (the defect)

    expect(isCurrentGeneration(correctCapture, generation)).toBe(false);
    expect(isCurrentGeneration(buggyCapture, generation)).toBe(true);
  });
});
