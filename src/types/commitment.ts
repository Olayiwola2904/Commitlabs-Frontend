export type CommitmentStatus = 'Active'|'Settled'|'Violated'|'Early Exit';
export type CommitmentType = 'Safe'|'Balanced'|'Aggressive';
export type IdempotencyKey = string;
export type CommitmentOperationStatus = 'idle'|'pending'|'succeeded'|'failed'|'cancelled';
export type CommitmentStatusTransitions = {readonly[S in CommitmentStatus]?:readonly CommitmentStatus[]};
export const COMMITMENT_STATUS_TRANSITIONS: CommitmentStatusTransitions = {Active:['Settled','Violated','Early Exit'],Settled:[],Violated:[],'Early Exit':[]} as const;
export function canTransitionCommitmentStatus(from: CommitmentStatus,to: CommitmentStatus): boolean { return COMMITMENT_STATUS_TRANSITIONS[from]?.includes(to) ?? false; }
export interface Commitment { id: string; type: CommitmentType; status: CommitmentStatus; ownerAddress?: string; asset: string; amount: string; currentValue?: string; changePercent?: number; durationProgress?: number; daysRemaining?: number; complianceScore?: number; maxLoss?: string; currentDrawdown?: string; idempotencyKey?: IdempotencyKey; operationStatus?: CommitmentOperationStatus; operationError?: string; operationAttempts?: number; lastOperationAt?: string; version?: number; createdDate?: string; expiryDate?: string; createdAt?: string; expiresAt?: string; }
