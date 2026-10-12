import assert from 'node:assert/strict';
import { types } from 'node:util';
const frozen = value => { const copy = structuredClone(value); const visit = item => { if (item && typeof item === 'object') { for (const child of Object.values(item)) visit(child); Object.freeze(item); } }; visit(copy); return copy; };
const same = (a, b) => ['tenantId', 'projectId', 'actorId', 'environment', 'billingMode'].every(key => a?.[key] === b?.[key]);
const tuple = ['finance.summary.read', 'finance.summary.export'];
/** Sole task-local SYNTHETIC authority. No production session, mapping or grant is minted. */
export function createSyntheticDisclosureHost(scope, instant) {
  const permits = new WeakMap(), hooks = new Map(); let bound, invalid = false, nextPermitExpiry = Infinity, clockHook;
  let record = frozen({ generation: '1', scope, contextScope: scope, contextStatus: 'present', contextRevision: 'synthetic-context-r1', principalKind: 'service', principalRevision: 'synthetic-principal-r1', active: true,
    readStatus: 'allowed', exportStatus: 'allowed', readRevision: 'synthetic-read-r1', exportRevision: 'synthetic-export-r1', now: Date.parse(instant), from: Date.parse(instant) - 1000, until: Date.parse(instant) + 3_600_000 });
  const counters = { calls: 0, reads: 0, validations: 0, transitions: 0, boundaries: [] };
  const update = patch => { counters.transitions++; const generation = (BigInt(record.generation) + 1n).toString(); record = frozen({ ...record, ...patch, generation }); };
  const controller = {
    setContext(status, currentScope = record.scope) { assert.ok(['present', 'absent', 'unavailable'].includes(status)); update({ contextStatus: status, contextScope: status === 'absent' ? null : currentScope, contextRevision: 'synthetic-context-r' + (BigInt(record.generation) + 1n) }); },
    setGrant(permission, status) { assert.ok(tuple.includes(permission)); assert.ok(['allowed', 'denied', 'unavailable'].includes(status)); const key = permission === tuple[0] ? 'read' : 'export'; update({ [key + 'Status']: status, [key + 'Revision']: 'synthetic-' + key + '-r' + (BigInt(record.generation) + 1n) }); },
    setPrincipal(active, kind = record.principalKind, revision = 'synthetic-principal-r' + (BigInt(record.generation) + 1n)) { assert.ok(['user', 'service'].includes(kind)); update({ active, principalKind: kind, principalRevision: revision }); },
    setScope(next) { update({ scope: next, contextScope: next, contextRevision: 'synthetic-context-r' + (BigInt(record.generation) + 1n) }); },
    bumpRevision(which) { assert.ok(['principal', 'context', 'read', 'export'].includes(which)); update({ [which === 'principal' ? 'principalRevision' : which + 'Revision']: 'synthetic-' + which + '-r' + (BigInt(record.generation) + 1n) }); },
    advanceTime(next) { const now = typeof next === 'string' ? Date.parse(next) : next; assert.ok(Number.isFinite(now) && now >= record.now); const crossed = (record.now < record.until && now >= record.until) || (record.now < nextPermitExpiry && now >= nextPermitExpiry); record = frozen({ ...record, now }); if (crossed) { nextPermitExpiry = Infinity; update({}); } },
    invalidateSourceBinding() { invalid = true; update({}); },
    onBoundary(name, callback) { assert.equal(typeof callback, 'function'); const list = hooks.get(name) ?? []; list.push(callback); hooks.set(name, list); },
    bindPorts(ports) { assert.equal(bound, undefined); bound = ports; },
    onClockRead(callback) { clockHook = callback; },
    inspect() { return frozen(record); },
  };
  const boundary = async name => { counters.boundaries.push(name); const list = hooks.get(name); if (list?.length) { const callback = list.shift(); await callback(controller); } else await Promise.resolve(); };
  const principal = current => current.principalKind === 'service' ? { kind: 'service', actorId: current.scope.actorId, serviceStatus: 'active', serviceGrantRevision: current.principalRevision } : { kind: 'user', actorId: current.scope.actorId, membershipStatus: 'active', membershipRevision: current.principalRevision };
  const decision = (current, operation, permission) => frozen({ status: 'allowed', decisionId: 'synthetic-decision-' + current.generation, operation, permission, scope: current.scope, principal: principal(current), verifiedAt: new Date(current.now).toISOString(), expiresAt: new Date(Math.min(current.until, current.now + 60000)).toISOString() });
  const clock = { now: () => { if (clockHook) { const result = clockHook(controller, counters); if (result && typeof result.then === 'function') { invalid = true; throw new Error('Async clock hook refused.'); } } return new Date(record.now); } };
  const trustedContext = { resolve: async requested => { await boundary('context.resolve'); const current = record; if (current.contextStatus === 'unavailable') throw new Error('PRIVATE_SYNTHETIC_CONTEXT_FAILURE'); if (current.contextStatus === 'absent' || current.now >= current.until) return null; return frozen(current.contextScope); } };
  const financeAuthority = { authorizeCurrent: async request => {
    counters.calls++; const key = request.permission === tuple[0] ? 'read' : request.permission === tuple[1] ? 'export' : 'writer'; await boundary('authority.' + key);
    const current = record; const denied = () => ({ status: 'denied', operation: request.operation, permission: request.permission });
    const exact = key === 'read' ? request.operation === 'reporting.querySummary' : key === 'export' ? request.operation === 'integrations.exportSummary' : request.operation === 'ledger.appendLedgerEvent' && request.permission === 'ledger.event.append';
    // The fixture's explicit ledger seeding grant is not conferred by the fence.
    if (!exact || !current.active || !same(request.requestedScope, current.scope) || current.now >= current.until || (key !== 'writer' && current[key + 'Status'] !== 'allowed')) return key !== 'writer' && current[key + 'Status'] === 'unavailable' ? null : denied();
    return decision(current, request.operation, request.permission);
  } };
  const own = (object, name, fn) => { if (!object || types.isProxy(object)) return false; const d = Object.getOwnPropertyDescriptor(object, name); return !!d && 'value' in d && d.value === fn; };
  const original = { now: clock.now, resolve: trustedContext.resolve, authorize: financeAuthority.authorizeCurrent };
  let fence;
  const intact = () => !invalid && bound && own(bound, 'clock', clock) && own(bound, 'trustedContext', trustedContext) && own(bound, 'financeAuthority', financeAuthority) && own(clock, 'now', original.now) && own(trustedContext, 'resolve', original.resolve) && own(financeAuthority, 'authorizeCurrent', original.authorize) && own(fence, 'acquire', acquire) && own(fence, 'validateCurrent', validateCurrent);
  const allowed = (current, request) => request.schemaVersion === '1.0.0' && JSON.stringify(request.requiredPermissions) === JSON.stringify(tuple) && same(request.scope, current.scope) && current.active && current.contextStatus === 'present' && same(current.contextScope, current.scope) && current.readStatus === 'allowed' && current.exportStatus === 'allowed' && current.from <= current.now && current.until > current.now;
  async function acquire(request) {
    const frame = frozen(request), before = record; if (!intact() || !allowed(before, frame)) return null;
    await boundary('acquire'); const current = record;
    if (!intact() || current.generation !== before.generation || !allowed(current, frame)) return null;
    nextPermitExpiry = Math.min(nextPermitExpiry, current.now + 60000, current.until);
    const permit = Object.freeze(Object.create(null)); permits.set(permit, frozen({ scope: frame.scope, generation: current.generation, principalKind: current.principalKind, principalRevision: current.principalRevision,
      contextRevision: current.contextRevision, readRevision: current.readRevision, exportRevision: current.exportRevision, expires: Math.min(current.until, current.now + 60000) })); return permit;
  }
  function validateCurrent(permit, request) {
    counters.validations++; const current = record, issued = permits.get(permit); // one CURRENT authoritative view
    const refuse = status => Object.freeze({ schemaVersion: '1.0.0', status });
    if (!intact() || !issued) return refuse('unavailable');
    if (!allowed(current, request) || !same(request.scope, issued.scope) || current.generation !== issued.generation || current.now >= issued.expires
        || ['principalKind', 'principalRevision', 'contextRevision', 'readRevision', 'exportRevision'].some(key => current[key] !== issued[key])) return refuse('denied');
    return frozen({ schemaVersion: '1.0.0', status: 'allowed', stateRevision: 'synthetic-state-' + current.generation, scope: current.scope,
      context: { scope: current.contextScope, revision: current.contextRevision, verifiedAt: new Date(current.now).toISOString(), expiresAt: new Date(Math.min(current.until, current.now + 60000)).toISOString() },
      read: decision(current, 'reporting.querySummary', tuple[0]), export: decision(current, 'integrations.exportSummary', tuple[1]) });
  }
  fence = { acquire, validateCurrent };
  const state = {};
  for (const key of ['calls', 'reads']) Object.defineProperty(state, key, { get: () => counters[key], set: value => { counters[key] = value; }, enumerable: true });
  Object.defineProperties(state, {
    denyRead: { get: () => record.readStatus !== 'allowed', set: denied => controller.setGrant(tuple[0], denied ? 'denied' : 'allowed') },
    denyExport: { get: () => record.exportStatus !== 'allowed', set: denied => controller.setGrant(tuple[1], denied ? 'denied' : 'allowed') },
    denied: { get: () => !record.active, set: denied => controller.setPrincipal(!denied) },
    clock: { get: () => new Date(record.now).toISOString(), set: next => controller.advanceTime(next) },
  });
  return { fixtureMode: 'synthetic_only', clock, trustedContext, financeAuthority, fence, controller, state, counters };
}
