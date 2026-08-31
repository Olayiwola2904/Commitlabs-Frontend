import type { Commitment } from "./state-machine";
import type { CommitmentType } from "../../types/commitment";

export interface CommitmentRecord extends Commitment {
  userId: string;
  version: number;
  type?: CommitmentType;
  asset?: string;
  amount?: string;
}

export class OptimisticLockError extends Error {
  constructor(
    public readonly id: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(`Commitment ${id} version conflict: expected ${expectedVersion}, actual ${actualVersion}`);
    this.name = "OptimisticLockError";
  }
}

export class DuplicateIdempotencyError extends Error {
  constructor(
    public readonly idempotencyKey: string,
    public readonly userId: string,
  ) {
    super(`Commitment with idempotency key ${idempotencyKey} already exists for user ${userId}`);
    this.name = "DuplicateIdempotencyError";
  }
}

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly id: string,
    public readonly fromState: string,
    public readonly toState: string,
  ) {
    super(`Commitment ${id} cannot transition from ${fromState} to ${toState}`);
    this.name = "InvalidStateTransitionError";
  }
}

const VALID_STATES: ReadonlySet<string> = new Set([
  "pending",
  "submitted",
  "confirmed",
  "rejected",
  "cancelled",
]);

const ALLOWED_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>> = {
  pending: new Set(["submitted", "cancelled"]),
  submitted: new Set(["confirmed", "rejected", "cancelled"]),
  confirmed: new Set(["cancelled"]),
  rejected: new Set(["submitted"]),
  cancelled: new Set(),
};

export interface CommitmentRepository {
  findById(id: string): Promise<CommitmentRecord | null>;
  findByIdempotencyKey(idempotencyKey: string, userId: string): Promise<CommitmentRecord | null>;
  create(record: CommitmentRecord): Promise<CommitmentRecord>;
  update(record: CommitmentRecord, expectedVersion: number): Promise<CommitmentRecord>;
  listByUser(userId: string): Promise<CommitmentRecord[]>;
  search(userId: string, query: string, state?: string): Promise<CommitmentRecord[]>;
}

export class InMemoryCommitmentRepository implements CommitmentRepository {
  private readonly store = new Map<string, CommitmentRecord>();

  async findById(id: string): Promise<CommitmentRecord | null> {
    return this.store.get(id) ?? null;
  }

  async findByIdempotencyKey(idempotencyKey: string, userId: string): Promise<CommitmentRecord | null> {
    for (const record of this.store.values()) {
      if (record.userId === userId && record.idempotencyKey === idempotencyKey) {
        return record;
      }
    }
    return null;
  }

  private assertValidRecord(record: CommitmentRecord): void {
    if (!record.id || typeof record.id !== "string") {
      throw new Error("Commitment id is required");
    }
    if (!record.userId || typeof record.userId !== "string") {
      throw new Error("Commitment userId is required");
    }
    if (!record.idempotencyKey || typeof record.idempotencyKey !== "string") {
      throw new Error("Commitment idempotencyKey is required");
    }
    if (!record.state || typeof record.state !== "string") {
      throw new Error("Commitment state is required");
    }
  }

  private assertValidTransition(id: string, fromState: string, toState: string): void {
    if (fromState === toState) {
      return;
    }
    const allowed = ALLOWED_TRANSITIONS[fromState];
    if (!allowed || !allowed.has(toState)) {
      throw new InvalidStateTransitionError(id, fromState, toState);
    }
  }

  async create(record: CommitmentRecord): Promise<CommitmentRecord> {
    this.assertValidRecord(record);

    if (!VALID_STATES.has(record.state)) {
      throw new InvalidStateTransitionError(record.id, "", record.state);
    }

    // Idempotent creation: if the same user retries with the same idempotency key,
    // return the existing commitment instead of creating a duplicate.
    const existing = await this.findByIdempotencyKey(record.idempotencyKey, record.userId);
    if (existing) {
      return existing;
    }

    if (this.store.has(record.id)) {
      throw new Error(`Commitment ${record.id} already exists`);
    }

    const created: CommitmentRecord = {
      ...record,
      version: record.version ?? 1,
    };
    this.store.set(created.id, created);
    return created;
  }

  async update(record: CommitmentRecord, expectedVersion: number): Promise<CommitmentRecord> {
    this.assertValidRecord(record);

    const current = this.store.get(record.id);
    if (!current) {
      throw new Error(`Commitment ${record.id} not found`);
    }

    if (current.idempotencyKey !== record.idempotencyKey) {
      throw new Error(`Commitment ${record.id} idempotencyKey cannot be changed`);
    }

    if (current.version !== expectedVersion) {
      throw new OptimisticLockError(record.id, expectedVersion, current.version);
    }

    this.assertValidTransition(record.id, current.state, record.state);

    const updated: CommitmentRecord = {
      ...current,
      ...record,
      id: current.id,
      userId: current.userId,
      idempotencyKey: current.idempotencyKey,
      version: current.version + 1,
      updatedAt: new Date(),
    };
    this.store.set(updated.id, updated);
    return updated;
  }

  async listByUser(userId: string): Promise<CommitmentRecord[]> {
    return [...this.store.values()]
      .filter((record) => record.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async search(userId: string, query: string, state?: string): Promise<CommitmentRecord[]> {
    const normalized = query.trim().toLowerCase();
    return [...this.store.values()]
      .filter((record) => {
        if (record.userId !== userId) return false;
        if (state && record.state !== state) return false;
        if (!normalized) return true;
        return (
          record.id.toLowerCase().includes(normalized) ||
          (record.asset?.toLowerCase().includes(normalized) ?? false) ||
          (record.amount?.toLowerCase().includes(normalized) ?? false)
        );
      })
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 100);
  }
}
