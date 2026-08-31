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
import { getUserCommitmentsFromChain, createCommitmentOnCain } from '@/lib/backend/services/contracts';
import { validateSupportedAsset, validateStellarAddress } from '@/lib/backend/validation';
import { withApiHandler } from '@/lib/backend/withApiHandler';

const MAX_CHAIN_COMMITMENTS_PROCESSED = 5000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
type IdempotencyEntry = { status: 'PENDING' | 'SUCCESS' | 'FAILED'; result?: unknown; error?: { code: string; message: string; status: number }; expiresAt: number };
const idempotencyStore = new Map<string, IdempotencyEntry>();

function getIdempotency(key: string): IdempotencyEntry | undefined {
  const now = Date.now();
  const entry = idempotencyStore.get(key);
  if (entry && entry.expiresAt <= now) { idempotencyStore.delete(key); return undefined; }
  return entry;
}
function setSuccess(key: string, result: unknown) { idempotencyStore.set(key, { status: 'SUCCESS', result, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS }); }
function setFailure(key: string, error: { code: string; message: string; status: number }) { idempotencyStore.set(key, { status: 'FAILED', error, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS }); }

const QuerySchema = z.object({
  ownerAddress: z.string().min(1),
  page: z.coerce(number().int().min(1).default(1),
  pageSize: z.coerce(number().int().min(1).max(MAX_PAGE_SIZE).default(10),
  status: z.enum(['ACTIVE', 'SETTLED', 'VIOLATED', 'EARLY_EXIT', 'UNKNOWN']).optional(),
  type: z.string().optional(),
  minCompliance: z.coerce(number().min(0).max(100).optional(),
});

const CreateSchema = z.object({
  ownerAddress: z.string().min(1),
  asset: z.string().min(1),
  amount: z.string().min(1).regex(/^\d+(?\.\d+)?$/, 'Invalid amount').refine((v) => Number(v) > 0, 'Invalid amount'),
  durationDays: z.number().int().positive().max(36500, 'Invalid durationDays'),
  maxLossBps: z.number().int().min(0).max(10000, 'Invalid maxLossBps'),
  metadata: z.record(z.unknown()).optional(),
});

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
    const existing = getIdempotency(idempotencyKey);
    if (existing?.status === 'PENDING') return fail('CONFLICT', 'A request with this Idempotency-Key is already being processed. Retry after a moment.', undefined, 409, correlationId);
    if (existing?.status === 'SUCCESS') return ok(existing.result, undefined, 200, correlationId);
    if (existing?.status === 'FAILED') return fail(existing.error!.code as any, existing.error!.message, undefined, existing.error!.status, correlationId);
    idempotencyStore.set(idempotencyKey, { status: 'PENDING', expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
    const parsed = await parseJsonWithLimit(req, { limitBytes: JSON_BODY_LIMITS.commitmentsCreate });
    const bodyResult = CreateSchema.safeParse(parsed ?? {});
    if (!bodyResult.success) { idempotencyStore.delete(idempotencyKey); throw new ValidationError('Invalid request body', bodyResult.error.issues); }
    const { ownerAddress, asset, amount, durationDays, maxLossBps, metadata } = bodyResult.data;
    try { validateSupportedAsset(asset, 'asset'); } catch { throw new ValidationError('Asset is not supported. Supported assets: XLM, USDC.'); }
    try { validateStellarAddress(ownerAddress, 'ownerAddress'); } catch { throw new ValidationError('Invalid ownerAddress: must be a valid Stellar address (G... format).'); }
    let result;
    try {
      result = await createCommitmentOnChain({ ownerAddress, asset, amount, durationDays, maxLossBps, ...(metadata !== undefined ? { metadata } : {}) }, { requestId: correlationId });
    } catch (error) {
      setFailure(idempotencyKey, { code: 'INTERNAL', message: error instanceof Error ? error.message : 'Commitment creation failed', status: 500 });
      throw error;
    }
    setSuccess(idempotencyKey, result);
    return ok(result, undefined, 201, correlationId);
  },
  { cors: COMMITMENTS_CORS_POLICY },
);

const _305 = methodNotAllowed(['GET', 'POST']);
export { _305 as PUT, _305 as PATCH, _305 as DELETE };
