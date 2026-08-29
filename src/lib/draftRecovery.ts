// State machine for the commitment creation wizard and draft recovery.
// Invariants:
// - Only one active submission at a time: SUBMIT is ignored if already submitting.
// - SUCCESS/FAILURE events must match the current submission id, preventing stale responses.
// - CANCEL is allowed from draft, submitting, or failed, but never overrides a confirmed commitment.
// - RETRY is only allowed from failed and always clears the submission id.
// - RECOVER never overwrites an in-flight or confirmed state, and converts any persisted
//   "submitting" state to "failed" so the user must explicitly verify/retry instead of
//   silently repeating an on-chain action.

export interface DraftState {
  status: 'draft' | 'submitting' | 'confirmed' | 'failed' | 'cancelled';
  step?: number;
  data?: unknown;
  id?: string | null;
  error?: string | null;
  owner?: string | null;
  updatedAt?: number;
}

export function reduce(state: DraftState | undefined, event: any): DraftState {
  const s: DraftState = state ?? { status: 'draft' } as DraftState;
  const n = Date.now();
  const ok = (patch: Partial<DraftState>):$DraftState => ({ ...s, ...patch, updatedAt: n });

  switch (event.type) {
    case 'START':
      // Starting a new draft must not clobber an active submission or confirmed commitment.
      if (s.status === 'submitting' || s.status === 'confirmed') return s;
      return ok({
        status: 'draft',
        step: event.step,
        data: event.data,
        id: null,
        error: null,
      });

    case 'SUBMIT':
      // Only allow submit from draft or failed, and never without a unique submission id.
      if ((s.status === 'draft' || s.status === 'failed') && !s.id && event.id) {
        return ok({ status: 'submitting', id: event.id, error: null });
      }
      return s;

    case 'SUCCESS':
      // Stale or mismatched success events must be ignored.
      if (s.status === 'submitting' && s.id === event.id) {
        return ok({ status: 'confirmed' });
      }
      return s;

    case 'FAILURE':
      // Stale or mismatched failure events must be ignored.
      if (s.status === 'submitting' && s.id === event.id) {
        return ok({ status: 'failed', error: event.error || 'Commitment failed', id: null });
      }
      return s;

    case 'CANCEL':
      // Cancellation is allowed from any non-final state (not confirmed).
      if (s.status === 'draft' || s.status === 'submitting' || s.status === 'failed') {
        return ok({ status: 'cancelled', id: null });
      }
      return s;

    case 'RETRY':
      if (s.status === 'failed') {
        return ok({ status: 'draft', id: null, error: null });
      }
      return s;

    case 'RECOVER':
      // Do not override an in-flight or already confirmed state.
      if (s.status === 'submitting' || s.status === 'confirmed') return s;
      const from = event.from;
      if (from && typeof from === 'object') {
        // If the previous state was 'submitting', we cannot know whether the on-chain
        // action completed, so convert to 'failed' to force explicit user verification.
        const recoveredStatus = from.status === 'submitting' ? 'failed' : (from.status || 'draft');
        const recoveredError = from.status === 'submitting' ? 'recovered' : from.error;
        return ok({
          status: recoveredStatus,
          step: from.step,
          data: from.data,
          owner: from.owner ?? s.owner,
          id: null,
          error: recoveredError,
        });
      }
      return s;

    default:
      return s;
  }
}
