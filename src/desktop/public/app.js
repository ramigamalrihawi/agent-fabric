const SENIOR_CLAIM_DEFAULTS = {
  worker: "deepseek-direct",
  workspaceMode: "git_worktree",
  workspacePath: "",
  modelProfile: "deepseek-v4-pro:max",
  maxRuntimeMinutes: "",
  batchLimit: 10
};

const state = {
  queues: [],
  selectedQueueId: null,
  claimDefaults: { ...SENIOR_CLAIM_DEFAULTS },
  dashboard: null,
  matrix: null,
  actionInbox: null,
  approvals: null,
  timeline: null,
  lanes: null,
  lastSnapshotAt: null,
  readiness: null,
  launchPlan: null,
  readyPacketLinks: null,
  memoryInbox: null,
  lastClaimResult: null,
  lastClaimBatchId: null,
  projectPolicyStatus: null,
  selectedTaskId: null,
  taskDetail: null,
  activeTab: "dashboard",
  apiToken: null,
  theaterFocus: false,
  theaterOnlyActive: true,
  commandPaletteOpen: false,
  commandPaletteQuery: "",
  commandPaletteIndex: 0,
  commandPaletteReturnFocus: null,
  pendingActions: new Set(),
  notices: [],
  nextNoticeId: 1,
  lastPolicyResult: null,
  lastImprovedPrompt: ""
};

const DESKTOP_PREFS_KEY = "agent-fabric.desktop.preferences.v2";
const VALID_TABS = new Set(["dashboard", "pipeline", "tasks", "matrix", "approvals", "memory", "context", "model-brain", "theater", "activity"]);
const TAB_LABELS = {
  dashboard: "Dashboard",
  pipeline: "Pipeline",
  tasks: "Tasks",
  matrix: "Matrix",
  approvals: "Approvals",
  memory: "Memory",
  context: "Context",
  "model-brain": "Model Brain",
  theater: "Theater",
  activity: "Activity"
};

const COMMON_POLICY_GRANTS = [
  { kind: "tool", value: "shell", label: "Shell" },
  { kind: "tool", value: "browser", label: "Browser" },
  { kind: "tool", value: "network", label: "Network" },
  { kind: "mcp_server", value: "filesystem", label: "Filesystem MCP" },
  { kind: "mcp_server", value: "github", label: "GitHub MCP" },
  { kind: "mcp_server", value: "memory", label: "Memory MCP" }
];

const PIPELINE_STAGES = [
  ["prompt_improvement", "Prompt Improvement"],
  ["planning", "Planning"],
  ["phasing", "Phasing"],
  ["task_writing", "Task Writing"],
  ["queue_shaping", "Queue Shaping"],
  ["tool_context", "Tool/Context"],
  ["execution", "Execution"],
  ["review", "Review"],
  ["decision", "Decision"]
];

const $ = (selector) => document.querySelector(selector);

function isActionPending(key) {
  return state.pendingActions.has(key);
}

function claimActionPending() {
  return isActionPending("claim-next") || isActionPending("claim-ready");
}

function setActionPending(key, pending) {
  if (pending) state.pendingActions.add(key);
  else state.pendingActions.delete(key);
  syncPendingButtons();
}

async function withPendingAction(key, task, busyMessage = "Action already running.") {
  if (isActionPending(key)) {
    toast(busyMessage);
    return null;
  }
  setActionPending(key, true);
  try {
    return await task();
  } finally {
    setActionPending(key, false);
  }
}

function syncPendingButtons() {
  const claimBusy = claimActionPending();
  document.querySelectorAll("#claim-worker-form button[type='submit'], #claim-ready-batch, [data-action-claim-ready], [data-theater-claim]").forEach((button) => {
    setButtonBusyState(button, claimBusy, "Claiming...");
  });
  document.querySelectorAll("[data-review-accept]").forEach((button) => {
    setButtonBusyState(button, isActionPending(`review-accept:${button.dataset.reviewAccept || ""}`), "Accepting...");
  });
  document.querySelectorAll("[data-review-retry]").forEach((button) => {
    setButtonBusyState(button, isActionPending(`review-retry:${button.dataset.reviewRetry || ""}`), "Retrying...");
  });
  document.querySelectorAll("[data-tool-approval], [data-claim-tool-approval], [data-task-tool-approval]").forEach((button) => {
    setButtonBusyState(button, isActionPending(`tool:${button.dataset.proposalId || ""}:${button.dataset.decision || ""}`), "Saving...");
  });
  document.querySelectorAll("[data-model-approval], [data-brain-model-approval]").forEach((button) => {
    setButtonBusyState(button, isActionPending(`model:${button.dataset.requestId || ""}:${button.dataset.decision || ""}`), "Saving...");
  });
  document.querySelectorAll("[data-memory-review]").forEach((button) => {
    setButtonBusyState(button, isActionPending(`memory:${button.dataset.memoryId || ""}:${button.dataset.decision || ""}`), "Saving...");
  });
}

function setButtonBusyState(button, busy, label) {
  if (!button) return;
  if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent.trim();
  if (busy) {
    if (!button.disabled) button.dataset.pendingEnabled = "1";
    button.disabled = true;
    button.textContent = label;
    button.classList.add("is-busy");
    return;
  }
  if (button.dataset.pendingEnabled === "1") {
    button.disabled = false;
    delete button.dataset.pendingEnabled;
  }
  button.textContent = button.dataset.idleLabel;
  button.classList.remove("is-busy");
}

document.addEventListener("DOMContentLoaded", () => {
  if (window.location.protocol === "file:") {
    upsertNotice("file-mode", "Desktop server required", {
      severity: "error",
      detail: "Open this shell through the local desktop server so queue state, auth, and mutation approvals stay same-origin."
    });
    renderFileModeNotice();
    return;
  }
  window.addEventListener("unhandledrejection", (event) => {
    upsertNotice("unexpected-error", "Unexpected UI failure", {
      severity: "error",
      detail: messageOf(event.reason)
    });
  });
  window.addEventListener("error", (event) => {
    upsertNotice("unexpected-error", "Unexpected UI failure", {
      severity: "error",
      detail: event.message || messageOf(event.error)
    });
  });
  restoreDesktopPreferences();
  restoreUrlState();
  $("#command-palette-open").addEventListener("click", () => openCommandPalette());
  $("#command-palette-close").addEventListener("click", () => closeCommandPalette());
  $("#command-palette").addEventListener("mousedown", (event) => {
    if (event.target === $("#command-palette")) closeCommandPalette();
  });
  $("#command-palette-input").addEventListener("input", (event) => {
    state.commandPaletteQuery = event.target.value;
    state.commandPaletteIndex = 0;
    renderCommandPalette();
  });
  $("#command-palette-input").addEventListener("keydown", handleCommandPaletteInputKeydown);
  $("#refresh-all").addEventListener("click", () => refreshAll());
  $("#seed-demo-queue").addEventListener("click", () => seedDemoQueue());
  $("#new-queue-toggle").addEventListener("click", () => showNewQueueForm(true));
  $("#new-queue-cancel").addEventListener("click", () => showNewQueueForm(false));
  $("#new-queue-form").addEventListener("submit", (event) => {
    event.preventDefault();
    createQueue();
  });
  $("#project-filter").addEventListener("change", () => loadQueues());
  $("#include-closed").addEventListener("change", () => loadQueues());
  $("#edit-settings-toggle").addEventListener("click", () => showSettingsForm(true));
  $("#settings-cancel").addEventListener("click", () => showSettingsForm(false));
  $("#queue-settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveQueueSettings();
  });
  $("#import-tasks-form").addEventListener("submit", (event) => {
    event.preventDefault();
    importTasks();
  });
  $("#add-task-form").addEventListener("submit", (event) => {
    event.preventDefault();
    addTaskFromForm();
  });
  $("#pipeline-stage-form").addEventListener("submit", (event) => {
    event.preventDefault();
    recordPipelineStage();
  });
  $("#prompt-improve-form").addEventListener("submit", (event) => {
    event.preventDefault();
    improvePromptFromPipeline();
  });
  $("#start-plan-form").addEventListener("submit", (event) => {
    event.preventDefault();
    startPlanFromPipeline();
  });
  $("#pipeline-decision-form").addEventListener("submit", (event) => {
    event.preventDefault();
    recordPipelineDecision();
  });
  $("#import-sample").addEventListener("click", () => fillTaskSample());
  $("#prepare-ready").addEventListener("click", () => prepareReady());
  $("#launch-plan").addEventListener("click", () => loadLaunchPlan(true));
  $("#start-execution").addEventListener("click", () => decideQueue("start_execution"));
  $("#copy-current-link").addEventListener("click", () => copyCurrentLink());
  $("#inspect-context").addEventListener("click", () => inspectContext());
  $("#model-brain-form").addEventListener("submit", (event) => {
    event.preventDefault();
    routeModelBrain();
  });
  document.addEventListener("keydown", (event) => {
    if (isCommandPaletteShortcut(event)) {
      event.preventDefault();
      openCommandPalette();
      return;
    }
    if (event.key === "Escape" && state.commandPaletteOpen) {
      event.preventDefault();
      closeCommandPalette();
      return;
    }
    if (event.key === "Escape" && state.theaterFocus) {
      state.theaterFocus = false;
      renderTheater();
    }
  });
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => selectTab(button.dataset.tab));
  });
  selectTab(state.activeTab, { persist: false });
  refreshAll();
  window.setInterval(() => {
    if (state.selectedQueueId) loadSelectedQueue({ quiet: true });
  }, 10_000);
});

function renderFileModeNotice() {
  $("#daemon-line").textContent = "Open through the local desktop server.";
  $("#empty-state").innerHTML = `
    <div class="panel">
      <div class="section-head"><h2>Desktop Server Required</h2></div>
      <div class="muted">This shell needs the local agent-fabric desktop server so API calls, queue state, and mutation approvals stay same-origin.</div>
      <div class="activity-item"><strong>Start command</strong><div class="muted">npm run dev:desktop -- --no-open --port 0</div></div>
    </div>
  `;
}

async function refreshAll() {
  await loadBootstrap();
}

async function loadBootstrap(options = {}) {
  const params = new URLSearchParams();
  const projectPath = $("#project-filter").value.trim();
  if (projectPath) params.set("projectPath", projectPath);
  if ($("#include-closed").checked) params.set("includeClosed", "1");
  if (state.selectedQueueId) params.set("queueId", state.selectedQueueId);
  if (state.selectedTaskId) params.set("queueTaskId", state.selectedTaskId);
  params.set("timelineLimit", "40");
  params.set("maxEvents", "5");
  params.set("memoryMax", "25");
  params.set("includeTaskResume", "1");
  params.set("maxTaskEvents", "5");
  try {
    const requestedQueueId = state.selectedQueueId;
    const requestedTaskId = state.selectedTaskId;
    const bootstrap = await apiGet(`/api/bootstrap?${params.toString()}`);
    state.readiness = bootstrap.readiness || null;
    state.apiToken = state.readiness?.server?.apiToken || null;
    clearNoticeKind("daemon");
    renderReadinessLine();
    state.queues = bootstrap.queues?.queues || [];
    $("#queue-count").textContent = String(state.queues.length);
    state.selectedQueueId = bootstrap.selectedQueueId || null;
    if (state.selectedQueueId !== requestedQueueId) {
      state.selectedTaskId = null;
      state.taskDetail = null;
      state.launchPlan = null;
      state.readyPacketLinks = null;
      state.projectPolicyStatus = null;
    } else if (bootstrap.taskDetail) {
      state.taskDetail = bootstrap.taskDetail;
      state.selectedTaskId = bootstrap.taskDetail.task?.queueTaskId || requestedTaskId || state.selectedTaskId;
    } else if (bootstrap.taskDetailError) {
      state.selectedTaskId = null;
      state.taskDetail = null;
    }
    persistDesktopPreferences();
    renderQueues();
    if (bootstrap.snapshot) {
      applyQueueSnapshot(bootstrap.snapshot);
      renderSelectedQueue();
    } else {
      renderEmpty();
    }
    if (!options.quiet) toast("Desktop refreshed.");
  } catch (error) {
    state.readiness = null;
    $("#daemon-line").textContent = `Daemon unavailable: ${messageOf(error)}`;
    upsertNotice("daemon", "Daemon unavailable", {
      severity: "error",
      detail: messageOf(error),
      code: error?.code
    });
    if (!options.quiet) toast(`Refresh failed: ${messageOf(error)}`);
  }
}

async function loadStatus() {
  try {
    const readiness = await apiGet("/api/readiness");
    state.readiness = readiness;
    state.apiToken = readiness.server?.apiToken || state.apiToken;
    clearNoticeKind("daemon");
    renderReadinessLine();
  } catch (error) {
    state.readiness = null;
    $("#daemon-line").textContent = `Daemon unavailable: ${messageOf(error)}`;
    upsertNotice("daemon", "Daemon unavailable", {
      severity: "error",
      detail: messageOf(error),
      code: error?.code
    });
  }
}

function renderReadinessLine() {
  const readiness = state.readiness || {};
  const daemon = readiness.daemon?.daemon || readiness.daemon || {};
  $("#daemon-line").textContent = `${readiness.ready ? "ready" : "not ready"} - schema ${daemon.schemaVersion || "?"} - tools ${readiness.server?.safeToolCount || 0} - ${daemon.dbPath || ""}`;
}

async function loadQueues() {
  await loadBootstrap();
}

async function loadSelectedQueue(options = {}) {
  if (!state.selectedQueueId) return;
  const queueId = encodeURIComponent(state.selectedQueueId);
  const snapshot = await apiGet(`/api/queues/${queueId}/snapshot?timelineLimit=40&maxEvents=5&memoryMax=25`);
  applyQueueSnapshot(snapshot);
  renderSelectedQueue();
  if (!options.quiet) toast("Queue refreshed.");
}

function applyQueueSnapshot(snapshot = {}) {
  state.dashboard = snapshot.dashboard || {};
  state.matrix = snapshot.matrix || {};
  state.actionInbox = snapshot.actionInbox || {};
  state.approvals = snapshot.approvals || {};
  state.timeline = snapshot.timeline || {};
  state.lanes = snapshot.lanes || {};
  state.lastSnapshotAt = new Date().toISOString();
  state.memoryInbox = snapshot.memoryInbox || {};
}

function restoreDesktopPreferences() {
  const prefs = readDesktopPreferences();
  if (!prefs) return;
  if (typeof prefs.projectFilter === "string") $("#project-filter").value = prefs.projectFilter;
  $("#include-closed").checked = prefs.includeClosed === true;
  if (typeof prefs.selectedQueueId === "string" && prefs.selectedQueueId) state.selectedQueueId = prefs.selectedQueueId;
  if (typeof prefs.selectedTaskId === "string" && prefs.selectedTaskId) state.selectedTaskId = prefs.selectedTaskId;
  if (typeof prefs.activeTab === "string" && VALID_TABS.has(prefs.activeTab)) state.activeTab = prefs.activeTab;
  if (prefs.claimDefaults && typeof prefs.claimDefaults === "object" && !Array.isArray(prefs.claimDefaults)) {
    state.claimDefaults = normalizeClaimDefaults({ ...state.claimDefaults, ...prefs.claimDefaults });
  }
}

function restoreUrlState() {
  try {
    const params = new URLSearchParams(window.location?.search || "");
    const projectPath = params.has("projectPath") ? params.get("projectPath") : params.get("project");
    const includeClosed = params.get("includeClosed");
    const queueId = params.get("queueId") || params.get("queue");
    const queueTaskId = params.get("queueTaskId") || params.get("taskId") || params.get("task");
    const tab = params.get("tab");
    if (projectPath !== null) $("#project-filter").value = projectPath || "";
    if (includeClosed !== null) $("#include-closed").checked = includeClosed === "1" || includeClosed === "true";
    if (queueId) state.selectedQueueId = queueId;
    if (queueTaskId) state.selectedTaskId = queueTaskId;
    if (tab && VALID_TABS.has(tab)) state.activeTab = tab;
  } catch {
    // URL state is best-effort; local preferences and bootstrap still work without it.
  }
}

function readDesktopPreferences() {
  try {
    const raw = window.localStorage?.getItem(DESKTOP_PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistDesktopPreferences() {
  try {
    window.localStorage?.setItem(
      DESKTOP_PREFS_KEY,
      JSON.stringify(
        compactObject({
          selectedQueueId: state.selectedQueueId,
          selectedTaskId: state.selectedTaskId,
          activeTab: state.activeTab,
          projectFilter: $("#project-filter").value.trim(),
          includeClosed: $("#include-closed").checked,
          claimDefaults: state.claimDefaults
        })
      )
    );
  } catch {
    // The command center remains fully functional if browser storage is unavailable.
  }
  syncUrlState();
}

function syncUrlState() {
  try {
    const url = desktopUrlWithState();
    window.history?.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // Some embedded shells may not expose history; this should never block the app.
  }
}

function desktopUrlWithState(overrides = {}) {
  const url = new URL(window.location.href);
  const params = url.searchParams;
  const selectedQueueId = Object.hasOwn(overrides, "selectedQueueId") ? overrides.selectedQueueId : state.selectedQueueId;
  const selectedTaskId = Object.hasOwn(overrides, "selectedTaskId") ? overrides.selectedTaskId : state.selectedTaskId;
  const activeTab = Object.hasOwn(overrides, "activeTab") ? overrides.activeTab : state.activeTab;
  const includeClosed = Object.hasOwn(overrides, "includeClosed") ? overrides.includeClosed : $("#include-closed").checked;
  const projectPath = Object.hasOwn(overrides, "projectPath") ? overrides.projectPath : $("#project-filter").value.trim();
  setUrlParam(params, "projectPath", projectPath);
  setUrlParam(params, "queueId", selectedQueueId);
  setUrlParam(params, "queueTaskId", selectedQueueId ? selectedTaskId : null);
  setUrlParam(params, "tab", activeTab === "dashboard" ? "" : activeTab);
  setUrlParam(params, "includeClosed", includeClosed ? "1" : "");
  return url;
}

function setUrlParam(params, key, value) {
  if (value === undefined || value === null || value === "") {
    params.delete(key);
    return;
  }
  params.set(key, String(value));
}

function normalizeClaimDefaults(defaults = {}) {
  const maxRuntime = Number(defaults.maxRuntimeMinutes);
  const batchLimit = Number(defaults.batchLimit);
  return {
    worker: ["ramicode", "local-cli", "openhands", "aider", "smolagents", "deepseek-direct", "jcode-deepseek", "manual"].includes(defaults.worker) ? defaults.worker : SENIOR_CLAIM_DEFAULTS.worker,
    workspaceMode: ["git_worktree", "in_place", "clone", "sandbox"].includes(defaults.workspaceMode) ? defaults.workspaceMode : SENIOR_CLAIM_DEFAULTS.workspaceMode,
    workspacePath: typeof defaults.workspacePath === "string" ? defaults.workspacePath : "",
    modelProfile: typeof defaults.modelProfile === "string" && defaults.modelProfile.trim() ? defaults.modelProfile.trim() : SENIOR_CLAIM_DEFAULTS.modelProfile,
    maxRuntimeMinutes: Number.isFinite(maxRuntime) && maxRuntime > 0 ? String(Math.floor(maxRuntime)) : "",
    batchLimit: Number.isFinite(batchLimit) && batchLimit > 0 ? Math.min(16, Math.max(1, Math.floor(batchLimit))) : SENIOR_CLAIM_DEFAULTS.batchLimit
  };
}

function updateClaimDefaultsFromForm() {
  const maxRuntime = Number($("#claim-max-runtime")?.value);
  const batchLimit = Number($("#claim-batch-limit")?.value);
  state.claimDefaults = normalizeClaimDefaults({
    worker: $("#claim-worker")?.value,
    workspaceMode: $("#claim-workspace-mode")?.value,
    workspacePath: $("#claim-workspace-path")?.value.trim() || "",
    modelProfile: $("#claim-model-profile")?.value.trim() || SENIOR_CLAIM_DEFAULTS.modelProfile,
    maxRuntimeMinutes: Number.isFinite(maxRuntime) && maxRuntime > 0 ? String(Math.floor(maxRuntime)) : "",
    batchLimit: Number.isFinite(batchLimit) && batchLimit > 0 ? Math.floor(batchLimit) : 4
  });
}

function bindClaimDefaultControls(root) {
  root.querySelectorAll("#claim-worker, #claim-workspace-mode, #claim-workspace-path, #claim-model-profile, #claim-max-runtime, #claim-batch-limit").forEach((input) => {
    input.addEventListener("change", () => {
      updateClaimDefaultsFromForm();
      persistDesktopPreferences();
    });
    input.addEventListener("input", () => {
      updateClaimDefaultsFromForm();
      persistDesktopPreferences();
    });
  });
}

function applySeniorFactoryDefaults(options = {}) {
  state.claimDefaults = normalizeClaimDefaults(SENIOR_CLAIM_DEFAULTS);
  syncClaimDefaultsForm();
  persistDesktopPreferences();
  if (!options.quiet) toast("Senior Factory defaults applied.");
}

function syncClaimDefaultsForm() {
  const claim = state.claimDefaults || {};
  const values = {
    "#claim-worker": claim.worker,
    "#claim-workspace-mode": claim.workspaceMode,
    "#claim-workspace-path": claim.workspacePath,
    "#claim-model-profile": claim.modelProfile,
    "#claim-max-runtime": claim.maxRuntimeMinutes,
    "#claim-batch-limit": claim.batchLimit
  };
  for (const [selector, value] of Object.entries(values)) {
    const input = $(selector);
    if (input) input.value = value ?? "";
  }
}

function seniorFactoryCommandText() {
  if (!state.selectedQueueId) return "";
  const queueId = shellQuote(state.selectedQueueId);
  const limit = Math.max(1, Math.min(16, Number(state.claimDefaults?.batchLimit || 10) || 10));
  return [
    "AGENT_FABRIC_SENIOR_MODE=permissive",
    "agent-fabric-project",
    "factory-run",
    "--queue",
    queueId,
    "--start-execution",
    "--parallel",
    String(limit),
    "--limit",
    String(limit),
    "--deepseek-role",
    "auto",
    "--patch-mode",
    "write",
    "--allow-sensitive-context",
    "--continue-on-failure",
    "--json"
  ].join(" ");
}

async function copySeniorFactoryCommand() {
  if (!state.selectedQueueId) {
    toast("Select a queue before copying the Senior Factory command.");
    return;
  }
  await copyText(seniorFactoryCommandText());
  toast("Senior Factory command copied.");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function claimWorkerOptionsHtml(current) {
  return [
    ["ramicode", "RamiCode"],
    ["local-cli", "Local CLI"],
    ["openhands", "OpenHands"],
    ["aider", "Aider"],
    ["smolagents", "smolagents"],
    ["deepseek-direct", "DeepSeek direct"],
    ["jcode-deepseek", "Jcode DeepSeek"],
    ["manual", "Manual"]
  ]
    .map(([value, label]) => `<option value="${value}"${value === current ? " selected" : ""}>${label}</option>`)
    .join("");
}

function claimWorkspaceOptionsHtml(current) {
  return [
    ["git_worktree", "Git worktree"],
    ["in_place", "In place"],
    ["clone", "Clone"],
    ["sandbox", "Sandbox"]
  ]
    .map(([value, label]) => `<option value="${value}"${value === current ? " selected" : ""}>${label}</option>`)
    .join("");
}

async function copyCurrentLink() {
  syncUrlState();
  await copyText(window.location.href);
  toast("Current Desktop link copied.");
}

async function copySelectedTaskLink() {
  if (!state.selectedQueueId || !state.selectedTaskId) {
    toast("Select a task before copying a task link.");
    return;
  }
  const url = desktopUrlWithState({ activeTab: "dashboard", selectedTaskId: state.selectedTaskId });
  await copyText(url.href);
  toast("Task link copied.");
}

async function copySelectedTaskPacketLink() {
  if (!state.selectedQueueId || !state.selectedTaskId) {
    toast("Select a task before copying a packet link.");
    return;
  }
  updateClaimDefaultsFromForm();
  const url = taskPacketUrl();
  await copyText(url.href);
  toast("Task packet API link copied.");
}

async function copyReadyPacketLink(path) {
  if (!path) return;
  await copyText(new URL(path, window.location.href).href);
  toast("Ready packet link copied.");
}

async function copyAllReadyPacketLinks() {
  const links = state.readyPacketLinks?.links || [];
  if (!links.length) {
    toast("Load ready packet links first.");
    return;
  }
  const text = links.map((link) => packetLinkHref(link)).join("\n");
  await copyText(text);
  toast(`Copied ${links.length} ready packet link(s).`);
}

async function copyReadyWorkerBrief() {
  const links = state.readyPacketLinks?.links || [];
  if (!links.length) {
    toast("Load ready packet links first.");
    return;
  }
  await copyText(readyWorkerBriefText());
  toast(`Copied worker handoff brief for ${links.length} task(s).`);
}

function taskPacketUrl() {
  const url = new URL(
    `/api/queues/${encodeURIComponent(state.selectedQueueId)}/tasks/${encodeURIComponent(state.selectedTaskId)}/packet`,
    window.location.href
  );
  const claim = state.claimDefaults || {};
  url.searchParams.set("format", "markdown");
  url.searchParams.set("includeResume", "1");
  url.searchParams.set("preferredWorker", claim.worker || SENIOR_CLAIM_DEFAULTS.worker);
  url.searchParams.set("workspaceMode", claim.workspaceMode || SENIOR_CLAIM_DEFAULTS.workspaceMode);
  url.searchParams.set("modelProfile", claim.modelProfile || SENIOR_CLAIM_DEFAULTS.modelProfile);
  if (claim.workspacePath) url.searchParams.set("workspacePath", claim.workspacePath);
  return url;
}

function readyPacketLinksUrl() {
  updateClaimDefaultsFromForm();
  const claim = state.claimDefaults || {};
  const url = new URL(`/api/queues/${encodeURIComponent(state.selectedQueueId)}/ready-packet-links`, window.location.href);
  url.searchParams.set("limit", String(claim.batchLimit || 4));
  url.searchParams.set("format", "markdown");
  url.searchParams.set("includeResume", "1");
  url.searchParams.set("preferredWorker", claim.worker || SENIOR_CLAIM_DEFAULTS.worker);
  url.searchParams.set("workspaceMode", claim.workspaceMode || SENIOR_CLAIM_DEFAULTS.workspaceMode);
  url.searchParams.set("modelProfile", claim.modelProfile || SENIOR_CLAIM_DEFAULTS.modelProfile);
  if (claim.workspacePath) url.searchParams.set("workspacePath", claim.workspacePath);
  return url;
}

function packetLinkHref(link = {}) {
  return new URL(link.packetApiPath || link.packetUrl || "", window.location.href).href;
}

function renderEmpty() {
  $("#empty-state").classList.remove("hidden");
  $("#queue-view").classList.add("hidden");
}

function renderQueues() {
  const list = $("#queue-list");
  list.innerHTML = "";
  for (const queue of state.queues) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `queue-item${queue.queueId === state.selectedQueueId ? " active" : ""}`;
    button.innerHTML = `
      <div class="queue-item-title">
        <span>${esc(queue.title || queue.queueId)}</span>
        <span class="pill ${statusClass(queue.status)}">${esc(queue.status || "unknown")}</span>
      </div>
      <div class="muted">${esc(queue.projectPath || "")}</div>
      <div class="queue-item-meta">
        <span class="pill blue">ready ${num(queue.readyCount)}</span>
        <span class="pill">blocked ${num(queue.blockedCount)}</span>
        <span class="pill amber">approvals ${num(queue.pendingApprovals)}</span>
        <span class="pill green">slots ${num(queue.availableSlots)}</span>
      </div>
    `;
    button.addEventListener("click", async () => {
      state.selectedQueueId = queue.queueId;
      state.selectedTaskId = null;
      state.taskDetail = null;
      state.launchPlan = null;
      state.projectPolicyStatus = null;
      persistDesktopPreferences();
      renderQueues();
      await loadSelectedQueue();
    });
    list.appendChild(button);
  }
}

function renderSelectedQueue() {
  $("#empty-state").classList.add("hidden");
  $("#queue-view").classList.remove("hidden");
  const queue = state.dashboard?.queue || state.matrix?.queue || {};
  $("#queue-title").textContent = queue.title || queue.queueId || "Queue";
  $("#queue-meta").textContent = `${queue.projectPath || ""} - ${queue.status || "unknown"} - max agents ${queue.maxParallelAgents || "?"}`;
  renderQueueHealthStrip();
  fillSettingsForm(queue);
  renderDashboard();
  renderPipeline();
  renderTasks();
  renderMatrix();
  renderApprovals();
  renderMemory();
  renderTheater();
  renderActivity();
  renderTabBadges();
  syncPendingButtons();
}

function renderQueueHealthStrip() {
  const root = $("#queue-health-strip");
  if (!root) return;
  const data = queueHealthData();
  root.innerHTML = `
    <div class="queue-health-main">
      <span class="queue-health-dot ${data.severity}"></span>
      <strong>${esc(data.headline)}</strong>
      <span class="muted">${esc(data.detail)}</span>
    </div>
    <div class="queue-health-pills">
      <span class="pill ${statusClass(data.queueStatus)}">${esc(data.queueStatus)}</span>
      <span class="pill green">${data.ready} ready</span>
      <span class="pill ${data.pendingApprovals ? "amber" : "green"}">${data.pendingApprovals} approvals</span>
      <span class="pill ${data.recoveryAttention ? "red" : "green"}">${data.recoveryAttention} recovery</span>
      <span class="pill ${data.highRisk ? "amber" : "green"}">${data.highRisk} high risk</span>
      <span class="pill">${money(data.estimatedCost)}</span>
    </div>
  `;
}

function queueHealthData() {
  const dashboard = state.dashboard || {};
  const summary = dashboard.summaryStrip || {};
  const counts = summary.counts || {};
  const queue = dashboard.queue || state.matrix?.queue || {};
  const recovery = recoveryCenterData();
  const pendingApprovals = num(counts.pendingApprovals) || (state.approvals?.toolContext?.length || 0) + (state.approvals?.modelCalls?.length || 0);
  const ready = num(counts.ready);
  const highRisk = num(summary.risk?.highRiskOpenCount);
  const estimatedCost = Number(summary.cost?.estimatedCostUsd || 0);
  const recoveryAttention = recovery.attentionCount;
  const severity = recoveryAttention || highRisk || pendingApprovals ? (recovery.failed.length || recovery.staleWorkers ? "red" : "amber") : "green";
  const headline = severity === "green" ? "Queue healthy" : severity === "red" ? "Recovery needed" : "Human attention";
  const detailParts = [];
  if (ready) detailParts.push(`${ready} ready task(s)`);
  if (pendingApprovals) detailParts.push(`${pendingApprovals} approval(s)`);
  if (recoveryAttention) detailParts.push(`${recoveryAttention} recovery item(s)`);
  if (highRisk) detailParts.push(`${highRisk} high-risk task(s)`);
  return {
    queueStatus: queue.status || summary.status || "unknown",
    ready,
    pendingApprovals,
    recoveryAttention,
    highRisk,
    estimatedCost,
    severity,
    headline,
    detail: detailParts.length ? detailParts.join(" - ") : "No immediate launch, approval, or recovery issue reported."
  };
}

function renderTabBadges() {
  const badges = tabBadgeData();
  document.querySelectorAll(".tab").forEach((button) => {
    const tab = button.dataset.tab;
    const label = TAB_LABELS[tab] || tab || "";
    const badge = badges[tab];
    button.innerHTML = `
      <span>${esc(label)}</span>
      ${badge?.count ? `<span class="tab-badge ${badge.severity || ""}">${esc(badge.count)}</span>` : ""}
    `;
    button.title = badge?.detail || label;
  });
}

function tabBadgeData() {
  const dashboard = state.dashboard || {};
  const summary = dashboard.summaryStrip || {};
  const counts = summary.counts || {};
  const matrix = state.matrix || {};
  const matrixSummary = matrix.summary || {};
  const approvals = state.approvals || {};
  const modelApprovals = approvals.modelCalls || [];
  const toolApprovals = approvals.toolContext || [];
  const memoryPending = state.memoryInbox?.memories || [];
  const memorySuggestions = dashboard.memorySuggestions || [];
  const lanes = state.lanes?.lanes || [];
  const activeLanes = lanes.filter((lane) => !["completed", "done", "failed", "canceled"].includes(String(lane.workerRun?.status || lane.queueTask?.status || "")));
  const review = patchReviewTasks();
  const recovery = recoveryCenterData();
  const pipeline = pipelineTabCounts();
  const actionItems = state.actionInbox?.items || [];
  const contextPreflights = num(summary.cost?.preflightCount);
  const badge = (count, detail, severity = "blue") => ({ count: num(count), detail, severity });
  return {
    dashboard: badge(actionItems.length + recovery.attentionCount, "Dashboard action and recovery items", recovery.attentionCount ? "red" : "amber"),
    pipeline: badge(pipeline.count, pipeline.detail, pipeline.severity),
    tasks: badge(num(counts.ready), `${num(counts.ready)} ready task(s), ${num(matrixSummary.openTasks)} open`, "green"),
    matrix: badge(num(matrixSummary.overlappingFileScopes), "Overlapping file scopes", "amber"),
    approvals: badge(toolApprovals.length + modelApprovals.length, "Pending tool/context and model approvals", "amber"),
    memory: badge(memoryPending.length + memorySuggestions.length, "Pending memories and task memory suggestions", memoryPending.length ? "amber" : "blue"),
    context: badge(contextPreflights, "Recorded model preflights/context packages", "blue"),
    "model-brain": badge(modelApprovals.length, "Pending model approvals", "amber"),
    theater: badge(activeLanes.length, "Active worker lanes", "green"),
    activity: badge((state.timeline?.items || []).length, "Recent timeline events", "blue"),
    review: badge(review.length, "Patch-ready review tasks", "amber")
  };
}

function pipelineTabCounts() {
  const stages = state.dashboard?.pipeline || [];
  const latest = latestStageByName(stages);
  const needsReview = PIPELINE_STAGES.filter(([stage]) => latest.get(stage)?.status === "needs_review").length;
  const failed = PIPELINE_STAGES.filter(([stage]) => ["failed", "rejected"].includes(latest.get(stage)?.status)).length;
  if (failed) return { count: failed, detail: `${failed} failed/rejected stage(s)`, severity: "red" };
  if (needsReview) return { count: needsReview, detail: `${needsReview} stage(s) need review`, severity: "amber" };
  return { count: 0, detail: "Pipeline has no pending gate badge", severity: "green" };
}

function renderDashboard() {
  const root = $("#tab-dashboard");
  const dashboard = state.dashboard || {};
  const summary = dashboard.summaryStrip || {};
  const counts = summary.counts || {};
  const board = dashboard.queueBoard || {};
  const claim = state.claimDefaults || {};
  const claimBusy = claimActionPending();
  root.innerHTML = `
    <div class="grid metrics">
      ${metric("Health", summary.status || "unknown", summary.severity || "")}
      ${metric("Ready", counts.ready || 0, "launch candidates")}
      ${metric("Approvals", counts.pendingApprovals || 0, "pending")}
      ${metric("Workers", `${dashboard.activeWorkers || 0}/${dashboard.queue?.maxParallelAgents || 0}`, "active/max")}
      ${metric("Risk", summary.risk?.highestOpenRisk || "none", `${summary.risk?.highRiskOpenCount || 0} high`)}
      ${metric("Estimate", money(summary.cost?.estimatedCostUsd || 0), `${summary.cost?.preflightCount || 0} preflights`)}
    </div>
    ${operatorBriefPanelHtml()}
    ${liveLanesPanelHtml()}
    ${costRiskStripHtml()}
    ${launchReadinessPanelHtml()}
    ${parallelWorkPreviewPanelHtml()}
    ${actionInboxPanelHtml()}
    ${recoveryCenterPanelHtml()}
    ${patchReviewPanelHtml()}
    <div class="panel">
      <div class="section-head">
        <h2>Queue Control</h2>
        <span class="pill ${statusClass(dashboard.queue?.status)}">${esc(dashboard.queue?.status || "unknown")}</span>
      </div>
      <div class="row-actions queue-control-actions">
        <button class="primary" data-queue-decision="start_execution" type="button">Start</button>
        <button data-queue-decision="resume" type="button">Resume</button>
        <button data-open-theater type="button">Theater</button>
        <button data-queue-decision="pause" type="button">Pause</button>
        <button data-queue-decision="complete" type="button">Complete</button>
        <button class="danger" data-queue-decision="cancel" type="button">Cancel</button>
      </div>
      <form id="recover-stale-form" class="form-panel no-margin">
        <div class="form-grid recovery-grid">
          <label>
            <span>Stale After Minutes</span>
            <input id="recover-stale-minutes" type="number" min="1" value="30" />
          </label>
          <label>
            <span>Action</span>
            <select id="recover-stale-action">
              <option value="requeue">Requeue</option>
              <option value="fail">Fail</option>
            </select>
          </label>
          <label class="checkline form-check">
            <input id="recover-stale-dry-run" type="checkbox" checked />
            <span>Dry run</span>
          </label>
        </div>
        <div class="row-actions">
          <button type="submit">Recover Stale</button>
        </div>
      </form>
      <div id="recover-stale-result"></div>
    </div>
    <div class="panel">
      <div class="section-head"><h2>Next</h2><span class="pill">${esc(summary.nextAction || "")}</span></div>
      <div class="board">
        ${boardColumn("Ready", board.ready || [])}
        ${boardColumn("Running", board.running || [])}
        ${boardColumn("Review", board.review || [])}
        ${blockedColumn("Blocked", board.blocked || [])}
      </div>
    </div>
    <div class="panel">
      <div class="section-head">
        <h2>Claim Worker</h2>
        <span class="pill">${summary.status === "waiting_on_start" ? "start gate required" : "ready queue"}</span>
      </div>
      <form id="claim-worker-form" class="form-panel no-margin">
        <div class="form-grid launch-grid">
          <label>
            <span>Worker</span>
            <select id="claim-worker">
              ${claimWorkerOptionsHtml(claim.worker)}
            </select>
          </label>
          <label>
            <span>Workspace</span>
            <select id="claim-workspace-mode">
              ${claimWorkspaceOptionsHtml(claim.workspaceMode)}
            </select>
          </label>
          <label>
            <span>Model Profile</span>
            <input id="claim-model-profile" type="text" value="${esc(claim.modelProfile || SENIOR_CLAIM_DEFAULTS.modelProfile)}" />
          </label>
          <label>
            <span>Max Minutes</span>
            <input id="claim-max-runtime" type="number" min="1" placeholder="Optional" value="${esc(claim.maxRuntimeMinutes || "")}" />
          </label>
          <label>
            <span>Batch Limit</span>
            <input id="claim-batch-limit" type="number" min="1" max="16" value="${esc(claim.batchLimit || 4)}" />
          </label>
        </div>
        <label>
          <span>Workspace Path</span>
          <input id="claim-workspace-path" type="text" value="${esc(claim.workspacePath || "")}" placeholder="Optional; default is project path or project.worktrees/task" />
        </label>
        <div class="row-actions">
          <button id="senior-factory-defaults" type="button">Senior Factory</button>
          <button id="copy-senior-factory-command" type="button" ${state.selectedQueueId ? "" : "disabled"}>Copy Senior Command</button>
          <button class="primary" type="submit" ${claimBusy ? "disabled" : ""}>${claimBusy ? "Claiming..." : "Claim Next Worker"}</button>
          <button id="claim-ready-batch" type="button" ${claimBusy ? "disabled" : ""}>${claimBusy ? "Claiming..." : "Claim Ready Slots"}</button>
        </div>
      </form>
      <div id="claim-worker-result">${claimWorkerResultHtml(state.lastClaimResult)}</div>
    </div>
    <div class="panel">
      ${launchPlanHtml()}
    </div>
    <div id="task-detail-card"></div>
  `;
  root.querySelectorAll("[data-task-id]").forEach((button) => {
    button.addEventListener("click", () => loadTaskDetail(button.dataset.taskId));
  });
  root.querySelectorAll("[data-queue-decision]").forEach((button) => {
    button.addEventListener("click", () => decideQueue(button.dataset.queueDecision));
  });
  root.querySelector("#recover-stale-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    recoverStale();
  });
  root.querySelector("#claim-worker-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    claimNextWorker();
  });
  root.querySelector("#claim-ready-batch")?.addEventListener("click", () => claimReadyBatch());
  root.querySelector("#senior-factory-defaults")?.addEventListener("click", () => applySeniorFactoryDefaults());
  root.querySelector("#copy-senior-factory-command")?.addEventListener("click", () => copySeniorFactoryCommand());
  root.querySelectorAll("[data-copy-operator-brief]").forEach((button) => {
    button.addEventListener("click", () => copyOperatorBrief());
  });
  root.querySelector("#load-ready-packet-links")?.addEventListener("click", () => loadReadyPacketLinks());
  root.querySelectorAll("#copy-all-ready-packet-links, [data-copy-all-ready-packet-links]").forEach((button) => {
    button.addEventListener("click", () => copyAllReadyPacketLinks());
  });
  root.querySelectorAll("[data-copy-worker-brief]").forEach((button) => {
    button.addEventListener("click", () => copyReadyWorkerBrief());
  });
  root.querySelectorAll("[data-launch-plan-preview]").forEach((button) => {
    button.addEventListener("click", () => loadLaunchPlan(true));
  });
  root.querySelectorAll("[data-cost-inspect-request]").forEach((button) => {
    button.addEventListener("click", () => {
      $("#context-request-id").value = button.dataset.requestId || "";
      inspectContext();
    });
  });
  bindClaimDefaultControls(root);
  root.querySelectorAll("[data-claim-tool-approval]").forEach((button) => {
    button.addEventListener("click", () => {
      decideClaimToolAndMaybeRetry(button.dataset.proposalId, button.dataset.decision, button.dataset.retry === "1");
    });
  });
  root.querySelectorAll("[data-open-approvals]").forEach((button) => {
    button.addEventListener("click", () => selectTab("approvals"));
  });
  root.querySelectorAll("[data-open-theater]").forEach((button) => {
    button.addEventListener("click", () => selectTab("theater"));
  });
  bindLiveLanesActions(root);
  root.querySelectorAll("[data-action-tab]").forEach((button) => {
    button.addEventListener("click", () => selectTab(button.dataset.actionTab));
  });
  root.querySelectorAll("[data-action-task]").forEach((button) => {
    button.addEventListener("click", () => loadTaskDetail(button.dataset.actionTask));
  });
  root.querySelectorAll("[data-action-claim-ready]").forEach((button) => {
    button.addEventListener("click", () => claimReadyBatch());
  });
  root.querySelectorAll("[data-action-recover-stale]").forEach((button) => {
    button.addEventListener("click", () => recoverStale());
  });
  root.querySelectorAll("[data-action-queue-decision]").forEach((button) => {
    button.addEventListener("click", () => decideQueue(button.dataset.actionQueueDecision));
  });
  root.querySelectorAll("[data-review-task]").forEach((button) => {
    button.addEventListener("click", () => loadTaskDetail(button.dataset.reviewTask));
  });
  root.querySelectorAll("[data-review-accept]").forEach((button) => {
    button.addEventListener("click", () => acceptReviewTask(button.dataset.reviewAccept));
  });
  root.querySelectorAll("[data-review-retry]").forEach((button) => {
    button.addEventListener("click", () => retryReviewTask(button.dataset.reviewRetry));
  });
  root.querySelectorAll("[data-recovery-copy]").forEach((button) => {
    button.addEventListener("click", () => copyRecoveryBrief());
  });
  root.querySelectorAll("[data-recovery-task]").forEach((button) => {
    button.addEventListener("click", () => loadTaskDetail(button.dataset.recoveryTask));
  });
  root.querySelectorAll("[data-recovery-retry]").forEach((button) => {
    button.addEventListener("click", () => retryRecoveryTask(button.dataset.recoveryRetry));
  });
  root.querySelectorAll("[data-recovery-recover-stale]").forEach((button) => {
    button.addEventListener("click", () => recoverStale());
  });
  root.querySelectorAll("[data-ready-packet-link]").forEach((button) => {
    button.addEventListener("click", () => copyReadyPacketLink(button.dataset.readyPacketLink));
  });
  root.querySelectorAll("[data-ready-packet-task]").forEach((button) => {
    button.addEventListener("click", () => loadTaskDetail(button.dataset.readyPacketTask));
  });
  bindLaneActions(root);
  renderTaskDetail();
}

function renderPipeline() {
  const root = $("#pipeline-view");
  if (!root) return;
  const dashboard = state.dashboard || {};
  const stages = dashboard.pipeline || [];
  const decisions = (state.timeline?.items || []).filter((item) => item.source === "human_decision");
  const latest = latestStageByName(stages);
  const completed = PIPELINE_STAGES.filter(([stage]) => ["completed", "accepted"].includes(latest.get(stage)?.status)).length;
  const needsReview = PIPELINE_STAGES.filter(([stage]) => latest.get(stage)?.status === "needs_review").length;
  const failed = PIPELINE_STAGES.filter(([stage]) => ["failed", "rejected"].includes(latest.get(stage)?.status)).length;
  root.innerHTML = `
    <div class="grid metrics">
      ${metric("Stages", `${completed}/${PIPELINE_STAGES.length}`, "complete")}
      ${metric("Needs Review", needsReview, "human gate")}
      ${metric("Problems", failed, "failed/rejected")}
      ${metric("Events", stages.length, "recorded")}
    </div>
    ${pipelineGateBriefPanelHtml({ stages, decisions, latest, completed, needsReview, failed })}
    <div class="panel">
      <div class="section-head">
        <h2>Pipeline State</h2>
        <span class="pill ${statusClass(dashboard.queue?.status)}">${esc(dashboard.queue?.status || "unknown")}</span>
      </div>
      <div class="pipeline-strip">
        ${PIPELINE_STAGES.map(([stage, label], index) => pipelineStepHtml(index + 1, stage, label, latest.get(stage))).join("")}
      </div>
    </div>
    <div class="panel">
      <div class="section-head">
        <h2>Human Gates</h2>
        <span class="pill">${esc(dashboard.queue?.status || "unknown")}</span>
      </div>
      <div class="quick-gates">
        ${pipelineGateButtons(dashboard.queue?.status)}
      </div>
      <div class="decision-history">
        ${decisions.length ? decisions.slice(0, 8).map(decisionHistoryHtml).join("") : emptyLine("No human gate decisions recorded yet.")}
      </div>
    </div>
    <div class="panel">
      <div class="section-head"><h2>Stage History</h2><span class="pill">${stages.length}</span></div>
      ${stages.length ? stages.slice().reverse().map(stageHistoryHtml).join("") : emptyLine("No pipeline stages recorded yet.")}
    </div>
  `;
  root.querySelectorAll("[data-pipeline-decision]").forEach((button) => {
    button.addEventListener("click", () => decideQueue(button.dataset.pipelineDecision, button.dataset.note || "Recorded from Desktop pipeline gate."));
  });
  root.querySelectorAll("[data-copy-pipeline-brief]").forEach((button) => {
    button.addEventListener("click", () => copyPipelineBrief());
  });
  root.querySelectorAll("[data-pipeline-open-tab]").forEach((button) => {
    button.addEventListener("click", () => selectTab(button.dataset.pipelineOpenTab));
  });
}

function pipelineGateBriefPanelHtml(input = {}) {
  const data = pipelineGateData(input);
  return `
    <div class="panel pipeline-gate-panel">
      <div class="section-head">
        <h2>Pipeline Gate</h2>
        <span class="pill ${data.severity}">${esc(data.headline)}</span>
      </div>
      <div class="grid metrics pipeline-gate-metrics">
        ${metric("Current Stage", data.currentLabel, data.currentStatus)}
        ${metric("Queue", data.queueStatus, data.queueProfile)}
        ${metric("Ready Tasks", data.readyTasks, `${data.openTasks} open`)}
        ${metric("Approvals", data.pendingApprovals, "pending")}
      </div>
      <div class="pipeline-gate-layout">
        <div>
          <div class="section-head compact-head">
            <h2>Quality Gates</h2>
            <span class="pill">${data.gates.filter((gate) => gate.state !== "ready").length} open</span>
          </div>
          <div class="pipeline-gate-list">
            ${data.gates.map(pipelineGateRowHtml).join("")}
          </div>
        </div>
        <div>
          <div class="section-head compact-head">
            <h2>Next Decision</h2>
            <span class="pill ${data.recommended.length ? "amber" : "blue"}">${data.recommended.length ? data.recommended.length : "manual"}</span>
          </div>
          <div class="muted">${esc(data.nextAction)}</div>
          <div class="quick-gates pipeline-brief-gates">
            ${pipelineGateButtons(data.queueStatus)}
          </div>
        </div>
      </div>
      <pre class="resume-box pipeline-brief-preview">${esc(pipelineBriefText({ preview: true }))}</pre>
      <div class="row-actions pipeline-brief-actions">
        <button class="primary" data-copy-pipeline-brief type="button">Copy Pipeline Brief</button>
        <button data-pipeline-open-tab="tasks" type="button">Open Tasks</button>
        <button data-pipeline-open-tab="matrix" type="button">Open Matrix</button>
        <button data-pipeline-open-tab="approvals" type="button">Open Approvals</button>
      </div>
    </div>
  `;
}

function pipelineGateData(input = {}) {
  const dashboard = state.dashboard || {};
  const summary = dashboard.summaryStrip || {};
  const counts = summary.counts || {};
  const queue = dashboard.queue || state.matrix?.queue || {};
  const latest = input.latest || latestStageByName(input.stages || []);
  const current = currentPipelineStage(latest);
  const queueStatus = queue.status || summary.status || "unknown";
  const recommended = recommendedDecisions(queueStatus);
  const problems = num(input.failed);
  const review = num(input.needsReview);
  const pendingApprovals = num(counts.pendingApprovals) || (state.approvals?.toolContext?.length || 0) + (state.approvals?.modelCalls?.length || 0);
  const gates = pipelineQualityGates(latest, queueStatus, {
    readyTasks: num(counts.ready),
    pendingApprovals,
    openTasks: num(state.matrix?.summary?.openTasks)
  });
  const openGateCount = gates.filter((gate) => gate.state !== "ready").length;
  const severity = problems ? "red" : review || pendingApprovals || openGateCount ? "amber" : "green";
  return {
    queue,
    queueStatus,
    queueProfile: queue.pipelineProfile || "balanced",
    current,
    currentLabel: current.label,
    currentStatus: current.status,
    readyTasks: num(counts.ready),
    openTasks: num(state.matrix?.summary?.openTasks),
    pendingApprovals,
    recommended,
    gates,
    severity,
    headline: problems ? `${problems} problem stage(s)` : review ? `${review} stage(s) need review` : recommended.length ? "decision ready" : "tracking",
    nextAction: pipelineNextAction(queueStatus, current, gates, recommended)
  };
}

function currentPipelineStage(latest) {
  for (const [stage, label] of PIPELINE_STAGES) {
    const status = latest.get(stage)?.status || "not_recorded";
    if (!["completed", "accepted"].includes(status)) {
      return { stage, label, status, entry: latest.get(stage) || null };
    }
  }
  const [stage, label] = PIPELINE_STAGES[PIPELINE_STAGES.length - 1];
  return { stage, label, status: latest.get(stage)?.status || "completed", entry: latest.get(stage) || null };
}

function pipelineQualityGates(latest, queueStatus, counts) {
  const promptStatus = latest.get("prompt_improvement")?.status || "not_recorded";
  const planStatus = latest.get("planning")?.status || "not_recorded";
  const taskStatus = latest.get("task_writing")?.status || "not_recorded";
  const queueStatusStage = latest.get("queue_shaping")?.status || "not_recorded";
  return [
    {
      label: "Prompt Review",
      state: stageGateState(promptStatus, ["prompt_review"].includes(queueStatus)),
      detail: promptStatus === "not_recorded" ? "No prompt-improvement result recorded yet." : `Prompt stage is ${promptStatus}.`
    },
    {
      label: "Plan Acceptance",
      state: stageGateState(planStatus, ["plan_review"].includes(queueStatus)),
      detail: planStatus === "not_recorded" ? "No reviewed plan has been recorded yet." : `Planning stage is ${planStatus}.`
    },
    {
      label: "Task Queue",
      state: counts.openTasks > 0 && ["completed", "accepted"].includes(taskStatus) && ["completed", "accepted"].includes(queueStatusStage) ? "ready" : queueStatus === "queue_review" ? "attention" : "blocked",
      detail: counts.openTasks > 0 ? `${counts.openTasks} open task(s); ${counts.readyTasks} ready.` : "No task queue is available yet."
    },
    {
      label: "Tool/Model Approvals",
      state: counts.pendingApprovals > 0 ? "attention" : "ready",
      detail: counts.pendingApprovals > 0 ? `${counts.pendingApprovals} approval(s) need a decision.` : "No pending model or tool/context approval."
    },
    {
      label: "Execution Gate",
      state: ["running", "active"].includes(queueStatus) ? "ready" : ["queue_review", "approved", "paused", "ready"].includes(queueStatus) ? "attention" : "blocked",
      detail: ["running", "active"].includes(queueStatus) ? "Worker launch is open." : `Queue is ${queueStatus}.`
    }
  ];
}

function stageGateState(status, queueReviewing) {
  if (["failed", "rejected"].includes(status)) return "blocked";
  if (["completed", "accepted"].includes(status)) return "ready";
  if (status === "needs_review" || queueReviewing) return "attention";
  return "blocked";
}

function pipelineGateRowHtml(gate = {}) {
  const klass = gate.state === "ready" ? "green" : gate.state === "blocked" ? "red" : "amber";
  return `
    <div class="pipeline-gate-row ${klass}">
      <div>
        <strong>${esc(gate.label || "Gate")}</strong>
        <div class="muted">${esc(gate.detail || "")}</div>
      </div>
      <span class="pill ${klass}">${esc(gate.state || "unknown")}</span>
    </div>
  `;
}

function pipelineNextAction(queueStatus, current, gates, recommended) {
  const blocked = gates.find((gate) => gate.state === "blocked");
  if (blocked) return `${blocked.label}: ${blocked.detail}`;
  const attention = gates.find((gate) => gate.state === "attention");
  if (recommended.length) return `Recommended queue decision: ${recommended.join(" or ")}.`;
  if (attention) return `${attention.label}: ${attention.detail}`;
  return `Continue with ${current.label}; current status is ${current.status}.`;
}

function pipelineBriefText(options = {}) {
  const dashboard = state.dashboard || {};
  const stages = dashboard.pipeline || [];
  const latest = latestStageByName(stages);
  const data = pipelineGateData({ stages, latest });
  const queue = data.queue || {};
  const recentStages = stages.slice().reverse().slice(0, options.preview ? 4 : 10);
  const lines = [
    "# Agent Fabric Console Pipeline Brief",
    "",
    `Queue: ${queue.title || queue.queueId || state.selectedQueueId || "selected queue"}`,
    `Project: ${queue.projectPath || selectedProjectPath() || "project path unavailable"}`,
    `Profile: ${queue.pipelineProfile || "balanced"}`,
    `Queue status: ${data.queueStatus}`,
    `Current stage: ${data.currentLabel} (${data.currentStatus})`,
    `Next action: ${data.nextAction}`,
    `Ready/open tasks: ${data.readyTasks}/${data.openTasks}`,
    `Pending approvals: ${data.pendingApprovals}`,
    ""
  ];
  if (data.recommended.length) {
    lines.push("Recommended decisions:");
    for (const decision of data.recommended) lines.push(`- ${decision}`);
    lines.push("");
  }
  lines.push("Quality gates:");
  for (const gate of data.gates) lines.push(`- ${gate.label}: ${gate.state} - ${gate.detail}`);
  lines.push("");
  if (recentStages.length) {
    lines.push("Recent stage outputs:");
    for (const stage of recentStages) {
      const summary = stage.outputSummary || stage.inputSummary || stage.status || "";
      lines.push(`- ${stageLabel(stage.stage)} (${stage.status || "unknown"}): ${summary}`);
    }
    lines.push("");
  }
  if (options.preview && stages.length > recentStages.length) {
    lines.push("Copy the full brief to include more stage history.");
  }
  return lines.join("\n").trim();
}

async function copyPipelineBrief() {
  await copyText(pipelineBriefText());
  toast("Pipeline brief copied.");
}

function renderMatrix() {
  const root = $("#tab-matrix");
  const matrix = state.matrix || {};
  const summary = matrix.summary || {};
  const buckets = matrix.buckets || {};
  root.innerHTML = `
    <div class="grid metrics">
      ${metric("Open", summary.openTasks || 0, `${summary.totalTasks || 0} total`)}
      ${metric("Launchable", summary.launchable || 0, `${summary.scheduledPreview || 0} scheduled`)}
      ${metric("Context", summary.tasksNeedingToolContextApproval || 0, "approval tasks")}
      ${metric("Files", summary.overlappingFileScopes || 0, `${summary.fileScopes || 0} scopes`)}
      ${metric("Edges", summary.dependencyEdges || 0, `${summary.rootTasks || 0} roots`)}
    </div>
    <div class="grid">
      ${bucketPanel("Risk", buckets.risk || [])}
      ${bucketPanel("Phase", buckets.phase || [])}
      ${fileScopePanel(matrix.fileScopes || [])}
      ${grantPanel(matrix.toolContext?.grants || [])}
    </div>
  `;
  root.querySelectorAll("[data-policy-grant]").forEach((button) => {
    button.addEventListener("click", () => setToolPolicy(button.dataset.grantKey, button.dataset.status));
  });
}

function renderTasks() {
  const root = $("#task-list-view");
  if (!root) return;
  const entries = state.matrix?.tasks || [];
  const open = entries.filter((entry) => !["completed", "accepted", "done", "canceled"].includes(entry.task?.status)).length;
  const ready = entries.filter((entry) => entry.readiness?.readyNow).length;
  const needsContext = entries.filter((entry) => Number(entry.requiredGrantCount || 0) > 0).length;
  root.innerHTML = `
    <div class="panel">
      <div class="section-head">
        <h2>Queue Tasks</h2>
        <span class="pill">${entries.length}</span>
      </div>
      <div class="grid metrics task-metrics">
        ${metric("Open", open, "not closed")}
        ${metric("Ready", ready, "dependency-free")}
        ${metric("Context", needsContext, "grant refs")}
      </div>
      <div class="task-list">
        ${entries.length ? entries.map(taskListItemHtml).join("") : emptyLine("No tasks in this queue yet.")}
      </div>
    </div>
  `;
  root.querySelectorAll("[data-task-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      await loadTaskDetail(button.dataset.taskId);
      selectTab("dashboard");
    });
  });
}

function renderApprovals() {
  const root = $("#tab-approvals");
  const approvals = state.approvals || {};
  const toolContext = approvals.toolContext || [];
  const modelCalls = approvals.modelCalls || [];
  root.innerHTML = `
    ${projectPolicyPanelHtml()}
    <div class="panel">
      <div class="section-head"><h2>Tool Context</h2><span class="pill">${toolContext.length}</span></div>
      ${toolContext.length ? toolContext.map(toolApprovalHtml).join("") : emptyLine("No tool/context approvals.")}
    </div>
    <div class="panel">
      <div class="section-head"><h2>Model Calls</h2><span class="pill">${modelCalls.length}</span></div>
      ${modelCalls.length ? modelCalls.map(modelApprovalHtml).join("") : emptyLine("No model approvals.")}
    </div>
  `;
  root.querySelector("#project-policy-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    setManualProjectPolicy();
  });
  root.querySelector("#load-project-policies")?.addEventListener("click", () => loadProjectPolicyStatus());
  root.querySelectorAll("[data-policy-quick]").forEach((button) => {
    button.addEventListener("click", () => setProjectPolicyFromButton(button));
  });
  root.querySelectorAll("[data-policy-bulk]").forEach((button) => {
    button.addEventListener("click", () => setQueuePolicyBulk(button.dataset.policyBulk));
  });
  root.querySelectorAll("[data-tool-approval]").forEach((button) => {
    button.addEventListener("click", () => decideTool(button.dataset.proposalId, button.dataset.decision));
  });
  root.querySelectorAll("[data-model-approval]").forEach((button) => {
    button.addEventListener("click", () => decideModel(button.dataset.requestId, button.dataset.decision));
  });
  root.querySelectorAll("[data-inspect-request]").forEach((button) => {
    button.addEventListener("click", () => {
      $("#context-request-id").value = button.dataset.requestId || "";
      selectTab("context");
      inspectContext();
    });
  });
}

function projectPolicyPanelHtml() {
  const projectPath = selectedProjectPath();
  const result = state.lastPolicyResult?.projectPath === projectPath ? state.lastPolicyResult : null;
  const status = state.projectPolicyStatus?.projectPath === projectPath ? state.projectPolicyStatus : null;
  const savedGrants = status?.grants || [];
  const queueGrants = state.matrix?.toolContext?.grants || [];
  return `
    <div class="panel">
      <div class="section-head">
        <h2>Project Tool Policy</h2>
        <span class="pill ${projectPath ? "green" : "amber"}">${projectPath ? "project scoped" : "select queue"}</span>
      </div>
      <form id="project-policy-form" class="form-panel no-margin">
        <div class="form-grid policy-grid">
          <label>
            <span>Grant Type</span>
            <select id="policy-grant-kind">
              <option value="mcp_server">MCP server</option>
              <option value="tool">Tool</option>
              <option value="memory">Memory</option>
              <option value="context">Context ref</option>
            </select>
          </label>
          <label>
            <span>Value</span>
            <input id="policy-grant-value" type="text" placeholder="github, shell, memory-id, context-ref" />
          </label>
          <label>
            <span>Decision</span>
            <select id="policy-grant-status">
              <option value="approved">Approve</option>
              <option value="rejected">Reject</option>
            </select>
          </label>
        </div>
        <div class="row-actions">
          <button class="primary" type="submit" ${projectPath ? "" : "disabled"}>Save Policy</button>
          <button id="load-project-policies" type="button" ${projectPath ? "" : "disabled"}>Load Saved Policies</button>
        </div>
      </form>
      <div class="muted">Policies are explicit project decisions. They unblock or reject matching tool/context proposals without exposing every worker to every server or memory.</div>
      ${projectPolicySummaryHtml(queueGrants, savedGrants)}
      <div id="project-policy-result">${
        result
          ? `<div class="activity-item">
              <strong>${esc(result.status === "approved" ? "Approved" : "Rejected")} ${esc(result.grantKey)}</strong>
              <div class="muted">${esc(result.projectPath)}</div>
            </div>`
          : ""
      }</div>
      <div class="policy-section">
        <div class="section-head">
          <h2>Queue-Required Grants</h2>
          <span class="pill">${queueGrants.length}</span>
        </div>
        ${queueGrants.length ? queueGrants.slice(0, 16).map(policyGrantToggleHtml).join("") : emptyLine("No task-required grants in the current queue matrix.")}
      </div>
      <div class="policy-section">
        <div class="section-head">
          <h2>Quick Toggles</h2>
          <span class="pill">common</span>
        </div>
        <div class="policy-quick-grid">
          ${COMMON_POLICY_GRANTS.map(policyQuickToggleHtml).join("")}
        </div>
      </div>
      <div class="policy-section">
        <div class="section-head">
          <h2>Saved Policies</h2>
          <span class="pill">${savedGrants.length}</span>
        </div>
        ${savedGrants.length ? savedGrants.slice(0, 24).map(savedPolicyHtml).join("") : emptyLine("Load saved policies to inspect remembered approved/rejected grants for this project.")}
      </div>
    </div>
  `;
}

function projectPolicySummaryHtml(queueGrants, savedGrants) {
  const summary = projectPolicySummary(queueGrants, savedGrants);
  const missing = missingQueuePolicyGrants(queueGrants);
  const nextAction = summary.queueMissing
    ? `${summary.queueMissing} queue-required grant(s) still need a project policy decision.`
    : summary.queueRejected
      ? "Rejected queue-required grant(s) may keep matching tasks blocked."
      : "Queue-required tool policy is ready for current known grants.";
  return `
    <div class="policy-section">
      <div class="section-head">
        <h2>Policy Summary</h2>
        <span class="pill ${summary.queueMissing || summary.queueRejected ? "amber" : "green"}">${esc(nextAction)}</span>
      </div>
      <div class="grid metrics policy-metrics">
        ${metric("Queue Grants", summary.queueRequired, "required")}
        ${metric("Approved", summary.queueApproved, `${summary.savedApproved} saved`)}
        ${metric("Rejected", summary.queueRejected, `${summary.savedRejected} saved`)}
        ${metric("Missing", summary.queueMissing, "need decision")}
      </div>
      <div class="row-actions policy-bulk-actions">
        <button class="primary" data-policy-bulk="approved" type="button" ${missing.length ? "" : "disabled"}>Approve Missing Required</button>
        <button class="danger" data-policy-bulk="rejected" type="button" ${missing.length ? "" : "disabled"}>Reject Missing Required</button>
      </div>
    </div>
  `;
}

function projectPolicySummary(queueGrants = [], savedGrants = []) {
  const queueStatuses = queueGrants.map((grant) => currentPolicyStatusForGrant(normalizeGrantForUi(grant)) || grant.policyStatus || "missing");
  return {
    queueRequired: queueGrants.length,
    queueApproved: queueStatuses.filter((status) => status === "approved").length,
    queueRejected: queueStatuses.filter((status) => status === "rejected").length,
    queueMissing: queueStatuses.filter((status) => !status || status === "missing").length,
    savedApproved: savedGrants.filter((grant) => grant.status === "approved").length,
    savedRejected: savedGrants.filter((grant) => grant.status === "rejected").length
  };
}

function missingQueuePolicyGrants(queueGrants = state.matrix?.toolContext?.grants || []) {
  return queueGrants
    .map((grant) => normalizeGrantForUi(grant))
    .filter((grant) => {
      const status = currentPolicyStatusForGrant(grant);
      return !status || status === "missing";
    });
}

function policyGrantToggleHtml(grant = {}) {
  const normalized = normalizeGrantForUi(grant);
  const status = currentPolicyStatusForGrant(normalized) || grant.policyStatus || "missing";
  return `
    <div class="policy-toggle-row">
      <div>
        <strong>${esc(normalized.grantKey)}</strong>
        <div class="muted">${esc(status)} - ${num(grant.taskCount)} task(s)</div>
      </div>
      <div class="row-actions">
        <button class="primary" data-policy-quick data-kind="${esc(normalized.kind)}" data-value-json="${esc(JSON.stringify(normalized.value))}" data-status="approved" type="button">Approve</button>
        <button class="danger" data-policy-quick data-kind="${esc(normalized.kind)}" data-value-json="${esc(JSON.stringify(normalized.value))}" data-status="rejected" type="button">Reject</button>
      </div>
    </div>
  `;
}

function policyQuickToggleHtml(grant = {}) {
  const grantKey = grantKeyForUi(grant.kind, grant.value);
  const status = currentPolicyStatusForGrant({ kind: grant.kind, value: grant.value, grantKey }) || "missing";
  return `
    <div class="policy-quick-card">
      <div>
        <strong>${esc(grant.label || grantKey)}</strong>
        <div class="muted">${esc(grantKey)} - ${esc(status)}</div>
      </div>
      <div class="row-actions">
        <button class="primary" data-policy-quick data-kind="${esc(grant.kind)}" data-value-json="${esc(JSON.stringify(grant.value))}" data-status="approved" type="button">Approve</button>
        <button class="danger" data-policy-quick data-kind="${esc(grant.kind)}" data-value-json="${esc(JSON.stringify(grant.value))}" data-status="rejected" type="button">Reject</button>
      </div>
    </div>
  `;
}

function savedPolicyHtml(policy = {}) {
  const statusClassName = policy.status === "approved" ? "green" : policy.status === "rejected" ? "red" : "amber";
  return `
    <div class="policy-toggle-row">
      <div>
        <strong>${esc(policy.grantKey || grantKeyForUi(policy.grantKind, policy.value))}</strong>
        <div class="muted">${esc(policy.projectPath || "")}${policy.decidedAt ? ` - ${esc(policy.decidedAt)}` : ""}</div>
      </div>
      <span class="pill ${statusClassName}">${esc(policy.status || "unknown")}</span>
    </div>
  `;
}

async function loadProjectPolicyStatus(options = {}) {
  const projectPath = selectedProjectPath();
  if (!projectPath) {
    toast("Select a project queue before loading policies.");
    return;
  }
  const result = await callTool("tool_context_policy_status", { projectPath });
  state.projectPolicyStatus = result;
  renderApprovals();
  if (!options.quiet) toast(`Loaded ${result.grants?.length || 0} project policy grant(s).`);
}

async function setProjectPolicyFromButton(button) {
  const grantKind = button.dataset.kind;
  const status = button.dataset.status;
  let value;
  try {
    value = JSON.parse(button.dataset.valueJson || "null");
  } catch (error) {
    toast(`Invalid grant value: ${messageOf(error)}`);
    return;
  }
  await setProjectPolicy(grantKind, value, status);
}

async function setQueuePolicyBulk(status) {
  const projectPath = selectedProjectPath();
  if (!projectPath) {
    toast("Select a project queue before saving tool policy.");
    return;
  }
  if (!["approved", "rejected"].includes(status)) {
    toast("Choose approve or reject.");
    return;
  }
  const missing = missingQueuePolicyGrants();
  if (!missing.length) {
    toast("No missing queue-required grants.");
    return;
  }
  const applied = [];
  for (const grant of missing.slice(0, 16)) {
    const result = await callTool("tool_context_policy_set", {
      projectPath,
      grantKind: grant.kind,
      value: grant.value,
      status
    });
    applied.push(result);
  }
  state.lastPolicyResult = {
    projectPath,
    grantKey: `${applied.length} queue-required grant(s)`,
    status
  };
  if (state.selectedQueueId) {
    await callTool("project_queue_prepare_ready", { queueId: state.selectedQueueId, limit: 4 });
  }
  await loadProjectPolicyStatus({ quiet: true });
  toast(`${status === "approved" ? "Approved" : "Rejected"} ${applied.length} missing queue-required grant(s).`);
  await loadSelectedQueue({ quiet: true });
}

function renderMemory() {
  const root = $("#tab-memory");
  if (!root) return;
  const suggestions = state.dashboard?.memorySuggestions || [];
  const pending = state.memoryInbox?.memories || [];
  const taskCount = new Set(suggestions.map((item) => item.queueTaskId).filter(Boolean)).size;
  root.innerHTML = `
    <div class="panel">
      <div class="section-head">
        <h2>Pending Memory Review</h2>
        <span class="pill amber">${pending.length}</span>
      </div>
      <div class="muted">Approve only durable, reusable facts. Reject noisy or wrong candidates. Archive true but low-value candidates.</div>
      <div class="memory-list">
        ${pending.length ? pending.map(memoryReviewHtml).join("") : emptyLine("No pending memories in this workspace.")}
      </div>
    </div>
    <div class="panel">
      <div class="section-head">
        <h2>Memory Suggestions</h2>
        <span class="pill">${suggestions.length}</span>
      </div>
      <div class="grid metrics">
        ${metric("Suggestions", suggestions.length, "advisory")}
        ${metric("Tasks", taskCount, "with hints")}
      </div>
      <div class="memory-list">
        ${suggestions.length ? suggestions.map(memorySuggestionHtml).join("") : emptyLine("No advisory memories for currently ready work.")}
      </div>
    </div>
  `;
  bindMemoryActions(root);
}

function renderActivity() {
  const root = $("#tab-activity");
  const lanes = state.lanes?.lanes || [];
  const timeline = state.timeline?.items || [];
  root.innerHTML = `
    <div class="panel">
      <div class="section-head">
        <h2>Agent Lanes</h2>
        <div class="section-actions">
          <span class="pill">${lanes.length}</span>
          <button data-copy-all-lane-briefs type="button" ${lanes.length ? "" : "disabled"}>Copy Lane Briefs</button>
        </div>
      </div>
      ${lanes.length ? lanes.map(laneHtml).join("") : emptyLine("No active lanes.")}
    </div>
    <div class="panel">
      <div class="section-head"><h2>Timeline</h2><span class="pill">${timeline.length}</span></div>
      ${timeline.length ? timeline.map(activityHtml).join("") : emptyLine("No activity.")}
    </div>
  `;
  bindLaneActions(root);
}

function renderTheater() {
  const root = $("#tab-theater");
  if (!root) return;
  const lanes = state.lanes?.lanes || [];
  const dashboard = state.dashboard || {};
  const summary = dashboard.summaryStrip || {};
  const counts = summary.counts || {};
  const active = lanes.filter((lane) => !["completed", "done", "failed", "canceled"].includes(String(lane.workerRun?.status || lane.queueTask?.status || "")));
  const lanesToShow = state.theaterOnlyActive ? active : lanes;
  const emptyTheaterText = state.theaterOnlyActive && lanes.length
    ? "No active lanes. Toggle Show All to review completed or failed lanes."
    : "No active lanes. Start or claim ready work to populate the theater.";
  root.innerHTML = `
    <div class="theater-stage${state.theaterFocus ? " theater-fullscreen" : ""}">
      <div class="theater-head">
        <div>
          <h2>Live Agent Theater</h2>
          <div class="muted">${esc(summary.nextAction || "Watch workers, checkpoints, tests, and approvals as they change.")}</div>
        </div>
        <div class="row-actions">
          <button type="button" data-theater-focus>${state.theaterFocus ? "Exit Focus" : "Focus"}</button>
          <button type="button" data-theater-active-toggle>${state.theaterOnlyActive ? "Show All" : "Active Only"}</button>
          <button type="button" data-theater-refresh>Refresh</button>
          <button type="button" data-copy-all-lane-briefs ${lanes.length ? "" : "disabled"}>Copy Lane Briefs</button>
          <button type="button" data-theater-claim>Claim Ready Slots</button>
        </div>
      </div>
      <div class="theater-metrics">
        ${metric("Active", active.length, "worker lanes")}
        ${metric("Ready", counts.ready || 0, "queued")}
        ${metric("Review", counts.patchReady || counts.review || 0, "patch-ready")}
        ${metric("Approvals", counts.pendingApprovals || 0, "waiting")}
      </div>
      <div class="theater-lanes">
        ${lanesToShow.length ? lanesToShow.map(theaterLaneHtml).join("") : emptyLine(emptyTheaterText)}
      </div>
    </div>
  `;
  root.querySelector("[data-theater-refresh]")?.addEventListener("click", () => loadSelectedQueue({ quiet: true }));
  root.querySelector("[data-theater-claim]")?.addEventListener("click", () => claimReadyBatch());
  root.querySelector("[data-theater-focus]")?.addEventListener("click", () => {
    state.theaterFocus = !state.theaterFocus;
    renderTheater();
  });
  root.querySelector("[data-theater-active-toggle]")?.addEventListener("click", () => {
    state.theaterOnlyActive = !state.theaterOnlyActive;
    renderTheater();
  });
  bindLaneActions(root);
  syncPendingButtons();
}

async function recordPipelineStage() {
  if (!state.selectedQueueId) return;
  const input = {
    queueId: state.selectedQueueId,
    stage: $("#pipeline-stage").value,
    status: $("#pipeline-status").value,
    modelAlias: $("#pipeline-model-alias").value.trim() || undefined,
    planChainId: $("#pipeline-plan-chain").value.trim() || undefined,
    inputSummary: $("#pipeline-input-summary").value.trim() || undefined,
    outputSummary: $("#pipeline-output-summary").value.trim() || undefined,
    artifacts: linesFromTextarea("#pipeline-artifacts"),
    warnings: linesFromTextarea("#pipeline-warnings")
  };
  const result = await callTool("project_queue_record_stage", input);
  $("#pipeline-stage-result").innerHTML = `<div class="activity-item"><strong>Recorded ${esc(result.stage || input.stage)}</strong><div class="muted">${esc(result.stageId || "")} - ${esc(result.status || input.status)}</div></div>`;
  toast("Pipeline stage recorded.");
  await loadSelectedQueue({ quiet: true });
}

async function improvePromptFromPipeline() {
  if (!state.selectedQueueId) return;
  const prompt = $("#prompt-improve-text").value.trim();
  if (!prompt) {
    toast("Prompt text is required.");
    return;
  }
  const result = await postProjectImprovePrompt({
    queueId: state.selectedQueueId,
    prompt,
    modelAlias: $("#prompt-improve-model").value.trim() || "prompt.improve.strong",
    accept: $("#prompt-improve-accept").checked
  });
  if (result.action === "prompt_improvement_blocked") {
    const preflight = result.preflight || {};
    $("#prompt-improve-result").innerHTML = `
      <div class="activity-item">
        <strong>Prompt improvement needs approval</strong>
        <div class="muted">${esc(preflight.requestId || "")} - ${esc(preflight.decision || "needs_user_approval")} - ${esc(preflight.risk || "risk")}</div>
      </div>
    `;
    toast("Prompt improvement is waiting on model approval.");
  } else {
    state.lastImprovedPrompt = result.improvedPrompt || "";
    $("#prompt-improve-result").innerHTML = `
      <div class="activity-item">
        <strong>${esc(result.summary || "Improved prompt ready")}</strong>
        <div class="muted">${esc(result.action || "prompt_improved")}</div>
        <pre>${esc(result.improvedPrompt || result.message || "")}</pre>
      </div>
    `;
    toast(result.action === "prompt_improved" ? "Prompt improved." : "Prompt improvement updated.");
  }
  await loadSelectedQueue({ quiet: true });
}

async function startPlanFromPipeline() {
  if (!state.selectedQueueId) return;
  const useImproved = $("#start-plan-use-prompt-result").checked;
  const task = (useImproved && state.lastImprovedPrompt ? state.lastImprovedPrompt : $("#start-plan-task").value).trim();
  const maxRounds = Number($("#start-plan-max-rounds").value);
  const budgetText = $("#start-plan-budget").value.trim();
  const budgetUsd = budgetText ? Number(budgetText) : undefined;
  if (!task) {
    toast("Planning task is required.");
    return;
  }
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 12) {
    toast("Max rounds must be an integer between 1 and 12.");
    return;
  }
  if (budgetText && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) {
    toast("Budget must be a non-negative number.");
    return;
  }
  const result = await postProjectStartPlan({
    queueId: state.selectedQueueId,
    task,
    maxRounds,
    budgetUsd,
    outputFormat: $("#start-plan-output-format").value
  });
  $("#start-plan-result").innerHTML = `
    <div class="activity-item">
      <strong>Plan chain started</strong>
      <div class="muted">${esc(result.chainId || "")} - ${esc(result.action || "plan_started")}</div>
      <div>${esc(result.message || "Planning stage is running.")}</div>
    </div>
  `;
  toast("Plan chain started.");
  await loadSelectedQueue({ quiet: true });
}

async function recordPipelineDecision() {
  if (!state.selectedQueueId) return;
  let metadata;
  const metadataText = $("#pipeline-decision-metadata").value.trim();
  if (metadataText) {
    try {
      metadata = JSON.parse(metadataText);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("expected a JSON object");
    } catch (error) {
      toast(`Invalid decision metadata JSON: ${messageOf(error)}`);
      return;
    }
  }
  const decision = $("#pipeline-decision").value;
  const note = $("#pipeline-decision-note").value.trim() || "Recorded from Agent Fabric Console pipeline gate.";
  if (!confirmQueueDecision(decision)) return;
  const result = await callTool("project_queue_decide", {
    queueId: state.selectedQueueId,
    decision,
    note,
    metadata
  });
  $("#pipeline-decision-result").innerHTML = `<div class="activity-item"><strong>${esc(result.decision || decision)}</strong><div class="muted">${esc(result.decisionId || "")} - queue ${esc(result.status || "")}</div></div>`;
  toast(`Queue decision recorded: ${decision}.`);
  await loadSelectedQueue({ quiet: true });
}

async function prepareReady() {
  if (!state.selectedQueueId) return;
  const result = await callTool("project_queue_prepare_ready", { queueId: state.selectedQueueId, limit: 4 });
  toast(`Prepared ${result.prepared?.length || 0}; approvals ${result.summary?.approvalRequired || 0}.`);
  await loadSelectedQueue({ quiet: true });
}

async function claimNextWorker() {
  if (!state.selectedQueueId) return;
  if (claimActionPending()) {
    toast("A worker claim is already running.");
    return;
  }
  await withPendingAction("claim-next", async () => {
    const input = claimWorkerInput("single");
    const result = await callTool("project_queue_claim_next", input);
    state.lastClaimResult = result;
    state.lastClaimBatchId = null;
    if (result.approvalRequired) {
      toast("Tool/context approval required before worker claim.");
    } else if (result.executionBlocked) {
      toast("Queue is not open for execution.");
    } else if (result.claimed) {
      state.selectedTaskId = result.claimed.queueTaskId || state.selectedTaskId;
      toast("Worker claimed.");
    } else {
      toast("No ready task available.");
    }
    await loadSelectedQueue({ quiet: true });
    if (result.claimed?.queueTaskId) await loadTaskDetail(result.claimed.queueTaskId, { quiet: true });
  });
}

async function claimReadyBatch() {
  if (!state.selectedQueueId) return;
  if (claimActionPending()) {
    toast("A worker claim is already running.");
    return;
  }
  await withPendingAction("claim-ready", async () => {
    const limitInput = Number($("#claim-batch-limit").value);
    const availableSlots = Number(state.dashboard?.summaryStrip?.counts?.availableSlots ?? state.dashboard?.availableSlots ?? state.dashboard?.queue?.maxParallelAgents ?? 4);
    const limit = Math.max(1, Math.min(16, Number.isFinite(limitInput) && limitInput > 0 ? limitInput : availableSlots || 4));
    const batchId = `desktop-batch-${Date.now()}`;
    const started = [];
    const skipped = [];
    const skipQueueTaskIds = [];
    for (let index = 0; index < limit; index += 1) {
      const result = await callTool("project_queue_claim_next", {
        ...claimWorkerInput("batch"),
        skipQueueTaskIds,
        _idempotencyKey: `${batchId}-${index}`
      });
      if (result.approvalRequired) {
        const proposal = result.toolContextProposal || {};
        skipped.push({
          reason: "tool/context approval required",
          queueTaskId: proposal.queueTaskId,
          proposalId: proposal.proposalId,
          missingGrants: proposal.missingGrants || []
        });
        if (proposal.queueTaskId) {
          skipQueueTaskIds.push(proposal.queueTaskId);
          continue;
        }
        break;
      }
      if (result.executionBlocked) {
        skipped.push({ reason: result.blockedReason || "queue is not runnable", executionBlocked: true });
        break;
      }
      if (!result.claimed) break;
      started.push(result);
    }
    state.lastClaimBatchId = batchId;
    state.lastClaimResult = { batch: true, batchId, started, skipped, requested: limit };
    if (started[0]?.claimed?.queueTaskId) state.selectedTaskId = started[0].claimed.queueTaskId;
    toast(`Claimed ${started.length}; skipped ${skipped.length}.`);
    await loadSelectedQueue({ quiet: true });
    if (started[0]?.claimed?.queueTaskId) await loadTaskDetail(started[0].claimed.queueTaskId, { quiet: true });
  });
}

function confirmQueueDecision(decision) {
  const labels = {
    cancel: "Canceling this queue stops further worker launch for the selected queue.",
    complete: "Completing this queue closes active queue work."
  };
  const message = labels[decision];
  return !message || window.confirm(`${message}\n\nContinue?`);
}

function confirmReviewDecision(action, task) {
  const label = task?.title || task?.queueTaskId || "this task";
  const messages = {
    accept: `Accept ${label} and mark the patch-ready task as accepted?`,
    retry: `Return ${label} to queued for another worker pass?`
  };
  return window.confirm(messages[action] || "Continue?");
}

function confirmToolDecision(proposalId, decision) {
  return window.confirm(`Record tool/context decision "${decision}" for ${proposalId || "this proposal"}?\n\nApproved tool/context grants can unblock worker launch.`);
}

function confirmModelDecision(requestId, decision) {
  return window.confirm(`Record model request decision "${decision}" for ${requestId || "this request"}?\n\nThis can allow, change, or cancel a metered model call.`);
}

function confirmPolicyGrant(grantKind, value, status) {
  return window.confirm(`${status === "approved" ? "Approve" : "Reject"} ${grantKind}:${String(value)} for this project?\n\nProject policy changes can affect future ready-task approvals.`);
}

function confirmMemoryDecision(memoryId, decision) {
  if (decision === "approve") return true;
  return window.confirm(`Record memory decision "${decision}" for ${memoryId || "this memory"}?`);
}

function confirmTaskOutcomeStatus(status) {
  const highImpact = ["patch_ready", "accepted", "done", "completed", "failed", "blocked", "canceled"].includes(String(status || ""));
  return !highImpact || window.confirm(`Save selected task outcome as "${status}"?`);
}

function claimWorkerInput(source) {
  updateClaimDefaultsFromForm();
  const maxRuntime = Number($("#claim-max-runtime").value);
  return {
    queueId: state.selectedQueueId,
    worker: state.claimDefaults.worker,
    workspaceMode: state.claimDefaults.workspaceMode,
    workspacePath: state.claimDefaults.workspacePath || undefined,
    modelProfile: state.claimDefaults.modelProfile || SENIOR_CLAIM_DEFAULTS.modelProfile,
    maxRuntimeMinutes: Number.isFinite(maxRuntime) && maxRuntime > 0 ? maxRuntime : undefined,
    metadata: { source: `local-cli-desktop-${source}` }
  };
}

async function recoverStale() {
  if (!state.selectedQueueId) return;
  const staleAfterMinutes = Number($("#recover-stale-minutes").value);
  if (!Number.isInteger(staleAfterMinutes) || staleAfterMinutes < 1) {
    toast("Stale minutes must be a positive integer.");
    return;
  }
  const result = await callTool("project_queue_recover_stale", {
    queueId: state.selectedQueueId,
    staleAfterMinutes,
    action: $("#recover-stale-action").value,
    dryRun: $("#recover-stale-dry-run").checked
  });
  $("#recover-stale-result").innerHTML = `
    <div class="activity-item">
      <strong>${result.dryRun ? "Previewed" : "Recovered"} ${result.count || 0} stale task(s)</strong>
      <div class="muted">${esc(result.action || "")} after ${result.staleAfterMinutes || staleAfterMinutes} minute(s)</div>
      ${(result.recovered || []).slice(0, 5).map((entry) => `<div>${esc(entry.queueTaskId || entry.title || "")} ${entry.staleReason ? `- ${esc(entry.staleReason)}` : ""}</div>`).join("")}
    </div>
  `;
  toast(`${result.dryRun ? "Previewed" : "Recovered"} ${result.count || 0} stale task(s).`);
  await loadSelectedQueue({ quiet: true });
}

function showNewQueueForm(visible) {
  $("#new-queue-form").classList.toggle("hidden", !visible);
  if (!visible) return;
  const projectFilter = $("#project-filter").value.trim();
  if (projectFilter && !$("#new-project-path").value.trim()) $("#new-project-path").value = projectFilter;
  $("#new-project-path").focus();
}

async function createQueue() {
  const projectPath = $("#new-project-path").value.trim();
  const title = $("#new-queue-title").value.trim();
  const prompt = $("#new-prompt").value.trim();
  const pipelineProfile = $("#new-pipeline-profile").value;
  const maxParallelAgents = Number($("#new-max-agents").value);
  if (!projectPath || !prompt) {
    toast("Project folder and prompt are required.");
    return;
  }
  if (!Number.isInteger(maxParallelAgents) || maxParallelAgents < 1 || maxParallelAgents > 16) {
    toast("Agents must be an integer between 1 and 16.");
    return;
  }
  const created = await postProjectCreate({
    projectPath,
    title: title || undefined,
    prompt,
    pipelineProfile,
    maxParallelAgents
  });
  state.selectedQueueId = created.queueId;
  state.launchPlan = null;
  $("#project-filter").value = projectPath;
  persistDesktopPreferences();
  $("#new-queue-form").reset();
  $("#new-max-agents").value = "4";
  showNewQueueForm(false);
  toast("Queue created with prompt improvement gate.");
  await loadQueues();
}

async function seedDemoQueue() {
  const projectPath = $("#project-filter").value.trim() || "/tmp/agent-fabric-desktop-demo";
  const seeded = await postDemoSeed({
    projectPath,
    title: "Agent Fabric Console Demo",
    maxParallelAgents: Number($("#new-max-agents")?.value || 4) || 4
  });
  state.selectedQueueId = seeded.queueId;
  state.selectedTaskId = null;
  state.launchPlan = null;
  $("#project-filter").value = projectPath;
  persistDesktopPreferences();
  toast(`Demo queue seeded: ${seeded.queueId || "ready"}.`);
  await loadQueues();
}

function showSettingsForm(visible) {
  $("#queue-settings-form").classList.toggle("hidden", !visible);
  if (visible) $("#settings-title").focus();
}

function fillSettingsForm(queue) {
  $("#settings-title").value = queue.title || "";
  $("#settings-profile").value = queue.pipelineProfile || "balanced";
  $("#settings-max-agents").value = String(queue.maxParallelAgents || 4);
}

async function saveQueueSettings() {
  if (!state.selectedQueueId) return;
  const title = $("#settings-title").value.trim();
  const pipelineProfile = $("#settings-profile").value;
  const maxParallelAgents = Number($("#settings-max-agents").value);
  if (!title) {
    toast("Queue title is required.");
    return;
  }
  if (!Number.isInteger(maxParallelAgents) || maxParallelAgents < 1 || maxParallelAgents > 16) {
    toast("Max agents must be an integer between 1 and 16.");
    return;
  }
  await callTool("project_queue_update_settings", {
    queueId: state.selectedQueueId,
    title,
    pipelineProfile,
    maxParallelAgents,
    note: "Updated from Agent Fabric Console command center."
  });
  showSettingsForm(false);
  toast("Queue settings saved.");
  await loadQueues();
}

function fillTaskSample() {
  $("#import-tasks-json").value = JSON.stringify(
    {
      tasks: [
        {
          clientKey: "schema",
          title: "Create queue schema",
          goal: "Add or update durable queue tables and migrations.",
          phase: "substrate",
          category: "implementation",
          priority: "high",
          risk: "medium",
          expectedFiles: ["src/migrations/example.sql"],
          acceptanceCriteria: ["Migration applies cleanly.", "Existing tests keep passing."],
          requiredTools: ["fabric_status"],
          requiredMcpServers: [],
          requiredMemories: [],
          requiredContextRefs: [],
          parallelSafe: true,
          dependsOn: []
        },
        {
          clientKey: "ui",
          title: "Render queue board",
          goal: "Expose ready, running, blocked, and review tasks in the command center.",
          phase: "desktop",
          category: "implementation",
          priority: "normal",
          risk: "low",
          expectedFiles: ["src/desktop/public/app.js", "src/desktop/public/app.css"],
          acceptanceCriteria: ["Task cards render without layout overlap.", "Clicking a task opens task detail."],
          requiredTools: [],
          requiredMcpServers: [],
          requiredMemories: [],
          requiredContextRefs: [],
          parallelSafe: true,
          dependsOn: ["schema"]
        }
      ]
    },
    null,
    2
  );
}

async function importTasks() {
  if (!state.selectedQueueId) return;
  const text = $("#import-tasks-json").value.trim();
  if (!text) {
    toast("Tasks JSON is required.");
    return;
  }
  let tasks;
  try {
    tasks = parseTasksPayload(JSON.parse(text));
  } catch (error) {
    toast(`Invalid tasks JSON: ${messageOf(error)}`);
    return;
  }
  if (!tasks.length) {
    toast("Tasks JSON must contain at least one task.");
    return;
  }
  await callTool("project_queue_record_stage", {
    queueId: state.selectedQueueId,
    stage: "task_writing",
    status: "completed",
    modelAlias: "task.writer",
    outputSummary: `Imported ${tasks.length} task(s) from Agent Fabric Console.`
  });
  const added = await callTool("project_queue_add_tasks", {
    queueId: state.selectedQueueId,
    tasks
  });
  await callTool("project_queue_record_stage", {
    queueId: state.selectedQueueId,
    stage: "queue_shaping",
    status: "completed",
    modelAlias: "task.writer",
    outputSummary: "Imported tasks were validated and added to the dependency-aware queue."
  });
  if ($("#import-approve-queue").checked) {
    await callTool("project_queue_decide", {
      queueId: state.selectedQueueId,
      decision: "approve_queue",
      note: "Approved after Desktop task import."
    });
  }
  $("#import-tasks-result").innerHTML = `<div class="activity-item"><strong>Imported ${added.created?.length || tasks.length} task(s)</strong><div class="muted">Queue is ready for review.</div></div>`;
  toast(`Imported ${added.created?.length || tasks.length} task(s).`);
  await loadSelectedQueue({ quiet: true });
  selectTab("dashboard");
}

function parseTasksPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray(payload.tasks)) return payload.tasks;
  throw new Error("expected a JSON array or an object with a tasks array");
}

async function addTaskFromForm() {
  if (!state.selectedQueueId) return;
  const title = $("#add-task-title").value.trim();
  const goal = $("#add-task-goal").value.trim();
  if (!title || !goal) {
    toast("Task title and goal are required.");
    return;
  }
  const task = compactObject({
    clientKey: $("#add-task-client-key").value.trim() || undefined,
    title,
    goal,
    phase: $("#add-task-phase").value.trim() || undefined,
    category: $("#add-task-category").value.trim() || "implementation",
    priority: $("#add-task-priority").value,
    risk: $("#add-task-risk").value,
    parallelGroup: $("#add-task-parallel-group").value.trim() || undefined,
    parallelSafe: $("#add-task-parallel-safe").checked,
    expectedFiles: linesFromTextarea("#add-task-files"),
    acceptanceCriteria: linesFromTextarea("#add-task-acceptance"),
    requiredTools: linesFromTextarea("#add-task-tools"),
    requiredMcpServers: linesFromTextarea("#add-task-mcp"),
    requiredMemories: linesFromTextarea("#add-task-memories"),
    requiredContextRefs: linesFromTextarea("#add-task-context"),
    dependsOn: linesFromTextarea("#add-task-depends")
  });
  try {
    await callTool("project_queue_record_stage", {
      queueId: state.selectedQueueId,
      stage: "task_writing",
      status: "completed",
      modelAlias: "manual.desktop",
      outputSummary: `Added manual coding task: ${title}.`
    });
    const added = await callTool("project_queue_add_tasks", {
      queueId: state.selectedQueueId,
      tasks: [task]
    });
    await callTool("project_queue_record_stage", {
      queueId: state.selectedQueueId,
      stage: "queue_shaping",
      status: "needs_review",
      modelAlias: "manual.desktop",
      outputSummary: "Manual task was added and needs queue-shaping review."
    });
    if ($("#add-task-approve-queue").checked) {
      await callTool("project_queue_decide", {
        queueId: state.selectedQueueId,
        decision: "approve_queue",
        note: "Approved after Desktop manual task add."
      });
    }
    const created = added.created?.[0] || {};
    $("#add-task-result").innerHTML = `<div class="activity-item"><strong>${esc(created.title || title)}</strong><div class="muted">${esc(created.queueTaskId || "")}</div><div>Task added to queue review.</div></div>`;
    $("#add-task-form").reset();
    $("#add-task-category").value = "implementation";
    $("#add-task-priority").value = "normal";
    $("#add-task-risk").value = "medium";
    $("#add-task-parallel-safe").checked = true;
    toast("Task added.");
    await loadSelectedQueue({ quiet: true });
  } catch (error) {
    toast(`Add task failed: ${messageOf(error)}`);
  }
}

async function loadLaunchPlan(showToast) {
  if (!state.selectedQueueId) return;
  const result = await callTool("project_queue_launch_plan", { queueId: state.selectedQueueId, limit: 4 });
  state.launchPlan = result;
  state.readyPacketLinks = null;
  if (showToast) toast(`Launchable ${result.summary?.launchable || 0}; approvals ${result.summary?.approvalRequired || 0}; waiting ${result.summary?.waitingForStart || 0}.`);
  await loadSelectedQueue({ quiet: true });
  selectTab("dashboard");
}

async function loadReadyPacketLinks() {
  if (!state.selectedQueueId) return;
  const url = readyPacketLinksUrl();
  const result = await apiGet(`${url.pathname}${url.search}`);
  state.readyPacketLinks = result;
  toast(`Loaded ${result.links?.length || 0} ready packet link(s).`);
  renderDashboard();
}

async function decideQueue(decision, note = "Recorded from Agent Fabric Console command center.") {
  if (!state.selectedQueueId) return;
  if (!confirmQueueDecision(decision)) return;
  await withPendingAction(`queue-decision:${decision}`, async () => {
    await callTool("project_queue_decide", { queueId: state.selectedQueueId, decision, note });
    toast(`Queue decision recorded: ${decision}.`);
    await loadSelectedQueue({ quiet: true });
  }, "Queue decision is already being recorded.");
}

async function decideTool(proposalId, decision) {
  if (!confirmToolDecision(proposalId, decision)) return;
  await withPendingAction(`tool:${proposalId}:${decision}`, async () => {
    await callTool("tool_context_decide", { proposalId, decision, remember: true, note: "Decided from Agent Fabric Console command center." });
    toast(`Tool/context ${decision}.`);
    await loadSelectedQueue({ quiet: true });
  }, "Tool/context decision is already running.");
}

async function decideClaimToolAndMaybeRetry(proposalId, decision, retry) {
  if (!proposalId || !decision) return;
  if (!confirmToolDecision(proposalId, decision)) return;
  await withPendingAction(`tool:${proposalId}:${decision}`, async () => {
    await callTool("tool_context_decide", {
      proposalId,
      decision,
      remember: true,
      note: "Decided from Agent Fabric Console worker-claim result."
    });
    toast(`Tool/context ${decision}.`);
    if (retry && decision === "approve") {
      await claimReadyBatch();
      return;
    }
    markClaimProposalDecision(proposalId, decision);
    await loadSelectedQueue({ quiet: true });
  }, "Tool/context decision is already running.");
}

function markClaimProposalDecision(proposalId, decision) {
  if (!state.lastClaimResult || !proposalId) return;
  if (state.lastClaimResult.batch) {
    state.lastClaimResult = {
      ...state.lastClaimResult,
      skipped: (state.lastClaimResult.skipped || []).map((entry) =>
        entry.proposalId === proposalId
          ? {
              ...entry,
              decision,
              reason: `tool/context ${decision}`
            }
          : entry
      )
    };
    return;
  }
  if (state.lastClaimResult.toolContextProposal?.proposalId === proposalId) {
    state.lastClaimResult = {
      ...state.lastClaimResult,
      approvalRequired: false,
      approvalDecision: decision,
      approvalProposalId: proposalId
    };
  }
}

async function decideModel(requestId, decision) {
  if (!confirmModelDecision(requestId, decision)) return;
  await withPendingAction(`model:${requestId}:${decision}`, async () => {
    await callTool("llm_approve", { requestId, decision, scope: "call", note: "Decided from Agent Fabric Console command center." });
    toast(`Model request ${decision}.`);
    await loadSelectedQueue({ quiet: true });
  }, "Model decision is already running.");
}

async function inspectContext() {
  const requestId = $("#context-request-id").value.trim();
  if (!requestId) return;
  const result = await apiGet(`/api/context/${encodeURIComponent(requestId)}`);
  renderContext(result);
  selectTab("context");
}

function renderContext(result) {
  const analysis = result.analysis || {};
  $("#context-result").innerHTML = `
    <div class="grid metrics">
      ${metric("Severity", analysis.severity || "unknown", analysis.shouldCompactBeforeModel ? "compact" : "ok")}
      ${metric("Tokens", result.summary?.inputTokens || 0, "input")}
      ${metric("Waste", analysis.estimatedWasteTokens || 0, `${Math.round((analysis.estimatedWasteRatio || 0) * 100)} percent`)}
      ${metric("Tools", result.summary?.toolSchemaCount || 0, `${result.summary?.mcpServerCount || 0} MCP`)}
    </div>
    <div class="panel">
      <div class="section-head"><h2>Actions</h2></div>
      ${(analysis.suggestedActions || []).map((action) => `<div class="activity-item"><strong>${esc(action.action)}</strong><div class="muted">${esc(action.reason || "")}</div><div>${esc(action.expectedImpact || "")}</div></div>`).join("")}
    </div>
    <div class="panel">
      <div class="section-head"><h2>Largest Files</h2></div>
      ${(analysis.largestFiles || []).map((file) => rowLine(file.path || file.name, `${file.tokens || 0} tokens`)).join("") || emptyLine("No file token data.")}
    </div>
  `;
}

async function routeModelBrain() {
  const roleAlias = $("#brain-role-alias").value.trim();
  const candidateModel = $("#brain-candidate-model").value.trim();
  const inputTokens = Number($("#brain-input-tokens").value);
  if (!roleAlias && !candidateModel) {
    toast("Choose a role alias or enter a candidate model.");
    return;
  }
  if (!Number.isFinite(inputTokens) || inputTokens < 1) {
    toast("Input tokens must be a positive number.");
    return;
  }
  const queue = state.dashboard?.queue || {};
  const selectedTask = state.taskDetail?.task || {};
  const taskType = $("#brain-task-type").value.trim() || "code_edit";
  const goal = $("#brain-goal").value.trim() || `Route ${taskType} request${queue.title ? ` for ${queue.title}` : ""}.`;
  const result = await callTool("model_brain_route", {
    client: "local-cli_desktop",
    roleAlias: roleAlias || undefined,
    candidateModel: candidateModel || undefined,
    task: compactObject({
      type: taskType,
      goal,
      queueId: state.selectedQueueId || undefined,
      queueTaskId: selectedTask.queueTaskId,
      title: selectedTask.title,
      phase: selectedTask.phase,
      category: selectedTask.category,
      priority: selectedTask.priority,
      requiredTools: selectedTask.requiredTools,
      requiredMcpServers: selectedTask.requiredMcpServers,
      requiredMemories: selectedTask.requiredMemories,
      requiredContextRefs: selectedTask.requiredContextRefs
    }),
    contextPackageSummary: {
      inputTokens
    },
    risk: $("#brain-risk").value,
    enforce: $("#brain-enforce").checked,
    budgetScope: state.selectedQueueId ? `project_queue:${state.selectedQueueId}` : undefined
  });
  renderModelBrain(result);
  selectTab("model-brain");
}

async function routeSelectedTaskModel() {
  if (!state.taskDetail?.task) {
    toast("Select a task before routing a model request.");
    return;
  }
  prefillModelBrainFromTask(state.taskDetail.task, state.taskDetail);
  await routeModelBrain();
}

function prefillModelBrainFromTask(task, detail = {}) {
  const risk = ["low", "medium", "high", "breakglass"].includes(task.risk) ? task.risk : "medium";
  $("#brain-risk").value = risk;
  $("#brain-role-alias").value = risk === "high" || risk === "breakglass" ? "review.strong" : "execute.cheap";
  $("#brain-candidate-model").value = "";
  $("#brain-task-type").value = task.category || "code_edit";
  $("#brain-input-tokens").value = String(estimateTaskInputTokens(task, detail));
  $("#brain-goal").value = [
    task.title ? `Task: ${task.title}` : "",
    task.goal ? `Goal: ${task.goal}` : "",
    task.phase ? `Phase: ${task.phase}` : "",
    task.acceptanceCriteria?.length ? `Acceptance: ${task.acceptanceCriteria.join("; ")}` : "",
    task.expectedFiles?.length ? `Expected files: ${task.expectedFiles.join(", ")}` : "",
    task.requiredTools?.length ? `Required tools: ${task.requiredTools.join(", ")}` : "",
    task.requiredMcpServers?.length ? `Required MCP: ${task.requiredMcpServers.join(", ")}` : "",
    task.requiredContextRefs?.length ? `Context refs: ${task.requiredContextRefs.join(", ")}` : "",
    task.requiredMemories?.length ? `Memories: ${task.requiredMemories.join(", ")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function estimateTaskInputTokens(task, detail = {}) {
  const textFields = [task.title, task.goal, task.summary, ...(task.acceptanceCriteria || []), ...(task.patchRefs || []), ...(task.testRefs || [])]
    .filter(Boolean)
    .join("\n");
  const fileTokens = (task.expectedFiles || []).length * 1200;
  const grantTokens =
    ((task.requiredTools || []).length + (task.requiredMcpServers || []).length + (task.requiredContextRefs || []).length + (task.requiredMemories || []).length) * 350;
  const graphTokens = ((detail.graph?.dependencies || []).length + (detail.graph?.dependents || []).length) * 250;
  const resumeTokens = detail.resume ? 1000 : 0;
  const estimated = 3500 + Math.ceil(textFields.length / 4) + fileTokens + grantTokens + graphTokens + resumeTokens;
  return Math.max(1000, Math.min(120_000, estimated));
}

function renderModelBrain(result) {
  const route = result.route || {};
  const requested = result.requested || {};
  const resolution = result.routeResolution || {};
  const gate = result.gate || {};
  const estimate = result.estimate || {};
  const approval = result.approval || {};
  $("#model-brain-result").innerHTML = `
    <div class="grid metrics">
      ${metric("Decision", result.decision || "unknown", gate.mustBlock ? "blocked" : gate.requiresApproval ? "approval" : "allowed")}
      ${metric("Estimate", money(estimate.estimatedCostUsd || 0), `${estimate.inputTokens || 0} in / ${estimate.reservedOutputTokens || 0} out`)}
      ${metric("Risk", result.risk || "unknown", result.taskType || "")}
      ${metric("Route", route.model || "unknown", `${route.provider || ""} ${route.reasoning || ""}`)}
      ${metric("Requested", requested.candidateModel || requested.roleAlias || "unknown", `${requested.provider || "auto"} ${requested.reasoning || "auto"}`)}
      ${metric("Resolution", resolution.changed ? "resolved" : "direct", resolution.summary || "")}
    </div>
    <div class="grid detail-grid">
      ${detailPanel(
        "Gate",
        `<div class="kv">
          <div>Allow</div><div>${gate.allowModelCall ? "yes" : "no"}</div>
          <div>Approval</div><div>${gate.requiresApproval ? "required" : "not required"}</div>
          <div>Compaction</div><div>${gate.requiresCompaction ? "required" : "not required"}</div>
          <div>Mode</div><div>${esc(gate.enforcementMode || "")}</div>
        </div>`
      )}
      ${detailPanel(
        "Route",
        `<div class="kv">
          <div>Requested source</div><div>${esc(requested.source || "")}</div>
          <div>Requested candidate</div><div>${esc(requested.candidateModel || "")}</div>
          <div>Requested provider</div><div>${esc(requested.provider || "auto")}</div>
          <div>Requested reasoning</div><div>${esc(requested.reasoning || "auto")}</div>
          <div>Provider</div><div>${esc(route.provider || "")}</div>
          <div>Model</div><div>${esc(route.model || "")}</div>
          <div>Reasoning</div><div>${esc(route.reasoning || "")}</div>
          <div>Budget</div><div>${esc(result.budgetScope || "")}</div>
        </div>
        <div class="listline">
          ${resolution.changed ? `<span class="pill amber">resolved route</span>` : `<span class="pill green">direct route</span>`}
          ${(route.reasonCodes || []).map((code) => `<span class="pill">${esc(code)}</span>`).join("")}
        </div>
        ${resolution.summary ? `<div class="muted">${esc(resolution.summary)}</div>` : ""}`
      )}
      ${detailPanel("Recommendations", listItems(result.recommendations || []))}
      ${detailPanel("Warnings", listItems(result.warnings || []))}
      ${detailPanel(
        "Approval",
        approval.requestId
          ? `<div class="kv"><div>Request</div><div>${esc(approval.requestId)}</div><div>Status</div><div>${esc(approval.status || "")}</div></div>
             <div class="row-actions">
               <button class="primary" data-brain-model-approval data-request-id="${esc(approval.requestId)}" data-decision="allow" type="button">Allow</button>
               <button data-brain-model-approval data-request-id="${esc(approval.requestId)}" data-decision="compact" type="button">Compact</button>
               <button data-brain-model-approval data-request-id="${esc(approval.requestId)}" data-decision="downgrade" type="button">Downgrade</button>
               <button class="danger" data-brain-model-approval data-request-id="${esc(approval.requestId)}" data-decision="cancel" type="button">Cancel</button>
               <button data-inspect-brain-context data-request-id="${esc(result.preflightRequestId || approval.requestId)}" type="button">Inspect Context</button>
             </div>`
          : result.preflightRequestId
            ? `<button data-inspect-brain-context data-request-id="${esc(result.preflightRequestId)}" type="button">Inspect Context</button>`
            : emptyLine("No approval request.")
      )}
    </div>
  `;
  $("#model-brain-result").querySelectorAll("[data-inspect-brain-context]").forEach((button) => {
    button.addEventListener("click", () => {
      $("#context-request-id").value = button.dataset.requestId || "";
      inspectContext();
    });
  });
  $("#model-brain-result").querySelectorAll("[data-brain-model-approval]").forEach((button) => {
    button.addEventListener("click", () => decideModel(button.dataset.requestId, button.dataset.decision));
  });
}

function selectTab(tab, options = {}) {
  const selectedTab = VALID_TABS.has(tab) ? tab : "dashboard";
  state.activeTab = selectedTab;
  document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === selectedTab));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.add("hidden"));
  $(`#tab-${selectedTab}`)?.classList.remove("hidden");
  if (selectedTab === "approvals") {
    const projectPath = selectedProjectPath();
    if (projectPath && state.projectPolicyStatus?.projectPath !== projectPath) {
      loadProjectPolicyStatus({ quiet: true }).catch((error) => {
        upsertNotice("project-policy", "Project policy status unavailable", {
          severity: "warning",
          detail: messageOf(error),
          code: error?.code
        });
      });
    }
  }
  if (options.persist !== false) persistDesktopPreferences();
}

function isCommandPaletteShortcut(event) {
  return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && String(event.key || "").toLowerCase() === "k";
}

function openCommandPalette(query = "") {
  if (!state.commandPaletteOpen) state.commandPaletteReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.commandPaletteOpen = true;
  state.commandPaletteQuery = query;
  state.commandPaletteIndex = 0;
  $("#command-palette").classList.remove("hidden");
  $("#command-palette").setAttribute("aria-hidden", "false");
  $("#command-palette-input").value = query;
  $("#command-palette-input").setAttribute("aria-expanded", "true");
  renderCommandPalette();
  window.requestAnimationFrame(() => $("#command-palette-input").focus());
}

function closeCommandPalette() {
  const returnFocus = state.commandPaletteReturnFocus;
  state.commandPaletteOpen = false;
  state.commandPaletteQuery = "";
  state.commandPaletteIndex = 0;
  state.commandPaletteReturnFocus = null;
  $("#command-palette").classList.add("hidden");
  $("#command-palette").setAttribute("aria-hidden", "true");
  $("#command-palette-input").setAttribute("aria-expanded", "false");
  $("#command-palette-input").removeAttribute("aria-activedescendant");
  if (returnFocus?.isConnected) window.requestAnimationFrame(() => returnFocus.focus());
}

function handleCommandPaletteInputKeydown(event) {
  const commands = filteredCommandPaletteCommands();
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    state.commandPaletteIndex = clampIndex(state.commandPaletteIndex + direction, commands.length);
    renderCommandPalette();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const command = commands[state.commandPaletteIndex];
    if (command) executeCommandPaletteCommand(command);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeCommandPalette();
  }
}

function clampIndex(index, length) {
  if (!length) return 0;
  return ((index % length) + length) % length;
}

function renderCommandPalette() {
  if (!state.commandPaletteOpen) return;
  const list = $("#command-palette-list");
  const commands = filteredCommandPaletteCommands();
  if (state.commandPaletteIndex >= commands.length) state.commandPaletteIndex = Math.max(0, commands.length - 1);
  const activeId = commands.length ? `command-palette-option-${state.commandPaletteIndex}` : "";
  if (activeId) $("#command-palette-input").setAttribute("aria-activedescendant", activeId);
  else $("#command-palette-input").removeAttribute("aria-activedescendant");
  list.innerHTML = commands.length
    ? commands
        .map(
          (command, index) => `
            <button id="command-palette-option-${index}" class="command-row${index === state.commandPaletteIndex ? " active" : ""}" data-command-id="${esc(command.id)}" type="button" role="option" aria-selected="${index === state.commandPaletteIndex ? "true" : "false"}" aria-disabled="${command.disabled ? "true" : "false"}"${command.disabled ? " disabled" : ""}>
              <span>
                <strong>${esc(command.title)}</strong>
                ${command.detail ? `<span class="muted">${esc(command.detail)}</span>` : ""}
              </span>
              ${command.badge ? `<span class="pill ${esc(command.badgeClass || "")}">${esc(command.badge)}</span>` : ""}
            </button>
          `
        )
        .join("")
    : `<div class="empty">No matching command.</div>`;
  list.querySelectorAll("[data-command-id]").forEach((button) => {
    button.addEventListener("mouseenter", () => {
      state.commandPaletteIndex = commands.findIndex((command) => command.id === button.dataset.commandId);
      renderCommandPalette();
    });
    button.addEventListener("click", () => {
      const command = commands.find((entry) => entry.id === button.dataset.commandId);
      if (command) executeCommandPaletteCommand(command);
    });
  });
}

function filteredCommandPaletteCommands() {
  const query = state.commandPaletteQuery.trim().toLowerCase();
  const commands = commandPaletteCommands();
  if (!query) return commands;
  return commands.filter((command) => commandPaletteHaystack(command).includes(query));
}

function commandPaletteHaystack(command) {
  return [command.title, command.detail, command.badge, ...(command.keywords || [])].filter(Boolean).join(" ").toLowerCase();
}

function executeCommandPaletteCommand(command) {
  if (command.disabled) {
    toast(command.disabledReason || "Command unavailable.");
    return;
  }
  closeCommandPalette();
  Promise.resolve(command.run()).catch((error) => {
    upsertNotice("command-palette", "Command failed", {
      severity: "error",
      detail: messageOf(error),
      code: error?.code
    });
    toast(`Command failed: ${messageOf(error)}`);
  });
}

function commandPaletteCommands() {
  const hasQueue = Boolean(state.selectedQueueId);
  const selectedTaskId = state.selectedTaskId;
  const queueStatus = state.dashboard?.queue?.status || state.matrix?.queue?.status || "";
  const disabledQueue = hasQueue ? {} : { disabled: true, disabledReason: "Select a queue first." };
  const liveLanes = liveLaneDashboardData();
  const disabledLiveCopy = hasQueue && liveLanes.active.length
    ? {}
    : { disabled: true, disabledReason: hasQueue ? "No active lanes to copy." : "Select a queue first." };
  const badges = tabBadgeData();
  const commands = [
    { id: "refresh", title: "Refresh", detail: "Reload queues and active queue state", run: () => refreshAll(), keywords: ["reload"] },
    {
      id: "new-queue",
      title: "New Queue",
      detail: "Open the queue intake form",
      run: () => {
        showNewQueueForm(true);
        focusSelector("#new-project-path");
      },
      keywords: ["create project"]
    },
    { id: "focus-project", title: "Project Filter", detail: "Focus the queue project filter", run: () => focusSelector("#project-filter"), keywords: ["search queues"] },
    { id: "copy-link", title: "Copy Current Link", detail: "Copy a link to this queue view", run: () => copyCurrentLink(), ...disabledQueue },
    { id: "prepare-ready", title: "Prepare Ready Tasks", detail: "Create tool/context proposals for launchable work", run: () => prepareReady(), ...disabledQueue },
    { id: "launch-plan", title: "Plan Launch", detail: "Preview ready work and launch blockers", run: () => loadLaunchPlan(true), ...disabledQueue },
    { id: "start-execution", title: "Start Execution", detail: `Queue status ${queueStatus || "unknown"}`, run: () => decideQueue("start_execution"), ...disabledQueue },
    { id: "pause", title: "Pause Queue", detail: `Queue status ${queueStatus || "unknown"}`, run: () => decideQueue("pause"), ...disabledQueue },
    { id: "resume", title: "Resume Queue", detail: `Queue status ${queueStatus || "unknown"}`, run: () => decideQueue("resume"), ...disabledQueue },
    { id: "senior-factory", title: "Senior Factory Defaults", detail: "DeepSeek direct, git worktrees, 10 ready lanes", run: () => applySeniorFactoryDefaults(), ...disabledQueue, keywords: ["deepseek 10 agents worker"] },
    { id: "copy-senior-factory-command", title: "Copy Senior Factory Command", detail: "Copy a 10-lane DeepSeek factory-run command", run: () => copySeniorFactoryCommand(), ...disabledQueue, keywords: ["deepseek factory cli command"] },
    {
      id: "live-lanes",
      title: "Open Live Lanes",
      detail: `${liveLanes.active.length} active / ${liveLanes.deepseek.length} DeepSeek lane(s)`,
      run: () => {
        selectTab("dashboard");
        focusSelector("[data-live-refresh]");
      },
      badge: liveLanes.active.length ? String(liveLanes.active.length) : "",
      badgeClass: liveLanes.quiet.length ? "amber" : "green",
      ...disabledQueue,
      keywords: ["dashboard theater active workers deepseek lanes"]
    },
    {
      id: "copy-active-lane-briefs",
      title: "Copy Active Lane Briefs",
      detail: "Copy only the currently active lane briefs",
      run: () => copyActiveLaneBriefs(),
      ...disabledLiveCopy,
      keywords: ["live lanes briefs deepseek workers"]
    },
    { id: "claim-next", title: "Claim Next Worker", detail: claimDefaultsLabel(), run: () => claimNextWorker(), ...disabledQueue },
    { id: "claim-ready", title: "Claim Ready Slots", detail: claimDefaultsLabel(), run: () => claimReadyBatch(), ...disabledQueue, badge: String(state.claimDefaults.batchLimit || SENIOR_CLAIM_DEFAULTS.batchLimit), badgeClass: "blue" },
    { id: "recover-stale", title: "Recover Stale Workers", detail: "Dry-run stale worker recovery from dashboard defaults", run: () => recoverStale(), ...disabledQueue },
    { id: "copy-task-link", title: "Copy Task Link", detail: selectedTaskId || "No task selected", run: () => copySelectedTaskLink(), disabled: !selectedTaskId, disabledReason: "Select a task first." },
    { id: "copy-task-brief", title: "Copy Task Brief", detail: selectedTaskId || "No task selected", run: () => copySelectedTaskBrief("worker"), disabled: !selectedTaskId, disabledReason: "Select a task first." }
  ];
  for (const tab of VALID_TABS) {
    commands.push({
      id: `tab-${tab}`,
      title: `Open ${TAB_LABELS[tab] || tab}`,
      detail: tab === state.activeTab ? "Current view" : "Switch queue view",
      run: () => selectTab(tab),
      badge: badges[tab]?.count ? String(badges[tab].count) : "",
      badgeClass: badges[tab]?.severity || "blue",
      ...disabledQueue
    });
  }
  for (const task of commandPaletteTasks()) {
    commands.push({
      id: `task-${task.queueTaskId}`,
      title: task.title || task.queueTaskId,
      detail: `${task.status || "task"} - ${task.goal || ""}`,
      badge: task.status || "",
      badgeClass: statusClass(task.status),
      run: () => loadTaskDetail(task.queueTaskId),
      keywords: [task.queueTaskId, task.risk, task.phase, task.category].filter(Boolean)
    });
  }
  return commands;
}

function claimDefaultsLabel() {
  const claim = state.claimDefaults || {};
  return `${claim.worker || "worker"} - ${claim.workspaceMode || "workspace"} - ${claim.modelProfile || "model"}`;
}

function commandPaletteTasks() {
  const board = state.dashboard?.queueBoard || {};
  const buckets = ["ready", "running", "review", "blocked"];
  const seen = new Set();
  return buckets
    .flatMap((bucket) => (Array.isArray(board[bucket]) ? board[bucket] : []))
    .map((task) => {
      const id = task?.queueTaskId || task?.id;
      if (!id || seen.has(id)) return null;
      seen.add(id);
      return { ...task, queueTaskId: id };
    })
    .filter(Boolean)
    .slice(0, 18);
}

function focusSelector(selector) {
  window.requestAnimationFrame(() => {
    const element = $(selector);
    if (element) element.focus();
  });
}

function metric(label, value, detail) {
  return `<div class="metric"><div class="metric-value">${esc(String(value))}</div><div class="metric-label">${esc(label)}${detail ? ` - ${esc(String(detail))}` : ""}</div></div>`;
}

function operatorBriefPanelHtml() {
  const data = operatorBriefData();
  return `
    <div class="panel operator-brief-panel">
      <div class="section-head">
        <h2>Operator Brief</h2>
        <span class="pill ${data.attentionCount ? "amber" : "green"}">${data.attentionCount ? `${data.attentionCount} attention` : "ready"}</span>
      </div>
      <div class="grid metrics operator-brief-metrics">
        ${metric("Queue", data.queueStatus, `${data.maxAgents} max agents`)}
        ${metric("Safe Lanes", data.parallelSafe, "parallel ready")}
        ${metric("Review", data.reviewCount, "patch-ready")}
        ${metric("Approvals", data.pendingApprovals, "waiting")}
      </div>
      <pre class="resume-box operator-brief-preview">${esc(operatorBriefText({ preview: true }))}</pre>
      <div class="row-actions operator-brief-actions">
        <button class="primary" data-copy-operator-brief type="button">Copy Operator Brief</button>
        <button data-action-tab="theater" type="button">Open Theater</button>
        <button data-action-tab="matrix" type="button">Open Matrix</button>
      </div>
    </div>
  `;
}

function operatorBriefData() {
  const dashboard = state.dashboard || {};
  const summary = dashboard.summaryStrip || {};
  const counts = summary.counts || {};
  const queue = dashboard.queue || state.matrix?.queue || {};
  const cost = summary.cost || {};
  const risk = summary.risk || {};
  const parallel = parallelWorkPreview();
  const review = patchReviewTasks();
  const actionItems = state.actionInbox?.items || [];
  const pendingApprovals = num(counts.pendingApprovals) || (state.approvals?.toolContext?.length || 0) + (state.approvals?.modelCalls?.length || 0);
  const queueGrants = state.matrix?.toolContext?.grants || [];
  const savedGrants = state.projectPolicyStatus?.projectPath === selectedProjectPath() ? state.projectPolicyStatus.grants || [] : [];
  const policy = projectPolicySummary(queueGrants, savedGrants);
  const attentionCount =
    pendingApprovals +
    num(counts.staleRunning) +
    policy.queueMissing +
    policy.queueRejected +
    review.length +
    actionItems.filter((item) => item.severity === "warning" || item.severity === "attention").length;
  return {
    queue,
    queueStatus: queue.status || summary.status || "unknown",
    maxAgents: queue.maxParallelAgents || dashboard.queue?.maxParallelAgents || "?",
    ready: num(counts.ready),
    running: num(dashboard.activeWorkers),
    availableSlots: num(counts.availableSlots ?? dashboard.availableSlots),
    blocked: (dashboard.queueBoard?.blocked || []).length,
    pendingApprovals,
    staleRunning: num(counts.staleRunning),
    estimatedCost: Number(cost.estimatedCostUsd || 0),
    preflights: num(cost.preflightCount),
    highRisk: num(risk.highRiskOpenCount),
    parallelSafe: parallel.safe.length,
    parallelSerial: parallel.serial.length,
    parallelOverlaps: parallel.overlapScopes.length,
    reviewCount: review.length,
    actionItems,
    policy,
    parallel,
    review
  };
}

function operatorBriefText(options = {}) {
  const data = operatorBriefData();
  const queue = data.queue || {};
  const actionItems = data.actionItems.slice(0, options.preview ? 3 : 8);
  const safeTasks = data.parallel.safe.slice(0, options.preview ? 3 : 8);
  const reviewTasks = data.review.slice(0, options.preview ? 3 : 8);
  const lines = [
    "# Agent Fabric Console Operator Brief",
    "",
    `Queue: ${queue.title || queue.queueId || state.selectedQueueId || "selected queue"}`,
    `Project: ${queue.projectPath || selectedProjectPath() || "project path unavailable"}`,
    `Status: ${data.queueStatus}`,
    `Workers: ${data.running}/${data.maxAgents} active, ${data.availableSlots} slot(s) available`,
    `Ready: ${data.ready} task(s), ${data.parallelSafe} parallel-safe, ${data.parallelSerial} serial/risk review`,
    `Approvals: ${data.pendingApprovals} pending, policy missing ${data.policy.queueMissing}, policy rejected ${data.policy.queueRejected}`,
    `Cost/Risk: ${money(data.estimatedCost)} estimated, ${data.preflights} preflight(s), ${data.highRisk} high-risk task(s)`,
    `Patch review: ${data.reviewCount} task(s)`,
    `File overlap: ${data.parallelOverlaps} scope(s)`,
    ""
  ];
  if (actionItems.length) {
    lines.push("Next actions:");
    for (const item of actionItems) lines.push(`- ${item.title || item.kind || "Action"}${item.detail ? `: ${item.detail}` : ""}`);
    lines.push("");
  }
  if (safeTasks.length) {
    lines.push("Parallel-safe ready tasks:");
    for (const entry of safeTasks) lines.push(`- ${entry.task.title || entry.task.queueTaskId} (${entry.task.queueTaskId})`);
    lines.push("");
  }
  if (reviewTasks.length) {
    lines.push("Patch-ready review tasks:");
    for (const task of reviewTasks) lines.push(`- ${task.title || task.queueTaskId} (${task.queueTaskId})`);
    lines.push("");
  }
  if (options.preview && (data.parallel.safe.length > safeTasks.length || data.review.length > reviewTasks.length)) {
    lines.push("Copy the full brief to include all ready and review tasks.");
  }
  return lines.join("\n").trim();
}

async function copyOperatorBrief() {
  await copyText(operatorBriefText());
  toast("Operator brief copied.");
}

function liveLanesPanelHtml() {
  const data = liveLaneDashboardData();
  const headerDetail = data.active.length
    ? `${data.active.length} active / ${data.deepseek.length} DeepSeek`
    : "No active lanes";
  return `
    <div class="panel live-lanes-panel">
      <div class="section-head live-lanes-headline">
        <div>
          <h2>Background Agents</h2>
          <div class="muted">${esc(data.nextAction)}</div>
        </div>
        <div class="section-actions">
          <span class="pill">${esc(data.lanes.length)} background agents</span>
          <span class="pill ${data.quiet.length ? "amber" : data.active.length ? "green" : "blue"}">${esc(headerDetail)}</span>
          <span class="live-lane-freshness">${esc(data.refreshLabel)}</span>
        </div>
      </div>
      <div class="grid metrics live-lane-metrics">
        ${metric("Active", data.active.length, "worker lanes")}
        ${metric("DeepSeek", data.deepseek.length, "active lanes")}
        ${metric("Review", data.reviewReady.length, "patch-ready")}
        ${metric("Quiet", data.quiet.length, "needs attention")}
      </div>
      <div class="live-lane-grid">
        ${data.visible.length ? data.visible.map(liveLaneCardHtml).join("") : liveLaneEmptyHtml()}
        ${data.hiddenCount ? liveLaneMoreHtml(data.hiddenCount) : ""}
      </div>
      <div class="row-actions live-lanes-actions">
        <button class="primary" data-live-refresh type="button">Refresh</button>
        <button data-live-open-theater type="button">Open</button>
        <button data-live-copy-lanes type="button" ${data.active.length ? "" : "disabled"}>Copy Active Briefs</button>
        <button data-live-claim-ready type="button">Claim Ready Slots</button>
        <button data-live-copy-senior type="button" ${state.selectedQueueId ? "" : "disabled"}>Copy Senior Command</button>
      </div>
    </div>
  `;
}

function liveLaneDashboardData() {
  const lanes = Array.isArray(state.lanes?.lanes) ? state.lanes.lanes : [];
  const active = lanes.filter(isActiveLane);
  const deepseek = active.filter(isDeepSeekLane);
  const reviewReady = active.filter((lane) => {
    const status = laneStatus(lane);
    return status.includes("patch") || status.includes("review");
  });
  const quiet = active.filter((lane) => liveLaneActivity(lane).severity !== "green");
  const visible = active
    .slice()
    .sort((left, right) => liveLaneUpdatedMs(right) - liveLaneUpdatedMs(left))
    .slice(0, 6);
  const dashboard = state.dashboard || {};
  const summary = dashboard.summaryStrip || {};
  return {
    lanes,
    active,
    deepseek,
    reviewReady,
    quiet,
    visible,
    hiddenCount: Math.max(0, active.length - visible.length),
    refreshLabel: state.lastSnapshotAt ? `Refreshed ${ageLabel(state.lastSnapshotAt)}` : "Waiting for first snapshot",
    nextAction: summary.nextAction || (active.length ? "Watch active worker lanes from the dashboard." : "Start or claim ready work to populate live lanes.")
  };
}

function liveLaneCardHtml(lane = {}) {
  const task = lane.queueTask || {};
  const run = lane.workerRun || {};
  const progress = lane.progress || {};
  const checkpointSummary = lane.latestCheckpoint?.summary || {};
  const status = laneStatus(lane);
  const activity = liveLaneActivity(lane);
  const percent = theaterProgressPercent(status);
  const laneId = laneStableId(lane);
  const files = laneListValues(progress.filesTouched || checkpointSummary.filesTouched);
  const tests = laneListValues(progress.testsRun || checkpointSummary.testsRun);
  const events = Array.isArray(lane.recentEvents) ? lane.recentEvents : [];
  const title = task.title || lane.laneId || run.workerRunId || "Worker lane";
  const agentName = codexLaneDisplayName(lane);
  const handle = codexLaneHandle(lane);
  const workerDetail = [run.worker || "worker", run.modelProfile, run.workspaceMode].filter(Boolean).join(" / ");
  const summary = progress.summary || checkpointSummary.nextAction || lane.latestEvent?.body || "Waiting for worker events.";
  return `
    <div class="live-lane-card ${activity.severity}">
      <div class="live-lane-card-head">
        <div class="live-lane-title">
          <strong>${esc(agentName)}</strong>
          <div class="muted truncate">${esc(handle)} - ${esc(workerDetail)}</div>
          <div class="truncate">${esc(title)}</div>
        </div>
        <div class="live-lane-pills">
          <span class="pill ${statusClass(status)}">${esc(progress.label || run.status || task.status || "active")}</span>
          <span class="pill ${activity.severity}">${esc(activity.label)}</span>
        </div>
      </div>
      <div class="live-lane-progress" aria-label="Lane progress"><span style="width: ${percent}%"></span></div>
      <div class="live-lane-summary">${esc(summary)}</div>
      <div class="live-lane-facts">
        <div><strong>${files.length || 0}</strong><span>files</span></div>
        <div><strong>${tests.length || 0}</strong><span>tests</span></div>
        <div><strong>${events.length || 0}</strong><span>events</span></div>
      </div>
      <div class="row-actions live-lane-card-actions">
        ${task.queueTaskId ? `<button type="button" data-live-task="${esc(task.queueTaskId)}">Open</button>` : ""}
        <button type="button" data-copy-lane-brief="${esc(laneId)}">Copy Brief</button>
      </div>
    </div>
  `;
}

const CODEX_AGENT_NAMES = ["Volta", "Ada", "Turing", "Noether", "Euler", "Curie", "Hopper", "Dirac", "Feynman", "Lovelace"];

function codexLaneDisplayName(lane = {}) {
  const runId = String(lane.workerRun?.workerRunId || lane.laneId || "");
  const index = stableNameIndex(runId);
  return CODEX_AGENT_NAMES[index % CODEX_AGENT_NAMES.length];
}

function codexLaneHandle(lane = {}) {
  const runId = String(lane.workerRun?.workerRunId || lane.laneId || "agent");
  return `@af/${codexLaneDisplayName(lane).toLowerCase()}-${runId.slice(-6)}`;
}

function stableNameIndex(value) {
  let hash = 0;
  for (const ch of String(value)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash;
}

function liveLaneEmptyHtml() {
  return `
    <div class="live-lane-empty">
      <strong>No active lanes</strong>
      <div class="muted">Claim ready slots with Senior Factory defaults or open Theater when work starts.</div>
    </div>
  `;
}

function laneListValues(values) {
  return Array.isArray(values) ? values.filter(Boolean) : [];
}

function liveLaneMoreHtml(hiddenCount) {
  return `
    <div class="live-lane-card live-lane-more">
      <strong>${esc(hiddenCount)} more active lane(s)</strong>
      <div class="muted">Open Theater for the full lane board, event lists, checkpoints, and per-lane briefs.</div>
      <div class="row-actions live-lane-card-actions">
        <button type="button" data-live-open-theater>Open Theater</button>
      </div>
    </div>
  `;
}

function bindLiveLanesActions(root) {
  root.querySelectorAll("[data-live-refresh]").forEach((button) => {
    button.addEventListener("click", () => loadSelectedQueue({ quiet: true }));
  });
  root.querySelectorAll("[data-live-open-theater]").forEach((button) => {
    button.addEventListener("click", () => selectTab("theater"));
  });
  root.querySelectorAll("[data-live-copy-lanes]").forEach((button) => {
    button.addEventListener("click", () => copyActiveLaneBriefs());
  });
  root.querySelectorAll("[data-live-claim-ready]").forEach((button) => {
    button.addEventListener("click", () => claimReadyBatch());
  });
  root.querySelectorAll("[data-live-copy-senior]").forEach((button) => {
    button.addEventListener("click", () => copySeniorFactoryCommand());
  });
  root.querySelectorAll("[data-live-task]").forEach((button) => {
    button.addEventListener("click", () => loadTaskDetail(button.dataset.liveTask));
  });
}

async function copyActiveLaneBriefs() {
  const lanes = liveLaneDashboardData().active;
  if (!lanes.length) {
    toast("No active lane briefs to copy.");
    return;
  }
  await copyText(lanes.map(laneBriefText).join("\n\n---\n\n"));
  toast(`Copied ${lanes.length} active lane brief(s).`);
}

function isActiveLane(lane = {}) {
  return !isClosedLaneStatus(laneStatus(lane));
}

function isClosedLaneStatus(status) {
  const normalized = String(status || "").toLowerCase();
  return ["completed", "done", "failed", "canceled", "cancelled"].some((closed) => normalized.includes(closed));
}

function laneStatus(lane = {}) {
  return String(lane.progress?.label || lane.workerRun?.status || lane.queueTask?.status || "").toLowerCase();
}

function isDeepSeekLane(lane = {}) {
  const run = lane.workerRun || {};
  const values = [run.worker, run.modelProfile, run.contextPolicy, run.workspacePath, Array.isArray(run.command) ? run.command.join(" ") : ""];
  return values.some((value) => String(value || "").toLowerCase().includes("deepseek"));
}

function liveLaneActivity(lane = {}) {
  const updatedMs = liveLaneUpdatedMs(lane);
  if (!updatedMs) return { severity: "blue", label: "waiting" };
  const minutes = Math.max(0, (Date.now() - updatedMs) / 60_000);
  if (minutes >= 30) return { severity: "red", label: "stale" };
  if (minutes >= 10) return { severity: "amber", label: "quiet" };
  return { severity: "green", label: "live" };
}

function liveLaneUpdatedMs(lane = {}) {
  const candidates = [
    lane.latestEvent?.timestamp,
    lane.latestCheckpoint?.timestamp,
    lane.workerRun?.updatedAt,
    lane.workerRun?.startedAt
  ];
  return candidates.reduce((latest, value) => Math.max(latest, timestampMs(value)), 0);
}

function timestampMs(value) {
  if (!value) return 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function ageLabel(value) {
  const timestamp = timestampMs(value);
  if (!timestamp) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function costRiskStripHtml() {
  const dashboard = state.dashboard || {};
  const summary = dashboard.summaryStrip || {};
  const cost = summary.cost || {};
  const risk = summary.risk || {};
  const modelApprovals = state.approvals?.modelCalls || [];
  const pendingModelCost = modelApprovals.reduce((total, item) => total + Number(item.estimate?.estimatedCostUsd || 0), 0);
  const firstRequest = modelApprovals.find((item) => item.requestId)?.requestId;
  const highRiskOpen = num(risk.highRiskOpenCount);
  const preflights = num(cost.preflightCount);
  const estimatedCost = Number(cost.estimatedCostUsd || 0);
  const severity = highRiskOpen || modelApprovals.length || estimatedCost >= 1 ? "amber" : "green";
  return `
    <div class="cost-risk-strip ${severity}">
      <div class="cost-risk-main">
        <div>
          <h2>Cost / Risk</h2>
          <div class="muted">${esc(costRiskSummaryText({ estimatedCost, preflights, highRiskOpen, modelApprovals: modelApprovals.length }))}</div>
        </div>
        <div class="cost-risk-stats">
          <span class="pill ${estimatedCost >= 1 ? "amber" : "green"}">${money(estimatedCost)} est</span>
          <span class="pill ${pendingModelCost ? "amber" : "green"}">${money(pendingModelCost)} pending</span>
          <span class="pill">${preflights} preflights</span>
          <span class="pill ${highRiskOpen ? "amber" : "green"}">${highRiskOpen} high risk</span>
        </div>
      </div>
      <div class="row-actions cost-risk-actions">
        <button data-action-tab="model-brain" type="button">Model Brain</button>
        <button data-action-tab="approvals" type="button">Model Approvals</button>
        ${firstRequest ? `<button data-cost-inspect-request data-request-id="${esc(firstRequest)}" type="button">Inspect Context</button>` : ""}
      </div>
    </div>
  `;
}

function costRiskSummaryText({ estimatedCost, preflights, highRiskOpen, modelApprovals }) {
  const parts = [];
  if (estimatedCost > 0) parts.push(`${money(estimatedCost)} estimated queued spend`);
  if (modelApprovals > 0) parts.push(`${modelApprovals} model approval(s) pending`);
  if (highRiskOpen > 0) parts.push(`${highRiskOpen} high-risk open task(s)`);
  if (preflights > 0) parts.push(`${preflights} preflight(s) recorded`);
  return parts.length ? parts.join(" - ") : "No elevated model cost or risk signals reported.";
}

function launchReadinessPanelHtml() {
  const dashboard = state.dashboard || {};
  const summary = dashboard.summaryStrip || {};
  const counts = summary.counts || {};
  const queue = dashboard.queue || {};
  const activeWorkers = num(dashboard.activeWorkers);
  const queueGrants = state.matrix?.toolContext?.grants || [];
  const savedGrants = state.projectPolicyStatus?.projectPath === selectedProjectPath() ? state.projectPolicyStatus.grants || [] : [];
  const policy = projectPolicySummary(queueGrants, savedGrants);
  const toolApprovals = state.approvals?.toolContext?.length || 0;
  const modelApprovals = state.approvals?.modelCalls?.length || 0;
  const pendingApprovals = num(counts.pendingApprovals) || toolApprovals + modelApprovals;
  const staleRunning = num(counts.staleRunning);
  const ready = num(counts.ready);
  const availableSlots = num(counts.availableSlots ?? dashboard.availableSlots);
  const queueStatus = queue.status || "unknown";
  const checks = launchReadinessChecks({
    queueStatus,
    summaryStatus: summary.status,
    ready,
    availableSlots,
    activeWorkers,
    pendingApprovals,
    staleRunning,
    policy
  });
  const blocked = checks.filter((check) => check.state !== "ready");
  const severity = blocked.some((check) => check.state === "blocked") ? "red" : blocked.length ? "amber" : "green";
  const headline = blocked.length ? `${blocked.length} launch check(s) need attention` : "Ready to launch workers";
  return `
    <div class="panel">
      <div class="section-head">
        <h2>Launch Readiness</h2>
        <span class="pill ${severity}">${esc(headline)}</span>
      </div>
      <div class="grid metrics launch-readiness-metrics">
        ${metric("Ready Tasks", ready, "launch candidates")}
        ${metric("Available Slots", availableSlots, "worker capacity")}
        ${metric("Approvals", pendingApprovals, "pending")}
        ${metric("Policy Missing", policy.queueMissing, "required grants")}
      </div>
      <div class="launch-check-list">
        ${checks.map(launchCheckRowHtml).join("")}
      </div>
      <div class="row-actions launch-readiness-actions">
        <button data-launch-plan-preview type="button">Plan Launch</button>
        <button data-action-tab="approvals" type="button">Open Approvals</button>
        <button class="primary" data-action-claim-ready type="button" ${ready && availableSlots && !blocked.some((check) => check.kind === "policy" || check.kind === "approval") ? "" : "disabled"}>Claim Ready Slots</button>
        <button data-action-queue-decision="${queueStatus === "paused" ? "resume" : "start_execution"}" type="button">${queueStatus === "paused" ? "Resume" : "Start"}</button>
      </div>
    </div>
  `;
}

function launchReadinessChecks(input) {
  const checks = [];
  const gateOpen = ["running", "active"].includes(input.queueStatus);
  const gateRecoverable = ["paused", "queue_review", "approved", "ready"].includes(input.queueStatus) || input.summaryStatus === "waiting_on_start";
  checks.push({
    kind: "start",
    label: "Start Gate",
    state: gateOpen ? "ready" : gateRecoverable ? "attention" : "blocked",
    detail: gateOpen ? "Worker launch is open." : gateRecoverable ? "Start or resume execution before claiming workers." : `Queue is ${input.queueStatus}. Finish earlier gates first.`
  });
  checks.push({
    kind: "capacity",
    label: "Worker Capacity",
    state: input.availableSlots > 0 ? "ready" : input.activeWorkers > 0 ? "attention" : "blocked",
    detail: input.availableSlots > 0 ? `${input.availableSlots} slot(s) available.` : input.activeWorkers > 0 ? "All worker slots are occupied." : "No worker slots are available."
  });
  checks.push({
    kind: "ready",
    label: "Ready Tasks",
    state: input.ready > 0 ? "ready" : input.activeWorkers > 0 ? "attention" : "blocked",
    detail: input.ready > 0 ? `${input.ready} task(s) can be scheduled.` : input.activeWorkers > 0 ? "Workers are active; no additional ready tasks right now." : "No dependency-free ready tasks."
  });
  checks.push({
    kind: "approval",
    label: "Approvals",
    state: input.pendingApprovals > 0 ? "attention" : "ready",
    detail: input.pendingApprovals > 0 ? `${input.pendingApprovals} approval(s) pending.` : "No pending tool/model approval blocks."
  });
  checks.push({
    kind: "policy",
    label: "Tool Policy",
    state: input.policy.queueRejected > 0 ? "blocked" : input.policy.queueMissing > 0 ? "attention" : "ready",
    detail:
      input.policy.queueRejected > 0
        ? `${input.policy.queueRejected} required grant(s) are rejected.`
        : input.policy.queueMissing > 0
          ? `${input.policy.queueMissing} required grant(s) need a decision.`
          : "Required tool/context grants have policy decisions."
  });
  checks.push({
    kind: "stale",
    label: "Stale Workers",
    state: input.staleRunning > 0 ? "attention" : "ready",
    detail: input.staleRunning > 0 ? `${input.staleRunning} worker(s) look stale.` : "No stale workers reported."
  });
  return checks;
}

function launchCheckRowHtml(check) {
  const klass = check.state === "ready" ? "green" : check.state === "blocked" ? "red" : "amber";
  return `
    <div class="launch-check-row ${klass}">
      <div>
        <strong>${esc(check.label)}</strong>
        <div class="muted">${esc(check.detail)}</div>
      </div>
      <span class="pill ${klass}">${esc(check.state)}</span>
    </div>
  `;
}

function parallelWorkPreviewPanelHtml() {
  const preview = parallelWorkPreview();
  return `
    <div class="panel">
      <div class="section-head">
        <h2>Parallel Work Preview</h2>
        <span class="pill ${preview.safe.length ? "green" : "amber"}">${preview.safe.length} safe lane(s)</span>
      </div>
      <div class="grid metrics parallel-metrics">
        ${metric("Parallel Safe", preview.safe.length, "ready now")}
        ${metric("Serial / Risk", preview.serial.length, "ready but caution")}
        ${metric("Blocked", preview.blocked.length, "not ready")}
        ${metric("File Overlap", preview.overlapScopes.length, "scope(s)")}
      </div>
      <div class="parallel-preview-grid">
        ${parallelPreviewColumnHtml("Safe To Launch", preview.safe, "green")}
        ${parallelPreviewColumnHtml("Needs Serial Review", preview.serial, "amber")}
        ${parallelOverlapColumnHtml(preview.overlapScopes)}
      </div>
      <div class="row-actions parallel-actions">
        <button data-launch-plan-preview type="button">Plan Launch</button>
        <button data-action-tab="matrix" type="button">Open Matrix</button>
        <button class="primary" data-action-claim-ready type="button" ${preview.safe.length ? "" : "disabled"}>Claim Ready Slots</button>
      </div>
    </div>
  `;
}

function parallelWorkPreview() {
  const matrixEntries = state.matrix?.tasks || [];
  const boardReady = state.dashboard?.queueBoard?.ready || [];
  const readyIds = new Set(boardReady.map((entry) => (entry.task || entry).queueTaskId).filter(Boolean));
  const overlapScopes = (state.matrix?.fileScopes || []).filter((scope) => scope.overlap).slice(0, 8);
  const overlapTaskIds = new Set(
    overlapScopes.flatMap((scope) => (scope.tasks || []).map((task) => task.queueTaskId).filter(Boolean))
  );
  const byId = new Map();
  for (const entry of matrixEntries) {
    const task = entry.task || entry;
    if (task?.queueTaskId) byId.set(task.queueTaskId, { task, entry });
  }
  for (const taskOrEntry of boardReady) {
    const task = taskOrEntry.task || taskOrEntry;
    if (task?.queueTaskId && !byId.has(task.queueTaskId)) {
      byId.set(task.queueTaskId, { task, entry: { task, readiness: { readyNow: true } } });
    }
  }
  const safe = [];
  const serial = [];
  const blocked = [];
  for (const { task, entry } of byId.values()) {
    if (!isOpenTaskStatus(task.status)) continue;
    const ready = Boolean(entry.readiness?.readyNow || readyIds.has(task.queueTaskId));
    const reasons = [];
    if (task.parallelSafe === false) reasons.push("parallelSafe=false");
    if (["high", "breakglass"].includes(task.risk)) reasons.push(`${task.risk} risk`);
    if (overlapTaskIds.has(task.queueTaskId)) reasons.push("file overlap");
    if (!ready) {
      blocked.push({ task, reasons: entry.readiness?.reasons || ["dependencies, policy, or start gate not ready"] });
      continue;
    }
    if (reasons.length) serial.push({ task, reasons });
    else safe.push({ task, reasons: ["ready now"] });
  }
  return { safe, serial, blocked, overlapScopes };
}

function parallelPreviewColumnHtml(title, entries, color) {
  return `
    <div class="parallel-column">
      <div class="section-head"><h2>${esc(title)}</h2><span class="pill ${color}">${entries.length}</span></div>
      ${entries.length ? entries.slice(0, 6).map(parallelTaskRowHtml).join("") : emptyLine("None")}
    </div>
  `;
}

function parallelTaskRowHtml(entry = {}) {
  const task = entry.task || {};
  const reasons = entry.reasons || [];
  return `
    <button class="parallel-task-row" data-task-id="${esc(task.queueTaskId || "")}" type="button">
      <div>
        <strong>${esc(task.title || task.queueTaskId || "Task")}</strong>
        <div class="muted">${esc(task.phase || "unphased")} - ${esc(task.category || "implementation")}</div>
      </div>
      <div class="listline">
        <span class="pill ${riskClass(task.risk)}">${esc(task.risk || "risk")}</span>
        <span class="pill">${esc(task.priority || "normal")}</span>
        ${reasons.slice(0, 2).map((reason) => `<span class="pill amber">${esc(reason)}</span>`).join("")}
      </div>
    </button>
  `;
}

function parallelOverlapColumnHtml(scopes) {
  return `
    <div class="parallel-column">
      <div class="section-head"><h2>File Overlap</h2><span class="pill ${scopes.length ? "amber" : "green"}">${scopes.length}</span></div>
      ${
        scopes.length
          ? scopes
              .slice(0, 6)
              .map(
                (scope) => `
                  <div class="parallel-file-row">
                    <strong class="truncate">${esc(scope.path || "")}</strong>
                    <div class="muted">${num(scope.openTaskCount)} open task(s)</div>
                  </div>
                `
              )
              .join("")
          : emptyLine("No overlapping open file scopes.")
      }
    </div>
  `;
}

function isOpenTaskStatus(status) {
  return !["completed", "accepted", "done", "canceled", "failed"].includes(String(status || ""));
}

function actionInboxPanelHtml() {
  const inbox = state.actionInbox || {};
  const items = Array.isArray(inbox.items) ? inbox.items : [];
  const counts = inbox.counts || {};
  const top = inbox.topAction || items[0] || {};
  return `
    <div class="panel">
      <div class="section-head">
        <h2>Action Inbox</h2>
        <span class="pill ${actionSeverityClass(top.severity)}">${items.length ? esc(top.title || "next action") : "clear"}</span>
      </div>
      <div class="listline">
        <span class="pill red">warnings ${num(counts.warning)}</span>
        <span class="pill amber">attention ${num(counts.attention)}</span>
        <span class="pill blue">info ${num(counts.info)}</span>
      </div>
      <div class="action-list">
        ${items.length ? items.map(actionInboxItemHtml).join("") : emptyLine("No immediate human action needed for this queue.")}
      </div>
    </div>
  `;
}

function actionInboxItemHtml(item = {}) {
  const taskIds = Array.isArray(item.taskIds) ? item.taskIds.filter(Boolean) : [];
  const action = actionInboxActionHtml(item);
  return `
    <div class="action-item ${actionSeverityClass(item.severity)}">
      <div class="action-main">
        <div>
          <strong>${esc(item.title || item.kind || "Action")}</strong>
          <div class="muted">${esc(item.detail || "")}</div>
          ${taskIds.length ? `<div class="listline">${taskIds.slice(0, 5).map((id) => `<span class="pill">${esc(id)}</span>`).join("")}</div>` : ""}
        </div>
        <div class="row-actions">${action}</div>
      </div>
    </div>
  `;
}

function actionInboxActionHtml(item = {}) {
  if (item.kind === "claim_ready_work") {
    return `<button class="primary" data-action-claim-ready type="button">Claim Ready</button>`;
  }
  if (item.kind === "stale_workers") {
    return `<button class="danger" data-action-recover-stale type="button">${esc(item.actionLabel || "Recover")}</button>`;
  }
  if (item.kind === "start_gate") {
    return `<button class="primary" data-action-queue-decision="start_execution" type="button">Start Execution</button>`;
  }
  if (item.queueTaskId) {
    return `<button data-action-task="${esc(item.queueTaskId)}" type="button">${esc(item.actionLabel || "Open Task")}</button>`;
  }
  if (item.tab && VALID_TABS.has(item.tab)) {
    return `<button data-action-tab="${esc(item.tab)}" type="button">${esc(item.actionLabel || "Open")}</button>`;
  }
  return "";
}

function recoveryCenterPanelHtml() {
  const data = recoveryCenterData();
  const severity = data.staleWorkers || data.failed.length ? "red" : data.tasks.length ? "amber" : "green";
  return `
    <div class="panel recovery-center-panel">
      <div class="section-head">
        <h2>Recovery Center</h2>
        <span class="pill ${severity}">${data.attentionCount ? `${data.attentionCount} attention` : "clear"}</span>
      </div>
      <div class="grid metrics recovery-metrics">
        ${metric("Stale Workers", data.staleWorkers, "recoverable")}
        ${metric("Failed", data.failed.length, "retryable")}
        ${metric("Blocked", data.blocked.length, "needs unblock")}
        ${metric("Interrupted", data.interrupted.length, "resume check")}
      </div>
      <div class="recovery-list">
        ${data.staleWorkers ? recoveryStaleCardHtml(data) : ""}
        ${data.tasks.length ? data.tasks.slice(0, 8).map(recoveryTaskCardHtml).join("") : emptyLine("No failed, interrupted, stale, or blocked work needs recovery.")}
      </div>
      <pre class="resume-box recovery-brief-preview">${esc(recoveryBriefText({ preview: true }))}</pre>
      <div class="row-actions recovery-actions">
        <button class="primary" data-recovery-copy type="button">Copy Recovery Brief</button>
        <button data-action-tab="activity" type="button">Open Activity</button>
        <button data-action-tab="matrix" type="button">Open Matrix</button>
        <button class="danger" data-recovery-recover-stale type="button" ${data.staleWorkers ? "" : "disabled"}>Recover Stale</button>
      </div>
    </div>
  `;
}

function recoveryCenterData() {
  const dashboard = state.dashboard || {};
  const summary = dashboard.summaryStrip || {};
  const counts = summary.counts || {};
  const board = dashboard.queueBoard || {};
  const matrixEntries = state.matrix?.tasks || [];
  const lanes = state.lanes?.lanes || [];
  const byId = new Map();

  const addTask = (task = {}, source, reasons = []) => {
    if (!task?.queueTaskId) return;
    const existing = byId.get(task.queueTaskId) || { task: {}, sources: new Set(), reasons: [] };
    existing.task = { ...existing.task, ...task };
    existing.sources.add(source);
    existing.reasons.push(...reasons.filter(Boolean));
    byId.set(task.queueTaskId, existing);
  };

  for (const entry of board.blocked || []) {
    addTask(entry.task || entry, "blocked board", entry.reasons || []);
  }
  for (const entry of matrixEntries) {
    const task = entry.task || entry;
    const status = String(task.status || "").toLowerCase();
    const readiness = entry.readiness || {};
    const reasons = readiness.reasons || [];
    if (isRecoveryStatus(status) || readiness.state === "blocked" || (!readiness.readyNow && reasons.length)) {
      addTask(task, "readiness matrix", reasons);
    }
  }
  for (const lane of lanes) {
    const task = lane.queueTask || {};
    const run = lane.workerRun || {};
    const status = String(run.status || task.status || "").toLowerCase();
    if (isRecoveryStatus(status)) {
      addTask(task, `worker ${run.status || "issue"}`, [lane.progress?.summary || lane.latestEvent?.body || run.status || task.status]);
    }
  }

  const tasks = [...byId.values()]
    .map((entry) => ({
      ...entry,
      sources: [...entry.sources],
      reasons: uniqueStrings(entry.reasons).slice(0, 4)
    }))
    .sort((left, right) => recoveryRank(left.task) - recoveryRank(right.task) || String(left.task.title || left.task.queueTaskId).localeCompare(String(right.task.title || right.task.queueTaskId)));
  const failed = tasks.filter((entry) => ["failed", "rejected"].includes(String(entry.task.status || "").toLowerCase()));
  const blocked = tasks.filter((entry) => String(entry.task.status || "").toLowerCase() === "blocked" || entry.sources.includes("blocked board"));
  const interrupted = tasks.filter((entry) => isInterruptedStatus(entry.task.status));
  return {
    tasks,
    failed,
    blocked,
    interrupted,
    staleWorkers: num(counts.staleRunning),
    attentionCount: tasks.length + num(counts.staleRunning)
  };
}

function isRecoveryStatus(status) {
  const normalized = String(status || "").toLowerCase();
  return ["failed", "rejected", "blocked", "canceled", "cancelled", "interrupted", "stale"].includes(normalized);
}

function isInterruptedStatus(status) {
  const normalized = String(status || "").toLowerCase();
  return ["canceled", "cancelled", "interrupted", "stale"].includes(normalized);
}

function recoveryRank(task = {}) {
  const status = String(task.status || "").toLowerCase();
  if (status === "failed" || status === "rejected") return 0;
  if (isInterruptedStatus(status)) return 1;
  if (status === "blocked") return 2;
  return 3;
}

function recoveryStaleCardHtml(data) {
  return `
    <div class="recovery-card red">
      <div>
        <strong>${data.staleWorkers} stale worker(s)</strong>
        <div class="muted">Use dry-run recovery first unless you already know the runs are abandoned.</div>
      </div>
      <div class="row-actions">
        <button class="danger" data-recovery-recover-stale type="button">Recover Stale</button>
      </div>
    </div>
  `;
}

function recoveryTaskCardHtml(entry = {}) {
  const task = entry.task || {};
  const status = String(task.status || "unknown").toLowerCase();
  const retryable = ["failed", "rejected", "blocked", "canceled", "cancelled", "interrupted"].includes(status);
  const klass = status === "failed" || status === "rejected" ? "red" : "amber";
  return `
    <div class="recovery-card ${klass}">
      <div class="recovery-card-main">
        <div>
          <strong>${esc(task.title || task.queueTaskId || "Task")}</strong>
          <div class="muted">${esc(task.summary || task.goal || entry.reasons[0] || "")}</div>
          <div class="listline">
            <span class="pill ${statusClass(task.status)}">${esc(task.status || "unknown")}</span>
            <span class="pill ${riskClass(task.risk)}">${esc(task.risk || "risk")}</span>
            <span class="pill">${esc(task.priority || "normal")}</span>
          </div>
          ${entry.reasons.length ? `<div class="muted">${esc(entry.reasons.join("; "))}</div>` : ""}
        </div>
        <div class="row-actions">
          <button data-recovery-task="${esc(task.queueTaskId || "")}" type="button">Open Task</button>
          <button class="danger" data-recovery-retry="${esc(task.queueTaskId || "")}" type="button" ${retryable ? "" : "disabled"}>Retry</button>
        </div>
      </div>
    </div>
  `;
}

function recoveryBriefText(options = {}) {
  const data = recoveryCenterData();
  const queue = state.dashboard?.queue || state.matrix?.queue || {};
  const tasks = data.tasks.slice(0, options.preview ? 5 : 16);
  const lines = [
    "# Agent Fabric Console Recovery Brief",
    "",
    `Queue: ${queue.title || queue.queueId || state.selectedQueueId || "selected queue"}`,
    `Project: ${queue.projectPath || selectedProjectPath() || "project path unavailable"}`,
    `Stale workers: ${data.staleWorkers}`,
    `Failed: ${data.failed.length}`,
    `Blocked: ${data.blocked.length}`,
    `Interrupted: ${data.interrupted.length}`,
    ""
  ];
  if (tasks.length) {
    lines.push("Recovery candidates:");
    for (const entry of tasks) {
      const task = entry.task || {};
      const reasons = entry.reasons.length ? ` - ${entry.reasons.join("; ")}` : "";
      lines.push(`- ${task.title || task.queueTaskId} (${task.queueTaskId}, ${task.status || "unknown"})${reasons}`);
    }
    lines.push("");
  } else {
    lines.push("No failed, blocked, stale, or interrupted queue tasks are currently reported.", "");
  }
  if (options.preview && data.tasks.length > tasks.length) {
    lines.push("Copy the full brief to include all recovery candidates.");
  }
  return lines.join("\n").trim();
}

async function copyRecoveryBrief() {
  await copyText(recoveryBriefText());
  toast("Recovery brief copied.");
}

async function retryRecoveryTask(queueTaskId) {
  if (!state.selectedQueueId || !queueTaskId) return;
  await callTool("project_queue_retry_task", {
    queueId: state.selectedQueueId,
    queueTaskId,
    reason: "Retry requested from Agent Fabric Console recovery center.",
    clearOutputs: false
  });
  toast("Recovery task returned to queued for retry.");
  await loadSelectedQueue({ quiet: true });
  if (state.selectedTaskId === queueTaskId) await loadTaskDetail(queueTaskId, { quiet: true });
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function patchReviewPanelHtml() {
  const tasks = patchReviewTasks();
  const patchRefs = tasks.reduce((total, task) => total + (task.patchRefs?.length || 0), 0);
  const testRefs = tasks.reduce((total, task) => total + (task.testRefs?.length || 0), 0);
  return `
    <div class="panel">
      <div class="section-head">
        <h2>Patch Review</h2>
        <span class="pill ${tasks.length ? "amber" : "green"}">${tasks.length ? `${tasks.length} ready` : "clear"}</span>
      </div>
      <div class="grid metrics review-metrics">
        ${metric("Review Tasks", tasks.length, "patch-ready")}
        ${metric("Patch Refs", patchRefs, "outputs")}
        ${metric("Test Refs", testRefs, "evidence")}
      </div>
      <div class="review-list">
        ${tasks.length ? tasks.map(patchReviewTaskHtml).join("") : emptyLine("No patch-ready tasks are waiting for review.")}
      </div>
    </div>
  `;
}

function patchReviewTasks() {
  const byId = new Map();
  const boardReview = state.dashboard?.queueBoard?.review || [];
  const matrixEntries = state.matrix?.tasks || [];
  const candidates = [
    ...boardReview.map((entry) => entry.task || entry),
    ...matrixEntries.map((entry) => entry.task || entry)
  ];
  for (const task of candidates) {
    if (!task?.queueTaskId || !isPatchReviewStatus(task.status)) continue;
    byId.set(task.queueTaskId, { ...(byId.get(task.queueTaskId) || {}), ...task });
  }
  return [...byId.values()].sort((left, right) => {
    const priority = { urgent: 0, high: 1, normal: 2, low: 3 };
    return (priority[left.priority] ?? 4) - (priority[right.priority] ?? 4) || String(left.title || left.queueTaskId).localeCompare(String(right.title || right.queueTaskId));
  });
}

function isPatchReviewStatus(status) {
  return ["patch_ready", "review"].includes(String(status || ""));
}

function patchReviewTaskHtml(task = {}) {
  const patches = Array.isArray(task.patchRefs) ? task.patchRefs : [];
  const tests = Array.isArray(task.testRefs) ? task.testRefs : [];
  const acceptBusy = isActionPending(`review-accept:${task.queueTaskId || ""}`);
  const retryBusy = isActionPending(`review-retry:${task.queueTaskId || ""}`);
  return `
    <div class="review-card">
      <div class="review-card-main">
        <div>
          <strong>${esc(task.title || task.queueTaskId || "Task")}</strong>
          <div class="muted">${esc(task.summary || task.goal || "")}</div>
          <div class="listline">
            <span class="pill ${statusClass(task.status)}">${esc(task.status || "review")}</span>
            <span class="pill ${riskClass(task.risk)}">${esc(task.risk || "risk")}</span>
            <span class="pill">${esc(task.priority || "normal")}</span>
          </div>
        </div>
        <div class="row-actions">
          <button data-review-task="${esc(task.queueTaskId || "")}" type="button">Open Task</button>
          <button class="primary" data-review-accept="${esc(task.queueTaskId || "")}" type="button" ${acceptBusy ? "disabled" : ""}>${acceptBusy ? "Accepting..." : "Accept"}</button>
          <button class="danger" data-review-retry="${esc(task.queueTaskId || "")}" type="button" ${retryBusy ? "disabled" : ""}>${retryBusy ? "Retrying..." : "Retry"}</button>
        </div>
      </div>
      <div class="review-evidence">
        <div>${reviewEvidenceHtml("Patches", patches)}</div>
        <div>${reviewEvidenceHtml("Tests", tests)}</div>
      </div>
    </div>
  `;
}

function reviewEvidenceHtml(title, values) {
  const items = Array.isArray(values) ? values.filter(Boolean).slice(0, 4) : [];
  return `<h3>${esc(title)}</h3>${items.length ? items.map((item) => `<div class="muted truncate">${esc(String(item))}</div>`).join("") : `<div class="muted">None recorded</div>`}`;
}

function boardColumn(title, tasks) {
  return `<div class="column"><div class="section-head"><h2>${esc(title)}</h2><span class="pill">${tasks.length}</span></div>${tasks.map(taskHtml).join("") || emptyLine("None")}</div>`;
}

function launchPlanHtml() {
  const plan = state.launchPlan;
  if (!plan || plan.queueId !== state.selectedQueueId) {
    return `
      <div class="section-head">
        <h2>Launch Plan</h2>
        <span class="pill">not loaded</span>
      </div>
      ${emptyLine("Run Plan Launch to preview launchable, approval-blocked, start-gated, and scheduler-blocked work.")}
    `;
  }
  const summary = plan.summary || {};
  return `
    <div class="section-head">
      <h2>Launch Plan</h2>
      <span class="pill ${plan.workerStartBlocked ? "amber" : "green"}">${plan.workerStartBlocked ? "start gate" : "ready"}</span>
    </div>
    <div class="listline">
      <span class="pill green">launchable ${num(summary.launchable)}</span>
      <span class="pill amber">approvals ${num(summary.approvalRequired)}</span>
      <span class="pill amber">waiting ${num(summary.waitingForStart)}</span>
      <span class="pill">scheduled ${num(summary.scheduled)}</span>
      <span class="pill">slots ${num(plan.availableSlots)}</span>
    </div>
      <div class="row-actions launch-actions">
        <button id="load-ready-packet-links" type="button">Ready Packet Links</button>
        <button data-copy-worker-brief type="button">Copy Worker Brief</button>
        <button id="copy-all-ready-packet-links" type="button">Copy All Links</button>
      </div>
    ${readyPacketLinksHtml()}
    ${plan.workerStartBlockedReason ? `<div class="activity-item"><strong>Start gate</strong><div>${esc(plan.workerStartBlockedReason)}</div></div>` : ""}
    <div class="grid detail-grid launch-plan-groups">
      ${launchPlanGroupHtml("Launchable", plan.launchable || [])}
      ${launchPlanGroupHtml("Approval Required", plan.approvalRequired || [])}
      ${launchPlanGroupHtml("Waiting For Start", plan.waitingForStart || [])}
      ${launchPlanGroupHtml("Blocked", plan.blocked || [])}
    </div>
  `;
}

function readyPacketLinksHtml() {
  const links = state.readyPacketLinks;
  if (!links || links.queueId !== state.selectedQueueId) {
    return `<div class="muted launch-help">Load ready packet links after previewing the launch plan to copy worker handoff URLs for the currently launchable tasks.</div>`;
  }
  const entries = links.links || [];
  const defaults = links.workerDefaults || {};
  return `
    <div class="ready-packet-list">
      <div class="section-head">
        <h2>Ready Packet Links</h2>
        <span class="pill ${entries.length ? "green" : "amber"}">${entries.length}</span>
      </div>
      <div class="muted">${esc(defaults.preferredWorker || "worker")} - ${esc(defaults.workspaceMode || "workspace")} - ${esc(defaults.modelProfile || "model")}</div>
      ${readyWorkerBriefHtml(entries, defaults)}
      ${
        entries.length
          ? entries
              .map(
                (entry) => `
                  <div class="ready-packet-row">
                    <div>
                      <strong>${esc(entry.title || entry.queueTaskId || "Task")}</strong>
                      <div class="muted">${esc(entry.queueTaskId || "")}</div>
                    </div>
                    <div class="row-actions">
                      <button data-ready-packet-task="${esc(entry.queueTaskId || "")}" type="button">Open Task</button>
                      <button data-ready-packet-link="${esc(entry.packetApiPath || entry.packetUrl || "")}" type="button">Copy Link</button>
                    </div>
                  </div>
                `
              )
              .join("")
          : emptyLine("No launchable packet links under the current start gate, approval, and concurrency constraints.")
      }
    </div>
  `;
}

function readyWorkerBriefHtml(entries, defaults) {
  if (!entries.length) return "";
  return `
    <div class="worker-brief">
      <div class="section-head">
        <h2>Worker Handoff Brief</h2>
        <span class="pill green">${entries.length} packet(s)</span>
      </div>
      <div class="grid metrics worker-brief-metrics">
        ${metric("Worker", defaults.preferredWorker || "worker", defaults.workspaceMode || "workspace")}
        ${metric("Model", defaults.modelProfile || "model", "default route")}
        ${metric("Tasks", entries.length, "launchable")}
      </div>
      <pre class="resume-box worker-brief-preview">${esc(readyWorkerBriefText({ limit: 4 }))}</pre>
      <div class="row-actions">
        <button class="primary" data-copy-worker-brief type="button">Copy Worker Brief</button>
        <button data-copy-all-ready-packet-links type="button">Copy Packet Links</button>
      </div>
    </div>
  `;
}

function readyWorkerBriefText(options = {}) {
  const links = state.readyPacketLinks?.links || [];
  const defaults = state.readyPacketLinks?.workerDefaults || {};
  const queue = state.dashboard?.queue || state.matrix?.queue || {};
  const limit = Number.isInteger(options.limit) ? options.limit : links.length;
  const visible = links.slice(0, limit);
  const hidden = Math.max(0, links.length - visible.length);
  const lines = [
    "# Ready Worker Handoff",
    "",
    `Queue: ${queue.title || queue.queueId || state.selectedQueueId || "selected queue"}`,
    `Project: ${queue.projectPath || selectedProjectPath() || "project path unavailable"}`,
    `Worker: ${defaults.preferredWorker || state.claimDefaults.worker || SENIOR_CLAIM_DEFAULTS.worker}`,
    `Workspace mode: ${defaults.workspaceMode || state.claimDefaults.workspaceMode || SENIOR_CLAIM_DEFAULTS.workspaceMode}`,
    `Model profile: ${defaults.modelProfile || state.claimDefaults.modelProfile || SENIOR_CLAIM_DEFAULTS.modelProfile}`,
    "",
    "Use each packet URL as the durable task handoff. The packet includes readiness, dependencies, required context, resume state, and worker instructions.",
    "",
    ...visible.flatMap((entry, index) => [
      `${index + 1}. ${entry.title || entry.queueTaskId || "Task"}`,
      `   Task: ${entry.queueTaskId || ""}`,
      `   Packet: ${packetLinkHref(entry)}`
    ])
  ];
  if (hidden) lines.push("", `... ${hidden} more packet(s) not shown in preview. Copy the full brief for all links.`);
  return lines.join("\n");
}

function claimWorkerResultHtml(result) {
  if (!result) return "";
  if (result.batch) {
    const started = result.started || [];
    const skipped = result.skipped || [];
    return `
      <div class="activity-item">
        <div class="section-head">
          <h2>Batch Claim</h2>
          <span class="pill ${started.length ? "green" : "amber"}">${started.length}/${num(result.requested)} claimed</span>
        </div>
        <div class="claim-batch-list">
          ${started.length ? started.map((entry) => claimBatchStartedHtml(entry)).join("") : emptyLine("No workers claimed.")}
          ${skipped.length ? skipped.map(claimBatchSkippedHtml).join("") : ""}
        </div>
      </div>
    `;
  }
  if (result.approvalRequired) {
    const proposal = result.toolContextProposal || {};
    const proposalId = proposal.proposalId || "";
    const missing = proposal.missingGrants || [];
    return `
      <div class="activity-item">
        <div class="section-head">
          <h2>Approval required</h2>
          <span class="pill amber">tool/context</span>
        </div>
        <div class="muted">${esc(proposalId)}</div>
        <div>Approve the proposed tool/context bundle before claiming this worker.</div>
        ${missing.length ? `<div class="listline">${missing.map((grant) => `<span class="pill amber">${esc(grant.grantKey || grant.kind || "")}</span>`).join("")}</div>` : ""}
        ${claimApprovalActionsHtml(proposalId, true)}
      </div>
    `;
  }
  if (result.approvalDecision) {
    const approved = result.approvalDecision === "approve";
    return `
      <div class="activity-item">
        <div class="section-head">
          <h2>Tool/context ${esc(result.approvalDecision)}</h2>
          <span class="pill ${approved ? "green" : "red"}">${approved ? "approved" : "rejected"}</span>
        </div>
        <div class="muted">${esc(result.approvalProposalId || "")}</div>
        <div>${approved ? "Run Claim Next Worker again to reserve the approved task." : "The skipped task will remain blocked until its tool/context needs change or a new proposal is approved."}</div>
      </div>
    `;
  }
  if (result.executionBlocked) {
    return `<div class="activity-item"><strong>Execution blocked</strong><div>${esc(result.blockedReason || "Start the queue before claiming workers.")}</div></div>`;
  }
  if (result.claimed) {
    const run = result.workerRun || {};
    const command = Array.isArray(run.command) ? run.command : [];
    return `
      <div class="activity-item">
        <div class="section-head">
          <h2>${esc(result.claimed.title || result.claimed.queueTaskId || "Claimed task")}</h2>
          <span class="pill green">claimed</span>
        </div>
        <div class="kv">
          <div>Task</div><div>${esc(result.claimed.queueTaskId || "")}</div>
          <div>Fabric task</div><div>${esc(result.claimed.fabricTaskId || "")}</div>
          <div>Worker run</div><div>${esc(run.workerRunId || "claimed without worker run")}</div>
          <div>Workspace</div><div>${esc(run.workspacePath || "")}</div>
        </div>
        ${command.length ? `<pre class="resume-box">${esc(command.join(" "))}</pre>` : ""}
        <div class="row-actions">
          <button data-task-id="${esc(result.claimed.queueTaskId || "")}" type="button">Open Task</button>
        </div>
      </div>
    `;
  }
  return `<div class="activity-item"><strong>No task claimed</strong><div class="muted">No schedulable task is available.</div></div>`;
}

function claimBatchStartedHtml(entry = {}) {
  const task = entry.claimed || {};
  const run = entry.workerRun || {};
  return `
    <div class="claim-batch-row">
      <div>
        <strong>${esc(task.title || task.queueTaskId || "Task")}</strong>
        <div class="muted">${esc(task.queueTaskId || "")} - ${esc(run.workerRunId || "")}</div>
      </div>
      <div class="row-actions">
        <button data-task-id="${esc(task.queueTaskId || "")}" type="button">Open</button>
      </div>
    </div>
  `;
}

function claimBatchSkippedHtml(entry = {}) {
  const proposalId = entry.proposalId || "";
  const decided = entry.decision === "approve" || entry.decision === "reject";
  const decisionClass = entry.decision === "approve" ? "green" : entry.decision === "reject" ? "red" : "amber";
  return `
    <div class="claim-batch-row skipped">
      <div>
        <strong>${esc(entry.queueTaskId || "Skipped")}</strong>
        <div class="muted">${esc(entry.reason || "")}${entry.proposalId ? ` - ${esc(entry.proposalId)}` : ""}</div>
        ${entry.missingGrants?.length ? `<div class="listline">${entry.missingGrants.map((grant) => `<span class="pill amber">${esc(grant.grantKey || grant.kind || "")}</span>`).join("")}</div>` : ""}
      </div>
      <div class="claim-batch-side">
        <span class="pill ${decisionClass}">${decided ? esc(entry.decision) : entry.executionBlocked ? "blocked" : "approval"}</span>
        ${proposalId && !decided ? claimApprovalActionsHtml(proposalId, true) : ""}
      </div>
    </div>
  `;
}

function claimApprovalActionsHtml(proposalId, retry) {
  if (!proposalId) {
    return `<div class="row-actions"><button data-open-approvals type="button">Open Approvals</button></div>`;
  }
  return `
    <div class="row-actions">
      <button class="primary" data-claim-tool-approval data-proposal-id="${esc(proposalId)}" data-decision="approve" data-retry="${retry ? "1" : "0"}" type="button">Approve${retry ? " + Retry" : ""}</button>
      <button data-open-approvals type="button">Open Approvals</button>
      <button class="danger" data-claim-tool-approval data-proposal-id="${esc(proposalId)}" data-decision="reject" type="button">Reject</button>
    </div>
  `;
}

function launchPlanGroupHtml(title, entries) {
  return `
    <div class="detail-panel">
      <div class="section-head"><h2>${esc(title)}</h2><span class="pill">${entries.length}</span></div>
      ${entries.length ? entries.map(launchPlanEntryHtml).join("") : emptyLine("None")}
    </div>
  `;
}

function launchPlanEntryHtml(entry = {}) {
  const task = entry.task || entry;
  const reasons = entry.reasons || [];
  const missing = entry.missingGrants || [];
  const blocked = entry.launchBlockedReason || reasons.join("; ");
  const readiness = entry.readyToLaunch ? "launchable" : entry.approvalRequired ? "approval" : entry.workerStartBlocked ? "waiting" : entry.needsProposal ? "proposal" : task.status || "blocked";
  return `
    <button class="task task-button" type="button" data-task-id="${esc(task.queueTaskId || "")}">
      <div class="task-title">${esc(task.title || task.queueTaskId || "Task")}</div>
      <div class="listline">
        <span class="pill ${statusClass(readiness)}">${esc(readiness)}</span>
        <span class="pill ${riskClass(task.risk)}">${esc(task.risk || "risk")}</span>
        <span class="pill">${esc(task.priority || "normal")}</span>
      </div>
      ${blocked ? `<div class="muted">${esc(blocked)}</div>` : ""}
      ${missing.length ? `<div class="listline">${missing.slice(0, 4).map((grant) => `<span class="pill amber">${esc(grant.grantKey || grant.kind || "")}</span>`).join("")}</div>` : ""}
    </button>
  `;
}

function blockedColumn(title, entries) {
  return `<div class="column"><div class="section-head"><h2>${esc(title)}</h2><span class="pill">${entries.length}</span></div>${entries.map((entry) => taskHtml(entry.task, entry.reasons)).join("") || emptyLine("None")}</div>`;
}

function taskHtml(task = {}, reasons = []) {
  const tag = task.queueTaskId ? "button" : "div";
  const taskAttr = task.queueTaskId ? ` type="button" data-task-id="${esc(task.queueTaskId)}"` : "";
  return `
    <${tag} class="task task-button${task.queueTaskId === state.selectedTaskId ? " active" : ""}"${taskAttr}>
      <div class="task-title">${esc(task.title || task.queueTaskId || "Task")}</div>
      <div class="listline">
        <span class="pill ${riskClass(task.risk)}">${esc(task.risk || "risk")}</span>
        <span class="pill">${esc(task.priority || "normal")}</span>
        <span class="pill">${esc(task.status || "unknown")}</span>
      </div>
      ${reasons.length ? `<div class="muted">${esc(reasons.join("; "))}</div>` : ""}
    </${tag}>
  `;
}

async function loadTaskDetail(queueTaskId, options = {}) {
  if (!state.selectedQueueId || !queueTaskId) return;
  state.selectedTaskId = queueTaskId;
  const detail = await apiGet(
    `/api/queues/${encodeURIComponent(state.selectedQueueId)}/tasks/${encodeURIComponent(queueTaskId)}?includeResume=1&maxEventsPerRun=5`
  );
  state.taskDetail = detail;
  persistDesktopPreferences();
  renderDashboard();
  if (!options.quiet) toast("Task detail loaded.");
}

function renderTaskDetail() {
  const root = $("#task-detail-card");
  if (!root) return;
  const detail = state.taskDetail;
  if (!detail) {
    root.innerHTML = `<div class="panel"><div class="section-head"><h2>Task Detail</h2></div>${emptyLine("Select a task card to inspect readiness, dependencies, checkpoints, and resume context.")}</div>`;
    return;
  }
  const task = detail.task || {};
  const readiness = detail.readiness || {};
  const graph = detail.graph || {};
  root.innerHTML = `
    <div class="panel">
      <div class="section-head">
        <h2>Task Detail</h2>
        <span class="pill ${statusClass(task.status)}">${esc(task.status || "unknown")}</span>
      </div>
      <div class="task-detail-head">
        <div>
          <h3>${esc(task.title || task.queueTaskId || "Task")}</h3>
          <div class="muted">${esc(task.goal || "")}</div>
        </div>
        <div class="listline">
          <span class="pill ${riskClass(task.risk)}">${esc(task.risk || "risk")}</span>
          <span class="pill">${esc(task.priority || "normal")}</span>
          <span class="pill">${readiness.readyNow ? "ready" : esc(readiness.state || "not ready")}</span>
        </div>
      </div>
      <div class="row-actions task-detail-actions">
        <button class="primary" id="propose-task-context" type="button">Propose Tool/Context</button>
        <button id="route-task-model" type="button">Route Model</button>
        <button id="generate-task-packet" type="button">Task Packet</button>
        <button id="copy-task-brief" type="button">Copy Task Brief</button>
        <button id="copy-task-review-brief" type="button">Copy Review Brief</button>
        <button id="copy-task-packet-link" type="button">Copy Packet Link</button>
        <button id="copy-task-link" type="button">Copy Task Link</button>
        <button id="open-task-approvals" type="button">Open Approvals</button>
      </div>
      <div id="task-context-result"></div>
      ${taskBriefPanelHtml(detail)}
      <div class="grid detail-grid">
        ${detailPanel("Acceptance", listItems(task.acceptanceCriteria))}
        ${detailPanel("Dependencies", linkItems(graph.dependencies))}
        ${detailPanel("Dependents", linkItems(graph.dependents))}
        ${detailPanel("Required Context", requiredContextHtml(task))}
        ${detailPanel("Readiness", readinessHtml(readiness))}
        ${detailPanel("Worker Runs", workerRunsHtml(detail.workerRuns || []))}
        ${detailPanel("Approvals", approvalsHtml(detail))}
        ${detailPanel("Resume", resumeHtml(detail.resume))}
      </div>
      <form id="task-metadata-form" class="metadata-form">
        <div class="section-head">
          <h2>Edit Metadata</h2>
          <span class="pill">queue review</span>
        </div>
        <textarea id="task-metadata-json" rows="12">${esc(JSON.stringify(taskMetadataPatch(task), null, 2))}</textarea>
        <div class="row-actions">
          <button class="primary" type="submit">Save Task Metadata</button>
        </div>
      </form>
      <form id="task-outcome-form" class="metadata-form">
        <div class="section-head">
          <h2>Task Outcome</h2>
          <span class="pill">review loop</span>
        </div>
        <div class="form-grid outcome-grid">
          <label>
            <span>Status</span>
            <select id="task-outcome-status">
              ${["review", "patch_ready", "completed", "failed", "blocked", "queued", "canceled", "accepted", "done"].map((status) => `<option value="${status}"${task.status === status ? " selected" : ""}>${status}</option>`).join("")}
            </select>
          </label>
          <label>
            <span>Summary</span>
            <input id="task-outcome-summary" type="text" value="${esc(task.summary || "")}" placeholder="What changed or what is needed next" />
          </label>
        </div>
        <div class="form-grid two">
          <label>
            <span>Patch refs</span>
            <textarea id="task-outcome-patches" rows="4" placeholder="One patch/file/ref per line">${esc((task.patchRefs || []).join("\n"))}</textarea>
          </label>
          <label>
            <span>Test refs</span>
            <textarea id="task-outcome-tests" rows="4" placeholder="One command/result/ref per line">${esc((task.testRefs || []).join("\n"))}</textarea>
          </label>
        </div>
        <div class="row-actions">
          <button class="primary" type="submit">Save Outcome</button>
          <button id="retry-task" type="button">Retry Task</button>
        </div>
      </form>
    </div>
  `;
  root.querySelectorAll(".link-row[data-task-id]").forEach((button) => {
    button.addEventListener("click", () => loadTaskDetail(button.dataset.taskId));
  });
  root.querySelector("#task-metadata-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveTaskMetadata();
  });
  root.querySelector("#task-outcome-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveTaskOutcome();
  });
  root.querySelector("#retry-task")?.addEventListener("click", () => retrySelectedTask());
  root.querySelector("#propose-task-context")?.addEventListener("click", () => proposeSelectedTaskContext());
  root.querySelector("#route-task-model")?.addEventListener("click", () => routeSelectedTaskModel());
  root.querySelector("#generate-task-packet")?.addEventListener("click", () => generateSelectedTaskPacket());
  root.querySelector("#copy-task-brief")?.addEventListener("click", () => copySelectedTaskBrief("worker"));
  root.querySelector("#copy-task-review-brief")?.addEventListener("click", () => copySelectedTaskBrief("review"));
  root.querySelector("#copy-task-packet-link")?.addEventListener("click", () => copySelectedTaskPacketLink());
  root.querySelector("#copy-task-link")?.addEventListener("click", () => copySelectedTaskLink());
  root.querySelector("#open-task-approvals")?.addEventListener("click", () => selectTab("approvals"));
  root.querySelectorAll("[data-task-brief-copy]").forEach((button) => {
    button.addEventListener("click", () => copySelectedTaskBrief(button.dataset.taskBriefCopy));
  });
  root.querySelectorAll("[data-task-tool-approval]").forEach((button) => {
    button.addEventListener("click", async () => {
      await decideTool(button.dataset.proposalId, button.dataset.decision);
      if (state.selectedTaskId) await loadTaskDetail(state.selectedTaskId, { quiet: true });
    });
  });
  root.querySelectorAll("[data-task-policy-grant]").forEach((button) => {
    button.addEventListener("click", async () => {
      await setTaskPolicyGrant(button.dataset.grantKind, button.dataset.grantValue, button.dataset.status);
    });
  });
  bindMemoryActions(root);
}

function bucketPanel(title, buckets) {
  return `<div class="panel"><div class="section-head"><h2>${esc(title)}</h2></div><div class="listline">${buckets.map((bucket) => `<span class="pill">${esc(bucket.key)} ${num(bucket.count)} / ${num(bucket.openCount)}</span>`).join("") || emptyLine("None")}</div></div>`;
}

function fileScopePanel(scopes) {
  const overlaps = scopes.filter((scope) => scope.overlap).slice(0, 12);
  return `<div class="panel"><div class="section-head"><h2>File Overlap</h2><span class="pill">${overlaps.length}</span></div>${overlaps.map((scope) => rowLine(scope.path, `${scope.openTaskCount || scope.taskCount || 0} tasks`)).join("") || emptyLine("No overlap.")}</div>`;
}

function taskListItemHtml(entry = {}) {
  const task = entry.task || {};
  const readiness = entry.readiness || {};
  return `
    <button class="task task-list-item task-button" type="button" data-task-id="${esc(task.queueTaskId || "")}">
      <div class="task-list-main">
        <div>
          <div class="task-title">${esc(task.title || task.queueTaskId || "Task")}</div>
          <div class="muted">${esc(task.phase || "unphased")} - ${esc(task.category || "implementation")}</div>
        </div>
        <div class="listline">
          <span class="pill ${statusClass(task.status)}">${esc(task.status || "unknown")}</span>
          <span class="pill ${riskClass(task.risk)}">${esc(task.risk || "risk")}</span>
          <span class="pill">${esc(task.priority || "normal")}</span>
          <span class="pill ${readiness.readyNow ? "green" : "amber"}">${readiness.readyNow ? "ready" : esc(readiness.state || "blocked")}</span>
        </div>
      </div>
      <div class="listline task-list-counters">
        <span class="pill">deps ${num(entry.dependencyCount)}</span>
        <span class="pill">dependents ${num(entry.dependentCount)}</span>
        <span class="pill">files ${num(entry.expectedFileCount)}</span>
        <span class="pill">grants ${num(entry.requiredGrantCount)}</span>
      </div>
      ${readiness.reasons?.length ? `<div class="muted">${esc(readiness.reasons.join("; "))}</div>` : ""}
    </button>
  `;
}

function grantPanel(grants) {
  return `
    <div class="panel">
      <div class="section-head"><h2>Tool Context Grants</h2><span class="pill">${grants.length}</span></div>
      ${
        grants.length
          ? grants
              .slice(0, 24)
              .map(
                (grant) => `
                  <div class="grant-row">
                    <div>
                      <strong>${esc(grant.grantKey)}</strong>
                      <div class="muted">${esc(grant.policyStatus || "missing")} - ${num(grant.taskCount)} task(s)</div>
                    </div>
                    <div class="row-actions">
                      <button class="primary" data-policy-grant data-grant-key="${esc(grant.grantKey)}" data-status="approved" type="button">Approve</button>
                      <button class="danger" data-policy-grant data-grant-key="${esc(grant.grantKey)}" data-status="rejected" type="button">Reject</button>
                    </div>
                  </div>
                `
              )
              .join("")
          : emptyLine("No grants.")
      }
    </div>
  `;
}

function taskBriefPanelHtml(detail = {}) {
  const data = taskBriefData(detail);
  return `
    <div class="task-brief-panel">
      <div class="section-head">
        <h2>Task Brief</h2>
        <span class="pill ${data.ready ? "green" : "amber"}">${data.ready ? "ready" : data.readinessState}</span>
      </div>
      <div class="grid metrics task-brief-metrics">
        ${metric("Dependencies", data.dependencies, "upstream")}
        ${metric("Context", data.contextCount, "required refs")}
        ${metric("Approvals", data.approvals, "pending/known")}
        ${metric("Evidence", data.evidence, "patch/test refs")}
      </div>
      <pre class="resume-box task-brief-preview">${esc(taskBriefText("worker", { preview: true }))}</pre>
      <div class="row-actions task-brief-actions">
        <button class="primary" data-task-brief-copy="worker" type="button">Copy Worker Brief</button>
        <button data-task-brief-copy="review" type="button">Copy Review Brief</button>
        <button data-task-brief-copy="recovery" type="button">Copy Recovery Brief</button>
      </div>
    </div>
  `;
}

function taskBriefData(detail = state.taskDetail || {}) {
  const task = detail.task || {};
  const graph = detail.graph || {};
  const readiness = detail.readiness || {};
  const contextCount =
    (task.requiredTools?.length || 0) +
    (task.requiredMcpServers?.length || 0) +
    (task.requiredMemories?.length || 0) +
    (task.requiredContextRefs?.length || 0) +
    (task.expectedFiles?.length || 0);
  const approvals = (detail.toolContextProposals?.length || 0) + (detail.modelApprovals?.length || 0) + (detail.memorySuggestions?.length || 0);
  const evidence = (task.patchRefs?.length || 0) + (task.testRefs?.length || 0);
  return {
    task,
    graph,
    readiness,
    ready: Boolean(readiness.readyNow),
    readinessState: readiness.state || "not ready",
    dependencies: graph.dependencies?.length || 0,
    dependents: graph.dependents?.length || 0,
    contextCount,
    approvals,
    evidence
  };
}

function taskBriefText(mode = "worker", options = {}) {
  const detail = state.taskDetail || {};
  const data = taskBriefData(detail);
  const task = data.task || {};
  const queue = state.dashboard?.queue || state.matrix?.queue || {};
  const graph = data.graph || {};
  const readiness = data.readiness || {};
  const resume = detail.resume || {};
  const packet = resume.taskPacket || {};
  const fabricResume = resume.fabricResume || {};
  const latestRun = latestWorkerRun(detail.workerRuns || []);
  const title = mode === "review" ? "Task Review Brief" : mode === "recovery" ? "Task Recovery Brief" : "Task Worker Brief";
  const lines = [
    `# ${title}`,
    "",
    `Queue: ${queue.title || queue.queueId || state.selectedQueueId || "selected queue"}`,
    `Project: ${queue.projectPath || selectedProjectPath() || "project path unavailable"}`,
    `Task: ${task.title || task.queueTaskId || "selected task"}`,
    `Task ID: ${task.queueTaskId || state.selectedTaskId || ""}`,
    `Status: ${task.status || "unknown"}`,
    `Phase/category: ${task.phase || "unphased"} / ${task.category || "implementation"}`,
    `Priority/risk: ${task.priority || "normal"} / ${task.risk || "risk unknown"}`,
    `Parallel safe: ${task.parallelSafe === false ? "no" : "yes"}`,
    `Readiness: ${readiness.readyNow ? "ready" : readiness.state || "not ready"}`,
    `Packet: ${safeTaskPacketHref()}`,
    ""
  ];

  if (task.goal || task.summary) {
    lines.push("Summary:", task.summary || task.goal, "");
  }
  pushBriefList(lines, "Acceptance criteria", task.acceptanceCriteria, options.preview ? 5 : 12);
  pushBriefList(lines, "Expected files", task.expectedFiles, options.preview ? 5 : 16);
  pushBriefList(lines, "Required tools", task.requiredTools, options.preview ? 5 : 16);
  pushBriefList(lines, "Required MCP servers", task.requiredMcpServers, options.preview ? 5 : 16);
  pushBriefList(lines, "Required memories", task.requiredMemories, options.preview ? 5 : 16);
  pushBriefList(lines, "Required context refs", task.requiredContextRefs, options.preview ? 5 : 16);
  pushBriefTaskList(lines, "Dependencies", graph.dependencies, options.preview ? 5 : 12);
  pushBriefTaskList(lines, "Dependents", graph.dependents, options.preview ? 5 : 12);
  pushBriefList(lines, "Readiness blockers", readiness.reasons, options.preview ? 5 : 12);

  if (latestRun) {
    const run = latestRun.workerRun || {};
    const event = latestRun.latestEvent || {};
    const checkpoint = latestRun.latestCheckpoint || {};
    const checkpointSummary = checkpoint.summary || {};
    lines.push(
      "Latest worker run:",
      `- Worker: ${run.worker || run.workerRunId || "worker"}`,
      `- Status: ${run.status || "unknown"}`,
      `- Workspace: ${run.workspacePath || run.workspaceMode || ""}`,
      `- Latest event: ${event.kind || ""}${event.body ? ` - ${event.body}` : ""}`,
      `- Next action: ${checkpointSummary.nextAction || checkpointSummary.summary || ""}`,
      ""
    );
  }

  if (mode === "review" || mode === "recovery") {
    pushBriefList(lines, "Patch refs", task.patchRefs, options.preview ? 5 : 16);
    pushBriefList(lines, "Test refs", task.testRefs, options.preview ? 5 : 16);
  }
  if (fabricResume.resumePrompt || packet.summary) {
    lines.push("Resume context:", fabricResume.resumePrompt || packet.summary, "");
  }
  if (options.preview) lines.push("Copy the full brief for the complete task handoff.");
  return lines.join("\n").trim();
}

function latestWorkerRun(runs = []) {
  if (!runs.length) return null;
  return runs[runs.length - 1];
}

function safeTaskPacketHref() {
  try {
    if (!state.selectedQueueId || !state.selectedTaskId) return "";
    return taskPacketUrl().href;
  } catch {
    return "";
  }
}

function pushBriefList(lines, title, values = [], limit = 12) {
  const items = Array.isArray(values) ? values.filter(Boolean).slice(0, limit) : [];
  if (!items.length) return;
  lines.push(`${title}:`);
  for (const item of items) lines.push(`- ${String(item)}`);
  if (Array.isArray(values) && values.length > items.length) lines.push(`- ... ${values.length - items.length} more`);
  lines.push("");
}

function pushBriefTaskList(lines, title, tasks = [], limit = 12) {
  const items = Array.isArray(tasks) ? tasks.filter(Boolean).slice(0, limit) : [];
  if (!items.length) return;
  lines.push(`${title}:`);
  for (const task of items) lines.push(`- ${task.title || task.queueTaskId || "Task"} (${task.queueTaskId || "no id"}, ${task.status || "unknown"})`);
  if (Array.isArray(tasks) && tasks.length > items.length) lines.push(`- ... ${tasks.length - items.length} more`);
  lines.push("");
}

async function copySelectedTaskBrief(mode) {
  if (!state.taskDetail?.task) {
    toast("Select a task before copying a brief.");
    return;
  }
  await copyText(taskBriefText(mode));
  toast(`${mode === "review" ? "Review" : mode === "recovery" ? "Recovery" : "Worker"} task brief copied.`);
}

async function setToolPolicy(grantKey, status) {
  const grants = state.matrix?.toolContext?.grants || [];
  const grant = grants.find((entry) => entry.grantKey === grantKey);
  const projectPath = selectedProjectPath();
  if (!grant || !projectPath) {
    toast("Grant or project path is missing.");
    return;
  }
  await callTool("tool_context_policy_set", {
    projectPath,
    grantKind: grant.kind,
    value: grant.value,
    status
  });
  toast(`${status === "approved" ? "Approved" : "Rejected"} ${grant.grantKey}.`);
  await loadSelectedQueue({ quiet: true });
}

async function setManualProjectPolicy() {
  const grantKind = $("#policy-grant-kind")?.value;
  const value = $("#policy-grant-value")?.value.trim();
  const status = $("#policy-grant-status")?.value;
  await setProjectPolicy(grantKind, value, status);
}

async function setProjectPolicy(grantKind, value, status) {
  const projectPath = selectedProjectPath();
  if (!projectPath) {
    toast("Select a project queue before saving tool policy.");
    return;
  }
  if (!["mcp_server", "tool", "memory", "context"].includes(grantKind)) {
    toast("Choose a valid grant type.");
    return;
  }
  if (!value) {
    toast("Grant value is required.");
    return;
  }
  if (!["approved", "rejected"].includes(status)) {
    toast("Choose approve or reject.");
    return;
  }
  const result = await callTool("tool_context_policy_set", {
    projectPath,
    grantKind,
    value,
    status
  });
  state.lastPolicyResult = {
    projectPath,
    grantKey: result.grantKey || `${grantKind}:${value}`,
    status
  };
  if (state.selectedQueueId) {
    await callTool("project_queue_prepare_ready", { queueId: state.selectedQueueId, limit: 4 });
  }
  await loadProjectPolicyStatus({ quiet: true });
  toast(`${status === "approved" ? "Approved" : "Rejected"} ${grantKind}:${value}.`);
  await loadSelectedQueue({ quiet: true });
}

function selectedProjectPath() {
  return state.dashboard?.queue?.projectPath || state.matrix?.queue?.projectPath || $("#project-filter")?.value.trim() || "";
}

function grantKeyForUi(kind, value) {
  return `${kind}:${typeof value === "string" ? value : JSON.stringify(value)}`;
}

function detailPanel(title, body) {
  return `<div class="detail-panel"><h2>${esc(title)}</h2>${body || emptyLine("None")}</div>`;
}

function listItems(items = []) {
  return items.length ? `<ul class="compact-list">${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : "";
}

function linkItems(items = []) {
  return items.length
    ? items
        .map((item) => `<button class="link-row" type="button" data-task-id="${esc(item.queueTaskId)}"><span>${esc(item.title || item.queueTaskId)}</span><span class="pill">${esc(item.status || "")}</span></button>`)
        .join("")
    : "";
}

function requiredContextHtml(task) {
  const groups = [
    ["Tools", task.requiredTools],
    ["MCP", task.requiredMcpServers],
    ["Memory", task.requiredMemories],
    ["Refs", task.requiredContextRefs],
    ["Files", task.expectedFiles]
  ];
  return groups
    .filter(([, values]) => Array.isArray(values) && values.length)
    .map(([label, values]) => `<div class="context-group"><strong>${esc(label)}</strong><div class="listline">${values.map((value) => `<span class="pill">${esc(value)}</span>`).join("")}</div></div>`)
    .join("");
}

function readinessHtml(readiness) {
  const reasons = readiness.reasons || [];
  return `
    <div class="kv">
      <div>State</div><div>${esc(readiness.state || "")}</div>
      <div>Ready</div><div>${readiness.readyNow ? "yes" : "no"}</div>
      <div>Dependencies</div><div>${readiness.dependenciesReady ? "ready" : "blocked"}</div>
    </div>
    ${reasons.length ? listItems(reasons) : ""}
  `;
}

function workerRunsHtml(runs) {
  return runs.length
    ? runs
        .map((entry) => {
          const run = entry.workerRun || {};
          const event = entry.latestEvent || {};
          const checkpoint = entry.latestCheckpoint || {};
          return `<div class="activity-item"><strong>${esc(run.worker || run.workerRunId || "worker")}</strong><div class="muted">${esc(run.status || "")} - ${esc(run.workspaceMode || "")}</div><div>${esc(event.kind || "")}${event.body ? ` - ${esc(event.body)}` : ""}</div><div class="muted">${esc(checkpoint.summary?.nextAction || checkpoint.summary?.summary || "")}</div></div>`;
        })
        .join("")
    : "";
}

function approvalsHtml(detail) {
  const toolContext = detail.toolContextProposals || [];
  const modelCalls = detail.modelApprovals || [];
  const memorySuggestions = detail.memorySuggestions || [];
  return `
    ${toolContext.length ? `<div class="context-group"><strong>Tool/context</strong>${toolContext.map(toolContextProposalHtml).join("")}</div>` : ""}
    ${modelCalls.length ? `<div class="context-group"><strong>Model</strong><div class="listline">${modelCalls.map((item) => `<span class="pill">${esc(item.status || item.decision || "")}</span>`).join("")}</div></div>` : ""}
    ${memorySuggestions.length ? `<div class="context-group"><strong>Memory suggestions</strong>${memorySuggestions.map((item) => memorySuggestionHtml({ ...item, queueTaskId: detail.task?.queueTaskId, queueTaskTitle: detail.task?.title })).join("")}</div>` : ""}
  `;
}

function memoryReviewHtml(memory = {}) {
  return `
    <div class="memory-card">
      <div class="section-head">
        <h2>${esc(memory.type || "memory")}</h2>
        <span class="pill amber">${esc(memory.status || "pending_review")}</span>
      </div>
      <div class="muted">${esc(memory.id || "")} - confidence ${esc(memory.confidence ?? "?")} - ${esc(memory.source || "auto")}</div>
      <div>${esc(memory.body || "")}</div>
      ${memory.intentKeys?.length ? `<div class="listline">${memory.intentKeys.map((key) => `<span class="pill">${esc(key)}</span>`).join("")}</div>` : ""}
      ${memory.refs?.length ? `<div class="muted">refs: ${memory.refs.map((ref) => esc(ref)).join(", ")}</div>` : ""}
      <div class="row-actions">
        <button class="primary" data-memory-review data-memory-id="${esc(memory.id || "")}" data-decision="approve" type="button">Approve</button>
        <button data-memory-review data-memory-id="${esc(memory.id || "")}" data-decision="archive" type="button">Archive</button>
        <button class="danger" data-memory-review data-memory-id="${esc(memory.id || "")}" data-decision="reject" type="button">Reject</button>
      </div>
    </div>
  `;
}

function memorySuggestionHtml(item = {}) {
  const memory = item.memory || {};
  const memoryRef = item.memoryRef || memory.id;
  const queueTaskId = item.queueTaskId || item.attachByUpdating?.queueTaskId;
  return `
    <div class="memory-card">
      <div class="section-head">
        <h2>${esc(memory.type || "memory")}</h2>
        <span class="pill ${item.approvalRequired ? "amber" : "green"}">${item.approvalRequired ? "approval" : "ready"}</span>
      </div>
      <strong>${esc(item.queueTaskTitle || queueTaskId || "Task")}</strong>
      <div class="muted">${esc(memoryRef || "")}${item.score !== undefined ? ` - score ${esc(item.score)}` : ""}</div>
      ${memory.body ? `<div>${esc(memory.body)}</div>` : ""}
      ${item.matchedIntentKeys?.length ? `<div class="listline">${item.matchedIntentKeys.map((key) => `<span class="pill">${esc(key)}</span>`).join("")}</div>` : ""}
      <div class="row-actions">
        <button class="primary" data-memory-attach data-task-id="${esc(queueTaskId || "")}" data-memory-ref="${esc(memoryRef || "")}" type="button">Attach Memory</button>
        ${queueTaskId ? `<button data-task-id="${esc(queueTaskId)}" type="button">Open Task</button>` : ""}
      </div>
    </div>
  `;
}

function bindMemoryActions(root) {
  root.querySelectorAll("[data-memory-review]").forEach((button) => {
    button.addEventListener("click", () => reviewMemory(button.dataset.memoryId, button.dataset.decision));
  });
  root.querySelectorAll("[data-memory-attach]").forEach((button) => {
    button.addEventListener("click", () => attachSuggestedMemory(button.dataset.taskId, button.dataset.memoryRef));
  });
  root.querySelectorAll(".memory-card [data-task-id]:not([data-memory-attach])").forEach((button) => {
    button.addEventListener("click", async () => {
      await loadTaskDetail(button.dataset.taskId);
      selectTab("dashboard");
    });
  });
}

function toolContextProposalHtml(item = {}) {
  const missing = item.missingGrants || [];
  const refs = [
    ...(item.tools || []).map((value) => `tool:${value}`),
    ...(item.mcpServers || []).map((value) => `mcp:${value}`),
    ...(item.memories || []).map((value) => `memory:${value}`),
    ...(item.contextRefs || []).map((value) => `context:${value}`)
  ];
  return `
    <div class="activity-item">
      <div class="section-head">
        <h2>${esc(item.status || "proposal")}</h2>
        <span class="pill ${item.approvalRequired ? "amber" : "green"}">${item.approvalRequired ? "approval" : "ready"}</span>
      </div>
      <div class="muted">${esc(item.proposalId || "")}${item.modelAlias ? ` - ${esc(item.modelAlias)}` : ""}</div>
      ${refs.length ? `<div class="listline">${refs.map((value) => `<span class="pill">${esc(value)}</span>`).join("")}</div>` : emptyLine("No requested tool/context refs.")}
      ${missing.length ? `<div class="missing-grants">${missing.map(missingGrantHtml).join("")}</div>` : ""}
      ${
        item.status === "proposed"
          ? `<div class="row-actions">
              <button class="primary" data-task-tool-approval data-proposal-id="${esc(item.proposalId)}" data-decision="approve" type="button">Approve</button>
              <button data-task-tool-approval data-proposal-id="${esc(item.proposalId)}" data-decision="revise" type="button">Revise</button>
              <button class="danger" data-task-tool-approval data-proposal-id="${esc(item.proposalId)}" data-decision="reject" type="button">Reject</button>
            </div>`
          : ""
      }
    </div>
  `;
}

function missingGrantHtml(grant = {}) {
  const normalized = normalizeGrantForUi(grant);
  const policyStatus = currentPolicyStatusForGrant(normalized) || grant.policyStatus || "missing";
  const statusClassName = policyStatus === "approved" ? "green" : policyStatus === "rejected" ? "red" : "amber";
  return `
    <div class="missing-grant-row">
      <div>
        <strong>${esc(normalized.grantKey)}</strong>
        <div class="muted">${esc(policyStatus)}</div>
      </div>
      <span class="pill ${statusClassName}">${esc(policyStatus)}</span>
      <div class="row-actions">
        <button class="primary" data-task-policy-grant data-grant-kind="${esc(normalized.kind)}" data-grant-value="${esc(JSON.stringify(normalized.value))}" data-status="approved" type="button">Approve Policy</button>
        <button class="danger" data-task-policy-grant data-grant-kind="${esc(normalized.kind)}" data-grant-value="${esc(JSON.stringify(normalized.value))}" data-status="rejected" type="button">Reject Policy</button>
      </div>
    </div>
  `;
}

function normalizeGrantForUi(grant = {}) {
  const grantKey = String(grant.grantKey || "");
  const separator = grantKey.indexOf(":");
  const kind = grant.kind || (separator > 0 ? grantKey.slice(0, separator) : "");
  const value = grant.value ?? (separator > 0 ? grantKey.slice(separator + 1) : grantKey);
  return {
    kind,
    value,
    grantKey: grantKey || `${kind}:${String(value)}`
  };
}

function currentPolicyStatusForGrant(grant) {
  const projectPolicies = state.projectPolicyStatus?.grants || [];
  const policy = projectPolicies.find((entry) => entry.grantKey === grant.grantKey);
  if (policy?.status) return policy.status;
  const grants = state.matrix?.toolContext?.grants || [];
  const match = grants.find((entry) => entry.grantKey === grant.grantKey);
  return match?.policyStatus;
}

function resumeHtml(resume) {
  if (!resume) return "";
  const packet = resume.taskPacket || {};
  const fabricResume = resume.fabricResume || {};
  return `
    <div class="kv">
      <div>Packet</div><div>${esc(packet.schema || "available")}</div>
      <div>Task</div><div>${esc(packet.queueTaskId || packet.fabricTaskId || "")}</div>
    </div>
    <pre class="resume-box">${esc(fabricResume.resumePrompt || packet.summary || "")}</pre>
  `;
}

function taskMetadataPatch(task) {
  return compactObject({
    title: task.title,
    goal: task.goal,
    phase: task.phase,
    category: task.category,
    priority: task.priority,
    parallelGroup: task.parallelGroup,
    parallelSafe: task.parallelSafe,
    risk: task.risk,
    expectedFiles: task.expectedFiles || [],
    acceptanceCriteria: task.acceptanceCriteria || [],
    requiredTools: task.requiredTools || [],
    requiredMcpServers: task.requiredMcpServers || [],
    requiredMemories: task.requiredMemories || [],
    requiredContextRefs: task.requiredContextRefs || [],
    dependsOn: task.dependsOn || []
  });
}

async function saveTaskMetadata() {
  if (!state.selectedQueueId || !state.selectedTaskId) return;
  let patch;
  try {
    patch = JSON.parse($("#task-metadata-json").value);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("expected a JSON object");
  } catch (error) {
    toast(`Invalid task metadata JSON: ${messageOf(error)}`);
    return;
  }
  await callTool("project_queue_update_task_metadata", {
    queueId: state.selectedQueueId,
    queueTaskId: state.selectedTaskId,
    ...patch,
    note: "Updated from Agent Fabric Console task detail."
  });
  toast("Task metadata saved.");
  await loadSelectedQueue({ quiet: true });
  await loadTaskDetail(state.selectedTaskId, { quiet: true });
}

async function saveTaskOutcome() {
  if (!state.selectedQueueId || !state.selectedTaskId) return;
  const patchRefs = linesFromTextarea("#task-outcome-patches");
  const testRefs = linesFromTextarea("#task-outcome-tests");
  const status = $("#task-outcome-status").value;
  if (!confirmTaskOutcomeStatus(status)) return;
  await callTool("project_queue_update_task", {
    queueId: state.selectedQueueId,
    queueTaskId: state.selectedTaskId,
    status,
    summary: $("#task-outcome-summary").value.trim() || undefined,
    patchRefs,
    testRefs
  });
  toast("Task outcome saved.");
  await loadSelectedQueue({ quiet: true });
  await loadTaskDetail(state.selectedTaskId, { quiet: true });
}

async function acceptReviewTask(queueTaskId) {
  if (!state.selectedQueueId || !queueTaskId) return;
  const selectedTask = state.taskDetail?.task?.queueTaskId === queueTaskId ? state.taskDetail.task : null;
  const task = patchReviewTasks().find((item) => item.queueTaskId === queueTaskId) || selectedTask;
  if (!confirmReviewDecision("accept", task)) return;
  await withPendingAction(`review-accept:${queueTaskId}`, async () => {
    await callTool("project_queue_update_task", {
      queueId: state.selectedQueueId,
      queueTaskId,
      status: "accepted",
      summary: "Accepted from Agent Fabric Console patch review."
    });
    toast("Patch-ready task accepted.");
    await loadSelectedQueue({ quiet: true });
    if (state.selectedTaskId === queueTaskId) await loadTaskDetail(queueTaskId, { quiet: true });
  }, "Review accept is already running.");
}

async function retryReviewTask(queueTaskId) {
  if (!state.selectedQueueId || !queueTaskId) return;
  const selectedTask = state.taskDetail?.task?.queueTaskId === queueTaskId ? state.taskDetail.task : null;
  const task = patchReviewTasks().find((item) => item.queueTaskId === queueTaskId) || selectedTask;
  if (!confirmReviewDecision("retry", task)) return;
  await withPendingAction(`review-retry:${queueTaskId}`, async () => {
    await callTool("project_queue_retry_task", {
      queueId: state.selectedQueueId,
      queueTaskId,
      reason: "Retry requested from Agent Fabric Console patch review.",
      clearOutputs: false
    });
    toast("Task returned to queued for retry.");
    await loadSelectedQueue({ quiet: true });
    if (state.selectedTaskId === queueTaskId) await loadTaskDetail(queueTaskId, { quiet: true });
  }, "Review retry is already running.");
}

async function proposeSelectedTaskContext() {
  if (!state.selectedQueueId || !state.selectedTaskId || !state.taskDetail?.task) return;
  const task = state.taskDetail.task;
  const requested = [
    ...(task.requiredTools || []),
    ...(task.requiredMcpServers || []),
    ...(task.requiredMemories || []),
    ...(task.requiredContextRefs || [])
  ];
  if (!requested.length) {
    $("#task-context-result").innerHTML = `<div class="activity-item"><strong>No required tool/context refs</strong><div class="muted">Add tools, MCP servers, memories, or context refs in task metadata first.</div></div>`;
    toast("No context refs to propose.");
    return;
  }
  const safetyWarnings = [];
  if (task.risk === "high" || task.risk === "breakglass") safetyWarnings.push(`Task risk is ${task.risk}; review grants before worker launch.`);
  const result = await callTool("tool_context_propose", {
    queueId: state.selectedQueueId,
    queueTaskId: state.selectedTaskId,
    tools: task.requiredTools || [],
    mcpServers: task.requiredMcpServers || [],
    memories: task.requiredMemories || [],
    contextRefs: task.requiredContextRefs || [],
    modelAlias: "tool.context.manager",
    reasoning: "desktop-task-detail",
    safetyWarnings
  });
  $("#task-context-result").innerHTML = `<div class="activity-item"><strong>${result.approvalRequired ? "Approval required" : "Context ready"}</strong><div class="muted">${esc(result.proposalId || "")}</div><div>${num(result.missingGrants?.length)} missing grant(s)</div></div>`;
  toast(result.approvalRequired ? "Tool/context proposal needs approval." : "Tool/context proposal recorded.");
  await loadSelectedQueue({ quiet: true });
  await loadTaskDetail(state.selectedTaskId, { quiet: true });
}

async function setTaskPolicyGrant(grantKind, valueJson, status) {
  if (!state.selectedQueueId || !state.selectedTaskId) return;
  const projectPath = state.dashboard?.queue?.projectPath || state.matrix?.queue?.projectPath;
  if (!projectPath || !grantKind || !valueJson) {
    toast("Grant policy input is missing.");
    return;
  }
  let value;
  try {
    value = JSON.parse(valueJson);
  } catch (error) {
    toast(`Invalid grant value: ${messageOf(error)}`);
    return;
  }
  if (!confirmPolicyGrant(grantKind, value, status)) return;
  await withPendingAction(`policy:${grantKind}:${String(value)}:${status}`, async () => {
    await callTool("tool_context_policy_set", {
      projectPath,
      grantKind,
      value,
      status
    });
    await callTool("project_queue_prepare_ready", { queueId: state.selectedQueueId, limit: 4 });
    toast(`${status === "approved" ? "Approved" : "Rejected"} ${grantKind}:${String(value)}.`);
    await loadSelectedQueue({ quiet: true });
    await loadTaskDetail(state.selectedTaskId, { quiet: true });
  }, "Policy decision is already running.");
}

async function attachSuggestedMemory(queueTaskId, memoryRef) {
  if (!state.selectedQueueId || !queueTaskId || !memoryRef) {
    toast("Memory suggestion is missing task or memory reference.");
    return;
  }
  await callTool("project_queue_update_task_metadata", {
    queueId: state.selectedQueueId,
    queueTaskId,
    addRequiredMemories: [memoryRef],
    note: "Attached suggested memory from Agent Fabric Console."
  });
  toast("Memory attached to task.");
  await loadSelectedQueue({ quiet: true });
  if (state.selectedTaskId === queueTaskId) await loadTaskDetail(queueTaskId, { quiet: true });
}

async function reviewMemory(memoryId, decision) {
  if (!memoryId || !decision) {
    toast("Memory review action is missing an id or decision.");
    return;
  }
  if (!confirmMemoryDecision(memoryId, decision)) return;
  await withPendingAction(`memory:${memoryId}:${decision}`, async () => {
    await callTool("memory_review", {
      id: memoryId,
      decision,
      reason: `Agent Fabric Console ${decision}`
    });
    toast(`Memory ${decision} recorded.`);
    await loadSelectedQueue({ quiet: true });
  }, "Memory review is already running.");
}

async function generateSelectedTaskPacket() {
  if (!state.selectedQueueId || !state.selectedTaskId) return;
  const result = await callTool("project_queue_task_packet", {
    queueId: state.selectedQueueId,
    queueTaskId: state.selectedTaskId,
    format: "markdown",
    includeResume: true,
    preferredWorker: $("#claim-worker")?.value || SENIOR_CLAIM_DEFAULTS.worker,
    workspaceMode: $("#claim-workspace-mode")?.value || SENIOR_CLAIM_DEFAULTS.workspaceMode,
    workspacePath: $("#claim-workspace-path")?.value.trim() || undefined,
    modelProfile: $("#claim-model-profile")?.value.trim() || SENIOR_CLAIM_DEFAULTS.modelProfile
  });
  $("#task-context-result").innerHTML = taskPacketResultHtml(result);
  $("#task-context-result").querySelector("[data-copy-task-packet]")?.addEventListener("click", async () => {
    await copyText(result.markdown || result.preview || JSON.stringify(result.packet || {}, null, 2));
    toast("Task packet copied.");
  });
  $("#task-context-result").querySelector("[data-copy-task-packet-link]")?.addEventListener("click", () => copySelectedTaskPacketLink());
  $("#task-context-result").querySelectorAll("[data-copy-handoff]").forEach((button) => {
    button.addEventListener("click", async () => {
      await copyText(button.dataset.command || "");
      toast("Handoff command copied.");
    });
  });
  toast(result.packetKind === "resume" ? "Resume packet generated." : "Task packet generated.");
}

function taskPacketResultHtml(result = {}) {
  const body = result.markdown || result.preview || JSON.stringify(result.packet || {}, null, 2);
  const task = result.queueTask || result.packet?.task || {};
  const handoff = result.handoff || {};
  const commands = handoff.commands || [];
  return `
    <div class="activity-item">
      <div class="section-head">
        <h2>${esc(result.packetKind === "resume" ? "Resume Packet" : "Task Packet")}</h2>
        <span class="pill">${esc(result.packet?.schema || "")}</span>
      </div>
      <div class="muted">${esc(task.title || task.queueTaskId || "")}</div>
      ${handoff.packetPath ? `<div class="kv"><div>Packet path</div><div>${esc(handoff.packetPath)}</div><div>Worker</div><div>${esc(handoff.worker || "")}</div></div>` : ""}
      ${
        commands.length
          ? `<div class="handoff-commands">
              ${commands
                .map(
                  (entry) => `
                    <div class="handoff-command">
                      <div class="section-head">
                        <h2>${esc(entry.label || entry.key || "Command")}</h2>
                        <span class="pill ${entry.editRequired ? "amber" : "green"}">${entry.editRequired ? "edit" : "ready"}</span>
                      </div>
                      <pre class="resume-box">${esc(entry.command || "")}</pre>
                      <div class="row-actions"><button data-copy-handoff data-command="${esc(entry.command || "")}" type="button">Copy Command</button></div>
                    </div>
                  `
                )
                .join("")}
            </div>`
          : ""
      }
      <pre class="resume-box handoff-box">${esc(body)}</pre>
      <div class="row-actions">
        <button class="primary" data-copy-task-packet type="button">Copy Packet</button>
        <button data-copy-task-packet-link type="button">Copy Packet Link</button>
      </div>
    </div>
  `;
}

async function retrySelectedTask() {
  if (!state.selectedQueueId || !state.selectedTaskId) return;
  if (!confirmReviewDecision("retry", state.taskDetail?.task)) return;
  await withPendingAction(`review-retry:${state.selectedTaskId}`, async () => {
    await callTool("project_queue_retry_task", {
      queueId: state.selectedQueueId,
      queueTaskId: state.selectedTaskId,
      reason: "Retry requested from Agent Fabric Console task detail.",
      clearOutputs: true
    });
    toast("Task returned to queued.");
    await loadSelectedQueue({ quiet: true });
    await loadTaskDetail(state.selectedTaskId, { quiet: true });
  }, "Task retry is already running.");
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.focus();
  area.select();
  document.execCommand("copy");
  area.remove();
}

function compactObject(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== null));
}

function linesFromTextarea(selector) {
  return $(selector)
    .value.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function toolApprovalHtml(item) {
  const missing = (item.missingGrants || []).map((grant) => grant.grantKey || grant.kind || "").filter(Boolean).join(", ");
  return `
    <div class="approval">
      <div class="approval-title">${esc(item.queueTaskTitle || item.proposalId)}</div>
      <div class="muted">${esc(missing || "No missing grants listed.")}</div>
      <div class="row-actions">
        <button class="primary" data-tool-approval data-proposal-id="${esc(item.proposalId)}" data-decision="approve" type="button">Approve</button>
        <button data-tool-approval data-proposal-id="${esc(item.proposalId)}" data-decision="revise" type="button">Revise</button>
        <button class="danger" data-tool-approval data-proposal-id="${esc(item.proposalId)}" data-decision="reject" type="button">Reject</button>
      </div>
    </div>
  `;
}

function modelApprovalHtml(item) {
  const selected = item.selected || {};
  const estimate = item.estimate || {};
  return `
    <div class="approval">
      <div class="approval-title">${esc(item.taskType || "model call")} - ${money(estimate.estimatedCostUsd || 0)}</div>
      <div class="muted">${esc(selected.provider || "")}/${esc(selected.model || "")}/${esc(selected.reasoning || "")}</div>
      <div class="row-actions">
        <button class="primary" data-model-approval data-request-id="${esc(item.requestId)}" data-decision="allow" type="button">Allow</button>
        <button data-model-approval data-request-id="${esc(item.requestId)}" data-decision="compact" type="button">Compact</button>
        <button data-model-approval data-request-id="${esc(item.requestId)}" data-decision="downgrade" type="button">Downgrade</button>
        <button class="danger" data-model-approval data-request-id="${esc(item.requestId)}" data-decision="cancel" type="button">Cancel</button>
        <button data-inspect-request data-request-id="${esc(item.requestId)}" type="button">Inspect</button>
      </div>
    </div>
  `;
}

function laneHtml(lane = {}) {
  const task = lane.queueTask || {};
  const run = lane.workerRun || {};
  const progress = lane.progress || {};
  const checkpoint = lane.latestCheckpoint || {};
  const checkpointSummary = checkpoint.summary || {};
  const status = progress.label || run.status || task.status || "active";
  const laneId = laneStableId(lane);
  const files = progress.filesTouched || checkpointSummary.filesTouched || [];
  const tests = progress.testsRun || checkpointSummary.testsRun || [];
  return `
    <div class="activity-item lane-card ${statusClass(status)}">
      <div class="lane-card-head">
        <div>
          <strong>${esc(task.title || lane.laneId || run.workerRunId || "Worker lane")}</strong>
          <div class="muted">${esc(run.worker || "worker")} - ${esc(run.workspaceMode || "")}${run.modelProfile ? ` - ${esc(run.modelProfile)}` : ""}</div>
        </div>
        <span class="pill ${statusClass(status)}">${esc(status)}</span>
      </div>
      <div>${esc(progress.summary || checkpointSummary.nextAction || lane.latestEvent?.body || "Waiting for worker events.")}</div>
      <div class="listline lane-card-facts">
        <span class="pill">files ${Array.isArray(files) ? files.length : 0}</span>
        <span class="pill">tests ${Array.isArray(tests) ? tests.length : 0}</span>
        <span class="pill">${esc(run.workerRunId || laneId)}</span>
      </div>
      <div class="row-actions lane-card-actions">
        ${task.queueTaskId ? `<button type="button" data-theater-task="${esc(task.queueTaskId)}">Open Task</button>` : ""}
        <button type="button" data-copy-lane-brief="${esc(laneId)}">Copy Lane Brief</button>
      </div>
    </div>
  `;
}

function theaterLaneHtml(lane = {}) {
  const task = lane.queueTask || {};
  const run = lane.workerRun || {};
  const progress = lane.progress || {};
  const latestCheckpoint = lane.latestCheckpoint || {};
  const checkpointSummary = latestCheckpoint.summary || {};
  const events = lane.recentEvents || [];
  const files = progress.filesTouched || checkpointSummary.filesTouched || [];
  const tests = progress.testsRun || checkpointSummary.testsRun || [];
  const percent = theaterProgressPercent(task.status || run.status || progress.label);
  const laneId = laneStableId(lane);
  return `
    <div class="theater-lane ${statusClass(task.status || run.status || progress.label)}">
      <div class="theater-lane-head">
        <div>
          <strong>${esc(task.title || lane.laneId || "Worker lane")}</strong>
          <div class="muted">${esc(run.worker || "worker")} - ${esc(run.workspaceMode || "")} ${run.modelProfile ? `- ${esc(run.modelProfile)}` : ""}</div>
        </div>
        <span class="pill ${statusClass(task.status || run.status || progress.label)}">${esc(progress.label || run.status || task.status || "active")}</span>
      </div>
      <div class="theater-progress"><span style="width: ${percent}%"></span></div>
      <div class="theater-summary">${esc(progress.summary || checkpointSummary.nextAction || lane.latestEvent?.body || "Waiting for worker events.")}</div>
      <div class="theater-grid">
        <div>${theaterListHtml("Files", files)}</div>
        <div>${theaterListHtml("Tests", tests)}</div>
        <div>${theaterEventListHtml(events)}</div>
      </div>
      <div class="row-actions">
        ${task.queueTaskId ? `<button type="button" data-theater-task="${esc(task.queueTaskId)}">Open Task</button>` : ""}
        <button type="button" data-copy-lane-brief="${esc(laneId)}">Copy Lane Brief</button>
      </div>
    </div>
  `;
}

function bindLaneActions(root) {
  root.querySelectorAll("[data-copy-lane-brief]").forEach((button) => {
    button.addEventListener("click", () => copyLaneBrief(button.dataset.copyLaneBrief));
  });
  root.querySelectorAll("[data-copy-all-lane-briefs]").forEach((button) => {
    button.addEventListener("click", () => copyAllLaneBriefs());
  });
  root.querySelectorAll("[data-theater-task]").forEach((button) => {
    button.addEventListener("click", () => loadTaskDetail(button.dataset.theaterTask));
  });
}

function laneStableId(lane = {}) {
  return lane.laneId || lane.workerRun?.workerRunId || lane.queueTask?.queueTaskId || "";
}

function findLane(laneId) {
  const lanes = state.lanes?.lanes || [];
  return lanes.find((lane) => laneStableId(lane) === laneId);
}

function laneBriefText(lane = {}) {
  const task = lane.queueTask || {};
  const run = lane.workerRun || {};
  const progress = lane.progress || {};
  const event = lane.latestEvent || {};
  const checkpoint = lane.latestCheckpoint || {};
  const checkpointSummary = checkpoint.summary || {};
  const events = lane.recentEvents || [];
  const files = progress.filesTouched || checkpointSummary.filesTouched || [];
  const tests = progress.testsRun || checkpointSummary.testsRun || [];
  const queue = state.dashboard?.queue || state.matrix?.queue || {};
  const lines = [
    "# Worker Lane Brief",
    "",
    `Queue: ${queue.title || queue.queueId || state.selectedQueueId || "selected queue"}`,
    `Project: ${queue.projectPath || selectedProjectPath() || "project path unavailable"}`,
    `Lane: ${laneStableId(lane) || "lane"}`,
    `Task: ${task.title || task.queueTaskId || "unknown task"}`,
    `Task ID: ${task.queueTaskId || ""}`,
    `Worker run: ${run.workerRunId || ""}`,
    `Worker/model: ${run.worker || "worker"} / ${run.modelProfile || "model profile unavailable"}`,
    `Workspace: ${run.workspacePath || run.workspaceMode || ""}`,
    `Status: ${progress.label || run.status || task.status || "active"}`,
    "",
    "Current summary:",
    progress.summary || checkpointSummary.nextAction || event.body || "No worker summary recorded yet.",
    ""
  ];
  pushBriefList(lines, "Files touched", files, 16);
  pushBriefList(lines, "Tests run", tests, 16);
  if (checkpointSummary.summary || checkpointSummary.nextAction) {
    lines.push("Checkpoint:", `- Summary: ${checkpointSummary.summary || ""}`, `- Next action: ${checkpointSummary.nextAction || ""}`, "");
  }
  if (events.length) {
    lines.push("Recent events:");
    for (const item of events.slice(0, 8)) {
      lines.push(`- ${item.kind || item.summary || "event"}${item.body ? `: ${item.body}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

async function copyLaneBrief(laneId) {
  const lane = findLane(laneId);
  if (!lane) {
    toast("Lane is no longer available.");
    return;
  }
  await copyText(laneBriefText(lane));
  toast("Lane brief copied.");
}

async function copyAllLaneBriefs() {
  const lanes = state.lanes?.lanes || [];
  if (!lanes.length) {
    toast("No lane briefs to copy.");
    return;
  }
  await copyText(lanes.map(laneBriefText).join("\n\n---\n\n"));
  toast(`Copied ${lanes.length} lane brief(s).`);
}

function theaterListHtml(title, values) {
  const items = Array.isArray(values) ? values.filter(Boolean).slice(0, 4) : [];
  return `<h3>${esc(title)}</h3>${items.length ? items.map((item) => `<div class="muted truncate">${esc(String(item))}</div>`).join("") : `<div class="muted">None yet</div>`}`;
}

function theaterEventListHtml(events) {
  const items = Array.isArray(events) ? events.slice(0, 4) : [];
  return `<h3>Events</h3>${items.length ? items.map((event) => `<div class="muted truncate">${esc(event.kind || event.summary || event.body || "event")}</div>`).join("") : `<div class="muted">No events</div>`}`;
}

function theaterProgressPercent(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized.includes("patch") || normalized.includes("review")) return 82;
  if (normalized.includes("running") || normalized.includes("started")) return 55;
  if (normalized.includes("queued") || normalized.includes("ready")) return 20;
  if (normalized.includes("completed") || normalized.includes("done")) return 100;
  if (normalized.includes("failed") || normalized.includes("cancel")) return 100;
  return 35;
}

function activityHtml(item) {
  return `<div class="activity-item"><strong>${esc(item.title || item.kind || "event")}</strong><div class="muted">${esc(item.timestamp || "")} - ${esc(item.source || "")}</div>${item.summary ? `<div>${esc(item.summary)}</div>` : ""}</div>`;
}

function latestStageByName(stages) {
  const latest = new Map();
  for (const stage of stages) latest.set(stage.stage, stage);
  return latest;
}

function pipelineStepHtml(number, stage, label, latest) {
  const status = latest?.status || "not_recorded";
  return `
    <div class="pipeline-step ${stageStatusClass(status)}">
      <div class="pipeline-step-top">
        <span class="pipeline-index">${number}</span>
        <span class="pill ${stageStatusClass(status)}">${esc(status)}</span>
      </div>
      <h3>${esc(label)}</h3>
      <div class="muted">${esc(latest?.modelAlias || defaultModelAlias(stage))}</div>
      ${latest?.outputSummary ? `<p>${esc(latest.outputSummary)}</p>` : ""}
    </div>
  `;
}

function pipelineGateButtons(queueStatus) {
  const options = [
    ["accept_improved_prompt", "Accept Prompt", "Accept improved prompt and move into planning."],
    ["request_prompt_revision", "Revise Prompt", "Prompt needs another improvement pass."],
    ["accept_plan", "Accept Plan", "Accept reviewed plan and move to queue review."],
    ["request_plan_revision", "Revise Plan", "Plan needs another planning round."],
    ["approve_queue", "Approve Queue", "Task queue is ready for execution review."],
    ["start_execution", "Start", "Open the worker start gate."],
    ["pause", "Pause", "Pause worker launch for this queue."],
    ["resume", "Resume", "Resume worker launch for this queue."]
  ];
  const recommended = recommendedDecisions(queueStatus);
  return options
    .map(([decision, label, note]) => {
      const primary = recommended.includes(decision) ? " primary" : "";
      return `<button class="${primary.trim()}" data-pipeline-decision="${esc(decision)}" data-note="${esc(note)}" type="button">${esc(label)}</button>`;
    })
    .join("");
}

function recommendedDecisions(queueStatus) {
  if (queueStatus === "prompt_review") return ["accept_improved_prompt", "request_prompt_revision"];
  if (queueStatus === "plan_review") return ["accept_plan", "request_plan_revision"];
  if (queueStatus === "queue_review") return ["approve_queue", "start_execution"];
  if (queueStatus === "paused") return ["resume"];
  if (queueStatus === "running") return ["pause"];
  return [];
}

function decisionHistoryHtml(item) {
  const data = item.data || {};
  return `
    <div class="activity-item compact-activity">
      <strong>${esc(data.decision || item.decision || item.title || "decision")}</strong>
      <div class="muted">${esc(item.timestamp || data.createdAt || "")}</div>
      ${item.summary ? `<div>${esc(item.summary)}</div>` : ""}
    </div>
  `;
}

function stageHistoryHtml(stage) {
  return `
    <div class="activity-item">
      <div class="section-head">
        <h2>${esc(stageLabel(stage.stage))}</h2>
        <span class="pill ${stageStatusClass(stage.status)}">${esc(stage.status || "unknown")}</span>
      </div>
      <div class="muted">${esc(stage.createdAt || "")}${stage.modelAlias ? ` - ${esc(stage.modelAlias)}` : ""}</div>
      ${stage.inputSummary ? `<div><strong>Input</strong>: ${esc(stage.inputSummary)}</div>` : ""}
      ${stage.outputSummary ? `<div><strong>Output</strong>: ${esc(stage.outputSummary)}</div>` : ""}
      ${stage.artifacts?.length ? `<div class="listline">${stage.artifacts.map((item) => `<span class="pill">${esc(String(item))}</span>`).join("")}</div>` : ""}
      ${stage.warnings?.length ? `<ul class="compact-list">${stage.warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul>` : ""}
    </div>
  `;
}

function stageLabel(stage) {
  return PIPELINE_STAGES.find(([key]) => key === stage)?.[1] || stage || "Stage";
}

function defaultModelAlias(stage) {
  if (stage === "prompt_improvement") return "prompt.improve.strong";
  if (stage === "planning") return "plan.strong";
  if (stage === "phasing") return "phase.splitter";
  if (stage === "task_writing" || stage === "queue_shaping") return "task.writer";
  if (stage === "tool_context") return "tool.context.manager";
  if (stage === "execution") return "execute.cheap";
  if (stage === "review") return "review.strong";
  return "human decision";
}

function rowLine(left, right) {
  return `<div class="file-row"><strong>${esc(left || "")}</strong><div class="muted">${esc(right || "")}</div></div>`;
}

async function apiGet(path) {
  const response = await fetch(path);
  return unpack(response);
}

async function callTool(tool, input) {
  let response = await postToolCall(tool, input);
  if (response.status === 401) {
    upsertNotice("api-auth", "Refreshing desktop API token", {
      severity: "warning",
      detail: "The local mutation token was rejected, so the shell is refreshing readiness and retrying once."
    });
    await refreshApiToken();
    response = await postToolCall(tool, input);
  }
  if (response.status === 401 || response.status === 403) {
    upsertNotice("api-auth", "Desktop API token rejected", {
      severity: "error",
      detail: "Refresh the desktop shell or restart the local desktop server before sending more mutation requests."
    });
  } else {
    clearNoticeKind("api-auth");
  }
  return unpack(response);
}

async function postToolCall(tool, input) {
  if (!state.apiToken) await refreshApiToken();
  const response = await fetch("/api/call", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(state.apiToken ? { "x-agent-fabric-desktop-token": state.apiToken } : {})
    },
    body: JSON.stringify({ tool, input })
  });
  return response;
}

async function postDemoSeed(input) {
  return postAuthenticatedJson("/api/demo-seed", input);
}

async function postProjectCreate(input) {
  return postAuthenticatedJson("/api/project-create", input);
}

async function postProjectImprovePrompt(input) {
  return postAuthenticatedJson("/api/project-improve-prompt", input);
}

async function postProjectStartPlan(input) {
  return postAuthenticatedJson("/api/project-start-plan", input);
}

async function postAuthenticatedJson(path, input) {
  if (!state.apiToken) await refreshApiToken();
  let response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(state.apiToken ? { "x-agent-fabric-desktop-token": state.apiToken } : {})
    },
    body: JSON.stringify(input)
  });
  if (response.status === 401) {
    await refreshApiToken();
    response = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(state.apiToken ? { "x-agent-fabric-desktop-token": state.apiToken } : {})
      },
      body: JSON.stringify(input)
    });
  }
  return unpack(response);
}

async function refreshApiToken() {
  const readiness = await apiGet("/api/readiness");
  state.readiness = readiness;
  state.apiToken = readiness.server?.apiToken || null;
  clearNoticeKind("daemon");
  renderReadinessLine();
}

async function unpack(response) {
  const payload = await response.json();
  if (!payload.ok) {
    const error = new Error(payload.error?.message || "Request failed.");
    error.code = payload.error?.code;
    error.status = response.status;
    if (response.status === 401 || response.status === 403 || response.status >= 500) {
      upsertNotice(`api-${response.status}`, payload.error?.code || "Request failed", {
        severity: response.status >= 500 ? "error" : "warning",
        detail: payload.error?.message || "The desktop server rejected the request.",
        code: payload.error?.code
      });
    }
    throw error;
  }
  return payload.data;
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.remove("hidden");
  window.setTimeout(() => node.classList.add("hidden"), 2400);
}

function upsertNotice(kind, title, options = {}) {
  const severity = ["error", "warning", "info"].includes(options.severity) ? options.severity : "info";
  const existing = state.notices.find((notice) => notice.kind === kind);
  const notice = {
    id: existing?.id || state.nextNoticeId++,
    kind,
    title,
    severity,
    detail: options.detail || "",
    code: options.code || "",
    createdAt: new Date().toLocaleTimeString()
  };
  state.notices = [notice, ...state.notices.filter((entry) => entry.kind !== kind)].slice(0, 8);
  renderNotices();
}

function clearNoticeKind(kind) {
  const before = state.notices.length;
  state.notices = state.notices.filter((notice) => notice.kind !== kind);
  if (state.notices.length !== before) renderNotices();
}

function dismissNotice(id) {
  state.notices = state.notices.filter((notice) => notice.id !== id);
  renderNotices();
}

function renderNotices() {
  const root = $("#notice-stack");
  if (!root) return;
  root.classList.toggle("hidden", state.notices.length === 0);
  root.innerHTML = state.notices
    .map(
      (notice) => `
        <div class="notice ${esc(notice.severity)}">
          <div class="notice-main">
            <div>
              <strong>${esc(notice.title)}</strong>
              <div class="muted">${esc(notice.createdAt)}${notice.code ? ` - ${esc(notice.code)}` : ""}</div>
            </div>
            <button class="notice-dismiss" data-dismiss-notice="${esc(notice.id)}" type="button" aria-label="Dismiss notice">Dismiss</button>
          </div>
          ${notice.detail ? `<div>${esc(notice.detail)}</div>` : ""}
        </div>
      `
    )
    .join("");
  root.querySelectorAll("[data-dismiss-notice]").forEach((button) => {
    button.addEventListener("click", () => dismissNotice(Number(button.dataset.dismissNotice)));
  });
}

function emptyLine(text) {
  return `<div class="muted">${esc(text)}</div>`;
}

function statusClass(status) {
  if (["running", "completed", "launchable"].includes(status)) return "green";
  if (["queue_review", "prompt_review", "plan_review", "paused", "needs_review", "pending", "approval", "waiting", "proposal"].includes(status)) return "amber";
  if (["canceled", "failed", "rejected"].includes(status)) return "red";
  if (["accepted", "done"].includes(status)) return "green";
  return "blue";
}

function actionSeverityClass(severity) {
  if (severity === "warning") return "red";
  if (severity === "attention") return "amber";
  if (severity === "info") return "blue";
  return "";
}

function stageStatusClass(status) {
  return statusClass(status === "not_recorded" ? "pending" : status);
}

function riskClass(risk) {
  if (risk === "low") return "green";
  if (risk === "medium") return "blue";
  if (risk === "high") return "amber";
  if (risk === "breakglass") return "red";
  return "";
}

function money(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function num(value) {
  return Number(value || 0);
}

function messageOf(error) {
  return error?.message || String(error);
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
