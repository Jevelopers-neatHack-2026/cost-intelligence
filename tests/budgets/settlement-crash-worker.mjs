// Disposable hosted-PG OS process. Only synthetic financial records/public owner keys arrive in this fixture.
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {runtimeDatabaseConfigFromEnvironment} from '../../scripts/test-db-lifecycle.mjs';
import {makePorts} from './reservation-harness.mjs';
import {settle} from '../../dist/budgets/index.js';
const fixture=JSON.parse(await readFile(process.argv[2],'utf8')),mode=process.argv[3];
if(!['before_commit','after_commit'].includes(mode))throw new Error('unsupported crash checkpoint');
const pool=new pg.Pool({...runtimeDatabaseConfigFromEnvironment(),max:1}),records=new Map(fixture.records);
const clock={now:()=>new Date(fixture.now)},low=makePorts(pool,fixture.scope,{clock});
const sourceCollector={loadCurrent:async reference=>structuredClone(records.get(reference.id)??null),loadCurrentIssuerKey:async id=>id==='synthetic-finance-collector'?structuredClone(fixture.publicKey):null};
const stop=async stage=>{process.send?.({kind:'checkpoint',stage});await new Promise(()=>{});};
const database={connect:async()=>{const client=await low.database.connect();return {release:()=>client.release(),query:async(text,values)=>{
 if(text.trim().toUpperCase()==='COMMIT'){
  if(mode==='before_commit')await stop('before_commit');
  const result=await client.query(text,values);
  if(mode==='after_commit')await stop('after_commit');
  return result;
 }
 return client.query(text,values);
}};}};
const ports={...low,budgets:{database,budgetEvidence:low.budgetEvidence,reservationAuthority:low.reservationAuthority,sourceCollector,reportedCostContractMode:'finance_collector_v1'}};
try{const result=await settle(fixture.command,ports);process.send?.({kind:'finished',ok:result.ok});}
catch{process.send?.({kind:'finished',ok:false});}
finally{await pool.end();process.disconnect?.();}
