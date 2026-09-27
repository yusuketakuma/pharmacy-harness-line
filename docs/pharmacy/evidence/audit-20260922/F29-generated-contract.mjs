import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.cwd(), evidence=join(root,'docs/pharmacy/evidence/audit-20260922');
const req=createRequire(join(root,'packages/plugin-template/package.json'));
const {Client}=await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/index.js')));
const {StdioClientTransport}=await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
const temp=await mkdtemp(join(evidence,'.F29-contract-'));
try {
 await symlink(join(root,'packages/plugin-template/node_modules'),join(temp,'node_modules'),'dir');
 await writeFile(join(temp,'old.mjs'),execFileSync('git',['show','797a7cbc56e857a63b104a68cb2bf343bdb8f93d:packages/plugin-template/dist-mcp/index.js']));
 await writeFile(join(temp,'deny.mjs'),"globalThis.fetch=async()=>{throw new Error('unexpected external call')}");
 const lists=[], validation=[];
 for(const file of [join(temp,'old.mjs'),join(root,'packages/plugin-template/dist-mcp/index.js')]) {
  const client=new Client({name:'synthetic-contract',version:'1.0.0'});
  try {
   await client.connect(new StdioClientTransport({command:process.execPath,args:['--import',join(temp,'deny.mjs'),file],env:{PATH:process.env.PATH,LANG:'C.UTF-8'},stderr:'pipe'}));
   lists.push(await client.listTools());
   const results=[];
   for(const [name,args,accepted] of [
    ['lookup_customer',{},false],
    ['lookup_customer',{customerId:123},false],
    ['lookup_customer',{customerId:'synthetic',extra:'synthetic'},true],
    ['send_myservice_notification',{friendId:'synthetic',notificationType:'invalid'},false],
    ['send_myservice_notification',{notificationType:'custom'},false],
    ['send_myservice_notification',{friendId:'synthetic',notificationType:'custom',message:'synthetic',extra:'synthetic'},true],
   ]) {
    let result;
    try {result=await client.callTool({name,arguments:args})} catch(error) {result={error:String(error)}}
    const reachedHandler=JSON.stringify(result).includes('Missing required env var: LINE_HARNESS_API_URL');
    assert.equal(reachedHandler,accepted);
    results.push({name,args,accepted,reachedHandler,result});
   }
   validation.push(results);
  } finally {await client.close()}
 }
 await writeFile(join(evidence,'F29-generated-tools-contract.json'),JSON.stringify({old:lists[0],current:lists[1],validation},null,2)+'\n');
 assert.deepEqual(validation[1].map(({name,args,accepted,reachedHandler})=>({name,args,accepted,reachedHandler})),validation[0].map(({name,args,accepted,reachedHandler})=>({name,args,accepted,reachedHandler})));
 console.log('PASS six old/current compiled input validation outcomes; exact schema comparison follows');
 assert.deepEqual(lists[1],lists[0]);
 console.log('PASS tracked old/current compiled MCP tools/list exact structural equality, external fetch denied');
} finally {await rm(temp,{recursive:true,force:true})}
