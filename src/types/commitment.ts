/* *
 * This module defines the core types for the commitment creation wizard.
 * It establishes the explicit state machine, data invariants, and failure
 * recovery contracts used by the wizard implementation.
 */
 
/**
 * The steps a user can be in during the wizard flow.
 */
export enum WizardStep {
  INPUT = 'input',
  REVIEW = 'review',
  WALLET = 'wallet',
  DONE = 'done',
}
 
/**
 * The user-entered data for a commitment.
 * All fields are optional to support partial draft recovery.
 */
export interface CommitmentFormData {
  title?: string;
  description?: string;
  amount?: string;
  recipient?: string;
  // Add other commitment-specific fields as needed.
}
 
/**
 * A persisted snapshot of the wizard's progress.
 * This is what is stored for draft recovery.
 * Invariant: `data` must always be consistent with `step`; i.e.
 * the data is sufficient to render the wizard at that step.
 */
export interface CommitmentDraft {
  /** Unique identifier for the draft. */
  id: string;
  /** The most recent step reached. */
  step: WizardStep;
  /** User input captured so far. */
  data: CommitmentFormData;
  /** Last time the draft was updated. */
  updatedAt: number;
  /** Monotonic version to prevent stale overwrites. */
  version: number;
}
 
/**
 * Error information returned from a failed operation.
 */
export interface WizardError {
  /** Machine-readable error code. */
  code: string;
  /** Human-readable error message. */
  message: string;
  /** Field-specific validation errors, if any. */
  fieldErrors?: Record<string, string>;
  /** Whether the operation can be retried without side effects. */
  retryable: boolean;
  /** Underlying error for debugging (not shown to users). */
  cause?: unknown;
}
 
/**
 * Unique token for a single submission attempt.
 * Used to prevent duplicate submissions and stale responses.
 */
export interface SubmissionToken {
  /** Unique submission attempt ID. */
  id: string;
  /** Timestamp when the submission was initiated. */
  createdAt: number;
  /** Hash of the payload being submitted; used to validate responses. */
  payloadHash: string;
  /** After this timestamp, the submission is considered stale. */
  expiresAt: number;
}
 
/**
 * Possible outcomes after a wallet interaction.
 */
type WalletOutcome =
  | { status: 'confirmed'; txHash: string; commitmentId: string }
  | { status: 'rejected'; error: WizardError }
  | { status: 'cancelled'; error?: WizardError };
 
/**
 * The full state of the commitment creation wizard.
 * Discriminated union on `status` to make illegal states unrepresentable.
 *
 * Invariants:
 * - Only one active submission token can exist at a time.
 * - a `submitting` or `waiting_confirmation` state must always reference the
 *   draft that was submitted.
 * - The `success` state is terminal and requires a transaction hash.
 */
type WizardState =
  | { status: 'idle' }
  | {
      status: 'editing';
      draft: CommitmentDraft;
    }
  | {
      status: 'submitting';
      draft: CommitmentDraft;
      submission: SubmissionToken;
    }
  | {
      status: 'waiting_confirmation';
      draft: CommitmentDraft;
      submission: SubmissionToken;
      txHash?: string;
    }
  | {
      status: 'success';
      commitmentId: string;
      txHash: string;
    }
  | {
      status: 'error';
      error: WizardError;
      /** The draft to recover, if any. */
      draft?: CommitmentDraft;
      /** The submission that caused this error, if any. */
      submission?: SubmissionToken;
    };
 
/**
 * Events that drive the wizard state machine.
 */
type WizardEvent =
  | { type: 'START' }
  | { type: 'EDIT'; draft: CommitmentDraft }
  | { type: 'SAVE_DRAFG'; draft: CommitmentDraft }
  | { type: 'SUBMIT'; submission: SubmissionToken }
  | { type: 'CONFIRMATION_SUCCESS'; outcome: WalletOutcome & { status: 'confirmed' } }
  | { type: 'CONFIRMATION_FAILURE'; error: WizardError; submission: SubmissionToken }
  | { type: 'CANCEL' }
  | { type: 'RESET' }
  | { type: 'RESUME'; draft: CommitmentDraft };
 
/**
 * Describes the transition function for the wizard.
 * The actual implementation is in `src/app/create/page.tsx`.
 */
export interface WizardStateMachine {
  transition(state: WizardState, event: WizardEvent): WizardState;
}
 
/**
 * Contract for draft persistence used by the recovery prompt.
 */
export interface DraftRepository {
  save(draft: CommitmentDraft): Promise<void>;
  load(): Promise<CommitmentDraft null>;
  clear(): Promise<void>;
}
 
/**
 * Result of a draft recovery attempt.
 */
type RecoveryResult =
  | { status: 'recovered'; draft: CommitmentDraft }
  | { status: 'none' }
  | { status: 'error'; error: WizardError };
