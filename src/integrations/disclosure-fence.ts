import { types } from 'node:util';
import { errorEnvelope, sameScope, type ApiResult, type Clock, type FinanceAuthorizationDecision, type TrustedScope } from '../shared/contracts.js';
import type { PreparedExportArtifacts } from './runtime.js';
import type { ReportingPreparedExportArtifacts } from './reporting-export.js';
import type { ExportManifest } from './index.js';
type Allowed = Extract<FinanceAuthorizationDecision, { readonly status: 'allowed' }>;
export type ExportDisclosureFenceRequest = { readonly schemaVersion: '1.0.0'; readonly requestId: string; readonly scope: TrustedScope; readonly requiredPermissions: readonly ['finance.summary.read', 'finance.summary.export'] };
declare const permitBrand: unique symbol;
export type ExportAccessPermit = object & { readonly [permitBrand]: never };
export type CurrentExportAccessSnapshot = {
  readonly schemaVersion: '1.0.0'; readonly status: 'allowed'; readonly stateRevision: string; readonly scope: TrustedScope;
  readonly context: { readonly scope: TrustedScope; readonly revision: string; readonly verifiedAt: string; readonly expiresAt: string };
  readonly read: Omit<Allowed, 'operation' | 'permission'> & { readonly operation: 'reporting.querySummary'; readonly permission: 'finance.summary.read' };
  readonly export: Omit<Allowed, 'operation' | 'permission'> & { readonly operation: 'integrations.exportSummary'; readonly permission: 'finance.summary.export' };
};
export type ExportDisclosureFenceResult = CurrentExportAccessSnapshot | { readonly schemaVersion: '1.0.0'; readonly status: 'denied' | 'unavailable' };
export interface ExportDisclosureFencePort {
  acquire(request: ExportDisclosureFenceRequest): Promise<ExportAccessPermit | null>;
  validateCurrent(permit: ExportAccessPermit, request: ExportDisclosureFenceRequest): ExportDisclosureFenceResult;
}
export type DisclosureFrame = { readonly port: ExportDisclosureFencePort; readonly acquire: ExportDisclosureFencePort['acquire']; readonly validate: ExportDisclosureFencePort['validateCurrent']; readonly request: ExportDisclosureFenceRequest; readonly permit: ExportAccessPermit };
const bindings = new WeakMap<object, DisclosureFrame>();
type PublicValue = ExportManifest | PreparedExportArtifacts | ReportingPreparedExportArtifacts;
type ResultBinding = { readonly frame: DisclosureFrame; readonly value: PublicValue; readonly clock: Clock; readonly now: Clock['now'] };
const publicResults = new WeakMap<object, ResultBinding>();
const reject = (code: 'FORBIDDEN_SCOPE' | 'SOURCE_UNAVAILABLE') => ({ ok: false as const, error: errorEnvelope('integrations', 'exportSummary', code, 'unavailable', code === 'FORBIDDEN_SCOPE' ? 'Current financial disclosure is not authorized.' : 'A coherent current financial disclosure capability is unavailable.', code === 'SOURCE_UNAVAILABLE') });
function method(port: object, name: string): unknown { if (types.isProxy(port)) return undefined; const d = Object.getOwnPropertyDescriptor(port, name); return d && 'value' in d ? d.value : undefined; }
function frozenPlain(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== 'object') return typeof value !== 'function' && typeof value !== 'symbol' && typeof value !== 'bigint';
  if (depth > 16 || types.isProxy(value) || !Object.isFrozen(value)) return false;
  const prototype = Object.getPrototypeOf(value); if (prototype !== null && prototype !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value); if (Object.keys(descriptors).length > 32 || Object.getOwnPropertySymbols(value).length) return false;
  return Object.values(descriptors).every(d => 'value' in d && frozenPlain(d.value, depth + 1));
}
function keys(value: object, expected: string): boolean { return Object.keys(value).sort().join(',') === expected.split(',').sort().join(','); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
function times(value: { verifiedAt: string; expiresAt: string }, now: number): boolean { const a = Date.parse(value.verifiedAt), b = Date.parse(value.expiresAt); return Number.isFinite(a) && Number.isFinite(b) && a <= now && now - a <= 60_000 && b > now && b > a && b - a <= 300_000; }
function principal(value: Allowed['principal'], scope: TrustedScope): string | null {
  if (!value || !keys(value, value.kind === 'user' ? 'kind,actorId,membershipStatus,membershipRevision' : 'kind,actorId,serviceStatus,serviceGrantRevision') || value.actorId !== scope.actorId) return null;
  if (value.kind === 'user' && value.membershipStatus === 'active' && text(value.membershipRevision)) return 'user:' + value.membershipRevision;
  if (value.kind === 'service' && value.serviceStatus === 'active' && text(value.serviceGrantRevision)) return 'service:' + value.serviceGrantRevision;
  return null;
}
export async function acquireDisclosure(port: ExportDisclosureFencePort | undefined, scope: TrustedScope, requestId: string): Promise<ApiResult<DisclosureFrame>> {
  try {
    if (!port) return reject('SOURCE_UNAVAILABLE');
    const acquire = method(port, 'acquire'), validate = method(port, 'validateCurrent');
    if (typeof acquire !== 'function' || typeof validate !== 'function') return reject('SOURCE_UNAVAILABLE');
    const request = Object.freeze({ schemaVersion: '1.0.0' as const, requestId, scope: Object.freeze(structuredClone(scope)), requiredPermissions: Object.freeze(['finance.summary.read', 'finance.summary.export'] as const) });
    const permit = await acquire.call(port, request);
    if (!permit || typeof permit !== 'object' || types.isProxy(permit) || !Object.isFrozen(permit)) return reject('SOURCE_UNAVAILABLE');
    return { ok: true, value: Object.freeze({ port, acquire, validate, request, permit }) as DisclosureFrame };
  } catch { return reject('SOURCE_UNAVAILABLE'); }
}
/** Synchronous resumed-caller fence. Clock/port work precedes immutable handoff. */
export function validateDisclosure(frame: DisclosureFrame | undefined, clock: Clock): ApiResult<null> {
  if (!frame) return { ok: true, value: null }; // standalone explicitly mocked legacy only
  try {
    const now = Date.prototype.getTime.call(clock.now());
    if (!Number.isFinite(now) || method(frame.port, 'acquire') !== frame.acquire || method(frame.port, 'validateCurrent') !== frame.validate) return reject('SOURCE_UNAVAILABLE');
    const raw: unknown = frame.validate.call(frame.port, frame.permit, frame.request);
    if (!frozenPlain(raw) || raw === null || typeof raw !== 'object') return reject('SOURCE_UNAVAILABLE');
    const value = raw as ExportDisclosureFenceResult;
    if (value.schemaVersion !== '1.0.0') return reject('SOURCE_UNAVAILABLE');
    if (value.status !== 'allowed') return keys(value, 'schemaVersion,status') && value.status === 'denied' ? reject('FORBIDDEN_SCOPE') : reject('SOURCE_UNAVAILABLE');
    if (!keys(value, 'schemaVersion,status,stateRevision,scope,context,read,export') || !text(value.stateRevision) || !sameScope(value.scope, frame.request.scope)
        || !keys(value.context, 'scope,revision,verifiedAt,expiresAt') || !sameScope(value.context.scope, frame.request.scope) || !text(value.context.revision) || !times(value.context, now)) return reject('FORBIDDEN_SCOPE');
    const identities: string[] = [];
    for (const [grant, operation, permission] of [[value.read, 'reporting.querySummary', 'finance.summary.read'], [value.export, 'integrations.exportSummary', 'finance.summary.export']] as const) {
      if (!keys(grant, 'status,decisionId,operation,permission,scope,principal,verifiedAt,expiresAt') || grant.status !== 'allowed' || !text(grant.decisionId)
          || grant.operation !== operation || grant.permission !== permission || !sameScope(grant.scope, frame.request.scope) || !times(grant, now)) return reject('FORBIDDEN_SCOPE');
      const identity = principal(grant.principal, frame.request.scope); if (!identity) return reject('FORBIDDEN_SCOPE'); identities.push(identity);
    }
    if (identities[0] !== identities[1]) return reject('FORBIDDEN_SCOPE');
    return { ok: true, value: null };
  } catch { return reject('SOURCE_UNAVAILABLE'); }
}
/** Own non-enumerable then prevents Promise adoption invoking an inherited hook. */
export function sealDisclosureSuccess<T>(value: T): ApiResult<T> {
  const result = { ok: true as const, value };
  Object.defineProperty(result, 'then', { value: undefined });
  return Object.freeze(result);
}
export function bindDisclosure(value: object, frame: DisclosureFrame | undefined): void { if (frame) bindings.set(value, frame); }
function registerPublicResult<T>(result: ApiResult<T>, frame: DisclosureFrame | undefined, clock: Clock): void {
  if (!result.ok || !frame) return;
  const now = method(clock, 'now');
  if (typeof now !== 'function') return;
  publicResults.set(result, Object.freeze({ frame, value: result.value as PublicValue, clock, now: now as Clock['now'] }));
}
/** Internal: only the exact immutable own manifest of a known preparation qualifies. */
export function bindManifestDisclosure(prepared: object, result: ApiResult<ExportManifest>, clock: Clock): void {
  const frame = bindings.get(prepared);
  if (!frame || !result.ok || types.isProxy(prepared) || types.isProxy(result.value) || !Object.isFrozen(prepared) || !Object.isFrozen(result.value)) return;
  const descriptor = Object.getOwnPropertyDescriptor(prepared, 'manifest');
  if (!descriptor || !('value' in descriptor) || descriptor.value !== result.value) return;
  bindings.set(result.value, frame);
  registerPublicResult(result, frame, clock);
}
/** Mandatory coherent release of an exact original result, after the caller's awaits. */
export function releaseExportDisclosure<T extends PublicValue>(result: ApiResult<T>, clock: Clock): ApiResult<T> {
  try {
    // Identity lookup precedes any property inspection of unknown caller objects.
    const record = result !== null && (typeof result === 'object' || typeof result === 'function') ? publicResults.get(result) : undefined;
    if (!record || clock !== record.clock || method(clock, 'now') !== record.now) return reject('SOURCE_UNAVAILABLE');
    const sealed = sealDisclosureSuccess(record.value as T);
    publicResults.set(sealed, record); // no registration work after the final fence
    const current = validateDisclosure(record.frame, record.clock);
    return current.ok ? sealed : current;
  } catch { return reject('SOURCE_UNAVAILABLE'); }
}
export function releaseDisclosure<T>(result: ApiResult<T>, clock: Clock, required: boolean): ApiResult<T> {
  if (!result.ok) return result;
  const frame = typeof result.value === 'object' && result.value !== null ? bindings.get(result.value) : undefined;
  if (required && !frame) return reject('SOURCE_UNAVAILABLE');
  const sealed = sealDisclosureSuccess(result.value);
  registerPublicResult(sealed, frame, clock);
  const current = validateDisclosure(frame, clock); return current.ok ? sealed : current;
}
