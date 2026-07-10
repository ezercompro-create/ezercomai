// EzercomAI Radar — Sunucu Tarafı Tarama (Vercel Serverless + Cron)
// Her çalıştığında: Binance Futures top-100'ü tarar, dip/tepe sinyallerini Telegram'a yollar.
// Gerekli env değişkenleri (Vercel → Settings → Environment Variables):
//   TELEGRAM_TOKEN   = BotFather'dan alınan bot token'ı
//   TELEGRAM_CHAT_ID = mesajın gideceği sohbet id'si
//   SCAN_KEY         = (opsiyonel) elle tetiklerken ?key=... koruması

const BIN = "https://fapi.binance.com";
const TOP_N = 100, MINCOMP = 3, TH = 40;

/* ---------- göstergeler (dashboard motoruyla birebir) ---------- */
const body=k=>Math.abs(k.c-k.o), range=k=>k.h-k.l;
const upWick=k=>k.h-Math.max(k.o,k.c), dnWick=k=>Math.min(k.o,k.c)-k.l;
const isBull=k=>k.c>k.o, isBear=k=>k.c<k.o;
function sma(a,n){ if(a.length<n) return null; let s=0; for(let i=a.length-n;i<a.length;i++)s+=a[i]; return s/n; }
function rsi(c,p=14){ if(c.length<p+1) return null; let g=0,l=0;
  for(let i=1;i<=p;i++){const d=c[i]-c[i-1]; if(d>0)g+=d; else l-=d;}
  let ag=g/p,al=l/p;
  for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];
    ag=(ag*(p-1)+Math.max(d,0))/p; al=(al*(p-1)+Math.max(-d,0))/p;}
  return al===0?100:100-100/(1+ag/al); }
function trendCtx(c,n=8){ if(c.length<n)return 0; const s=c.slice(-n); return s[0]>0?(s[s.length-1]-s[0])/s[0]:0; }

function detectPatterns(kl){
  const out=[]; if(kl.length<5) return out;
  const n=kl.length, a=kl[n-1], b=kl[n-2], c=kl[n-3];
  const ctx=trendCtx(kl.slice(0,-1).map(k=>k.c),8);
  const down=ctx<-0.03, up=ctx>0.03;
  const avgRange=sma(kl.slice(-15).map(range),Math.min(15,n))||range(a)||1e-9;
  const rA=range(a)||1e-9, bA=body(a);
  const push=(name,dir,w)=>out.push({name,dir,w});
  if(dnWick(a)>=2*bA&&upWick(a)<=0.35*bA+1e-12&&bA/rA<0.4&&rA>0.5*avgRange){
    if(down)push("Çekiç",1,0.9); else if(up)push("Asılı Adam",-1,0.6); }
  if(upWick(a)>=2*bA&&dnWick(a)<=0.35*bA+1e-12&&bA/rA<0.4&&rA>0.5*avgRange){
    if(down)push("Ters Çekiç",1,0.6); else if(up)push("Kayan Yıldız",-1,0.9); }
  if(bA/rA<0.08&&rA>0.4*avgRange){
    if(dnWick(a)>3*upWick(a)&&down)push("Dragonfly Doji",1,0.55);
    else if(upWick(a)>3*dnWick(a)&&up)push("Gravestone Doji",-1,0.55);
    else if(down||up)push("Doji",down?1:-1,0.3); }
  if(n>=2){ const bB=body(b), tol=avgRange*0.1;
    if(isBear(b)&&isBull(a)&&a.c>=b.o&&a.o<=b.c&&bA>bB*1.05&&down)push("Boğa Yutan",1,1.0);
    if(isBull(b)&&isBear(a)&&a.o>=b.c&&a.c<=b.o&&bA>bB*1.05&&up)push("Ayı Yutan",-1,1.0);
    if(isBear(b)&&isBull(a)&&a.o<b.l&&a.c>(b.o+b.c)/2&&a.c<b.o&&down)push("Delen Mum",1,0.75);
    if(isBull(b)&&isBear(a)&&a.o>b.h&&a.c<(b.o+b.c)/2&&a.c>b.o&&up)push("Kara Bulut",-1,0.75);
    if(isBear(b)&&isBull(a)&&a.o>b.c&&a.c<b.o&&bB>0.6*avgRange&&down)push("Boğa Harami",1,0.5);
    if(isBull(b)&&isBear(a)&&a.o<b.c&&a.c>b.o&&bB>0.6*avgRange&&up)push("Ayı Harami",-1,0.5);
    if(Math.abs(a.l-b.l)<tol&&isBear(b)&&isBull(a)&&down)push("Cımbız Dip",1,0.6);
    if(Math.abs(a.h-b.h)<tol&&isBull(b)&&isBear(a)&&up)push("Cımbız Tepe",-1,0.6); }
  if(n>=3){ const bC=body(c);
    if(isBear(c)&&body(b)<bC*0.5&&isBull(a)&&a.c>(c.o+c.c)/2&&down)push("Sabah Yıldızı",1,1.0);
    if(isBull(c)&&body(b)<bC*0.5&&isBear(a)&&a.c<(c.o+c.c)/2&&up)push("Akşam Yıldızı",-1,1.0);
    if(isBull(a)&&isBull(b)&&isBull(c)&&a.c>b.c&&b.c>c.c&&body(a)>0.5*avgRange&&body(b)>0.5*avgRange&&down)push("Üç Beyaz Asker",1,0.8);
    if(isBear(a)&&isBear(b)&&isBear(c)&&a.c<b.c&&b.c<c.c&&body(a)>0.5*avgRange&&body(b)>0.5*avgRange&&up)push("Üç Kara Karga",-1,0.8); }
  out.sort((x,y)=>y.w-x.w);
  return out;
}

const DAY=86400000, WEEK=7*DAY;
function analyze(sym, meta, dAll, wAll){
  // sunucu taraması her zaman "sadece kapanmış mumlar" modunda çalışır
  const d=dAll.filter(k=>k.t+DAY<=Date.now());
  const w=wAll.filter(k=>k.t+WEEK<=Date.now());
  if(d.length<25||w.length<5) return null;
  const last=d[d.length-1];
  const rsiD=rsi(d.map(k=>k.c)), rsiW=rsi(w.map(k=>k.c));
  const dP=detectPatterns(d)[0]||null, wP=detectPatterns(w)[0]||null;
  const look=d.slice(-90);
  const lo=Math.min(...look.map(k=>k.l)), hi=Math.max(...look.map(k=>k.h));
  const rangePos=hi>lo?(last.c-lo)/(hi-lo):0.5;
  const vAvg=sma(d.slice(0,-1).map(k=>k.v),20);
  const volX=vAvg?last.v/vAvg:1;
  const rA=range(last)||1e-9, lowRej=dnWick(last)/rA, highRej=upWick(last)/rA;
  const parts=[];
  parts.push(wP?Math.round(25*wP.w*wP.dir):0);
  parts.push(dP?Math.round(15*dP.w*dP.dir):0);
  let v=0;
  if(rsiD!=null){ if(rsiD<=30)v=Math.min(15,Math.round((30-rsiD)*0.75)); else if(rsiD>=70)v=-Math.min(15,Math.round((rsiD-70)*0.75)); }
  parts.push(v); v=0;
  if(rsiW!=null){ if(rsiW<=35)v=Math.min(10,Math.round((35-rsiW)*0.5)); else if(rsiW>=65)v=-Math.min(10,Math.round((rsiW-65)*0.5)); }
  parts.push(v); v=0;
  if(rangePos<=0.2)v=Math.round(12*(0.2-rangePos)/0.2); else if(rangePos>=0.8)v=-Math.round(12*(rangePos-0.8)/0.2);
  parts.push(v);
  const pd=(wP?wP.dir*wP.w:0)*1.5+(dP?dP.dir*dP.w:0);
  v=0; if(volX>=1.5&&pd!==0)v=Math.round(Math.min(10,(volX-1)*5)*Math.sign(pd));
  parts.push(v);
  const f=meta.funding; v=0;
  if(f!=null){ if(f<=-0.0003)v=Math.min(8,Math.round(-f/0.0005*4+2));
    else if(f>=0.0005)v=-Math.min(8,Math.round(f/0.0008*4+2)); }
  parts.push(v); v=0;
  if(lowRej>0.55&&rangePos<0.4)v=5; else if(highRej>0.55&&rangePos>0.6)v=-5;
  parts.push(v);
  const score=Math.max(-100,Math.min(100,parts.reduce((a,b)=>a+b,0)));
  const sgn=score>=0?1:-1;
  const comps=parts.reduce((a,x)=>a+((sgn>0?x>=3:x<=-3)?1:0),0);
  return { symbol:sym, score, comps, rsiD,
    pat:(wP?("1W "+wP.name):dP?("1D "+dP.name):"momentum"),
    funding:f, price:last.c };
}

/* ---------- veri ---------- */
async function jget(u){ const r=await fetch(u); if(!r.ok) throw new Error("HTTP "+r.status+" "+u); return r.json(); }

async function runScan(deadline){
  const [info,tick,prem]=await Promise.all([
    jget(BIN+"/fapi/v1/exchangeInfo"),
    jget(BIN+"/fapi/v1/ticker/24hr"),
    jget(BIN+"/fapi/v1/premiumIndex")]);
  const tmap=Object.fromEntries(tick.map(t=>[t.symbol,t]));
  const fmap=Object.fromEntries(prem.map(p=>{const f=parseFloat(p.lastFundingRate);return[p.symbol,isFinite(f)?f:null];}));
  const syms=info.symbols
    .filter(s=>s.contractType==="PERPETUAL"&&s.quoteAsset==="USDT"&&s.status==="TRADING")
    .map(s=>({symbol:s.symbol, quoteVol:+(tmap[s.symbol]?.quoteVolume||0), funding:fmap[s.symbol]??null}))
    .sort((a,b)=>b.quoteVol-a.quoteVol).slice(0,TOP_N);
  const rows=[]; let idx=0;
  async function worker(){
    while(idx<syms.length && Date.now()<deadline){
      const s=syms[idx++];
      try{
        const [d,w]=await Promise.all([
          jget(`${BIN}/fapi/v1/klines?symbol=${s.symbol}&interval=1d&limit=99`).then(a=>a.map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]}))),
          jget(`${BIN}/fapi/v1/klines?symbol=${s.symbol}&interval=1w&limit=40`).then(a=>a.map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]})))]);
        const r=analyze(s.symbol,s,d,w);
        if(r) rows.push(r);
      }catch(e){}
    }
  }
  await Promise.all(Array.from({length:15},worker));
  return {rows, universe:syms.length};
}

function buildMessage(rows, universe){
  const dips=rows.filter(r=>r.score>=TH&&r.comps>=MINCOMP).sort((a,b)=>b.score-a.score);
  const tops=rows.filter(r=>r.score<=-TH&&r.comps>=MINCOMP).sort((a,b)=>a.score-b.score);
  const dipB=rows.filter(r=>r.score>=20).length, topB=rows.filter(r=>r.score<=-20).length;
  const funds=rows.map(r=>r.funding).filter(f=>f!=null);
  const fAvg=funds.length?funds.reduce((a,b)=>a+b,0)/funds.length:0;
  const btc=rows.find(r=>r.symbol==="BTCUSDT");
  let pts=0;
  if(fAvg<-0.00002)pts++; else if(fAvg>0.00012)pts--;
  if(dipB>3&&dipB>=2*topB)pts++; else if(topB>3&&topB>=2*dipB)pts--;
  if(btc&&btc.rsiD!=null){ if(btc.rsiD<45)pts++; else if(btc.rsiD>60)pts--; }
  const regime=pts>=2?"🟢 LONG LEHİNE":pts<=-2?"🔴 SHORT LEHİNE":"⚪ NÖTR";
  const line=r=>`• <b>${r.symbol}</b> ${r.score>0?"+":""}${r.score} — ${r.pat} (${r.comps} bileşen)`;
  let msg=`🎯 <b>EzercomAI Radar — Günlük Tarama</b>\n`;
  msg+=`Rejim: <b>${regime}</b> · Ort. funding ${(fAvg*100).toFixed(4)}% · BTC RSI ${btc&&btc.rsiD!=null?btc.rsiD.toFixed(1):"–"}\n`;
  msg+=`Analiz edilen: ${rows.length}/${universe} · eşik ${TH} · minB ${MINCOMP}\n\n`;
  msg+=`🟢 <b>Dipten Dönüş Hazır (${dips.length})</b>\n`;
  msg+=dips.length?dips.slice(0,8).map(line).join("\n"):"— aday yok";
  msg+=`\n\n🔴 <b>Tepeden Dönüş Hazır (${tops.length})</b>${pts>=2&&tops.length?" ⚠ rejim karşıtı":""}\n`;
  msg+=tops.length?tops.slice(0,8).map(line).join("\n"):"— aday yok";
  msg+=`\n\nDetay için dashboard'ı aç. Sinyal ≠ emir: kırılım girişi + SL şart.`;
  return msg;
}

async function sendTelegram(msg){
  const token=process.env.TELEGRAM_TOKEN, chat=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chat) return {sent:false, reason:"TELEGRAM_TOKEN / TELEGRAM_CHAT_ID tanımlı değil"};
  const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:chat, text:msg, parse_mode:"HTML", disable_web_page_preview:true})});
  const j=await r.json();
  return {sent:!!j.ok, reason:j.ok?"":JSON.stringify(j)};
}

module.exports = async (req, res) => {
  // koruma: SCAN_KEY tanımlıysa ?key= eşleşmeli; Vercel cron ise CRON_SECRET başlığıyla gelir
  const key=process.env.SCAN_KEY;
  const auth=req.headers["authorization"]||"";
  const isCron=process.env.CRON_SECRET && auth===`Bearer ${process.env.CRON_SECRET}`;
  if(key && req.query.key!==key && !isCron)
    return res.status(401).json({ok:false, error:"key gerekli (?key=...)"});
  try{
    const deadline=Date.now()+45000; // 45 sn güvenli sınır
    const {rows, universe}=await runScan(deadline);
    const msg=buildMessage(rows, universe);
    const tg=await sendTelegram(msg);
    res.status(200).json({ok:true, analyzed:rows.length, universe, telegram:tg,
      dips:rows.filter(r=>r.score>=TH&&r.comps>=MINCOMP).map(r=>({s:r.symbol,sc:r.score})),
      tops:rows.filter(r=>r.score<=-TH&&r.comps>=MINCOMP).map(r=>({s:r.symbol,sc:r.score}))});
  }catch(e){
    res.status(500).json({ok:false, error:String(e.message||e)});
  }
};
