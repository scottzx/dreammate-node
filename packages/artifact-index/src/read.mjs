/** Bound transport output while the library keeps the complete original unit. */
export function readPage(unit,{section='text',offset=0,maxChars=12000}={}){
  if(!['text','metadata','representations'].includes(section))throw new Error('Invalid read section');
  if(!Number.isSafeInteger(offset)||offset<0||offset>100000000)throw new Error('Invalid read offset');
  if(!Number.isSafeInteger(maxChars)||maxChars<1000||maxChars>12000)throw new Error('Invalid read character budget');
  const {text='',metadata={},representations=[],resource,...header}=unit;
  const content=section==='text'?text:JSON.stringify(section==='metadata'?metadata:representations);
  const fixed={...header,status:resource?.status,last_error:resource?.last_error,section,content_type:section==='text'?'text/plain':'application/json',offset,total_chars:content.length};
  const budget=Math.max(64,maxChars-JSON.stringify(fixed).length-180);
  // JSON escaping can expand one character to six bytes/characters. Budget the
  // serialized page itself so dense table metadata stays bounded as well.
  let low=0,high=Math.min(content.length-offset,Math.max(0,budget));
  high=Math.max(0,high);
  while(low<high){const middle=Math.ceil((low+high)/2);if(JSON.stringify(content.slice(offset,offset+middle)).length<=budget)low=middle;else high=middle-1;}
  const end=offset+low;
  return {...fixed,text:content.slice(offset,end),next_offset:end<content.length?end:null,truncated:end<content.length};
}
