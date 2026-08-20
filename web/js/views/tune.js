/* ============================================================
   Instructions — put your own signed-in Claude to work on your own
   history, either to refine a CLAUDE.md or to distil sessions into
   memory notes.

   Two things are load-bearing and stated in the UI: it runs the local
   `claude` CLI (so nothing leaves the machine beyond an ordinary
   Claude request), and it sends *session summaries*, never full
   transcripts.
   ============================================================ */

(function (ASM) {
  "use strict";

  const { esc, fmt } = ASM.util;
  const ui = ASM.ui;
  const State = ASM.state;

  function projectById(id) { return State.projects.find((project) => project.id === id); }

  /** The sessions handed to the assistant as context: recent-first, capped. */
  function contextItems() {
    const tune = State.tune;
    let pool = (tune.sessions || []).filter((session) => session.assistant_messages > 0);
    if (tune.mode === "memory" || tune.scope === "project") {
      pool = pool.filter((session) => session.project_id === tune.projectId);
    }
    return [...pool].sort((a, b) => b.mtime - a.mtime).slice(0, 60);
  }

  function projectSelect(tune) {
    const options = State.projects.map((project) =>
      `<option value="${esc(project.id)}" ${project.id === tune.projectId ? "selected" : ""}>${esc(project.name)}</option>`).join("");
    return `<select class="picker" data-tune="project">${options || `<option value="">No projects</option>`}</select>`;
  }

  function status(tune) {
    if (tune.busy) {
      return `<div class="tune-status"><span class="spinner"></span>
        Running <span class="mono">claude</span> over your history — this can take a while…
        <span class="spacer"></span><button class="btn sm" data-action="tune-cancel">Cancel</button></div>`;
    }
    if (tune.error) return `<div class="tune-err">${esc(tune.error)}</div>`;
    return "";
  }

  function guidanceForm(tune) {
    const count = contextItems().length;
    const project = tune.scope === "project" ? projectById(tune.projectId) : null;
    const where = tune.scope === "global" ? "every project on this machine" : (project ? project.name : "this project");
    const guidance = tune.guidance || {};
    const scopeChip = (key, label) =>
      `<button class="chip ${tune.scope === key ? "on" : ""}" data-action="tune-scope" data-scope="${key}">${label}</button>`;
    const canRun = !tune.busy && count > 0 && (tune.scope === "global" || !!project);

    return `<div class="tune-form">
      <div class="fld">
        <label class="fld-label">Target file</label>
        <div class="row wrap">${scopeChip("global", "Global · ~/.claude")}${scopeChip("project", "A project")}
          ${tune.scope === "project" ? projectSelect(tune) : ""}</div>
        <div class="tune-hint mono">${esc(guidance.path || (tune.scope === "project" ? "select a project" : "~/.claude/CLAUDE.md"))}
          · ${guidance.exists ? `${(guidance.content || "").length} chars now` : "none yet — it will be created"}</div>
      </div>
      <div class="fld">
        <label class="fld-label">Instruction <span class="faint">(optional)</span></label>
        <textarea class="tune-ta" id="tune-instruction" spellcheck="false"
          placeholder="Leave blank to let Claude fold in durable conventions and drop anything stale. Or steer it: “Emphasise our testing setup; remove the old build notes.”">${esc(tune.instruction || "")}</textarea>
      </div>
      <div class="tune-hint">Context: the <b>${count}</b> most recent session${count === 1 ? "" : "s"} in ${esc(where)} — summaries only, never full transcripts.</div>
      <div><button class="btn primary" data-action="tune-run" ${canRun ? "" : "disabled"}>
        ${tune.busy ? "Working…" : "Generate CLAUDE.md"}</button></div>
      ${status(tune)}
      ${tune.proposal != null ? proposal(tune, guidance) : ""}
    </div>`;
  }

  function proposal(tune, guidance) {
    const project = tune.scope === "project" ? projectById(tune.projectId) : null;
    return ui.section("Proposed CLAUDE.md", `
      <textarea class="editor" id="tune-proposal" spellcheck="false">${esc(tune.proposal)}</textarea>
      <div class="tune-hint">Writes to <span class="mono">${esc(guidance.path || (project ? project.path + "/CLAUDE.md" : ""))}</span>${tune.cost ? ` · this run cost ${fmt.cost(tune.cost)}` : ""}. Edit freely before saving.</div>`,
      { actions: `<button class="btn sm primary" data-action="tune-save">Save${guidance.exists ? " (overwrite)" : ""}</button>
        <button class="btn sm" data-action="tune-run">Regenerate</button>` });
  }

  function memoryForm(tune) {
    const project = projectById(tune.projectId);
    const count = contextItems().length;
    const canRun = !tune.busy && !!project && count > 0;
    return `<div class="tune-form">
      <div class="fld">
        <label class="fld-label">Project to distil into memory</label>
        <div class="row">${projectSelect(tune)}</div>
        <div class="tune-hint">Notes are written to this project's memory store
          (<span class="mono">${esc(project ? project.name : "—")}/memory</span>) and indexed in its MEMORY.md.</div>
      </div>
      <div class="tune-hint">Context: the <b>${count}</b> most recent session${count === 1 ? "" : "s"} in
        ${esc(project ? project.name : "—")} — summaries only.</div>
      <div><button class="btn primary" data-action="tune-run" ${canRun ? "" : "disabled"}>
        ${tune.busy ? "Distilling…" : "Distil memory notes"}</button></div>
      ${status(tune)}
      ${tune.notes != null ? notes(tune) : ""}
    </div>`;
  }

  function notes(tune) {
    if (!tune.notes.length) {
      return `<div class="tune-hint" style="margin-top:14px">Claude found nothing durable worth saving from these sessions.</div>`;
    }
    const chosen = tune.notes.filter((_, index) => tune.noteSel.has(index)).length;
    return ui.section(`${tune.notes.length} proposed note${tune.notes.length === 1 ? "" : "s"}`,
      `${tune.notes.map((note, index) => {
        const on = tune.noteSel.has(index);
        return `<div class="note-card ${on ? "" : "off"}" data-action="tune-note-toggle" data-i="${index}">
          <input type="checkbox" class="chk" ${on ? "checked" : ""} tabindex="-1">
          <div class="nc-main">
            <div class="note-name">${esc(note.name)} ${note.type ? ui.badge(note.type) : ""}</div>
            ${note.description ? `<div class="note-desc">${esc(note.description)}</div>` : ""}
            <div class="note-body">${esc(note.body)}</div>
          </div></div>`;
      }).join("")}
      ${tune.cost ? `<div class="tune-hint">This run cost ${fmt.cost(tune.cost)}.</div>` : ""}`,
      { actions: `<button class="btn sm primary" data-action="tune-write-notes" ${chosen ? "" : "disabled"}>Write ${chosen} to memory</button>` });
  }

  function render() {
    if (State.agent === "codex") {
      return `<div class="page-head"><div class="ph-title"><h1>Instructions</h1>
          <div class="ph-sub">Codex reads durable guidance from AGENTS.md.</div></div>
          <div class="page-actions"><button class="btn sm" data-action="open-agents">Open AGENTS.md</button></div></div>
        ${ui.notice(`<strong>Agent-specific by design.</strong> CLAUDE.md and AGENTS.md are not automatically
          synchronised, because their semantics can differ.`)}
        ${ui.section("Edit Codex guidance", `<div class="card">
          <p>Use the Codex settings view to edit the global or project <span class="mono">AGENTS.md</span> with automatic backups.</p>
          <button class="btn primary" style="margin-top:10px" data-action="goto-codex-settings">Open Codex settings</button></div>`)}`;
    }
    if (State.agent === "all") {
      return ui.emptyState("I", "Choose an agent",
        "Instructions stay separate. Select Claude for CLAUDE.md, or Codex for AGENTS.md.");
    }
    const tune = State.tune;
    if (!tune) return ui.skeleton("Loading…");
    if (tune.source_readonly) {
      return ui.emptyState("R", "Select Windows to tune instructions",
        "WSL histories can be browsed and measured, but instruction and memory writes stay read-only there.");
    }
    const modeChip = (key, label) =>
      `<button class="chip ${tune.mode === key ? "on" : ""}" data-action="tune-mode" data-mode="${key}">${label}</button>`;
    return `
      <div class="page-head"><div class="ph-title"><h1>Claude instructions</h1>
        <div class="ph-sub">Put your own signed-in Claude to work on your history — refine CLAUDE.md, or distil sessions
          into memory. Runs the local <span class="mono">claude</span> CLI; nothing leaves your machine beyond a normal Claude request.</div></div></div>
      <div class="seg">${modeChip("guidance", "Refine CLAUDE.md")}${modeChip("memory", "Consolidate → memory")}</div>
      ${tune.mode === "guidance" ? guidanceForm(tune) : memoryForm(tune)}`;
  }

  /** Persist whatever is in the instruction box before any re-render wipes it. */
  function syncInstruction() {
    const box = document.getElementById("tune-instruction");
    if (box && State.tune) State.tune.instruction = box.value;
  }

  async function refreshGuidance() {
    const tune = State.tune;
    if (!tune || tune.mode !== "guidance") return;
    const project = tune.scope === "project" ? projectById(tune.projectId) : null;
    const path = project ? (project.path || "") : "";
    if (tune.scope === "project" && !path) {
      tune.guidance = { exists: false, content: "", path: "" };
      return;
    }
    tune.guidance = await ASM.api.call("getGuidance", tune.scope, path);
  }

  async function run() {
    const tune = State.tune;
    if (!tune || tune.busy) return;
    syncInstruction();
    const items = contextItems().map((session) => ({
      project_id: session.project_id, session_id: session.session_id,
    }));
    if (!items.length) { ASM.toast("No sessions to learn from", "err"); return; }

    tune.busy = true;
    tune.error = null;
    tune.proposal = null;
    tune.notes = null;
    tune.cost = 0;

    let request;
    if (tune.mode === "memory") {
      const project = projectById(tune.projectId);
      if (!project) { tune.busy = false; ASM.toast("Pick a project", "err"); return; }
      request = { kind: "consolidate", sessions: items, project_id: tune.projectId, project_name: project.name };
    } else {
      const project = tune.scope === "project" ? projectById(tune.projectId) : null;
      request = {
        kind: "tune", scope: tune.scope, sessions: items, instruction: tune.instruction,
        current_md: (tune.guidance && tune.guidance.content) || "",
        project_name: project ? project.name : "",
      };
    }
    ASM.router.renderMain();
    const result = await ASM.api.call("startAssistant", JSON.stringify(request));
    if (!result || !result.ok) {
      tune.busy = false;
      tune.error = (result && result.error) || "Could not start the claude CLI.";
      ASM.router.renderMain();
      return;
    }
    tune.jobId = result.job_id;
  }

  /** The async result of a startAssistant job, pushed by the bridge. */
  function onEvent(payload) {
    let result;
    try { result = typeof payload === "string" ? JSON.parse(payload) : payload; } catch { return; }
    const tune = State.tune;
    if (!tune || !result || result.job_id !== tune.jobId) return;   // stale, or the user moved on
    tune.busy = false;
    tune.jobId = null;
    tune.cost = result.cost || 0;
    if (!result.ok) {
      tune.error = result.error || "The assistant failed.";
      ASM.router.renderMain();
      ASM.toast("Assistant error", "err");
      return;
    }
    if (result.kind === "consolidate") {
      tune.notes = result.notes || [];
      tune.noteSel = new Set(tune.notes.map((_, index) => index));
    } else {
      tune.proposal = result.text || "";
      if (!tune.proposal) tune.error = "The assistant returned an empty document.";
    }
    ASM.router.renderMain();
  }

  async function save() {
    const tune = State.tune;
    const box = document.getElementById("tune-proposal");
    const content = box ? box.value : (tune.proposal || "");
    if (!content.trim()) { ASM.toast("Nothing to save", "err"); return; }
    const project = tune.scope === "project" ? projectById(tune.projectId) : null;
    const result = await ASM.api.call("saveGuidance", tune.scope, content, project ? (project.path || "") : "");
    if (result && result.ok) {
      ASM.toast(`Saved ${result.path.split(/[\\/]/).pop()}${result.backup ? " · previous version backed up" : ""}`, "ok");
      tune.guidance = { ok: true, exists: true, path: result.path, content };
      tune.proposal = null;
      ASM.router.renderMain();
    } else {
      ASM.toast(result && result.error ? `Save failed: ${result.error}` : "Save failed", "err");
    }
  }

  async function writeNotes() {
    const tune = State.tune;
    const chosen = (tune.notes || []).filter((_, index) => tune.noteSel.has(index));
    if (!chosen.length) { ASM.toast("No notes selected", "err"); return; }
    const result = await ASM.api.call("writeMemoryNotes", tune.projectId, JSON.stringify(chosen));
    if (result && result.ok) {
      ASM.toast(`Wrote ${result.count} note${result.count === 1 ? "" : "s"} to memory`, "ok");
      tune.notes = null;
      tune.noteSel = new Set();
      ASM.router.renderMain();
      await ASM.router.loadOverview();
    } else ASM.toast("Write failed", "err");
  }

  async function handle(action, element) {
    const tune = State.tune;
    switch (action) {
      case "tune-mode":
        if (!tune || tune.busy || tune.mode === element.dataset.mode) return true;
        syncInstruction();
        tune.mode = element.dataset.mode;
        tune.error = null;
        await refreshGuidance();
        ASM.router.renderMain();
        return true;
      case "tune-scope":
        if (!tune || tune.busy || tune.scope === element.dataset.scope) return true;
        syncInstruction();
        tune.scope = element.dataset.scope;
        tune.proposal = null;
        tune.error = null;
        await refreshGuidance();
        ASM.router.renderMain();
        return true;
      case "tune-run": run(); return true;
      case "tune-save": save(); return true;
      case "tune-write-notes": writeNotes(); return true;
      case "tune-cancel": {
        if (!tune || !tune.jobId) return true;
        const result = await ASM.api.call("cancelAssistant", tune.jobId);
        tune.busy = false;
        tune.jobId = null;
        tune.error = result && result.ok ? "Cancelled." : ((result && result.error) || "Could not cancel the job.");
        ASM.router.renderMain();
        return true;
      }
      case "tune-note-toggle": {
        const index = Number(element.dataset.i);
        if (tune.noteSel.has(index)) tune.noteSel.delete(index);
        else tune.noteSel.add(index);
        ASM.router.renderMain();
        return true;
      }
      default: return false;
    }
  }

  ASM.views = ASM.views || {};
  ASM.views.tune = { render, handle, onEvent, refreshGuidance, contextItems, syncInstruction };
})(window.ASM = window.ASM || {});
