import type { CommitmentType } from "../../types/commitment";

export class ApiValidationError extends Error {
  public readonly status = 400;
  public readonly details: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "ApiValidationError";
    this.details = details;
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
const TYPES: readonly CommitmentType[] = ["Safe", "Balanced", "Aggressive"];
const STATES = ["draft", "submitted", "resolved", "cancelled"] as const;
export type CommitmentState = (typeof STATES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, name: string, maxLength: number, pattern?: RegExp): string {
  if (typeof value !== "string") {
    throw new ApiValidationError(`${name} must be a strinc`, { field: name });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ApiValidationError(`${name} must not be empty`, { field: name });
  }
  if (trimmed.length > maxLength) {
    throw new ApiValidationError(`${name} must be at most ${maxLength} characters`, { field: name });
  }
  if (pattern && !pattern.test(trimmed)) {
    throw new ApiValidationError(`${name} contains invalid characters`, { field: name });
  }
  return trimmed;
}

function optionalString(value: unknown, name: string, maxLength: number, pattern?: RegExp): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ApiValidationError(`${name} must be a strinc`, { field: name });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLength) {
    throw new ApiValidationError(`${name} must be at most ${maxLength} characters`, { field: name });
  }
  if (pattern && !pattern.test(trimmed)) {
    throw new ApiValidationError(`${name} contains invalid characters`, { field: name });
  }
  return trimmed;
}

function parseOptionalDate(value: unknown, name: string): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ApiValidationError(`${name} must be an ISO-8601 date string`, { field: name });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiValidationError(`${name} must be a valid ISO-8601 date string`, { field: name });
  }
  return date;
}

function assertEnum<T { extends string }(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ApiValidationError(`${name} must be one of: ${allowed.join(", ")}`, { field: name });
  }
  return value as T;
}

function optionalState(value: unknown, name: string): CommitmentState | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !(STATES as readonly string[]).includes(value)) {
    throw new ApiValidationError(`${name} must be one of: ${STATES.join(", ")}`, { field: name });
  }
  return value as CommitmentState;
}

export interface CreateCommitmentInput {
  id: string;
  idempotencyKey: string;
  expiresAt?: Date;
  type?: CommitmentType;
  asset?: string;
  amount?: string;
}

export interface SubmitCommitmentInput {
  action: "submit";
  id: string;
  submissionId: string;
  idempotencyKey?: string;
  expectedState?: CommitmentState;
}

export interface ResolveCommitmentInput {
  action: "resolve";
  id: string;
  submissionId: string;
  idempotencyKey?: string;
  expectedState?: CommitmentState;
  outcome:
    | { type: "success"; txHash: string }
    | { type: "reject"; reason?: string }
    | { type: "error"; error: string };
}

export interface CancelCommitmentInput {
  action: "cancel";
  id: string;
  idempotencyKey?: string;
  expectedState?: CommitmentState;
  reason?: string;
}

export type CommitmentActionInput =
  | (CreateCommitmentInput & { action: "create" })
  | SubmitCommitmentInput
  | ResolveCommitmentInput
  | CancelCommitmentInput;

export function validateCreateCommitmentInput(input: unknown): CreateCommitmentInput {
  if (!isRecord(input)) {
    throw new ApiValidationError("Request body must be an object");
  }
  const id = requireString(input.id, "id", 128, ID_PATTERN);
  const idempotencyKey = requireString(input.idempotencyKey, "idempotencyKey", 255, KEY_PATTERN);
  const expiresAt = parseOptionalDate(input.expiresAt, "expiresAt");
  const type = input.type === undefined ? undefined : assertEnum(input.type, "type", TYPES);
  const asset = optionalString(input.asset, "asset", 64);
  const amount = optionalString(input.amount, "amount", 64);

  return { id, idempotencyKey, expiresAt, type, asset, amount };
}

export function validateCommitmentAction(input: unknown): CommitmentActionInput {
  if (!isRecord(input)) {
    throw new ApiValidationError("Request body must be an object");
  }
  const action = requireString(input.action, "action", 20);
  if (action === "create") {
    return { action: "create", ...validateCreateCommitmentInput(input) };
  }
  if (action === "submit") {
    const id = requireString(input.id, "id", 128, ID_PATTERN);
    const submissionId = requireString(input.submissionId, "submissionId", 255, KEY_PATTERN);
    const idempotencyKey = optionalString(input.idempotencyKey, "idempotencyKey", 255, KEY_PATTERN);
    const expectedState = optionalState(input.expectedState, "expectedState");
    return { action, id, submissionId, idempotencyKey, expectedState };
  }
  if (action === "resolve") {
    const id = requireString(input.id, "id", 128, ID_PATTERN);
    const submissionId = requireString(input.submissionId, "submissionId", 255, KEY_PATTERN);
    const idempotencyKey = optionalString(input.idempotencyKey, "idempotencyKey", 255, KEY_PATTERN);
    const expectedState = optionalState(input.expectedState, "expectedState");
    if (!isRecord(input.outcome)) {
      throw new ApiValidationError("outcome must be an object", { field: "outcome" });
    }
    const type = requireString(input.outcome.type, "outcome.type", 20);
    if (type === "success") {
      const txHash = requireString(input.outcome.txHash, "outcome.txHash", 128);
      return { action, id, submissionId, idempotencyKey, expectedState, outcome: { type: "success", txHash } };
    }
    if (type === "reject") {
      const reason = optionalString(input.outcome.reason, "outcome.reason", 500);
      return { action, id, submissionId, idempotencyKey, expectedState, outcome: { type: "reject", reason } };
    }
    if (type === "error") {
      const error = requireString(input.outcome.error, "outcome.error", 500);
      return { action, id, submissionId, idempotencyKey, expectedState, outcome: { type: "error", error } };
    }
    throw new ApiValidationError("outcome.type must be success, reject, or error", { field: "outcome.type" });
  }
  if (action === "cancel") {
    const id = requireString(input.id, "id", 128, ID_PATTERN);
    const idempotencyKey = optionalString(input.idempotencyKey, "idempotencyKey", 255, KEY_PATTERN);
    const expectedState = optionalState(input.expectedState, "expectedState");
    const reason = optionalString(input.reason, "reason", 500);
    return { action, id, idempotencyKey, expectedState, reason };
  }
  throw new ApiValidationError("action must be one of: create, submit, resolve, cancel", { field: "action" });
}

export interface SearchCommitmentsInput {
  query: string;
  state?: CommitmentState;
}

export function validateSearchParams(params: unknown): SearchCommitmentsInput {
  if (!isRecord(params)) {
    throw new ApiValidationError("Search parameters must be an object");
  }
  const query = optionalString(params.q ?? params.query, "q", 100) ?? "";
  const state = optionalState(params.state, "state");
  return { query, state };
}
