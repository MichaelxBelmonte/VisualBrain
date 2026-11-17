// Claude Code StopFailure hook / optional statusLine adapter. Only quota metadata goes to the local API.
export function observation(data) {
  const windows=[];
  for(const [key,minutes] of [['five_hour',300],['seven_day',10080]]){
    const w=data?.rate_limits?.[key];
    if(w && typeof w.used_percentage==='number' && Number.isFinite(w.used_percentage) && w.used_percentage>=0 && w.used_percentage<=100)
      windows.push({name:key,minutes,remainingPct:100-w.used_percentage,resetsAt:Number.isSafeInteger(w.resets_at)?w.resets_at*1000:null});
  }
  const failure=data?.hook_event_name==='StopFailure' && data.error==='rate_limit';
  if(!failure && !windows.length)return null;
  const details=data.error_details;
  const header=details?.headers?.['retry-after'] ?? details?.headers?.['Retry-After'] ??
    (typeof details==='string'?/^(?:Retry-After):[ \t]*([^\r\n]+)$/im.exec(details)?.[1]?.trim():null);
  return {windows,limited:failure,origin:failure?'StopFailure':'statusline',...(header!=null?{retryAfter:header}:{})};
}
async function main() {
  const {VB_STATE_URL:address,VB_SESSION_ID:from,VB_TEAM_TOKEN:token}=process.env;
  if(!address||!from||!token)return;
  const url=new URL(address);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!/^\/api\/work\/\d+\/state$/.test(url.pathname)||url.search||url.hash||url.username||url.password)return;
  let raw='';process.stdin.setEncoding('utf8');
  for await(const chunk of process.stdin){if(raw.length+chunk.length>2_000_000)return;raw+=chunk;}
  const data=observation(JSON.parse(raw));
  if(!data)return;
  url.pathname=url.pathname.replace(/state$/,'quota');
  await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(1200),headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({...data,from})});
}
if(import.meta.filename===process.argv[1])await main().catch(()=>{});
