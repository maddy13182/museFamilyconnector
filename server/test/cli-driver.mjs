// Test-only JSON-lines bridge: real CLI crypto against the real Worker handlers.
import readline from 'node:readline';
import { handleRequest } from '../dist/src/index.js';
import { freshDb, sqliteClient } from '../dist/test/sqlite.js';
const raw = freshDb();
const db = sqliteClient(raw);
const env = {TOKEN_PEPPER:'integration-pepper',READ_RECEIPT_SECRET:'integration-receipts',SETUP_LOCKED:'0'};
console.log = () => {}; // Request metadata is noise; the protocol owns stdout.
for await (const line of readline.createInterface({input:process.stdin})) {
  try {
    const input = JSON.parse(line);
    if(input.lock_setup) {
      env.SETUP_LOCKED='1';
      process.stdout.write(JSON.stringify({status:200,body:'{"ok":true}'})+'\n');
      continue;
    }
    if(input.snapshot) {
      const data = {};
      for(const table of ['topics','entries','tasks','members','agent_tokens','enrollment_receipts','principals','agents']) data[table]=raw.prepare(`SELECT * FROM ${table}`).all();
      process.stdout.write(JSON.stringify({status:200,body:JSON.stringify(data)})+'\n');
      continue;
    }
    const request = new Request('https://hub.test'+input.path,{method:input.method,headers:input.headers,body:input.body??undefined});
    const result = await handleRequest(request,db,env);
    process.stdout.write(JSON.stringify({status:result.status,body:await result.text()})+'\n');
  } catch(error) {
    process.stdout.write(JSON.stringify({status:500,body:JSON.stringify({error:{message:String(error)}})})+'\n');
  }
}
raw.close();
