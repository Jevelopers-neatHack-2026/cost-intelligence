import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { mkdir,writeFile } from 'node:fs/promises';
import * as finance from '../../dist/index.js';
import * as reporting from '../../dist/reporting/index.js';
import { bindFinancialDatabaseScope } from '../../dist/shared/database-scope.js';
import { runtimeDatabaseConfigFromEnvironment,databaseConfigFromEnvironment,assertDisposableMarker } from '../../scripts/test-db-lifecycle.mjs';
import { posting,fixtureScope,hostPorts,checked } from '../exports/query-export-fixtures.mjs';
import { makeStoredRecords,ownerFixture,canonical } from './partition-binding-fixture.mjs';
import { partitionBindingSQLiteEvidence } from './partition-binding.test.mjs';
await test('Finance binding actual restricted PG initial source and governed owner fixture',async t=>{
 const admin=new pg.Pool({...databaseConfigFromEnvironment('CI_TEST_DB'),max:1}),pool=new pg.Pool({...runtimeDatabaseConfigFromEnvironment(),max:4});
 const evidence={status:'ACTUAL_ISOLATED_PG_SQLITE_BINDING_PROOF_NOT_LIVE_ISSUER_OR_PRODUCT_PROVISIONING',SQLiteOrdering:partitionBindingSQLiteEvidence,observations:[]};let f;
 async function proof(scope,eventId){const client=await pool.connect();try{await client.query('BEGIN READ ONLY');await bindFinancialDatabaseScope(client,scope);const row=(await client.query('SELECT source_name,source_object_id,source_revision_subject_id,source_revision_sequence,event_id,event_hash,economic_root_event_id,financial_effect FROM cost_intelligence.financial_ledger_events WHERE event_id=$1',[eventId])).rows[0];assert.ok(row);const origin=(await client.query('SELECT event_id,event_hash FROM cost_intelligence.financial_ledger_events WHERE event_id=$1',[row.economic_root_event_id])).rows[0];await client.query('COMMIT');return {sourceIdentity:{sourceName:row.source_name,sourceObjectId:row.source_object_id,revisionSubjectId:row.source_revision_subject_id},rootEvent:{eventId:origin.event_id,eventHash:origin.event_hash},currentHead:{eventId:row.event_id,eventHash:row.event_hash,revisionSequence:Number(row.source_revision_sequence)},financialEffect:row.financial_effect};}finally{client.release();}}
 function sourceIntent(operation){const db=new DatabaseSync(f.path);try{db.exec('BEGIN IMMEDIATE');db.prepare("INSERT INTO finance_binding_source_intents VALUES(?,'changing')").run(operation);db.exec('COMMIT');}finally{db.close();}}
 function publish(records,operation){const db=new DatabaseSync(f.path);try{db.exec('BEGIN IMMEDIATE');db.prepare('UPDATE finance_binding_custody_snapshots SET body=? WHERE binding_id=?').run(canonical(records),records.binding.unsigned.id);db.prepare("UPDATE finance_binding_source_intents SET state='published' WHERE operation_id=?").run(operation);db.exec('COMMIT');Object.assign(f.records,records);Object.assign(f.request,{bindingReference:records.bindingReference});f.frame.signedMaintainerActionCanonicalBytes=canonical(records.action);}finally{db.close();}}
 try{
  assertDisposableMarker((await admin.query('SELECT marker FROM ci_test.disposable_database_marker')).rows);
  assert.deepEqual((await pool.query('SELECT migrations_ready,required_migrations_present FROM cost_intelligence.foundation_health')).rows,
   [{migrations_ready:true,required_migrations_present:11}],'the actual selected PG source exposes exact core11; independent feature migrations do not increase this count');
  const scope=fixtureScope({actorId:'synthetic-binding-source-owner',billingMode:'simulated'}),{ports}=hostPorts(scope,pool),databaseName=(await pool.query('SELECT current_database() AS name')).rows[0].name;
  // This PG writer is held only by this owner fixture, and ALWAYS commits changing intent before append.
  f=ownerFixture(makeStoredRecords({scope,backendName:databaseName}),{database:pool,databaseName});
  const initial=structuredClone(posting(scope,'binding-anchor',{amount:null}));initial.eventType='usage_observation';initial.classification='usage_memo';initial.financialEffect=false;let latestEventId=initial.eventId;
  assert.equal(finance.validateLedgerAppendRequestBoundary(initial).ok,true,'FINAL mutated public append payload');
  await t.test('genuine initial public append sequence0/nonfinancial root is independently signed and admitted',async()=>{
   sourceIntent('initial-source');assert.equal((await f.api.bindingVerifier.verifyCurrentBinding(f.request)).status,'unavailable');
   const appended=await checked(finance.appendLedgerEvent(initial,ports));assert.equal(appended.status,'accepted');const anchor=await proof(scope,initial.eventId);assert.equal(anchor.currentHead.revisionSequence,0);assert.equal(anchor.rootEvent.eventId,anchor.currentHead.eventId);assert.equal(anchor.financialEffect,false);
   publish(makeStoredRecords({scope,backendName:databaseName,sourceProof:anchor}),'initial-source');const result=await f.api.bindingVerifier.verifyCurrentBinding(f.request);assert.equal(result.status,'verified',JSON.stringify(result));assert.equal(result.provenance,'isolated_fixture');evidence.observations.push({case:'initial-nonfinancial-zero-source',anchor,result,actualLedgerAppendStatus:appended.status});
  });
  await t.test('actual PG proof plus held SQLite fence commits mapping/receipt before second source writer intent',async()=>{
   const held=f.api.guardLifecycle.acquireGuard(f.frame);assert.equal(held.status,'held');const prepared=await f.api.bindingCurrentness.prepareCurrentness(held.guard,f.request,f.frame);assert.equal(prepared.status,'ready',JSON.stringify(prepared));
   const signal=new SharedArrayBuffer(4),arr=new Int32Array(signal),worker=new Worker(new URL('./partition-binding-worker.mjs',import.meta.url),{workerData:{path:f.path,signal,mode:'intent',operationId:'next-source'}}),done=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});
   const result=f.commitPrepared(held.guard,prepared.privateBindingHandle,{beforeCommit(){const deadline=Date.now()+5000;while(Atomics.load(arr,0)===0){if(Date.now()>deadline)throw Error('worker-start timeout');Atomics.wait(arr,0,0,100);}}});assert.equal(result.status,'committed');const observed=await done;assert.equal(observed.error,undefined);assert.equal(observed.receiptsSeenAfterGuardAcquired,1);assert.ok(observed.epochAfter>observed.epochBefore);assert.equal((await f.api.bindingVerifier.verifyCurrentBinding(f.request)).status,'unavailable');evidence.observations.push({case:'actual-pg-to-sqlite-commit-before-source-intent',commit:result,secondConnection:observed,mappingRows:f.db.prepare('SELECT id,revision,frame_hash FROM owner_mappings').all(),receiptRows:f.db.prepare('SELECT action_id,frame_hash,source_epoch FROM owner_receipts').all()});
  });
  await t.test('actual next PG source revision remains unavailable until signed authoritative publication',async()=>{
   const revised=structuredClone(posting(scope,'binding-anchor-revision',{subject:'binding-anchor',revision:1,amount:null}));revised.eventType='usage_observation';revised.classification='usage_memo';revised.supersedesEventId=initial.eventId;revised.financialEffect=false;assert.equal(finance.validateLedgerAppendRequestBoundary(revised).ok,true,'FINAL revised public payload');
   assert.equal(f.db.prepare("SELECT state FROM finance_binding_source_intents WHERE operation_id='next-source'").get().state,'changing');const receipt=await checked(finance.appendLedgerEvent(revised,ports));assert.equal(receipt.status,'accepted');latestEventId=revised.eventId;const before=await f.api.bindingVerifier.verifyCurrentBinding(f.request);assert.equal(before.status,'unavailable');assert.equal(before.reason,'source_changing');const anchor=await proof(scope,revised.eventId);assert.equal(anchor.currentHead.revisionSequence,1);assert.equal(anchor.rootEvent.eventId,initial.eventId);
   const records=makeStoredRecords({scope,backendName:databaseName,sourceProof:anchor,recordRevision:2});publish(records,'next-source');const after=await f.api.bindingVerifier.verifyCurrentBinding(f.request);assert.equal(after.status,'verified',JSON.stringify(after));evidence.observations.push({case:'actual-pg-revision-and-crash-window-publication',anchor,beforePublication:before,afterPublication:after,signedRecordRevision:2});
  });
  await t.test('correctly signed foreign PG root and wrong selected backend do not admit',async()=>{
   const observed=await proof(scope,latestEventId),foreign={...observed,rootEvent:{eventId:'foreign-root-not-in-partition',eventHash:observed.rootEvent.eventHash}};const records=makeStoredRecords({scope,backendName:databaseName,sourceProof:foreign,recordRevision:3});publish(records,'next-source');const rejected=await f.api.bindingVerifier.verifyCurrentBinding(f.request);assert.equal(rejected.status,'denied');assert.equal(rejected.reason,'lineage_mismatch');evidence.observations.push({case:'native-signed-foreign-root',refusal:rejected});const wrong=reporting.createFinanceLedgerPartitionBindingVerifier({custodySource:reporting.createIsolatedFinanceSqliteCustodySource(f.db),selectedBackend:{reference:records.backendReference,databaseName:'wrong-selected-database',database:pool},clock:{now:()=>new Date(f.clock.value)}});const refused=await wrong.bindingVerifier.verifyCurrentBinding(f.request);assert.equal(refused.status,'unavailable');assert.equal(refused.reason,'backend_mismatch');evidence.observations.push({case:'wrong-actual-selected-backend',refusal:refused});wrong.guardLifecycle.destroy();
  });
 }finally{
  await mkdir(new URL('../../artifacts/reporting/',import.meta.url),{recursive:true});await writeFile(new URL('../../artifacts/reporting/partition-binding-evidence.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');f?.cleanup();await pool.end();await admin.end();
 }
});
