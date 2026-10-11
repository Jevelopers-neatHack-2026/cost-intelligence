import { FormatRegistry, Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

function validDateTime(value: string): boolean {
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  return calendarDate.getUTCFullYear() === year && calendarDate.getUTCMonth() === month - 1 && calendarDate.getUTCDate() === day;
}

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', validDateTime);
if (!FormatRegistry.Has('uri')) FormatRegistry.Set('uri', value => {
  try { return new URL(value).protocol.length > 0; } catch { return false; }
});

export const SCHEMA_VERSION = '1.0.0' as const;
export const SchemaVersionSchema = Type.Literal(SCHEMA_VERSION);

export const EnvironmentSchema = Type.Union([
  Type.Literal('development'),
  Type.Literal('test'),
  Type.Literal('production'),
]);
export const BillingModeSchema = Type.Union([
  Type.Literal('live'),
  Type.Literal('sandbox'),
  Type.Literal('simulated'),
]);

export const TrustedScopeSchema = Type.Object({
  tenantId: Type.String({ minLength: 1, maxLength: 128 }),
  projectId: Type.String({ minLength: 1, maxLength: 128 }),
  environment: EnvironmentSchema,
  billingMode: BillingModeSchema,
  actorId: Type.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false });
export type TrustedScope = Static<typeof TrustedScopeSchema>;

export const ErrorCodeSchema = Type.Union([
  Type.Literal('VALIDATION_ERROR'),
  Type.Literal('UNSUPPORTED_VERSION'),
  Type.Literal('FORBIDDEN_SCOPE'),
  Type.Literal('IDEMPOTENCY_CONFLICT'),
  Type.Literal('PRICING_UNKNOWN'),
  Type.Literal('BUDGET_EXCEEDED'),
  Type.Literal('BUDGET_UNAVAILABLE'),
  Type.Literal('RECONCILIATION_PENDING'),
  Type.Literal('SOURCE_UNAVAILABLE'),
]);
export type ErrorCode = Static<typeof ErrorCodeSchema>;

export const ErrorEnvelopeSchema = Type.Object({
  schemaVersion: SchemaVersionSchema,
  module: Type.String({ minLength: 1 }),
  operation: Type.String({ minLength: 1 }),
  code: ErrorCodeSchema,
  retryable: Type.Boolean(),
  safe_message: Type.String({ minLength: 1, maxLength: 240 }),
  diagnostic_ref: Type.String({ minLength: 1, maxLength: 160 }),
}, { additionalProperties: false });
export type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;

export const RequestBaseSchema = Type.Object({
  schemaVersion: SchemaVersionSchema,
  requestId: Type.String({ minLength: 1, maxLength: 128 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
  scope: TrustedScopeSchema,
}, { additionalProperties: false });
export type RequestBase = Static<typeof RequestBaseSchema>;

export const DecimalAmountSchema = Type.String({
  pattern: '^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,18})?$',
  maxLength: 40,
  description: 'Base-10 decimal string with at most 18 fractional digits; never use binary floating point for money.',
});
export const NonNegativeDecimalAmountSchema = Type.String({
  pattern: '^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,18})?$',
  maxLength: 40,
  description: 'Non-negative base-10 decimal string with at most 18 fractional digits.',
});
export const CurrencySchema = Type.String({ pattern: '^[A-Z]{3}$' });
export const CompletenessSchema = Type.Union([
  Type.Literal('complete'),
  Type.Literal('partial'),
  Type.Literal('unknown'),
]);

export type ApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ErrorEnvelope };
export type ApiErrorResult = { readonly ok: false; readonly error: ErrorEnvelope };
export type Clock = { now(): Date };
export type FinancialStorePort = { isAvailable(): Promise<boolean> };
export type ProviderSourcePort = { isAvailable(): Promise<boolean> };
export type TrustedContextPort = { resolve(requested: TrustedScope): Promise<TrustedScope | null> };
export type RuntimePorts = {
  clock: Clock;
  storage: FinancialStorePort;
  providerSource: ProviderSourcePort;
  trustedContext: TrustedContextPort;
};

export type Validation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ErrorEnvelope };

export function errorEnvelope(
  module: string,
  operation: string,
  code: ErrorCode,
  requestId: string,
  safeMessage: string,
  retryable = false,
): ErrorEnvelope {
  const opaqueRef = globalThis.crypto.randomUUID();
  return {
    schemaVersion: SCHEMA_VERSION,
    module,
    operation,
    code,
    retryable,
    safe_message: safeMessage,
    diagnostic_ref: `ci1:${opaqueRef}`,
  };
}

export function validateRequest<T extends TSchema>(
  schema: T,
  value: unknown,
  module: string,
  operation: string,
): Validation<Static<T>> {
  const requestId = typeof value === 'object' && value !== null && 'requestId' in value && typeof value.requestId === 'string'
    ? value.requestId
    : 'unavailable';
  if (typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      error: errorEnvelope(module, operation, 'UNSUPPORTED_VERSION', requestId, 'The request schema version is not supported.'),
    };
  }
  if (!Value.Check(schema, value)) {
    return {
      ok: false,
      error: errorEnvelope(module, operation, 'VALIDATION_ERROR', requestId, 'The request does not match the published schema.'),
    };
  }
  return { ok: true, value: value as Static<T> };
}

export function failure(error: ErrorEnvelope): ApiErrorResult {
  return { ok: false, error };
}

export function success<T>(value: T): ApiResult<T> {
  return { ok: true, value };
}

export async function blockedBoundary<TRequest extends RequestBase, TOutput>(args: {
  module: string;
  operation: string;
  schema: TSchema;
  request: unknown;
  ports: RuntimePorts;
  unavailableCode: ErrorCode;
  safeMessage: string;
  retryable?: boolean;
}): Promise<ApiResult<TOutput>> {
  const validation = validateRequest(args.schema, args.request, args.module, args.operation);
  if (!validation.ok) return failure(validation.error);
  const request = validation.value as TRequest;
  try {
    const trusted = await args.ports.trustedContext.resolve(request.scope);
    if (!trusted || !sameScope(trusted, request.scope)) {
      return failure(errorEnvelope(args.module, args.operation, 'FORBIDDEN_SCOPE', request.requestId, 'The requested financial scope is not authorized.'));
    }
  } catch {
    return failure(errorEnvelope(args.module, args.operation, 'SOURCE_UNAVAILABLE', request.requestId, 'Trusted authorization context is temporarily unavailable.', true));
  }
  return failure(errorEnvelope(args.module, args.operation, args.unavailableCode, request.requestId, args.safeMessage, args.retryable ?? false));
}

export function sameScope(left: TrustedScope, right: TrustedScope): boolean {
  return left.tenantId === right.tenantId
    && left.projectId === right.projectId
    && left.environment === right.environment
    && left.billingMode === right.billingMode
    && left.actorId === right.actorId;
}
