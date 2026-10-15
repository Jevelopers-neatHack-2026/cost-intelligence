// Synthetic schema11 catalog for control-flow-only scripted ports. This is not PostgreSQL capability evidence.
const tables=['budget_source_observations','budget_lifecycle_observations','budget_command_receipts','budget_settlement_postings','budget_reconciliation_exceptions','budget_recovery_cursors','budget_reported_observations'];
const unique={
 budget_source_observations:['UNIQUE (tenant_id, project_id, environment, billing_mode, record_id, record_revision)'],
 budget_lifecycle_observations:['UNIQUE (tenant_id, project_id, environment, billing_mode, reservation_id, event_sequence)','UNIQUE (tenant_id, project_id, environment, billing_mode, idempotency_key)'],
 budget_command_receipts:['UNIQUE (tenant_id, project_id, environment, billing_mode, idempotency_key)'],
 budget_settlement_postings:['UNIQUE (tenant_id, project_id, environment, billing_mode, reservation_id, reservation_revision)','FOREIGN KEY (observation_id) REFERENCES cost_intelligence.budget_source_observations(observation_id)','FOREIGN KEY (ledger_event_id) REFERENCES cost_intelligence.financial_ledger_events(event_id)'],
 budget_reconciliation_exceptions:['UNIQUE (tenant_id, project_id, environment, billing_mode, exception_id, revision)','UNIQUE (tenant_id, project_id, environment, billing_mode, exception_id, idempotency_key)'],
 budget_recovery_cursors:['UNIQUE (tenant_id, project_id, environment, billing_mode, currency, job_reference, revision)','UNIQUE (tenant_id, project_id, environment, billing_mode, idempotency_key)'],
 budget_reported_observations:['PRIMARY KEY (tenant_id, project_id, environment, billing_mode, source_observation_id)','UNIQUE (tenant_id, project_id, environment, billing_mode, provider_evidence_id, provider_evidence_revision)','FOREIGN KEY (collector_observation_id) REFERENCES cost_intelligence.budget_source_observations(observation_id)','FOREIGN KEY (ledger_event_id) REFERENCES cost_intelligence.financial_ledger_events(event_id)'],
};
const guards=[['budget_lifecycle_observations','guard_budget_revision_append'],['budget_source_observations','guard_budget_source_append'],['budget_reported_observations','guard_budget_reported_append'],['budget_reconciliation_exceptions','guard_budget_queue_append'],['budget_recovery_cursors','guard_budget_queue_append'],['financial_privacy_quarantine','guard_financial_privacy_scope_insert']];
export function syntheticCapabilityRows(sql){
 if(sql==='SELECT migrations_ready,required_migrations_present FROM cost_intelligence.foundation_health')return [{migrations_ready:true,required_migrations_present:11}];
 if(sql.includes('AS has_decisions')&&sql.includes('AS extension_columns'))return [{has_decisions:true,has_acknowledgements:true,has_attempt_index:true,has_revision_function:true,extension_columns:7}];
 if(sql.includes('AS attempt_unique')&&sql.includes('AS revision_guards'))return [{attempt_unique:true,ack_key_unique:true,ack_revision_unique:true,policy_key_unique:true,revision_guards:2,forced_rls_tables:2}];
 if(sql.includes('SELECT required.name,to_regclass'))return tables.map(name=>({name,present:true}));
 if(sql.includes('SELECT conname,convalidated,pg_get_constraintdef'))return [
  ['financial_ledger_events_valuation_check','valuation'],['usage_intake_inbox_valuation_basis_check','valuation_basis'],['usage_intake_attempts_valuation_basis_check','valuation_basis'],
 ].map(([conname,column])=>({conname,convalidated:true,definition:`CHECK ((${column} = ANY (ARRAY['unknown'::text, 'estimated'::text, 'provider_confirmed'::text, 'provider_reported_unsettled'::text])))`}));
 if(sql.includes("SELECT to_regprocedure('cost_intelligence.guard_financial_privacy_scope_insert()')"))return [{present:true}];
 if(sql.includes('SELECT required.table_name,required.column_name FROM unnest'))return [];
 if(sql.includes('SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid'))return tables.map(relname=>({relname,relrowsecurity:true,relforcerowsecurity:true,owner:'ci_finance_owner',append_guards:2}));
 if(sql.includes('SELECT tablename,roles::text[],cmd,permissive,qual,with_check FROM pg_policies'))return tables.map(tablename=>({tablename,roles:['ci_finance_runtime'],cmd:'ALL',permissive:'PERMISSIVE',qual:'cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode)',with_check:'cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode)'}));
 if(sql.includes('SELECT c.relname,t.tgname,p.proname,t.tgtype'))return guards.map(([relname,proname])=>({relname,proname,tgname:relname==='financial_privacy_quarantine'?'financial_privacy_quarantine_scope_insert_guard':relname+'_revision_guard',tgtype:7,tgenabled:'O',prosecdef:false,tgisinternal:false,proconfig:['search_path=pg_catalog, cost_intelligence'],function_owner:'ci_finance_owner'}));
 if(sql.includes('SELECT c.relname,k.convalidated,k.condeferrable,pg_get_constraintdef'))return Object.entries(unique).flatMap(([relname,definitions])=>definitions.map(definition=>({relname,convalidated:true,condeferrable:false,definition})));
 return null;
}
