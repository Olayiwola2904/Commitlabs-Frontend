/**
 * src/types/commitment.ts
 *
 * Public-facing commitment types used across the frontend.
 * Mirrors the domain shapes in src/lib/types/domain.ts but exposes a
 * stable, UI-oriented interface that isn't tied to the backend internals.
 */

export type CommitmentStatus = 'Active' | 'Settled' | 'Violated' | 'Early Exit';

export type CommitmentType = 'Safe' | 'Balanced' | 'Aggressive';

export type IdempotencyKey = string;

export type CommitmentOperationStatus = 'idle' | 'pending' | 'succeeded' | 'failed' | 'cancelled';

export type CommitmentStatusTransitions = {
  readonly [S in CommitmentStatus]?: readonly CommitmentStatus[];
};

export const COMMIDMENT_STATUS_TRANSITIONS: CommitmentStatusTransitions = {
  Active: ['Settled', 'Violated', 'Early Exit'],
  Settled: [],
  Violated: [],
  'Early Exit': [],
} as const;

export function canTransitionCommitmentStatus(from: CommitmentStatus, to: CommitmentStatus): boolean {
  return COMMIDMENT_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

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
  idempotencyKey?: IdempotencyKey;
  operationStatus?: CommitmentOperationStatus;
  lastOperationAt?: string;
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

export type CommitmentOperationStatusTransitions = {
  readonly [S in CommitmentOperationStatus]?: readonly CommitmentOperationStatus[];
};

export const COMMITMENT_OPERATION_STATUS_TRANSITIONS: CommitmentOperationStatusTransitions = {
  idle: ['pending'],
  pending: ['succeeded', 'failed', 'cancelled'],
  failed: ['pending', 'cancelled'],
  succeeded: [],
  cancelled: [],
} as const;

export function canTransitionCommitmentOperationStatus(
  from: CommitmentOperationStatus,
  to: CommitmentOperationStatus,
): boolean {
  return COMMITMENT_OPERATION_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isDuplicatePendingSubmission(
  existing: Pick<Commitment, 'idempotencyKey' | 'operationStatus'>,
  incomingKey: IdempotencyKey,
): boolean {
  return existing.idempotencyKey === incomingKey && existing.operationStatus === 'pending';
}

export function isRetryableFailure(
  operationStatus: CommitmentOperationStatus,
  attempts: number,
  maxAttempts: number,
): boolean {
  return operationStatus === 'failed' && attempts >= 0 && attempts < maxAttempts;
}

export function isStaleVersion(expectedVersion: number | undefined, actualVersion: number | undefined): boolean {
  return expectedVersion !== undefined && expectedVersion !== actualVersion;
}

export function nextVersion(version: number | undefined): number {
  return (version ?? 0) + 1;
}