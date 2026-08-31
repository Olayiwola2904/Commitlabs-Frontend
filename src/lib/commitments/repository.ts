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

  async create(record: CommitmentRecord): Promise<CommitmentRecord> {
    if (this.store.has(record.id)) {
      throw new Error(`Commitment ${record.id} already exists`);
    }
    const created: CommitmentRecord = { ...record, version: record.version ?? 1 };
    this.store.set(created.id, created);
    return created;
  }

  async update(record: CommitmentRecord, expectedVersion: number): Promise<CommitmentRecord> {
    const current = this.store.get(record.id);
    if (!current) {
      throw new Error(`Commitment ${record.id} not found`);
    }
    if (current.version !== expectedVersion) {
      throw new OptimisticLockError(record.id, expectedVersion, current.version);
    }
    const updated: CommitmentRecord = { ...current, ...record, version: current.version + 1 };
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
        return (record.id.toLowerCase().includes(normalized) ||
          (record.asset?.toLowerCase().includes(normalized) ?? false) ||
          (record.amount?.toLowerCase().includes(normalized) ?? false);
      })
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }
}
