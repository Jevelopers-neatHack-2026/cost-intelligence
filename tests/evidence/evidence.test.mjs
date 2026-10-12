import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FINANCE_OPERATION_POLICY,
  evidenceAuthority,
  lookupByOperationalReference,
  lookupPostingEvidence,
  operationalReferencesFor,
  validateEvidenceReference,
} from '../../dist/index.js';

const now = '2026-10-12T05:30:00.000Z';
const scopeA = { tenantId: 'tenant-a', projectId: 'project-a', environment: 'test', billingMode: 'simulated', actorId: 'actor-a' };
const scopeB = { ...scopeA, tenantId: 'tenant-b', actorId: 'actor-b' };
const clock = { now: () => new Date(now) };

function authority(denied = false) {
  return {
    async authorizeCurrent(request) {
      if (denied) return { status: 'denied', operation: request.operation, permission: request.permission };
      return {
        status: 'allowed', decisionId: 'synthetic', operation: request.operation, permission: request.permission,
        scope: request.requestedScope,
        principal: { kind: 'user', actorId: request.requestedScope.actorId, membershipStatus: 'active', membershipRevision: 'm1' },
        verifiedAt: now, expiresAt: '2026-10-12T05:31:00.000Z',
      };
    },
  };
}

function record(scope, overrides = {}) {
  return {
    scope: { tenantId: scope.tenantId, projectId: scope.projectId, environment: scope.environment, billingMode: scope.billingMode },
    eventId: 'evt-expense-1', eventType: 'expense', classification: 'direct_cost', financialEffect: true,
    correlationId: 'corr-1', logicalOperationId: 'op-1', sourceObservationId: 'obs-1', reservationId: 'res-1',
    transportAttempt: { status: 'known', id: 'tr-1' }, providerAttempt: { status: 'unknown' },
    providerRequest: { status: 'known', id: 'req_abc123' }, billableAttempt: { status: 'known', id: 'ba-1' },
    provider: 'OpenAI', workflowId: 'wf-1', jobId: null,
    pricing: { policyVersion: 'p1', ruleVersion: 'r1', rateCardRef: null },
    supersedesEventId: null, reversesEventId: null,
    ...overrides,
  };
}

/** In-memory store that honors scope the way a real store must. */
function store(rows, { leak = false, permissive = false, unavailable = new Set(), calls = [] } = {}) {
  const same = (s, r) => r.scope.tenantId === s.tenantId && r.scope.projectId === s.projectId
    && r.scope.environment === s.environment && r.scope.billingMode === s.billingMode;
  const visible = scope => (leak ? rows : rows.filter(r => same(scope, r)));
  return {
    calls,
    async getPosting(scope, eventId) {
      calls.push('getPosting');
      if (unavailable.has('getPosting')) return { status: 'unavailable' };
      return { status: 'ok', value: visible(scope).find(r => r.eventId === eventId) ?? null };
    },
    async listByLogicalOperation(scope, id) {
      if (unavailable.has('list')) return { status: 'unavailable' };
      return { status: 'ok', value: { records: visible(scope).filter(r => r.logicalOperationId === id), truncated: false } };
    },
    async findByReference(scope, reference) {
      calls.push('findByReference');
      calls.lastReference = reference;
      if (permissive) return { status: 'ok', value: { records: visible(scope), truncated: false } };
      const field = { logical_operation: 'logicalOperationId', source_observation: 'sourceObservationId', correlation: 'correlationId', reservation: 'reservationId', workflow: 'workflowId' }[reference.kind];
      const records = visible(scope).filter(r => (reference.kind === 'provider_request'
        ? r.providerRequest.id === reference.id && `provider:${String(r.provider).toLowerCase()}` === reference.namespace
        : field && r[field] === reference.id));
      return { status: 'ok', value: { records, truncated: false } };
    },
  };
}

const observation = scope => record(scope, { eventId: 'evt-obs-1', eventType: 'usage_observation', classification: 'usage_memo', financialEffect: false, reservationId: null });
const request = (scope, extra) => ({ schemaVersion: '1.0.0', requestId: 'req-1', scope, ...extra });
const ports = (rows, opts = {}) => ({ store: store(rows, opts), clock, financeAuthority: authority(opts.denied) });

test('reference validation separates resolved/unknown/unavailable/not_applicable and never accepts ids on the others', () => {
  const ok = value => validateEvidenceReference(value).ok;
  assert.ok(ok({ status: 'resolved', kind: 'logical_operation', namespace: 'cost-intelligence', id: 'op-1' }));
  assert.ok(ok({ status: 'unknown', kind: 'trace' }));
  assert.ok(ok({ status: 'unavailable', kind: 'trace', reason: 'source_unreachable' }));
  assert.ok(ok({ status: 'not_applicable', kind: 'provider_request', reason: 'not_generated_by_source' }));
  assert.equal(ok({ status: 'unknown', kind: 'trace', id: 'fabricated' }), false);
  assert.equal(ok({ status: 'unavailable', kind: 'trace', reason: 'source_unreachable', id: 'x' }), false);
  assert.equal(ok({ status: 'resolved', kind: 'trace', namespace: 'neatlogs' }), false, 'resolved requires an id');
  assert.equal(ok({ status: 'resolved', kind: 'trace', namespace: 'neatlogs', id: '' }), false);
  assert.equal(ok({ status: 'unavailable', kind: 'trace', reason: 'made-up' }), false);
});

test('namespace, id shape and sensitive URL parameters are validated', () => {
  const resolved = (kind, namespace, id) => validateEvidenceReference({ status: 'resolved', kind, namespace, id }).ok;
  assert.equal(resolved('logical_operation', 'neatlogs', 'op-1'), false, 'wrong namespace for kind');
  assert.equal(resolved('trace', 'cost-intelligence', 't1'), false);
  assert.equal(resolved('trace', 'neatlogs', 'https://x.example/t?token=SECRET'), false);
  assert.equal(resolved('trace', 'neatlogs', 'abc def'), false);
  assert.equal(resolved('trace', 'neatlogs', 'abc?x=1'), false);
  assert.equal(resolved('trace', 'neatlogs', 'a'.repeat(257)), false);
  assert.equal(resolved('artifact_hash', 'design-system', 'not-a-hash'), false);
  assert.ok(resolved('artifact_hash', 'design-system', `sha256:${'a'.repeat(64)}`));
  assert.equal(resolved('repo_commit', 'git', 'main'), false);
  assert.ok(resolved('repo_commit', 'git', 'a'.repeat(40)));
  assert.ok(resolved('provider_request', 'provider:openai', 'req_abc123'));
  assert.equal(resolved('provider_request', 'openai', 'req_abc123'), false);
  assert.equal(resolved('dev_session', 'entire', 's1'), true);
  assert.equal(validateEvidenceReference(null).ok, false);
  assert.equal(validateEvidenceReference('x').ok, false);
});

test('provider request ids and trace systems are never billing authority', async () => {
  assert.equal(evidenceAuthority('provider_request'), 'correlation_only');
  assert.equal(evidenceAuthority('trace'), 'evidence_only');
  assert.equal(evidenceAuthority('dev_session'), 'evidence_only');
  assert.equal(evidenceAuthority('billable_attempt'), 'ledger_identity');
  const result = await lookupByOperationalReference(
    request(scopeA, { reference: { status: 'resolved', kind: 'correlation', namespace: 'cost-intelligence', id: 'corr-1' } }),
    ports([record(scopeA), record(scopeA, { eventId: 'evt-2', sourceObservationId: 'obs-2' })]),
  );
  assert.ok(result.ok);
  assert.equal(result.value.billingAuthority, false);
  assert.equal(result.value.matchBasis, 'correlation_only');
  assert.ok(result.value.gaps.includes('correlation_only_match'));
  assert.equal(JSON.stringify(result.value).includes('amount'), false, 'no amounts are returned or summed');
});

test('operational references report known/unknown/not_applicable/unavailable without inventing ids', () => {
  const refs = operationalReferencesFor(record(scopeA, { billableAttempt: { status: 'not_applicable' }, jobId: null, providerRequest: { status: 'unknown' } }));
  const by = kind => refs.find(ref => ref.kind === kind);
  assert.deepEqual(by('transport_attempt'), { status: 'resolved', kind: 'transport_attempt', namespace: 'cost-intelligence', id: 'tr-1' });
  assert.deepEqual(by('provider_attempt'), { status: 'unknown', kind: 'provider_attempt' });
  assert.equal(by('billable_attempt').status, 'not_applicable');
  assert.deepEqual(by('provider_request'), { status: 'unknown', kind: 'provider_request' });
  assert.deepEqual(by('job'), { status: 'unknown', kind: 'job' });
  for (const kind of ['trace', 'design_version', 'repo_commit', 'build', 'dev_session', 'checkpoint']) {
    assert.deepEqual(by(kind), { status: 'unavailable', kind, reason: 'source_not_integrated' });
  }
  for (const ref of refs) assert.ok(validateEvidenceReference(ref).ok, `${ref.kind} output validates`);
  const withRequest = operationalReferencesFor(record(scopeA)).find(ref => ref.kind === 'provider_request');
  assert.deepEqual(withRequest, { status: 'resolved', kind: 'provider_request', namespace: 'provider:openai', id: 'req_abc123' });
  const noProvider = operationalReferencesFor(record(scopeA, { provider: null })).find(ref => ref.kind === 'provider_request');
  assert.deepEqual(noProvider, { status: 'unavailable', kind: 'provider_request', reason: 'broken_link' }, 'no guessed provider namespace');
});

test('posting lookup links observations, reservation, rate/rule refs and declares remaining gaps', async () => {
  const result = await lookupPostingEvidence(request(scopeA, { eventId: 'evt-expense-1' }), ports([record(scopeA), observation(scopeA)]));
  assert.ok(result.ok);
  const value = result.value;
  assert.equal(value.status, 'found');
  assert.equal(value.posting.eventId, 'evt-expense-1');
  assert.deepEqual(value.sourceObservations.map(item => item.eventId), ['evt-obs-1']);
  assert.deepEqual(value.reservation, { status: 'resolved', kind: 'reservation', namespace: 'cost-intelligence', id: 'res-1' });
  assert.deepEqual(value.rateRule, { policyVersion: 'p1', ruleVersion: 'r1', rateCardRef: null });
  for (const gap of ['rate_card_not_recorded', 'reconciliation_lineage_not_linked', 'adjustment_lineage_not_linked', 'export_lineage_not_linked']) {
    assert.ok(value.gaps.includes(gap), gap);
  }
  assert.equal(value.billingAuthority, false);
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes('event_payload'), false);
  assert.equal(serialized.includes('prompt'), false);
});

test('reservation not applicable and unavailable observation source are declared, not hidden', async () => {
  const noReservation = record(scopeA, { reservationId: null, pricing: null });
  const result = await lookupPostingEvidence(request(scopeA, { eventId: 'evt-expense-1' }), ports([noReservation], { unavailable: new Set(['list']) }));
  assert.ok(result.ok);
  assert.equal(result.value.reservation.status, 'not_applicable');
  assert.ok(result.value.gaps.includes('source_observations_unavailable'));
  assert.ok(result.value.gaps.includes('pricing_not_recorded'));
  assert.deepEqual(result.value.sourceObservations, []);
});

test('cross-tenant posting and reverse lookups refuse, and a leaky store cannot widen scope', async () => {
  const rows = [record(scopeB, { eventId: 'evt-b-1' }), observation(scopeB)];
  const own = await lookupPostingEvidence(request(scopeA, { eventId: 'evt-b-1' }), ports(rows));
  assert.ok(own.ok);
  assert.equal(own.value.status, 'not_found');
  assert.equal(own.value.posting, null);
  assert.deepEqual(own.value.operationalReferences, []);
  const absent = await lookupPostingEvidence(request(scopeA, { eventId: 'evt-none' }), ports(rows));
  assert.deepEqual(absent.value, own.value, 'absent and other-tenant are indistinguishable');

  const leakyPosting = await lookupPostingEvidence(request(scopeA, { eventId: 'evt-b-1' }), ports(rows, { leak: true }));
  assert.equal(leakyPosting.value.status, 'not_found', 'returned rows are re-verified against the requested scope');
  const leakyReverse = await lookupByOperationalReference(
    request(scopeA, { reference: { status: 'resolved', kind: 'logical_operation', namespace: 'cost-intelligence', id: 'op-1' } }),
    ports(rows, { leak: true }),
  );
  assert.ok(leakyReverse.ok);
  assert.deepEqual(leakyReverse.value.matches, []);
  assert.ok(leakyReverse.value.gaps.includes('no_match_is_not_proof_of_zero_usage'));

  const reverse = await lookupByOperationalReference(
    request(scopeA, { reference: { status: 'resolved', kind: 'source_observation', namespace: 'cost-intelligence', id: 'obs-1' } }), ports(rows));
  assert.deepEqual(reverse.value.matches, []);
  const sameProjectOtherEnv = { ...scopeA, environment: 'production' };
  const crossEnv = await lookupPostingEvidence(request(sameProjectOtherEnv, { eventId: 'evt-expense-1' }), ports([record(scopeA)]));
  assert.equal(crossEnv.value.status, 'not_found');
});

test('reverse lookup preserves scope, finds linked records and declares completeness gaps', async () => {
  const result = await lookupByOperationalReference(
    request(scopeA, { reference: { status: 'resolved', kind: 'logical_operation', namespace: 'cost-intelligence', id: 'op-1' } }),
    ports([record(scopeA), observation(scopeA), record(scopeB, { eventId: 'evt-b' })]),
  );
  assert.ok(result.ok);
  assert.deepEqual(result.value.matches.map(item => item.eventId).sort(), ['evt-expense-1', 'evt-obs-1']);
  assert.equal(result.value.matchBasis, 'ledger_identity');
  assert.ok(result.value.gaps.includes('reference_kinds_not_indexed'));
  assert.ok(result.value.gaps.includes('export_lineage_not_linked'));
});

test('reverse lookup refuses unvalidated, unresolved and non-indexed references before touching the store', async () => {
  const live = ports([record(scopeA)]);
  const attempts = [
    { status: 'unknown', kind: 'logical_operation' },
    { status: 'unavailable', kind: 'logical_operation', reason: 'source_unreachable' },
    { status: 'not_applicable', kind: 'logical_operation', reason: 'not_part_of_operation' },
    { status: 'resolved', kind: 'dev_session', namespace: 'entire', id: 's1' },
    { status: 'resolved', kind: 'trace', namespace: 'neatlogs', id: 't1' },
    { status: 'resolved', kind: 'logical_operation', namespace: 'neatlogs', id: 'op-1' },
    { status: 'resolved', kind: 'logical_operation', namespace: 'cost-intelligence', id: 'op-1?token=SECRET' },
  ];
  for (const reference of attempts) {
    const result = await lookupByOperationalReference(request(scopeA, { reference }), live);
    assert.equal(result.ok, false, JSON.stringify(reference));
    assert.equal(result.error.code, 'VALIDATION_ERROR');
  }
  assert.deepEqual(live.store.calls, []);
});

test('lookups fail closed without current authority and never read the store', async () => {
  const denied = ports([record(scopeA)], { denied: true });
  const posting = await lookupPostingEvidence(request(scopeA, { eventId: 'evt-expense-1' }), denied);
  assert.equal(posting.ok, false);
  assert.equal(posting.error.code, 'FORBIDDEN_SCOPE');
  const reverse = await lookupByOperationalReference(
    request(scopeA, { reference: { status: 'resolved', kind: 'logical_operation', namespace: 'cost-intelligence', id: 'op-1' } }), denied);
  assert.equal(reverse.error.code, 'FORBIDDEN_SCOPE');
  const unconfigured = { store: store([record(scopeA)]), clock };
  const missing = await lookupPostingEvidence(request(scopeA, { eventId: 'evt-expense-1' }), unconfigured);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'SOURCE_UNAVAILABLE');
  assert.deepEqual([...denied.store.calls, ...unconfigured.store.calls], []);

  const wrongActor = { store: store([record(scopeA)]), clock, financeAuthority: { async authorizeCurrent(req) { return authority().authorizeCurrent({ ...req, requestedScope: scopeB }); } } };
  const mismatch = await lookupPostingEvidence(request(scopeA, { eventId: 'evt-expense-1' }), wrongActor);
  assert.equal(mismatch.error.code, 'FORBIDDEN_SCOPE');
});

test('store outages are retryable errors; a throwing store never leaks details; extra request fields are rejected', async () => {
  const down = await lookupPostingEvidence(request(scopeA, { eventId: 'e' }), ports([], { unavailable: new Set(['getPosting']) }));
  assert.equal(down.error.code, 'SOURCE_UNAVAILABLE');
  assert.equal(down.error.retryable, true);
  const throwing = { store: { async getPosting() { throw new Error('connection string postgres://secret'); } }, clock, financeAuthority: authority() };
  const thrown = await lookupPostingEvidence(request(scopeA, { eventId: 'e' }), throwing);
  assert.equal(thrown.error.code, 'SOURCE_UNAVAILABLE');
  assert.equal(JSON.stringify(thrown).includes('secret'), false);
  const extra = await lookupPostingEvidence({ ...request(scopeA, { eventId: 'e' }), prompt: 'raw prompt' }, ports([]));
  assert.equal(extra.error.code, 'VALIDATION_ERROR');
  assert.equal((await lookupPostingEvidence(null, ports([]))).ok, false);
});

test('lookups reuse the existing ledger read grant and add no new finance permission', () => {
  assert.equal(FINANCE_OPERATION_POLICY['ledger.readSnapshot'].permission, 'ledger.snapshot.read');
  assert.equal(Object.keys(FINANCE_OPERATION_POLICY).some(name => name.startsWith('evidence.')), false);
});

const hash = `sha256:${'a'.repeat(64)}`;
const sensitive = /token=SECRET|RAW_PRIVATE_PROMPT|rates\.example|logs\.example|SECRET/;

test('reverse lookup passes the full reference and rechecks namespace, so provider id collisions do not cross', async () => {
  const rows = [record(scopeA, { eventId: 'evt-openai', provider: 'openai', providerRequest: { status: 'known', id: 'req-shared' } }),
    record(scopeA, { eventId: 'evt-anthropic', provider: 'anthropic', providerRequest: { status: 'known', id: 'req-shared' } })];
  const reference = { status: 'resolved', kind: 'provider_request', namespace: 'provider:openai', id: 'req-shared' };
  for (const permissive of [false, true]) {
    const p = ports(rows, { permissive });
    const result = await lookupByOperationalReference(request(scopeA, { reference }), p);
    assert.deepEqual(result.value.matches.map(m => m.eventId), ['evt-openai'], `permissive=${permissive}`);
    assert.deepEqual(p.store.calls.lastReference, reference, 'namespace reaches the store');
  }
});

test('a permissive or faulty store cannot return same-scope unrelated rows', async () => {
  const rows = [record(scopeA), record(scopeA, { eventId: 'evt-other', logicalOperationId: 'op-other', correlationId: 'corr-other', sourceObservationId: 'obs-other', providerRequest: { status: 'unknown' } })];
  const result = await lookupByOperationalReference(
    request(scopeA, { reference: { status: 'resolved', kind: 'logical_operation', namespace: 'cost-intelligence', id: 'op-1' } }),
    ports(rows, { permissive: true }));
  assert.deepEqual(result.value.matches.map(m => m.eventId), ['evt-expense-1']);
  const junk = { store: { ...store(rows), async findByReference() { return { status: 'ok', value: { records: [null, 7, { eventId: 'x' }, ...rows], truncated: false } }; } }, clock, financeAuthority: authority() };
  const survived = await lookupByOperationalReference(
    request(scopeA, { reference: { status: 'resolved', kind: 'logical_operation', namespace: 'cost-intelligence', id: 'op-1' } }), junk);
  assert.deepEqual(survived.value.matches.map(m => m.eventId), ['evt-expense-1']);
});

test('public outputs are allowlist projections: URL token in rateCardRef and extra prompt property never leak', async () => {
  const dirty = record(scopeA, {
    pricing: { policyVersion: 'p1', ruleVersion: 'r1', prompt: 'RAW_PRIVATE_PROMPT',
      rateCardRef: { contract: 'rate-card', id: 'https://rates.example/card?token=SECRET', revision: 1, content_hash: hash, prompt: 'RAW_PRIVATE_PROMPT' } },
    prompt: 'RAW_PRIVATE_PROMPT',
  });
  const result = await lookupPostingEvidence(request(scopeA, { eventId: 'evt-expense-1' }), ports([dirty]));
  assert.ok(result.ok);
  assert.equal(sensitive.test(JSON.stringify(result.value)), false);
  assert.equal(result.value.rateRule.rateCardRef, null);
  assert.ok(result.value.gaps.includes('malformed_source_field'));
  assert.deepEqual(result.value.rateRule, { policyVersion: 'p1', ruleVersion: 'r1', rateCardRef: null });

  const clean = record(scopeA, { pricing: { policyVersion: 'p1', ruleVersion: 'r1', rateCardRef: { contract: 'rate-card', id: 'card-1', revision: 2, content_hash: hash, prompt: 'RAW_PRIVATE_PROMPT' } } });
  const projected = await lookupPostingEvidence(request(scopeA, { eventId: 'evt-expense-1' }), ports([clean]));
  assert.deepEqual(projected.value.rateRule.rateCardRef, { contract: 'rate-card', id: 'card-1', revision: 2, content_hash: hash });
  assert.equal(JSON.stringify(projected.value).includes('RAW_PRIVATE_PROMPT'), false);
});

test('sensitive summary, related-event, observation and version fields are dropped and declared', async () => {
  const dirtyPosting = record(scopeA, {
    eventType: 'expense?token=SECRET', classification: 'https://logs.example/SECRET',
    supersedesEventId: 'https://logs.example/evt?token=SECRET', reversesEventId: 'evt-ok-1',
    pricing: { policyVersion: 'v1?token=SECRET', ruleVersion: 'r1', rateCardRef: null },
    workflowId: 'wf/../../SECRET', providerRequest: { status: 'known', id: 'req?token=SECRET' },
  });
  const dirtyObservation = { ...observation(scopeA), sourceObservationId: 'obs?token=SECRET', eventId: 'evt-obs-ok' };
  const unsafeObservation = { ...observation(scopeA), eventId: 'https://logs.example/evt?token=SECRET' };
  const result = await lookupPostingEvidence(request(scopeA, { eventId: 'evt-expense-1' }), ports([dirtyPosting, dirtyObservation, unsafeObservation]));
  assert.ok(result.ok);
  assert.equal(sensitive.test(JSON.stringify(result.value)), false, JSON.stringify(result.value));
  assert.equal(result.value.posting.eventType, null);
  assert.equal(result.value.posting.classification, null);
  assert.deepEqual(result.value.relatedEventIds, { supersedes: null, reverses: 'evt-ok-1' });
  assert.equal(result.value.rateRule.policyVersion, null);
  assert.deepEqual(result.value.sourceObservations.map(o => [o.eventId, o.sourceObservationId]), [['evt-obs-ok', null]]);
  assert.ok(result.value.gaps.includes('malformed_source_field'));
  const byKind = kind => result.value.operationalReferences.find(ref => ref.kind === kind);
  assert.deepEqual(byKind('workflow'), { status: 'unavailable', kind: 'workflow', reason: 'broken_link' });
  assert.deepEqual(byKind('provider_request'), { status: 'unavailable', kind: 'provider_request', reason: 'broken_link' });
});

test('unsafe posting event ids and reverse-lookup match ids are not echoed', async () => {
  const bad = await lookupPostingEvidence(request(scopeA, { eventId: 'https://logs.example/evt?token=SECRET' }), ports([]));
  assert.equal(bad.error.code, 'VALIDATION_ERROR');
  const rows = [record(scopeA, { eventId: 'https://logs.example/evt?token=SECRET' })];
  const reverse = await lookupByOperationalReference(
    request(scopeA, { reference: { status: 'resolved', kind: 'logical_operation', namespace: 'cost-intelligence', id: 'op-1' } }), ports(rows));
  assert.deepEqual(reverse.value.matches, []);
  assert.ok(reverse.value.gaps.includes('malformed_source_field'));
  assert.equal(sensitive.test(JSON.stringify(reverse.value)), false);
});

test('URL-shaped ids are rejected for every kind, including paths and query strings', () => {
  const urls = ['https://logs.example/private/SECRET', 'logs.example/private/SECRET', 'a/b', 'x?token=SECRET', 'x#frag', 'http://h', '//h/p'];
  const samples = [['trace', 'neatlogs'], ['correlation', 'cost-intelligence'], ['logical_operation', 'cost-intelligence'],
    ['provider_request', 'provider:openai'], ['design', 'design-system'], ['build', 'ci'], ['dev_session', 'entire'], ['checkpoint', 'entire']];
  for (const [kind, namespace] of samples) {
    for (const id of urls) assert.equal(validateEvidenceReference({ status: 'resolved', kind, namespace, id }).ok, false, `${kind} ${id}`);
  }
});

// Synthetic authority/store barriers exercise the public disclosure boundary.
// These do not claim a mounted host issuer or a database-backed evidence adapter.
for (const stage of ['getPosting', 'listByLogicalOperation', 'findByReference']) {
  test(`revocation during ${stage} denies evidence and prevents any later read`, async () => {
    let revoked = false;
    const calls = [];
    const base = store([record(scopeA), observation(scopeA)]);
    const guardedStore = Object.fromEntries(['getPosting', 'listByLogicalOperation', 'findByReference'].map(method => [method, async (...args) => {
      calls.push(method);
      const result = await base[method](...args);
      if (method === stage) revoked = true;
      return result;
    }]));
    const runtime = { store: guardedStore, clock, financeAuthority: {
      async authorizeCurrent(input) { return authority(revoked).authorizeCurrent(input); },
    } };
    const result = stage === 'findByReference'
      ? await lookupByOperationalReference(request(scopeA, { reference: { status: 'resolved', kind: 'logical_operation', namespace: 'cost-intelligence', id: 'op-1' } }), runtime)
      : await lookupPostingEvidence(request(scopeA, { eventId: 'evt-expense-1' }), runtime);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'FORBIDDEN_SCOPE');
    assert.equal(Object.hasOwn(result, 'value'), false, 'denial must not carry retained data');
    assert.deepEqual(calls, stage === 'getPosting' ? ['getPosting']
      : stage === 'listByLogicalOperation' ? ['getPosting', 'listByLogicalOperation'] : ['findByReference']);
  });
}

for (const outcome of ['absent', 'unavailable']) {
  test(`late revocation also denies ${outcome} evidence lookups`, async () => {
    let revoked = false;
    const runtime = { clock, financeAuthority: {
      async authorizeCurrent(input) { return authority(revoked).authorizeCurrent(input); },
    }, store: { async getPosting() {
      revoked = true;
      return outcome === 'absent' ? { status: 'ok', value: null } : { status: 'unavailable' };
    } } };
    const result = await lookupPostingEvidence(request(scopeA, { eventId: 'evt-expense-1' }), runtime);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'FORBIDDEN_SCOPE');
    assert.equal(Object.hasOwn(result, 'value'), false);
  });
}

for (const change of ['unavailable', 'expired', 'foreign_scope', 'membership_revision']) {
  test(`a ${change} final authority cannot disclose a previously readable posting`, async () => {
    let readFinished = false;
    const base = store([record(scopeA), observation(scopeA)]);
    const runtime = { clock, store: { ...base, async listByLogicalOperation(...args) {
      const result = await base.listByLogicalOperation(...args);
      readFinished = true;
      return result;
    } }, financeAuthority: { async authorizeCurrent(input) {
      if (readFinished && change === 'unavailable') return null;
      const decision = await authority().authorizeCurrent(input);
      if (readFinished && change === 'expired') return { ...decision, expiresAt: now };
      if (readFinished && change === 'foreign_scope') return { ...decision, scope: scopeB };
      if (readFinished && change === 'membership_revision') return { ...decision, principal: { ...decision.principal, membershipRevision: 'm2' } };
      return decision;
    } } };
    const result = await lookupPostingEvidence(request(scopeA, { eventId: 'evt-expense-1' }), runtime);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, change === 'unavailable' ? 'SOURCE_UNAVAILABLE' : 'FORBIDDEN_SCOPE');
    assert.equal(Object.hasOwn(result, 'value'), false);
  });
}

test('caller mutation during authorization cannot substitute evidence scope or posting identity', async () => {
  const submitted = request({ ...scopeA }, { eventId: 'evt-expense-1' });
  const seen = [];
  const base = store([record(scopeA), record(scopeB, { eventId: 'evt-b' })]);
  const runtime = { clock, store: { ...base, async getPosting(scope, id) {
    seen.push({ scope: { ...scope }, id });
    return base.getPosting(scope, id);
  } }, financeAuthority: { async authorizeCurrent(input) {
    Object.assign(submitted.scope, scopeB);
    submitted.eventId = 'evt-b';
    return authority().authorizeCurrent(input);
  } } };
  const result = await lookupPostingEvidence(submitted, runtime);
  assert.ok(result.ok);
  assert.equal(result.value.posting.eventId, 'evt-expense-1');
  assert.deepEqual(seen, [{ scope: scopeA, id: 'evt-expense-1' }]);
});

test('caller mutation during authorization cannot substitute a reverse lookup reference', async () => {
  const submitted = request({ ...scopeA }, { reference: { status: 'resolved', kind: 'logical_operation', namespace: 'cost-intelligence', id: 'op-1' } });
  const runtime = ports([record(scopeA), record(scopeA, { eventId: 'evt-other', logicalOperationId: 'op-other' })]);
  runtime.financeAuthority = { async authorizeCurrent(input) {
    submitted.reference.id = 'op-other';
    return authority().authorizeCurrent(input);
  } };
  const result = await lookupByOperationalReference(submitted, runtime);
  assert.ok(result.ok);
  assert.deepEqual(result.value.matches.map(item => item.eventId), ['evt-expense-1']);
});

test('store-owned posting records cannot change while related evidence is read', async () => {
  const row = record(scopeA);
  const base = store([row, observation(scopeA)]);
  const runtime = { ...ports([]), store: { ...base, async listByLogicalOperation(...args) {
    row.eventId = 'evt-substituted';
    row.reservationId = 'res-substituted';
    return base.listByLogicalOperation(...args);
  } } };
  const result = await lookupPostingEvidence(request(scopeA, { eventId: 'evt-expense-1' }), runtime);
  assert.ok(result.ok);
  assert.equal(result.value.posting.eventId, 'evt-expense-1');
  assert.equal(result.value.reservation.id, 'res-1');
});
