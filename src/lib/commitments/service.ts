import {
  CommitmentEvent,
  createCommitment,
  transition,
  CommitmentStateError,
  StaleSubmissionError,
  TERMINAL_STATES,
  SUBMITTABLE_STATES,
} from "./state-machine";
import {
  CommitmentRecord,
  CommitmentRepository,
  InMemoryCommitmentRepository,
  OptimisticLockError,
} from "./repository";
import type { CreateCommitmentInput } from "./validation";

export class CommitmentNotFoundError extends Error {
  constructor(id: string) {
    super(`Commitment ${id} not found`);
    this.name = "CommitmentNotFoundError";
  }
}

export class CommitmentForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "CommitmentForbiddenError";
  }
}

export class CommitmentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommitmentConflictError";
  }
}

export type ResolveOutcome =
  | { type: "success"; txHash: string }
  | { type: "reject"; reason?: string }
  | { type: "error"; error: string };

let defaultRepository: CommitmentRepository | null = null;
let defaultService: CommitmentService | null = null;

export function getDefaultRepository(): CommitmentRepository {
  if (!defaultRepository) {
    defaultRepository = new InMemoryCommitmentRepository();
  }
  return defaultRepository;
}

export function getCommitmentService(): CommitmentService {
  if (!defaultService) {
    defaultService = new CommitmentService(getDefaultRepository());
  }
  return defaultService;
}

export class CommitmentService {
  constructor(private readonly repository: CommitmentRepository) {}

  async create(input: CreateCommitmentInput & { userId: string }): Promise<CommitmentRecord> {
    const { userId, id, idempotencyKey } = input;

    const existingById = await this.repository.findById(id);
    if (existingById) {
      if (existingById.userId !== userId) {
        throw new CommitmentNotFoundError(id);
      }
      if (existingById.idempotencyKey !== idempotencyKey) {
        throw new CommitmentConflictError(`Commitment "${id}" already exists with a different idempotency key`);
      }
      return existingById;
    }

    const existingByKey = await this.repository.findByIdempotencyKey(idempotencyKey, userId);
    if (existingByKey) {
      if (existingByKey.id !== id) {
        throw new CommitmentConflictError(`Idempotency key "${idempotencyKey}" is already used by commitment "${existingByKey.id}"`);
      }
      return existingByKey;
    }

    const commitment = createCommitment({
      id,
      idempotencyKey,
      expiresAt: input.expiresAt,
    });

    const record: CommitmentRecord = {
      ...commitment,
      userId,
      version: 1,
      type: input.type,
      asset: input.asset,
      amount: input.amount,
    };

    return this.repository.create(record);
  }

  async beginSubmission(id: string, userId: string, submissionId: string): Promise<CommitmentRecord> {
    let record = await this.getOwnedRecord(id, userId);
    record = await this.maybeExpire(record);

    if (record.state === "submitting") {
      if (record.currentSubmissionId === submissionId) {
        return record;
      }
      throw new CommitmentConflictError(`Submission already in progress with submissionId "${record.currentSubmissionId}"`);
    }

    if (!SUBMITTABLE_STATES.has(record.state)) {
      throw new CommitmentConflictError(`Cannot start submission from state "${record.state}"`);
    }

    const next = this.applyTransition(record, { type: "submit", submissionId });
    return this.optimisticUpdate(record, next);
  }

  async resolve(
    id: string,
    userId: string,
    submissionId: string,
    outcome: ResolveOutcome,
  ): Promise<CommitmentRecord> {
    const record = await this.getOwnedRecord(id, userId);

    if (record.currentSubmissionId === submissionId && record.state === "submitting") {
      // active submission, process outcome
    } else if (record.lastSubmissionId === submissionId && TERMINAL_STATES.has(record.state)) {
      // idempotent duplicate callback
      return record;
    } else {
      throw new CommitmentConflictError("No active submission matching the provided submissionId");
    }

    const event: CommitmentEvent =
      outcome.type === "success"
        ? { type: "success", submissionId, transactionHash: outcome.txHash }
        : outcome.type === "reject"
          ? { type: "reject", submissionId, reason: outcome.reason }
          : { type: "error", submissionId, error: outcome.error };

    const next = this.applyTransition(record, event);
    return this.optimisticUpdate(record, next);
  }

  async cancel(id: string, userId: string, reason?: string): Promise<CommitmentRecord> {
    const record = await this.getOwnedRecord(id, userId);
    const next = this.applyTransition(record, { type: "cancel", reason });
    return this.optimisticUpdate(record, next);
  }

  async listByUser(userId: string): Promise<CommitmentRecord[]> {
    return this.repository.listByUser(userId);
  }

  async search(userId: string, query: string, state?: string): Promise<CommitmentRecord[]> {
    return this.repository.search(userId, query, state);
  }

  private async maybeExpire(record: CommitmentRecord): Promise<CommitmentRecord> {
    if (record.expiresAt && record.expiresAt.getTime() <= Date.now() && !TERMINAL_STATES.has(record.state) && record.state !== "submitting") {
      const next = this.applyTransition(record, { type: "expire" });
      return this.optimisticUpdate(record, next);
    }
    return record;
  }

  private async getOwnedRecord(id: string, userId: string): Promise<CommitmentRecord> {
    const record = await this.repository.findById(id);
    if (!record) {
      throw new CommitmentNotFoundError(id);
    }
    if (record.userId !== userId) {
      throw new CommitmentForbiddenError();
    }
    return record;
  }

  private applyTransition(record: CommitmentRecord, event: CommitmentEvent): CommitmentRecord {
    try {
      const next = transition(record, event);
      return {
        ...next,
        userId: record.userId,
        version: record.version,
        type: record.type,
        asset: record.asset,
        amount: record.amount,
      };
    } catch (error) {
      if (error instanceof StaleSubmissionError) {
        throw new CommitmentConflictError(error.message);
      }
      throw error;
    }
  }

  private async optimisticUpdate(
    current: CommitmentRecord,
    next: CommitmentRecord,
  ): Promise<CommitmentRecord> {
    try {
      return await this.repository.update(
        { ...next, version: current.version },
        current.version,
      );
    } catch (error) {
      if (error instanceof OptimisticLockError) {
        throw new CommitmentConflictError(error.message);
      }
      throw error;
    }
  }
}
