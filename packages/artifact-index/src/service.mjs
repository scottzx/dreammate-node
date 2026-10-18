import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readPage} from './read.mjs';

const protocol='dreammate.artifacts.v1';
const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
export const ARTIFACT_METHODS={
  'artifacts.search':{description:'Search indexed local PDF pages, presentation slides, spreadsheet cell ranges and video time segments; return summaries and original locations.',parameters:object({query:{type:'string',minLength:1,maxLength:2000},types:{type:'array',minItems:1,items:{type:'string',enum:['pdf','presentation','spreadsheet','video']}},modalities:{type:'array',minItems:1,items:{type:'string',enum:['text','image','video']}},mode:{type:'string',enum:['hybrid','lexical','semantic']},limit:{type:'integer',minimum:1,maximum:20},offset:{type:'integer',minimum:0,maximum:10000},max_chars:{type:'integer',minimum:1000,maximum:12000}},['query'])},
  'artifacts.read':{description:'Read a bounded page of an indexed unit: text, structured metadata JSON (cells/formulas), or representations JSON. Continue using next_offset.',parameters:object({unit_id:{type:'string',minLength:1,maxLength:256},section:{type:'string',enum:['text','metadata','representations']},offset:{type:'integer',minimum:0,maximum:100000000},max_chars:{type:'integer',minimum:1000,maximum:12000}},['unit_id'])},
  'artifacts.list':{description:'List artifact resources and indexing status without loading an embedding model.',parameters:object({limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0,maximum:1000000}})},
  'artifacts.status':{description:'Read artifact-index statistics without loading an embedding model.',parameters:object({})},
};
const problem=(message,status=400)=>Object.assign(new Error(message),{status});
function agentOrigin(value){
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Service registration requires a loopback Node gateway');
  return url.origin;
}
function boundedInteger(value,fallback,min,max,label){
  const n=value??fallback;
  if(!Number.isSafeInteger(n)||n<min||n>max)throw problem(`${label} must be ${min}..${max}`);
  return n;
}

/** A separately registered, read-only service. Source changes remain CLI operations. */
export async function serveArtifactIndex({index,agent='http://127.0.0.1:36908',port=36910,sharing='local',register=true,serviceId='artifact-index',log=message=>process.stderr.write(`${message}\n`),registrationIntervalMs=15000}={}){
  if(!index||typeof index.search!=='function')throw new Error('An ArtifactIndex instance is required');
  if(!['local','network'].includes(sharing)||!Number.isSafeInteger(port)||port<0||port>65535||!/^[a-zA-Z0-9_-]{1,100}$/.test(serviceId))throw new Error('Invalid artifact service options');
  agent=agentOrigin(agent);
  const instanceId=randomUUID(),visibility=sharing==='network'?'network':undefined;
  let stopped=false,registered=false,confirmed=false,lastError,refreshing,timer;
  const active=new Map();
  const apiRequest=async(url,options={})=>{
    const response=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(2500)});
    if(!response.ok){await response.body?.cancel();throw new Error(`Node HTTP ${response.status}`);}
    return {body:response.status===204?null:await response.json(),etag:response.headers.get('etag')};
  };
  const descriptor=()=>({id:serviceId,name:'Local artifact index',kind:'generic',port:server.address()?.port??port,sharing,reachability:'localhost',execution:'http',health:'/health',methods:ARTIFACT_METHODS,resources:[{scheme:'artifact',description:'Versioned artifact units with original page, slide, cell range and time locators'}],metadata:{artifact_index_provider:{protocol,version:'0.1.0',instance_id:instanceId,read_only:true},invoke_timeout_ms:120000}});
  const health=()=>({status:'ok',service:'artifact-index',protocol,pid:process.pid,sharing,read_only:true,registration:{registered,local_confirmed:confirmed,...(lastError?{last_error:lastError}:{})}});
  const send=(res,status,body)=>{
    if(res.destroyed||res.writableEnded)return;
    const data=Buffer.from(JSON.stringify(body));res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':data.length});res.end(data);
  };
  const server=createServer(async(req,res)=>{
    const controller=new AbortController();
    let finished;
    const completion=new Promise(resolve=>{finished=resolve;});
    active.set(controller,completion);
    const disconnected=()=>{if(!res.writableEnded)controller.abort(new Error('Client disconnected'));};
    res.once('close',disconnected);
    try{
      if(req.method==='GET'&&req.url==='/health')return send(res,200,health());
      if(req.method!=='POST'||req.url!=='/invoke')return send(res,404,{error:'Not found'});
      if(register&&sharing==='local'&&!confirmed)throw problem('Local sharing is not confirmed by the Node',503);
      const chunks=[];let bytes=0;
      const bodyTimer=setTimeout(()=>req.destroy(),10000);
      let input;
      try{
        for await(const chunk of req){bytes+=chunk.length;if(bytes>262144)throw problem('Request body exceeds 262144 bytes',413);chunks.push(chunk);}
        try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw problem('Expected a JSON request');}
      }finally{clearTimeout(bodyTimer);}
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['method','capability','params'].includes(key))||(input.method&&input.capability&&input.method!==input.capability))throw problem('Expected consistent method/capability and params');
      const method=input.method??input.capability,params=input.params??{};
      const contract=ARTIFACT_METHODS[method];
      if(!contract)throw problem('Unknown artifact method',404);
      if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).some(key=>!Object.hasOwn(contract.parameters.properties,key)))throw problem('Invalid method parameters');
      if(method==='artifacts.status'){
        // Public counts must not disclose locally scoped resources.
        return send(res,200,visibility?{...health(),catalog:await index.list({limit:1,offset:0,sharing:visibility})}:await index.stats());
      }
      if(method==='artifacts.list')return send(res,200,await index.list({limit:boundedInteger(params.limit,20,1,100,'limit'),offset:boundedInteger(params.offset,0,0,1000000,'offset'),sharing:visibility}));
      if(method==='artifacts.read'){
        if(typeof params.unit_id!=='string'||!params.unit_id||params.unit_id.length>256)throw problem('unit_id is required');
        const unit=await index.read(params.unit_id);
        if(!unit||(visibility&&(unit.resource?.sharing??unit.sharing)!=='network'))throw problem('Artifact unit not found',404);
        if(params.section!==undefined&&!['text','metadata','representations'].includes(params.section))throw problem('Invalid read section');
        return send(res,200,readPage(unit,{section:params.section,offset:boundedInteger(params.offset,0,0,100000000,'offset'),maxChars:boundedInteger(params.max_chars,12000,1000,12000,'max_chars')}));
      }
      if(typeof params.query!=='string'||!params.query.trim()||params.query.length>2000)throw problem('query must have 1..2000 characters');
      if(params.mode!==undefined&&!['hybrid','lexical','semantic'].includes(params.mode))throw problem('Invalid search mode');
      if(params.types!==undefined&&(!Array.isArray(params.types)||!params.types.length||params.types.some(type=>!['pdf','presentation','spreadsheet','video'].includes(type))))throw problem('Invalid artifact types');
      if(params.modalities!==undefined&&(!Array.isArray(params.modalities)||!params.modalities.length||params.modalities.some(type=>!['text','image','video'].includes(type))))throw problem('Invalid modalities');
      return send(res,200,await index.search(params.query,{mode:params.mode??'hybrid',types:params.types,modalities:params.modalities,limit:boundedInteger(params.limit,15,1,20,'limit'),offset:boundedInteger(params.offset,0,0,10000,'offset'),maxChars:boundedInteger(params.max_chars,12000,1000,12000,'max_chars'),sharing:visibility,signal:controller.signal}));
    }catch(error){send(res,error.status??500,{error:error.status?error.message:'Artifact request failed'});}
    finally{res.off('close',disconnected);active.delete(controller);finished();}
  });
  server.headersTimeout=10000;server.requestTimeout=10000;
  const refresh=()=>refreshing??=(async()=>{
    try{
      if(stopped||!register)return;
      if(sharing==='local'){
        const probe=await apiRequest(`${agent}/health`);
        if(probe.body?.service_sharing!=='dreammate.service-sharing.v1')throw new Error('Node does not support local sharing');
      }
      await apiRequest(`${agent}/services`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(descriptor())});
      registered=true;confirmed=sharing==='local';lastError=undefined;
    }catch(error){confirmed=false;const text=error.message??String(error);if(text!==lastError)log(`Artifact index registration: ${text}`);lastError=text;}
    finally{refreshing=undefined;}
  })();
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});}
  catch(error){server.close();throw error;}
  await refresh();timer=setInterval(()=>{void refresh();},registrationIntervalMs);timer.unref?.();
  let stopping;
  const stop=()=>stopping??=(async()=>{
    stopped=true;clearInterval(timer);await refreshing;
    if(registered){
      try{
        const url=`${agent}/services/${encodeURIComponent(serviceId)}`,result=await apiRequest(url),current=result.body?.service??result.body;
        if(result.etag&&current?.metadata?.artifact_index_provider?.instance_id===instanceId)await apiRequest(url,{method:'DELETE',headers:{'if-match':result.etag}});
      }catch{/* An unavailable/replaced gateway expires the advertisement. */}
    }
    for(const controller of active.keys())controller.abort(new Error('Artifact service stopped'));
    const pending=[...active.values()];
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    await Promise.allSettled(pending);
  })();
  return {server,health,descriptor,refresh,stop};
}
