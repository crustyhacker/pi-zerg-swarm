import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import test, { mock } from 'node:test';
import { createWorkflowScriptParser, type WorkflowScriptParserReply } from '../workflow-script-process.js';
import { WORKFLOW_SCRIPT_LIMITS as L } from '../workflow-script-format.js';
import { compileWorkflowScript } from '../workflow-script.js';

const source = `workflow({id:'demo',label:'Demo',inputSchema:{type:'object',properties:{},additionalProperties:false}},()=>{const a=aggregate('a',{inputs:{},operation:'collect'});});`;
function code(reply: { ok: true } | Extract<WorkflowScriptParserReply, { ok: false }>) { assert.equal(reply.ok,false); return reply.ok ? '' : reply.diagnostics[0].code; }
const originalSpawn = childProcess.spawn;
async function withSpawn(implementation: (...args: any[]) => any, body: () => Promise<void>) {
  const mocked = mock.method(childProcess, 'spawn', implementation as typeof childProcess.spawn);
  syncBuiltinESMExports();
  try { await body(); } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
}
class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); kills = 0;
  kill(signal: string) { assert.equal(signal,'SIGKILL'); this.kills++; return true; }
  close(code: number | null = 0) { this.emit('close',code,null); }
}

test('owned real parser launches no shell/inherited env or execArgv, then reaps before returning', async () => {
  const owner = createWorkflowScriptParser(); let child: ChildProcess | undefined, closed = false;
  const before = { options: process.env.NODE_OPTIONS, path: process.env.NODE_PATH, secret: process.env.S8D_SECRET };
  process.env.NODE_OPTIONS = '--definitely-not-valid'; process.env.NODE_PATH='/not/allowed'; process.env.S8D_SECRET='SECRET_SENTINEL';
  process.execArgv.push('--definitely-not-valid');
  try {
    await withSpawn((file, args, options) => {
      assert.equal(file,process.execPath);
      assert.equal(args.length,2); assert.equal(args[0],`--max-old-space-size=${L.heapMiB}`);
      assert.match(args[1],/workflow-script-compiler\.mjs$/);
      assert.equal(options.shell,false);
      assert.deepEqual(options.env,{LANG:'C',TZ:'UTC'});
      assert.deepEqual(options.stdio,['pipe','pipe','pipe']);
      child = originalSpawn(file,args,options); child.once('close',()=>{closed=true;}); return child;
    }, async () => {
      assert.equal((await owner.parse(source)).ok,true);
      assert.equal(closed,true);
      assert.deepEqual(owner.inspect(),{active:0,queued:0,disposed:false});
      if (process.platform !== 'win32') assert.throws(()=>process.kill(child!.pid!,0),/ESRCH/);
    });
  } finally {
    process.execArgv.pop();
    for (const [key,value] of Object.entries({NODE_OPTIONS:before.options,NODE_PATH:before.path,S8D_SECRET:before.secret})) {
      if (value===undefined) delete process.env[key]; else process.env[key]=value;
    }
    owner.dispose(); await owner.drain();
  }
});

test('one active + four queued, preabort/queued abort, cancellation retains permit until close', async () => {
  const children: FakeChild[] = [], owner = createWorkflowScriptParser();
  await withSpawn(()=>{const c=new FakeChild();children.push(c);return c;},async()=>{
    const pre = new AbortController(); pre.abort(); assert.equal(code(await owner.parse(source,pre.signal)),'cancelled');
    assert.equal(children.length,0);
    const abort = new AbortController(), queuedAbort = new AbortController();
    const active = owner.parse(source,abort.signal);
    const pending = [owner.parse(source,queuedAbort.signal),owner.parse(source),owner.parse(source),owner.parse(source)];
    assert.deepEqual(owner.inspect(),{active:1,queued:4,disposed:false});
    assert.equal(code(await owner.parse(source)),'busy');
    queuedAbort.abort(); assert.equal(code(await pending[0]),'cancelled');
    assert.equal(owner.inspect().queued,3);
    let resolved=false, drained=false;
    void active.then(()=>{resolved=true;});
    abort.abort(); assert.ok(children[0].kills>=1);
    await Promise.resolve(); assert.equal(resolved,false); assert.equal(children.length,1);
    owner.dispose(); owner.dispose();
    void owner.drain().then(()=>{drained=true;});
    assert.equal(code(await pending[1]),'disposed'); assert.equal(code(await pending[2]),'disposed'); assert.equal(code(await pending[3]),'disposed');
    assert.equal(drained,false);
    children[0].close(null);
    assert.equal(code(await active),'cancelled'); await owner.drain();
    assert.equal(resolved,true); assert.equal(drained,true);
    assert.equal(owner.inspect().active,0); assert.equal(children.length,1);
    assert.equal(code(await owner.parse(source)),'disposed');
  });
});

test('aborted child must close before next queued parse can spawn', async () => {
  const children: FakeChild[] = [], owner = createWorkflowScriptParser();
  await withSpawn(()=>{const c=new FakeChild();children.push(c);return c;},async()=>{
    const abort=new AbortController(); const one=owner.parse(source,abort.signal), two=owner.parse(source);
    abort.abort(); assert.equal(children.length,1);
    children[0].close(null); assert.equal(code(await one),'cancelled'); assert.equal(children.length,2);
    children[1].stdout.write(JSON.stringify({ok:false,diagnostics:[{code:'rejected',message:'Compiler rejected source'}]})); children[1].close();
    assert.equal(code(await two),'rejected'); owner.dispose(); await owner.drain();
  });
});

for (const stream of ['stdout','stderr'] as const) test(`${stream} overflow kills owned child, bounded buffers, waits for close`, async()=>{
  const owner=createWorkflowScriptParser(), child=new FakeChild();
  await withSpawn(()=>child,async()=>{
    const result=owner.parse(source); let done=false; void result.then(()=>{done=true;});
    child[stream].write(Buffer.alloc((stream==='stdout'?L.stdoutBytes:L.stderrBytes)+1));
    assert.ok(child.kills>=1); await Promise.resolve(); assert.equal(done,false);
    child.close(null); assert.equal(code(await result),'overflow'); owner.dispose(); await owner.drain();
  });
});

test('malformed/oversized protocol diagnostics fail closed and never leak raw response', async()=>{
  const responses: Array<string|Buffer> = [
    'SECRET_SENTINEL', Buffer.from([0xff]), '{}', '[]', '{"ok":1}',
    JSON.stringify({ok:false,diagnostics:[]}),
    JSON.stringify({ok:false,diagnostics:Array(9).fill({code:'rejected',message:'no'})}),
    JSON.stringify({ok:false,diagnostics:[{code:'x',message:'x'.repeat(257)}]}),
    JSON.stringify({ok:false,diagnostics:[{code:'x',message:'no',span:{start:0,end:99999,line:1,column:0}}]}),
    JSON.stringify({ok:false,diagnostics:[{code:'x',message:'no',source:'SECRET_SENTINEL'}]}),
    JSON.stringify({ok:true,definition:{},steps:[],phases:[],source:'SECRET_SENTINEL'}),
  ];
  for(const response of responses) {
    const owner=createWorkflowScriptParser(), child=new FakeChild();
    await withSpawn(()=>child,async()=>{
      const result=owner.parse(source); child.stdout.write(response); child.close();
      const reply=await result; assert.equal(code(reply),'protocol'); assert.ok(!JSON.stringify(reply).includes('SECRET_SENTINEL'));
      owner.dispose(); await owner.drain();
    });
  }
});

test('spawn throw, emitted error, transport failure and nonzero exits isolate host', async()=>{
  const owner=createWorkflowScriptParser();
  await withSpawn(()=>{throw new Error('SECRET_SENTINEL');},async()=>{assert.equal(code(await owner.parse(source)),'process');});
  owner.dispose(); await owner.drain();
  for(const mode of ['error','stdin','exit']) {
    const parser=createWorkflowScriptParser(), child=new FakeChild();
    await withSpawn(()=>child,async()=>{
      const result=parser.parse(source);
      if(mode==='error') child.emit('error',new Error('SECRET_SENTINEL'));
      if(mode==='stdin') child.stdin.emit('error',new Error('SECRET_SENTINEL'));
      child.close(1); assert.equal(code(await result),'process'); parser.dispose(); await parser.drain();
    });
  }
});

test('real owned timeout includes queue time, SIGKILL and close/reaping before drain', async()=>{
  const owner=createWorkflowScriptParser(); const children: ChildProcess[]=[]; let closes=0;
  await withSpawn((_file,_args,options)=>{
    // Trusted test fixture only. NEVER evaluated submitted DSL or request bytes.
    const child=originalSpawn(process.execPath,['-e','process.stdin.resume();setInterval(()=>{},1000)'],options);
    children.push(child); child.once('close',()=>{closes++;}); return child;
  },async()=>{
    const start=performance.now(); const one=owner.parse(source), two=owner.parse(source);
    assert.equal(code(await one),'timeout'); assert.equal(code(await two),'timeout');
    await owner.drain(); assert.ok(performance.now()-start>=L.deadlineMs-100);
    assert.equal(closes,children.length); assert.ok(children.length<=2);
    for(const child of children) if(process.platform!=='win32') assert.throws(()=>process.kill(child.pid!,0),/ESRCH/);
    assert.deepEqual(owner.inspect(),{active:0,queued:0,disposed:false}); owner.dispose();
  });
});

test('real owned cancellation and crash leave owner reusable only after reaping', async()=>{
  const owner=createWorkflowScriptParser(); let child: ChildProcess | undefined;
  await withSpawn((_file,_args,options)=>{
    child=originalSpawn(process.execPath,['-e','process.stdin.resume();setInterval(()=>{},1000)'],options); return child;
  },async()=>{
    const abort=new AbortController(), result=owner.parse(source,abort.signal);
    await once(child!,'spawn'); abort.abort(); assert.equal(code(await result),'cancelled');
    await owner.drain(); assert.equal(owner.inspect().active,0);
  });
  await withSpawn((_file,_args,options)=>originalSpawn(process.execPath,['-e','process.exit(17)'],options),async()=>{
    assert.equal(code(await owner.parse(source)),'process');
  });
  assert.equal((await owner.parse(source)).ok,true); owner.dispose(); await owner.drain();
});

test('shared compiler per-job abort never kills another control owner and settles after close', async()=>{
  const children: ChildProcess[] = [], closed = new Set<ChildProcess>();
  await withSpawn((file,args,options)=>{
    const child=originalSpawn(file,args,options); children.push(child); child.once('close',()=>closed.add(child)); return child;
  },async()=>{
    const ownerA=new AbortController(), ownerB=new AbortController();
    const first=compileWorkflowScript(source,{signal:ownerA.signal});
    const other=compileWorkflowScript(source,{signal:ownerB.signal});
    const abandoned=compileWorkflowScript(source,{signal:ownerA.signal});
    assert.equal(children.length,1);
    ownerA.abort();
    assert.equal(code(await first),'cancelled');
    assert.equal(closed.has(children[0]),true);
    assert.equal(code(await abandoned),'cancelled');
    assert.equal((await other).ok,true);
    assert.equal(children.length,2); assert.equal(closed.size,2);
    for(const child of children) if(process.platform!=='win32') assert.throws(()=>process.kill(child.pid!,0),/ESRCH/);
  });
});

test('deep malformed parser input cannot take down the host or poison subsequent compilation', async()=>{
  const owner=createWorkflowScriptParser();
  try {
    // Few delimiters but deeply recursive parser expressions: postparse guards alone are insufficient.
    for(const expression of ['!'.repeat(4000)+'true', Array(2000).fill('x=>').join('')+'0', '('.repeat(4000)+'0']) {
      const bad=source.replace("const a=aggregate",`const malformed=${expression};const a=aggregate`);
      assert.equal((await owner.parse(bad)).ok,false);
      assert.deepEqual(owner.inspect(),{active:0,queued:0,disposed:false});
      assert.equal((await owner.parse(source)).ok,true);
    }
  } finally {owner.dispose(); await owner.drain();}
});

test('source admission rejects bytes/lone surrogates without any process', async()=>{
  await withSpawn(()=>{throw new Error('must not spawn');},async()=>{
    const owner=createWorkflowScriptParser();
    for(const bad of ['\ud800','雪'.repeat(22000),' '.repeat(L.sourceBytes+1),null as unknown as string]) assert.equal(code(await owner.parse(bad)),'source');
    assert.deepEqual(owner.inspect(),{active:0,queued:0,disposed:false}); owner.dispose(); await owner.drain();
  });
});
