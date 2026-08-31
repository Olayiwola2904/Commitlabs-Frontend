/**
 * src/types/commitment.ts
 *
 * Public-facing commitment types used across the frontend.
 * Mirrors the domain shapes in src/lib/types/domain.ts but exposes a
 * stable, UI-oriented interface that isn't tied to the backend internals.
 */

/** On-chain lifecycle states. */
export type CommitmentStatus = 'Active' | 'Settled' | 'Violated' | 'Early Exit';

/** Risk profile. */
export type CommitmentType = 'Safe' | 'Balanced' | 'Aggressive';

/**
 * Client-supplied key used for idempotent request deduplication.
 * Must be unique per user and commitment action to prevent duplicate submissions.
 */
export type IdempotencyKey = string;

/**
 * Tracks the processing state of an on-chain operation for a commitment.
 * Enables recovery and retry logic when a wallet operation is interrupted.
 */
export type CommitmentOperationStatus = 'idle' | 'pending' | 'succeeded' | 'failed';

/**
 * Defines the state machine for commitment lifecycle transitions.
 * Each entry maps a current status to the set of permissible next statuses.
 * Must reflect the backend's transition rules to ensure deterministic behavior.
 */
export type CommitmentStatusTransitions = {
  readonly [Status in CommitmentStatus]?: readonly CommitmentStatus[];
};

/** UI-facing commitment shape used by MyCommitmentsGrid and related views. */
export interface Commitment {
  id: string;
  type: CommitmentType;
  status: CommitmentStatus;
  ownerAddress?: string;
  asset: string;
  amount: string;
  currentValue?: string;
  changePercent?: number;
  durationProgress?: number;
  daysRemaining?: number;
  complianceScore?: number;
  maxLoss?: string;
  currentDrawdown?: string;
  /** Client-supplied idempotency key to prevent duplicate submissions. */
  idempotencyKey?: IdempotencyKey;
  /** Tracks the operation result to support retries and stale-response handling. */
  operationStatus?: CommitmentOperationStatus;
  /** Monotonic revision number; incremented on every accepted mutation. */
  version?: number;
  /** ISO-8601 date string (legacy field). */
  createdDate?: string;
  /** ISO-8601 date string (legacy field). */
  expiryDate?: string;
  /** ISO-8601 date string. */
  createdAt?: string;
  /** ISO-8601 date string. */
  expiresAt?: string;
}
