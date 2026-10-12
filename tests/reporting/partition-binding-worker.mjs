import { DatabaseSync } from 'node:sqlite';
import { parentPort,workerData } from 'node:worker_threads';
const signal=new Int32Array(workerData.signal),db=new DatabaseSync(workerData.path);
try {
 db.exec('PRAGMA busy_timeout=5000');Atomics.store(signal,0,1);Atomics.notify(signal,0);
 db.exec('BEGIN IMMEDIATE');const receipts=db.prepare('SELECT count(*) AS n FROM owner_receipts').get().n;
 const before=db.prepare('SELECT epoch FROM finance_binding_custody_state WHERE singleton=1').get().epoch;
 if(workerData.mode==='intent')db.prepare("INSERT INTO finance_binding_source_intents VALUES(?,'changing')").run(workerData.operationId);
 else if(workerData.mode==='delete_recreate'){const row=db.prepare('SELECT binding_id,body FROM finance_binding_custody_snapshots').get();db.prepare('DELETE FROM finance_binding_custody_snapshots WHERE binding_id=?').run(row.binding_id);db.prepare('INSERT INTO finance_binding_custody_snapshots VALUES(?,?)').run(row.binding_id,row.body);}
 else {const row=db.prepare('SELECT body FROM finance_binding_custody_snapshots').get();const body=JSON.parse(row.body);const key='binding:'+body.binding.unsigned.id;body.heads[key].state='revoked';const canonical=v=>JSON.stringify(sort(v));function sort(v){return Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;}db.prepare('UPDATE finance_binding_custody_snapshots SET body=?').run(canonical(body));if(workerData.mode==='aba'){body.heads[key].state='active';db.prepare('UPDATE finance_binding_custody_snapshots SET body=?').run(canonical(body));}}
 db.exec('COMMIT');const after=db.prepare('SELECT epoch FROM finance_binding_custody_state WHERE singleton=1').get().epoch;
 parentPort.postMessage({receiptsSeenAfterGuardAcquired:receipts,epochBefore:before,epochAfter:after,mode:workerData.mode});
} catch(error){parentPort.postMessage({error:String(error)});}finally{db.close();}
