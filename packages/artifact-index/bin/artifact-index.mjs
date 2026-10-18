#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {homedir,hostname} from 'node:os';
import path from 'node:path';
import {readFile,realpath} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {readPage} from '../src/read.mjs';

const help=`artifact-index — local artifact indexing, independent of the Node gateway package

  artifact-index doctor                         Check local parsers and shared model services
  artifact-index index FILE...                  Index PDF/PPT(X)/XLS(X)/video files
  artifact-index search --query TEXT            Search summaries and original locations
  artifact-index read --id UNIT_ID              Read an indexed unit
  artifact-index list                          List indexed source resources
  artifact-index remove --id RESOURCE_ID        Remove a source and its units/vectors
  artifact-index stats                         Read index statistics
  artifact-index serve                         Register a read-only DreamMate service

  --db ABSOLUTE_PATH                           Default ~/.1agents/artifacts/index.sqlite
  --cache-dir ABSOLUTE_PATH                    Local derived pages/clips; no model files
  --python PYTHON                              Default DREAMMATE_ARTIFACT_PYTHON or python3
  --agent http://127.0.0.1:36908                Existing shared embedding gateway
  --media-root ABSOLUTE_PATH                   Existing Gemma inbox, if not advertised
  --sharing local|network                     Resource/service scope; default local
  --source-node NAME                           Source node identity; default hostname
  --mode hybrid|lexical|semantic               Search mode; default hybrid
  --types pdf,presentation,spreadsheet,video   Optional search filter
  --modalities text|image,video                Optional embedding-space filter
  --section text|metadata|representations      read content; default text
  --limit N --offset N --max-chars N            Bounded search result controls
  --no-semantic                               Parse/index without model inference
  --no-visual                                 Skip page/slide rendering explicitly
  --embedding-timeout-ms N                     Default 60000 per model request
  --port 36910 --no-register                   serve options; loopback HTTP only

The package never downloads, installs or starts embedding models. It reuses the
same Qwen/Gemma services as tool search. Python parsers and office/video utilities
must already exist; doctor reports missing dependencies. No network file URLs.
`;
const integer=(value,fallback,min,max,label)=>{
  const n=value===undefined?fallback:Number(value);
  if(!/^\d+$/.test(String(n))||!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`${label} must be ${min}..${max}`);
  return n;
};
export async function main(argv=process.argv.slice(2)){
  if(argv.length===0||argv.includes('--help')||argv.includes('-h')){process.stdout.write(help);return;}
  if(argv[0]==='--version'){process.stdout.write(`${JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version}\n`);return;}
  const command=argv[0];
  if(!['doctor','index','search','read','list','remove','stats','serve'].includes(command))throw new Error(`Unknown command: ${command}`);
  const {values,positionals}=parseArgs({args:argv.slice(1),allowPositionals:true,strict:true,options:{
    db:{type:'string'},'cache-dir':{type:'string'},python:{type:'string'},agent:{type:'string'},'media-root':{type:'string'},sharing:{type:'string',default:'local'},'source-node':{type:'string'},query:{type:'string'},id:{type:'string'},mode:{type:'string',default:'hybrid'},types:{type:'string'},modalities:{type:'string'},section:{type:'string',default:'text'},limit:{type:'string'},offset:{type:'string'},'max-chars':{type:'string'},'no-semantic':{type:'boolean',default:false},'no-visual':{type:'boolean',default:false},'embedding-timeout-ms':{type:'string'},port:{type:'string'},'no-register':{type:'boolean',default:false},
  }});
  if(!['local','network'].includes(values.sharing))throw new Error('--sharing must be local or network');
  if(!['hybrid','lexical','semantic'].includes(values.mode))throw new Error('Invalid --mode');
  if(command!=='index'&&positionals.length)throw new Error('Only index accepts file arguments');
  const {createEmbeddingClient}=await import('../src/embeddings.mjs');
  const embeddingTimeoutMs=integer(values['embedding-timeout-ms'],60000,1,120000,'embedding timeout');
  const embeddings=createEmbeddingClient({agent:values.agent??'http://127.0.0.1:36908',mediaRoot:values['media-root'],timeoutMs:embeddingTimeoutMs});
  const parserOptions={python:values.python??process.env.DREAMMATE_ARTIFACT_PYTHON??'python3',visual:!values['no-visual']};
  const emit=value=>process.stdout.write(`${JSON.stringify(value,null,2)}\n`);
  if(command==='doctor'){
    const extraction=await import('../src/extract.mjs');
    let models;
    try{models=await embeddings.status();}catch(error){models={available:false,error:error.message};}
    emit({package:'@1agents/artifact-index',version:'0.1.0',parsers:await extraction.doctor(parserOptions),embeddings:models,models_downloaded:false});return;
  }
  const {ArtifactIndex}=await import('../src/index.mjs');
  const {extractArtifact}=await import('../src/extract.mjs');
  const dbPath=path.resolve(values.db??path.join(homedir(),'.1agents/artifacts/index.sqlite'));
  const cacheDir=path.resolve(values['cache-dir']??path.join(homedir(),'.1agents/artifacts/cache'));
  const index=new ArtifactIndex({dbPath,cacheDir,sourceNode:values['source-node']??hostname(),sharing:values.sharing,extractor:(file,options)=>extractArtifact(file,{...options,...parserOptions}),embeddings});
  let service;
  try{
    if(command==='index'){
      if(!positionals.length)throw new Error('index requires one or more local file paths');
      emit(await index.index(positionals.map(file=>path.resolve(file)),{semantic:!values['no-semantic'],visual:!values['no-visual'],sharing:values.sharing,embeddingTimeoutMs}));
    }else if(command==='search'){
      if(!values.query?.trim())throw new Error('--query is required');
      emit(await index.search(values.query,{mode:values.mode,types:values.types?.split(','),modalities:values.modalities?.split(','),limit:integer(values.limit,15,1,20,'limit'),offset:integer(values.offset,0,0,10000,'offset'),maxChars:integer(values['max-chars'],12000,1000,12000,'max chars'),embeddingTimeoutMs}));
    }else if(command==='read'){
      if(!values.id)throw new Error('--id is required');const unit=await index.read(values.id);if(!unit)throw new Error('Unit not found');emit(readPage(unit,{section:values.section,offset:integer(values.offset,0,0,100000000,'offset'),maxChars:integer(values['max-chars'],12000,1000,12000,'max chars')}));
    }else if(command==='remove'){
      if(!values.id)throw new Error('--id is required');emit(await index.remove(values.id));
    }else if(command==='list')emit(await index.list({limit:integer(values.limit,20,1,100,'limit'),offset:integer(values.offset,0,0,1000000,'offset')}));
    else if(command==='stats')emit(await index.stats());
    else{
      const {serveArtifactIndex}=await import('../src/service.mjs');
      service=await serveArtifactIndex({index,agent:values.agent??'http://127.0.0.1:36908',port:integer(values.port,36910,1,65535,'port'),sharing:values.sharing,register:!values['no-register']});
      process.stderr.write(`Artifact index listening on 127.0.0.1:${service.descriptor().port}; ${values.sharing}\n`);
      await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
    }
  }finally{await service?.stop();await index.close();}
}
const entry=process.argv[1]?await realpath(process.argv[1]).catch(()=>null):null;
if(entry&&pathToFileURL(entry).href===import.meta.url){
  main().catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
}
