import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const resources = process.env.DSH_DESKTOP_RESOURCES ?? '/Applications/DeepSeek Harness.app/Contents/Resources';
const executable = join(dirname(resources), 'MacOS', 'DeepSeek Harness');
const connectionModule = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-connection', 'lib', 'index.js');
const cordisModule = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js');
const hostModule = process.env.DSH_TEST_HOST_MODULE
  ? resolve(process.env.DSH_TEST_HOST_MODULE)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../dist/onboarding/host.js');

/** Optional installed-host integration: never starts the App or reads its profile. */
describe.skipIf(process.platform !== 'darwin' || !existsSync(executable) || !existsSync(hostModule))('official App RPC registration', () => {
  it('reproduces the modern custom-channel defect even with a consumer webServer injection', () => {
    const program = `
      const {pathToFileURL} = await import('node:url');
      const {Context} = await import(pathToFileURL(${JSON.stringify(cordisModule)}).href);
      const {HostConnectionService} = await import(pathToFileURL(${JSON.stringify(connectionModule)}).href);
      const {registerConnectionRpc} = await import(pathToFileURL(${JSON.stringify(hostModule)}).href);
      const outputs=[];
      for(const webServerInjected of [false,true]) {
        const ctx=new Context();
        const routes=[];
        const serverProvider=ctx.plugin({apply(owner){owner.provide('webServer',{register(route){routes.push(route.path);return()=>{};}});}});
        await serverProvider.await();
        const provider=ctx.plugin({apply(owner){new HostConnectionService(owner,[],{});}});
        await provider.await();
        let failure,arity;
        const consumer=ctx.plugin({inject:webServerInjected?['connection','webServer']:['connection'],apply(owner){
          const rpc=owner.get('connection').rpc; arity=rpc.handle.length;
          try {registerConnectionRpc(rpc,{snapshot(){return {phase:'idle'};}});}
          catch(error){failure=String(error.message);}
        }});
        await consumer.await();
        outputs.push({webServerInjected,arity,routes,failure});
        await consumer.dispose();await provider.dispose();await serverProvider.dispose();
      }
      process.stdout.write(JSON.stringify(outputs));
    `;
    const output = execFileSync(executable, ['--expose-internals', '--input-type=module', '-e', program], {
      env: {HOME: process.env.HOME, PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1'},
      encoding: 'utf8', timeout: 20000,
    });
    const results = JSON.parse(output) as Array<{webServerInjected: boolean; arity: number; routes: string[]; failure?: string}>;
    expect(results[0]).toMatchObject({webServerInjected: false, arity: 2, routes: [], failure: expect.stringContaining('webServer')});
    expect(results[1]).toMatchObject({webServerInjected: true, arity: 2, routes: [], failure: expect.stringContaining('webServer')});
  });

  it('serves exact settings routes only to authenticated owners through the modern host', () => {
    const program = `
      const {pathToFileURL}=await import('node:url');
      const {Context}=await import(pathToFileURL(${JSON.stringify(cordisModule)}).href);
      const {HostConnectionService}=await import(pathToFileURL(${JSON.stringify(connectionModule)}).href);
      const {registerConnectionRpc}=await import(pathToFileURL(${JSON.stringify(hostModule)}).href);
      const ctx=new Context();
      const server=ctx.plugin({apply(owner){owner.provide('webServer',{host:'127.0.0.1',protocol:'http:',register(){throw Error('custom route must not be used');}});}});
      await server.await();
      let service,authenticated=true;
      const provider=ctx.plugin({apply(owner){service=new HostConnectionService(owner,[],{isAuthenticated(){return authenticated;},authenticateApi(){return undefined;}});}});
      await provider.await();
      const calls=[];
      const controller={snapshot(){calls.push('status');return {phase:'idle'};},async command(endpoint){calls.push(endpoint);return {phase:'idle'};}};
      let remove,connection;
      const consumer=ctx.plugin({inject:['connection'],async apply(owner){connection=owner.get('connection');remove=await registerConnectionRpc(connection.rpc,controller,connection.fetch);}});
      await consumer.await();
      const router=service.createSharedFetchHandler('/api');
      function request(endpoint='status',options={}){
        return new Request('http://127.0.0.1/api/larkbot/'+endpoint+(options.query??''),{
          method:'POST',headers:{host:'127.0.0.1',origin:options.origin??'http://127.0.0.1','content-type':options.contentType??'application/json'},
          body:options.body??JSON.stringify({type:'client-request',rpcId:'test-id',method:'larkbot/'+(options.method??endpoint),payload:options.payload??{}})
        });
      }
      const owner=service.browserPeer;
      const nonOwner={principal:{kind:'untrusted'}};
      const before=calls.length;
      const forbidden=await router.fetch(request(),nonOwner);
      const nonOwnerCalls=calls.length-before;
      const untrustedOrigin=service.admit(request('status',{origin:'https://untrusted.example'}));
      authenticated=false;const unauthenticated=service.admit(request());authenticated=true;
      const accepted=service.admit(request());
      const success=await router.fetch(request('status',{query:'?endpoint=disconnect'}),accepted.peer);
      const body=await success.json();
      const methodMismatch=await router.fetch(request('status',{method:'disconnect'}),owner);
      const mediaType=await router.fetch(request('status',{contentType:'text/plain'}),owner);
      const oversize=await router.fetch(request('status',{body:'x'.repeat(8193)}),owner);
      const invalidPayload=await router.fetch(request('create',{payload:{cards:'yes'}}),owner);
      const invalidResult=await invalidPayload.json();
      const missing=await router.fetch(request('not-supported'),owner);
      await remove();
      const afterDispose=await router.fetch(request(),owner);
      let registered=0,partialFailed=false;
      try {await registerConnectionRpc(connection.rpc,controller,{register(route){if(++registered===2)throw Error('registration conflict');return connection.fetch.register(route);}});}
      catch {partialFailed=true;}
      const afterPartialFailure=await router.fetch(request(),owner);
      process.stdout.write(JSON.stringify({forbidden:forbidden.status,nonOwnerCalls,untrustedOrigin:untrustedOrigin.rejection,unauthenticated:unauthenticated.rejection,success:success.status,body,methodMismatch:methodMismatch.status,mediaType:mediaType.status,oversize:oversize.status,invalidPayloadOk:invalidResult.result.ok,missing:missing.status,afterDispose:afterDispose.status,partialFailed,afterPartialFailure:afterPartialFailure.status,calls}));
      await consumer.dispose();await provider.dispose();await server.dispose();
    `;
    const output = execFileSync(executable, ['--expose-internals', '--input-type=module', '-e', program], {
      env: {HOME: process.env.HOME, PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1'}, encoding: 'utf8', timeout: 20000,
    });
    expect(JSON.parse(output)).toEqual({
      forbidden: 403, nonOwnerCalls: 0, untrustedOrigin: 403, unauthenticated: 401, success: 200,
      body: {type: 'server-response', rpcId: 'test-id', result: {ok: true, value: {phase: 'idle'}}},
      methodMismatch: 400, mediaType: 415, oversize: 413, invalidPayloadOk: false,
      missing: 404, afterDispose: 404, partialFailed: true, afterPartialFailure: 404, calls: ['status'],
    });
  });
});
