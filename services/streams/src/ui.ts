type DisplayDecisionLock = {
  status?: string;
  createdAt?: string;
};

type DisplayStream = {
  streamId: string;
  title?: string;
  about?: string;
  summary?: string;
  ownerBot?: string;
  status?: string;
  needsDon?: boolean;
  archived?: boolean;
  priority?: number;
  updatedAt?: string;
  decisionLock?: DisplayDecisionLock | null;
  lock?: DisplayDecisionLock | null;
};

export function applyLiveStreams(value: unknown): DisplayStream[] | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as { type?: unknown; streams?: unknown };
  if (payload.type !== "streams.snapshot" && payload.type !== "streams.updated")
    return null;
  return Array.isArray(payload.streams)
    ? (payload.streams as DisplayStream[])
    : null;
}

export function liveReconnectDelay(
  attempt: number,
  baseMs = 1_000,
  maxMs = 30_000,
): number {
  const safeAttempt =
    Number.isFinite(attempt) && attempt >= 0 ? Math.floor(attempt) : 0;
  return Math.min(maxMs, baseMs * 2 ** Math.min(safeAttempt, 30));
}

export function timelineDisclosureState(
  currentlyOpen: boolean,
  action: "new-stream" | "same-stream-refresh" | "close-dialog",
): boolean {
  return action === "same-stream-refresh" ? currentlyOpen : false;
}

export function getStreamCardContent(stream: DisplayStream): {
  ownerBot: string;
  title: string;
  about: string;
  status: string;
  priority: number;
  updatedAt: string;
  deliveryStatus: string | null;
} {
  const lock =
    stream.decisionLock !== undefined
      ? stream.decisionLock
      : (stream.lock ?? null);
  let status =
    stream.status ?? (stream.needsDon ? "needs_decision" : "ongoing");
  if (status === "active")
    status = stream.needsDon === false ? "ongoing" : "needs_decision";
  if (status === "deferred") status = "no_action";
  return {
    ownerBot: typeof stream.ownerBot === "string" ? stream.ownerBot : "",
    title: typeof stream.title === "string" ? stream.title : "",
    about:
      typeof stream.summary === "string" && stream.summary.trim()
        ? stream.summary
        : typeof stream.about === "string"
          ? stream.about
          : "",
    status,
    priority:
      typeof stream.priority === "number" && Number.isFinite(stream.priority)
        ? stream.priority
        : 0,
    updatedAt: typeof stream.updatedAt === "string" ? stream.updatedAt : "",
    deliveryStatus:
      lock && typeof lock.status === "string" ? lock.status : null,
  };
}

export const isRetryableDecisionStatus = (status: string): boolean =>
  status === "pending" || status === "failed";

/**
 * Group streams for the PWA's attention hierarchy. This function has no
 * dependencies so the browser can execute the same rules from `.toString()`.
 */
export function groupStreamsForDisplay<T extends DisplayStream>(
  streams: T[],
  now: Date | string | number = new Date(),
): { needsYou: T[]; recentDecisions: T[]; elsewhere: T[] } {
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const lockFor = (stream: T): DisplayDecisionLock | null =>
    stream.decisionLock !== undefined
      ? stream.decisionLock
      : (stream.lock ?? null);
  const statusFor = (stream: T): string => {
    if (stream.status === "active")
      return stream.needsDon === false ? "ongoing" : "needs_decision";
    if (stream.status === "deferred") return "no_action";
    return stream.status ?? (stream.needsDon ? "needs_decision" : "ongoing");
  };
  const timeFor = (value: unknown): number =>
    typeof value === "string" ? Date.parse(value) : Number.NaN;
  const compareTimeDescending = (first: unknown, second: unknown): number => {
    const firstMs = timeFor(first);
    const secondMs = timeFor(second);
    if (Number.isFinite(firstMs) && Number.isFinite(secondMs))
      return secondMs - firstMs;
    if (Number.isFinite(firstMs)) return -1;
    if (Number.isFinite(secondMs)) return 1;
    return String(second ?? "").localeCompare(String(first ?? ""));
  };
  const priorityFor = (stream: T): number =>
    typeof stream.priority === "number" && Number.isFinite(stream.priority)
      ? stream.priority
      : 0;
  const comparePriorityUpdatedId = (first: T, second: T): number =>
    priorityFor(second) - priorityFor(first) ||
    compareTimeDescending(first.updatedAt, second.updatedAt) ||
    first.streamId.localeCompare(second.streamId);
  const statusRankForElsewhere = (stream: T): number =>
    statusFor(stream) === "ongoing"
      ? 0
      : statusFor(stream) === "no_action"
        ? 1
        : 2;
  const compareElsewhere = (first: T, second: T): number =>
    statusRankForElsewhere(first) - statusRankForElsewhere(second) ||
    comparePriorityUpdatedId(first, second);
  const deliveryRank = (lock: DisplayDecisionLock | null): number =>
    lock?.status === "failed"
      ? 0
      : lock?.status === "pending"
        ? 1
        : lock?.status === "submitted"
          ? 2
          : 3;
  const compareRecentPriorityId = (first: T, second: T): number =>
    priorityFor(second) - priorityFor(first) ||
    first.streamId.localeCompare(second.streamId);
  const compareRecent = (first: T, second: T): number => {
    const firstLock = lockFor(first);
    const secondLock = lockFor(second);
    return (
      deliveryRank(firstLock) - deliveryRank(secondLock) ||
      compareTimeDescending(firstLock?.createdAt, secondLock?.createdAt) ||
      compareRecentPriorityId(first, second)
    );
  };
  const visible = streams.filter(
    (stream) => stream.archived !== true && stream.status !== "archived",
  );
  const isRecent = (stream: T): boolean => {
    const lock = lockFor(stream);
    if (!lock) return false;
    if (lock.status === "pending" || lock.status === "failed") return true;
    if (lock.status !== "submitted") return false;
    const createdMs = timeFor(lock.createdAt);
    return (
      Number.isFinite(createdMs) &&
      Number.isFinite(nowMs) &&
      nowMs - createdMs <= weekMs
    );
  };
  // Needs attention → Needs you. Prefer status===needs_decision; also honor needsDon.
  // Only divert into Recent decisions when isRecent(lock); do not let a stale/non-recent
  // decisionLock hide streams that still need a decision.
  const needsAttention = (stream: T): boolean =>
    statusFor(stream) === "needs_decision" || stream.needsDon === true;
  const needsYou = visible
    .filter((stream) => needsAttention(stream) && !isRecent(stream))
    .sort(comparePriorityUpdatedId);
  const recentDecisions = visible
    .filter((stream) => Boolean(lockFor(stream)) && isRecent(stream))
    .sort(compareRecent);
  const elsewhere = visible
    .filter(
      (stream) =>
        !needsYou.includes(stream) && !recentDecisions.includes(stream),
    )
    .sort(compareElsewhere);
  return { needsYou, recentDecisions, elsewhere };
}

export const manifest = {
  name: "0000-streams",
  short_name: "Streams",
  start_url: "/",
  display: "standalone",
  background_color: "#f4f0e8",
  theme_color: "#171914",
  icons: [
    {
      src: "/icon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any maskable",
    },
  ],
};

export const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="42" fill="#171914"/><path d="M42 55h108M42 96h76M42 137h92" stroke="#d7ff67" stroke-width="16" stroke-linecap="round"/></svg>`;

export const serviceWorker = `
const CACHE = "helm-streams-v3";
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(["/", "/manifest.webmanifest", "/icon.svg"]))));
self.addEventListener("activate", event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
  await self.clients.claim();
})()));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request)));
});`;

export const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#171914"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg">
<title>0000-streams</title><style>
:root{color-scheme:light;--ink:#171914;--paper:#f4f0e8;--acid:#d7ff67;--muted:#4d5148;--line:#b9b5ab;--red:#8f2c20;--card:#fffdf8;--shadow:#d8d3c8}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,textarea{font:inherit}.shell{max-width:760px;margin:auto;padding:24px 18px calc(64px + env(safe-area-inset-bottom))}.mast{display:flex;justify-content:space-between;align-items:end;border-bottom:2px solid var(--ink);padding:14px 0}.mono,.zone,.card-meta,.chip,time{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
h1{font:800 clamp(2rem,10vw,4.5rem)/.9 system-ui,sans-serif;letter-spacing:-.045em;margin:0}.zone{font-size:.72rem;text-transform:uppercase;color:var(--muted)}.count{margin:24px 0 10px;font:700 .75rem/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.1em}.stream-section{margin:24px 0 30px}.section-heading{font:800 1.15rem/1.2 system-ui,sans-serif;letter-spacing:-.025em;margin:0 0 10px}.section-empty{border:1px dashed var(--muted);padding:16px;color:var(--muted);margin:0}.stream{display:block;width:100%;min-height:44px;text-align:left;border:1px solid var(--line);border-left:5px solid var(--ink);border-radius:8px;background:var(--card);padding:14px 15px;margin:0 0 10px;box-shadow:2px 3px 0 var(--shadow);cursor:pointer}.stream[data-needs-don=true]{border-left-color:var(--acid)}.eyebrow{display:flex;justify-content:space-between;align-items:center;gap:12px;color:var(--muted);font-size:.72rem;text-transform:uppercase}.stream h3{font:750 1.25rem/1.15 system-ui,sans-serif;margin:9px 0 6px}.summary{display:-webkit-box;max-width:65ch;overflow:hidden;color:#30342d;line-height:1.45;-webkit-box-orient:vertical;-webkit-line-clamp:3}.card-meta{display:flex;align-items:center;gap:8px;margin-top:10px;color:var(--muted);font-size:.68rem}.card-meta .priority{opacity:.75}.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{display:inline-flex;align-items:center;min-height:28px;border:1px solid var(--line);border-radius:999px;padding:3px 9px;color:var(--ink);font-size:.68rem;font-weight:800;line-height:1.15;text-transform:uppercase;letter-spacing:.02em}.chip.status-needs{background:var(--acid);border-color:#809900}.chip.status-ongoing,.chip.status-no-action{background:#eeece5}.chip.delivery-submitted{background:#e1ebcf;border-color:#8ba36b}.chip.delivery-pending{background:#f5e8bb;border-color:#a78627}.chip.delivery-failed{background:#f3d5cc;border-color:var(--red);color:#641d15}
dialog{width:min(720px,calc(100% - 20px));max-height:calc(100dvh - 20px);border:0;padding:0;background:var(--paper);box-shadow:0 20px 80px #0008;overflow:hidden}dialog::backdrop{background:#171914b8}.detail{max-height:calc(100dvh - 20px);overflow-y:auto;overscroll-behavior:contain;padding:20px 20px calc(24px + env(safe-area-inset-bottom))}.close{float:right;min-width:44px;min-height:44px;border:1px solid var(--ink);border-radius:6px;background:transparent;padding:7px 10px;cursor:pointer}.detail h2{font:750 clamp(1.8rem,8vw,3.2rem)/1 system-ui,sans-serif;letter-spacing:-.04em;max-width:14ch;margin:14px 0 10px}.detail h3{font:800 1rem/1.2 system-ui,sans-serif;margin:20px 0 8px}.recorded{clear:both;border-left:4px solid var(--acid);background:var(--card);padding:12px 14px;margin:18px 0 4px}.recorded h3{margin-top:0}.recorded p{margin:6px 0}.recorded-label{color:var(--muted);font-size:.72rem;text-transform:uppercase}.delivery{font-weight:800}.delivery.failed{color:var(--red)}details{clear:both;margin-top:20px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}summary{display:flex;align-items:center;min-height:44px;padding:10px 0;cursor:pointer;font-weight:800;list-style-position:inside}summary::-webkit-details-marker{color:var(--ink)}.history{padding:0 0 12px 24px;color:var(--muted);margin:0}.history li{padding:6px 0}.history time{display:block;color:var(--ink);font-size:.75rem}.history .section-empty{margin:6px 12px 6px 0}
.choices{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:20px 0 12px}.choice{min-height:52px;border:1px solid var(--ink);border-radius:6px;background:var(--card);padding:14px;text-align:left;cursor:pointer}.choice[aria-pressed=true]{background:var(--acid);box-shadow:2px 2px 0 var(--ink)}.choice.recommended{border-color:#718b00}.choice-recommended{display:block;margin-top:6px;color:#526500;font:800 .7rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}label{display:block;color:var(--muted);font:700 .75rem/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;margin:12px 0 6px}textarea{width:100%;min-height:88px;border:1px solid var(--line);border-radius:6px;background:var(--card);padding:12px;resize:vertical}.actions{display:grid;gap:8px;margin-top:10px}.submit,.secondary{width:100%;min-height:52px;border:0;border-radius:6px;background:var(--ink);color:#fff;padding:14px 16px;font-weight:800;cursor:pointer}.secondary{border:1px solid var(--ink);background:transparent;color:var(--ink)}.submit:disabled,.secondary:disabled,.choice:disabled{opacity:.48;cursor:not-allowed}.notice{min-height:1.5em;color:var(--muted)}.error{color:var(--red)}:focus-visible{outline:3px solid var(--ink);outline-offset:3px;box-shadow:0 0 0 5px var(--acid)}
@media(max-width:460px){.choices{grid-template-columns:1fr}.shell{padding-top:8px}.eyebrow{gap:8px;align-items:start;flex-direction:column}}
</style></head><body><main class="shell"><header class="mast"><h1>Streams</h1><span class="zone">Manila · UTC+8</span></header><p class="count" id="count">Loading</p><section id="list" aria-live="polite"></section></main>
<dialog id="dialog" aria-labelledby="title"><article class="detail"><button class="close" type="button" aria-label="Close">Close</button><p class="zone" id="meta"></p><h2 id="title"></h2><p class="summary" id="summary"></p><section class="recorded" id="recorded" aria-live="polite" hidden><h3>Recorded answer</h3><p id="recordedAnswer"></p><p id="recordedText"></p><p class="delivery" id="delivery"></p></section><details id="timelineDisclosure"><summary id="timelineSummary">Timeline · 0 updates · Manila/UTC+8</summary><ol class="history" id="history"></ol></details><section id="decisionPanel" aria-label="Decision response"><div class="choices" id="choices" role="group" aria-label="Decision choices"></div><label for="freeText">Optional note or custom instruction</label><textarea id="freeText" placeholder="Optional note or custom instruction"></textarea><div class="actions"><button class="submit" id="submit" type="button" disabled>Send decision</button><button class="secondary" id="retry" type="button" hidden>Retry decision</button><button class="secondary" id="change" type="button" hidden>Change my answer</button></div></section><p id="noDecision" class="section-empty" hidden>No decision needed for this stream.</p><p class="notice" id="notice" role="status"></p></article></dialog>
<script type="module">const isRetryableDecisionStatus=${isRetryableDecisionStatus.toString()};
const groupStreamsForDisplay=${groupStreamsForDisplay.toString()};
const timelineDisclosureState=${timelineDisclosureState.toString()};
const getStreamCardContent=${getStreamCardContent.toString()};
const applyLiveStreams=${applyLiveStreams.toString()};
const liveReconnectDelay=${liveReconnectDelay.toString()};
const state={streams:[],selected:null,choice:null,decisionId:null,busy:false};let liveSocket=null,liveReconnectTimer=null,livePollTimer=null,liveReconnectAttempt=0,liveStopped=false;const LIVE_POLL_INTERVAL_MS=15000;const list=document.querySelector("#list"),dialog=document.querySelector("#dialog"),notice=document.querySelector("#notice"),freeTextInput=document.querySelector("#freeText"),submitButton=document.querySelector("#submit"),retryButton=document.querySelector("#retry"),changeButton=document.querySelector("#change"),decisionPanel=document.querySelector("#decisionPanel"),noDecision=document.querySelector("#noDecision"),timelineDisclosure=document.querySelector("#timelineDisclosure"),timelineSummary=document.querySelector("#timelineSummary"),closeButton=document.querySelector(".close");
const fmt=new Intl.DateTimeFormat("en-PH",{timeZone:"Asia/Manila",dateStyle:"medium",timeStyle:"short"});
function transitionTimeline(action){timelineDisclosure.open=timelineDisclosureState(timelineDisclosure.open,action)}
function lockView(stream){return stream?.decisionLock!==undefined?stream.decisionLock:stream?.lock||null}
function canDecide(stream){return stream?.status===undefined?stream?.needsDon===true:stream?.status==="needs_decision"}
function streamAbout(stream){return typeof stream.about==="string"?stream.about:typeof stream.summary==="string"?stream.summary:""}
function timelineEntries(stream){if(Array.isArray(stream.timeline))return stream.timeline.filter(entry=>entry&&typeof entry.at==="string"&&typeof entry.text==="string");if(Array.isArray(stream.history))return stream.history.filter(text=>typeof text==="string").map(text=>({at:stream.updatedAt,text}));return []}
function formatManila(at){const date=new Date(at);return Number.isNaN(date.getTime())?at+" · Manila/UTC+8":fmt.format(date)+" · Manila/UTC+8"}
function lockStatus(lock){return lock?.status||"unlocked"}
function choiceForLock(stream,lock){return stream?.choices?.find(choice=>choice.id===lock?.choiceId&&choice.value===lock?.value)||null}
function deliveryLabel(lock){if(!lock)return "";if(lock.status==="failed")return "Delivery failed"+(lock.error?": "+lock.error:"");if(lock.status==="pending")return "Delivery pending";return "Delivery submitted"}
function statusLabel(stream){if(stream?.status==="needs_decision"||stream?.needsDon===true)return "Needs decision";if(stream?.status==="no_action")return "No action";return "Ongoing"}
function addChip(parent,text,className){const chip=document.createElement("span");chip.className="chip "+className;chip.textContent=text;parent.append(chip)}
function makeCard(stream){const content=getStreamCardContent(stream);const card=document.createElement("button");card.className="stream";card.type="button";card.dataset.needsDon=String(stream.needsDon===true);const eyebrow=document.createElement("span");eyebrow.className="eyebrow";const owner=document.createElement("b");owner.textContent=content.ownerBot;const chips=document.createElement("span");chips.className="chips";addChip(chips,statusLabel(stream),content.status==="needs_decision"?"status-needs":content.status==="no_action"?"status-no-action":"status-ongoing");const lock=lockView(stream);if(content.deliveryStatus)addChip(chips,deliveryLabel(lock),"delivery-"+content.deliveryStatus);eyebrow.append(owner,chips);const title=document.createElement("h3");title.textContent=content.title;const about=document.createElement("span");about.className="summary";about.textContent=content.about;const meta=document.createElement("span");meta.className="card-meta";const priority=document.createElement("span");priority.className="priority";priority.textContent="P"+String(content.priority);const updated=document.createElement("time");updated.dateTime=content.updatedAt;updated.textContent="Updated "+formatManila(content.updatedAt);meta.append(priority,updated);card.append(eyebrow,title,about,meta);card.onclick=()=>open(stream);return card}
function makeSection(title,streams,emptyText){const section=document.createElement("section");section.className="stream-section";section.dataset.section=title.toLowerCase().replaceAll(" ","-");const heading=document.createElement("h2");heading.className="section-heading";heading.textContent=title+" ("+streams.length+")";section.append(heading);if(!streams.length){const empty=document.createElement("p");empty.className="section-empty";empty.textContent=emptyText;section.append(empty);return section}streams.forEach(stream=>section.append(makeCard(stream)));return section}
function render(){const grouped=groupStreamsForDisplay(state.streams,new Date());const visible=grouped.needsYou.concat(grouped.recentDecisions,grouped.elsewhere);document.querySelector("#count").textContent=visible.length+" stream"+(visible.length===1?"":"s");const sections=[makeSection("Needs you",grouped.needsYou,"No stream needs your attention.")];if(grouped.recentDecisions.length)sections.push(makeSection("Recent decisions",grouped.recentDecisions,"No recent decisions."));sections.push(makeSection("Elsewhere",grouped.elsewhere,"Nothing else is active."));list.replaceChildren(...sections)}
function setNotice(text,isError){notice.textContent=text;notice.className=isError?"notice error":"notice"}
function canSubmit(){return Boolean(state.choice||freeTextInput.value.trim())}
function updateChoicePressed(){document.querySelectorAll("#choices .choice").forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.choiceId===state.choice?.id&&button.dataset.choiceValue===state.choice?.value)))}
function renderChoices(stream,lock){const choices=document.querySelector("#choices");choices.replaceChildren();const recordedChoice=choiceForLock(stream,lock);(Array.isArray(stream.choices)?stream.choices:[]).forEach(choice=>{const button=document.createElement("button");button.className="choice"+(choice.recommended?" recommended":"");button.type="button";button.dataset.choiceId=choice.id;button.dataset.choiceValue=choice.value;button.setAttribute("aria-pressed",String(Boolean(lock&&recordedChoice&&recordedChoice.id===choice.id&&recordedChoice.value===choice.value)));const label=document.createElement("span");label.textContent=choice.label;button.append(label);if(choice.recommended){const recommended=document.createElement("span");recommended.className="choice-recommended";recommended.textContent="Recommended";button.append(recommended)}button.disabled=!canDecide(stream)||Boolean(lock)||state.busy;button.onclick=()=>{if(!canDecide(state.selected)||lockView(state.selected)||state.busy)return;state.choice=choice;updateChoicePressed();submitButton.disabled=!canSubmit()};choices.append(button)})}
function renderTimeline(stream){const history=document.querySelector("#history");const entries=timelineEntries(stream);timelineSummary.textContent="Timeline · "+entries.length+" update"+(entries.length===1?"":"s")+" · Manila/UTC+8";history.replaceChildren();if(!entries.length){const empty=document.createElement("li");empty.className="section-empty";empty.textContent="No timeline updates yet · Manila/UTC+8";history.append(empty);return}entries.forEach(entry=>{const item=document.createElement("li");const time=document.createElement("time");time.dateTime=entry.at;time.textContent=formatManila(entry.at);item.append(time,document.createTextNode(entry.text));history.append(item)})}
function renderDetail(options={}){const stream=state.selected;if(!stream)return;const lock=lockView(stream);const canMakeDecision=canDecide(stream)||Boolean(lock);const savedNotice=options.preserveNotice?notice.textContent:null;const savedError=options.preserveNotice&&notice.classList.contains("error");document.querySelector("#meta").textContent=stream.ownerBot+" · "+stream.status;document.querySelector("#title").textContent=stream.title;document.querySelector("#summary").textContent=streamAbout(stream);renderTimeline(stream);if(lock)state.decisionId=lock.decisionId;decisionPanel.hidden=!canMakeDecision;noDecision.hidden=canMakeDecision;renderChoices(stream,lock);if(lock)freeTextInput.value=lock.freeText;const locked=Boolean(lock);freeTextInput.disabled=!canDecide(stream)||locked||state.busy;submitButton.textContent=lockStatus(lock)==="pending"?"Decision pending":lockStatus(lock)==="submitted"?"Decision sent":lockStatus(lock)==="failed"?"Delivery failed":"Send decision";submitButton.disabled=!canDecide(stream)||locked||state.busy||!canSubmit();retryButton.textContent=lock?.status==="pending"?"Retry pending delivery":lock?.status==="failed"?"Retry failed delivery":"Retry decision";retryButton.hidden=!lock||(lock.status!=="pending"&&lock.status!=="failed");retryButton.disabled=state.busy;changeButton.hidden=!lock||lock.status==="pending";changeButton.disabled=state.busy;const recorded=document.querySelector("#recorded");recorded.hidden=!lock;if(lock){const recordedChoice=choiceForLock(stream,lock);document.querySelector("#recordedAnswer").textContent=recordedChoice?recordedChoice.label+" ("+lock.value+")":"Custom response ("+lock.value+")";document.querySelector("#recordedText").textContent=lock.freeText?"Note: "+lock.freeText:"No additional text recorded.";const delivery=document.querySelector("#delivery");delivery.className="delivery"+(lock.status==="failed"?" failed":"");delivery.textContent=deliveryLabel(lock);if(lock.kind==="correction")delivery.textContent+=" · correction"}if(options.preserveNotice&&savedNotice!==null){setNotice(savedNotice,savedError)}else if(lock?.status==="failed"){setNotice("Delivery failed. Retry the same decision or change your answer.",true)}else if(lock?.status==="pending"){setNotice("Decision is still sending. Try again shortly.")}else if(lock?.status==="submitted"){setNotice("Decision sent.")}else if(!canMakeDecision){setNotice("No decision needed for this stream.")}else{setNotice("")}}
function open(stream){state.selected=stream;state.choice=null;state.decisionId=null;state.busy=false;freeTextInput.value="";transitionTimeline("new-stream");renderDetail();if(!dialog.open){dialog.showModal()}closeButton.focus()}
async function readError(response,fallback){try{const body=await response.json();if(typeof body.error==="string"&&body.error)return body.error}catch{}return fallback}
async function load(keepStreamId,preserveNotice=false){try{const response=await fetch("/api/streams");if(!response.ok)throw Error("Could not load streams");const streams=await response.json();if(!Array.isArray(streams))throw Error("Could not load streams");state.streams=streams;render();if(keepStreamId&&dialog.open){const selected=state.streams.find(stream=>stream.streamId===keepStreamId);if(selected){transitionTimeline("same-stream-refresh");state.selected=selected;renderDetail({preserveNotice})}}return true}catch(error){if(state.streams.length===0){list.replaceChildren();const failure=document.createElement("p");failure.className="section-empty error";failure.textContent=error instanceof Error?error.message:"Could not load streams";list.append(failure)}return false}}
function applyLiveEnvelope(value){const streams=applyLiveStreams(value);if(!streams)return;const selectedId=state.selected?.streamId;state.streams=streams;render();if(!selectedId||!dialog.open)return;const selected=state.streams.find(stream=>stream.streamId===selectedId);if(selected){state.selected=selected;transitionTimeline("same-stream-refresh");renderDetail({preserveNotice:true})}else{dialog.close()}}
function startLivePolling(){if(livePollTimer!==null)return;livePollTimer=window.setInterval(()=>{void load(state.selected?.streamId,true)},LIVE_POLL_INTERVAL_MS)}
function stopLivePolling(){if(livePollTimer===null)return;window.clearInterval(livePollTimer);livePollTimer=null}
function scheduleLiveReconnect(){startLivePolling();if(liveReconnectTimer!==null)return;const delay=liveReconnectDelay(liveReconnectAttempt++);liveReconnectTimer=window.setTimeout(()=>{liveReconnectTimer=null;connectLive()},delay)}
function connectLive(){if(liveStopped)return;if(typeof WebSocket==="undefined"){startLivePolling();return}if(liveSocket&&(liveSocket.readyState===0||liveSocket.readyState===1))return;let socket;try{const protocol=location.protocol==="https:"?"wss:":"ws:";socket=new WebSocket(protocol+"//"+location.host+"/api/streams/live")}catch{scheduleLiveReconnect();return}liveSocket=socket;socket.onopen=()=>{if(liveSocket!==socket)return;liveReconnectAttempt=0;stopLivePolling()};socket.onmessage=event=>{if(liveSocket!==socket)return;try{applyLiveEnvelope(JSON.parse(event.data))}catch{}};socket.onerror=()=>{if(liveSocket===socket)socket.close()};socket.onclose=()=>{if(liveSocket!==socket)return;liveSocket=null;scheduleLiveReconnect()}}
async function submitDecision(){const stream=state.selected;if(!stream||!canDecide(stream)||state.busy||lockView(stream)||!canSubmit())return;const freeText=freeTextInput.value;const choice=state.choice||{id:"custom",value:"custom"};if(!state.decisionId)state.decisionId=crypto.randomUUID();state.busy=true;setNotice("Sending…");renderDetail({preserveNotice:true});try{const response=await fetch("/api/decisions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({decisionId:state.decisionId,streamId:stream.streamId,choiceId:choice.id,value:choice.value,freeText})});if(response.status===202){setNotice("Decision is still sending. Try again shortly.");await load(stream.streamId,true)}else if(!response.ok){throw Error(await readError(response,"Submission failed"))}else{setNotice("Decision sent.");await load(stream.streamId,true)}}catch(error){setNotice(error instanceof Error?error.message:"Submission failed",true);await load(stream.streamId,true)}finally{state.busy=false;if(state.selected)renderDetail({preserveNotice:true})}}
async function retryDecision(){const stream=state.selected;const lock=stream&&lockView(stream);if(!stream||!lock||!isRetryableDecisionStatus(lock.status)||state.busy)return;state.busy=true;setNotice(lock.status==="pending"?"Retrying pending delivery…":"Retrying failed delivery…");renderDetail({preserveNotice:true});try{const response=await fetch("/api/decisions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({decisionId:lock.decisionId,streamId:stream.streamId,choiceId:lock.choiceId,value:lock.value,freeText:lock.freeText})});if(response.status===202){setNotice("Decision is still sending. Try again shortly.");await load(stream.streamId,true)}else if(!response.ok){throw Error(await readError(response,"Retry failed"))}else{setNotice("Decision sent.");await load(stream.streamId,true)}}catch(error){setNotice(error instanceof Error?error.message:"Retry failed",true);await load(stream.streamId,true)}finally{state.busy=false;if(state.selected)renderDetail({preserveNotice:true})}}
async function changeAnswer(){const stream=state.selected;const lock=stream&&lockView(stream);if(!stream||!lock||lock.status==="pending"||state.busy)return;state.busy=true;setNotice("Unlocking…");renderDetail({preserveNotice:true});try{const response=await fetch("/api/decisions/unlock",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({streamId:stream.streamId,decisionId:lock.decisionId})});if(!response.ok)throw Error(await readError(response,"Could not change the answer"));state.choice=null;state.decisionId=null;freeTextInput.value="";const loaded=await load(stream.streamId,false);if(!loaded)throw Error("Could not reload streams");setNotice("Choose a new answer.")}catch(error){setNotice(error instanceof Error?error.message:"Could not change the answer",true)}finally{state.busy=false;if(state.selected)renderDetail({preserveNotice:true})}}
freeTextInput.oninput=()=>{if(canDecide(state.selected)&&!lockView(state.selected)&&!state.busy)submitButton.disabled=!canSubmit()};closeButton.onclick=()=>dialog.close();dialog.addEventListener("close",()=>{state.selected=null;state.choice=null;state.decisionId=null;state.busy=false;transitionTimeline("close-dialog")});submitButton.onclick=submitDecision;retryButton.onclick=retryDecision;changeButton.onclick=changeAnswer;window.addEventListener("pagehide",()=>{liveStopped=true;if(liveReconnectTimer!==null)window.clearTimeout(liveReconnectTimer);if(livePollTimer!==null)window.clearInterval(livePollTimer);if(liveSocket)liveSocket.close()});void load().then(()=>connectLive());if("serviceWorker"in navigator)navigator.serviceWorker.register("/service-worker.js");
</script></body></html>`;
