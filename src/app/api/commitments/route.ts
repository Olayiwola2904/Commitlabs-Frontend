import { createHash } from 'crypto';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { fail, ok, methodNotAllowed } from '@/lib/backend/apiResponse';
import { createCorsOptionsHandler, type CorsRoutePolicy } from '@/lib/backend/cors';
import { assertMutationCsrf } from '@/lib/backend/csrf';
import { TooManyRequestsError, ValidationError } from '@/lib/backend/errors';
import { getClientIp } from '@/lib/backend/getClientIp';
import { parseJsonWithLimit, JSON_BODY_LIMITS } from '@/lib/backend/jsonBodyLimit';
import { logInfo, logWarn } from '@/lib/backend/logger';
import { MAX_PAGE_SIZE } from '@/lib/backend/pagination';
import { checkRateLimit, getRateLimitWindowSeconds } from '@/lib/backend/rateLimit';
import { requireAuth } from '@/lib/backend/requireAuth';
import { getUserCommitmentsFromChain, createCommitmentOnChain } from '@/lib/backend/services/contracts';
import { validateSupportedAsset, validateStellarAddress } from '@/lib/backend/validation';
import { withApiHandler } from '@/lib/backend/withApiHandler';

const MAX_CHAIN_COMMITMENTS_PROCESSED = 5000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const UNKNOWN_TTL_MS = IDEMPOTENCY_TTL_MS;
type IdempotencyStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'UNKNOWN';
type IdempotencyEntry = {
  status: IdempotencyStatus;
  requestHash: string;
  result?: unknown;
  error?: { code: string; message: string; status: number };
  expiresAt: number;
};
const idempotencyStore = new Map<string, IdempotencyEntry>();
const idempotencyLocks = new Map<string, Promise<unknown>>();

function withIdempotencyLock<T>(key: string, action: () => T | Promise<T>): Promise<T> {
  const previous = idempotencyLocks.get(key) ?? Promise.resolve();
  const current = previous.then(action, action);
  idempotencyLocks.set(key, current);
  const cleanup = () => {
    if (idempotencyLocks.get(key) === current) idempotencyLocks.delete(key);
  };
  void current.then(cleanup, cleanup);
  return current;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

function hashRequestPayload(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload ?? {})).digest('hex');
}

function getIdempotency(key: string): IdempotencyEntry | undefined {
  const now = Date.now();
  const entry = idempotencyStore.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    if (entry.status === 'PENDING') {
      const unknownEntry: IdempotencyEntry = {
        ...entry,
        status: 'UNKNOWN',
        expiresAt: now + UNKNOWN_TTL_MS,
      };
      idempotencyStore.set(key, unknownEntry);
      return unknownEntry;
    }
    idempotencyStore.delete(key);
    return undefined;
  }
  return entry;
}
function setPending(key: string, requestHash: string) {
  idempotencyStore.set(key, { status: 'PENDING', requestHash, expiresAt: Date.now() + PENDING_TTL_MS });
}
function setSuccess(key: string, requestHash: string, result: unknown) {
  idempotencyStore.set(key, { status: 'SUCCESS', requestHash, result, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
}
function setFailure(key: string, requestHash: string, error: { code: string; message: string; status: number }) {
  idempotencyStore.set(key, { status: 'FAILED', requestHash, error, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
}
function setUnknown(key: string, requestHash: string, error: { code: string; message: string; status: number }) {
  idempotencyStore.set(key, { status: 'UNKNOWN', requestHash, error, expiresAt: Date.now() + UNKNOWN_TTL_MS });
}
function isAmbiguousCommitmentError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  const message = error.message.toLowerCase();
  return /timeout|network|connection|socket|abort|unavailable|nonce|sequence|broadcast|unknown/i.test(message);
}

const QuerySchema = z.object({
  ownerAddress: z.string().min(1),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(10),
  status: z.enum(['ACTIVE', 'SETTLED', 'VIOLATED', 'EARLY_EXIT', 'UNKNOWN']).optional(),
  type: z.string().optional(),
  minCompliance: z.coerce.number().min(0).max(100).optional(),
});

const CreateSchema = z.object({
  ownerAddress: z.string().min(1),
  asset: z.string().min(1),
  amount: z.string().min(1).regex(/^\d+(?:\.\d+)?$/, 'Invalid amount').refine((v) => Number(v) > 0, 'Invalid amount'),
  durationDays: z.number().int().positive().max(36500, 'Invalid durationDays'),
  maxLossBps: z.number().int().min(0).max(10000, 'Invalid maxLossBps'),
  metadata: z.record(z.unknown()).optional(),
});

type CommitmentPreparation =
  | { kind: 'PROCEED'; data: { ownerAddress: string; asset: string; amount: string; durationDays: number; maxLossBps: number; metadata?: Record<string, unknown> } }
  | { kind: 'PENDING' }
  | { kind: 'SUCCESS'; result: unknown }
  | { kind: 'UNKNOWN' }
  | { kind: 'CONFLICT' };

/**
 * Idempotency state machine for commitment creation:
 * - No entry -> PENDING when a create attempt is claimed.
 * - PENDING -> SUCCESS after an unambiguous on-chain success.
 * - PENDING -> FAILED after a non-ambiguous on-chain failure.
 * - PENDING -> UNKNOWN when the pending lease expires or an ambiguous error occurs.
 * - FAILED -> PENDING when the same payload is retried.
 * - UNKNOWN and SUCCESS are not retryable until TTL expiry.
 * - Validation failures occur before PENDING is written and leave no idempotency state.
 * - Client cancellation does not cancel the on-chain attempt; it settles later.
 */
function prepareCommitmentCreation(
  idempotencyKey: string,
  requestHash: string,
  parsedBody: unknown,
): Promise<CommitmentPreparation> {
  return withIdempotencyLock(idempotencyKey, () => {
    const existing = getIdempotency(idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) return { kind: 'CONFLICT' };
      if (existing.status === 'PENDING') return { kind: 'PENDING' };
      if (existing.status === 'SUCCESS') return { kind: 'SUCCESS', result: existing.result };
      if (existing.status === 'UNKNOWN') return { kind: 'UNKNOWN' };
      // FAILED entries are definitive, non-ambiguous failures; retrying the
      // same payload under the same key is therefore safe.
    }
    const bodyResult = CreateSchema.safeParse(parsedBody);
    if (!bodyResult.success) throw new ValidationError('Invalid request body', bodyResult.error.issues);
    const { ownerAddress, asset, amount, durationDays, maxLossBps, metadata } = bodyResult.data;
    try { validateSupportedAsset(asset, 'asset'); } catch { throw new ValidationError('Asset is not supported. Supported assets: XLM, USDC.'); }
    try { validateStellarAddress(ownerAddress, 'ownerAddress'); } catch { throw new ValidationError('Invalid ownerAddress: must be a valid Stellar address (G... format).'); }
    setPending(idempotencyKey, requestHash);
    return {
      kind: 'PROCEED',
      data: { ownerAddress, asset, amount, durationDays, maxLossBps, ...(metadata !== undefined ? { metadata } : {}) },
    };
  });
}

const COMMITMENTS_CORS_POLICY = { GET: { access: 'first-party' as const }, POST: { access: 'first-party' as const } } satisfies CorsRoutePolicy;
export const OPTIONS = createCorsOptionsHandler(COMMITMENTS_CORS_POLICY);

export const GET = withApiHandler(
  async (req: NextRequest, _context, correlationId) => {
    requireAuth(req);
    const { searchParams } = new URL(req.url);
    const queryResult = QuerySchema.safeParse(Object.fromEntries(searchParams.entries()));
    if (!queryResult.success) throw new ValidationError('Invalid query parameters', queryResult.error.issues);
    const { ownerAddress, page, pageSize, status, type, minCompliance } = queryResult.data;
    validateStellarAddress(ownerAddress, 'ownerAddress');
    const ip = getClientIp(req);
    if (!(await checkRateLimit(ip, 'api/commitments'))) throw new TooManyRequestsError('Too many requests. Please try again later.', undefined, getRateLimitWindowSeconds('api/commitments'));
    const commitments = await getUserCommitmentsFromChain(ownerAddress, { requestId: correlationId });
    let source = commitments;
    let truncated = false;
    if (source.length > MAX_CHAIN_COMMITMENTS_PROCESSED) {
      source = source.slice(0, MAX_CHAIN_COMMITMENTS_PROCESSED);
      truncated = true;
      logWarn(req, '[api/commitments] chain result exceeded processing bound, truncating', { correlationId, ownerAddress, rawCount: commitments.length, boundApplied: MAX_CHAIN_COMMITMENTS_PROCESSED });
    }
    let mapped = source.map((c: any) => ({
      commitmentId: String(c.id ?? c.commitmentId),
      ownerAddress: c.ownerAddress,
      asset: c.asset,
      amount: typeof c.amount === 'bigint' ? String(c.amount) : c.amount,
      status: c.status,
      complianceScore: c.complianceScore,
      type: 'Safe',
      currentValue: typeof c.currentValue === 'bigint' ? String(c.currentValue) : c.currentValue,
      feeEarned: c.feeEarned,
      violationCount: c.violationCount,
      createdAt: c.createdAt,
      expiresAt: c.expiresAt,
      contractVersion: c.contractVersion,
    }));
    if (status) mapped = mapped.filter((c) => c.status === status);
    if (type) mapped = mapped.filter((c) => c.type.toLowerCase() === type.toLowerCase());
    if (minCompliance !== undefined) mapped = mapped.filter((c) => c.complianceScore >= minCompliance);
    const total = mapped.length;
    const start = (page - 1) * pageSize;
    logInfo(req, '[api/commitments] list served', { correlationId, ownerAddress, rawCount: commitments.length, filteredCount: total, returnedCount: mapped.slice(start, start + pageSize).length, page, pageSize, truncated });
    return ok({ items: mapped.slice(start, start + pageSize), page, pageSize, total }, undefined, 200, correlationId);
  },
  { cors: COMMITMENTS_CORS_POLICY, enableETag: true },
);

export const POST = withApiHandler(
  async (req: NextRequest, _context, correlationId) => {
    requireAuth(req);
    assertMutationCsrf(req);
    const ip = getClientIp(req);
    if (!(await checkRateLimit(ip, 'api/commitments/create'))) throw new TooManyRequestsError('Too many requests. Please try again later.', undefined, getRateLimitWindowSeconds('api/commitments/create'));
    const idempotencyKey = req.headers.get('Idempotency-Key');
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 255) return fail('BAD_REQUEST', 'Idempotency-Key header is required and must be between 8 and 255 characters', undefined, 400, correlationId);
    const parsed = await parseJsonWithLimit(req, { limitBytes: JSON_BODY_LIMITS.commitmentsCreate });
    const requestHash = hashRequestPayload(parsed ?? {});
    const preparation = await prepareCommitmentCreation(idempotencyKey, requestHash, parsed ?? {});
    if (preparation.kind === 'PENDING') return fail('CONFLICT', 'A request with this Idempotency-Key is already being processed. Retry after a moment.', undefined, 409, correlationId);
    if (preparation.kind === 'CONFLICT') return fail('CONFLICT', 'Idempotency-Key was already used with a different request payload', undefined, 409, correlationId);
    if (preparation.kind === 'SUCCESS') return ok(preparation.result, undefined, 200, correlationId);
    if (preparation.kind === 'UNKNOWN') return fail('CONFLICT', 'The previous request outcome is unknown. Review on-chain state before retrying.', undefined, 409, correlationId);
    const { ownerAddress, asset, amount, durationDays, maxLossBps, metadata } = preparation.data;
    let result;
    try {
      result = await createCommitmentOnChain({ ownerAddress, asset, amount, durationDays, maxLossBps, ...(metadata !== undefined ? { metadata } : {}) }, { requestId: correlationId });
    } catch (error) {
      const errorResponse = { code: 'INTERNAL', message: error instanceof Error ? error.message : 'Commitment creation failed', status: 500 };
      if (isAmbiguousCommitmentError(error)) {
        setUnknown(idempotencyKey, requestHash, errorResponse);
      } else {
        setFailure(idempotencyKey, requestHash, errorResponse);
      }
      throw error;
    }
    setSuccess(idempotencyKey, requestHash, result);
    return ok(result, undefined, 201, correlationId);
  },
  { cors: COMMITMENTS_CORS_POLICY },
);

const _305 = methodNotAllowed(['GET', 'POST']);
export { _305 as PUT, _305 as PATCH, _305 as DELETE };
