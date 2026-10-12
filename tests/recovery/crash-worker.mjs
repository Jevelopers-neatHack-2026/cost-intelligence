import pg from 'pg';
import { ingestUsage, replayUsageOutbox } from '../../dist/index.js';
import { runtimeDatabaseConfigFromEnvironment } from '../../scripts/test-db-lifecycle.mjs';

const { Pool } = pg;
const mode = process.argv[2];
const observation = JSON.parse(process.env.CI04A_CRASH_PAYLOAD ?? 'null');
const replayScope = JSON.parse(process.env.CI04A_REPLAY_SCOPE ?? 'null');
if ((!observation || !['before_commit', 'after_commit'].includes(mode))
    && !(mode === 'replay_during' && replayScope)) process.exit(2);
const pool = new Pool({ ...runtimeDatabaseConfigFromEnvironment(), max: 1 });
const clock = { now: () => new Date() };
const ports = {
  database: { connect: async () => {
    const client = await pool.connect();
    return {
      query: async (text, values) => {
        if (text === 'COMMIT' && mode === 'before_commit') {
          process.send?.({ state: 'before_commit' });
          await new Promise(() => {});
        }
        const result = await client.query(text, values);
        if (mode === 'replay_during' && /^INSERT INTO cost_intelligence\.financial_ledger_events/i.test(text)) {
          process.send?.({ state: 'during_replay' });
          await new Promise(() => {});
        }
        if (text === 'COMMIT' && mode === 'after_commit') {
          process.send?.({ state: 'after_commit' });
          await new Promise(() => {});
        }
        return result;
      },
      release: () => client.release(),
    };
  } },
  trustedContext: { resolve: async requested => requested },
  clock,
  financeAuthority: { authorizeCurrent: async request => ({
    status: 'allowed', decisionId: 'ci04a-crash-worker', operation: request.operation,
    permission: request.permission, scope: request.requestedScope,
    principal: { kind: 'service', actorId: request.requestedScope.actorId, serviceStatus: 'active', serviceGrantRevision: 'ci04a-test' },
    verifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }) },
};
const result = mode === 'replay_during'
  ? await replayUsageOutbox({ schemaVersion: '1.0.0', requestId: 'ci04a-crash-replay', scope: replayScope, limit: 100 }, ports)
  : await ingestUsage(observation, ports);
process.send?.({ state: 'returned', ok: result.ok });
await pool.end();
