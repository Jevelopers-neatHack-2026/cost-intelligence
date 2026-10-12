import registerTest from 'node:test';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
const context=new AsyncLocalStorage(),cases=[];
const codes=new Set(['ERR_ASSERTION','42P01','42703','42883','42501','23505','23514','57014','55P03','P0001']);
const files=new Set(['authorization.test.mjs','settlement-integrity.test.mjs','lifecycle.test.mjs','contention.test.mjs']);
export function diagnosticTest(file){if(!files.has(file))throw new Error('unknown diagnostic fixture');return (name,...args)=>{
 const body=args.pop(),registration=[...new Error().stack.matchAll(new RegExp(file.replaceAll('.','\\.')+':(\\d+):(\\d+)','g'))].at(0);
 return registerTest(name,...args,async testContext=>{
  const entry={file:`tests/budgets/${file}`,titleHash:createHash('sha256').update(String(name)).digest('hex'),registrationLine:registration?Number(registration[1]):null,status:'running',sqlStates:[]};cases.push(entry);
  try{await context.run(entry,()=>body(testContext));entry.status='passed';}catch(error){entry.status='failed';entry.code=codes.has(error?.code)?error.code:'bounded_other';
   for(const field of ['actual','expected'])if(typeof error?.[field]==='boolean'||Number.isSafeInteger(error?.[field])&&Math.abs(error[field])<=100000)entry[field]=error[field];
   for(const known of files){const found=String(error?.stack??'').match(new RegExp(known.replaceAll('.','\\.')+':(\\d+):(\\d+)'));if(found){entry.failureLocation={file:`tests/budgets/${known}`,line:Number(found[1]),column:Number(found[2])};break;}}throw error;
  }finally{await mkdir(new URL('../../artifacts/test-manifests/',import.meta.url),{recursive:true});await writeFile(new URL('../../artifacts/test-manifests/ci05b-budget-static-diagnostics.json',import.meta.url),JSON.stringify({version:'1.0.0',cases})+'\n');}
 });
};}
export function diagnosticBudgetClient(client){return {release:()=>client.release(),query:async(...args)=>{
 try{return await client.query(...args);}catch(error){const entry=context.getStore();if(entry&&entry.sqlStates.length<16)entry.sqlStates.push(codes.has(error?.code)?error.code:'bounded_other');throw error;}
}};}
