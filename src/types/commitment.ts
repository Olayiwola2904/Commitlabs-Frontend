export enum WizardStep {
  INPUT = 1,
  REVIEW = 2,
  WALLET = 3,
  DONE = 4,
}

export interface CommitmentFormData {
  selectedType?: string;
  amount?: string;
  asset?: string;
  durationDays?: number;
  recipient?: string;
  title?: string;
  description?: string;
}

export interface CommitmentDraft {
  id: string;
  step: number;
  data: CommitmentFormData;
  updatedAt: number;
  version: number;
}

export interface WizardError {
  code: string;
  message: string;
  fieldErrors?: Record<string, string>;
  retryable: boolean;
  cause?: unknown;
}

export interface SubmissionToken {
  id: string;
  createdAt: number;
  payloadHash: string;
  expiresAt: number;
}

export type WalletOutcome =
  | { status: 'confirmed'; txHash: string; commitmentId: string }
  | { status: 'rejected'; error: WizardError }
  | { status: 'cancelled'; error?: WizardError };

export type ConfirmedWalletOutcome = Extract<WalletOutcome, { status: 'confirmed' }>;

export type WizardState =
  | { status: 'idle' }
  | { status: 'editing'; draft: CommitmentDraft }
  | { status: 'submitting'; draft: CommitmentDraft; submission: SubmissionToken }
  | { status: 'waiting_confirmation'; draft: CommitmentDraft; submission: SubmissionToken; txHash?: string }
  | { status: 'success'; commitmentId: string; txHash: string }
  | { status: 'error'; error: WizardError; draft?: CommitmentDraft; submission?: SubmissionToken };

export type WizardEvent =
  | { type: 'START' }
  | { type: 'EDIT'; draft: CommitmentDraft }
  | { type: 'SAVE_DRAFT'; draft: CommitmentDraft }
  | { type: 'SUBMIT'; draft: CommitmentDraft; submission: SubmissionToken }
  | { type: 'CONFIRMATION_SUCCESS'; submission: SubmissionToken; outcome: ConfirmedWalletOutcome }
  | { type: 'CONFIRMATION_FAILURE'; submission: SubmissionToken; error: WizardError }
  | { type: 'CANCEL' }
  | { type: 'RESET' }
  | { type: 'RESUME'; draft: CommitmentDraft };

export interface WizardStateMachine {
  transition(state: WizardState, event: WizardEvent): WizardState;
}

export interface DraftRepository {
  save(draft: CommitmentDraft): Promise<void>;
  load(): Promise<CommitmentDraft null>;
  clear(): Promise<void>;
}

export type RecoveryResult =
  | { status: 'recovered'; draft: CommitmentDraft }
  | { status: 'none' }
  | { status: 'error'; error: WizardError };