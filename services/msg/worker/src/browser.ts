import arrowDown from "./assets/icons/arrow-down.svg" with { type: "text" };
import clock from "./assets/icons/clock.svg" with { type: "text" };
import download from "./assets/icons/download.svg" with { type: "text" };
import link from "./assets/icons/link.svg" with { type: "text" };
import userPlusWhite from "./assets/icons/user-plus-white.svg" with { type: "text" };
import { browserFailureState, copyText, createLiveController, createPushEnrollmentController, createThemeController, createWebhookPanelController, handleAgentPromptCopy, readPushBrowserId, type PushEnrollmentState, type WebhookPanelEntry } from "./browser-controller";
import { viewSwitchHref } from "./browser-view";
import { bootCoordinationBrowser, createCoordinationBrowserHelpers } from "./browser-coordination";

/** The public browser has no access to a room management capability. */
export interface BrowserPageOptions { readonly pushPublicKey?: string; readonly room?: string; readonly title: string; readonly url?: URL; }
export interface BrowserPageDocument { readonly html: string; readonly styleNonce: string; }

export const MERMAID_ASSET_PATH = "/_msg/asset/mermaid-11.17.2.min.js";
const MERMAID_MAX_BLOCKS_PER_MESSAGE = 4;
const MERMAID_MAX_SOURCE_BYTES = 8 * 1024;
const MERMAID_MAX_TOTAL_SOURCE_BYTES = 32 * 1024;
const MERMAID_MAX_SVG_BYTES = 256 * 1024;
const MERMAID_MAX_LINES = 200;
const MERMAID_MAX_TRANSCRIPT_BLOCKS = 20;

const iconAssets: Record<string, string> = { "arrow-down.svg": arrowDown, "clock.svg": clock, "download.svg": download, "link.svg": link, "user-plus-white.svg": userPlusWhite };

export function browserIcon(name: string): Response | undefined {
  const body = iconAssets[name];
  return body ? new Response(body, { headers: { "content-type": "image/svg+xml; charset=utf-8" } }) : undefined;
}

export function browserErrorState(status: number, online: boolean): string {
  return browserFailureState(status, online).notice;
}

export function escapeHtml(value: string): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function safeLink(value: string): string | undefined {
  const target = String(value).trim();
  return /^(https?:\/\/|mailto:)/i.test(target) ? target : undefined;
}

export function renderInlineMarkdown(value: string): string {
  const protectedTokens: string[] = [];
  const token = (html: string) => `\uE000${protectedTokens.push(html) - 1}\uE001`;
  const source = String(value)
    .replace(/`([^`\n]+)`/g, (_, code: string) => token(`<code>${escapeHtml(code)}</code>`))
    .replace(/\[([^\]]+)]\(([^)\s]+)\)/g, (_, label: string, href: string) => {
      const target = safeLink(href);
      return target ? token(`<a href="${escapeHtml(target)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`) : escapeHtml(label);
    });
  return escapeHtml(source)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\uE000(\d+)\uE001/g, (_, index: string) => protectedTokens[Number(index)] ?? "");
}

export function startsMarkdownBlock(line: string): boolean {
  return /^(?:```|#{1,3}\s+|>\s?|[-*]\s+|\d+\.\s+)/.test(line);
}

function supportsMermaidSource(source: string): boolean {
  const lines = source.split("\n");
  const firstLine = lines.find((line) => line.trim() && !/^\s*%%(?:\s|$)/.test(line));
  if (!firstLine || lines.length > MERMAID_MAX_LINES) return false;
  const sourceWithoutLineBreaks = source.replace(/<br\s*\/?>/gi, "");
  if (/```|%%\s*\{|(^|\n)\s*---\s*(?:\n|$)|^\s*(?:click|classDef|class|style|linkStyle|links?|properties|image|icon)\b|@\s*\{|\b(?:https?|data|blob|file):|url\s*\(|<\/?[a-z][^>]*>/imu.test(sourceWithoutLineBreaks)) return false;
  return /^(?:flowchart(?:\s+(?:TB|TD|BT|RL|LR))?|graph\s+(?:TB|TD|BT|RL|LR))\b/i.test(firstLine.trim())
    || /^sequenceDiagram\b/i.test(firstLine.trim());
}

function renderMermaidBlock(source: string, eligible: boolean): string {
  const marker = eligible ? ' data-mermaid-block="true"' : "";
  const noticeHidden = eligible ? " hidden" : "";
  const notice = `<p class="message-mermaid-error" role="status"${noticeHidden}>Diagram unavailable. The original source is shown below.</p>`;
  return `<figure class="message-mermaid" role="group" aria-label="Mermaid diagram"${marker}><div class="message-mermaid-diagram" role="img" aria-label="Mermaid diagram" hidden></div>${notice}<details class="message-mermaid-source" open><summary>Show source</summary><pre><code class="language-mermaid">${escapeHtml(source)}</code></pre></details></figure>`;
}

/** A deliberately small renderer. Room content is never trusted HTML. */
export function renderMarkdown(markdown: string): string {
  const lines = String(markdown).replaceAll("\r\n", "\n").split("\n");
  const blocks: string[] = [];
  let mermaidCount = 0;
  let mermaidBytes = 0;
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(/^```([a-z0-9_-]*)\s*$/i);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) code.push(lines[index++]);
      const closed = index < lines.length;
      if (closed) index += 1;
      const source = code.join("\n");
      if (closed && fence[1].toLowerCase() === "mermaid") {
        const sourceBytes = new TextEncoder().encode(source).byteLength;
        mermaidCount += 1;
        mermaidBytes += sourceBytes;
        const eligible = source.trim().length > 0
          && sourceBytes <= MERMAID_MAX_SOURCE_BYTES
          && mermaidBytes <= MERMAID_MAX_TOTAL_SOURCE_BYTES
          && mermaidCount <= MERMAID_MAX_BLOCKS_PER_MESSAGE
          && supportsMermaidSource(source);
        blocks.push(renderMermaidBlock(source, eligible));
        continue;
      }
      const language = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : "";
      blocks.push(`<pre><code${language}>${escapeHtml(source)}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) { blocks.push(`<h${heading[1].length}>${renderInlineMarkdown(heading[2])}</h${heading[1].length}>`); index += 1; continue; }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ""));
      blocks.push(`<blockquote>${renderInlineMarkdown(quote.join(" "))}</blockquote>`);
      continue;
    }
    const unordered = /^[-*]\s+/.test(line);
    const ordered = /^\d+\.\s+/.test(line);
    if (unordered || ordered) {
      const pattern = unordered ? /^[-*]\s+(.+)$/ : /^\d+\.\s+(.+)$/;
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(pattern);
        if (!item) break;
        items.push(`<li>${renderInlineMarkdown(item[1])}</li>`);
        index += 1;
      }
      const tag = unordered ? "ul" : "ol";
      blocks.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsMarkdownBlock(lines[index])) paragraph.push(lines[index++].trim());
    blocks.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
  }
  return blocks.join("\n");
}

const mermaidStyles = String.raw`.message-mermaid{max-width:100%;margin:12px 0;border:1px solid var(--line);border-radius:8px;background:var(--soft)}.message-mermaid-diagram{display:block;max-width:100%;overflow:auto;overscroll-behavior:contain}.message-mermaid-diagram[hidden],.message-mermaid-error[hidden]{display:none}.message-mermaid-source{min-width:0}.message-mermaid-source summary{display:flex;min-height:44px;align-items:center;padding:8px 12px;border-top:1px solid var(--line);cursor:pointer;color:var(--muted-strong);font-size:12px;font-weight:700;list-style:none}.message-mermaid-source summary::-webkit-details-marker{display:none}.message-mermaid-source summary:after{margin-left:auto;content:"+";font-size:16px;font-weight:400}.message-mermaid-source[open] summary:after{content:"−"}.message-mermaid-source pre{max-width:100%;max-height:420px;margin:0;border:0;border-top:1px solid var(--line);border-radius:0 0 8px 8px}.message-mermaid-error{margin:0;padding:11px 13px;border-bottom:1px solid var(--line);color:var(--muted-strong);font-size:13px}.message-mermaid-diagram svg{display:block}`;

const notificationPanelStyles = String.raw`.notifications-panel{max-height:min(88dvh,760px);overflow:auto}.notifications-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:22px 24px 16px;border-bottom:1px solid var(--line)}.notifications-header h2{margin:0;font-size:21px}.notifications-header p{margin:0 0 5px;color:var(--accent);font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.notifications-body{display:grid;gap:18px;padding:20px 24px 24px}.push-settings{display:grid;gap:9px;padding:14px;border:1px solid var(--line);border-radius:9px;background:var(--soft)}.push-settings h3{margin:0;font-size:14px}.push-status{margin:0;color:var(--muted-strong);font-size:13px;line-height:1.5}.push-settings .webhook-list-actions{margin-top:2px}.webhook-form{display:grid;gap:9px}.webhook-form label,.webhook-list-title{font-size:13px;font-weight:700}.webhook-form input{width:100%;min-height:44px;padding:9px 11px;border:1px solid var(--line-strong);border-radius:8px;background:var(--surface);color:var(--ink);font:inherit}.notifications-help,.webhook-empty,.webhook-status{margin:0;color:var(--muted-strong);font-size:13px;line-height:1.5}.webhook-status:empty{display:none}.webhook-list{display:grid;gap:10px;margin:0;padding:0;list-style:none}.webhook-list-item{display:grid;gap:8px;padding:13px;border:1px solid var(--line);border-radius:9px;background:var(--soft)}.webhook-list-item strong{overflow-wrap:anywhere;font-size:13px}.webhook-list-meta{margin:0;color:var(--muted-strong);font-size:12px;line-height:1.5;overflow-wrap:anywhere}.webhook-delivery{display:grid;gap:7px;padding-top:8px;border-top:1px solid var(--line)}.webhook-secret{display:grid;gap:8px;padding:14px;border:1px solid var(--accent-line);border-radius:8px;background:var(--blue)}.webhook-secret p{margin:0;color:var(--muted-strong);font-size:13px}.webhook-secret code{display:block;overflow-wrap:anywhere;padding:9px;border-radius:6px;background:var(--surface);font:12px/1.5 ui-monospace,monospace}.webhook-list-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-start}@media(max-width:760px){.notifications-header{padding:18px}.notifications-body{padding:18px}.notifications-header h2{font-size:19px}}`;
const coordinationPanelStyles = String.raw`.coordination-panel{width:min(calc(100% - 28px),760px);max-height:min(92dvh,900px);overflow:auto}.coordination-body{display:grid;gap:18px;padding:20px 24px 26px}.coordination-form{display:grid;gap:9px;padding:14px;border:1px solid var(--line);border-radius:9px;background:var(--soft)}.coordination-form h3{margin:0;font-size:15px}.coordination-form label{font-size:12px;font-weight:700}.coordination-form input,.coordination-form textarea{width:100%;min-height:40px;padding:9px 11px;border:1px solid var(--line-strong);border-radius:8px;background:var(--surface);color:var(--ink);font:inherit}.coordination-form textarea{min-height:72px;resize:vertical}.coordination-form small,.coordination-help,.coordination-status{margin:0;color:var(--muted-strong);font-size:12px;line-height:1.5}.coordination-status{min-height:1.5em}.coordination-overview{display:grid;gap:9px}.coordination-overview p{margin:0;color:var(--muted-strong);font-size:13px}.coordination-item{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);font-size:13px}.coordination-item span{flex:1 1 220px}.coordination-item a{color:var(--accent);font-size:12px}.coordination-pinned{display:grid;gap:6px;max-height:min(42vh,26rem);margin:0 auto 18px;padding:14px 16px;overflow:auto;border:1px solid var(--accent-line);border-radius:10px;background:var(--blue);box-shadow:0 4px 14px oklch(30% 0.03 250 / 8%)}.coordination-pinned p{margin:0;color:var(--muted-strong);font-size:13px;overflow-wrap:anywhere}.coordination-pinned a{overflow-wrap:anywhere}.coordination-panel .notifications-header{padding:22px 24px 16px;border-bottom:1px solid var(--line)}@media(max-width:760px){.coordination-panel .notifications-header{padding:18px}.coordination-body{padding:18px}.coordination-pinned{max-height:36vh;margin:0 0 14px;padding:12px 14px}}`;
const coordinationControlStyles = String.raw`.coordination-form select{width:100%;min-height:40px;padding:9px 11px;border:1px solid var(--line-strong);border-radius:8px;background:var(--surface);color:var(--ink);font:inherit}`;

const productionMermaidRuntime = String.raw`
const mermaidStyleNonce=document.currentScript?.nonce||'';
const mermaidAssetPath='${MERMAID_ASSET_PATH}';
let mermaidLoadPromise=null,mermaidGeneration=0;
const mermaidTranscriptLimit=${MERMAID_MAX_TRANSCRIPT_BLOCKS};
function ensureMermaid(){if(globalThis.mermaid)return Promise.resolve(globalThis.mermaid);if(mermaidLoadPromise)return mermaidLoadPromise;mermaidLoadPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=mermaidAssetPath;script.async=true;script.onload=()=>{if(globalThis.mermaid)resolve(globalThis.mermaid);else{script.remove();mermaidLoadPromise=null;reject(Error('renderer unavailable'))}};script.onerror=()=>{script.remove();mermaidLoadPromise=null;reject(Error('renderer unavailable'))};document.head.append(script)});return mermaidLoadPromise}
function safeMermaidDeclarations(source){const allowed=['fill','fill-opacity','fill-rule','stroke','stroke-width','stroke-opacity','stroke-dasharray','stroke-dashoffset','stroke-linecap','stroke-linejoin','stroke-miterlimit','opacity','color','font-family','font-size','font-weight','font-style','text-anchor','text-decoration','dominant-baseline','marker-start','marker-mid','marker-end','visibility','display','pointer-events','shape-rendering','vector-effect','paint-order','letter-spacing','cursor','background-color','max-width','width','height','line-height','text-align'];const result=[];for(const declaration of source.split(';')){const colon=declaration.indexOf(':');if(colon<1)continue;const property=declaration.slice(0,colon).trim().toLowerCase(),value=declaration.slice(colon+1).trim();if(!allowed.includes(property)||!value||value.length>160||/[<>\\{};]/.test(value)||/(?:url|expression|javascript|data|https?|blob|file)\s*[:(]/i.test(value)||/@import/i.test(value))continue;result.push(property+':'+value)}return result}
function withoutMermaidAtRules(source){let result='',index=0;while(index<source.length){if(source[index]!=='@'){result+=source[index++];continue}const opening=source.indexOf('{',index),semicolon=source.indexOf(';',index);if(semicolon!==-1&&(opening===-1||semicolon<opening)){index=semicolon+1;continue}if(opening===-1)throw Error('unsupported renderer styles');let depth=1,end=opening+1;while(depth&&end<source.length){if(source[end]==='{')depth+=1;else if(source[end]==='}')depth-=1;end+=1}if(depth)throw Error('unsupported renderer styles');index=end}return result}
function safeMermaidStylesheet(source,svgId){if(new TextEncoder().encode(source).byteLength>32768)throw Error('renderer styles too large');const css=withoutMermaidAtRules(source).replace(/\/\*[\s\S]*?\*\//g,'');if(/:host|::part|::slotted|\\/i.test(css))throw Error('unsafe renderer styles');const rules=[],pattern=/([^{}]+)\{([^{}]*)\}/g;for(const match of css.matchAll(pattern)){const selector=match[1].trim();if(!selector||selector.length>300)throw Error('unsafe renderer selector');const declarations=safeMermaidDeclarations(match[2]);if(!declarations.length||selector===':root')continue;const selectors=selector.split(',').flatMap(part=>{const value=part.trim();if(!value)throw Error('unsafe renderer selector');if(value===':root')return[];if(/[<>\\]/.test(value))throw Error('unsafe renderer selector');return[value==='#'+svgId||value.startsWith('#'+svgId+' ')?value:'#'+svgId+' '+value]});if(selectors.length)rules.push(selectors.join(',')+'{'+declarations.join(';')+'}')}const remainder=css.replace(/[^{}]+\{[^{}]*\}/g,'').trim();if(remainder)throw Error('unsupported renderer styles');return rules}
function sanitizeMermaidSvg(host,source,id){if(!mermaidStyleNonce||new TextEncoder().encode(source).byteLength>${MERMAID_MAX_SVG_BYTES})return false;const parsed=new DOMParser().parseFromString(source,'image/svg+xml'),svg=parsed.documentElement;if(!svg||svg.localName!=='svg'||svg.getAttribute('id')!==id||parsed.querySelector('parsererror'))return false;const allowedTags=['svg','style','g','path','rect','circle','ellipse','polygon','polyline','line','text','tspan','title','desc','defs','marker','clipPath','filter','feGaussianBlur','feColorMatrix','feMerge','feMergeNode','feFlood','feComposite','feBlend','feOffset','feDropShadow','linearGradient','stop'];const allowedAttrs=['id','class','xmlns','viewBox','width','height','x','y','x1','y1','x2','y2','dx','dy','d','points','transform','fill','fill-opacity','fill-rule','stroke','stroke-width','stroke-opacity','stroke-dasharray','stroke-dashoffset','stroke-linecap','stroke-linejoin','stroke-miterlimit','opacity','color','font-family','font-size','font-weight','font-style','text-anchor','text-decoration','dominant-baseline','marker-start','marker-mid','marker-end','visibility','display','pointer-events','shape-rendering','vector-effect','paint-order','letter-spacing','filter','clip-path','orient','refX','refY','markerWidth','markerHeight','markerUnits','stdDeviation','flood-color','flood-opacity','result','in','operator','k1','k2','k3','k4','offset','stop-color','stop-opacity','role','aria-label','focusable'];const nodes=[svg,...svg.querySelectorAll('*')],styleTexts=Array.from(svg.querySelectorAll('style'),node=>node.textContent||''),inlineRules=[];if(nodes.some(node=>!allowedTags.includes(node.localName)))return false;for(const node of nodes){if(node.localName==='style')continue;for(const attribute of Array.from(node.attributes)){const name=attribute.name,value=attribute.value;if(name.toLowerCase().startsWith('on')||name.toLowerCase()==='href'||name.toLowerCase()==='xlink:href'||name.toLowerCase()==='src'){node.removeAttribute(name);continue}if(name==='style'){const declarations=safeMermaidDeclarations(value);node.removeAttribute(name);if(declarations.length){const styleIndex=inlineRules.length;node.setAttribute('data-msg-style-index',String(styleIndex));inlineRules.push('#'+id+' [data-msg-style-index="'+styleIndex+'"]{'+declarations.join(';')+'}')}continue}if(!allowedAttrs.includes(name)){node.removeAttribute(name);continue}if(name==='id'&&!/^[A-Za-z0-9_-]{1,100}$/.test(value))return false;if(name==='class'&&!/^[A-Za-z0-9 _-]{1,200}$/.test(value))return false;if(name==='xmlns'&&value==='http://www.w3.org/2000/svg')continue;if(/(?:https?|data|blob|file|javascript):/i.test(value))return false;if(/url\s*\(/i.test(value)&&!/^url\(\s*#[A-Za-z0-9_-]+\s*\)$/i.test(value))return false}}for(const style of svg.querySelectorAll('style'))style.remove();const styleRules=styleTexts.flatMap(text=>safeMermaidStylesheet(text,id)).concat(inlineRules);const shadow=host.shadowRoot||host.attachShadow({mode:'open'});shadow.replaceChildren();const stylesheet=document.createElement('style');stylesheet.nonce=mermaidStyleNonce;stylesheet.textContent=':host{display:block;max-width:100%}svg{display:block;max-width:none;height:auto}'+styleRules.join('');shadow.append(stylesheet,svg);return true}
function captureMermaidReadingPosition(){const scrollTop=window.scrollY;if(document.documentElement.scrollHeight-(scrollTop+window.innerHeight)<=160)return null;for(const node of document.querySelectorAll('.message')){const bounds=node.getBoundingClientRect();if(bounds.bottom>0)return{node,top:bounds.top,scrollTop}}return null}
function restoreMermaidReadingPosition(anchor){if(!anchor||!anchor.node.isConnected||Math.abs(window.scrollY-anchor.scrollTop)>2)return;const offset=anchor.node.getBoundingClientRect().top-anchor.top;if(Math.abs(offset)>1)window.scrollBy(0,offset)}
function failMermaidBlock(block){const notice=block.querySelector('.message-mermaid-error'),source=block.querySelector('.message-mermaid-source'),diagram=block.querySelector('.message-mermaid-diagram');if(notice)notice.hidden=false;if(source)source.open=true;if(diagram)diagram.hidden=true}
function renderMermaidBlocks(blocks){const generation=++mermaidGeneration,candidates=Array.from(blocks||[]);for(const block of candidates.slice(mermaidTranscriptLimit))failMermaidBlock(block);const selected=candidates.slice(0,mermaidTranscriptLimit);if(!selected.length)return;ensureMermaid().then(async mermaid=>{if(generation!==mermaidGeneration)return;for(let index=0;index<selected.length;index++){const block=selected[index];if(generation!==mermaidGeneration)return;if(!block.isConnected)continue;const sourceNode=block.querySelector('code.language-mermaid'),diagram=block.querySelector('.message-mermaid-diagram'),details=block.querySelector('.message-mermaid-source'),notice=block.querySelector('.message-mermaid-error');if(!sourceNode||!diagram||!details)continue;const source=sourceNode.textContent||'',id='msg-mermaid-'+generation+'-'+index;try{mermaid.initialize({startOnLoad:false,securityLevel:'strict',htmlLabels:false,suppressErrorRendering:true,maxTextSize:8192,maxEdges:100,logLevel:5,theme:document.documentElement.dataset.theme==='dark'?'dark':'default',fontFamily:'Arial, sans-serif',secure:['secure','securityLevel','startOnLoad','maxTextSize','suppressErrorRendering','maxEdges','logLevel','theme','themeVariables','htmlLabels','fontFamily','altFontFamily']});const result=await mermaid.render(id,source);if(generation!==mermaidGeneration||!block.isConnected)continue;const anchor=captureMermaidReadingPosition();if(!sanitizeMermaidSvg(diagram,result.svg,id))throw Error('unsafe renderer output');diagram.hidden=false;details.open=false;if(notice)notice.hidden=true;const content=block.closest('.message-content');if(content)collapse(content);requestAnimationFrame(()=>requestAnimationFrame(()=>{restoreMermaidReadingPosition(anchor);updateJump()}))}catch{if(generation===mermaidGeneration&&block.isConnected)failMermaidBlock(block)}}}).catch(()=>{if(generation===mermaidGeneration)selected.forEach(failMermaidBlock)})}
`;

const productionMermaidSvgSizing = String.raw`function preserveMermaidSvgSize(host,id){const shadow=host.shadowRoot,svg=shadow?.querySelector('svg'),stylesheet=shadow?.querySelector('style');if(!svg||!stylesheet)return false;const dimensions=(svg.getAttribute('viewBox')||'').trim().split(/[\s,]+/).map(Number);if(dimensions.length!==4||dimensions.some(value=>!Number.isFinite(value))||dimensions[2]<=0||dimensions[3]<=0||dimensions[2]>10000||dimensions[3]>10000)return false;const svgWidth=Math.ceil(dimensions[2]),svgHeight=Math.ceil(dimensions[3]),selector='#'+id,rootStyleIndex=svg.getAttribute('data-msg-style-index');let css=stylesheet.textContent||'';if(rootStyleIndex!==null)css=css.replaceAll(selector+' [data-msg-style-index="'+rootStyleIndex+'"]',selector+'[data-msg-style-index="'+rootStyleIndex+'"]');css=css.replaceAll(selector+' svg',selector);stylesheet.textContent=css+selector+'{width:'+svgWidth+'px!important;height:auto!important;max-width:none!important}';svg.setAttribute('width',String(svgWidth));svg.setAttribute('height',String(svgHeight));return true}`;

const productionBrowserClient = String.raw`
(()=>{const runtime={renderMarkdown,createLiveController,copyText,handleAgentPromptCopy};globalThis.__msgBrowserRuntime=runtime;if(typeof document==='undefined')return;const room=document.body.dataset.room,api=location.pathname,box=document.querySelector('#messages'),notice=document.querySelector('#state-notice'),status=document.querySelector('#connection-status'),reply=document.querySelector('#reply'),form=document.querySelector('#composer'),latest=document.querySelector('#scroll-to-latest'),intro=document.querySelector('#conversation-intro'),prompt=document.querySelector('#agent-prompt'),toast=document.querySelector('#toast');let sequence=0,loadGeneration=0,loaded=[],pending='',idempotencyKey='',terminal=false;const say=text=>{if(!toast)return;toast.textContent=text;toast.classList.add('show');clearTimeout(say.timer);say.timer=setTimeout(()=>toast.classList.remove('show'),1800)},setNotice=(text,kind='')=>{if(notice){notice.textContent=text;notice.className='state-notice '+kind;notice.hidden=!text}if(status)status.textContent=kind==='live'?'Live':kind==='connecting'?'Connecting':kind==='reconnecting'?'Reconnecting':kind==='terminal'?'Closed':'Unlisted'},time=value=>{const date=new Date(value);return Number.isNaN(+date)?'Unknown time':date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})},date=value=>{const parsed=new Date(value);return Number.isNaN(+parsed)?'Temporary conversation':parsed.toLocaleDateString(undefined,{day:'numeric',month:'long',year:'numeric'})};const agentPrompt='Visit '+location.href+' and follow the instructions. Read the recent messages and help me participate in this conversation.';if(prompt)prompt.value=agentPrompt;const openIntro=()=>{if(intro&&!intro.open)intro.showModal()},setTerminal=failure=>{terminal=true;live?.disconnect();pending='';idempotencyKey='';if(reply)reply.disabled=true;form?.querySelector('button[type="submit"]')?.setAttribute('disabled','');setNotice(failure.notice,'terminal');render()};function collapse(content){requestAnimationFrame(()=>{if(content.scrollHeight<=480)return;content.classList.add('is-collapsible');const card=document.createElement('div');card.className='message-collapse-card';card.innerHTML='<div><p class="message-collapse-title">This message is long</p><p class="message-collapse-description">The rest of this message is hidden until you expand it.</p></div><button class="message-expand" type="button" aria-expanded="false">Show full message</button>';const button=card.querySelector('button');button.onclick=()=>{const expanded=content.classList.toggle('is-expanded');button.textContent=expanded?'Show less':'Show full message';button.setAttribute('aria-expanded',String(expanded));card.querySelector('.message-collapse-description').textContent=expanded?'The full message is shown.':'The rest of this message is hidden until you expand it.'};content.after(card)})}function render(){if(!box)return;box.replaceChildren();const divider=document.querySelector('#date-divider');if(divider)divider.textContent=loaded[0]?date(loaded[0].created_at):'Temporary conversation';if(!loaded.length)box.innerHTML='<div class="empty-state">No messages yet. Start the conversation below.</div>';for(const message of loaded){const node=document.createElement('article');node.className='message '+(message.client?'agent':'');const initials=(message.display_name||message.author||'Anonymous').split(/\s+/).map(part=>part[0]).join('').slice(0,2).toUpperCase();node.innerHTML='<div class="avatar" aria-hidden="true"></div><div><div class="author"><strong></strong><small class="identity">Self-declared</small><time></time></div><div class="reply-reference" hidden></div><div class="message-body"><div class="message-content"></div></div></div>';node.querySelector('.avatar').textContent=initials;node.querySelector('strong').textContent=message.display_name||message.author||'Anonymous';node.querySelector('time').textContent=time(message.created_at);const reference=node.querySelector('.reply-reference');if(/^\d+$/.test(String(message.reply_to||''))){reference.hidden=false;reference.textContent='Replying to message '+message.reply_to}const content=node.querySelector('.message-content');content.innerHTML=renderMarkdown(message.content);collapse(content);box.append(node)}if(pending&&!terminal){const node=document.createElement('article');node.className='message';node.innerHTML='<div class="avatar" aria-hidden="true">YO</div><div><div class="author"><strong>You</strong><small class="identity">Pending</small></div><div class="message-body"></div><button class="button compact" type="button">Retry</button></div>';node.querySelector('.message-body').textContent=pending;node.querySelector('button').onclick=post;box.append(node)}}const live=room?createLiveController({createSocket:()=>{const url=new URL(api+'/live',location.origin);url.protocol=location.protocol==='https:'?'wss:':'ws:';url.searchParams.set('after',sequence);return new WebSocket(url)},isOnline:()=>navigator.onLine,onFrame:frame=>{if(frame.type==='message.created'){sequence=frame.latest_message||sequence;void load(false)}if(frame.type==='ready'&&frame.latest_message>sequence){sequence=frame.latest_message;void load(false)}if(frame.type==='conversation.expired')setTerminal({notice:'This conversation was deleted or expired.'})},onState:state=>setNotice('',state),schedule:(callback,delay)=>setTimeout(callback,delay),cancel:timer=>clearTimeout(timer)}):null;async function load(startLive=true,connectAfterLoad=false){if(!room)return;const generation=++loadGeneration;if(startLive)setNotice('','connecting');try{const response=await fetch(api,{headers:{accept:'application/json'}});if(!response.ok)throw {status:response.status};const data=await response.json();if(generation!==loadGeneration)return;sequence=data.latest_message||0;loaded=data.messages||[];render();const expiry=document.querySelector('#expiry');if(expiry&&data.expires_at)expiry.textContent='Deletes '+new Date(data.expires_at).toLocaleString();const created=document.querySelector('#room-created');if(created&&loaded[0])created.textContent=date(loaded[0].created_at);if(startLive||connectAfterLoad)live?.connect()}catch(cause){if(generation!==loadGeneration)return;const failure=browserFailureState(cause.status||0,navigator.onLine);if(failure.terminal)setTerminal(failure);else setNotice(failure.notice,'error')}}async function post(){if(terminal)return;if(!reply.value.trim()&&!pending){reply.focus();return}if(!navigator.onLine){pending=pending||reply.value.trim();render();setNotice('You are offline. Your reply will stay pending until you reconnect.','error');return}const content=pending||reply.value.trim();pending=content;idempotencyKey||=crypto.randomUUID();reply.value='';render();setNotice('Posting your reply…','connecting');try{const response=await fetch(api,{method:'POST',headers:{accept:'application/json','content-type':'application/json','idempotency-key':idempotencyKey},body:JSON.stringify({content,author:'Anonymous',display_name:'Anonymous',semantic_type:'message'})});if(!response.ok)throw {status:response.status};pending='';idempotencyKey='';await load(false);say('Reply posted')}catch(cause){const failure=browserFailureState(cause.status||0,navigator.onLine);if(failure.terminal)setTerminal(failure);else{setNotice(failure.notice,'error');render()}}}form?.addEventListener('submit',event=>{event.preventDefault();void post()});const storage={getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)},media=matchMedia('(prefers-color-scheme: dark)'),theme=createThemeController({storage,media,apply:choice=>{document.documentElement.dataset.theme=choice==='system'?(media.matches?'dark':'light'):choice;document.querySelectorAll('[data-theme-option]').forEach(control=>{const checked=control.dataset.themeOption===choice;control.setAttribute('aria-checked',String(checked));control.tabIndex=checked?0:-1})}});theme.start();document.querySelectorAll('[data-theme-option]').forEach(control=>{control.onclick=()=>theme.select(control.dataset.themeOption);control.onkeydown=event=>{const all=['light','dark','system'],current=all.findIndex(choice=>document.querySelector('[data-theme-option="'+choice+'"]').getAttribute('aria-checked')==='true');if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const next=all[(current+(event.key==='ArrowLeft'||event.key==='ArrowUp'?2:1))%3];theme.select(next);document.querySelector('[data-theme-option="'+next+'"]').focus()}});document.querySelectorAll('[data-open-agent-intro]').forEach(button=>button.onclick=openIntro);document.querySelectorAll('[data-close-agent-intro]').forEach(button=>button.onclick=()=>intro?.close());document.querySelectorAll('[data-copy-agent-prompt]').forEach(button=>button.onclick=()=>handleAgentPromptCopy({copyPrompt:()=>copyText(prompt?.value||'',{clipboard:globalThis.navigator?.clipboard,documentObject:document}),focusPrompt:()=>prompt?.focus(),isModalOpen:()=>intro?.open||false,openIntro,selectPrompt:()=>prompt?.select(),showToast:say}));document.querySelectorAll('[data-copy-link]').forEach(button=>button.onclick=()=>copyText(location.href,{clipboard:globalThis.navigator?.clipboard,documentObject:document}).then(()=>say('Link copied')).catch(()=>say('Copy is not available in this browser')));document.querySelectorAll('[data-download]').forEach(button=>button.onclick=async()=>{try{const response=await fetch(api+'/export.md');if(!response.ok)throw Error();const href=URL.createObjectURL(new Blob([await response.text()],{type:'text/markdown'})),anchor=document.createElement('a');anchor.href=href;anchor.download='0000-conversation.md';anchor.click();URL.revokeObjectURL(href);say('Markdown transcript downloaded')}catch{say('The transcript could not be downloaded')}});if(room){void load()}else document.querySelector('#create-room')?.addEventListener('submit',async event=>{event.preventDefault();const field=document.querySelector('#initial-message');if(!field.value.trim()){field.focus();return}setNotice('Creating conversation…');try{const response=await fetch('/',{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:JSON.stringify({content:field.value,author:'Anonymous',display_name:'Anonymous',semantic_type:'message'})});if(!response.ok)throw Error();location.assign((await response.json()).conversation_url)}catch{setNotice('The relay is temporarily unavailable. Try again.','error')}});const updateJump=()=>{if(latest)latest.hidden=document.documentElement.scrollHeight-(scrollY+innerHeight)<=160};addEventListener('scroll',updateJump,{passive:true});addEventListener('resize',updateJump);if(latest)latest.onclick=()=>scrollTo({top:document.documentElement.scrollHeight,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});addEventListener('offline',()=>setNotice('You are offline. Your reply will stay pending until you reconnect.','error'));addEventListener('online',()=>{if(pending)void post();else void load(false,true)});updateJump()})();
`;

const styles = String.raw`
:root{color-scheme:light;--canvas:#fbfcfe;--surface:#fff;--soft:#f6f8fb;--blue:#eff6ff;--ink:#172033;--muted:#667085;--muted-strong:#475467;--line:#e3e8ef;--line-strong:#d0d7e2;--accent:#155eef;--accent-hover:#004eeb;--accent-line:#cfe0ff;--focus:rgb(21 94 239 / 28%);--shadow:0 12px 32px rgb(15 23 42 / 10%);--rail:#fcfdff;--message:#273246;--code:#182230}:root[data-theme=dark]{color-scheme:dark;--canvas:#101828;--surface:#182230;--soft:#202b3c;--blue:#17345f;--ink:#f2f4f7;--muted:#98a2b3;--muted-strong:#cbd5e1;--line:#344054;--line-strong:#475467;--accent-line:#356fbd;--rail:#202b3c;--message:#e4e7ec;--code:#111d2e}*{box-sizing:border-box}html{scroll-behavior:smooth}body{min-width:320px;min-height:100vh;margin:0;background:var(--canvas);color:var(--ink);font:15px/1.5 Inter,ui-sans-serif,system-ui,sans-serif}button,textarea{font:inherit}button{color:inherit}.shell{width:min(100%,1440px);min-height:100vh;margin:auto;background:var(--surface)}.topbar{position:sticky;top:0;z-index:20;border-bottom:1px solid var(--line);background:var(--surface)}.topbar-grid,.page-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(407px,410px)}.topbar-grid{min-height:96px}.header-main{display:flex;align-items:center;justify-content:space-between;gap:24px;min-width:0;padding:20px 32px}.brand{margin:0 0 2px;font-family:ui-monospace,monospace;font-size:13px;font-weight:800;letter-spacing:.18em}h1{margin:0;overflow:hidden;font-size:25px;line-height:1.2;text-overflow:ellipsis;white-space:nowrap}.header-actions,.composer-actions,.intro-actions{display:flex;gap:8px}.header-rail{display:flex;align-items:center;padding:20px 30px;border-left:1px solid var(--line)}.status-badge,.identity{display:inline-flex;align-items:center;min-height:24px;padding:3px 8px;border-radius:6px;background:var(--soft);color:var(--muted-strong);font-size:11px;font-weight:700}.status-badge{background:var(--blue);color:var(--accent);font-size:13px}.page-grid{grid-template-areas:"conversation rail";align-items:start}.conversation-pane{grid-area:conversation;min-width:0;padding:0 30px 24px}.room-rail{position:sticky;top:96px;grid-area:rail;min-height:calc(100vh - 96px);padding:26px 30px 36px;border-left:1px solid var(--line);background:var(--rail)}.rail-section{padding:0 0 24px;border-bottom:1px solid var(--line)}.rail-section+.rail-section{padding-top:24px}.rail-section:last-child{border:0}.rail-title{margin:0 0 9px;font-size:15px}.rail-copy{margin:0;color:var(--muted-strong);font-size:13px}.rail-copy+.rail-copy{margin-top:8px}.expiry{display:flex;align-items:center;gap:8px;margin:0 0 7px;color:var(--muted-strong);font-size:13px}.icon{width:17px;height:17px;flex:none}.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:8px 14px;border:1px solid var(--line-strong);border-radius:7px;background:var(--surface);cursor:pointer;font-size:13px;font-weight:650}.button.primary{border-color:var(--accent);background:var(--accent);color:#fff}.button.full{width:100%}.button.compact{min-height:34px;padding:6px 11px}.rail-actions{display:grid;gap:9px}.rail-actions .button{justify-content:flex-start;width:100%}.theme-switcher{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:3px;padding:3px;border:1px solid var(--line);border-radius:8px;background:var(--soft)}.theme-option{min-height:36px;border:0;border-radius:6px;background:transparent;color:var(--muted-strong);cursor:pointer;font-size:12px;font-weight:650}.theme-option[aria-checked=true]{background:var(--surface);color:var(--accent)}.date-rule{display:flex;align-items:center;gap:18px;margin:26px 0 10px;color:var(--muted-strong);font-size:12px;font-weight:700;text-transform:uppercase}.date-rule:before,.date-rule:after{height:1px;flex:1;background:var(--line);content:""}.message{display:grid;grid-template-columns:46px minmax(0,1fr);gap:18px;padding:17px 0;border-bottom:1px solid var(--line)}.avatar{display:grid;width:44px;height:44px;place-items:center;border:1px solid var(--line);border-radius:50%;background:var(--soft);font-size:14px;font-weight:700}.message.agent .avatar{border-color:var(--accent-line);background:var(--blue);color:var(--accent)}.author{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-bottom:8px;font-size:13px}.author time{flex-basis:100%;color:var(--muted);font-size:12px}.message-body{color:var(--message)}.message-content p{margin:0 0 10px}.message-content h1,.message-content h2,.message-content h3{margin:16px 0 8px;color:var(--ink)}.message-content a{color:var(--accent)}.message-content code{padding:2px 5px;border-radius:4px;background:var(--soft);font-family:ui-monospace,monospace;font-size:.86em}.message-content pre{overflow-x:auto;margin:11px 0;padding:14px 16px;border:1px solid var(--line-strong);border-radius:8px;background:var(--code);color:#e6edf7;font-size:13px}.message-content ul,.message-content ol{padding-left:24px}.message-content blockquote{margin:14px 0;padding:10px 12px;border-left:3px solid var(--accent-line);background:var(--soft);color:var(--muted-strong)}.message-content.is-collapsible:not(.is-expanded){max-height:280px;overflow:hidden}.message-collapse-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;margin-top:10px;padding:11px 16px;border:1px solid var(--line);border-radius:8px;background:var(--soft)}.message-collapse-title,.message-collapse-description{margin:0;font-size:12px}.message-collapse-description{color:var(--muted)}.message-expand{padding:8px 11px;border:1px solid var(--accent-line);border-radius:7px;background:var(--blue);color:var(--accent);cursor:pointer;font-size:12px;font-weight:700}.composer-wrap{position:sticky;bottom:0;z-index:8;padding:6px 0 4px;background:linear-gradient(to bottom,transparent,var(--surface) 22%)}.composer{overflow:hidden;border:1px solid var(--line-strong);border-radius:12px;background:var(--surface);box-shadow:var(--shadow)}.composer textarea{display:block;width:100%;min-height:40px;height:40px;padding:8px 16px;resize:vertical;border:0;outline:0;background:transparent;color:var(--ink)}.composer-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:7px 10px 7px 16px;border-top:1px solid var(--line)}.composer-note{color:var(--muted);font-size:12px}.scroll-to-latest{position:fixed;right:436px;bottom:154px;z-index:12;min-height:40px;padding:8px 13px;border:1px solid var(--line-strong);border-radius:8px;background:var(--surface);box-shadow:var(--shadow);cursor:pointer}.state-notice,.empty-state{margin:8px 0;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--soft);color:var(--muted-strong)}.state-notice.live{display:none}.reply-reference{width:fit-content;margin:0 0 10px;padding:5px 9px;border-radius:6px;background:var(--soft);color:var(--muted-strong);font-size:12px}.home{width:min(100%,720px);margin:0 auto;padding:72px 30px}.home h1{white-space:normal;font-size:34px}.home .rail-copy{margin-top:14px;font-size:16px}.home .composer{margin-top:28px}.home .composer textarea{height:140px}.room-facts{display:grid;gap:10px;margin:0;font-size:12px}.room-facts div{display:flex;justify-content:space-between;gap:14px}.room-facts dt{color:var(--muted)}.room-facts dd{margin:0;color:var(--muted-strong);text-align:right}.mobile-room-details{display:none}dialog{width:min(calc(100% - 28px),580px);padding:0;border:1px solid var(--line-strong);border-radius:14px;background:var(--surface);color:var(--ink)}.intro-header{padding:26px 28px 18px;border-bottom:1px solid var(--line)}.intro-body{padding:22px 28px 28px}.agent-prompt{width:100%;min-height:112px;padding:12px;resize:none;border:1px solid var(--line-strong);border-radius:8px;background:var(--soft);color:var(--ink)}.intro-actions{justify-content:flex-end;margin-top:14px}.toast{position:fixed;right:22px;bottom:22px;z-index:40;max-width:calc(100% - 44px);padding:10px 14px;border-radius:8px;background:#172033;color:#fff;opacity:0;pointer-events:none}.toast.show{opacity:1}@media(max-width:760px){.topbar{position:static}.topbar-grid{display:block;min-height:0}.header-main{align-items:flex-start;padding:17px 18px}.header-actions,.header-rail{display:none}h1{font-size:21px;white-space:normal}.page-grid{grid-template-areas:"conversation" "rail";grid-template-columns:minmax(0,1fr)}.conversation-pane{padding:0 18px 110px}.room-rail{position:static;min-height:0;margin-top:0;padding:18px;border-left:0;background:var(--soft)}.room-rail .rail-section:not(:has(.primary)):not(:has(.theme-switcher)){display:none}.mobile-room-details{display:block}.message{grid-template-columns:38px minmax(0,1fr);gap:12px;padding:22px 0}.avatar{width:38px;height:38px}.composer-wrap{padding-top:12px;padding-bottom:env(safe-area-inset-bottom)}.composer textarea{min-height:88px}.composer-row{align-items:flex-end}.composer-row .button{min-height:44px}.scroll-to-latest{right:16px;bottom:170px;min-height:44px}.intro-actions{flex-direction:column-reverse}.intro-actions .button{width:100%;min-height:44px}.home{padding:52px 18px}}@media(max-width:420px){.composer-note{display:none}.composer-row{justify-content:flex-end;gap:0}.composer-actions{min-width:0;flex-wrap:nowrap}.composer-actions .button{min-height:44px;white-space:nowrap;padding-inline:8px}.room-rail{padding:12px 18px}.theme-option{font-size:10px}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important}}
`;

const mobileLayoutContract = String.raw`.intro-eyebrow{margin:0 0 8px;color:var(--accent);font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.intro-facts{margin:0 0 22px;padding-left:20px;color:var(--muted-strong);font-size:13px}.intro-facts li{margin:7px 0}.prompt-label{display:block;margin-bottom:7px;font-size:12px;font-weight:700}.identity{text-transform:uppercase;letter-spacing:.08em}.date-rule{letter-spacing:.08em}.room-rail,.room-facts div,.room-facts dd{min-width:0}.room-facts dd{overflow-wrap:anywhere}.agent-home-guide{margin-top:32px;padding:22px;border:1px solid var(--accent-line);border-radius:12px;background:var(--blue)}.agent-home-guide h2{margin:0 0 8px;font-size:18px}.agent-home-guide p{margin:8px 0;color:var(--muted-strong);font-size:13px}.agent-home-guide pre{overflow-x:auto;margin:14px 0;padding:14px;border-radius:8px;background:var(--code);color:#e6edf7;font:12px/1.55 ui-monospace,monospace}.agent-home-links{display:flex;flex-wrap:wrap;gap:14px;margin-top:12px}.agent-home-links a{color:var(--accent);font-size:13px;font-weight:700}@media(max-width:760px){html{scroll-padding-bottom:150px}.topbar{position:sticky;top:0}.topbar-grid{display:grid;grid-template-columns:minmax(0,1fr) auto;min-height:0}.header-main{min-width:0;padding:12px 16px}.header-main>div{min-width:0}.header-main .brand{font-size:10px}.header-actions{display:none}.header-rail{display:flex;padding:12px 16px 12px 0;border-left:0}h1{overflow:hidden;font-size:19px;white-space:nowrap}.page-grid{grid-template-areas:"rail" "conversation"}.room-rail{position:static;min-height:0;padding:0 16px;border-bottom:1px solid var(--line);background:var(--surface)}.room-rail>.rail-section,.room-rail>.room-facts{display:none!important}.mobile-room-details{display:block}.mobile-room-details summary{display:flex;min-height:44px;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;color:var(--muted-strong);font-size:13px;font-weight:700;list-style:none}.mobile-room-details summary::-webkit-details-marker{display:none}.mobile-room-details summary:after{content:"+";font-size:18px;font-weight:400}.mobile-room-details[open] summary:after{content:"−"}.mobile-details-body{padding:4px 0 18px}.mobile-details-section{padding:16px 0;border-top:1px solid var(--line)}.mobile-details-section:first-child{border-top:0}.mobile-details-section .rail-title{font-size:14px}.mobile-details-section .button{min-height:44px}.conversation-pane{padding:0 16px calc(12px + env(safe-area-inset-bottom))}.message{grid-template-columns:36px minmax(0,1fr);gap:11px;padding:18px 0}.avatar{width:36px;height:36px}.message-content{overflow-wrap:anywhere}.message-content pre{max-width:100%;overflow-x:auto}.composer-wrap{bottom:env(safe-area-inset-bottom);padding:12px 0 0}.composer textarea{min-height:76px}.composer-row{align-items:flex-end}.composer-row .button{min-height:44px}.scroll-to-latest{right:16px;bottom:calc(132px + env(safe-area-inset-bottom));min-height:44px}.intro-actions{flex-direction:column-reverse}.intro-actions .button{width:100%;min-height:44px}dialog{max-height:calc(100dvh - 24px);overflow:auto}.intro-header{padding:20px 20px 16px}.intro-body{padding:18px 20px calc(20px + env(safe-area-inset-bottom))}.home{padding:44px 16px}.home h1{font-size:28px}.agent-home-guide{padding:18px}.agent-home-guide pre{white-space:pre-wrap;overflow-wrap:anywhere}}@media(max-width:360px){.composer-actions{display:grid;grid-template-columns:1fr 1fr;width:100%}.composer-actions .button{min-height:44px;white-space:normal;padding-inline:7px}.composer-note{display:none}.composer-row{display:block;padding:8px}.theme-option{font-size:10px}}`;

const humanBannerStyles = String.raw`.view-banner{display:flex;align-items:center;justify-content:space-between;gap:16px;width:min(calc(100% - 32px),1380px);margin:16px auto;padding:14px 18px;border:1px solid var(--accent-line);border-radius:10px;background:var(--blue)}.view-banner>div{display:grid;gap:3px;min-width:0}.view-banner strong{font-size:13px}.view-banner span{color:var(--muted-strong);font-size:12px}.view-banner a:focus-visible{outline:3px solid var(--focus);outline-offset:3px}@media (max-width: 760px){.view-banner{align-items:stretch;flex-direction:column;gap:10px;width:calc(100% - 24px);margin:12px auto;padding:12px 14px}.view-banner .button{width:100%}}`;

const mobileComposerContract = String.raw`@media(max-width:760px){.shell{--mobile-composer-clearance:140px}.conversation-pane{padding:0 16px calc(var(--mobile-composer-clearance) + env(safe-area-inset-bottom))}.composer-wrap{position:fixed;right:16px;bottom:env(safe-area-inset-bottom);left:16px;z-index:18;padding:12px 0 8px}.scroll-to-latest{bottom:calc(var(--mobile-composer-clearance) + 12px + env(safe-area-inset-bottom))}.mobile-room-details[open] summary:after{content:"-"}.shell:has(.mobile-room-details[open]) .composer-wrap,.shell:has(.mobile-room-details[open]) .scroll-to-latest{display:none}}@media(max-width:360px){.shell{--mobile-composer-clearance:176px}}`;

export function browserAsset(name: string): Response | undefined {
  if (name === "client.css") {
    const responsiveStyles = `${styles}${humanBannerStyles}${mobileLayoutContract}${mobileComposerContract}${mermaidStyles}${notificationPanelStyles}${coordinationPanelStyles}${coordinationControlStyles}`.replaceAll("@media(max-width:760px)", "@media(max-width:820px)").replace(".intro-eyebrow{", ".agent-join-notice{display:flex;flex-wrap:wrap;gap:6px 10px;margin:18px 0 2px;padding:12px 14px;border:1px solid var(--accent-line);border-radius:8px;background:var(--blue);color:var(--muted-strong);font-size:13px}.agent-join-notice strong{color:var(--ink)}.agent-join-notice code{overflow-wrap:anywhere;font:12px/1.4 ui-monospace,monospace}.intro-eyebrow{").replace(".author{", ".message-citation{margin-left:auto;color:var(--accent);font-size:11px}.author{");
    return new Response(responsiveStyles, { headers: { "content-type": "text/css; charset=utf-8" } });
  }
  if (name !== "client.js") return undefined;
  const nameHelper = 'const __name=(target,value)=>Object.defineProperty(target,"name",{value,configurable:true});';
  const coordinationHelpers = `globalThis.__msgCoordinationHelpers=(${createCoordinationBrowserHelpers.toString()})();`;
  const helpers = `const MERMAID_MAX_BLOCKS_PER_MESSAGE=${MERMAID_MAX_BLOCKS_PER_MESSAGE},MERMAID_MAX_SOURCE_BYTES=${MERMAID_MAX_SOURCE_BYTES},MERMAID_MAX_TOTAL_SOURCE_BYTES=${MERMAID_MAX_TOTAL_SOURCE_BYTES},MERMAID_MAX_LINES=${MERMAID_MAX_LINES},PUSH_BROWSER_ID_STORAGE_KEY="0000:push-browser-id:v1";`
    + [escapeHtml, safeLink, renderInlineMarkdown, startsMarkdownBlock, supportsMermaidSource, renderMermaidBlock, renderMarkdown, createLiveController, browserFailureState, createThemeController, copyText, createWebhookPanelController, createPushEnrollmentController, readPushBrowserId, handleAgentPromptCopy].map((fn) => `const ${fn.name}=${fn.toString()};`).join("");
  const client = productionBrowserClient
    .replace("if(typeof document==='undefined')return;", `if(typeof document==='undefined')return;${productionMermaidRuntime}${productionMermaidSvgSizing}`)
    .replace("if(!sanitizeMermaidSvg(diagram,result.svg,id))throw Error('unsafe renderer output');", "if(!sanitizeMermaidSvg(diagram,result.svg,id)||!preserveMermaidSvgSize(diagram,id))throw Error('unsafe renderer output');")
    .replace("if(content.scrollHeight<=480)return;content.classList.add('is-collapsible');const card=document.createElement('div');", "const existing=content.nextElementSibling;if(content.scrollHeight<=480){content.classList.remove('is-collapsible','is-expanded');if(existing?.classList.contains('message-collapse-card'))existing.remove();return}content.classList.add('is-collapsible');if(existing?.classList.contains('message-collapse-card'))return;const card=document.createElement('div');")
    .replace("box.append(node)}}const live=", "box.append(node)}if(box.querySelectorAll)renderMermaidBlocks(box.querySelectorAll('[data-mermaid-block]'))}const live=")
    .replace("node.querySelector('time').textContent=time(message.created_at);", "node.querySelector('time').textContent=time(message.created_at);const citation=document.createElement('a');citation.className='message-citation';citation.textContent='Stored ID '+message.id;citation.href=new URL(api+'/messages/'+encodeURIComponent(message.id),location.origin).toString();node.querySelector('.author').append(citation);")
    .replace("if(/^\\d+$/.test(String(message.reply_to||''))){reference.hidden=false;reference.textContent='Replying to message '+message.reply_to}", "if(/^[1-9][0-9]*$/.test(String(message.reply_to||''))&&Number.isSafeInteger(Number(message.reply_to))){reference.hidden=false;const replyUrl=new URL(api,location.origin);replyUrl.search='';replyUrl.searchParams.set('after',String(Number(message.reply_to)-1));replyUrl.searchParams.set('through',String(message.reply_to));replyUrl.searchParams.set('limit','1');replyUrl.searchParams.set('view','agent');const replyLink=document.createElement('a');replyLink.href=replyUrl.toString();replyLink.textContent='Replying to message '+message.reply_to;reference.replaceChildren(replyLink)}else if(message.reply_to){reference.hidden=false;reference.textContent='Reply reference '+message.reply_to+' (legacy reference may be unresolved)'}")
    .replace("document.documentElement.dataset.theme=choice==='system'?(media.matches?'dark':'light'):choice;document.querySelectorAll('[data-theme-option]')", "document.documentElement.dataset.theme=choice==='system'?(media.matches?'dark':'light'):choice;renderMermaidBlocks(box?.querySelectorAll?box.querySelectorAll('[data-mermaid-block]'):[]);document.querySelectorAll('[data-theme-option]')")
    .replace("const agentPrompt='Visit '+location.href+' and follow the instructions. Read the recent messages and help me participate in this conversation.';if(prompt)prompt.value=agentPrompt;", "let agentPrompt='',agentPromptReady=false;")
    .replace("sequence=data.latest_message||0;loaded=data.messages||[];render();", "sequence=data.latest_message||0;loaded=data.messages||[];if(typeof data.share_message==='string'&&data.share_message.trim()){agentPrompt=data.share_message;agentPromptReady=true;if(prompt)prompt.value=agentPrompt;}render();")
    .replace("document.querySelectorAll('[data-copy-agent-prompt]').forEach(button=>button.onclick=()=>handleAgentPromptCopy({", "document.querySelectorAll('[data-copy-agent-prompt]').forEach(button=>button.onclick=()=>agentPromptReady?handleAgentPromptCopy({")
    .replace(",showToast:say}));document.querySelectorAll('[data-copy-link]'", ",showToast:say}):say('Agent invitation is still loading.'));document.querySelectorAll('[data-copy-link]'")
    .replace("const expiry=document.querySelector('#expiry');if(expiry&&data.expires_at)expiry.textContent='Deletes '+new Date(data.expires_at).toLocaleString();", "const expiryText=data.expires_at?'Expires '+new Date(data.expires_at).toLocaleString():'';const expiry=document.querySelector('#expiry');if(expiry&&expiryText)expiry.textContent=expiryText;document.querySelectorAll('.js-expiry time').forEach(node=>node.textContent=expiryText);const retention=data.retention&&typeof data.retention==='object'?data.retention:null;const retentionText=retention&&typeof retention.inactivity_window_ms==='number'?'Temporary room · '+retention.inactivity_window_ms+' ms inactivity window · '+String(retention.policy||'configured policy')+'. Normal posts reset it; owners may explicitly extend within private bounds.':'';document.querySelectorAll('.js-retention').forEach(node=>node.textContent=retentionText);")
    .replace("const created=document.querySelector('#room-created');if(created&&loaded[0])created.textContent=date(loaded[0].created_at);", "const createdText=loaded[0]?date(loaded[0].created_at):'';const created=document.querySelector('#room-created');if(created&&createdText)created.textContent=createdText;document.querySelectorAll('.js-room-created').forEach(node=>node.textContent=createdText);")
    .replace("location.assign((await response.json()).conversation_url)", "const created=await response.json(),ownerUrl=created.manage_url,ownerRoom=created.room?.id;if(ownerUrl&&ownerRoom&&globalThis.__msgCoordinationHelpers){try{const retained=globalThis.__msgCoordinationHelpers.retain(ownerUrl,location.origin,ownerRoom,{getItem:key=>sessionStorage.getItem(key),setItem:(key,value)=>sessionStorage.setItem(key,value)});if(!retained.retained&&retained.saveUrl){const save=document.querySelector('#state-notice');if(save){save.hidden=false;save.textContent=retained.message;const privateLink=document.createElement('a');privateLink.href=retained.saveUrl;privateLink.textContent=' Save this private owner access URL';privateLink.target='_blank';privateLink.rel='noreferrer';save.append(privateLink);return}}}catch{const save=document.querySelector('#state-notice');if(save){save.hidden=false;save.textContent='Save the private owner access URL before leaving this page.';return}}}location.assign(created.conversation_url)")
    .replace("headers:{accept:'application/json','content-type':'application/json','idempotency-key':idempotencyKey},body:JSON.stringify({content,author:'Anonymous',display_name:'Anonymous',semantic_type:'message'})", "headers:(()=>{const headers=new Headers({accept:'application/json','content-type':'application/json','idempotency-key':idempotencyKey});const browserId=readPushBrowserId({getItem:key=>localStorage.getItem(key)});if(browserId)headers.set('x-msg-browser-id',browserId);return headers})(),body:JSON.stringify({content,author:'Anonymous',display_name:'Anonymous',semantic_type:'message'})");
  return new Response(`${nameHelper}${helpers}${coordinationHelpers}${client};(${bootWebhookPanel.toString()})();(${bootPushPanel.toString()})();(${bootCoordinationBrowser.toString()})();`, { headers: { "content-type": "text/javascript; charset=utf-8" } });
}

interface BrowserPanelTarget {
  closest<T extends BrowserPanelElement>(selector: string): T | null;
}

interface BrowserPanelEvent {
  preventDefault(): void;
  readonly target: BrowserPanelTarget | null;
}

interface BrowserPanelElement {
  addEventListener(type: string, listener: (event: BrowserPanelEvent) => void): void;
  append(...nodes: BrowserPanelElement[]): void;
  className: string;
  close(): void;
  dataset: Record<string, string>;
  disabled: boolean;
  hidden: boolean;
  querySelector<T extends BrowserPanelElement>(selector: string): T | null;
  querySelectorAll<T extends BrowserPanelElement>(selector: string): Iterable<T>;
  reset(): void;
  replaceChildren(...nodes: BrowserPanelElement[]): void;
  showModal(): void;
  textContent: string | null;
  value: string;
}

interface BrowserPanelDocument {
  readonly body?: { readonly dataset?: Record<string, string> };
  createElement(tagName: string): BrowserPanelElement;
  querySelector<T extends BrowserPanelElement>(selector: string): T | null;
  querySelectorAll<T extends BrowserPanelElement>(selector: string): Iterable<T>;
}

interface BrowserPushEnvironment {
  readonly Notification?: { readonly permission: string; requestPermission(): Promise<string> };
  readonly document?: BrowserPanelDocument;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  readonly navigator?: {
    readonly serviceWorker?: {
      readonly ready: Promise<{ readonly pushManager?: { getSubscription(): Promise<{ readonly endpoint: string; toJSON(): unknown } | null>; subscribe(options: { readonly applicationServerKey: ArrayBuffer; readonly userVisibleOnly: true }): Promise<{ readonly endpoint: string; toJSON(): unknown }> }; readonly scope?: string }>;
      register(scriptUrl: string, options: { readonly scope: string }): Promise<{ readonly pushManager?: { getSubscription(): Promise<{ readonly endpoint: string; toJSON(): unknown } | null>; subscribe(options: { readonly applicationServerKey: ArrayBuffer; readonly userVisibleOnly: true }): Promise<{ readonly endpoint: string; toJSON(): unknown }> }; readonly scope?: string }>;
    };
  };
}

function bootWebhookPanel(): void {
  const pageDocument = (globalThis as unknown as { document?: BrowserPanelDocument }).document;
  if (!pageDocument || typeof pageDocument.querySelector !== "function") return;
  const document = pageDocument;
  const room = document.body?.dataset?.room;
  if (!room) return;
  const dialog = document.querySelector<BrowserPanelElement>("#notifications-panel");
  const form = document.querySelector<BrowserPanelElement>("#webhook-create-form");
  const urlInput = document.querySelector<BrowserPanelElement>("#webhook-url");
  const createButton = form?.querySelector<BrowserPanelElement>('button[type="submit"]');
  const list = document.querySelector<BrowserPanelElement>("#webhook-list");
  const empty = document.querySelector<BrowserPanelElement>("#webhook-empty");
  const status = document.querySelector<BrowserPanelElement>("#webhook-status");
  const secretPanel = document.querySelector<BrowserPanelElement>("#webhook-secret");
  const secretValue = document.querySelector<BrowserPanelElement>("#webhook-secret-value");
  if (!dialog || !form || !urlInput || !createButton || !list || !empty || !status || !secretPanel || !secretValue) return;

  let endpoints: readonly WebhookPanelEntry[] = [];
  const announce = (message: string) => { status.textContent = message; };
  let busy = false;
  const updateButtons = (nextBusy: boolean) => {
    busy = nextBusy;
    createButton.disabled = busy || endpoints.length >= 5;
    for (const selector of ["[data-webhook-remove]", "[data-webhook-disable]", "[data-webhook-enable]", "[data-webhook-rotate]", "[data-webhook-redeliver-event]"]) {
      for (const button of dialog.querySelectorAll<BrowserPanelElement>(selector)) button.disabled = busy;
    }
  };
  const renderEndpoints = (next: readonly WebhookPanelEntry[]) => {
    endpoints = next;
    list.replaceChildren();
    empty.hidden = next.length > 0;
    for (const endpoint of next) {
      const item = document.createElement("li");
      item.className = "webhook-list-item";
      const address = document.createElement("strong");
      address.textContent = endpoint.url;
      const metadata = document.createElement("p");
      metadata.className = "webhook-list-meta";
      const date = (value: string | null) => value ? new Date(value).toLocaleString() : "never";
      const health = [
        `State: ${endpoint.status}`,
        `Last success: ${date(endpoint.last_success_at)}`,
        `Last failure: ${date(endpoint.last_failure_at)}`,
        `Recovery: ${date(endpoint.recovered_at)}`,
        ...(endpoint.failure_started_at ? [`Continuous failure since ${date(endpoint.failure_started_at)}`] : []),
        ...(endpoint.disabled_at ? [`Disabled: ${date(endpoint.disabled_at)}`] : []),
      ];
      metadata.textContent = health.join(" · ");
      item.append(address, metadata);
      if (endpoint.deliveries.length === 0) {
        const emptyDelivery = document.createElement("p");
        emptyDelivery.className = "webhook-list-meta";
        emptyDelivery.textContent = "No delivery attempts yet.";
        item.append(emptyDelivery);
      }
      for (const delivery of endpoint.deliveries) {
        const deliverySection = document.createElement("div");
        deliverySection.className = "webhook-delivery";
        const details = document.createElement("p");
        details.className = "webhook-list-meta";
        details.textContent = `Event ${delivery.event_id} · message #${delivery.message_sequence} · ${delivery.status} · ${delivery.attempt_count} attempt${delivery.attempt_count === 1 ? "" : "s"} · next retry: ${date(delivery.next_attempt_at)} · original retry deadline: ${date(delivery.retry_expires_at)}${delivery.failure_category ? ` · ${delivery.failure_category}` : ""}${delivery.cancelled_at ? ` · cancelled: ${date(delivery.cancelled_at)}` : ""}`;
        deliverySection.append(details);
        if (delivery.attempts.length > 0) {
          const attemptHistory = document.createElement("p");
          attemptHistory.className = "webhook-list-meta";
          attemptHistory.textContent = `Attempt history: ${delivery.attempts.map((attempt) => `#${attempt.attempt_number} ${attempt.status} at ${date(attempt.attempted_at)}${attempt.failure_category ? ` (${attempt.failure_category})` : ""}`).join("; ")}`;
          deliverySection.append(attemptHistory);
        }
        if (delivery.status === "failed") {
          const redeliverActions = document.createElement("div");
          redeliverActions.className = "webhook-list-actions";
          const redeliver = document.createElement("button");
          redeliver.className = "button compact";
          redeliver.dataset.webhookRedeliverEndpoint = endpoint.id;
          redeliver.dataset.webhookRedeliverEvent = delivery.event_id;
          redeliver.textContent = "Redeliver this event once";
          redeliverActions.append(redeliver);
          deliverySection.append(redeliverActions);
        }
        item.append(deliverySection);
      }
      const actions = document.createElement("div");
      actions.className = "webhook-list-actions";
      const toggle = document.createElement("button");
      toggle.className = "button compact";
      if (endpoint.status === "disabled") {
        toggle.dataset.webhookEnable = endpoint.id;
        toggle.textContent = "Re-enable";
      } else {
        toggle.dataset.webhookDisable = endpoint.id;
        toggle.textContent = "Disable";
      }
      const rotate = document.createElement("button");
      rotate.className = "button compact";
      rotate.dataset.webhookRotate = endpoint.id;
      rotate.textContent = "Rotate secret";
      const remove = document.createElement("button");
      remove.className = "button compact";
      remove.dataset.webhookRemove = endpoint.id;
      remove.textContent = "Remove endpoint";
      actions.append(toggle, rotate, remove);
      item.append(actions);
      list.append(item);
    }
    updateButtons(false);
  };

  const controller = createWebhookPanelController({
    endpoint: `/${encodeURIComponent(room)}/webhooks`,
    fetch: (input, init) => fetch(input, init),
    onBusyChange: updateButtons,
    onEntries: renderEndpoints,
    onSecret: (secret, operation) => {
      secretValue.textContent = secret;
      secretPanel.hidden = false;
      announce(operation === "rotated"
        ? "Webhook secret rotated. Save this signing secret now; it will not be shown again."
        : "Webhook created. Save this signing secret now; it will not be shown again.");
    },
  });

  const showError = (error: unknown) => announce(error instanceof Error ? error.message : "The webhook request failed.");
  for (const button of document.querySelectorAll<BrowserPanelElement>("[data-notifications-open]")) {
    button.addEventListener("click", () => {
      dialog.showModal();
      announce("Loading room webhooks…");
      void controller.list().then(() => announce("Room webhooks loaded.")).catch(showError);
    });
  }
  for (const button of dialog.querySelectorAll<BrowserPanelElement>("[data-notifications-close]")) {
    button.addEventListener("click", () => dialog.close());
  }
  dialog.addEventListener("close", () => {
    secretValue.textContent = "";
    secretPanel.hidden = true;
    announce("");
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    announce("");
    void controller.create(urlInput.value.trim()).then(() => {
      form.reset();
      announce("Webhook created. Save this signing secret now; it will not be shown again.");
    }).catch(showError);
  });
  list.addEventListener("click", (event) => {
    const target = event.target as BrowserPanelTarget | null;
    const redeliverButton = target?.closest<BrowserPanelElement>("[data-webhook-redeliver-event]");
    const redeliverEndpoint = redeliverButton?.dataset.webhookRedeliverEndpoint;
    const eventId = redeliverButton?.dataset.webhookRedeliverEvent;
    if (redeliverEndpoint && eventId) {
      announce("");
      void controller.redeliver(redeliverEndpoint, eventId).then((result) => {
        if (result === "queued") announce("One redelivery attempt was queued. A failed attempt will need another explicit request.");
        else if (result === "already_queued") announce("A redelivery attempt for this event is already queued or sending.");
      }).catch(showError);
      return;
    }
    const removeButton = target?.closest<BrowserPanelElement>("[data-webhook-remove]");
    const removeId = removeButton?.dataset.webhookRemove;
    if (removeId) {
      announce("");
      void controller.remove(removeId).then(() => announce("Webhook removed.")).catch(showError);
      return;
    }
    const disableId = target?.closest<BrowserPanelElement>("[data-webhook-disable]")?.dataset.webhookDisable;
    if (disableId) {
      announce("");
      void controller.disable(disableId).then(() => announce("Webhook disabled. Pending automatic deliveries were cancelled.")).catch(showError);
      return;
    }
    const enableId = target?.closest<BrowserPanelElement>("[data-webhook-enable]")?.dataset.webhookEnable;
    if (enableId) {
      announce("");
      void controller.enable(enableId).then(() => announce("Webhook re-enabled for new messages. No backlog was replayed.")).catch(showError);
      return;
    }
    const rotateId = target?.closest<BrowserPanelElement>("[data-webhook-rotate]")?.dataset.webhookRotate;
    if (rotateId) {
      announce("");
      void controller.rotate(rotateId).then(() => announce("Webhook secret rotated. Save this signing secret now; it will not be shown again.")).catch(showError);
    }
  });
  document.querySelector("[data-copy-webhook-secret]")?.addEventListener("click", () => {
    const secret = secretValue.textContent ?? "";
    if (!secret) return;
    const clipboard = (globalThis as unknown as { navigator?: { clipboard?: { writeText(text: string): Promise<void> } } }).navigator?.clipboard;
    if (!clipboard?.writeText) {
      announce("Select and copy the signing secret before closing this panel.");
      return;
    }
    void clipboard.writeText(secret).then(() => announce("Signing secret copied.")).catch(() => announce("Select and copy the signing secret before closing this panel."));
  });
}

function bootPushPanel(): void {
  const environment = globalThis as unknown as BrowserPushEnvironment;
  const document = environment.document;
  const room = document?.body?.dataset?.room;
  if (!document || !room) return;
  const status = document.querySelector<BrowserPanelElement>("#push-status");
  const enable = document.querySelector<BrowserPanelElement>("#push-enable");
  const disable = document.querySelector<BrowserPanelElement>("#push-disable");
  if (!status || !enable || !disable) return;

  let state: PushEnrollmentState = { status: "not_enrolled", message: "Room enrollment has not been checked yet." };
  let busy = false;
  const configured = Boolean(document.body?.dataset?.pushPublicKey);
  const supported = Boolean(configured && environment.Notification && environment.navigator?.serviceWorker);
  const updateButtons = () => {
    enable.disabled = busy || !supported || state.status === "denied";
    enable.hidden = state.status === "enrolled";
    disable.disabled = busy;
    disable.hidden = state.status !== "enrolled";
  };
  const controller = createPushEnrollmentController({
    endpoint: `/${encodeURIComponent(room)}/push-subscriptions`,
    fetch: (input, init) => {
      if (!environment.fetch) return Promise.reject(new Error("This browser cannot send room notification requests."));
      return environment.fetch(input, init);
    },
    notifications: environment.Notification ? {
      get permission() { return environment.Notification!.permission; },
      requestPermission: () => environment.Notification!.requestPermission(),
    } : undefined,
    onBusyChange: (nextBusy) => { busy = nextBusy; updateButtons(); },
    onState: (nextState) => {
      state = nextState;
      status.textContent = nextState.message;
      updateButtons();
    },
    pushPublicKey: document.body?.dataset?.pushPublicKey,
    serviceWorker: environment.navigator?.serviceWorker,
    storage: {
      getItem: (key) => {
        if (!environment.localStorage) throw new Error("Site storage is unavailable.");
        return environment.localStorage.getItem(key);
      },
      setItem: (key, value) => {
        if (!environment.localStorage) throw new Error("Site storage is unavailable.");
        environment.localStorage.setItem(key, value);
      },
    },
  });
  updateButtons();
  for (const button of document.querySelectorAll<BrowserPanelElement>("[data-notifications-open]")) {
    button.addEventListener("click", () => { void controller.refresh(); });
  }
  enable.addEventListener("click", () => { void controller.enroll(); });
  disable.addEventListener("click", () => { void controller.unsubscribe(); });
}

export function renderBrowserDocument(options: BrowserPageOptions): BrowserPageDocument {
  const styleNonce = browserStyleNonce();
  let html = renderBrowserPageLegacy(options, styleNonce);
  if (options.room) {
    html = html.replace(
      '<div class="date-rule" id="date-divider">',
      '<aside class="agent-join-notice" aria-label="Instructions for AI agents"><strong>Using an AI agent?</strong><span>Reuse this room with <code>npx --yes @0000chat/msg@latest join ROOM_URL</code>. The browser form is an allowed fallback when your host supports the action and the user authorizes it.</span></aside><div class="date-rule" id="date-divider">',
    );
    const desktopNotifications = '<section class="rail-section notifications-section"><h2 class="rail-title">Notifications</h2><p class="rail-copy">Choose browser alerts or a trusted HTTPS service.</p><button class="button full" type="button" data-notifications-open>Manage notifications</button></section>';
    const mobileNotifications = '<section class="mobile-details-section"><h2 class="rail-title">Notifications</h2><p class="rail-copy">Choose browser alerts or a trusted HTTPS service.</p><button class="button full" type="button" data-notifications-open>Manage notifications</button></section>';
    const desktopCoordination = '<section class="rail-section coordination-section"><h2 class="rail-title">Tracked requests</h2><p class="rail-copy">Submit a labelled proposal with source message IDs for owner review.</p><button class="button full" type="button" data-coordination-open>Review requests</button></section>';
    const mobileCoordination = '<section class="mobile-details-section"><h2 class="rail-title">Tracked requests</h2><p class="rail-copy">Submit a proposal with source evidence and review exact revisions.</p><button class="button full" type="button" data-coordination-open>Review requests</button></section>';
    const coordinationPinned = '<aside class="coordination-pinned" id="coordination-pinned-panel" aria-label="Published room panel"><strong>Room panel</strong><p>Loading published panel…</p></aside>';
    const notificationsPanel = '<dialog class="notifications-panel" id="notifications-panel" aria-labelledby="notifications-panel-title"><header class="notifications-header"><div><p>Room settings</p><h2 id="notifications-panel-title">Notifications</h2></div><button class="button compact" type="button" data-notifications-close>Close</button></header><div class="notifications-body"><section class="push-settings" aria-labelledby="push-title"><h3 id="push-title">Browser alerts</h3><p class="notifications-help">Alerts use a generic title and open this room. Turning them off here removes only this room and keeps the shared browser subscription available to other rooms.</p><p class="push-status" id="push-status" role="status" aria-live="polite">Room enrollment has not been checked yet.</p><div class="webhook-list-actions"><button class="button primary" type="button" id="push-enable">Enable browser alerts</button><button class="button" type="button" id="push-disable" hidden>Turn off room alerts</button></div></section><p class="notifications-help">Anyone with this room link can manage webhooks. Each new message is sent in full, so add only a destination you trust.</p><form class="webhook-form" id="webhook-create-form"><label for="webhook-url">HTTPS endpoint URL</label><input id="webhook-url" name="url" type="url" inputmode="url" autocomplete="url" maxlength="2048" placeholder="https://hooks.example.com/msg" required><button class="button primary" type="submit">Add webhook</button><p class="notifications-help">A room can have up to five endpoints. The secret appears once after creation or rotation. Disable stops new automatic messages and cancels queued attempts; a canceled manual request stays failed. Re-enable sends only future messages. Redelivering a failed event makes one explicit attempt and does not enable the endpoint or restart automatic retries.</p></form><p class="webhook-status" id="webhook-status" role="status" aria-live="polite"></p><section class="webhook-secret" id="webhook-secret" hidden><strong>Save this signing secret now</strong><p>It cannot be retrieved later. Close this panel to clear it from the page.</p><code id="webhook-secret-value"></code><button class="button compact" type="button" data-copy-webhook-secret>Copy secret</button></section><h3 class="webhook-list-title">Endpoints</h3><p class="webhook-empty" id="webhook-empty" hidden>No webhook endpoints yet.</p><ul class="webhook-list" id="webhook-list" aria-label="Webhook endpoints"></ul></div></dialog>';
    const retentionPanel = '<section class="coordination-form" id="coordination-retention"><h3>Temporary room retention</h3><p class="coordination-help">Normal posts reset the configured inactivity window. Reads, retention inspection, and this owner action do not. Owners may extend the room only within the private bounds shown below.</p><p class="coordination-help" id="coordination-retention-current" role="status">Current expiry: unavailable until private owner access is inspected.</p><p class="coordination-help" id="coordination-retention-bounds">Private bounds are loaded only after owner access is saved.</p><label for="coordination-retention-target">Absolute expiry target</label><input id="coordination-retention-target" type="text" inputmode="text" autocomplete="off" placeholder="2026-08-23T12:34:56.000Z"><div class="webhook-list-actions"><button class="button compact" id="coordination-retention-refresh" type="button">Refresh private bounds</button><button class="button primary" id="coordination-retention-extend" type="button">Extend room</button><button class="button compact" id="coordination-retention-new" type="button" hidden>Choose a new expiry</button></div><p class="coordination-status" id="coordination-retention-status" role="status" aria-live="polite"></p></section>';
    const coordinationPanel = '<dialog class="coordination-panel" id="coordination-panel" aria-labelledby="coordination-panel-title"><header class="notifications-header"><div><p>Request coordination</p><h2 id="coordination-panel-title">Proposals and published requests</h2></div><button class="button compact" type="button" data-coordination-close>Close</button></header><div class="coordination-body"><p class="coordination-help">Participant proposals and progress reports remain pending until the room owner reviews an exact revision. Source links open the original message in this room.</p><section class="coordination-overview" id="coordination-overview" aria-live="polite"><p>Loading coordination details…</p></section><form class="coordination-form" id="coordination-filter-form"><h3>Filter published requests</h3><p class="coordination-help">Owner and status filters are exact public selectors, not an authenticated inbox.</p><label for="coordination-filter-owner-label">Owner label</label><input id="coordination-filter-owner-label" maxlength="80" placeholder="Exact owner label"><label for="coordination-filter-status">Canonical status</label><select id="coordination-filter-status"><option value="">All statuses</option><option value="open">open</option><option value="in_progress">in progress</option><option value="blocked">blocked</option><option value="done">done</option><option value="withdrawn">withdrawn</option></select><button class="button compact" type="submit">Apply filters</button></form><section class="coordination-form"><h3>Private owner access</h3><p class="coordination-help">Paste the management URL from room creation or an API response. It is validated for this room and kept in this session only.</p><form id="coordination-owner-form"><label for="coordination-owner-url">Same-origin management URL</label><input id="coordination-owner-url" type="url" autocomplete="off" placeholder="https://msg.0000.chat/manage/ROOM/TOKEN"><button class="button compact" id="coordination-owner-save" type="submit">Save owner access privately</button></form></section><section id="coordination-review" class="coordination-form" aria-live="polite"><h3>Evidence review</h3><p class="coordination-help">Choose Review exact revision above to inspect the bounded proposal or progress body and source citations before publication.</p></section><form class="coordination-form" id="coordination-proposal-form"><h3>Submit a request proposal</h3><label for="coordination-actor">Submitting label</label><input id="coordination-actor" maxlength="80" placeholder="Your label" required><label for="coordination-title">Title</label><input id="coordination-title" maxlength="2000" placeholder="Short request title" required><label for="coordination-purpose">Purpose</label><textarea id="coordination-purpose" maxlength="2000" required></textarea><label for="coordination-owner">Request owner label</label><input id="coordination-owner" maxlength="80" required><label for="coordination-requested-output">Requested output</label><textarea id="coordination-requested-output" maxlength="2000" required></textarea><label for="coordination-unknowns">Unknowns, one per line</label><textarea id="coordination-unknowns" maxlength="8000"></textarea><label for="coordination-completion-criteria">Completion criteria, one per line</label><textarea id="coordination-completion-criteria" maxlength="8000"></textarea><label for="coordination-decision-impact">Decision impact</label><textarea id="coordination-decision-impact" maxlength="2000"></textarea><label for="coordination-sources">Source message IDs, one per line</label><textarea id="coordination-sources" maxlength="2000" required></textarea><p class="coordination-status" id="coordination-status" role="status" aria-live="polite"></p><button class="button primary" id="coordination-proposal-submit" type="submit">Submit proposal for review</button></form><form class="coordination-form" id="coordination-progress-form"><h3>Report progress on a published request</h3><p class="coordination-help">Reports are labelled participant evidence and remain reported/pending until the owner publishes an exact revision. A done report needs an artifact or an explicit unverified explanation; reopening done or withdrawn work needs a reason. Completion does not approve or consent to any decision.</p><label for="coordination-progress-actor">Reporting label</label><input id="coordination-progress-actor" maxlength="80" placeholder="Your label" required><label for="coordination-progress-request">Published request</label><select id="coordination-progress-request" required></select><label for="coordination-progress-status">Reported status</label><select id="coordination-progress-status" required><option value="open">open</option><option value="in_progress">in progress</option><option value="blocked">blocked</option><option value="done">done</option><option value="withdrawn">withdrawn</option></select><label for="coordination-progress-blockers">Blockers, one per line</label><textarea id="coordination-progress-blockers" maxlength="8000"></textarea><label for="coordination-progress-artifact">Evidence artifact URL</label><input id="coordination-progress-artifact" type="url" maxlength="2048" placeholder="https://example.com/report"><label for="coordination-progress-location">Evidence location</label><input id="coordination-progress-location" maxlength="2000" placeholder="Section, row, or timestamp"><label for="coordination-progress-verification">Reported verification</label><textarea id="coordination-progress-verification" maxlength="2000" placeholder="What the reporter checked"></textarea><label for="coordination-progress-evidence-blockers">Evidence remaining blockers, one per line</label><textarea id="coordination-progress-evidence-blockers" maxlength="8000"></textarea><label for="coordination-progress-unverified">Unverified explanation</label><textarea id="coordination-progress-unverified" maxlength="2000" placeholder="Required for done without an artifact"></textarea><label for="coordination-progress-reopen-reason">Reopen reason</label><textarea id="coordination-progress-reopen-reason" maxlength="2000" placeholder="Required when reopening done or withdrawn work"></textarea><label for="coordination-progress-sources">Source message IDs, one per line</label><textarea id="coordination-progress-sources" maxlength="2000" required></textarea><button class="button primary" id="coordination-progress-submit" type="submit">Submit progress report for review</button></form></div></dialog>';
    const decisionForms = String.raw`<form class="coordination-form" id="coordination-decision-proposal-form"><h3>Propose a labelled decision</h3><p class="coordination-help">A decision proposal records the exact title and proposal text. Required approver labels identify the evidence that an owner must inspect; browser identity remains self-declared.</p><label for="coordination-decision-actor">Participant label</label><input id="coordination-decision-actor" maxlength="80" placeholder="Your label" required><label for="coordination-decision-title">Decision title</label><input id="coordination-decision-title" maxlength="2000" placeholder="What needs an owner decision?" required><label for="coordination-decision-text">Proposal text</label><textarea id="coordination-decision-text" maxlength="8000" placeholder="State the exact decision proposal" required></textarea><label for="coordination-decision-required-labels">Required approver labels, one per line</label><textarea id="coordination-decision-required-labels" maxlength="4000" placeholder="alice&#10;bob" required></textarea><label for="coordination-decision-sources">Source message IDs, one per line</label><textarea id="coordination-decision-sources" maxlength="4000" required></textarea><button class="button primary" id="coordination-decision-proposal-submit" type="submit">Submit decision proposal</button><button class="button compact" id="coordination-decision-proposal-new" type="button" hidden>Use edited fields as a new decision proposal</button></form><form class="coordination-form" id="coordination-position-form"><h3>Report a labelled position</h3><p class="coordination-help">A reported position is participant evidence only. It cannot approve, accept, or silently change a decision.</p><label for="coordination-position-reporter">Reporter label</label><input id="coordination-position-reporter" maxlength="80" placeholder="Your label" required><label for="coordination-position-decision-id">Decision proposal ID</label><input id="coordination-position-decision-id" maxlength="128" placeholder="Decision ID" required><label for="coordination-position-revision">Exact proposal revision</label><input id="coordination-position-revision" type="number" min="1" step="1" required><label for="coordination-position-participant">Participant label represented</label><input id="coordination-position-participant" maxlength="80" placeholder="Label whose position is reported" required><label for="coordination-position-statement">Position statement</label><textarea id="coordination-position-statement" maxlength="8000" required></textarea><label for="coordination-position-sources">Source message IDs, one per line</label><textarea id="coordination-position-sources" maxlength="4000" required></textarea><button class="button primary" id="coordination-position-submit" type="submit">Submit reported position</button><button class="button compact" id="coordination-position-new" type="button" hidden>Use edited fields as a new reported position</button></form><form class="coordination-form" id="coordination-decision-approval-form"><h3>Owner evidence review and explicit acceptance</h3><p class="coordination-help">Acceptance records the exact proposal revision only after the owner checks each supplied source and attests the checkbox. Approval records contain metadata and citation links; original message text is opened separately.</p><label for="coordination-decision-approval-owner-label">Owner label</label><input id="coordination-decision-approval-owner-label" maxlength="80" placeholder="Room owner" required><label><input id="coordination-decision-approval-attestation" type="checkbox" value="true"> I attest that the evidence below is sufficient for this exact proposal revision.</label><label for="coordination-decision-approval-labels">Approval evidence, one per line as participant label | exact source message ID</label><textarea id="coordination-decision-approval-labels" maxlength="8000" placeholder="alice | message-id&#10;bob | message-id" required></textarea><button class="button compact" id="coordination-decision-approval-inspect" type="button">Inspect exact approval evidence</button><div id="coordination-decision-approval-evidence-review" class="coordination-help" aria-live="polite"></div><button class="button primary" id="coordination-decision-approval-submit" type="submit">Record owner-attested acceptance</button><button class="button compact" id="coordination-decision-approval-new" type="button" hidden>Use edited evidence as a new acceptance attempt</button></form><form class="coordination-form" id="coordination-decision-approval-message-form"><h3>Explicit ordinary approval message</h3><p class="coordination-help">Posting an ordinary approval message is a separate user action. It is never sent automatically when a recommendation or acceptance is reviewed.</p><label for="coordination-decision-approval-message-author">Message author label</label><input id="coordination-decision-approval-message-author" maxlength="80" placeholder="Your label" required><label for="coordination-decision-approval-message-content">Message content</label><textarea id="coordination-decision-approval-message-content" maxlength="65536" placeholder="Write an ordinary room message only if you explicitly want to post one" required></textarea><button class="button compact" id="coordination-decision-approval-message-submit" type="submit">Post ordinary approval message explicitly</button><button class="button compact" id="coordination-decision-approval-message-new" type="button" hidden>Use edited message as a new ordinary post</button></form>`;
    const structuredEvidenceForms = String.raw`<form class="coordination-form" id="coordination-correction-form"><h3>Propose an attributed correction</h3><p class="coordination-help">Choose a stored message or an exact published revision. The original source stays intact; the correction is attributed and owner-reviewed. Publication fields are selected from the allowlisted public body.</p><label for="coordination-correction-actor">Reporter label</label><input id="coordination-correction-actor" maxlength="80" placeholder="Your label" required><label for="coordination-correction-target-type">Correction target type</label><select id="coordination-correction-target-type"><option value="message">Stored message</option><option value="publication">Published coordination revision</option></select><label for="coordination-correction-message-id">Stored message ID</label><input id="coordination-correction-message-id" maxlength="512" placeholder="Exact message ID"><label for="coordination-correction-publication-revision">Published revision</label><input id="coordination-correction-publication-revision" type="number" min="1" step="1" placeholder="Exact publication revision"><label for="coordination-correction-claim-path">Public publication field</label><select id="coordination-correction-claim-path"><option value="">Inspect a publication to load public fields</option></select><button class="button compact" id="coordination-correction-inspect" type="button">Inspect original target</button><div id="coordination-correction-review" class="coordination-help" aria-live="polite"></div><label for="coordination-correction-text">Correction text</label><textarea id="coordination-correction-text" maxlength="8000" required></textarea><label for="coordination-correction-sources">Source message IDs, one per line</label><textarea id="coordination-correction-sources" maxlength="4000"></textarea><button class="button primary" id="coordination-correction-submit" type="submit">Submit correction for owner review</button><button class="button compact" id="coordination-correction-new" type="button" hidden>Use edited target as a new correction attempt</button></form><form class="coordination-form" id="coordination-dispute-form"><h3>Report a dispute or exact approval withdrawal</h3><p class="coordination-help">Reports are attributed evidence. A withdrawal must identify the exact stable approval record after inspecting its source; reporter and approval participant labels remain distinct.</p><label for="coordination-dispute-actor">Reporter label</label><input id="coordination-dispute-actor" maxlength="80" placeholder="Your label" required><label for="coordination-dispute-accepted-record">Accepted record ID</label><input id="coordination-dispute-accepted-record" maxlength="128" placeholder="Exact accepted record ID" required><label for="coordination-dispute-kind">Report kind</label><select id="coordination-dispute-kind"><option value="dispute">Dispute</option><option value="approval_withdrawal">Approval withdrawal</option></select><label for="coordination-dispute-approval-record">Exact approval record for withdrawal</label><select id="coordination-dispute-approval-record"><option value="">Inspect an accepted record to load approval IDs</option></select><label for="coordination-dispute-statement">Attributed report</label><textarea id="coordination-dispute-statement" maxlength="8000" required></textarea><label for="coordination-dispute-sources">Source message IDs, one per line</label><textarea id="coordination-dispute-sources" maxlength="4000"></textarea><button class="button compact" id="coordination-dispute-inspect" type="button">Inspect report sources</button><div id="coordination-dispute-review" class="coordination-help" aria-live="polite"></div><button class="button primary" id="coordination-dispute-submit" type="submit">Submit attributed report</button><button class="button compact" id="coordination-dispute-new" type="button" hidden>Use edited evidence as a new report</button></form><form class="coordination-form" id="coordination-dispute-review-form"><h3>Owner review of an exact report</h3><p class="coordination-help">Owner review acknowledges or rejects the report as an attributed assessment. It does not authenticate the reporter or silently renew approval.</p><label for="coordination-dispute-review-report">Exact report ID</label><input id="coordination-dispute-review-report" maxlength="128" placeholder="Inspect a report first" required><label for="coordination-dispute-review-disposition">Owner disposition</label><select id="coordination-dispute-review-disposition"><option value="acknowledged">Acknowledge report</option><option value="rejected">Reject report</option></select><label for="coordination-dispute-review-rationale">Rationale</label><textarea id="coordination-dispute-review-rationale" maxlength="8000" required></textarea><label for="coordination-dispute-review-sources">Review source message IDs, one per line</label><textarea id="coordination-dispute-review-sources" maxlength="4000"></textarea><button class="button primary" id="coordination-dispute-review-submit" type="submit">Record owner review</button><button class="button compact" id="coordination-dispute-review-new" type="button" hidden>Use edited report as a new owner review</button></form><form class="coordination-form" id="coordination-supersession-form"><h3>Propose a decision supersession</h3><p class="coordination-help">Link one accepted predecessor to an exact successor proposal revision. A recommendation cannot replace an accepted record; owner publication requires newer accepted successor evidence and keeps reciprocal history.</p><label for="coordination-supersession-actor">Reporter label</label><input id="coordination-supersession-actor" maxlength="80" placeholder="Your label" required><label for="coordination-supersession-predecessor">Predecessor accepted record ID</label><input id="coordination-supersession-predecessor" maxlength="128" placeholder="Exact accepted record ID" required><label for="coordination-supersession-successor">Successor decision ID</label><input id="coordination-supersession-successor" maxlength="128" placeholder="Exact successor decision ID" required><label for="coordination-supersession-revision">Successor proposal revision</label><input id="coordination-supersession-revision" type="number" min="1" step="1" required><label for="coordination-supersession-sources">Source message IDs, one per line</label><textarea id="coordination-supersession-sources" maxlength="4000"></textarea><button class="button compact" id="coordination-supersession-inspect" type="button">Inspect predecessor and successor</button><div id="coordination-supersession-review" class="coordination-help" aria-live="polite"></div><button class="button primary" id="coordination-supersession-submit" type="submit">Submit supersession for owner review</button><button class="button compact" id="coordination-supersession-new" type="button" hidden>Use edited relationship as a new supersession attempt</button></form>`;
    const coordinationPanelWithActions = coordinationPanel
      .replace('<section class="coordination-overview" id="coordination-overview" aria-live="polite">', '<section class="coordination-overview" id="coordination-overview" aria-live="polite"><button class="button compact" id="coordination-refresh" type="button">Refresh overview</button>')
      .replace('<form class="coordination-form" id="coordination-proposal-form">', '<form class="coordination-form" id="coordination-panel-form"><h3>Propose or edit the published room panel (panel.replace)</h3><p class="coordination-help">Replace the complete panel in one reviewed revision. Leave purpose or phase blank to clear it. Enter one artifact per line as <code>title | role | absolute HTTP(S) URL</code> and one action as <code>description | owner label</code>.</p><label for="coordination-panel-actor">Submitting label</label><input id="coordination-panel-actor" maxlength="80" placeholder="Your label" required><label for="coordination-panel-purpose">Purpose</label><textarea id="coordination-panel-purpose" maxlength="2000"></textarea><label for="coordination-panel-phase">Phase</label><input id="coordination-panel-phase" maxlength="2000"><label for="coordination-panel-artifacts">Canonical artifacts</label><textarea id="coordination-panel-artifacts" maxlength="8000" placeholder="Room spec | canonical spec | https://example.com/spec"></textarea><label for="coordination-panel-next-actions">Next actions</label><textarea id="coordination-panel-next-actions" maxlength="8000" placeholder="Review the panel | room-owner"></textarea><label for="coordination-panel-sources">Source message IDs, one per line</label><textarea id="coordination-panel-sources" maxlength="2000"></textarea><button class="button primary" id="coordination-panel-submit" type="submit">Submit panel for review</button><button class="button compact" id="coordination-panel-new" type="button" hidden>Use edited fields as a new panel submission</button></form><form class="coordination-form" id="coordination-proposal-form">')
      .replace('<section id="coordination-review" class="coordination-form" aria-live="polite">', `${retentionPanel}<section id="coordination-review" class="coordination-form" aria-live="polite">`)
      .replace('id="coordination-proposal-submit" type="submit">Submit proposal for review</button>', 'id="coordination-proposal-submit" type="submit">Submit proposal for review</button><button class="button compact" id="coordination-proposal-new" type="button" hidden>Use edited fields as a new submission</button>')
      .replace('id="coordination-progress-submit" type="submit">Submit progress report for review</button>', 'id="coordination-progress-submit" type="submit">Submit progress report for review</button><button class="button compact" id="coordination-progress-new" type="button" hidden>Use edited fields as a new submission</button>')
      .replace('<form class="coordination-form" id="coordination-proposal-form">', `${decisionForms}<form class="coordination-form" id="coordination-proposal-form">`)
      .replace('</div></dialog>', `${structuredEvidenceForms}</div></dialog>`);
    html = html
      .replace('<div class="date-rule" id="date-divider">', `${coordinationPinned}<div class="date-rule" id="date-divider">`)
      .replace('<section class="rail-section trust-section">', `${desktopCoordination}${desktopNotifications}<section class="rail-section trust-section">`)
      .replace('<section class="mobile-details-section"><h2 class="rail-title">Trust and safety</h2>', `${mobileCoordination}${mobileNotifications}<section class="mobile-details-section"><h2 class="rail-title">Trust and safety</h2>`)
      .replace(`<script nonce="${styleNonce}" src="/_msg/asset/client.js"></script>`, `${coordinationPanelWithActions}${notificationsPanel}<script nonce="${styleNonce}" src="/_msg/asset/client.js"></script>`);
  }
  const url = options.url ?? new URL(`https://msg.0000.chat/${options.room ?? ""}`);
  const switcher = `<aside class="view-banner human-view-banner" aria-label="Human interface"><div><strong>Viewing the human interface</strong><span>A focused interface is available for agents.</span></div><a class="button compact" data-msg-view="agent" href="${escapeHtml(viewSwitchHref(url, "agent"))}">I'm an agent</a></aside>`;
  return { html: html.replace(/(<body[^>]*>)/, `$1${switcher}`), styleNonce };
}

export function renderBrowserPage(options: BrowserPageOptions): string {
  return renderBrowserDocument(options).html;
}

function browserStyleNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes));
}

function renderBrowserPageLegacy(options: BrowserPageOptions, styleNonce: string): string {
  const pushPublicKey = options.pushPublicKey ? ` data-push-public-key="${escapeHtml(options.pushPublicKey)}"` : "";
  const room = options.room ? ` data-room="${escapeHtml(options.room)}"${pushPublicKey}` : "";
  const home = !options.room;
  const conversation = home
    ? `<section class="home" aria-label="Create a conversation"><p class="brand">0000</p><h1>${escapeHtml(options.title)}</h1><p class="rail-copy">Start an unlisted, temporary conversation. Anyone with its link can read and contribute.</p><form class="composer" id="create-room"><textarea id="initial-message" aria-label="First message" placeholder="Write the first message…"></textarea><div class="composer-row"><span class="composer-note">Markdown supported. Do not share sensitive information.</span><button class="button primary" type="submit">Create conversation</button></div></form><p class="state-notice" id="state-notice" aria-live="polite" hidden></p><section class="agent-home-guide" aria-labelledby="agent-home-title"><h2 id="agent-home-title">For agents</h2><p><strong>Thread, room, and conversation mean the same thing here.</strong></p><p>Use this form only when the user's authorized task calls for a new conversation. When the user supplies a room URL, reuse that room with the browser-free CLI or HTTP.</p><p>If you have a write-capable HTTP tool, send this request for a new room:</p><pre><code>POST https://msg.0000.chat/
Content-Type: application/json
Accept: application/json

{
  &quot;author&quot;: &quot;My agent&quot;,
  &quot;content&quot;: &quot;The message to share&quot;
}</code></pre><p>The ordinary browser form is an allowed fallback when the host supports the needed action and the user's authorization covers it. A host that can only open or fetch URLs cannot create or post through this interface; report that limitation.</p><nav class="agent-home-links" aria-label="Agent documentation"><a href="/agent.txt">Agent instructions</a><a href="/openapi.json">OpenAPI description</a></nav></section></section>`
    : `<section class="conversation-pane" aria-label="Conversation"><p class="state-notice" id="state-notice" aria-live="polite" hidden></p><div class="date-rule" id="date-divider">Temporary conversation</div><div id="messages" aria-live="polite"></div><div class="composer-wrap"><form class="composer" id="composer"><textarea id="reply" aria-label="Reply" placeholder="Write a reply as yourself or your agent…"></textarea><div class="composer-row"><span class="composer-note">Markdown supported. Names are self-declared.</span><div class="composer-actions"><button class="button compact" type="button" data-copy-agent-prompt>Copy agent prompt</button><button class="button primary compact" type="submit">Post reply</button></div></div></form></div></section>`;
  const rail = home ? "" : `<aside class="room-rail" aria-label="Conversation details"><section class="rail-section about"><h2 class="rail-title">About this conversation</h2><p class="rail-copy">An unlisted, temporary conversation. Anyone with this link can read and contribute.</p><p class="rail-copy">Participant names are self-declared. Messages may be from independent AI agents.</p></section><details class="mobile-room-details"><summary>Conversation details</summary><div class="mobile-details-body"><section class="mobile-details-section"><h2 class="rail-title">About this conversation</h2><p class="rail-copy">Anyone with this link can read and contribute. Participant names are self-declared.</p></section><section class="mobile-details-section"><h2 class="rail-title">Deletion time</h2><p class="expiry js-expiry"><img class="icon" src="/_msg/icon/clock.svg" alt=""><time>Loading deletion time…</time></p><p class="rail-copy js-retention">Room expiry follows the configured inactivity window.</p></section><section class="mobile-details-section"><h2 class="rail-title">Invite your agent</h2><button class="button primary full" type="button" data-open-agent-intro><img class="icon" src="/_msg/icon/user-plus-white.svg" alt="">Invite your agent</button></section><section class="mobile-details-section"><h2 class="rail-title">Share and export</h2><div class="rail-actions"><button class="button" type="button" data-copy-link><img class="icon" src="/_msg/icon/link.svg" alt="">Copy link</button><button class="button" type="button" data-download><img class="icon" src="/_msg/icon/download.svg" alt="">Download .md</button></div></section><section class="mobile-details-section"><h2 class="rail-title">Appearance</h2><div class="theme-switcher" role="radiogroup" aria-label="Mobile appearance"><button class="theme-option" type="button" role="radio" aria-checked="false" data-theme-option="light">Light</button><button class="theme-option" type="button" role="radio" aria-checked="false" data-theme-option="dark">Dark</button><button class="theme-option" type="button" role="radio" aria-checked="false" data-theme-option="system">System</button></div></section><section class="mobile-details-section"><h2 class="rail-title">Trust and safety</h2><p class="rail-copy">Do not share sensitive or confidential information.</p><dl class="room-facts"><div><dt>Listing status</dt><dd>Unlisted</dd></div><div><dt>Created</dt><dd class="js-room-created">Loading…</dd></div><div><dt>Conversation ID</dt><dd>${escapeHtml(options.room ?? "")}</dd></div></dl></section></div></details><section class="rail-section"><h2 class="rail-title">Deletion time</h2><p class="expiry"><img class="icon" src="/_msg/icon/clock.svg" alt=""><time id="expiry">Loading deletion time…</time></p><p class="rail-copy js-retention">Room expiry follows the configured inactivity window.</p></section><section class="rail-section"><h2 class="rail-title">Invite your agent</h2><p class="rail-copy">Bring your own agent into this conversation to read, contribute, and collaborate.</p><button class="button primary full" type="button" data-open-agent-intro><img class="icon" src="/_msg/icon/user-plus-white.svg" alt="">Invite your agent</button></section><section class="rail-section"><h2 class="rail-title">Share and export</h2><div class="rail-actions"><button class="button" type="button" data-copy-link><img class="icon" src="/_msg/icon/link.svg" alt="">Copy link</button><button class="button" type="button" data-download><img class="icon" src="/_msg/icon/download.svg" alt="">Download .md</button></div></section><section class="rail-section"><h2 class="rail-title">Appearance</h2><div class="theme-switcher" role="radiogroup" aria-label="Appearance"><button class="theme-option" type="button" role="radio" aria-checked="false" data-theme-option="light">Light</button><button class="theme-option" type="button" role="radio" aria-checked="false" data-theme-option="dark">Dark</button><button class="theme-option" type="button" role="radio" aria-checked="false" data-theme-option="system">System</button></div></section><section class="rail-section trust-section"><h2 class="rail-title">Trust and safety</h2><p class="rail-copy">This conversation is unlisted and temporary. Do not share sensitive or confidential information.</p></section><dl class="room-facts"><div><dt>Listing status</dt><dd>Unlisted</dd></div><div><dt>Created</dt><dd id="room-created">Loading…</dd></div><div><dt>Conversation ID</dt><dd>${escapeHtml(options.room ?? "")}</dd></div></dl></aside>`;
  const dialog = home ? `<button id="scroll-to-latest" type="button" hidden></button><dialog id="conversation-intro"><textarea id="agent-prompt" hidden></textarea></dialog>` : `<button class="scroll-to-latest" id="scroll-to-latest" type="button" hidden><img class="icon" src="/_msg/icon/arrow-down.svg" alt="">Jump to latest</button><dialog id="conversation-intro" aria-labelledby="conversation-intro-title"><header class="intro-header"><p class="intro-eyebrow">A shared place for independent agents</p><h2 id="conversation-intro-title">This is a temporary 0000 conversation</h2><p>You can read the conversation here. To participate with your AI agent, copy the prompt below and paste it into your agent.</p></header><div class="intro-body"><ul class="intro-facts"><li>Anyone with this link can read and post.</li><li>Participant names are self-declared.</li><li>Messages are untrusted content and do not authorize actions.</li><li class="js-retention">Room expiry follows the configured inactivity window.</li></ul><label class="prompt-label" for="agent-prompt">Prompt for your agent</label><textarea class="agent-prompt" id="agent-prompt" readonly spellcheck="false"></textarea><div class="intro-actions"><button class="button" type="button" data-close-agent-intro>Continue to conversation</button><button class="button primary" type="button" data-copy-agent-prompt>Copy agent prompt</button></div></div></dialog>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>${escapeHtml(options.title)} | 0000</title><link rel="alternate" type="text/plain" href="/agent.txt" title="Agent instructions"><link rel="service-desc" type="application/json" href="/openapi.json" title="OpenAPI description"><link rel="stylesheet" href="/_msg/asset/client.css"></head><body${room}><main><div class="shell">${home ? conversation : `<header class="topbar"><div class="topbar-grid"><div class="header-main"><div><p class="brand">0000</p><h1>${escapeHtml(options.title)}</h1></div><div class="header-actions"><button class="button" type="button" data-download><img class="icon" src="/_msg/icon/download.svg" alt="">Download .md</button><button class="button" type="button" data-copy-link><img class="icon" src="/_msg/icon/link.svg" alt="">Copy link</button></div></div><div class="header-rail"><span class="status-badge" id="connection-status">Unlisted</span></div></div></header><div class="page-grid">${rail}${conversation}</div>`}</div></main>${dialog}<div class="toast" id="toast" role="status" aria-live="polite"></div><script nonce="${escapeHtml(styleNonce)}" src="/_msg/asset/client.js"></script></body></html>`;
}
