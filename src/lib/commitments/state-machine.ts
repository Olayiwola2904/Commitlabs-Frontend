/**
 * Commitment state machine for the Commitments API.
 *
 * This module defines the core domain invariants for commitment lifecycle
 * transitions. It provides pure functions to create and transition
 * commitment records, enforcing:
 *
 * - Deterministic state transitions (a single valid target per event).
 * - No transitions out of terminal states (confirmed, rejected, cancelled, expired).
 * - A single in-flight submission per commitment (currentSubmissionId).
 * - Stale responses (wrong submissionId) are rejected.
 * - Duplicate-submission protection via idempotency key at creation time.
 * - Explicit retry from failed state; never automatic/on-chain repeated action.
 */

export type CommitmentState =
  | 'pending'
  | 'submitting'
  | 'failed'
  | 'confirmed'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export interface Commitment {
  /** Unique identifier for the commitment. */
  id: string;
  /** Client-provided idempotency key used to dedupe create requests. */
  idempotencyKey: string;
  /** Current lifecycle state. */
  state: CommitmentState;
  /** Number of submission attempts (0 before first submit). */
  attempt: number;
  /** Identifier of the current in-flight submission attempt, if any. */
  currentSubmissionId: string | null;
  /** Hash of the successful on-chain transaction, if confirmed. */
  transactionHash?: string;
  /** Human-readable error/reason from the last failed/rejected attempt. */
  lastError?: string;
  /** Creation timestamp. */
  createdAt: Date;
  /** Last update timestamp. */
  updatedAt: Date;
  /** Optional deadline after which the commitment may expire. */
  expiresAt?: Date;
}

export type CommitmentEvent =
  | { type: 'submit'; submissionId: string }
  | { type: 'success'; submissionId: string; transactionHash: string }
  | { type: 'reject'; submissionId: string; reason?: string }
  | { type: 'error'; submissionId: string; error: string }
  | { type: 'cancel'; reason?: string }
  | { type: 'expire' };

/** States from which no further transitions are allowed. */
export const TERMINAL_STATES: ReadonlySet<CommitmentState> = new Set<CommitmentState>([
  'confirmed',
  'rejected',
  'cancelled',
  'expired',
]);

/** States from which a new submission attempt may be started. */
export const SUBMITTABLE_STATES: ReadonlySet<CommitmentState> = new Set<CommitmentState>([
  'pending',
  'failed',
]);

export class CommitmentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitmentStateError';
  }
}

export class StaleSubmissionError extends CommitmentStateError {
  constructor(message: string) {
    super(message);
    this.name = 'StaleSubmissionError';
  }
}

/** Returns true if the state is terminal and cannot accept any further events. */
export function isTerminalState(state: CommitmentState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Returns true if, at a high level, the event may be allowed from the given state. */
export function canTransition(state: CommitmentState, event: CommitmentEvent): boolean {
  switch (state) {
    case 'pending':
      return event.type === 'submit' || event.type === 'cancel' || event.type === 'expire';
    case 'submitting':
      return (
        event.type === 'success' ||
        event.type === 'reject' ||
        event.type === 'error' ||
        event.type === 'cancel'
      );
    case 'failed':
      return event.type === 'submit' || event.type === 'cancel' || event.type === 'expire';
    default:
      return false;
  }
}

/**
 * Creates a new commitment in the 'pending' state.
 *
 * @throws CommitmentStateError if required fields are missing.
 */
export function createCommitment(input: {
  id: string;
  idempotencyKey: string;
  expiresAt?: Date;
}): Commitment {
  if (!input.id || !input.idempotencyKey) {
    throw new CommitmentStateError('id and idempotencyKey are required');
  }
  const now = new Date();
  return {
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    state: 'pending',
    attempt: 0,
    currentSubmissionId: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: input.expiresAt,
  };
}

/**
 * Applies an event to a commitment and returns a new commitment representing
 * the next state. The original commitment is not mutated.
 *
 * @param commitment The current commitment.
 * @param event      The event to apply.
 * @returns A new commitment with the next state.
 * @throws CommitmentStateError for invalid state transitions.
 * @throws StaleSubmissionError when a response carries a stale submissionId.
 */
export function transition(commitment: Commitment, event: CommitmentEvent): Commitment {
  const now = new Date();

  // Terminal states reject all events.
  if (isTerminalState(commitment.state)) {
    throw new CommitmentStateError(
      `Cannot apply event "${event.type}" to terminal state "${commitment.state}"`,
    );
  }

  // High-level transition validity.
  if (!canTransition(commitment.state, event)) {
    throw new CommitmentStateError(
      `Cannot apply event "${event.type}" in state "${commitment.state}"`,
    );
  }

  switch (event.type) {
    case 'submit': {
      const attempt = commitment.state === 'pending' ? 1 : commitment.attempt + 1;
      return {
        ...commitment,
        state: 'submitting',
        attempt,
        currentSubmissionId: event.submissionId,
        lastError: undefined,
        updatedAt: now,
      };
    }

    case 'success':
    case 'reject':
    case 'error': {
      // Must be exactly in 'submitting' with the matching submission id.
      if (commitment.state !== 'submitting') {
        throw new CommitmentStateError(
          `Cannot apply event "${event.type}" unless state is "submitting" (current: "${commitment.state}")`,
        );
      }
      if (commitment.currentSubmissionId !== event.submissionId) {
        throw new StaleSubmissionError(
          `Submission id "${event.submissionId}" does not match current submission ` +
            `"${commitment.currentSubmissionId}"`,
        );
      }

      const base = {
        ...commitment,
        currentSubmissionId: null,
        updatedAt: now,
      };

      if (event.type === 'success') {
        return {
          ...base,
          state: 'confirmed',
          transactionHash: event.transactionHash,
          lastError: undefined,
        };
      }
      if (event.type === 'reject') {
        return {
          ...base,
          state: 'rejected',
          lastError: event.reason ?? 'Rejected by user',
        };
      }
      // error
      return {
        ...base,
        state: 'failed',
        lastError: event.error,
      };
    }

    case 'cancel': {
      return {
        ...commitment,
        state: 'cancelled',
        currentSubmissionId: null,
        lastError: event.reason,
        updatedAt: now,
      };
    }

    case 'expire': {
      if (commitment.expiresAt && commitment.expiresAt > now) {
        // Invariant: expiration event only valid after expiry timestamp.
        throw new CommitmentStateError(
          'Cannot expire before the configured expiration time',
        );
      }
      return {
        ...commitment,
        state: 'expired',
        currentSubmissionId: null,
        updatedAt: now,
      };
    }

    default:
      throw new Error(`Unsupported event type: ${(event as CommitmentEvent).type}`);
  }
}

/**
 * Verifies that an incoming create request is idempotent with the stored commitment.
 *
 * If a commitment with the same idempotency key exists:
 * - If it has the same id, it's a retry; the stored commitment should be returned.
 * - If it has a different id, the request is invalid (duplicate idempotency key).
 */
export function assertIdempotencyMatch(existing: Commitment | null, input: { id: string; idempotencyKey: string }): void {
  if (!existing) return;
  if (existing.idempotencyKey === input.idempotencyKey && existing.id !== input.id) {
    throw new CommitmentStateError(
      `Idempotency key "${input.idempotencyKey}" is already used by commitment "${existing.id}"`,
    );
  }
}
