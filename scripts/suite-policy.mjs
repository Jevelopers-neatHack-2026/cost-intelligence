export const foundationTestFiles = Object.freeze([
  'tests/contracts/shared-contracts.test.mjs',
  'tests/contracts/api-contract-shapes.test.mjs',
  'tests/exports/public-exports.test.mjs',
  'tests/smoke/api-boundaries.test.mjs',
  'tests/traceability/release-gates.test.mjs',
]);

export const databaseTestFiles = Object.freeze(['tests/migrations/migrations.test.mjs']);

export const requiredDomainSuites = Object.freeze([
  'accounting', 'adapters', 'budgets', 'ledger', 'metering', 'pricing', 'reconciliation', 'reporting', 'recovery',
]);
export const deferredDomainSuites = Object.freeze([
  Object.freeze({ suite: 'budgets', selector: 'nested-scopes', issue: 17, priority: 'P1', status: 'assigned_not_v1' }),
]);

const leafPaths = Object.freeze({
  accounting: ['tests/accounting/accounting.test.mjs'],
  adapters: ['tests/adapters/adapters.test.mjs'],
  budgets: ['tests/budgets/authorization.test.mjs', 'tests/budgets/contention.test.mjs', 'tests/budgets/lifecycle.test.mjs'],
  contracts: ['tests/contracts/shared-contracts.test.mjs', 'tests/contracts/api-contract-shapes.test.mjs'],
  exports: ['tests/exports/public-exports.test.mjs', 'tests/exports/csv-encoding.test.mjs'],
  integration: [...foundationTestFiles, ...databaseTestFiles],
  ledger: ['tests/ledger/ledger.test.mjs'],
  metering: ['tests/metering/metering.test.mjs'],
  migrations: databaseTestFiles,
  pricing: ['tests/pricing/pricing.test.mjs'],
  reconciliation: ['tests/reconciliation/reconciliation.test.mjs'],
  recovery: ['tests/recovery/recovery.test.mjs'],
  release: [...foundationTestFiles, ...databaseTestFiles],
  reporting: ['tests/reporting/reporting.test.mjs'],
  security: ['tests/security/security.test.mjs'],
  smoke: ['tests/smoke/api-boundaries.test.mjs', 'tests/smoke/postgres-cleanup.test.mjs'],
  traceability: ['tests/traceability/release-gates.test.mjs'],
  unit: foundationTestFiles,
});

const documentedSelectors = Object.freeze({
  budgets: Object.freeze({
    authorization: ['tests/budgets/authorization.test.mjs'],
    contention: ['tests/budgets/contention.test.mjs'],
    lifecycle: ['tests/budgets/lifecycle.test.mjs'],
    'nested-scopes': ['tests/budgets/nested-scopes.test.mjs'],
  }),
});

export function suitePlan(name, existingFiles, selector) {
  const known = leafPaths[name];
  if (!known) return { name, selector: selector ?? null, requiredFiles: [], selectedFiles: [], missingFiles: [], selectorErrors: [`unknown suite name: ${name}`], requiredDomainSuites: [], deferredDomainSuites: [] };
  let requestedFiles = known;
  const selectorErrors = [];
  if (selector !== undefined) {
    const supported = documentedSelectors[name];
    const requested = selector.split(',').map(value => value.trim());
    if (!selector || requested.some(value => !value) || new Set(requested).size !== requested.length) {
      selectorErrors.push('suite selector must be a nonempty comma-separated list of unique selectors');
    } else if (!supported) {
      selectorErrors.push(`suite ${name} does not define sub-suite selectors`);
    } else {
      const unknown = requested.filter(value => !Object.hasOwn(supported, value));
      if (unknown.length) selectorErrors.push(...unknown.map(value => `unknown ${name} sub-suite selector: ${value}`));
      else requestedFiles = requested.flatMap(value => supported[value]);
    }
  }
  if (selectorErrors.length) requestedFiles = [];
  const requiredDomain = name === 'integration' || name === 'release' ? requiredDomainSuites : [];
  const requiredFiles = [...requestedFiles];
  if (selector === undefined && (name === 'integration' || name === 'release')) {
    for (const suite of requiredDomain) {
      const suiteFiles = leafPaths[suite] ?? [];
      if (suiteFiles.length === 0) requiredFiles.push(`tests/${suite}/`);
      else requiredFiles.push(...suiteFiles);
    }
    if (name === 'release') requiredFiles.push(...leafPaths.security, ...leafPaths.traceability);
  }
  const selectedFiles = [...new Set(requiredFiles)].filter(path => existingFiles.has(path));
  const missingFiles = [...new Set(requiredFiles)].filter(path => !existingFiles.has(path));
  const deferred = name === 'integration' || name === 'release' || name === 'budgets' ? deferredDomainSuites : [];
  return { name, selector: selector ?? null, requiredFiles: [...new Set(requiredFiles)], selectedFiles, missingFiles, selectorErrors, requiredDomainSuites: requiredDomain, deferredDomainSuites: deferred };
}

export { documentedSelectors };
