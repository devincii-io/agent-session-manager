/* ============================================================
   The session inspector: header, tab bar, and every tab that is not
   Summary or Timeline (those have files of their own).

   Tabs appear only when they have something to show. A session with
   no subagents, no task board and no images gets four tabs, not
   eight, and the counts on the tabs say what is behind them.
   ============================================================ */

(function (ASM) {
  "use strict";

  const { esc, fmt } = ASM.util;
  const ui = ASM.ui;
  const State = ASM.state;

  /* The user role also carries the CLI's own scaffolding. It is real data,
     but it is not conversation, so it is folded away behind one toggle. */
  const NOISE = /^<(local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|system-reminder|task-notification|user-prompt-submit-hook|bash-(input|stdout|stderr))/;

  function isNoise(event) {
    if (event.role !== "user") return false;
    const text = (event.blocks || []).map((block) => block.text || "").join("").trimStart();
    return !!text && NOISE.test(text);
  }

  /* ---------- header ---------- */

  function header() {
    const detail = State.detail || {};
    const session = ASM.scope.currentSession() || {};
    const provider = session.provider || ASM.scope.currentProvider();
    const title = session.title || session.first_prompt || "Session";
    const analytics = detail.analytics || {};
    const project = ASM.scope.currentProject();
    const priced = ASM.scope.priced(provider);

    const facts = [];
    if (project) facts.push(`<span class="fact-link" data-action="project" data-id="${esc(project.id)}">${esc(project.name)}</span>`);
    const started = analytics.first_ts || session.created;
    if (started) facts.push(`<span>${esc(fmt.dayClock(started))}</span>`);
    const active = analytics.active_ms != null ? analytics.active_ms : session.active_ms;
    if (active) facts.push(`<span><b>${esc(fmt.hours(active))}</b> active</span>`);
    facts.push(`<span><b>${fmt.num(analytics.assistant_turns || session.assistant_messages || 0)}</b> turns</span>`);
    facts.push(`<span><b>${fmt.tokens((detail.usage || session.usage || {}).total)}</b> tokens</span>`);
    if (priced) facts.push(`<span class="p-cost">${fmt.cost(detail.cost != null ? detail.cost : session.cost)}</span>`);
    if (session.active) facts.push(`<span class="badge green"><span class="dot-active"></span> live</span>`);
    (session.models || []).slice(0, 3).forEach((model) => facts.push(ui.badge(fmt.model(model))));

    return `<div class="session-head">
      <div class="sh-top">
        <div class="ph-title" style="min-width:0">
          <h1>${esc(title)}</h1>
          <div class="ph-sub mono">${ui.providerBadge(provider)} ${esc(State.sessionId || "")}</div>
        </div>
        <div class="page-actions">
          <button class="btn sm primary" data-action="launch-resume" title="Resume this session in a terminal (Ctrl+Enter)">Resume</button>
          ${provider === "codex" ? `<button class="btn sm" data-action="launch-fork">Fork</button>` : ""}
          <button class="btn sm" data-action="copy-resume">Copy command</button>
          <button class="btn sm" data-action="open-jsonl">Open .jsonl</button>
          ${session.protected
            ? `<button class="btn sm" disabled title="Cleanup unlocks after ten minutes without transcript activity">Recently active</button>`
            : provider === "codex"
              ? `<button class="btn sm" data-action="archive-session">Archive</button>`
              : session.source_writable === false
                ? `<button class="btn sm" disabled title="WSL Claude cleanup is inspection-only">Read-only</button>`
                : `<button class="btn sm danger" data-action="delete-session">Delete</button>`}
        </div>
      </div>
      <div class="sh-facts">${facts.join("")}</div>
    </div>`;
  }

  function tabList() {
    const detail = State.detail || {};
    const provider = ASM.scope.currentProvider();
    const goals = (detail.goals && detail.goals.goals) || [];
    const prompts = (detail.requests && detail.requests.requests) || [];
    const trace = (detail.trace && detail.trace.events) || [];
    const tabs = [
      ["summary", "Summary", null],
      ["timeline", "Timeline", goals.length ? `${goals.length} goal${goals.length === 1 ? "" : "s"}` : (prompts.length || null)],
      ["transcript", "Transcript", detail.total_events || 0],
    ];
    if (trace.length) tabs.push(["trace", "Trace", trace.length]);
    if (detail.subagents && detail.subagents.count) tabs.push(["subagents", "Subagents", detail.subagents.count]);
    if (provider === "claude") {
      if ((detail.tasks || []).length) tabs.push(["tasks", "Tasks", detail.tasks.length]);
      if (((detail.scratchpad && detail.scratchpad.files) || []).length) tabs.push(["workspace", "Workspace", detail.scratchpad.files.length]);
      if ((detail.images || []).length) tabs.push(["images", "Images", detail.images.length]);
    }
    tabs.push(["details", "Details", null]);
    return tabs;
  }

  function render() {
    if (!State.detail) {
      return `${header()}${ui.tabs([["summary", "Summary", null], ["timeline", "Timeline", null], ["transcript", "Transcript", null]], State.tab)}
        <div id="tab-body">${ui.skeletonTiles(4)}<div class="card">${ui.skeletonRows(5)}</div></div>`;
    }
    const tabs = tabList();
    if (!tabs.some(([key]) => key === State.tab)) State.tab = "summary";
    return `${header()}
      ${ui.tabs(tabs, State.tab)}
      <div id="tab-body">${tabBody()}</div>`;
  }

  function tabBody() {
    const detail = State.detail || {};
    switch (State.tab) {
      case "timeline": return ASM.views.journey.render(detail);
      case "transcript": return transcriptTab();
      case "trace": return traceTab(detail);
      case "subagents": return subagentsTab(detail);
      case "tasks": return tasksTab(detail);
      case "workspace": return workspaceTab(detail);
      case "images": return imagesTab(detail);
      case "details": return detailsTab(detail);
      default: return ASM.views.summary.render(detail);
    }
  }

  /** Anything a tab needs to do once its markup is in the DOM. */
  function mountTab() {
    if (State.tab === "timeline" && State.detail) ASM.views.journey.mount(State.detail);
  }

  /* ---------- transcript ---------- */

  function transcriptTab() {
    const window_ = State.transcript || { events: [], start: 0, total: 0 };
    const all = window_.events.filter((event) => !event.sidechain);
    const events = State.showNoise ? all : all.filter((event) => !isNoise(event));
    const hidden = all.length - events.length;
    if (!events.length && !hidden && !window_.start) return ui.emptyState("◌", "No messages");

    const controls = [];
    if (window_.start > 0) {
      controls.push(`<button class="btn sm" data-action="show-earlier">Load earlier · ${window_.start} before this</button>`);
    }
    if (hidden) {
      controls.push(`<button class="btn sm" data-action="toggle-noise">${State.showNoise ? "Hide" : "Show"} ${hidden} CLI message${hidden === 1 ? "" : "s"}</button>`);
    }
    return `${controls.length ? `<div class="row wrap" style="margin-bottom:12px">${controls.join("")}</div>` : ""}
      <div class="transcript">${events.map(message).join("")}</div>`;
  }

  function message(event) {
    const avatar = event.role === "user" ? "U" : (event.sidechain ? "S" : "C");
    const head = [`<span class="msg-role">${event.sidechain ? "subagent" : esc(event.role)}</span>`];
    if (event.model && event.model !== "<synthetic>") head.push(`<span>${esc(fmt.model(event.model))}</span>`);
    if (event.ts) head.push(`<span data-tip="${esc(fmt.time(event.ts))}">${esc(fmt.clock(event.ts))}</span>`);
    return `<div class="msg ${esc(event.role)}${event.sidechain ? " sidechain" : ""}">
      <div class="msg-avatar">${avatar}</div>
      <div class="msg-body">
        <div class="msg-head">${head.join('<span class="faint">·</span>')}</div>
        ${(event.blocks || []).map(block).join("")}
      </div></div>`;
  }

  function block(item) {
    if (item.type === "text") {
      return `<div class="msg-text">${esc(item.text)}${item.truncated ? `<span class="truncated-note"> …truncated</span>` : ""}</div>`;
    }
    if (item.type === "thinking") {
      return `<div class="block-thinking">${esc(item.text)}${item.truncated ? " …" : ""}</div>`;
    }
    if (item.type === "tool_use") {
      const category = ASM.categorize(item.name);
      return `<div class="block-tool">
        <div class="tool-name"><span class="cat-dot bg-${category}"></span>${esc(item.name)}</div>
        <div class="tool-input">${esc(item.input_preview)}${item.input_truncated ? " …" : ""}</div></div>`;
    }
    if (item.type === "tool_result") {
      return `<div class="block-result ${item.is_error ? "error" : ""}">${esc(item.content_preview) || "(empty)"}${item.content_truncated ? " …" : ""}</div>`;
    }
    if (item.type === "image") {
      return `<div class="block-tool"><div class="tool-name">image</div></div>`;
    }
    return "";
  }

  /* ---------- trace ---------- */

  function traceTab(detail) {
    const trace = detail.trace || {};
    const events = [...(trace.events || [])].reverse();
    if (!events.length) {
      return ui.emptyState("◎", "Nothing traced", "No skill, subagent, kill or interruption was recorded in this session.");
    }
    const counts = {};
    events.forEach((event) => { counts[event.k] = (counts[event.k] || 0) + 1; });
    const chips = Object.entries(counts).map(([kind, count]) =>
      `<span class="trace-chip k-${esc(kind)}"><span class="tc-dot"></span>${esc(ui.TRACE_LABELS[kind] || kind)}<b>${count}</b></span>`).join("");
    return `<div class="trace-chips" style="margin-bottom:12px">${chips}</div>
      <div class="card flush"><div class="trace-list">${events.map((event) => `<div class="trace-row">
        <span class="tr-time">${esc(fmt.dayClock(event.t))}</span>
        ${ui.traceChip(event.k)}
        <span class="tr-name">${esc(event.n)}</span>
        <span class="tr-detail">${esc(event.d || "")}</span>
        <span class="tr-ms">${event.ms ? esc(fmt.duration(event.ms)) : ""}${event.e ? ` <span class="badge red">failed</span>` : ""}</span>
      </div>`).join("")}</div></div>
      <div class="section-note">Newest first. Agents show how long they ran until their result came back.</div>`;
  }

  /* ---------- subagents ---------- */

  function subagentsTab(detail) {
    const subagents = detail.subagents || {};
    const calls = subagents.agent_calls || [];
    const events = subagents.events || [];
    if (!calls.length && !events.length) {
      return ui.emptyState("◈", "No subagent activity",
        "This session did not spawn subagents or use the Agent/Task tools.");
    }
    return `${calls.length ? ui.section(`Agent invocations (${calls.length})`, `<div class="card">
        ${calls.map((call) => `<div class="block-tool">
          <div class="tool-name"><span class="cat-dot bg-agent"></span>${esc(call.kind || call.name)}
            <span class="spacer"></span><span class="faint">${esc(fmt.clock(call.ts))}</span></div>
          <div class="tool-input">${esc(call.desc)}</div></div>`).join("")}
      </div>`) : ""}
      ${events.length ? ui.section(`Sidechain messages — last ${events.length} of ${subagents.count}`,
        `<div class="transcript">${events.map(message).join("")}</div>`) : ""}`;
  }

  /* ---------- tasks ---------- */

  function tasksTab(detail) {
    const tasks = detail.tasks || [];
    if (!tasks.length) return ui.emptyState("☑", "No tasks", "No task board was created for this session.");
    const statusClass = { completed: "green", in_progress: "amber", pending: "" };
    const counts = tasks.reduce((acc, task) => {
      const key = task.status || "pending";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return `<div class="tiles" style="margin-bottom:14px">
        ${ui.tile("Tasks", fmt.num(tasks.length), "on this session's board")}
        ${ui.tile("Completed", fmt.num(counts.completed || 0), fmt.pct(100 * (counts.completed || 0) / tasks.length))}
        ${ui.tile("In progress", fmt.num(counts.in_progress || 0), "")}
        ${ui.tile("Pending", fmt.num(counts.pending || 0), "")}
      </div>
      <div class="card flush"><div class="rows">${tasks.map((task) => `
        <div class="row-item" style="cursor:default">
          <div class="ri-main">
            <div class="ri-name">${esc(task.subject || task.description || "task")}</div>
            ${task.description && task.description !== task.subject
              ? `<div class="ri-desc">${esc(task.description)}</div>` : ""}
          </div>
          ${ui.badge(task.status || "pending", statusClass[task.status] || "")}
        </div>`).join("")}</div></div>`;
  }

  /* ---------- workspace ---------- */

  function workspaceTab(detail) {
    const scratchpad = detail.scratchpad || {};
    const files = scratchpad.files || [];
    if (!scratchpad.exists || !files.length) {
      return ui.emptyState("▤", "No workspace files",
        "No scratchpad files for this session, or they have already been cleaned up.");
    }
    return `${ui.section(`${files.length} file${files.length === 1 ? "" : "s"}`,
      `<div class="card flush"><div class="rows">${files.map((file) => `
        <div class="row-item" data-action="preview-file" data-path="${esc(file.path)}">
          <div class="ri-ic">${esc((file.ext || "·").slice(0, 3))}</div>
          <div class="ri-main"><div class="ri-name">${esc(file.name)}</div></div>
          <div class="ri-meta">${fmt.bytes(file.size)}<br>${esc(fmt.rel(file.mtime))}</div>
        </div>`).join("")}</div></div>`,
      { actions: `<button class="btn sm" data-action="open-folder" data-path="${esc(scratchpad.dir)}">Open folder</button>` })}
      <div id="file-preview"></div>`;
  }

  /* ---------- images ---------- */

  function imagesTab(detail) {
    const images = detail.images || [];
    if (!images.length) return ui.emptyState("▣", "No images", "No pasted images are cached for this session.");
    return `<div class="img-grid">${images.map((file) => `
      <figure class="img-card" data-action="open-folder" data-path="${esc(file.path)}"
        data-tip="${esc(file.name)}\n${fmt.bytes(file.size)}">
        <img src="file://${esc(file.path)}" loading="lazy" alt="${esc(file.name)}">
        <figcaption>${esc(file.name)} <span class="faint">${fmt.bytes(file.size)}</span></figcaption>
      </figure>`).join("")}</div>`;
  }

  /* ---------- details ---------- */

  function detailsTab(detail) {
    const history = detail.file_history || {};
    const provider = ASM.scope.currentProvider();
    const resume = provider === "codex" ? `codex resume ${State.sessionId}` : `claude --resume ${State.sessionId}`;
    const goals = detail.goals || {};
    const requests = detail.requests || {};
    const usage = detail.usage || {};
    const analytics = detail.analytics || {};
    const models = Object.entries(detail.usage_by_model || {}).filter(([name]) => name !== "unknown");
    return `<div class="card">
      ${ui.kv([
        ["Session ID", State.sessionId || ""],
        ["Provider", ASM.agentInfo(provider).label],
        ["Transcript", detail.path || ""],
        ["Started", fmt.time(analytics.first_ts)],
        ["Last written", fmt.time(analytics.last_ts)],
        ["Events", `${fmt.num(detail.total_events)} total · ${fmt.num((State.transcript && State.transcript.events.length) || 0)} loaded`],
        ["Tokens", `${fmt.num(usage.input)} input · ${fmt.num(usage.output)} output · ${fmt.num(usage.cache_read)} cache read · ${fmt.num(usage.cache_write)} cache write`],
        ["Models", models.map(([name, value]) => `${fmt.model(name)} (${fmt.tokens(value.total)}${value.cost ? `, ${fmt.cost(value.cost)}` : ""})`).join(", ") || "—"],
        ["Goals set", `${fmt.num(goals.count || 0)}${goals.count ? ` · ${goals.met || 0} met, ${goals.open || 0} open` : ""}`],
        ["Prompts", `${fmt.num(requests.count || 0)}${requests.dropped ? ` (${requests.dropped} older dropped)` : ""}`],
        ["Thinking share", analytics.thinking_chars + analytics.text_chars
          ? fmt.pct(100 * analytics.thinking_chars / (analytics.thinking_chars + analytics.text_chars)) + " of generated text" : "—"],
        ["File checkpoints", `${history.count || 0} snapshots · ${fmt.bytes(history.bytes)}`],
        ["Resume", resume],
      ])}
      <div class="row wrap" style="margin-top:14px">
        <button class="btn" data-action="open-jsonl">Open transcript in editor</button>
        ${history.count ? `<button class="btn" data-action="open-folder" data-path="${esc(history.dir)}">Open checkpoints</button>` : ""}
        <button class="btn" data-action="copy-resume">Copy resume command</button>
      </div></div>`;
  }

  /** Session-scoped actions the summary's findings can trigger. */
  async function handle(action, element) {
    if (State.view !== "session") return false;
    switch (action) {
      case "prompt-open": {
        State.tab = "timeline";
        State.promptIndex = Number(element.dataset.id);
        State.goalIndex = null;
        ASM.router.renderTab();
        return true;
      }
      default:
        return false;
    }
  }

  ASM.views = ASM.views || {};
  ASM.views.session = { render, header, tabBody, mountTab, message, isNoise, handle };
})(window.ASM = window.ASM || {});
