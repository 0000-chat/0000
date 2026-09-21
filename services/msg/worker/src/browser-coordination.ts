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
  checked?: boolean;
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
  readonly target_id?: string;
  readonly target_kind?: string;
  readonly revision_proposal_id?: string;
  readonly revision_kind?: "request.create" | "request.progress" | "panel.replace" | "decision.proposal" | "decision.position" | "claim.correction" | "decision.supersession";
};

type CoordinationRetryOperation = "proposal" | "progress" | "panel" | "publication" | "decision-proposal" | "decision-position" | "decision-publication" | "approval-message" | "correction" | "dispute" | "dispute-review" | "supersession";

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
  const decisionProposalForm = get<CoordinationElement>("#coordination-decision-proposal-form");
  const decisionActor = get<CoordinationElement>("#coordination-decision-actor");
  const decisionTitle = get<CoordinationElement>("#coordination-decision-title");
  const decisionText = get<CoordinationElement>("#coordination-decision-text");
  const decisionRequiredLabels = get<CoordinationElement>("#coordination-decision-required-labels");
  const decisionSources = get<CoordinationElement>("#coordination-decision-sources");
  const decisionProposalSubmit = get<CoordinationElement>("#coordination-decision-proposal-submit");
  const decisionProposalNew = get<CoordinationElement>("#coordination-decision-proposal-new");
  const positionForm = get<CoordinationElement>("#coordination-position-form");
  const positionReporter = get<CoordinationElement>("#coordination-position-reporter");
  const positionDecisionId = get<CoordinationElement>("#coordination-position-decision-id");
  const positionRevision = get<CoordinationElement>("#coordination-position-revision");
  const positionParticipant = get<CoordinationElement>("#coordination-position-participant");
  const positionStatement = get<CoordinationElement>("#coordination-position-statement");
  const positionSources = get<CoordinationElement>("#coordination-position-sources");
  const positionSubmit = get<CoordinationElement>("#coordination-position-submit");
  const positionNew = get<CoordinationElement>("#coordination-position-new");
  const decisionApprovalForm = get<CoordinationElement>("#coordination-decision-approval-form");
  const approvalOwnerLabel = get<CoordinationElement>("#coordination-decision-approval-owner-label");
  const approvalAttestation = get<CoordinationElement>("#coordination-decision-approval-attestation");
  const approvalLabels = get<CoordinationElement>("#coordination-decision-approval-labels");
  const approvalSubmit = get<CoordinationElement>("#coordination-decision-approval-submit");
  const approvalNew = get<CoordinationElement>("#coordination-decision-approval-new");
  const approvalEvidenceInspect = get<CoordinationElement>("#coordination-decision-approval-inspect");
  const approvalEvidenceReview = get<CoordinationElement>("#coordination-decision-approval-evidence-review");
  const approvalMessageForm = get<CoordinationElement>("#coordination-decision-approval-message-form");
  const approvalMessageAuthor = get<CoordinationElement>("#coordination-decision-approval-message-author");
  const approvalMessageContent = get<CoordinationElement>("#coordination-decision-approval-message-content");
  const approvalMessageSubmit = get<CoordinationElement>("#coordination-decision-approval-message-submit");
  const approvalMessageNew = get<CoordinationElement>("#coordination-decision-approval-message-new");
  const correctionForm = get<CoordinationElement>("#coordination-correction-form");
  const correctionActor = get<CoordinationElement>("#coordination-correction-actor");
  const correctionTargetType = get<CoordinationElement>("#coordination-correction-target-type");
  const correctionMessageId = get<CoordinationElement>("#coordination-correction-message-id");
  const correctionPublicationRevision = get<CoordinationElement>("#coordination-correction-publication-revision");
  const correctionClaimPath = get<CoordinationElement>("#coordination-correction-claim-path");
  const correctionText = get<CoordinationElement>("#coordination-correction-text");
  const correctionSources = get<CoordinationElement>("#coordination-correction-sources");
  const correctionInspect = get<CoordinationElement>("#coordination-correction-inspect");
  const correctionSubmit = get<CoordinationElement>("#coordination-correction-submit");
  const correctionNew = get<CoordinationElement>("#coordination-correction-new");
  const correctionReview = get<CoordinationElement>("#coordination-correction-review");
  const disputeForm = get<CoordinationElement>("#coordination-dispute-form");
  const disputeActor = get<CoordinationElement>("#coordination-dispute-actor");
  const disputeAcceptedRecord = get<CoordinationElement>("#coordination-dispute-accepted-record");
  const disputeKind = get<CoordinationElement>("#coordination-dispute-kind");
  const disputeStatement = get<CoordinationElement>("#coordination-dispute-statement");
  const disputeApprovalRecord = get<CoordinationElement>("#coordination-dispute-approval-record");
  const disputeSources = get<CoordinationElement>("#coordination-dispute-sources");
  const disputeInspect = get<CoordinationElement>("#coordination-dispute-inspect");
  const disputeSubmit = get<CoordinationElement>("#coordination-dispute-submit");
  const disputeNew = get<CoordinationElement>("#coordination-dispute-new");
  const disputeReview = get<CoordinationElement>("#coordination-dispute-review");
  const disputeReviewForm = get<CoordinationElement>("#coordination-dispute-review-form");
  const disputeReviewReport = get<CoordinationElement>("#coordination-dispute-review-report");
  const disputeReviewDisposition = get<CoordinationElement>("#coordination-dispute-review-disposition");
  const disputeReviewRationale = get<CoordinationElement>("#coordination-dispute-review-rationale");
  const disputeReviewSources = get<CoordinationElement>("#coordination-dispute-review-sources");
  const disputeReviewSubmit = get<CoordinationElement>("#coordination-dispute-review-submit");
  const disputeReviewNew = get<CoordinationElement>("#coordination-dispute-review-new");
  const supersessionForm = get<CoordinationElement>("#coordination-supersession-form");
  const supersessionActor = get<CoordinationElement>("#coordination-supersession-actor");
  const supersessionPredecessor = get<CoordinationElement>("#coordination-supersession-predecessor");
  const supersessionSuccessor = get<CoordinationElement>("#coordination-supersession-successor");
  const supersessionRevision = get<CoordinationElement>("#coordination-supersession-revision");
  const supersessionSources = get<CoordinationElement>("#coordination-supersession-sources");
  const supersessionInspect = get<CoordinationElement>("#coordination-supersession-inspect");
  const supersessionSubmit = get<CoordinationElement>("#coordination-supersession-submit");
  const supersessionNew = get<CoordinationElement>("#coordination-supersession-new");
  const supersessionReview = get<CoordinationElement>("#coordination-supersession-review");
  const retentionCurrent = get<CoordinationElement>("#coordination-retention-current");
  const retentionBounds = get<CoordinationElement>("#coordination-retention-bounds");
  const retentionTarget = get<CoordinationElement>("#coordination-retention-target");
  const retentionRefresh = get<CoordinationElement>("#coordination-retention-refresh");
  const retentionExtend = get<CoordinationElement>("#coordination-retention-extend");
  const retentionNew = get<CoordinationElement>("#coordination-retention-new");
  const retentionStatus = get<CoordinationElement>("#coordination-retention-status");
  const proposalRetryKey = `0000:coordination-proposal-attempt:v1:${room}`;
  const progressRetryKey = `0000:coordination-progress-attempt:v1:${room}`;
  const panelRetryKey = `0000:coordination-panel-attempt:v1:${room}`;
  const publicationRetryKey = `0000:coordination-publication-attempt:v1:${room}`;
  const decisionProposalRetryKey = `0000:coordination-decision-proposal-attempt:v1:${room}`;
  const decisionPositionRetryKey = `0000:coordination-decision-position-attempt:v1:${room}`;
  const decisionPublicationRetryKey = `0000:coordination-decision-publication-attempt:v1:${room}`;
  const approvalMessageRetryKey = `0000:coordination-approval-message-attempt:v1:${room}`;
  const correctionRetryKey = `0000:coordination-correction-attempt:v1:${room}`;
  const disputeRetryKey = `0000:coordination-dispute-attempt:v1:${room}`;
  const disputeReviewRetryKey = `0000:coordination-dispute-review-attempt:v1:${room}`;
  const supersessionRetryKey = `0000:coordination-supersession-attempt:v1:${room}`;
  const retentionRetryKey = `0000:retention-extension-attempt:v1:${room}`;
  let currentOverview: Record<string, unknown> | undefined;
  let currentProposal: { proposal_id: string; revision: number; base_revision: number; kind?: string } | undefined;
  let currentDecision: { decision_id: string; revision: number; base_revision: number; title: string; state: "recommended" | "accepted"; required_approver_labels: string[]; accepted_record_id?: string } | undefined;
  let revisionProposalId: string | undefined;
  let revisionKind: CoordinationAttempt["revision_kind"] | undefined;
  let memoryProposalAttempt: CoordinationAttempt | undefined;
  let memoryProgressAttempt: CoordinationAttempt | undefined;
  let memoryPanelAttempt: CoordinationAttempt | undefined;
  let memoryPublicationAttempt: CoordinationAttempt | undefined;
  let memoryDecisionProposalAttempt: CoordinationAttempt | undefined;
  let memoryDecisionPositionAttempt: CoordinationAttempt | undefined;
  let memoryDecisionPublicationAttempt: CoordinationAttempt | undefined;
  let memoryApprovalMessageAttempt: CoordinationAttempt | undefined;
  let memoryCorrectionAttempt: CoordinationAttempt | undefined;
  let memoryDisputeAttempt: CoordinationAttempt | undefined;
  let memoryDisputeReviewAttempt: CoordinationAttempt | undefined;
  let memorySupersessionAttempt: CoordinationAttempt | undefined;
  let busy = false;
  let ownerManagementUrl = helpers.read(location.origin, room, storage);
  let retentionBusy = false;
  let retentionBoundsValue: { readonly expires_at?: string; readonly minimum_expires_at?: string; readonly maximum_expires_at?: string; readonly retention?: { readonly expires_at?: string; readonly inactivity_window_ms?: number; readonly mode?: string; readonly policy?: string } } | undefined;
  let memoryRetentionAttempt: { readonly client_retry_id: string; readonly expires_at: string } | undefined;

  const say = (message: string) => { if (status) status.textContent = message; };
  const retryKeyFor = (operation: CoordinationRetryOperation) => operation === "proposal" ? proposalRetryKey : operation === "progress" ? progressRetryKey : operation === "panel" ? panelRetryKey : operation === "publication" ? publicationRetryKey : operation === "decision-proposal" ? decisionProposalRetryKey : operation === "decision-position" ? decisionPositionRetryKey : operation === "decision-publication" ? decisionPublicationRetryKey : operation === "approval-message" ? approvalMessageRetryKey : operation === "correction" ? correctionRetryKey : operation === "dispute" ? disputeRetryKey : operation === "dispute-review" ? disputeReviewRetryKey : supersessionRetryKey;
  const showNew = (operation: CoordinationRetryOperation, visible: boolean) => {
    const button = operation === "proposal" ? proposalNew : operation === "progress" ? progressNew : operation === "panel" ? panelNew : operation === "decision-proposal" ? decisionProposalNew : operation === "decision-position" ? positionNew : operation === "decision-publication" ? approvalNew : operation === "approval-message" ? approvalMessageNew : operation === "correction" ? correctionNew : operation === "dispute" ? disputeNew : operation === "dispute-review" ? disputeReviewNew : operation === "supersession" ? supersessionNew : undefined;
    if (button) button.hidden = !visible;
  };
  const useEditedFields = (operation: CoordinationRetryOperation) => {
    const attempt = parseAttempt(operation);
    if (attempt?.revision_proposal_id) {
      revisionProposalId = attempt.revision_proposal_id;
      revisionKind = attempt.revision_kind;
    }
    clearAttempt(operation);
    showNew(operation, false);
    const label = operation === "progress" ? "progress report" : operation === "panel" ? "panel replacement" : operation === "decision-proposal" ? "decision proposal" : operation === "decision-position" ? "reported position" : operation === "decision-publication" ? "decision publication" : operation === "approval-message" ? "ordinary approval message" : operation === "correction" ? "correction" : operation === "dispute" ? "dispute report" : operation === "supersession" ? "supersession proposal" : operation === "dispute-review" ? "dispute review" : "proposal";
    say(`The previous ${label} was rejected. Edited fields will be submitted as a new attempt.`);
  };
  const lines = (value: string | undefined) => (value ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const parseAttempt = (operation: CoordinationRetryOperation): CoordinationAttempt | undefined => {
    const memory = operation === "proposal" ? memoryProposalAttempt : operation === "progress" ? memoryProgressAttempt : operation === "panel" ? memoryPanelAttempt : operation === "publication" ? memoryPublicationAttempt : operation === "decision-proposal" ? memoryDecisionProposalAttempt : operation === "decision-position" ? memoryDecisionPositionAttempt : operation === "decision-publication" ? memoryDecisionPublicationAttempt : operation === "approval-message" ? memoryApprovalMessageAttempt : operation === "correction" ? memoryCorrectionAttempt : operation === "dispute" ? memoryDisputeAttempt : operation === "dispute-review" ? memoryDisputeReviewAttempt : memorySupersessionAttempt;
    if (memory) return memory;
    try { const value = JSON.parse(browserGlobal.sessionStorage.getItem(retryKeyFor(operation)) ?? "null"); return value?.client_retry_id && value?.payload ? value : undefined; } catch { return; }
  };
  const saveAttempt = (operation: CoordinationRetryOperation, payload: Record<string, unknown>, metadata: Pick<CoordinationAttempt, "revision_proposal_id" | "revision_kind" | "target_id" | "target_kind"> = {}) => {
    const attempt: CoordinationAttempt = { client_retry_id: String(payload.client_retry_id), payload, ...metadata };
    if (operation === "proposal") memoryProposalAttempt = attempt; else if (operation === "progress") memoryProgressAttempt = attempt; else if (operation === "panel") memoryPanelAttempt = attempt; else if (operation === "publication") memoryPublicationAttempt = attempt; else if (operation === "decision-proposal") memoryDecisionProposalAttempt = attempt; else if (operation === "decision-position") memoryDecisionPositionAttempt = attempt; else if (operation === "decision-publication") memoryDecisionPublicationAttempt = attempt; else if (operation === "approval-message") memoryApprovalMessageAttempt = attempt; else if (operation === "correction") memoryCorrectionAttempt = attempt; else if (operation === "dispute") memoryDisputeAttempt = attempt; else if (operation === "dispute-review") memoryDisputeReviewAttempt = attempt; else memorySupersessionAttempt = attempt;
    try { browserGlobal.sessionStorage.setItem(retryKeyFor(operation), JSON.stringify(attempt)); } catch { /* The in-memory attempt remains available. */ }
  };
  const clearAttempt = (operation: CoordinationRetryOperation) => {
    if (operation === "proposal") memoryProposalAttempt = undefined; else if (operation === "progress") memoryProgressAttempt = undefined; else if (operation === "panel") memoryPanelAttempt = undefined; else if (operation === "publication") memoryPublicationAttempt = undefined; else if (operation === "decision-proposal") memoryDecisionProposalAttempt = undefined; else if (operation === "decision-position") memoryDecisionPositionAttempt = undefined; else if (operation === "decision-publication") memoryDecisionPublicationAttempt = undefined; else if (operation === "approval-message") memoryApprovalMessageAttempt = undefined; else if (operation === "correction") memoryCorrectionAttempt = undefined; else if (operation === "dispute") memoryDisputeAttempt = undefined; else if (operation === "dispute-review") memoryDisputeReviewAttempt = undefined; else memorySupersessionAttempt = undefined;
    try { browserGlobal.sessionStorage.setItem(retryKeyFor(operation), ""); } catch { /* Ignore unavailable storage. */ }
  };
  const errorMessage = async (response: Response) => {
    const value = await response.json().catch(() => ({})) as { error?: { code?: string; current_revision?: number; message?: string } };
    if (value.error?.code === "stale_revision" && typeof value.error.current_revision === "number") return `The published revision is now ${value.error.current_revision}. Review and explicitly rebase before retrying.`;
    if (typeof value.error?.message === "string" && value.error.message.length > 0 && value.error.message.length <= 240) return value.error.message;
    return "The coordination request could not be completed. The same attempt is preserved for retry.";
  };
  const parseRetentionAttempt = () => {
    if (memoryRetentionAttempt) return memoryRetentionAttempt;
    try {
      const value = JSON.parse(browserGlobal.sessionStorage.getItem(retentionRetryKey) ?? "null") as { client_retry_id?: unknown; expires_at?: unknown } | null;
      if (typeof value?.client_retry_id === "string" && value.client_retry_id.length > 0 && typeof value.expires_at === "string" && value.expires_at.length > 0) return memoryRetentionAttempt = { client_retry_id: value.client_retry_id, expires_at: value.expires_at };
    } catch { /* Ignore unavailable or stale browser storage. */ }
    return undefined;
  };
  const saveRetentionAttempt = (attempt: { readonly client_retry_id: string; readonly expires_at: string }) => {
    memoryRetentionAttempt = attempt;
    try { browserGlobal.sessionStorage.setItem(retentionRetryKey, JSON.stringify(attempt)); } catch { /* Keep the frozen attempt in memory for this page. */ }
  };
  const clearRetentionAttempt = () => {
    memoryRetentionAttempt = undefined;
    try { browserGlobal.sessionStorage.setItem(retentionRetryKey, ""); } catch { /* Ignore unavailable storage. */ }
  };
  const renderRetention = () => {
    const attempt = parseRetentionAttempt();
    const current = retentionBoundsValue?.expires_at ?? retentionBoundsValue?.retention?.expires_at;
    if (retentionCurrent) retentionCurrent.textContent = current ? `Current expiry: ${current}` : "Current expiry: unavailable until private owner access is inspected.";
    if (retentionBounds) {
      const minimum = retentionBoundsValue?.minimum_expires_at;
      const maximum = retentionBoundsValue?.maximum_expires_at;
      retentionBounds.textContent = minimum && maximum ? `Private bounds: ${minimum} through ${maximum}. Reads and retention inspection do not reset activity.` : "Private bounds are loaded only after owner access is saved.";
    }
    if (retentionTarget && attempt) retentionTarget.value = attempt.expires_at;
    if (retentionNew) retentionNew.hidden = !attempt;
    if (retentionStatus && attempt) retentionStatus.textContent = `Retry target frozen at ${attempt.expires_at}. The same client request will be retried until you choose a new target.`;
  };
  const retentionErrorMessage = async (response: Response) => {
    const value = await response.json().catch(() => ({})) as { error?: { message?: string } };
    if (typeof value.error?.message === "string" && value.error.message.length > 0 && value.error.message.length <= 240 && !/https?:\/\//iu.test(value.error.message)) return value.error.message;
    return `The retention request could not be completed (HTTP ${response.status}). The same target remains frozen for retry.`;
  };
  const loadRetentionBounds = async () => {
    if (!ownerManagementUrl) { if (retentionStatus) retentionStatus.textContent = "Save the private owner management URL before inspecting retention bounds."; return false; }
    if (retentionRefresh) retentionRefresh.disabled = true;
    let response: Response;
    try {
      response = await fetch(ownerManagementUrl, { headers: { accept: "application/json" } });
    } catch {
      if (retentionStatus) retentionStatus.textContent = "Private retention bounds could not be loaded. Check the room connection and retry.";
      if (retentionRefresh) retentionRefresh.disabled = false;
      return false;
    }
    try {
      if (!response.ok) throw Error(await retentionErrorMessage(response));
      let value: { expires_at?: unknown; minimum_expires_at?: unknown; maximum_expires_at?: unknown; retention?: unknown };
      try { value = await response.json() as { expires_at?: unknown; minimum_expires_at?: unknown; maximum_expires_at?: unknown; retention?: unknown }; } catch { throw Error("The private retention bounds response was invalid."); }
      const retention = value.retention && typeof value.retention === "object" && !Array.isArray(value.retention) ? value.retention as { expires_at?: unknown; inactivity_window_ms?: unknown; mode?: unknown; policy?: unknown } : undefined;
      if (typeof value.expires_at !== "string" || typeof value.minimum_expires_at !== "string" || typeof value.maximum_expires_at !== "string" || !retention || typeof retention.expires_at !== "string" || typeof retention.inactivity_window_ms !== "number" || typeof retention.mode !== "string" || typeof retention.policy !== "string") throw Error("The private retention bounds response was incomplete.");
      retentionBoundsValue = { expires_at: value.expires_at, minimum_expires_at: value.minimum_expires_at, maximum_expires_at: value.maximum_expires_at, retention: { expires_at: retention.expires_at, inactivity_window_ms: retention.inactivity_window_ms, mode: retention.mode, policy: retention.policy } };
      const attempt = parseRetentionAttempt();
      if (retentionTarget && !attempt) retentionTarget.value = value.maximum_expires_at;
      renderRetention();
      if (retentionStatus && !attempt) retentionStatus.textContent = "Private bounds loaded. Choose an absolute target and select Extend room.";
      return true;
    } catch (error) {
      if (retentionStatus) retentionStatus.textContent = error instanceof Error && error.message && !/https?:\/\//iu.test(error.message) ? error.message : "Private retention bounds could not be loaded.";
      return false;
    } finally { if (retentionRefresh) retentionRefresh.disabled = false; }
  };
  const submitRetention = async () => {
    if (retentionBusy) return;
    if (!ownerManagementUrl) { if (retentionStatus) retentionStatus.textContent = "Save the private owner management URL before extending retention."; return; }
    let attempt = parseRetentionAttempt();
    if (!attempt) {
      if (!retentionBoundsValue) { if (!(await loadRetentionBounds())) return; if (retentionStatus) retentionStatus.textContent = "Private bounds loaded. Choose an absolute target and select Extend room again."; return; }
      const expiresAt = retentionTarget?.value.trim() || retentionBoundsValue?.maximum_expires_at || "";
      if (!expiresAt) { if (retentionStatus) retentionStatus.textContent = "Choose an absolute expiry after inspecting the private bounds."; return; }
      attempt = { client_retry_id: browserGlobal.crypto.randomUUID(), expires_at: expiresAt };
      saveRetentionAttempt(attempt);
      renderRetention();
    }
    retentionBusy = true;
    if (retentionExtend) retentionExtend.disabled = true;
    if (retentionRefresh) retentionRefresh.disabled = true;
    if (retentionNew) retentionNew.disabled = true;
    let response: Response;
    try {
      response = await fetch(`${ownerManagementUrl}/retention`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(attempt) });
    } catch {
      renderRetention();
      if (retentionStatus) retentionStatus.textContent = "Retention extension could not be completed. The same target remains frozen for retry.";
      retentionBusy = false;
      if (retentionExtend) retentionExtend.disabled = false;
      if (retentionRefresh) retentionRefresh.disabled = false;
      if (retentionNew) retentionNew.disabled = false;
      return;
    }
    try {
      if (!response.ok) throw Error(await retentionErrorMessage(response));
      let receipt: { client_retry_id?: unknown; event_id?: unknown; result_expires_at?: unknown; current_expires_at?: unknown; maximum_expires_at?: unknown; minimum_expires_at?: unknown; retention?: unknown };
      try { receipt = await response.json() as { client_retry_id?: unknown; event_id?: unknown; result_expires_at?: unknown; current_expires_at?: unknown; maximum_expires_at?: unknown; minimum_expires_at?: unknown; retention?: unknown }; } catch { throw Error("The retention receipt was invalid. The same target remains frozen for retry."); }
      if (receipt.client_retry_id !== attempt.client_retry_id || typeof receipt.event_id !== "string" || typeof receipt.result_expires_at !== "string") throw Error("The retention receipt was incomplete. The same target remains frozen for retry.");
      clearRetentionAttempt();
      retentionBoundsValue = { expires_at: typeof receipt.current_expires_at === "string" ? receipt.current_expires_at : receipt.result_expires_at, minimum_expires_at: typeof receipt.minimum_expires_at === "string" ? receipt.minimum_expires_at : retentionBoundsValue?.minimum_expires_at, maximum_expires_at: typeof receipt.maximum_expires_at === "string" ? receipt.maximum_expires_at : retentionBoundsValue?.maximum_expires_at, retention: retentionBoundsValue?.retention };
      renderRetention();
      if (retentionTarget) retentionTarget.value = receipt.result_expires_at;
      if (retentionStatus) retentionStatus.textContent = `Retention extension recorded through ${receipt.result_expires_at}. Event ${receipt.event_id} is immutable.`;
    } catch (error) {
      renderRetention();
      if (retentionStatus) retentionStatus.textContent = error instanceof Error && error.message && !/https?:\/\//iu.test(error.message) ? error.message : "Retention extension is pending. The same target remains frozen for retry.";
    } finally { retentionBusy = false; if (retentionExtend) retentionExtend.disabled = false; if (retentionRefresh) retentionRefresh.disabled = false; if (retentionNew) retentionNew.disabled = false; }
  };
  const renderOverview = (value: Record<string, unknown>, panelDetail?: Record<string, unknown>) => {
    if (!overview && !pinnedOverview) return;
    currentOverview = value;
    const pending = Array.isArray(value.pending_proposals) ? value.pending_proposals : [];
    const published = Array.isArray(value.published_requests) ? value.published_requests : [];
    const decisions = Array.isArray(value.decision_summaries) ? value.decision_summaries : [];
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
    const pendingCount = Number(value.pending_proposal_count ?? pending.length), publishedCount = Number(value.published_request_count ?? published.length), decisionCount = Number(value.decision_count ?? decisions.length), acceptedDecisionCount = Number(value.accepted_decision_count ?? decisions.filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).state === "accepted").length);
    const statusCounts = value.request_status_counts && typeof value.request_status_counts === "object" && !Array.isArray(value.request_status_counts) ? value.request_status_counts as Record<string, unknown> : {};
    const heading = documentObject.createElement("p"); heading.textContent = `${pendingCount} pending proposal${pendingCount === 1 ? "" : "s"}; ${publishedCount} published request${publishedCount === 1 ? "" : "s"}; ${decisionCount} decision${decisionCount === 1 ? "" : "s"} (${acceptedDecisionCount} owner-recorded accepted); status counts open ${String(statusCounts.open ?? 0)}, in progress ${String(statusCounts.in_progress ?? 0)}, blocked ${String(statusCounts.blocked ?? 0)}, done ${String(statusCounts.done ?? 0)}, withdrawn ${String(statusCounts.withdrawn ?? 0)}; global publication revision ${String(value.published_revision ?? 0)}; event cursor ${String(value.coordination_cursor ?? 0)}.`; overview.append(heading);
    for (const [label, key] of [["Browse proposals", "proposals_url"], ["Browse published requests", "requests_url"], ["Browse decisions", "decisions_url"], ["Inspect panel", "panel_url"], ["Panel history", "panel_history_url"]] as const) {
      if (typeof value[key] !== "string") continue;
      const link = documentObject.createElement("a"); link.href = String(value[key]); link.textContent = label; link.target = "_blank"; link.rel = "noreferrer"; overview.append(link);
    }
    for (const item of pending) {
      if (!item || typeof item !== "object") continue;
      const record = item as { title?: string; proposal_id?: string; revision?: number; status?: string; kind?: string; detail_url?: string };
      const row = documentObject.createElement("div"); row.className = "coordination-item";
      const text = documentObject.createElement("span"); text.textContent = `${record.kind === "panel.replace" ? "Room panel replacement" : record.kind === "decision.proposal" ? "Decision proposal" : record.title || "Untitled proposal"} · revision ${record.revision ?? "?"} · ${record.kind === "request.progress" ? "reported progress" : record.kind === "decision.proposal" ? "labelled evidence pending owner review" : record.status || "pending"}`; row.append(text);
      if (record.detail_url) { const link = documentObject.createElement("a"); link.href = record.detail_url; link.textContent = "Review evidence"; link.target = "_blank"; link.rel = "noreferrer"; row.append(link); }
      if (record.proposal_id) { const button = documentObject.createElement("button"); button.type = "button"; button.className = "button compact"; button.textContent = "Review exact revision"; button.onclick = () => { void reviewProposal(record.proposal_id!, Number(record.revision)); }; row.append(button); }
      overview.append(row);
    }
    for (const item of decisions) {
      if (!item || typeof item !== "object") continue;
      const record = item as { decision_id?: string; title?: string; state?: string; latest_proposal_revision?: number; published_revision?: number; required_approver_labels?: readonly string[]; accepted_record_id?: string; detail_url?: string };
      if (!record.decision_id) continue;
      const row = documentObject.createElement("div"); row.className = "coordination-item";
      const state = record.state === "accepted" ? "owner-recorded accepted decision" : "recommendation; approval evidence is still unverified";
      const text = documentObject.createElement("span"); text.textContent = `Decision: ${record.title || record.decision_id} · ${state} · proposal revision ${record.latest_proposal_revision ?? "?"} · publication revision ${record.published_revision ?? "?"}`; row.append(text);
      if (record.detail_url) { const link = documentObject.createElement("a"); link.href = record.detail_url; link.textContent = "Review decision evidence"; link.target = "_blank"; link.rel = "noreferrer"; row.append(link); }
      const button = documentObject.createElement("button"); button.type = "button"; button.className = "button compact"; button.textContent = "Inspect labelled evidence"; button.onclick = () => { void reviewDecision(record.decision_id!); }; row.append(button);
      overview.append(row);
    }
    const correctionSummaries = Array.isArray(value.correction_summaries) ? value.correction_summaries : [];
    const correctionCount = Number(value.correction_count ?? correctionSummaries.length);
    const correctionHeading = documentObject.createElement("p");
    correctionHeading.textContent = correctionCount === 0 ? "Corrections: none" : `Corrections (${correctionCount}; showing ${correctionSummaries.length}): original claims remain visible beside attributed corrections.`;
    overview.append(correctionHeading);
    for (const item of correctionSummaries.slice(0, 5)) {
      if (!item || typeof item !== "object") continue;
      const record = item as { correction_id?: string; correction_text?: string; detail_url?: string; owner_label?: string; reporter_label?: string; target?: { type?: string; message_id?: string; published_revision?: number; claim_path?: readonly (string | number)[] } };
      const row = documentObject.createElement("div"); row.className = "coordination-item";
      const target = record.target?.type === "message" ? `message ${record.target.message_id ?? "?"}` : `publication ${record.target?.published_revision ?? "?"} claim ${JSON.stringify(record.target?.claim_path ?? [])}`;
      const text = documentObject.createElement("span"); text.textContent = `Correction ${record.correction_id ?? "?"} · ${target} · reported by ${record.reporter_label ?? "unknown"} · published by ${record.owner_label ?? "unknown"}: ${record.correction_text ?? ""}`; row.append(text);
      if (record.detail_url) { const link = documentObject.createElement("a"); link.href = record.detail_url; link.textContent = "Inspect correction and original"; link.target = "_blank"; link.rel = "noreferrer"; row.append(link); }
      overview.append(row);
    }
    if (typeof value.corrections_url === "string" && correctionCount > correctionSummaries.length) {
      const link = documentObject.createElement("a"); link.href = value.corrections_url; link.textContent = "Browse full correction history"; link.target = "_blank"; link.rel = "noreferrer"; overview.append(link);
    }
    for (const item of published) {
      if (!item || typeof item !== "object") continue;
      const record = item as { title?: string; body?: { title?: string }; published_revision?: number; status?: string; detail_url?: string };
      const row = documentObject.createElement("div"); row.className = "coordination-item";
      const text = documentObject.createElement("span"); text.textContent = `${record.title || record.body?.title || "Untitled request"} · canonical status ${record.status || "open"} · published revision ${record.published_revision ?? "?"}`; row.append(text);
      if (record.detail_url) { const link = documentObject.createElement("a"); link.href = record.detail_url; link.textContent = "Inspect request"; link.target = "_blank"; link.rel = "noreferrer"; row.append(link); }
      if (typeof (record as Record<string, unknown>).corrections_url === "string") { const link = documentObject.createElement("a"); link.href = String((record as Record<string, unknown>).corrections_url); link.textContent = "Corrections for this publication"; link.target = "_blank"; link.rel = "noreferrer"; row.append(link); }
      overview.append(row);
    }
    if (!pending.length && !published.length && !decisions.length) { const empty = documentObject.createElement("p"); empty.textContent = "No tracked requests or decisions yet. Submit labelled source evidence to begin review."; overview.append(empty); }
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
  const pathLabel = (path: readonly (string | number)[]) => path.map((segment) => typeof segment === "number" ? `[${segment}]` : segment).join(".");
  const publicClaimPaths = (value: unknown, prefix: readonly (string | number)[] = [], result: Array<{ path: readonly (string | number)[]; value: unknown }> = []) => {
    if (prefix.length > 8 || value === null || typeof value !== "object") return result;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => { if (Object.prototype.hasOwnProperty.call(value, index)) { const path = [...prefix, index] as const; result.push({ path, value: entry }); publicClaimPaths(entry, path, result); } });
      return result;
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
      const path = [...prefix, key] as const;
      const child = (value as Record<string, unknown>)[key];
      result.push({ path, value: child });
      publicClaimPaths(child, path, result);
    }
    return result;
  };
  const sourceLinks = (container: CoordinationElement, sources: readonly Record<string, unknown>[]) => {
    for (const source of sources) {
      if (typeof source.citation_url !== "string") continue;
      const link = documentObject.createElement("a"); link.href = source.citation_url; link.textContent = `${String(source.display_name ?? source.author ?? "Source")} (${String(source.id ?? "stored message")})`; link.target = "_blank"; link.rel = "noreferrer"; container.append(link);
    }
  };
  const setChoiceValue = (element: CoordinationElement | null, value: string, label = value) => {
    if (!element || !value) return;
    element.value = value;
    if (element.value === value) return;
    const option = documentObject.createElement("option"); option.value = value; option.textContent = label; element.append(option); element.value = value;
  };
  const inspectCorrectionTarget = async () => {
    if (!correctionReview) return;
    const targetType = correctionTargetType?.value || "message";
    const revision = Number(correctionPublicationRevision?.value || 0);
    const messageId = correctionMessageId?.value.trim() || "";
    const targetUrl = targetType === "message" ? `/${encodeURIComponent(room)}/messages/${encodeURIComponent(messageId)}` : `${api}/publications/${revision}`;
    correctionReview.replaceChildren();
    try {
      const response = await fetch(targetUrl, { headers: { accept: "application/json" } });
      const value = await response.json().catch(() => undefined) as { message?: { id?: string; author?: string; display_name?: string; content?: string }; publication?: { body?: unknown; detail_url?: string; source_messages?: readonly Record<string, unknown>[] } } | undefined;
      if (!response.ok || !value) throw Error();
      const heading = documentObject.createElement("p"); heading.textContent = targetType === "message" ? `Original stored message ${value.message?.id ?? messageId} · author ${value.message?.display_name ?? value.message?.author ?? "unknown"} (self-declared and unverified)` : `Original canonical publication ${revision} · publisher attribution remains separate from the correction reporter.`; correctionReview.append(heading);
      const body = documentObject.createElement("pre"); body.textContent = targetType === "message" ? String(value.message?.content ?? "") : JSON.stringify(value.publication?.body ?? value.publication ?? {}, null, 2); correctionReview.append(body);
      const link = documentObject.createElement("a"); link.href = targetUrl; link.textContent = "Open exact original source"; link.target = "_blank"; link.rel = "noreferrer"; correctionReview.append(link);
      if (targetType === "publication" && correctionClaimPath) {
        correctionClaimPath.replaceChildren();
        const entries = publicClaimPaths(value.publication?.body);
        for (const entry of entries) {
          const option = documentObject.createElement("option"); option.value = JSON.stringify(entry.path); option.textContent = `${pathLabel(entry.path)} · ${typeof entry.value === "object" && entry.value !== null ? "object" : String(entry.value)}`; correctionClaimPath.append(option);
        }
        const savedAttempt = parseAttempt("correction");
        const savedBody = savedAttempt?.payload.body;
        const savedTarget = savedBody && typeof savedBody === "object" && !Array.isArray(savedBody) ? (savedBody as { target?: unknown }).target : undefined;
        const savedPath = savedTarget && typeof savedTarget === "object" && !Array.isArray(savedTarget) && Array.isArray((savedTarget as Record<string, unknown>).claim_path) ? JSON.stringify((savedTarget as Record<string, unknown>).claim_path) : "";
        if (savedPath) setChoiceValue(correctionClaimPath, savedPath);
        else if (!correctionClaimPath.value && entries[0]) setChoiceValue(correctionClaimPath, JSON.stringify(entries[0].path));
        if (!correctionClaimPath.value) say("The publication has no selectable public fields; inspect the exact envelope before choosing another revision.");
      }
      if (value.publication?.source_messages) sourceLinks(correctionReview, value.publication.source_messages);
    } catch { const error = documentObject.createElement("p"); error.textContent = "The original correction target could not be loaded from this room. Inspect it before submitting."; correctionReview.append(error); }
  };
  const correctionTargetFromForm = () => {
    const targetType = correctionTargetType?.value === "publication" ? "publication" : "message";
    return targetType === "message"
      ? { type: "message", message_id: correctionMessageId?.value.trim() || "" }
      : { type: "publication", published_revision: Number(correctionPublicationRevision?.value || 0), claim_path: (() => { try { return JSON.parse(correctionClaimPath?.value || "[]"); } catch { return []; } })() };
  };
  const makeCorrection = () => {
    const attempt = parseAttempt("correction"); if (attempt) return attempt.payload;
    const target = correctionTargetFromForm();
    const payload = { actor_label: correctionActor?.value.trim() || "Anonymous participant", base_revision: Number(currentOverview?.published_revision ?? 0), body: { correction_text: correctionText?.value.trim() || "", target }, client_retry_id: browserGlobal.crypto.randomUUID(), kind: "claim.correction", source_message_ids: lines(correctionSources?.value) };
    saveAttempt("correction", payload, { ...(revisionKind === "claim.correction" && revisionProposalId ? { revision_proposal_id: revisionProposalId } : {}), revision_kind: "claim.correction", target_id: JSON.stringify(target), target_kind: "claim.correction" }); return payload;
  };
  const submitCorrection = async () => {
    if (busy) return; busy = true; if (correctionSubmit) correctionSubmit.disabled = true;
    const payload = makeCorrection();
    try {
      const attempt = parseAttempt("correction");
      if (attempt?.target_id && attempt.target_id !== JSON.stringify(correctionTargetFromForm())) { showNew("correction", true); throw Error("The previous correction attempt targets a different claim. Choose the explicit new-attempt action before changing its target."); }
      const targetProposalId = attempt?.revision_kind === "claim.correction" ? attempt.revision_proposal_id : revisionKind === "claim.correction" ? revisionProposalId : undefined;
      const endpoint = targetProposalId ? `${api}/proposals/${encodeURIComponent(targetProposalId)}/revisions` : `${api}/proposals`;
      const response = await fetch(endpoint, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) { const message = await errorMessage(response); if (response.status === 400 || response.status === 413) showNew("correction", true); throw Error(`${message} Edit the fields, then choose the new-submission action; retry keeps the original target frozen.`); }
      const receipt = await response.json().catch(() => undefined) as { proposal?: { proposal_id?: string; revision?: number } } | undefined;
      if (!receipt?.proposal?.proposal_id || !Number.isSafeInteger(receipt.proposal.revision)) throw Error("The correction proposal receipt was incomplete. The same attempt is preserved for retry.");
      clearAttempt("correction"); showNew("correction", false); say("Correction submitted for owner review; the original claim remains unchanged."); await loadOverview();
    } catch (error) { say(error instanceof Error && error.message ? error.message : "The correction proposal is pending. Retry this same attempt when the network is ready."); }
    finally { busy = false; if (correctionSubmit) correctionSubmit.disabled = false; }
  };
  const makeDispute = () => {
    const attempt = parseAttempt("dispute"); if (attempt) return attempt.payload;
    const kind = disputeKind?.value === "approval_withdrawal" ? "approval_withdrawal" : "dispute";
    const payload = { accepted_record_id: disputeAcceptedRecord?.value.trim() || "", actor_label: disputeActor?.value.trim() || "Anonymous reporter", client_retry_id: browserGlobal.crypto.randomUUID(), kind, ...(kind === "approval_withdrawal" && disputeApprovalRecord?.value.trim() ? { approval_record_id: disputeApprovalRecord.value.trim() } : {}), source_message_ids: lines(disputeSources?.value), statement: disputeStatement?.value.trim() || "" };
    saveAttempt("dispute", payload); return payload;
  };
  const inspectDisputeSources = async () => {
    if (!disputeReview) return;
    disputeReview.replaceChildren();
    for (const id of lines(disputeSources?.value)) {
      try {
        const response = await fetch(`/${encodeURIComponent(room)}/messages/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
        const value = await response.json().catch(() => undefined) as { message?: { id?: string; content?: string; author?: string } } | undefined;
        const line = documentObject.createElement("p"); line.textContent = response.ok && value?.message ? `Source ${value.message.id ?? id} · author ${value.message.author ?? "unknown"} (self-declared) · ${value.message.content ?? ""}` : `Source ${id} could not be loaded from this room.`; disputeReview.append(line);
      } catch { const line = documentObject.createElement("p"); line.textContent = `Source ${id} could not be loaded from this room.`; disputeReview.append(line); }
    }
  };
  const submitDispute = async () => {
    if (busy) return; busy = true; if (disputeSubmit) disputeSubmit.disabled = true;
    const payload = makeDispute();
    try {
      const response = await fetch(`${api}/disputes`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) { const message = await errorMessage(response); if (response.status === 400 || response.status === 413) showNew("dispute", true); throw Error(`${message} The exact accepted record and approval ID stay frozen for retry.`); }
      const receipt = await response.json().catch(() => undefined) as { dispute?: { report_id?: string }; report?: { report_id?: string } } | undefined;
      if (!receipt?.dispute?.report_id && !receipt?.report?.report_id) throw Error("The dispute receipt was incomplete. The same report remains frozen for retry.");
      clearAttempt("dispute"); showNew("dispute", false); say("Attributed report submitted; the accepted record is contested until an owner reviews it."); await loadOverview();
    } catch (error) { say(error instanceof Error && error.message ? error.message : "The report is pending. Retry this same attempt when the network is ready."); }
    finally { busy = false; if (disputeSubmit) disputeSubmit.disabled = false; }
  };
  const makeDisputeReview = () => {
    const attempt = parseAttempt("dispute-review"); if (attempt) return attempt.payload;
    const payload = { base_revision: Number(currentOverview?.published_revision ?? 0), client_retry_id: browserGlobal.crypto.randomUUID(), disposition: disputeReviewDisposition?.value === "rejected" ? "rejected" : "acknowledged", owner_label: approvalOwnerLabel?.value.trim() || owner?.value.trim() || "Room owner", rationale: disputeReviewRationale?.value.trim() || "", source_message_ids: lines(disputeReviewSources?.value) };
    saveAttempt("dispute-review", payload, { target_id: disputeReviewReport?.value.trim() || "", target_kind: "dispute.review" }); return payload;
  };
  const reviewDispute = async (reportId: string, after = 0, through?: number) => {
    if (!disputeReview) return;
    if (disputeReviewReport) disputeReviewReport.value = reportId;
    try {
      const url = new URL(`${api}/disputes/${encodeURIComponent(reportId)}`, location.origin); url.searchParams.set("after", String(after)); url.searchParams.set("limit", "20"); if (through !== undefined) url.searchParams.set("through", String(through));
      const response = await fetch(`${url.pathname}${url.search}`, { headers: { accept: "application/json" } });
      const value = await response.json().catch(() => undefined) as { dispute?: Record<string, unknown> } | undefined;
      if (!response.ok || !value?.dispute) throw Error();
      const report = value.dispute; disputeReview.replaceChildren();
      const heading = documentObject.createElement("p"); heading.textContent = `${String(report.kind ?? "dispute")} report ${String(report.report_id ?? reportId)} · reporter ${String(report.actor_label ?? "unknown")} · accepted record ${String(report.accepted_record_id ?? "unknown")}. Reporter identity is self-declared and separate from any approval participant.`; disputeReview.append(heading);
      const body = documentObject.createElement("p"); body.textContent = String(report.statement ?? ""); disputeReview.append(body);
      sourceLinks(disputeReview, Array.isArray(report.source_messages) ? report.source_messages as Record<string, unknown>[] : []);
      const reviews = Array.isArray(report.reviews) ? report.reviews : [];
      for (const item of reviews) { if (!item || typeof item !== "object") continue; const row = documentObject.createElement("p"); const reviewValue = item as Record<string, unknown>; row.textContent = `Owner review ${String(reviewValue.review_id ?? "unknown")} · ${String(reviewValue.disposition ?? "unknown")} by ${String(reviewValue.owner_label ?? "unknown")}: ${String(reviewValue.rationale ?? "")}`; disputeReview.append(row); sourceLinks(disputeReview, Array.isArray(reviewValue.source_messages) ? reviewValue.source_messages as Record<string, unknown>[] : []); }
      if (report.reviews_has_more === true) { const more = documentObject.createElement("button"); more.type = "button"; more.className = "button compact"; more.textContent = "Load more owner reviews"; more.onclick = () => { void reviewDispute(reportId, Number(report.reviews_next_after ?? after), Number(report.reviews_through ?? through)); }; disputeReview.append(more); }
      if (ownerManagementUrl) { const formNote = documentObject.createElement("p"); formNote.textContent = "Owner review is an attributed assessment of this report; it does not authenticate the reporter or renew approval."; disputeReview.append(formNote); }
    } catch { say("The exact report and its bounded review history could not be loaded."); }
  };
  const submitDisputeReview = async () => {
    const reportId = disputeReviewReport?.value.trim() || "";
    if (busy || !ownerManagementUrl || !reportId) { if (!ownerManagementUrl) say("Add the private owner management URL before reviewing a report."); else say("Enter the exact report ID after inspecting its evidence."); return; }
    busy = true; if (disputeReviewSubmit) disputeReviewSubmit.disabled = true;
    const payload = makeDisputeReview();
    try {
      const attempt = parseAttempt("dispute-review");
      if (attempt?.target_id && attempt.target_id !== reportId) { showNew("dispute-review", true); throw Error("The previous owner review targets a different report. Choose the explicit new-review action before changing it."); }
      const endpoint = `${ownerManagementUrl}/coordination/disputes/${encodeURIComponent(reportId)}/review`;
      const response = await fetch(endpoint, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) { const message = await errorMessage(response); if (response.status === 400 || response.status === 409 || response.status === 413) showNew("dispute-review", true); throw Error(`${message} Review input remains frozen until you explicitly change it.`); }
      const value = await response.json().catch(() => undefined) as { review?: { review_id?: string } } | undefined;
      if (!value?.review?.review_id) throw Error("The owner review receipt was incomplete. The same review remains frozen for retry.");
      clearAttempt("dispute-review"); say("Owner review recorded; the report and prior reviews remain inspectable."); await reviewDispute(reportId); await loadOverview();
    } catch (error) { say(error instanceof Error && error.message ? error.message : "The owner review is pending. Retry this same frozen review."); }
    finally { busy = false; if (disputeReviewSubmit) disputeReviewSubmit.disabled = false; }
  };
  const makeSupersession = () => {
    const attempt = parseAttempt("supersession"); if (attempt) return attempt.payload;
    const target = { predecessor_accepted_record_id: supersessionPredecessor?.value.trim() || "", successor_decision_id: supersessionSuccessor?.value.trim() || "", successor_decision_revision: Number(supersessionRevision?.value || 0) };
    const payload = { actor_label: supersessionActor?.value.trim() || "Anonymous participant", base_revision: Number(currentOverview?.published_revision ?? 0), body: target, client_retry_id: browserGlobal.crypto.randomUUID(), kind: "decision.supersession", source_message_ids: lines(supersessionSources?.value) };
    saveAttempt("supersession", payload, { ...(revisionKind === "decision.supersession" && revisionProposalId ? { revision_proposal_id: revisionProposalId } : {}), revision_kind: "decision.supersession", target_id: JSON.stringify(target), target_kind: "decision.supersession" }); return payload;
  };
  const inspectSupersession = async () => {
    if (!supersessionReview) return;
    const predecessor = supersessionPredecessor?.value.trim() || "", successor = supersessionSuccessor?.value.trim() || "";
    supersessionReview.replaceChildren();
    const line = documentObject.createElement("p"); line.textContent = `Proposed relationship: accepted predecessor ${predecessor || "unset"} → decision ${successor || "unset"} revision ${supersessionRevision?.value || "unset"}. A recommendation cannot supersede an accepted record; inspect both exact records before submitting.`; supersessionReview.append(line);
    if (predecessor && successor) {
      const links = documentObject.createElement("p"); links.textContent = "Inspect the predecessor accepted record and successor decision through their exact public routes before owner publication."; supersessionReview.append(links);
    }
  };
  const submitSupersession = async () => {
    if (busy) return; busy = true; if (supersessionSubmit) supersessionSubmit.disabled = true;
    const payload = makeSupersession();
    try {
      const attempt = parseAttempt("supersession"); const target = attempt?.payload ?? payload;
      const targetFingerprint = JSON.stringify({ predecessor_accepted_record_id: supersessionPredecessor?.value.trim() || "", successor_decision_id: supersessionSuccessor?.value.trim() || "", successor_decision_revision: Number(supersessionRevision?.value || 0) });
      if (attempt?.target_id && attempt.target_id !== targetFingerprint) { showNew("supersession", true); throw Error("The previous supersession attempt links a different successor. Choose the explicit new-attempt action before changing its target."); }
      const targetProposalId = attempt?.revision_kind === "decision.supersession" ? attempt.revision_proposal_id : revisionKind === "decision.supersession" ? revisionProposalId : undefined;
      const endpoint = targetProposalId ? `${api}/proposals/${encodeURIComponent(targetProposalId)}/revisions` : `${api}/proposals`;
      const response = await fetch(endpoint, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(target) });
      if (!response.ok) { const message = await errorMessage(response); if (response.status === 400 || response.status === 413) showNew("supersession", true); throw Error(`${message} Rebase explicitly after the successor acceptance changes.`); }
      const receipt = await response.json().catch(() => undefined) as { proposal?: { proposal_id?: string; revision?: number } } | undefined;
      if (!receipt?.proposal?.proposal_id || !Number.isSafeInteger(receipt.proposal.revision)) throw Error("The supersession proposal receipt was incomplete. The same relationship remains frozen for retry.");
      clearAttempt("supersession"); showNew("supersession", false); say("Supersession proposal submitted; predecessor acceptance remains visible until exact successor acceptance and owner publication."); await loadOverview();
    } catch (error) { say(error instanceof Error && error.message ? error.message : "The supersession proposal is pending. Retry this same attempt when the network is ready."); }
    finally { busy = false; if (supersessionSubmit) supersessionSubmit.disabled = false; }
  };
  type DecisionSource = { id?: string; author?: string; display_name?: string; citation_url?: string };
  type DecisionProposalRevision = { proposal_id: string; revision: number; base_revision: number; actor_label?: string; kind?: string; body?: Record<string, unknown>; source_messages?: readonly DecisionSource[]; status?: string };
  const resetDecisionReview = () => {
    currentDecision = undefined;
    currentProposal = undefined;
    if (approvalOwnerLabel) approvalOwnerLabel.value = owner?.value.trim() || "";
    if (approvalAttestation) { approvalAttestation.value = "true"; approvalAttestation.checked = false; }
    if (approvalLabels) approvalLabels.value = "";
    if (approvalEvidenceReview) approvalEvidenceReview.replaceChildren();
    if (positionDecisionId) positionDecisionId.value = "";
    if (positionRevision) positionRevision.value = "";
  };
  const appendDecisionSources = (proposal: DecisionProposalRevision) => {
    for (const source of proposal.source_messages ?? []) {
      if (!source.citation_url) continue;
      const link = documentObject.createElement("a"); link.href = source.citation_url; link.textContent = `${source.display_name || source.author || "Source"} (${source.id || "stored message"})`; link.target = "_blank"; link.rel = "noreferrer"; review?.append(link);
    }
  };
  const parseApprovalEvidence = () => lines(approvalLabels?.value).map((line) => {
    const parts = line.split("|").map((part) => part.trim());
    return { participant_label: parts[0] ?? "", source_message_id: parts.slice(1).join("|") };
  });
  const makeDecisionProposal = () => {
    const attempt = parseAttempt("decision-proposal"); if (attempt) return attempt.payload;
    const payload = {
      actor_label: decisionActor?.value.trim() || "Anonymous participant",
      base_revision: Number(currentOverview?.published_revision ?? 0),
      body: { proposal_text: decisionText?.value.trim() || "", required_approver_labels: lines(decisionRequiredLabels?.value), title: decisionTitle?.value.trim() || "" },
      client_retry_id: browserGlobal.crypto.randomUUID(),
      kind: "decision.proposal",
      source_message_ids: lines(decisionSources?.value),
    };
    saveAttempt("decision-proposal", payload, { revision_proposal_id: revisionProposalId, revision_kind: revisionKind }); return payload;
  };
  const submitDecisionProposal = async () => {
    if (busy) return; busy = true; if (decisionProposalSubmit) decisionProposalSubmit.disabled = true;
    const payload = makeDecisionProposal();
    try {
      const attempt = parseAttempt("decision-proposal");
      const targetProposalId = attempt?.revision_proposal_id ?? revisionProposalId;
      const targetKind = attempt?.revision_kind ?? revisionKind;
      const endpoint = targetProposalId && targetKind === "decision.proposal" ? `${api}/proposals/${encodeURIComponent(targetProposalId)}/revisions` : `${api}/proposals`;
      const response = await fetch(endpoint, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) {
        const message = await errorMessage(response);
        if (response.status === 400 || response.status === 413) { showNew("decision-proposal", true); throw Error(`${message} Edit the fields, then choose the new-submission action; retry keeps this attempt frozen.`); }
        throw Error(message);
      }
      const receipt = await response.json().catch(() => undefined) as { proposal?: { proposal_id?: string; revision?: number } } | undefined;
      if (!receipt?.proposal?.proposal_id || !Number.isSafeInteger(receipt.proposal.revision)) throw Error("The decision proposal receipt was incomplete. The same attempt is preserved for retry.");
      clearAttempt("decision-proposal"); showNew("decision-proposal", false); revisionProposalId = undefined; revisionKind = undefined; say("Labelled decision proposal submitted for owner review; identity remains self-declared."); await loadOverview();
    } catch (error) { say(error instanceof Error && error.message ? error.message : "The decision proposal is pending. Retry this same attempt when the network is ready."); }
    finally { busy = false; if (decisionProposalSubmit) decisionProposalSubmit.disabled = false; }
  };
  const makePosition = () => {
    const attempt = parseAttempt("decision-position"); if (attempt) return attempt.payload;
    const payload = {
      actor_label: positionReporter?.value.trim() || "Anonymous participant",
      base_revision: Number(currentOverview?.published_revision ?? 0),
      body: { decision_proposal_id: positionDecisionId?.value.trim() || currentDecision?.decision_id || "", decision_revision: Number(positionRevision?.value || currentDecision?.revision || 0), participant_label: positionParticipant?.value.trim() || "", statement: positionStatement?.value.trim() || "" },
      client_retry_id: browserGlobal.crypto.randomUUID(),
      kind: "decision.position",
      source_message_ids: lines(positionSources?.value),
    };
    saveAttempt("decision-position", payload, { revision_proposal_id: revisionProposalId, revision_kind: revisionKind }); return payload;
  };
  const submitPosition = async () => {
    if (busy) return; busy = true; if (positionSubmit) positionSubmit.disabled = true;
    const payload = makePosition();
    try {
      const attempt = parseAttempt("decision-position");
      const targetProposalId = attempt?.revision_proposal_id ?? revisionProposalId;
      const targetKind = attempt?.revision_kind ?? revisionKind;
      const endpoint = targetProposalId && targetKind === "decision.position" ? `${api}/proposals/${encodeURIComponent(targetProposalId)}/revisions` : `${api}/proposals`;
      const response = await fetch(endpoint, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) {
        const message = await errorMessage(response);
        if (response.status === 400 || response.status === 413) { showNew("decision-position", true); throw Error(`${message} Edit the fields, then choose the new-submission action; retry keeps this attempt frozen.`); }
        throw Error(message);
      }
      const receipt = await response.json().catch(() => undefined) as { proposal?: { proposal_id?: string; revision?: number }; position?: { position_id?: string } } | undefined;
      if (!receipt?.proposal?.proposal_id || !receipt.position?.position_id) throw Error("The reported position receipt was incomplete. The same attempt is preserved for retry.");
      clearAttempt("decision-position"); showNew("decision-position", false); revisionProposalId = undefined; revisionKind = undefined; say("Labelled position submitted for owner review; it does not approve the decision."); await loadOverview();
    } catch (error) { say(error instanceof Error && error.message ? error.message : "The reported position is pending. Retry this same attempt when the network is ready."); }
    finally { busy = false; if (positionSubmit) positionSubmit.disabled = false; }
  };
  const makeDecisionPublication = (mode: "recommendation" | "acceptance") => {
    const attempt = parseAttempt("decision-publication");
    if (attempt) return attempt.payload;
    const decisionPublication = mode === "recommendation"
      ? { mode }
      : { approvals: parseApprovalEvidence(), mode, owner_attestation: approvalAttestation?.checked === true };
    const payload = {
      base_revision: mode === "acceptance" ? Number(currentOverview?.published_revision ?? currentDecision?.base_revision ?? 0) : Number(currentDecision?.base_revision ?? currentOverview?.published_revision ?? 0),
      client_retry_id: browserGlobal.crypto.randomUUID(),
      decision_publication: decisionPublication,
      owner_label: approvalOwnerLabel?.value.trim() || owner?.value.trim() || "Room owner",
      proposal_id: currentDecision?.decision_id || "",
      revision: currentDecision?.revision || 0,
    };
    saveAttempt("decision-publication", payload); return payload;
  };
  const submitDecisionPublication = async (mode: "recommendation" | "acceptance") => {
    if (busy || !currentDecision || !ownerManagementUrl) { if (!ownerManagementUrl) say("Add the private owner management URL before recording a decision."); return; }
    const attempt = parseAttempt("decision-publication");
    const attemptMode = attempt?.payload.decision_publication && typeof attempt.payload.decision_publication === "object" ? (attempt.payload.decision_publication as Record<string, unknown>).mode : undefined;
    const attemptMatches = attempt?.payload.proposal_id === currentDecision.decision_id && attempt.payload.revision === currentDecision.revision && attemptMode === mode;
    if (attempt && !attemptMatches) { showNew("decision-publication", true); say("A different decision publication attempt is frozen. Inspect the selected proposal, then explicitly choose the new publication action before editing or retrying."); return; }
    if (mode === "acceptance" && currentDecision.state === "accepted" && !attemptMatches) { say("This accepted decision is immutable; inspect its approval metadata and exact source citations."); return; }
    busy = true; if (approvalSubmit) approvalSubmit.disabled = true;
    const payload = makeDecisionPublication(mode);
    try {
      const response = await fetch(`${ownerManagementUrl}/coordination/publish`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) { const message = await errorMessage(response); if (response.status === 400 || response.status === 413) showNew("decision-publication", true); throw Error(message); }
      const receipt = await response.json().catch(() => undefined) as { decision?: { decision_id?: string; state?: string }; accepted_record?: { accepted_record_id?: string } } | undefined;
      const complete = mode === "recommendation" ? receipt?.decision?.decision_id === currentDecision.decision_id : receipt?.decision?.decision_id === currentDecision.decision_id && receipt?.decision?.state === "accepted" && Boolean(receipt?.accepted_record?.accepted_record_id);
      if (!complete) throw Error("The decision publication receipt was incomplete. The same attempt is preserved for retry.");
      const decisionId = currentDecision.decision_id;
      clearAttempt("decision-publication"); showNew("decision-publication", false); say(mode === "recommendation" ? "Published the labelled decision recommendation. Approval remains unverified until owner attestation and exact evidence." : "Recorded the owner-attested accepted decision with metadata-only approval evidence."); await loadOverview(); await reviewDecision(decisionId);
    } catch (error) { say(error instanceof Error && error.message ? error.message : "Decision publication is pending. Retry this same frozen attempt after reviewing the current revision."); }
    finally { busy = false; if (approvalSubmit) approvalSubmit.disabled = false; }
  };
  const postApprovalMessage = async () => {
    if (busy) return;
    const attempt = parseAttempt("approval-message");
    const author = approvalMessageAuthor?.value.trim() || "Anonymous participant", content = approvalMessageContent?.value.trim() || "";
    if (!attempt && !content) { say("Enter approval message text before explicitly posting an ordinary message."); return; }
    busy = true; if (approvalMessageSubmit) approvalMessageSubmit.disabled = true;
    try {
      const payload = attempt?.payload ?? { author, client_retry_id: browserGlobal.crypto.randomUUID(), content, display_name: author, idempotency_key: browserGlobal.crypto.randomUUID(), semantic_type: "decision" };
      if (!attempt) saveAttempt("approval-message", payload);
      const response = await fetch(`/${encodeURIComponent(room)}`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "idempotency-key": String(payload.idempotency_key) }, body: JSON.stringify({ author: payload.author, content: payload.content, display_name: payload.display_name, semantic_type: payload.semantic_type }) });
      if (!response.ok) { const message = await errorMessage(response); if (response.status === 400 || response.status === 413) showNew("approval-message", true); throw Error(message); }
      const receipt = await response.json().catch(() => undefined) as { message?: { id?: string } } | undefined;
      if (!receipt?.message?.id) throw Error("The ordinary approval message receipt was incomplete.");
      clearAttempt("approval-message"); showNew("approval-message", false); say(`Posted ordinary approval message ${receipt.message.id} explicitly; inspect ${`/${encodeURIComponent(room)}/messages/${encodeURIComponent(receipt.message.id)}`} before using it as evidence.`);
      if (approvalMessageContent) approvalMessageContent.value = "";
    } catch (error) { say(error instanceof Error && error.message ? error.message : "The ordinary approval message could not be posted."); }
    finally { busy = false; if (approvalMessageSubmit) approvalMessageSubmit.disabled = false; }
  };
  const inspectApprovalEvidence = async () => {
    if (!currentDecision || !approvalEvidenceReview) { say("Review an exact decision proposal before inspecting prospective approval evidence."); return; }
    const approvals = parseApprovalEvidence();
    approvalEvidenceReview.replaceChildren();
    const heading = documentObject.createElement("p"); heading.textContent = `Prospective approval evidence for proposal revision ${currentDecision.revision}; participant identities remain self-declared and unverified.`; approvalEvidenceReview.append(heading);
    for (const approval of approvals) {
      if (!approval.participant_label || !approval.source_message_id) { const line = documentObject.createElement("p"); line.textContent = "Each approval evidence line must contain a participant label and exact source message ID."; approvalEvidenceReview.append(line); continue; }
      try {
        const response = await fetch(`/${encodeURIComponent(room)}/messages/${encodeURIComponent(approval.source_message_id)}`, { headers: { accept: "application/json" } });
        const value = await response.json().catch(() => undefined) as { message?: { author?: string; content?: string; display_name?: string; id?: string; sequence?: number } } | undefined;
        if (!response.ok || !value?.message) throw Error();
        const message = value.message;
        const line = documentObject.createElement("p"); line.textContent = `${approval.participant_label} · source ${message.id || approval.source_message_id} · author ${message.author || "unknown"} · ${message.author === approval.participant_label ? "author label matches" : "author label does not match"} · exact text: ${message.content || ""}`; approvalEvidenceReview.append(line);
        if (message.id) { const link = documentObject.createElement("a"); link.href = `/${encodeURIComponent(room)}/messages/${encodeURIComponent(message.id)}`; link.textContent = "Open exact stored message"; link.target = "_blank"; link.rel = "noreferrer"; approvalEvidenceReview.append(link); }
      } catch { const line = documentObject.createElement("p"); line.textContent = `${approval.participant_label} · source ${approval.source_message_id} could not be loaded from this room.`; approvalEvidenceReview.append(line); }
    }
  };
  const renderDecisionSurface = async (decision: { decision_id: string; detail_url?: string; latest_proposal_revision: number; proposal_text: string; published_revision: number; required_approver_labels: readonly string[]; state: "recommended" | "accepted"; title: string; accepted_record_id?: string }, proposal: DecisionProposalRevision, positions: readonly Record<string, unknown>[] = []) => {
    if (!review) return;
    currentDecision = { accepted_record_id: decision.accepted_record_id, base_revision: proposal.base_revision, decision_id: decision.decision_id, required_approver_labels: [...decision.required_approver_labels], revision: proposal.revision, state: decision.state, title: decision.title };
    if (disputeAcceptedRecord) disputeAcceptedRecord.value = decision.accepted_record_id ?? "";
    if (disputeApprovalRecord) disputeApprovalRecord.replaceChildren();
    if (positionDecisionId) positionDecisionId.value = decision.decision_id;
    if (positionRevision) positionRevision.value = String(proposal.revision);
    if (approvalOwnerLabel) approvalOwnerLabel.value = approvalOwnerLabel.value || owner?.value.trim() || "Room owner";
    if (approvalLabels && !approvalLabels.value) approvalLabels.value = decision.required_approver_labels.map((label) => `${label} | `).join("\n");
    review.replaceChildren();
    const heading = documentObject.createElement("p"); heading.textContent = `Reviewing decision “${decision.title}” · proposal revision ${proposal.revision} · ${decision.state === "accepted" ? "owner-recorded accepted decision" : "recommendation"}`; review.append(heading);
    const body = documentObject.createElement("p"); body.textContent = `${proposal.body && typeof proposal.body.proposal_text === "string" ? proposal.body.proposal_text : decision.proposal_text} · participant identity is self-declared; exact evidence links are required.`; review.append(body);
    const labels = documentObject.createElement("p"); labels.textContent = `Required approval labels: ${decision.required_approver_labels.join(", ") || "none"}. Positions are reported participant statements and do not approve this decision.`; review.append(labels);
    const evidence = documentObject.createElement("p"); evidence.textContent = "Proposal source evidence (exact stored messages):"; review.append(evidence); appendDecisionSources(proposal);
    for (const position of positions) {
      const line = documentObject.createElement("p"); line.textContent = `Reported position · ${String(position.participant_label ?? "unknown participant")} · revision ${String(position.decision_revision ?? "?")}: ${String(position.statement ?? "")}`; review.append(line);
      const positionSourcesValue = Array.isArray(position.source_messages) ? position.source_messages : [];
      for (const source of positionSourcesValue) { if (!source || typeof source !== "object" || typeof (source as Record<string, unknown>).citation_url !== "string") continue; const link = documentObject.createElement("a"); link.href = String((source as Record<string, unknown>).citation_url); link.textContent = `Position source ${String((source as Record<string, unknown>).id ?? "stored message")}`; link.target = "_blank"; link.rel = "noreferrer"; review.append(link); }
    }
    if (ownerManagementUrl && decision.state === "recommended") {
      const recommendation = documentObject.createElement("button"); recommendation.type = "button"; recommendation.className = "button primary compact"; recommendation.textContent = "Publish labelled recommendation"; recommendation.onclick = () => { void submitDecisionPublication("recommendation"); }; review.append(recommendation);
      const attestation = documentObject.createElement("p"); attestation.textContent = "Owner acceptance is a separate explicit action. Check the attestation box after inspecting each exact source, then provide one participant label and source message ID for every required label."; review.append(attestation);
    }
    if (decision.state === "accepted" && decision.accepted_record_id) {
      const recordUrl = `${decision.detail_url || `${api}/decisions/${encodeURIComponent(decision.decision_id)}`}/records/${encodeURIComponent(decision.accepted_record_id)}`;
      const recordLink = documentObject.createElement("a"); recordLink.href = recordUrl; recordLink.textContent = "Inspect immutable accepted record and approval metadata"; recordLink.target = "_blank"; recordLink.rel = "noreferrer"; review.append(recordLink);
      try {
        const recordResponse = await fetch(recordUrl, { headers: { accept: "application/json" } });
        if (recordResponse.ok) {
          const recordValue = await recordResponse.json() as { accepted_record?: { owner_label?: string; owner_attestation?: boolean; decision_revision?: number; accepted_record_id?: string }; approvals?: readonly { participant_label?: string; source_message_id?: string; source_author?: string; citation_url?: string; approval_record_id?: string }[] };
          const metadata = documentObject.createElement("p"); metadata.textContent = `Immutable accepted record ${String(recordValue.accepted_record?.accepted_record_id ?? decision.accepted_record_id)} · owner ${String(recordValue.accepted_record?.owner_label ?? "unknown")} · attestation ${recordValue.accepted_record?.owner_attestation === true ? "true" : "missing"} · proposal revision ${String(recordValue.accepted_record?.decision_revision ?? proposal.revision)}.`; review.append(metadata);
          for (const approval of recordValue.approvals ?? []) {
            const line = documentObject.createElement("p"); line.textContent = `Approval metadata · ${String(approval.participant_label ?? "unknown")} · source author ${String(approval.source_author ?? "unknown")} · source ${String(approval.source_message_id ?? "unknown")} · stable approval ${String(approval.approval_record_id ?? "unknown")}`; review.append(line);
            if (disputeApprovalRecord && approval.approval_record_id) { const option = documentObject.createElement("option"); option.value = approval.approval_record_id; option.textContent = `${approval.participant_label ?? "unknown participant"} · exact approval ${approval.approval_record_id}`; disputeApprovalRecord.append(option); }
            if (approval.citation_url) { const link = documentObject.createElement("a"); link.href = approval.citation_url; link.textContent = "Open exact approval source"; link.target = "_blank"; link.rel = "noreferrer"; review.append(link); }
          }
          const annotations = (decision as { current_annotations?: Record<string, unknown> }).current_annotations;
          if (annotations) {
            const annotation = documentObject.createElement("p"); annotation.textContent = `Current annotations: ${Number(annotations.report_count ?? 0)} reports, ${Number(annotations.unresolved_report_count ?? 0)} unresolved; ${annotations.contested === true ? "contested" : "not currently contested"}.`;
            review.append(annotation);
            for (const key of ["reports_url", "predecessors_url", "successors_url"] as const) { if (typeof annotations[key] !== "string") continue; const link = documentObject.createElement("a"); link.href = annotations[key] as string; link.textContent = key === "reports_url" ? "Inspect bounded dispute reports" : key === "predecessors_url" ? "Inspect predecessor history" : "Inspect successor history"; link.target = "_blank"; link.rel = "noreferrer"; review.append(link); }
          }
        }
      } catch { /* The immutable record link remains available when the metadata read is temporarily unavailable. */ }
    }
  };
  const reviewDecision = async (decisionId: string) => {
    if (!review) return;
    resetDecisionReview();
    try {
      const response = await fetch(`${api}/decisions/${encodeURIComponent(decisionId)}?limit=20`, { headers: { accept: "application/json" } });
      if (!response.ok) throw Error();
      const value = await response.json() as { decision?: { decision_id: string; detail_url?: string; latest_proposal_revision: number; proposal_text: string; published_revision: number; required_approver_labels: readonly string[]; state: "recommended" | "accepted"; title: string; accepted_record_id?: string }; history?: readonly { kind?: string; proposal?: DecisionProposalRevision; body?: Record<string, unknown>; proposal_id?: string | null; proposal_revision?: number | null }[]; positions?: readonly Record<string, unknown>[] };
      if (!value.decision) throw Error();
      const latest = [...(value.history ?? [])].reverse().find((entry) => entry.kind === "decision.proposal" && entry.proposal);
      const proposal = latest?.proposal ?? { proposal_id: value.decision.decision_id, revision: latest?.proposal_revision ?? value.decision.latest_proposal_revision, base_revision: value.decision.published_revision, body: { proposal_text: value.decision.proposal_text, required_approver_labels: value.decision.required_approver_labels, title: value.decision.title } };
      await renderDecisionSurface(value.decision, proposal, value.positions ?? []);
    } catch { say("The decision evidence could not be loaded. Retry the exact decision review."); }
  };
  const reviewProposal = async (proposalId: string, revision: number) => {
    if (!review) return;
    resetDecisionReview();
    try {
      const response = await fetch(`${api}/proposals/${encodeURIComponent(proposalId)}/revisions/${revision}`, { headers: { accept: "application/json" } });
      if (!response.ok) throw Error();
      const value = await response.json() as { proposal?: { proposal_id: string; revision: number; base_revision: number; actor_label?: string; kind?: string; body?: Record<string, unknown>; source_messages?: readonly { id?: string; author?: string; display_name?: string; citation_url?: string }[]; status?: string } };
      const proposal = value.proposal;
      if (!proposal) throw Error();
      currentProposal = { proposal_id: proposal.proposal_id, revision: proposal.revision, base_revision: proposal.base_revision, kind: proposal.kind };
      if (proposal.kind === "claim.correction") {
        const bodyValue = proposal.body ?? {};
        const target = bodyValue.target && typeof bodyValue.target === "object" && !Array.isArray(bodyValue.target) ? bodyValue.target as Record<string, unknown> : {};
        if (correctionActor) correctionActor.value = String(proposal.actor_label ?? "");
        if (correctionText) correctionText.value = String(bodyValue.correction_text ?? "");
        if (correctionSources) correctionSources.value = (proposal.source_messages ?? []).map((source) => source.id || "").filter(Boolean).join("\n");
        if (correctionTargetType) correctionTargetType.value = String(target.type ?? "message");
        if (correctionMessageId) correctionMessageId.value = String(target.message_id ?? "");
        if (correctionPublicationRevision) correctionPublicationRevision.value = String(target.published_revision ?? "");
        if (correctionClaimPath) correctionClaimPath.value = JSON.stringify(target.claim_path ?? []);
        review.replaceChildren();
        const heading = documentObject.createElement("p"); heading.textContent = `Reviewing attributed correction ${proposal.proposal_id} revision ${proposal.revision}; the original claim remains unchanged.`; review.append(heading);
        const body = documentObject.createElement("p"); body.textContent = `Reported by ${proposal.actor_label}; correction text: ${String(bodyValue.correction_text ?? "")}`; review.append(body);
        sourceLinks(review, (proposal.source_messages ?? []) as unknown as Record<string, unknown>[]);
        await inspectCorrectionTarget();
        if (ownerManagementUrl && proposal.status === "pending") { const publish = documentObject.createElement("button"); publish.type = "button"; publish.className = "button primary compact"; publish.textContent = "Publish this exact correction revision"; publish.onclick = () => { void publishCurrent(); }; review.append(publish); }
        const rebase = documentObject.createElement("button"); rebase.type = "button"; rebase.className = "button compact"; rebase.textContent = "Edit correction as an explicit new revision"; rebase.onclick = () => { revisionProposalId = proposal.proposal_id; revisionKind = "claim.correction"; clearAttempt("correction"); showNew("correction", false); say("Edit the correction fields and submit an explicit new revision against the current published state."); }; review.append(rebase);
        return;
      }
      if (proposal.kind === "decision.supersession") {
        const bodyValue = proposal.body ?? {};
        if (supersessionActor) supersessionActor.value = String(proposal.actor_label ?? "");
        if (supersessionPredecessor) supersessionPredecessor.value = String(bodyValue.predecessor_accepted_record_id ?? "");
        if (supersessionSuccessor) supersessionSuccessor.value = String(bodyValue.successor_decision_id ?? "");
        if (supersessionRevision) supersessionRevision.value = String(bodyValue.successor_decision_revision ?? "");
        if (supersessionSources) supersessionSources.value = (proposal.source_messages ?? []).map((source) => source.id || "").filter(Boolean).join("\n");
        review.replaceChildren();
        const heading = documentObject.createElement("p"); heading.textContent = `Reviewing proposed supersession ${proposal.proposal_id} revision ${proposal.revision}; this is a pending relationship, not an accepted decision.`; review.append(heading);
        const body = documentObject.createElement("p"); body.textContent = `Accepted predecessor ${String(bodyValue.predecessor_accepted_record_id ?? "?")} → successor decision ${String(bodyValue.successor_decision_id ?? "?")} revision ${String(bodyValue.successor_decision_revision ?? "?")}. A recommendation cannot supersede acceptance.`; review.append(body);
        sourceLinks(review, (proposal.source_messages ?? []) as unknown as Record<string, unknown>[]);
        if (ownerManagementUrl && proposal.status === "pending") { const publish = documentObject.createElement("button"); publish.type = "button"; publish.className = "button primary compact"; publish.textContent = "Publish this exact supersession revision"; publish.onclick = () => { void publishCurrent(); }; review.append(publish); }
        const rebase = documentObject.createElement("button"); rebase.type = "button"; rebase.className = "button compact"; rebase.textContent = "Rebase relationship explicitly after successor acceptance"; rebase.onclick = () => { revisionProposalId = proposal.proposal_id; revisionKind = "decision.supersession"; clearAttempt("supersession"); showNew("supersession", false); say("Inspect the exact successor acceptance, then submit an explicit rebased relationship revision."); }; review.append(rebase);
        return;
      }
      if (proposal.kind === "decision.proposal") {
        const bodyValue = proposal.body ?? {};
        const decision = { decision_id: proposal.proposal_id, detail_url: `${api}/decisions/${encodeURIComponent(proposal.proposal_id)}`, latest_proposal_revision: proposal.revision, proposal_text: String(bodyValue.proposal_text ?? ""), published_revision: Number(currentOverview?.published_revision ?? proposal.base_revision), required_approver_labels: Array.isArray(bodyValue.required_approver_labels) ? bodyValue.required_approver_labels.map(String) : [], state: "recommended" as const, title: String(bodyValue.title ?? "Decision proposal") };
        await renderDecisionSurface(decision, proposal);
        const rebase = documentObject.createElement("button"); rebase.type = "button"; rebase.className = "button compact"; rebase.textContent = "Edit decision as explicit new revision"; rebase.onclick = () => {
          revisionProposalId = proposal.proposal_id; revisionKind = "decision.proposal"; clearAttempt("decision-proposal"); showNew("decision-proposal", false);
          if (decisionActor) decisionActor.value = String(proposal.actor_label ?? "");
          if (decisionTitle) decisionTitle.value = String(bodyValue.title ?? "");
          if (decisionText) decisionText.value = String(bodyValue.proposal_text ?? "");
          if (decisionRequiredLabels) decisionRequiredLabels.value = Array.isArray(bodyValue.required_approver_labels) ? bodyValue.required_approver_labels.map(String).join("\n") : "";
          if (decisionSources) decisionSources.value = (proposal.source_messages ?? []).map((source) => source.id || "").filter(Boolean).join("\n");
          say("Edit the labelled decision proposal and submit an explicit new revision against the current published state.");
        };
        review.append(rebase);
        return;
      }
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
      const receipt = await response.json().catch(() => undefined) as { proposal?: { proposal_id?: string; revision?: number }; request?: { request_id?: string }; panel?: { proposal_id?: string; published_revision?: number }; correction?: { correction_id?: string }; supersession?: { supersession_id?: string }; decision?: { decision_id?: string }; position?: { position_id?: string } } | undefined;
      const hasResult = currentProposal.kind === "panel.replace" ? Boolean(receipt?.panel?.proposal_id) : currentProposal.kind === "claim.correction" ? Boolean(receipt?.correction?.correction_id) : currentProposal.kind === "decision.supersession" ? Boolean(receipt?.supersession?.supersession_id) : currentProposal.kind === "decision.proposal" ? Boolean(receipt?.decision?.decision_id) : currentProposal.kind === "decision.position" ? Boolean(receipt?.position?.position_id) : Boolean(receipt?.request?.request_id);
      if (!receipt?.proposal?.proposal_id || !hasResult) throw Error("The publication receipt was incomplete. The same attempt is preserved for retry.");
      clearAttempt("publication"); say("Published the exact reviewed proposal revision."); await loadOverview();
    } catch (error) { say(error instanceof Error && error.message ? error.message : "Publication is pending. Retry this same attempt after reviewing the current revision."); }
    finally { busy = false; if (ownerSave) ownerSave.disabled = false; }
  };
  const restoreStructuredAttempts = () => {
    const correctionAttempt = parseAttempt("correction");
    if (correctionAttempt) {
      const payload = correctionAttempt.payload;
      const body = payload.body && typeof payload.body === "object" && !Array.isArray(payload.body) ? payload.body as Record<string, unknown> : {};
      const target = body.target && typeof body.target === "object" && !Array.isArray(body.target) ? body.target as Record<string, unknown> : {};
      if (correctionActor) correctionActor.value = String(payload.actor_label ?? "");
      if (correctionText) correctionText.value = String(body.correction_text ?? "");
      if (correctionSources) correctionSources.value = Array.isArray(payload.source_message_ids) ? payload.source_message_ids.map(String).join("\n") : "";
      if (correctionTargetType) correctionTargetType.value = String(target.type ?? "message");
      if (correctionMessageId) correctionMessageId.value = String(target.message_id ?? "");
      if (correctionPublicationRevision) correctionPublicationRevision.value = String(target.published_revision ?? "");
      if (correctionClaimPath) setChoiceValue(correctionClaimPath, Array.isArray(target.claim_path) ? JSON.stringify(target.claim_path) : "[]");
      say("A saved correction attempt is ready; its original target and body will be retried until you choose a new correction.");
    }
    const disputeAttempt = parseAttempt("dispute");
    if (disputeAttempt) {
      const payload = disputeAttempt.payload;
      if (disputeActor) disputeActor.value = String(payload.actor_label ?? "");
      if (disputeAcceptedRecord) disputeAcceptedRecord.value = String(payload.accepted_record_id ?? "");
      if (disputeKind) disputeKind.value = String(payload.kind ?? "dispute");
      if (disputeApprovalRecord) setChoiceValue(disputeApprovalRecord, String(payload.approval_record_id ?? ""));
      if (disputeStatement) disputeStatement.value = String(payload.statement ?? "");
      if (disputeSources) disputeSources.value = Array.isArray(payload.source_message_ids) ? payload.source_message_ids.map(String).join("\n") : "";
      say("A saved dispute report is ready; its accepted record, approval ID, and reporter attribution remain frozen for retry.");
    }
    const reviewAttempt = parseAttempt("dispute-review");
    if (reviewAttempt) {
      const payload = reviewAttempt.payload;
      if (disputeReviewReport) disputeReviewReport.value = reviewAttempt.target_id ?? "";
      if (disputeReviewDisposition) disputeReviewDisposition.value = String(payload.disposition ?? "acknowledged");
      if (disputeReviewRationale) disputeReviewRationale.value = String(payload.rationale ?? "");
      if (disputeReviewSources) disputeReviewSources.value = Array.isArray(payload.source_message_ids) ? payload.source_message_ids.map(String).join("\n") : "";
      say("A saved owner review is ready; its exact report target and decision remain frozen for retry.");
    }
    const supersessionAttempt = parseAttempt("supersession");
    if (supersessionAttempt) {
      const payload = supersessionAttempt.payload;
      const body = payload.body && typeof payload.body === "object" && !Array.isArray(payload.body) ? payload.body as Record<string, unknown> : {};
      if (supersessionActor) supersessionActor.value = String(payload.actor_label ?? "");
      if (supersessionPredecessor) supersessionPredecessor.value = String(body.predecessor_accepted_record_id ?? "");
      if (supersessionSuccessor) supersessionSuccessor.value = String(body.successor_decision_id ?? "");
      if (supersessionRevision) supersessionRevision.value = String(body.successor_decision_revision ?? "");
      if (supersessionSources) supersessionSources.value = Array.isArray(payload.source_message_ids) ? payload.source_message_ids.map(String).join("\n") : "";
      say("A saved supersession attempt is ready; its predecessor, successor, and revision remain frozen for retry.");
    }
    const retentionAttempt = parseRetentionAttempt();
    if (retentionAttempt) {
      if (retentionTarget) retentionTarget.value = retentionAttempt.expires_at;
      if (retentionStatus) retentionStatus.textContent = `Retry target frozen at ${retentionAttempt.expires_at}. Inspect bounds only when choosing a new target.`;
    }
    renderRetention();
  };
  if (ownerUrl) { ownerUrl.value = ownerManagementUrl ?? ""; }
  for (const button of documentObject.querySelectorAll("[data-coordination-open]")) button.onclick = () => { (panel as CoordinationElement & { showModal?: () => void }).showModal?.(); };
  for (const button of documentObject.querySelectorAll("[data-coordination-close]")) button.onclick = () => { (panel as CoordinationElement & { close?: () => void }).close?.(); };
  ownerForm?.addEventListener("submit", (event: { preventDefault(): void }) => { event.preventDefault(); const result = helpers.retain(ownerUrl?.value.trim() ?? "", location.origin, room, storage); ownerManagementUrl = result.normalized; if (result.retained) say(result.message); else { say(result.message); if (result.saveUrl && ownerUrl) { ownerUrl.value = result.saveUrl; ownerUrl.select(); } } void loadOverview(); void loadRetentionBounds(); });
  proposalForm?.addEventListener("submit", (event: { preventDefault(): void }) => { event.preventDefault(); void submitProposal(); });
  progressForm?.addEventListener("submit", (event: { preventDefault(): void }) => { event.preventDefault(); void submitProgress(); });
  panelForm?.addEventListener("submit", (event: { preventDefault(): void }) => { event.preventDefault(); void submitPanel(); });
  decisionProposalForm?.addEventListener("submit", (event: { preventDefault(): void }) => { event.preventDefault(); void submitDecisionProposal(); });
  positionForm?.addEventListener("submit", (event: { preventDefault(): void }) => { event.preventDefault(); void submitPosition(); });
  decisionApprovalForm?.addEventListener("submit", (event: { preventDefault(): void }) => { event.preventDefault(); void submitDecisionPublication("acceptance"); });
  approvalMessageForm?.addEventListener("submit", (event: { preventDefault(): void }) => { event.preventDefault(); void postApprovalMessage(); });
  correctionForm?.addEventListener("submit", (event: { preventDefault(): void }) => { event.preventDefault(); void submitCorrection(); });
  correctionInspect?.addEventListener("click", () => { void inspectCorrectionTarget(); });
  disputeForm?.addEventListener("submit", (event: { preventDefault(): void }) => { event.preventDefault(); void submitDispute(); });
  disputeInspect?.addEventListener("click", () => { void inspectDisputeSources(); });
  disputeReviewSubmit?.addEventListener("click", (event: { preventDefault(): void }) => { event.preventDefault(); void submitDisputeReview(); });
  disputeReviewForm?.addEventListener("submit", (event: { preventDefault(): void }) => { event.preventDefault(); void submitDisputeReview(); });
  supersessionForm?.addEventListener("submit", (event: { preventDefault(): void }) => { event.preventDefault(); void submitSupersession(); });
  supersessionInspect?.addEventListener("click", () => { void inspectSupersession(); });
  approvalEvidenceInspect?.addEventListener("click", () => { void inspectApprovalEvidence(); });
  approvalLabels?.addEventListener("input", () => { if (!parseAttempt("decision-publication") && approvalAttestation) approvalAttestation.checked = false; if (approvalEvidenceReview) approvalEvidenceReview.replaceChildren(); });
  proposalNew?.addEventListener("click", () => useEditedFields("proposal"));
  progressNew?.addEventListener("click", () => useEditedFields("progress"));
  panelNew?.addEventListener("click", () => useEditedFields("panel"));
  decisionProposalNew?.addEventListener("click", () => useEditedFields("decision-proposal"));
  positionNew?.addEventListener("click", () => useEditedFields("decision-position"));
  approvalNew?.addEventListener("click", () => { useEditedFields("decision-publication"); if (approvalAttestation) approvalAttestation.checked = false; });
  approvalMessageNew?.addEventListener("click", () => useEditedFields("approval-message"));
  correctionNew?.addEventListener("click", () => { useEditedFields("correction"); revisionProposalId = undefined; revisionKind = undefined; });
  disputeNew?.addEventListener("click", () => useEditedFields("dispute"));
  disputeReviewNew?.addEventListener("click", () => { useEditedFields("dispute-review"); void loadOverview().then(() => say("The current publication base is loaded for this explicit rebased review.")); });
  retentionRefresh?.addEventListener("click", () => { void loadRetentionBounds(); });
  retentionExtend?.addEventListener("click", () => { void submitRetention(); });
  retentionNew?.addEventListener("click", () => { if (retentionBusy) return; clearRetentionAttempt(); retentionBoundsValue = undefined; if (retentionTarget) retentionTarget.value = ""; renderRetention(); if (retentionStatus) retentionStatus.textContent = "Choose a new target after the private bounds are refreshed."; void loadRetentionBounds(); });
  supersessionNew?.addEventListener("click", () => { useEditedFields("supersession"); revisionProposalId = undefined; revisionKind = undefined; });
  coordinationRefresh?.addEventListener("click", () => { void loadOverview(); });
  filterForm?.addEventListener("submit", (event: { preventDefault(): void }) => { event.preventDefault(); void loadOverview(); });
  restoreStructuredAttempts();
  renderRetention();
  void loadOverview();
}
