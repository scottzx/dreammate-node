#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {homedir,hostname} from 'node:os';
import path from 'node:path';
import {readFile,realpath} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {readPage} from '../src/read.mjs';

const help=`artifact-index — local artifact indexing, independent of the Node gateway package

  artifact-index doctor                         Check local parsers and shared model services
  artifact-index index FILE|DIR...              Index files, or walk directories for supported formats
                                            Without FILE|DIR the configured index_roots are used
  artifact-index search --query TEXT            Search summaries and original locations
  artifact-index search --query-image IMAGE     Find pages, slides and clips that look like IMAGE
                                            (--query TEXT may accompany it as a display label)
  artifact-index read --id UNIT_ID              Read an indexed unit
  artifact-index list                          List indexed source resources
  artifact-index remove --id RESOURCE_ID        Remove a source and its units/vectors
  artifact-index stats                         Read index statistics
  artifact-index serve                         Register a read-only DreamMate service

  --db ABSOLUTE_PATH                           Default ~/.1agents/artifacts/index.sqlite
  --config ABSOLUTE_PATH                      Default ~/.1agents/artifacts/config.json
                                           (index_roots/exclude_keywords/exclude_paths are read from it)
  --cache-dir ABSOLUTE_PATH                    Local derived pages/clips; no model files
  --python PYTHON                              Default DREAMMATE_ARTIFACT_PYTHON or python3
  --agent http://127.0.0.1:36908                Existing shared embedding gateway
  --media-root ABSOLUTE_PATH                   Existing Gemma inbox, if not advertised
  --sharing local|network                     Resource/service scope; default local
  --source-node NAME                           Source node identity; default hostname
  --mode hybrid|lexical|semantic               Search mode; default hybrid
  --query-image ABSOLUTE_PATH                  Query with a local image instead of words
  --keep-duplicates                            List every copy of identical file content
  --types pdf,presentation,spreadsheet,video,document,text
                                                Optional search filter
  --modalities text|image,video                Optional embedding-space filter
  --section text|metadata|representations      read content; default text
  --limit N --offset N --max-chars N            Bounded search result controls
  --no-semantic                               Parse/index without model inference
  --no-visual                                 Skip page/slide rendering explicitly
  --embedding-timeout-ms N                     Default 60000 per model request
  --max-depth N                               Directory walk depth; default 12
  --file-limit N                              Maximum files collected per run; default 5000
  --concurrency N                             Parsers run in parallel; default 6
  --chunk-size N                              Files committed per transaction group; default 64
  --exclude PATTERN                            Skip matching paths; repeatable
  --exclude-dir NAME                          Skip whole directories by name; repeatable
  --exclude-path SUBSTRING                    Exclude indexed files whose path contains it; repeatable
  --exclude-keyword KEYWORD                   Skip paths containing keyword while scanning; repeatable
  --include-hidden                            Include hidden files and directories
  --reindex                                   Re-read sources whose size and mtime are unchanged
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
    db:{type:'string'},config:{type:'string'},'cache-dir':{type:'string'},python:{type:'string'},agent:{type:'string'},'media-root':{type:'string'},sharing:{type:'string',default:'local'},'source-node':{type:'string'},query:{type:'string'},'query-image':{type:'string'},id:{type:'string'},mode:{type:'string',default:'hybrid'},types:{type:'string'},modalities:{type:'string'},section:{type:'string',default:'text'},limit:{type:'string'},offset:{type:'string'},'max-chars':{type:'string'},'no-semantic':{type:'boolean',default:false},'no-visual':{type:'boolean',default:false},'embedding-timeout-ms':{type:'string'},'max-depth':{type:'string'},'file-limit':{type:'string'},concurrency:{type:'string'},'chunk-size':{type:'string'},exclude:{type:'string',multiple:true},'exclude-dir':{type:'string',multiple:true},'exclude-path':{type:'string',multiple:true},'exclude-keyword':{type:'string',multiple:true},'include-hidden':{type:'boolean',default:false},reindex:{type:'boolean',default:false},'keep-duplicates':{type:'boolean',default:false},port:{type:'string'},'no-register':{type:'boolean',default:false},
  }});
  const packageVersion=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
  // A persistent exclude list keeps bulk corpora out of every search without
  // repeating the same flags.
  const configFile=values.config??path.join(homedir(),'.1agents','artifacts','config.json');
  let saved={};
  try{saved=JSON.parse(await readFile(configFile,'utf8'))??{};}catch{/* No saved configuration yet. */}
  if(saved.exclude_paths!==undefined&&!Array.isArray(saved.exclude_paths))throw new Error('config exclude_paths must be an array');
  if(saved.exclude_keywords!==undefined&&!Array.isArray(saved.exclude_keywords))throw new Error('config exclude_keywords must be an array');
  if(saved.index_roots!==undefined&&!Array.isArray(saved.index_roots))throw new Error('config index_roots must be an array');
  const excludedPaths=[...new Set([...(saved.exclude_paths??[]),...(values['exclude-path']??[])])];
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
    emit({package:'@1agents/artifact-index',version:packageVersion,parsers:await extraction.doctor(parserOptions),embeddings:models,models_downloaded:false});return;
  }
  const {ArtifactIndex}=await import('../src/index.mjs');
  const {extractArtifact}=await import('../src/extract.mjs');
  const dbPath=path.resolve(values.db??path.join(homedir(),'.1agents/artifacts/index.sqlite'));
  const cacheDir=path.resolve(values['cache-dir']??path.join(homedir(),'.1agents/artifacts/cache'));
  const index=new ArtifactIndex({dbPath,cacheDir,sourceNode:values['source-node']??hostname(),sharing:values.sharing,extractor:(file,options)=>extractArtifact(file,{...options,...parserOptions}),embeddings});
  let service;
  try{
    if(command==='index'){
      // Configured roots keep a multi-location corpus reproducible: the same
      // command rebuilds every source the user asked for.
      const roots=[...positionals.map(file=>path.resolve(file)),...(saved.index_roots??[]).map(root=>path.resolve(root))];
      if(!roots.length)throw new Error('index requires one or more local file or directory paths');
      emit(await index.index(roots,{semantic:!values['no-semantic'],visual:!values['no-visual'],sharing:values.sharing,embeddingTimeoutMs,reindex:values.reindex,concurrency:integer(values.concurrency,6,1,32,'concurrency'),chunkSize:integer(values['chunk-size'],64,1,2000,'chunk size'),onProgress:info=>process.stderr.write(`[${new Date().toISOString().slice(11,19)}] ${info.phase} group ${info.group}/${info.groups} files=${info.files}${info.cached!==undefined?` cached=${info.cached}`:''}\n`),scan:{maxDepth:integer(values['max-depth'],12,1,64,'max depth'),fileLimit:integer(values['file-limit'],5000,1,1000000,'file limit'),exclude:values.exclude??[],excludeKeywords:[...(saved.exclude_keywords??[]),...(values['exclude-keyword']??[])],excludeDirectories:values['exclude-dir']??[],includeHidden:values['include-hidden']}}));
    }else if(command==='search'){
      const queryImage=values['query-image'];
      if(!values.query?.trim()&&!queryImage)throw new Error('--query or --query-image is required');
      emit(await index.search(values.query??'',{mode:values.mode,types:values.types?.split(','),excludePaths:excludedPaths,modalities:values.modalities?.split(','),limit:integer(values.limit,15,1,20,'limit'),offset:integer(values.offset,0,0,10000,'offset'),maxChars:integer(values['max-chars'],12000,1000,12000,'max chars'),embeddingTimeoutMs,...(queryImage?{queryImage:path.resolve(queryImage)}:{}),collapseDuplicates:!values['keep-duplicates']}));
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
