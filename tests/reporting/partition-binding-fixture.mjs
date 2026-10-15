/** Isolated OWNER fixture coordinator, not Product provisioning or a live Finance source. */
import { DatabaseSync } from 'node:sqlite';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as reporting from '../../dist/reporting/index.js';
export const canonical=reporting.financeBindingCanonicalBytes;
export const hash=v=>'sha256:'+createHash('sha256').update(typeof v==='string'?v:canonical(v)).digest('hex');
const key=label=>createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),createHash('sha256').update('ISOLATED-FINANCE-DESIGN-VECTOR-KEY-NOT-LIVE-20261012:'+label).digest()]),format:'der',type:'pkcs8'});
const signingKeys=new Map([['isolated-key',key('primary')],...['kind','action','scope','entitlement'].map(k=>['isolated-wrong-'+k+'-key',key(k)])]);
export function envelope(unsigned){return {unsigned,signature:{algorithm:'Ed25519',value:sign(null,Buffer.from(unsigned.format+'\n'+canonical(unsigned)),signingKeys.get(unsigned.issuerKeyReference.keyId)).toString('base64url')}};}
const ref=(id,body)=>({id,revision:1,contentHash:hash(body)});
export function makeStoredRecords({scope,backendName='isolated-test-pg',sourceProof,recordRevision=1}={}){
 const template=JSON.parse(readFileSync(new URL('../../fixtures/reporting/partition-binding/records-template.json',import.meta.url),'utf8'));
 const s=structuredClone(template);scope??=s.scope;s.scope=scope;s.partition=Object.fromEntries(Object.entries(scope).filter(([k])=>k!=='actorId'));
 s.backendReference=ref('isolated-pg-backend',{owner:'fixture',name:backendName});s.configurationReference=ref('isolated-owner-config',{verifierId:'isolated-verifier',backend:s.backendReference});
 for(const entitlement of s.registry.entitlements){entitlement.allowedScopes=[scope];entitlement.policyReference=s.policyReference;entitlement.issuerConfigurationReference=s.configurationReference;entitlement.ledgerBackendReference=s.backendReference;}
 for(const k of s.registry.keys){if(!k.id.includes('wrong-scope'))k.allowedScopes=[scope];k.entitlementReferences=k.id.includes('wrong-entitlement')?[ref(s.registry.entitlements[1].id,s.registry.entitlements[1])]:[ref(s.registry.entitlements[0].id,s.registry.entitlements[0])];}
 s.registryReference=ref(s.registry.id,s.registry);s.principal.scope=scope;
 const common={issuerRegistryReference:s.registryReference,issuerKeyReference:{registryReference:s.registryReference,keyId:'isolated-key',revision:1,publicKeyContentHash:s.registry.keys[0].publicKeyContentHash},issuerEntitlementReference:ref(s.registry.entitlements[0].id,s.registry.entitlements[0]),scope,partition:s.partition,ledgerBackendReference:s.backendReference,issuerConfigurationReference:s.configurationReference};
 const l={...s.lineage.unsigned,...common,revision:recordRevision};if(sourceProof){l.sourceIdentity=sourceProof.sourceIdentity;l.rootEvent=sourceProof.rootEvent;l.currentHead=sourceProof.currentHead;}s.lineage=envelope(l);s.lineages=[s.lineage];s.lineageReference={id:l.id,revision:l.revision,contentHash:hash(l)};
 const b={...s.binding.unsigned,...common,revision:recordRevision,sourceLineageReferences:[s.lineageReference]};s.binding=envelope(b);s.bindingReference={id:b.id,revision:b.revision,contentHash:hash(b)};
 const a=s.action.unsigned;a.audience.financeBackendReference=s.backendReference;a.audience.issuerRegistryReference=s.registryReference;a.target.hostConfigurationReference=s.configurationReference;a.issuerKeyReference=common.issuerKeyReference;a.entitlementReference=common.issuerEntitlementReference;a.scope=scope;a.financeBindingReference=s.bindingReference;
 const m=a.change.mapping;m.scope=scope;m.ledgerPartition=s.partition;m.issuerConfigurationReference=s.configurationReference;m.financeBindingReference=s.bindingReference;
 a.changeContentHash=hash(a.change);s.action=envelope(a);s.sourceAudience=m.sourceAudience;s.operationRecords=m.operationRecords;
 s.heads={['binding:'+b.id]:{recordReference:s.bindingReference,signedRecordContentHash:hash(s.binding),state:'active',custodyEpoch:1},['lineage:'+l.id]:{recordReference:s.lineageReference,signedRecordContentHash:hash(s.lineage),state:'active',custodyEpoch:1},['action:'+a.id]:{recordReference:{id:a.id,revision:a.revision,contentHash:hash(a)},signedRecordContentHash:hash(s.action),state:'active',custodyEpoch:1}};
 s.artifacts=[{reference:s.policyReference,encoding:'utf8',body:s.policyArtifactUtf8},{reference:s.backendReference,encoding:'canonical_json',body:{owner:'fixture',name:backendName}},{reference:s.configurationReference,encoding:'canonical_json',body:{verifierId:'isolated-verifier',backend:s.backendReference}},...['session','account','event','issuer','policy'].map(kind=>({reference:b.sourceCustodyReferences[kind],encoding:'canonical_json',body:{kind,epoch:1}}))];
 return s;
}
export function syntheticAnchorDatabase(records){let reads=0;return {get reads(){return reads;},async connect(){return {release(){},async query(sql){reads++;if(sql.includes('database_name'))return {rows:[{database_name:'isolated-test-pg',rolsuper:false,rolbypassrls:false}]};if(sql.includes('foundation_health'))return {rows:[{migrations_ready:true,required_migrations_present:11}]};if(sql.includes('pg_class'))return {rows:['financial_ledger_events','financial_source_revision_heads'].map(relname=>({relname,relrowsecurity:true,relforcerowsecurity:true}))};if(sql.includes('JOIN cost_intelligence.financial_ledger_events')){const l=records.lineage.unsigned;return {rows:[{current_revision_sequence:String(l.currentHead.revisionSequence),current_event_id:l.currentHead.eventId,event_hash:l.currentHead.eventHash,economic_root_event_id:l.rootEvent.eventId,origin_event_hash:l.rootEvent.eventHash}]};}return {rows:[]};}};}};}
export function ownerFixture(records,{database=syntheticAnchorDatabase(records),databaseName='isolated-test-pg'}={}){
 const dir=mkdtempSync(join(tmpdir(),'ci-finance-binding-owned-')),path=join(dir,'owner.sqlite'),db=new DatabaseSync(path);
 db.exec(`PRAGMA journal_mode=WAL;CREATE TABLE finance_binding_custody_state(singleton INTEGER PRIMARY KEY,epoch INTEGER NOT NULL,format TEXT NOT NULL);INSERT INTO finance_binding_custody_state VALUES(1,1,'ci-finance-closed-fixture-custody-1.0.0');CREATE TABLE finance_binding_custody_snapshots(binding_id TEXT PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE finance_binding_source_intents(operation_id TEXT PRIMARY KEY,state TEXT NOT NULL);CREATE TABLE owner_mappings(id TEXT PRIMARY KEY,revision INTEGER,body TEXT,frame_hash TEXT);CREATE TABLE owner_receipts(action_id TEXT PRIMARY KEY,frame_hash TEXT,source_epoch INTEGER);CREATE TABLE owner_mapping_epochs(id TEXT PRIMARY KEY,epoch INTEGER NOT NULL);CREATE TRIGGER snapshot_update AFTER UPDATE ON finance_binding_custody_snapshots BEGIN UPDATE finance_binding_custody_state SET epoch=epoch+1 WHERE singleton=1;END;CREATE TRIGGER snapshot_delete AFTER DELETE ON finance_binding_custody_snapshots BEGIN UPDATE finance_binding_custody_state SET epoch=epoch+1 WHERE singleton=1;END;CREATE TRIGGER snapshot_insert AFTER INSERT ON finance_binding_custody_snapshots BEGIN UPDATE finance_binding_custody_state SET epoch=epoch+1 WHERE singleton=1;END;CREATE TRIGGER intent_insert AFTER INSERT ON finance_binding_source_intents BEGIN UPDATE finance_binding_custody_state SET epoch=epoch+1 WHERE singleton=1;END;CREATE TRIGGER intent_update AFTER UPDATE ON finance_binding_source_intents BEGIN UPDATE finance_binding_custody_state SET epoch=epoch+1 WHERE singleton=1;END;`);
 db.prepare('INSERT INTO finance_binding_custody_snapshots VALUES(?,?)').run(records.binding.unsigned.id,canonical(records));
 db.prepare('INSERT INTO owner_mapping_epochs VALUES(?,1)').run(records.action.unsigned.change.mapping.id);
 const source=reporting.createIsolatedFinanceSqliteCustodySource(db),clock={value:'2026-10-12T02:00:00.000Z'};
 const api=reporting.createFinanceLedgerPartitionBindingVerifier({custodySource:source,selectedBackend:{reference:records.backendReference,databaseName,database},clock:{now:()=>{clock.hook?.();return new Date(clock.value);}}});
 const request={sourceTenantId:records.sourceTenantId,sourceProjectRef:records.sourceProjectRef,scope:records.scope,bindingReference:records.bindingReference,policyReference:records.policyReference};
 const frame={format:'ci-finance-binding-mutation-frame-1.0.0',signedMaintainerActionCanonicalBytes:canonical(records.action)};
 function persist(changed=records){db.prepare('UPDATE finance_binding_custody_snapshots SET body=? WHERE binding_id=?').run(canonical(changed),records.binding.unsigned.id);}
 function commitPrepared(guard,handle,{beforeCommit}={}){
  // Prepare every statement, canonical payload, hash and actual epoch BEFORE the final check.
  const action=records.action.unsigned,m=action.change.mapping,body=canonical(m),frameHash=hash(frame),epoch=db.prepare('SELECT epoch FROM finance_binding_custody_state WHERE singleton=1').get().epoch;
  const mappingStatement=db.prepare('INSERT INTO owner_mappings VALUES(?,?,?,?)'),receiptStatement=db.prepare('INSERT INTO owner_receipts VALUES(?,?,?)'),epochStatement=db.prepare('UPDATE owner_mapping_epochs SET epoch=epoch+1 WHERE id=?');
  const actualMappingEpoch=db.prepare('SELECT epoch FROM owner_mapping_epochs WHERE id=?').get(m.id).epoch;const prior=db.prepare('SELECT revision,body FROM owner_mappings WHERE id=?').get(m.id);if(prior||actualMappingEpoch!==action.expectedPrior.custodyEpoch){api.guardLifecycle.rollbackGuard(guard);return {status:'denied',reason:'fixture_prior_mismatch'};}
  const decision=api.bindingCurrentness.validateCurrent(handle,frame);if(decision.status!=='current'){api.guardLifecycle.rollbackGuard(guard);return decision;}
  mappingStatement.run(m.id,m.revision,body,frameHash);receiptStatement.run(action.id,frameHash,epoch);epochStatement.run(m.id);
  // Test-only barrier signals another worker, never a supplied production mutation hook.
  beforeCommit?.();return api.guardLifecycle.commitGuard(guard);
 }
 return {dir,path,db,records,database,api,request,frame,clock,persist,commitPrepared,cleanup(){api.guardLifecycle.destroy();try{db.close();}catch{}rmSync(dir,{recursive:true,force:true});}};
}
