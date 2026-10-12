/**
 * Pure state machine for one import/export panel (P6.1).
 *
 * Extracted from the React component so the destructive-path rules can be tested
 * directly rather than only observed through rendered markup. The component owns
 * nothing but this state and the async plumbing around it.
 *
 * ## The rules this encodes
 *
 * 1. **A preview authorizes exactly one document.** `previewOf` holds the document
 *    object the summary was computed from, and `canApply` compares identity, not
 *    content. Editing the text yields a new parsed object, so any edit — even one
 *    that produces identical content — invalidates the previous preview. A summary
 *    of document A is therefore never permission to import document B.
 * 2. **A preview is not a credential.** Confirmation always resets when a new
 *    preview is produced or when the document changes, so the checkbox can never
 *    carry over from an earlier, different preview.
 * 3. **Apply requires both a fresh preview and explicit confirmation.** Neither is
 *    derived from the other; a missing `confirm: true` also fails on the server.
 * 4. **A successful apply consumes the preview.** Clearing `previewOf` means the
 *    same document cannot be applied twice by a double click or a re-render.
 * 5. **A failed apply keeps the preview but re-arms confirmation.** The server
 *    applies atomically, so nothing changed; the user may retry deliberately.
 *
 * Document identity is compared by reference, which is why the state stores the
 * document objects rather than a serialized copy.
 */

/** A parsed JSON document. Opaque here; only identity matters. */
export type FlowDocument = object;

export interface PortabilityFlowState<Doc extends FlowDocument = FlowDocument, Summary = unknown> {
  /** The document currently parsed from the textarea, or `null` if none. */
  document: Doc | null;
  /** The document a summary was computed from, or `null` if never previewed. */
  previewOf: Doc | null;
  /** Summary returned by the server for `previewOf`. */
  summary: Summary | null;
  /** Whether the user has ticked the destructive-action confirmation. */
  confirmed: boolean;
}

export function initialPortabilityFlow<
  Doc extends FlowDocument = FlowDocument,
  Summary = unknown,
>(): PortabilityFlowState<Doc, Summary> {
  return { document: null, previewOf: null, summary: null, confirmed: false };
}

/**
 * Record a newly parsed document, invalidating any preview and confirmation.
 *
 * Passing `null` (empty or unparseable input) clears the document entirely.
 */
export function documentAccepted<Doc extends FlowDocument, Summary>(
  _state: PortabilityFlowState<Doc, Summary>,
  document: Doc | null,
): PortabilityFlowState<Doc, Summary> {
  return {
    document,
    previewOf: null,
    summary: null,
    confirmed: false,
  };
}

/** Record a successful preview. The confirmation is always re-armed. */
export function previewSucceeded<Doc extends FlowDocument, Summary>(
  state: PortabilityFlowState<Doc, Summary>,
  document: Doc,
  summary: Summary,
): PortabilityFlowState<Doc, Summary> {
  return { document: state.document, previewOf: document, summary, confirmed: false };
}

/**
 * Record a failed preview; nothing is authorized.
 *
 * The document is retained so the user can correct the text without re-parsing,
 * but no preview and no confirmation survive.
 */
export function previewFailed<Doc extends FlowDocument, Summary>(
  state: PortabilityFlowState<Doc, Summary>,
): PortabilityFlowState<Doc, Summary> {
  return { document: state.document, previewOf: null, summary: null, confirmed: false };
}


/** Toggle the destructive-action confirmation. */
export function confirmationChanged<Doc extends FlowDocument, Summary>(
  state: PortabilityFlowState<Doc, Summary>,
  confirmed: boolean,
): PortabilityFlowState<Doc, Summary> {
  return { ...state, confirmed };
}

/** Record a successful apply, consuming the preview so it cannot be replayed. */
export function applySucceeded<Doc extends FlowDocument, Summary>(
  state: PortabilityFlowState<Doc, Summary>,
): PortabilityFlowState<Doc, Summary> {
  return { document: state.document, previewOf: null, summary: null, confirmed: false };
}

/**
 * Record a failed apply.
 *
 * The preview stays usable because the server changed nothing, but the
 * confirmation is re-armed so a retry is always a deliberate act.
 */
export function applyFailed<Doc extends FlowDocument, Summary>(
  state: PortabilityFlowState<Doc, Summary>,
): PortabilityFlowState<Doc, Summary> {
  return { ...state, confirmed: false };
}

/* -------------------------------------------------------------------------- */
/* Identity generation guard                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A monotonic identity/session generation.
 *
 * Incremented synchronously the moment teardown begins (logout), *before* any
 * `await`, so async work started under an earlier identity is detectable the
 * instant it completes — independently of whether React has re-rendered, whether
 * the session has refetched, or whether the panel is still mounted.
 */
export type IdentityGeneration = number;

/**
 * Capture the current generation immediately before starting async work.
 *
 * This must be called **before the first `await`**. Capturing it afterwards
 * defeats the guard entirely: a teardown that already happened would be folded
 * into the captured value and the stale completion would look current.
 */
export function captureGeneration(generation: IdentityGeneration): IdentityGeneration {
  return generation;
}

/**
 * True when async work captured `captured` still belongs to the live identity.
 *
 * A `false` result means the completion is **stale**: the caller must not save a
 * file, render a preview or error, re-arm confirmation, show success, or trigger
 * any protected refetch.
 */
export function isCurrentGeneration(
  captured: IdentityGeneration,
  current: IdentityGeneration,
): boolean {
  return captured === current;
}

/** True when the stored summary describes the currently parsed document. */
export function hasFreshPreview<Doc extends FlowDocument, Summary>(
  state: PortabilityFlowState<Doc, Summary>,
): boolean {
  return state.previewOf !== null && state.previewOf === state.document;
}

/**
 * True when applying is permitted: a fresh preview for the current document, an
 * explicit confirmation, and no request in flight.
 */
export function canApply<Doc extends FlowDocument, Summary>(
  state: PortabilityFlowState<Doc, Summary>,
  isBusy: boolean,
): boolean {
  return hasFreshPreview(state) && state.confirmed && !isBusy;
}
