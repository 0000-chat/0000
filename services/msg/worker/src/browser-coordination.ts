/** Browser-only coordination helpers. Management URLs stay in the room owner's private storage/UI. */
export interface CoordinationBrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CoordinationManagementUrlResult {
  readonly normalized?: string;
  readonly reason?: "invalid" | "cross_origin" | "wrong_room";
}

export interface CoordinationManagementRetention {
  readonly key: string;
  readonly normalized?: string;
  readonly retained: boolean;
  readonly save_url?: string;
  readonly message: string;
}

interface CoordinationElement {
  append(...nodes: CoordinationElement[]): void;
  className: string;
  dataset: Record<string, string>;
  disabled: boolean;
  href: string;
  hidden: boolean;
  onclick: (() => void) | null;
  rel: string;
  replaceChildren(...nodes: CoordinationElement[]): void;
  select(): void;
  target: string;
  textContent: string | null;
  type: string;
  value: string;
  addEventListener(type: string, listener: (event: { preventDefault(): void }) => void): void;
}

interface CoordinationDocument {
  readonly body?: { readonly dataset?: Record<string, string> };
  createElement(tagName: string): CoordinationElement;
  querySelector<T extends CoordinationElement>(selector: string): T | null;
  querySelectorAll(selector: string): Iterable<CoordinationElement>;
}

interface CoordinationGlobal {
  readonly document?: CoordinationDocument;
  readonly crypto: { randomUUID(): string };
  readonly sessionStorage: CoordinationBrowserStorage;
}

type CoordinationAttempt = {
  readonly client_retry_id: string;
  readonly payload: Record<string, unknown>;
  readonly revision_proposal_id?: string;
  readonly revision_kind?: "request.create" | "request.progress" | "panel.replace";
};

/** Accepts only the room's same-origin management URL, with no query, fragment, or credentials. */
export function normalizeCoordinationManagementUrl(value: string, origin: string, room: string): CoordinationManagementUrlResult {
  const result = createCoordinationBrowserHelpers().normalize(value, origin, room);
  return result ? { normalized: result } : { reason: "invalid" };
}

/** Retains an owner capability only after exact-origin/room validation; storage failure keeps a private save affordance. */
export function retainCoordinationManagementUrl(storage: CoordinationBrowserStorage, value: string, origin: string, room: string): CoordinationManagementRetention {
  const result = createCoordinationBrowserHelpers().retain(value, origin, room, storage);
  return {
    key: result.storageKey,
    ...(result.normalized ? { normalized: result.normalized } : {}),
    ...(result.saveUrl ? { save_url: result.saveUrl } : {}),
    message: result.message,
    retained: result.retained,
  };
}

/** Reads a retained URL defensively; stale or malformed storage is ignored. */
export function readCoordinationManagementUrl(storage: CoordinationBrowserStorage, origin: string, room: string): string | undefined {
  return createCoordinationBrowserHelpers().read(origin, room, storage);
}

/** Creates browser-safe helpers for the served script without capturing Worker module state. */
export function createCoordinationBrowserHelpers() {
  const key = (room: string) => `0000:coordination-management-url:v1:${room}`;
  const normalize = (value: string, origin: string, room: string) => {
    try {
      const parsed = new URL(value), expected = new URL(origin).origin;
      if (parsed.origin !== expected || parsed.username || parsed.password || parsed.search || parsed.hash) return;
      const parts = parsed.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
      if (parts.length !== 3 || parts[0] !== "manage" || parts[1] !== room || !parts[2]) return;
      return `${expected}/manage/${encodeURIComponent(room)}/${encodeURIComponent(parts[2])}`;
    } catch { return; }
  };
  const retain = (value: string, origin: string, room: string, storage: CoordinationBrowserStorage) => {
    const normalized = normalize(value, origin, room), storageKey = key(room);
    if (!normalized) return { retained: false, storageKey, message: "Enter the private management URL for this room." };
    try {
      storage.setItem(storageKey, normalized);
      return { retained: true, storageKey, normalized, message: "Private owner access is ready in this session/tab." };
    } catch {
      return { retained: false, storageKey, normalized, saveUrl: normalized, message: "This browser could not retain the private owner URL. Save it privately before leaving this page." };
    }
  };
  const read = (origin: string, room: string, storage: CoordinationBrowserStorage) => {
    try { const value = storage.getItem(key(room)); return value ? normalize(value, origin, room) : undefined; } catch { return; }
  };
  return { key, normalize, retain, read };
}

/** Served coordination UI: public proposal/review plus private owner publication. */
export function bootCoordinationBrowser(): void {
  const browserGlobal = globalThis as unknown as CoordinationGlobal;
  const documentObject = browserGlobal.document;
  const room = documentObject?.body?.dataset?.room;
  if (!documentObject || !room) return;
  const panel = documentObject.querySelector<CoordinationElement>("#coordination-panel");
  if (!panel) return;
  const helpers = (globalThis as typeof globalThis & { __msgCoordinationHelpers?: ReturnType<typeof createCoordinationBrowserHelpers> }).__msgCoordinationHelpers;
  if (!helpers) return;
  const api = `/${encodeURIComponent(room)}/coordination`;
  const storage = { getItem: (key: string) => browserGlobal.sessionStorage.getItem(key), setItem: (key: string, value: string) => browserGlobal.sessionStorage.setItem(key, value) };
  const get = <T extends CoordinationElement>(selector: string) => documentObject.querySelector<T>(selector);
  const status = get<CoordinationElement>("#coordination-status");
  const overview = get<CoordinationElement>("#coordination-overview");
  const pinnedOverview = get<CoordinationElement>("#coordination-pinned-panel");
  const review = get<CoordinationElement>("#coordination-review");
  const actor = get<CoordinationElement>("#coordination-actor");
  const title = get<CoordinationElement>("#coordination-title");
  const purpose = get<CoordinationElement>("#coordination-purpose");
  const owner = get<CoordinationElement>("#coordination-owner");
  const requestedOutput = get<CoordinationElement>("#coordination-requested-output");
  const unknowns = get<CoordinationElement>("#coordination-unknowns");
  const criteria = get<CoordinationElement>("#coordination-completion-criteria");
  const impact = get<CoordinationElement>("#coordination-decision-impact");
  const sources = get<CoordinationElement>("#coordination-sources");
  const progressForm = get<CoordinationElement>("#coordination-progress-form");
  const progressActor = get<CoordinationElement>("#coordination-progress-actor");
  const progressRequest = get<CoordinationElement>("#coordination-progress-request");
  const progressStatus = get<CoordinationElement>("#coordination-progress-status");
  const progressBlockers = get<CoordinationElement>("#coordination-progress-blockers");
  const progressArtifact = get<CoordinationElement>("#coordination-progress-artifact");
  const progressLocation = get<CoordinationElement>("#coordination-progress-location");
  const progressVerification = get<CoordinationElement>("#coordination-progress-verification");
  const progressEvidenceBlockers = get<CoordinationElement>("#coordination-progress-evidence-blockers");
  const progressUnverified = get<CoordinationElement>("#coordination-progress-unverified");
  const progressReopenReason = get<CoordinationElement>("#coordination-progress-reopen-reason");
  const progressSources = get<CoordinationElement>("#coordination-progress-sources");
  const progressSubmit = get<CoordinationElement>("#coordination-progress-submit");
  const progressNew = get<CoordinationElement>("#coordination-progress-new");
  const filterForm = get<CoordinationElement>("#coordination-filter-form");
  const filterOwnerLabel = get<CoordinationElement>("#coordination-filter-owner-label");
  const filterStatus = get<CoordinationElement>("#coordination-filter-status");
  const proposalForm = get<CoordinationElement>("#coordination-proposal-form");
  const ownerForm = get<CoordinationElement>("#coordination-owner-form");
  const ownerUrl = get<CoordinationElement>("#coordination-owner-url");
  const proposalSubmit = get<CoordinationElement>("#coordination-proposal-submit");
  const proposalNew = get<CoordinationElement>("#coordination-proposal-new");
  const ownerSave = get<CoordinationElement>("#coordination-owner-save");
  const panelForm = get<CoordinationElement>("#coordination-panel-form");
  const panelActor = get<CoordinationElement>("#coordination-panel-actor");
  const panelPurpose = get<CoordinationElement>("#coordination-panel-purpose");
  const panelPhase = get<CoordinationElement>("#coordination-panel-phase");
  const panelArtifacts = get<CoordinationElement>("#coordination-panel-artifacts");
  const panelNextActions = get<CoordinationElement>("#coordination-panel-next-actions");
  const panelSources = get<CoordinationElement>("#coordination-panel-sources");
  const panelSubmit = get<CoordinationElement>("#coordination-panel-submit");
  const panelNew = get<CoordinationElement>("#coordination-panel-new");
  const coordinationRefresh = get<CoordinationElement>("#coordination-refresh");
  const proposalRetryKey = `0000:coordination-proposal-attempt:v1:${room}`;
  const progressRetryKey = `0000:coordination-progress-attempt:v1:${room}`;
  const panelRetryKey = `0000:coordination-panel-attempt:v1:${room}`;
  const publicationRetryKey = `0000:coordination-publication-attempt:v1:${room}`;
  let currentOverview: Record<string, unknown> | undefined;
  let currentProposal: { proposal_id: string; revision: number; base_revision: number; kind?: string } | undefined;
  let revisionProposalId: string | undefined;
  let revisionKind: "request.create" | "request.progress" | "panel.replace" | undefined;
  let memoryProposalAttempt: CoordinationAttempt | undefined;
  let memoryProgressAttempt: CoordinationAttempt | undefined;
  let memoryPanelAttempt: CoordinationAttempt | undefined;
  let memoryPublicationAttempt: CoordinationAttempt | undefined;
  let busy = false;
  let ownerManagementUrl = helpers.read(location.origin, room, storage);

  const say = (message: string) => { if (status) status.textContent = message; };
  const showNew = (operation: "proposal" | "progress" | "panel", visible: boolean) => { const button = operation === "proposal" ? proposalNew : operation === "progress" ? progressNew : panelNew; if (button) button.hidden = !visible; };
  const useEditedFields = (operation: "proposal" | "progress" | "panel") => {
    const attempt = parseAttempt(operation);
    if (attempt?.revision_proposal_id) {
      revisionProposalId = attempt.revision_proposal_id;
      revisionKind = attempt.revision_kind;
    }
    clearAttempt(operation);
    showNew(operation, false);
    say(`The previous ${operation === "progress" ? "progress report" : "proposal"} was rejected. Edited fields will be submitted as a new attempt.`);
  };
  const lines = (value: string | undefined) => (value ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const parseAttempt = (operation: "proposal" | "progress" | "panel" | "publication"): CoordinationAttempt | undefined => {
    const memory = operation === "proposal" ? memoryProposalAttempt : operation === "progress" ? memoryProgressAttempt : operation === "panel" ? memoryPanelAttempt : memoryPublicationAttempt;
    if (memory) return memory;
    try { const value = JSON.parse(browserGlobal.sessionStorage.getItem(operation === "proposal" ? proposalRetryKey : operation === "progress" ? progressRetryKey : operation === "panel" ? panelRetryKey : publicationRetryKey) ?? "null"); return value?.client_retry_id && value?.payload ? value : undefined; } catch { return; }
  };
  const saveAttempt = (operation: "proposal" | "progress" | "panel" | "publication", payload: Record<string, unknown>, metadata: Pick<CoordinationAttempt, "revision_proposal_id" | "revision_kind"> = {}) => {
    const attempt: CoordinationAttempt = { client_retry_id: String(payload.client_retry_id), payload, ...metadata };
    if (operation === "proposal") memoryProposalAttempt = attempt; else if (operation === "progress") memoryProgressAttempt = attempt; else if (operation === "panel") memoryPanelAttempt = attempt; else memoryPublicationAttempt = attempt;
    try { browserGlobal.sessionStorage.setItem(operation === "proposal" ? proposalRetryKey : operation === "progress" ? progressRetryKey : operation === "panel" ? panelRetryKey : publicationRetryKey, JSON.stringify(attempt)); } catch { /* The in-memory attempt remains available. */ }
  };
  const clearAttempt = (operation: "proposal" | "progress" | "panel" | "publication") => {
    if (operation === "proposal") memoryProposalAttempt = undefined; else if (operation === "progress") memoryProgressAttempt = undefined; else if (operation === "panel") memoryPanelAttempt = undefined; else memoryPublicationAttempt = undefined;
    try { browserGlobal.sessionStorage.setItem(operation === "proposal" ? proposalRetryKey : operation === "progress" ? progressRetryKey : operation === "panel" ? panelRetryKey : publicationRetryKey, ""); } catch { /* Ignore unavailable storage. */ }
  };
  const errorMessage = async (response: Response) => {
    const value = await response.json().catch(() => ({})) as { error?: { code?: string; current_revision?: number; message?: string } };
    if (value.error?.code === "stale_revision" && typeof value.error.current_revision === "number") return `The published revision is now ${value.error.current_revision}. Review and explicitly rebase before retrying.`;
    if (typeof value.error?.message === "string" && value.error.message.length > 0 && value.error.message.length <= 240) return value.error.message;
    return "The coordination request could not be completed. The same attempt is preserved for retry.";
  };
  const renderOverview = (value: Record<string, unknown>, panelDetail?: Record<string, unknown>) => {
    if (!overview && !pinnedOverview) return;
    currentOverview = value;
    const pending = Array.isArray(value.pending_proposals) ? value.pending_proposals : [];
    const published = Array.isArray(value.published_requests) ? value.published_requests : [];
    const panelValue = value.panel && typeof value.panel === "object" && !Array.isArray(value.panel) ? value.panel as Record<string, unknown> : undefined;
    const exactPanel = panelDetail ?? panelValue;
    const panelBody = exactPanel?.body && typeof exactPanel.body === "object" && !Array.isArray(exactPanel.body) ? exactPanel.body as Record<string, unknown> : exactPanel;
    if (pinnedOverview) {
      pinnedOverview.replaceChildren();
      const heading = documentObject.createElement("strong"); heading.textContent = "Room panel"; pinnedOverview.append(heading);
      const revision = documentObject.createElement("p"); revision.textContent = panelValue ? `Global publication revision ${String(value.published_revision ?? 0)} · event cursor ${String(value.coordination_cursor ?? 0)} · panel revision ${String(panelValue.published_revision ?? "?")} · owner label ${String(panelValue.owner_label ?? "unknown")} (self-declared)` : "Panel unset; no transcript state is inferred."; pinnedOverview.append(revision);
      const purposeText = documentObject.createElement("p"); purposeText.textContent = `Purpose: ${String(panelBody?.purpose ?? "unset")} · Phase: ${String(panelBody?.phase ?? "unset")}`; pinnedOverview.append(purposeText);
      const artifactItems = Array.isArray(panelValue?.artifacts) ? panelValue.artifacts : [];
      const artifactCount = Number(panelValue?.artifact_count ?? artifactItems.length);
      const artifacts = documentObject.createElement("p"); artifacts.textContent = artifactCount === 0 ? "Canonical artifacts: none" : `Canonical artifacts (${artifactCount}; showing ${artifactItems.length}):`; pinnedOverview.append(artifacts);
      for (const item of artifactItems.slice(0, 5)) {
        if (!item || typeof item !== "object") continue;
        const artifact = item as Record<string, unknown>;
        const link = documentObject.createElement("a"); link.href = String(artifact.url ?? ""); link.textContent = `${String(artifact.title ?? "Artifact")} [${String(artifact.role ?? "unspecified role")}]`; link.target = "_blank"; link.rel = "noreferrer"; pinnedOverview.append(link);
      }
      if (artifactCount > artifactItems.length) { const more = documentObject.createElement("p"); more.textContent = `${artifactCount - artifactItems.length} more artifacts; inspect the exact panel.`; pinnedOverview.append(more); }
      const actionItems = Array.isArray(panelValue?.next_actions) ? panelValue.next_actions : [];
      const actionCount = Number(panelValue?.next_action_count ?? actionItems.length);
      const actions = documentObject.createElement("p"); actions.textContent = actionCount === 0 ? "Next actions: none" : `Next actions (${actionCount}; showing ${actionItems.length}):`; pinnedOverview.append(actions);
      for (const item of actionItems.slice(0, 5)) {
        if (!item || typeof item !== "object") continue;
        const action = item as Record<string, unknown>;
        const line = documentObject.createElement("p"); line.textContent = `${String(action.description ?? "")} (${String(action.owner_label ?? "")})`; pinnedOverview.append(line);
      }
      if (actionCount > actionItems.length) { const more = documentObject.createElement("p"); more.textContent = `${actionCount - actionItems.length} more actions; inspect the exact panel.`; pinnedOverview.append(more); }
      for (const [label, href] of [["Inspect exact panel", value.panel_url], ["Panel history", value.panel_history_url]] as const) {
        if (typeof href !== "string") continue;
        const link = documentObject.createElement("a"); link.href = href; link.textContent = label; link.target = "_blank"; link.rel = "noreferrer"; pinnedOverview.append(link);
      }
      const open = documentObject.createElement("button"); open.type = "button"; open.className = "button compact"; open.textContent = "Review or edit panel"; open.onclick = () => { (panel as CoordinationElement & { showModal?: () => void }).showModal?.(); }; pinnedOverview.append(open);
    }
    if (panelBody && !parseAttempt("panel")) {
      if (panelPurpose) panelPurpose.value = typeof panelBody.purpose === "string" ? panelBody.purpose : "";
      if (panelPhase) panelPhase.value = typeof panelBody.phase === "string" ? panelBody.phase : "";
      if (panelArtifacts) panelArtifacts.value = Array.isArray(panelBody.artifacts) ? panelBody.artifacts.map((item) => item && typeof item === "object" ? `${String((item as Record<string, unknown>).title ?? "")} | ${String((item as Record<string, unknown>).role ?? "")} | ${String((item as Record<string, unknown>).url ?? "")}` : "").filter(Boolean).join("\n") : "";
      if (panelNextActions) panelNextActions.value = Array.isArray(panelBody.next_actions) ? panelBody.next_actions.map((item) => item && typeof item === "object" ? `${String((item as Record<string, unknown>).description ?? "")} | ${String((item as Record<string, unknown>).owner_label ?? "")}` : "").filter(Boolean).join("\n") : "";
    }
    if (!overview) return;
    overview.replaceChildren();
    if (progressRequest) {
      progressRequest.replaceChildren();
      for (const item of published) {
        if (!item || typeof item !== "object") continue;
        const record = item as { request_id?: string; title?: string; body?: { title?: string }; status?: string };
        if (!record.request_id) continue;
        const option = documentObject.createElement("option"); option.value = record.request_id; option.textContent = `${record.title || record.body?.title || "Untitled request"} · canonical ${record.status || "open"}`; progressRequest.append(option);
      }
    }
    const pendingCount = Number(value.pending_proposal_count ?? pending.length), publishedCount = Number(value.published_request_count ?? published.length);
    const statusCounts = value.request_status_counts && typeof value.request_status_counts === "object" && !Array.isArray(value.request_status_counts) ? value.request_status_counts as Record<string, unknown> : {};
    const heading = documentObject.createElement("p"); heading.textContent = `${pendingCount} pending proposal${pendingCount === 1 ? "" : "s"}; ${publishedCount} published request${publishedCount === 1 ? "" : "s"}; status counts open ${String(statusCounts.open ?? 0)}, in progress ${String(statusCounts.in_progress ?? 0)}, blocked ${String(statusCounts.blocked ?? 0)}, done ${String(statusCounts.done ?? 0)}, withdrawn ${String(statusCounts.withdrawn ?? 0)}; global publication revision ${String(value.published_revision ?? 0)}; event cursor ${String(value.coordination_cursor ?? 0)}.`; overview.append(heading);
    for (const [label, key] of [["Browse proposals", "proposals_url"], ["Browse published requests", "requests_url"], ["Inspect panel", "panel_url"], ["Panel history", "panel_history_url"]] as const) {
      if (typeof value[key] !== "string") continue;
      const link = documentObject.createElement("a"); link.href = String(value[key]); link.textContent = label; link.target = "_blank"; link.rel = "noreferrer"; overview.append(link);
    }
    for (const item of pending) {
      if (!item || typeof item !== "object") continue;
      const record = item as { title?: string; proposal_id?: string; revision?: number; status?: string; kind?: string; detail_url?: string };
      const row = documentObject.createElement("div"); row.className = "coordination-item";
      const text = documentObject.createElement("span"); text.textContent = `${record.kind === "panel.replace" ? "Room panel replacement" : record.title || "Untitled proposal"} · revision ${record.revision ?? "?"} · ${record.kind === "request.progress" ? "reported progress" : record.status || "pending"}`; row.append(text);
      if (record.detail_url) { const link = documentObject.createElement("a"); link.href = record.detail_url; link.textContent = "Review evidence"; link.target = "_blank"; link.rel = "noreferrer"; row.append(link); }
      if (record.proposal_id) { const button = documentObject.createElement("button"); button.type = "button"; button.className = "button compact"; button.textContent = "Review exact revision"; button.onclick = () => { void reviewProposal(record.proposal_id!, Number(record.revision)); }; row.append(button); }
      overview.append(row);
    }
    for (const item of published) {
      if (!item || typeof item !== "object") continue;
      const record = item as { title?: string; body?: { title?: string }; published_revision?: number; status?: string; detail_url?: string };
      const row = documentObject.createElement("div"); row.className = "coordination-item";
      const text = documentObject.createElement("span"); text.textContent = `${record.title || record.body?.title || "Untitled request"} · canonical status ${record.status || "open"} · published revision ${record.published_revision ?? "?"}`; row.append(text);
      if (record.detail_url) { const link = documentObject.createElement("a"); link.href = record.detail_url; link.textContent = "Inspect request"; link.target = "_blank"; link.rel = "noreferrer"; row.append(link); }
      overview.append(row);
    }
    if (!pending.length && !published.length) { const empty = documentObject.createElement("p"); empty.textContent = "No tracked requests yet. Submit a proposal with source message IDs to begin review."; overview.append(empty); }
  };
  const renderLoadedOverview = async (value: Record<string, unknown>) => {
    let panelDetail: Record<string, unknown> | undefined;
    if (typeof value.panel_url === "string") {
      try {
        const panelResponse = await fetch(value.panel_url, { headers: { accept: "application/json" } });
        if (panelResponse.ok) {
          const panelPayload = await panelResponse.json() as { panel?: unknown };
          if (panelPayload.panel && typeof panelPayload.panel === "object" && !Array.isArray(panelPayload.panel)) panelDetail = panelPayload.panel as Record<string, unknown>;
        }
      } catch { /* The bounded overview remains usable when the exact panel is temporarily unavailable. */ }
    }
    renderOverview(value, panelDetail);
  };
  const loadOverview = async () => {
    try {
      const response = await fetch(api, { headers: { accept: "application/json" } });
      if (!response.ok) throw Error();
      const value = await response.json() as Record<string, unknown>;
      const ownerLabel = filterOwnerLabel?.value.trim() || "";
      const selectedStatus = filterStatus?.value || "";
      if (!ownerLabel && !selectedStatus) { await renderLoadedOverview(value); return; }
      const requestsUrl = new URL(`${api}/requests`, location.origin);
      requestsUrl.searchParams.set("limit", "20");
      if (ownerLabel) requestsUrl.searchParams.set("owner_label", ownerLabel);
      if (selectedStatus) requestsUrl.searchParams.set("status", selectedStatus);
      const requestsResponse = await fetch(`${requestsUrl.pathname}${requestsUrl.search}`, { headers: { accept: "application/json" } });
      if (!requestsResponse.ok) throw Error();
      const requests = await requestsResponse.json() as { requests?: readonly Record<string, unknown>[] };
      await renderLoadedOverview({ ...value, published_requests: requests.requests ?? [], published_request_count: (requests.requests ?? []).length });
    } catch { say("Coordination details are temporarily unavailable. Retry when the room is reachable."); }
  };
  const panelArtifactLines = (value: string | undefined) => lines(value).map((line) => {
    const parts = line.split("|").map((part) => part.trim());
    return { title: parts[0] ?? "", role: parts[1] ?? "", url: parts.slice(2).join("|") };
  });
  const panelActionLines = (value: string | undefined) => lines(value).map((line) => {
    const parts = line.split("|").map((part) => part.trim());
    return { description: parts[0] ?? "", owner_label: parts.slice(1).join("|") };
  });
  const makePanel = () => {
    const attempt = parseAttempt("panel"); if (attempt) return attempt.payload;
    const payload = {
      actor_label: panelActor?.value.trim() || "Anonymous participant",
      base_revision: Number(currentOverview?.published_revision ?? 0),
      body: { artifacts: panelArtifactLines(panelArtifacts?.value), next_actions: panelActionLines(panelNextActions?.value), phase: panelPhase?.value.trim() || null, purpose: panelPurpose?.value.trim() || null },
      client_retry_id: browserGlobal.crypto.randomUUID(),
      kind: "panel.replace",
      source_message_ids: lines(panelSources?.value),
    };
    saveAttempt("panel", payload, { revision_proposal_id: revisionProposalId, revision_kind: revisionKind }); return payload;
  };
  const submitPanel = async () => {
    if (busy) return; busy = true; if (panelSubmit) panelSubmit.disabled = true;
    const payload = makePanel();
    try {
      const attempt = parseAttempt("panel");
      const targetProposalId = attempt?.revision_proposal_id ?? revisionProposalId;
      const targetKind = attempt?.revision_kind ?? revisionKind;
      const endpoint = targetProposalId && targetKind === "panel.replace" ? `${api}/proposals/${encodeURIComponent(targetProposalId)}/revisions` : `${api}/proposals`;
      const response = await fetch(endpoint, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) {
        const message = await errorMessage(response);
        if (response.status === 400 || response.status === 413) { showNew("panel", true); throw Error(`${message} Edit the fields, then choose the new-submission action; retry keeps this attempt frozen.`); }
        throw Error(message);
      }
      const receipt = await response.json().catch(() => undefined) as { proposal?: { proposal_id?: string; revision?: number } } | undefined;
      if (!receipt?.proposal?.proposal_id || !Number.isSafeInteger(receipt.proposal.revision)) throw Error("The panel proposal receipt was incomplete. The same attempt is preserved for retry.");
      clearAttempt("panel"); showNew("panel", false); revisionProposalId = undefined; revisionKind = undefined; say("Panel replacement submitted for owner review."); await loadOverview();
    } catch (error) { say(error instanceof Error && error.message ? error.message : "Panel proposal is pending. Retry this same attempt when the network is ready."); }
    finally { busy = false; if (panelSubmit) panelSubmit.disabled = false; }
  };
  const makeProposal = () => {
    const attempt = parseAttempt("proposal"); if (attempt) return attempt.payload;
    const payload = {
      actor_label: actor?.value.trim() || "Anonymous participant",
      base_revision: Number(currentOverview?.published_revision ?? 0),
      body: { completion_criteria: lines(criteria?.value), decision_impact: impact?.value.trim() || "", owner_label: owner?.value.trim() || "", purpose: purpose?.value.trim() || "", requested_output: requestedOutput?.value.trim() || "", title: title?.value.trim() || "", unknowns: lines(unknowns?.value) },
      client_retry_id: browserGlobal.crypto.randomUUID(),
      kind: "request.create",
      source_message_ids: lines(sources?.value),
    };
    saveAttempt("proposal", payload, { revision_proposal_id: revisionProposalId, revision_kind: revisionKind }); return payload;
  };
  const submitProposal = async () => {
    if (busy) return; busy = true; if (proposalSubmit) proposalSubmit.disabled = true;
    const payload = makeProposal();
    try {
      const attempt = parseAttempt("proposal");
      const targetProposalId = attempt?.revision_proposal_id ?? revisionProposalId;
      const targetKind = attempt?.revision_kind ?? revisionKind;
      const endpoint = targetProposalId && targetKind !== "request.progress" ? `${api}/proposals/${encodeURIComponent(targetProposalId)}/revisions` : `${api}/proposals`;
      const response = await fetch(endpoint, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) {
        const message = await errorMessage(response);
        if (response.status === 400 || response.status === 413) { showNew("proposal", true); throw Error(`${message} Edit the fields, then choose the new-submission action; retry keeps this attempt frozen.`); }
        throw Error(message);
      }
      const receipt = await response.json().catch(() => undefined) as { proposal?: { proposal_id?: string; revision?: number } } | undefined;
      if (!receipt?.proposal?.proposal_id || !Number.isSafeInteger(receipt.proposal.revision)) throw Error("The proposal receipt was incomplete. The same attempt is preserved for retry.");
      clearAttempt("proposal"); showNew("proposal", false); revisionProposalId = undefined; revisionKind = undefined; say("Proposal submitted for owner review."); await loadOverview();
    } catch (error) { say(error instanceof Error && error.message ? error.message : "The proposal is pending. Retry this same attempt when the network is ready."); }
    finally { busy = false; if (proposalSubmit) proposalSubmit.disabled = false; }
  };
  const makeProgress = () => {
    const attempt = parseAttempt("progress"); if (attempt) return attempt.payload;
    const artifactUrl = progressArtifact?.value.trim() || "";
    const evidence = artifactUrl ? [{
      artifact_url: artifactUrl,
      ...(progressLocation?.value.trim() ? { location: progressLocation.value.trim() } : {}),
      reported_verification: progressVerification?.value.trim() || "Reported by the participant; the service does not independently verify artifacts.",
      remaining_blockers: lines(progressEvidenceBlockers?.value),
    }] : [];
    const payload = {
      actor_label: progressActor?.value.trim() || "Anonymous participant",
      base_revision: Number(currentOverview?.published_revision ?? 0),
      body: {
        blockers: lines(progressBlockers?.value),
        evidence,
        request_id: progressRequest?.value.trim() || "",
        status: progressStatus?.value || "open",
        ...(progressUnverified?.value.trim() ? { unverified_explanation: progressUnverified.value.trim() } : {}),
        ...(progressReopenReason?.value.trim() ? { reopen_reason: progressReopenReason.value.trim() } : {}),
      },
      client_retry_id: browserGlobal.crypto.randomUUID(),
      kind: "request.progress",
      source_message_ids: lines(progressSources?.value),
    };
    saveAttempt("progress", payload, { revision_proposal_id: revisionProposalId, revision_kind: revisionKind }); return payload;
  };
  const submitProgress = async () => {
    if (busy) return; busy = true; if (progressSubmit) progressSubmit.disabled = true;
    const payload = makeProgress();
    try {
      const attempt = parseAttempt("progress");
      const targetProposalId = attempt?.revision_proposal_id ?? revisionProposalId;
      const targetKind = attempt?.revision_kind ?? revisionKind;
      const endpoint = targetProposalId && targetKind === "request.progress" ? `${api}/proposals/${encodeURIComponent(targetProposalId)}/revisions` : `${api}/proposals`;
      const response = await fetch(endpoint, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) {
        const message = await errorMessage(response);
        if (response.status === 400 || response.status === 413) { showNew("progress", true); throw Error(`${message} Edit the fields, then choose the new-submission action; retry keeps this attempt frozen.`); }
        throw Error(message);
      }
      const receipt = await response.json().catch(() => undefined) as { proposal?: { proposal_id?: string; revision?: number } } | undefined;
      if (!receipt?.proposal?.proposal_id || !Number.isSafeInteger(receipt.proposal.revision)) throw Error("The progress receipt was incomplete. The same attempt is preserved for retry.");
      clearAttempt("progress"); showNew("progress", false); revisionProposalId = undefined; revisionKind = undefined; say("Progress report submitted for owner review; the canonical request is unchanged until publication."); await loadOverview();
    } catch (error) { say(error instanceof Error && error.message ? error.message : "The progress report is pending. Retry this same attempt when the network is ready."); }
    finally { busy = false; if (progressSubmit) progressSubmit.disabled = false; }
  };
  const reviewProposal = async (proposalId: string, revision: number) => {
    if (!review) return;
    try {
      const response = await fetch(`${api}/proposals/${encodeURIComponent(proposalId)}/revisions/${revision}`, { headers: { accept: "application/json" } });
      if (!response.ok) throw Error();
      const value = await response.json() as { proposal?: { proposal_id: string; revision: number; base_revision: number; kind?: string; body?: Record<string, unknown>; source_messages?: readonly { id?: string; author?: string; display_name?: string; citation_url?: string }[]; status?: string } };
      const proposal = value.proposal;
      if (!proposal) throw Error();
      currentProposal = { proposal_id: proposal.proposal_id, revision: proposal.revision, base_revision: proposal.base_revision, kind: proposal.kind };
      review.replaceChildren();
      const heading = documentObject.createElement("p"); heading.textContent = `Reviewing proposal revision ${proposal.revision} · ${proposal.status || "pending"}`; review.append(heading);
      const body = documentObject.createElement("p"); body.textContent = JSON.stringify(proposal.body ?? {}); review.append(body);
      const evidence = documentObject.createElement("p"); evidence.textContent = "Source evidence:"; review.append(evidence);
      for (const source of proposal.source_messages ?? []) { if (!source.citation_url) continue; const link = documentObject.createElement("a"); link.href = source.citation_url; link.textContent = `${source.display_name || source.author || "Source"} (${source.id || "stored message"})`; link.target = "_blank"; link.rel = "noreferrer"; review.append(link); }
      const rebase = documentObject.createElement("button"); rebase.type = "button"; rebase.className = "button compact"; rebase.textContent = "Edit as explicit new revision"; rebase.onclick = () => {
        revisionProposalId = proposal.proposal_id;
        revisionKind = proposal.kind === "request.progress" ? "request.progress" : proposal.kind === "panel.replace" ? "panel.replace" : "request.create";
        const bodyValue = proposal.body ?? {};
        if (revisionKind === "panel.replace") {
          clearAttempt("panel"); showNew("panel", false);
          if (panelActor) panelActor.value = String((proposal as { actor_label?: string }).actor_label ?? "");
          if (panelPurpose) panelPurpose.value = typeof bodyValue.purpose === "string" ? bodyValue.purpose : "";
          if (panelPhase) panelPhase.value = typeof bodyValue.phase === "string" ? bodyValue.phase : "";
          if (panelArtifacts) panelArtifacts.value = Array.isArray(bodyValue.artifacts) ? bodyValue.artifacts.map((item) => item && typeof item === "object" ? `${String((item as Record<string, unknown>).title ?? "")} | ${String((item as Record<string, unknown>).role ?? "")} | ${String((item as Record<string, unknown>).url ?? "")}` : "").filter(Boolean).join("\n") : "";
          if (panelNextActions) panelNextActions.value = Array.isArray(bodyValue.next_actions) ? bodyValue.next_actions.map((item) => item && typeof item === "object" ? `${String((item as Record<string, unknown>).description ?? "")} | ${String((item as Record<string, unknown>).owner_label ?? "")}` : "").filter(Boolean).join("\n") : "";
          if (panelSources) panelSources.value = (proposal.source_messages ?? []).map((source) => source.id || "").filter(Boolean).join("\n");
          say("Edit the panel replacement and submit an explicit new revision against the current published state.");
          return;
        }
        if (revisionKind === "request.progress") {
          clearAttempt("progress"); showNew("progress", false);
          if (progressRequest) progressRequest.value = String(bodyValue.request_id ?? "");
          if (progressStatus) progressStatus.value = String(bodyValue.status ?? "open");
          if (progressActor) progressActor.value = String((proposal as { actor_label?: string }).actor_label ?? "");
          if (progressBlockers) progressBlockers.value = Array.isArray(bodyValue.blockers) ? bodyValue.blockers.join("\n") : "";
          const firstEvidence = Array.isArray(bodyValue.evidence) && bodyValue.evidence[0] && typeof bodyValue.evidence[0] === "object" ? bodyValue.evidence[0] as Record<string, unknown> : {};
          if (progressArtifact) progressArtifact.value = String(firstEvidence.artifact_url ?? "");
          if (progressLocation) progressLocation.value = String(firstEvidence.location ?? "");
          if (progressVerification) progressVerification.value = String(firstEvidence.reported_verification ?? "");
          if (progressEvidenceBlockers) progressEvidenceBlockers.value = Array.isArray(firstEvidence.remaining_blockers) ? firstEvidence.remaining_blockers.join("\n") : "";
          if (progressUnverified) progressUnverified.value = String(bodyValue.unverified_explanation ?? "");
          if (progressReopenReason) progressReopenReason.value = String(bodyValue.reopen_reason ?? "");
          if (progressSources) progressSources.value = (proposal.source_messages ?? []).map((source) => source.id || "").filter(Boolean).join("\n");
          say("Edit the progress report and submit an explicit new revision against the current published state.");
          return;
        }
        clearAttempt("proposal"); showNew("proposal", false);
        if (title) title.value = String(bodyValue.title ?? ""); if (purpose) purpose.value = String(bodyValue.purpose ?? ""); if (owner) owner.value = String(bodyValue.owner_label ?? ""); if (requestedOutput) requestedOutput.value = String(bodyValue.requested_output ?? ""); if (unknowns) unknowns.value = Array.isArray(bodyValue.unknowns) ? bodyValue.unknowns.join("\n") : ""; if (criteria) criteria.value = Array.isArray(bodyValue.completion_criteria) ? bodyValue.completion_criteria.join("\n") : ""; if (impact) impact.value = String(bodyValue.decision_impact ?? ""); say("Edit the fields and submit an explicit new revision against the current published state.");
      };
      review.append(rebase);
      if (ownerManagementUrl && proposal.status === "pending") { const publish = documentObject.createElement("button"); publish.type = "button"; publish.className = "button primary compact"; publish.textContent = "Publish this exact revision"; publish.onclick = () => { void publishCurrent(); }; review.append(publish); }
    } catch { say("The proposal revision could not be loaded. Retry the review."); }
  };
  const publishCurrent = async () => {
    if (busy || !currentProposal || !ownerManagementUrl) { if (!ownerManagementUrl) say("Add the private owner management URL before publishing."); return; }
    busy = true; if (ownerSave) ownerSave.disabled = true;
    const attempt = parseAttempt("publication");
    const payload = attempt?.payload?.proposal_id === currentProposal.proposal_id && attempt?.payload?.revision === currentProposal.revision && attempt.payload.operation === "publication"
      ? attempt.payload
      : { base_revision: currentProposal.base_revision, client_retry_id: browserGlobal.crypto.randomUUID(), owner_label: owner?.value.trim() || "Room owner", proposal_id: currentProposal.proposal_id, revision: currentProposal.revision, operation: "publication" };
    const requestPayload = { base_revision: payload.base_revision, client_retry_id: payload.client_retry_id, owner_label: payload.owner_label, proposal_id: payload.proposal_id, revision: payload.revision };
    saveAttempt("publication", payload);
    try {
      const response = await fetch(`${ownerManagementUrl}/coordination/publish`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(requestPayload) });
      if (!response.ok) { const message = await errorMessage(response); if (response.status === 400) clearAttempt("publication"); throw Error(message); }
      const receipt = await response.json().catch(() => undefined) as { proposal?: { proposal_id?: string; revision?: number }; request?: { request_id?: string }; panel?: { proposal_id?: string; published_revision?: number } } | undefined;
      const hasResult = currentProposal.kind === "panel.replace" ? Boolean(receipt?.panel?.proposal_id) : Boolean(receipt?.request?.request_id);
      if (!receipt?.proposal?.proposal_id || !hasResult) throw Error("The publication receipt was incomplete. The same attempt is preserved for retry.");
      clearAttempt("publication"); say("Published the exact reviewed proposal revision."); await loadOverview();
    } catch (error) { say(error instanceof Error && error.message ? error.message : "Publication is pending. Retry this same attempt after reviewing the current revision."); }
    finally { busy = false; if (ownerSave) ownerSave.disabled = false; }
  };
  if (ownerUrl) { ownerUrl.value = ownerManagementUrl ?? ""; }
  for (const button of documentObject.querySelectorAll("[data-coordination-open]")) button.onclick = () => { (panel as CoordinationElement & { showModal?: () => void }).showModal?.(); };
  for (const button of documentObject.querySelectorAll("[data-coordination-close]")) button.onclick = () => { (panel as CoordinationElement & { close?: () => void }).close?.(); };
  ownerForm?.addEventListener("submit", (event: { preventDefault(): void }) => { event.preventDefault(); const result = helpers.retain(ownerUrl?.value.trim() ?? "", location.origin, room, storage); ownerManagementUrl = result.normalized; if (result.retained) say(result.message); else { say(result.message); if (result.saveUrl && ownerUrl) { ownerUrl.value = result.saveUrl; ownerUrl.select(); } } void loadOverview(); });
  proposalForm?.addEventListener("submit", (event: { preventDefault(): void }) => { event.preventDefault(); void submitProposal(); });
  progressForm?.addEventListener("submit", (event: { preventDefault(): void }) => { event.preventDefault(); void submitProgress(); });
  panelForm?.addEventListener("submit", (event: { preventDefault(): void }) => { event.preventDefault(); void submitPanel(); });
  proposalNew?.addEventListener("click", () => useEditedFields("proposal"));
  progressNew?.addEventListener("click", () => useEditedFields("progress"));
  panelNew?.addEventListener("click", () => useEditedFields("panel"));
  coordinationRefresh?.addEventListener("click", () => { void loadOverview(); });
  filterForm?.addEventListener("submit", (event: { preventDefault(): void }) => { event.preventDefault(); void loadOverview(); });
  void loadOverview();
}
