import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {serveArtifactIndex} from '../src/service.mjs';
import {readPage} from '../src/read.mjs';

async function gateway(t,{supportsLocal=true}={}){
  const state={descriptor:null,deletes:[],replacement:false};
  const server=createServer(async(req,res)=>{
    const send=(status,value,headers={})=>{res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(value));};
    if(req.url==='/health')return send(200,supportsLocal?{service_sharing:'dreammate.service-sharing.v1'}:{});
    if(req.url==='/services'&&req.method==='POST'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);state.descriptor=JSON.parse(Buffer.concat(chunks));return send(200,{});
    }
    if(req.url==='/services/artifact-index'&&req.method==='GET')return send(200,state.replacement?{...state.descriptor,metadata:{}}:state.descriptor,{etag:'"fixture"'});
    if(req.method==='DELETE'){state.deletes.push(req.headers['if-match']);return send(200,{});}
    send(404,{});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return {state,url:`http://127.0.0.1:${server.address().port}`};
}
function fakeIndex(){
  const calls=[];
  return {calls,async search(query,options){calls.push({method:'search',query,options});return {results:[],semantic_status:'no_vectors'};},async read(id){calls.push({method:'read',id});return id==='missing'?null:{unit_id:id,resource:{sharing:id==='public'?'network':'local'},locator:{page:2}};},async list(options){calls.push({method:'list',options});return {resources:[],total:options.sharing?0:5};},async stats(){calls.push({method:'stats'});return {resources:5};}};
}
async function post(service,body){const response=await fetch(`http://127.0.0.1:${service.descriptor().port}/invoke`,{method:'POST',body:JSON.stringify(body)});return {status:response.status,body:await response.json()};}

test('read-only service registers its real methods and withdraws only its owned ETag',async t=>{
  const g=await gateway(t),index=fakeIndex(),service=await serveArtifactIndex({index,port:0,agent:g.url,log(){}});
  t.after(()=>service.stop());
  assert.equal(g.state.descriptor.sharing,'local');
  assert.equal(g.state.descriptor.metadata.artifact_index_provider.read_only,true);
  assert.ok(g.state.descriptor.methods['artifacts.search']);
  assert.equal(service.health().registration.local_confirmed,true);
  assert.equal(index.calls.length,0,'registration must not search or load a model');
  const search=await post(service,{method:'artifacts.search',capability:'artifacts.search',params:{query:'眼镜',limit:3}});
  assert.equal(search.status,200);assert.equal(index.calls.at(-1).options.limit,3);
  assert.equal((await post(service,{method:'artifacts.index',params:{file:'/private/file'}})).status,404);
  assert.equal((await post(service,{method:'artifacts.read',params:{unit_id:'missing'}})).status,404);
  assert.equal((await post(service,{method:'artifacts.search',params:{query:'x',limit:200}})).status,400);
  assert.equal((await post(service,{method:'artifacts.search',capability:'artifacts.read',params:{query:'x'}})).status,400);
  await service.stop();assert.deepEqual(g.state.deletes,['"fixture"']);
});

test('network publication filters local records before search/list and rejects private reads',async t=>{
  const index=fakeIndex(),service=await serveArtifactIndex({index,port:0,register:false,sharing:'network'});
  t.after(()=>service.stop());
  assert.equal((await post(service,{method:'artifacts.search',params:{query:'budget'}})).status,200);
  assert.equal(index.calls.at(-1).options.sharing,'network');
  await post(service,{method:'artifacts.list'});assert.equal(index.calls.at(-1).options.sharing,'network');
  const status=await post(service,{method:'artifacts.status'});assert.equal(status.body.catalog.total,0);assert.equal(index.calls.at(-1).method,'list');
  assert.equal((await post(service,{method:'artifacts.read',params:{unit_id:'private'}})).status,404);
  assert.equal((await post(service,{method:'artifacts.read',params:{unit_id:'public'}})).status,200);
});

test('an old Node cannot advertise local scope, and a replacement registration is preserved',async t=>{
  const old=await gateway(t,{supportsLocal:false}),index=fakeIndex();
  const unavailable=await serveArtifactIndex({index,port:0,agent:old.url,log(){}});t.after(()=>unavailable.stop());
  assert.equal(old.state.descriptor,null);
  assert.equal((await post(unavailable,{method:'artifacts.search',params:{query:'x'}})).status,503);
  const current=await gateway(t),service=await serveArtifactIndex({index,port:0,agent:current.url,log(){}});t.after(()=>service.stop());
  current.state.replacement=true;await service.stop();assert.deepEqual(current.state.deletes,[]);
});

test('large structured reads page without losing formulas or repeating full text',()=>{
  const unit={unit_id:'u',locator:{sheet:'Ledger',range:'A1:Z100'},text:'正文'.repeat(15000),metadata:{cells:Array.from({length:500},(_,i)=>({address:`D${i+1}`,formula:`=B${i+1}*C${i+1}`,value:i}))},representations:[{text:'duplicate'.repeat(5000)}]};
  const chunks=[];let offset=0;
  do{
    const result=readPage(unit,{section:'metadata',offset,maxChars:12000});
    assert.ok(JSON.stringify(result).length<=12000);
    assert.equal(result.representations,undefined);
    chunks.push(result.text);offset=result.next_offset;
  }while(offset!==null);
  assert.deepEqual(JSON.parse(chunks.join('')),unit.metadata);
  const page=readPage(unit,{maxChars:1000});assert.ok(page.next_offset>0);assert.equal(page.text,unit.text.slice(0,page.next_offset));
});

test('HTTP search forwards modality filters and cancels inference after disconnect',async t=>{
  let started,aborted;
  const pending=new Promise(resolve=>{started=resolve;}),cancelled=new Promise(resolve=>{aborted=resolve;});
  const index={...fakeIndex(),async search(query,options){assert.deepEqual(options.modalities,['video']);started();await new Promise(resolve=>options.signal.addEventListener('abort',()=>{aborted();resolve();},{once:true}));return {results:[]};}};
  const service=await serveArtifactIndex({index,port:0,register:false});t.after(()=>service.stop());
  const controller=new AbortController();
  const response=fetch(`http://127.0.0.1:${service.descriptor().port}/invoke`,{method:'POST',body:JSON.stringify({method:'artifacts.search',params:{query:'木马',modalities:['video']}}),signal:controller.signal}).catch(()=>{});
  await pending;controller.abort();await cancelled;await response;
  assert.equal((await post(service,{method:'artifacts.search',params:{query:'x',offset:10001}})).status,400);
});
