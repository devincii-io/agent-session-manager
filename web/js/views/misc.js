/* ============================================================
   The smaller views: memory, global search, and the file preview
   panels shared by Workspace and the config editors.
   ============================================================ */

(function (ASM) {
  "use strict";

  const { esc, fmt } = ASM.util;
  const ui = ASM.ui;
  const State = ASM.state;

  /* ---------- memory ---------- */

  function memoryView() {
    const memory = State.memory;
    if (!memory) return ui.skeleton("Loading memory…");
    const files = memory.files || [];
    const active = State._memFile;
    return `
      <div class="page-head"><div class="ph-title"><h1>Memory</h1>
        <div class="ph-sub mono">${esc(memory.dir)}</div></div>
        <div class="page-actions"><button class="btn sm" data-action="open-folder" data-path="${esc(memory.dir)}">Open folder</button></div></div>
      ${memory.index ? ui.section("MEMORY.md · index", `<div class="card"><pre class="code">${esc(memory.index)}</pre></div>`) : ""}
      ${ui.section(`${files.length} memory file${files.length === 1 ? "" : "s"}`, `<div class="card flush"><div class="rows">
        ${files.map((file) => `
          <div class="row-item ${active === file.path ? "active" : ""}" data-action="mem-file" data-path="${esc(file.path)}">
            <div class="ri-ic">◇</div>
            <div class="ri-main"><div class="ri-name">${esc(file.title)} ${file.type ? ui.badge(file.type) : ""}</div>
              <div class="ri-desc">${esc(file.description || file.name)}</div></div>
            <div class="ri-meta">${fmt.bytes(file.size)}</div>
          </div>`).join("") || `<div class="sb-empty">No memory files yet.</div>`}
      </div></div>`)}
      <div id="mem-editor"></div>`;
  }

  function memoryEditor(path) {
    const file = (State.memory.files || []).find((entry) => entry.path === path);
    if (!file) return "";
    const readonly = State.memory.source_writable === false;
    return ui.section(file.name,
      `<textarea class="editor" id="mem-textarea" spellcheck="false" ${readonly ? "readonly" : ""}>${esc(file.content)}</textarea>`,
      { actions: readonly
        ? ui.badge("WSL read-only")
        : `<button class="btn sm primary" data-action="mem-save" data-path="${esc(path)}">Save</button>
           <button class="btn sm danger" data-action="mem-delete" data-path="${esc(path)}">Delete</button>` });
  }

  /* ---------- global search ---------- */

  function searchView() {
    const results = State.searchResults;
    if (!results) return ui.skeleton("Searching every session and prompt…");
    const sessions = results.sessions || [];
    const prompts = results.prompts || [];
    return `
      <div class="page-head"><div class="ph-title"><h1>Search</h1>
        <div class="ph-sub">“${esc(State.searchQuery)}” · ${sessions.length} session${sessions.length === 1 ? "" : "s"}
          · ${prompts.length} prompt${prompts.length === 1 ? "" : "s"} · Esc to clear</div></div></div>
      ${sessions.length ? ui.section("Sessions", `<div class="card flush"><div class="rows">
        ${sessions.map((item) => `
          <div class="row-item" data-action="open-session" data-pid="${esc(item.project_id)}" data-sid="${esc(item.session_id)}">
            <div class="ri-ic">◈</div>
            <div class="ri-main"><div class="ri-name">${esc(item.title || item.session_id)}</div>
              <div class="ri-desc">${esc(item.project_name)} · ${esc(fmt.rel(item.mtime))} ${ui.providerBadge(item.provider)}</div></div>
            <div class="ri-meta">${item.provider === "codex" ? "" : fmt.cost(item.cost)}</div>
          </div>`).join("")}</div></div>`) : ""}
      ${prompts.length ? ui.section("Prompt history", `<div class="card flush"><div class="rows">
        ${prompts.map((item) => `
          <div class="row-item" data-action="open-session" data-pid="${esc(item.project_id)}" data-sid="${esc(item.session_id)}">
            <div class="ri-ic">›_</div>
            <div class="ri-main"><div class="ri-name" style="font-weight:400">${esc(item.display)}</div>
              <div class="ri-desc">${esc(item.project_name)} · ${esc(fmt.rel(item.timestamp))}</div></div>
          </div>`).join("")}</div></div>`) : ""}
      ${!sessions.length && !prompts.length
        ? ui.emptyState("○", "No matches", "Nothing found across sessions or prompt history.") : ""}`;
  }

  /* ---------- file panels ---------- */

  async function previewFile(path) {
    const box = document.getElementById("file-preview");
    if (!box) return;
    box.innerHTML = ui.skeleton("Loading…");
    const result = await ASM.api.call("readFile", path);
    if (!result || !result.ok) { box.innerHTML = `<div class="faint">Could not read this file.</div>`; return; }
    box.innerHTML = ui.section(String(path).split(/[\\/]/).pop(),
      `<div class="card"><pre class="code">${esc(result.content)}${result.truncated ? "\n… (truncated)" : ""}</pre></div>`,
      { actions: `<button class="btn sm" data-action="open-editor" data-path="${esc(path)}">Open externally</button>` });
  }

  async function openConfigFile(path) {
    State._cfgFile = path;
    ASM.util.dom.all(".cfg-file").forEach((element) =>
      element.classList.toggle("active", element.dataset.path === path));
    const box = document.getElementById("cfg-editor");
    if (!box) return;
    box.innerHTML = ui.skeleton("Loading…");
    const result = await ASM.api.call("readFile", path);
    if (!result || !result.ok) { box.innerHTML = `<div class="faint">Could not read this file.</div>`; return; }
    box.innerHTML = `<div class="section-title" style="margin-bottom:8px">
        <span class="mono">${esc(String(path).split(/[\\/]/).pop())}</span>
        <span class="st-actions">
          <button class="btn sm primary" data-action="cfg-save" data-path="${esc(path)}" ${result.truncated ? "disabled" : ""}>Save</button>
          <button class="btn sm" data-action="open-editor" data-path="${esc(path)}">Open externally</button></span></div>
      <textarea class="editor" id="cfg-textarea" spellcheck="false" ${result.truncated ? "readonly" : ""}>${esc(result.content)}</textarea>
      ${result.truncated ? `<div class="truncated-note">This file is large — editing it here would truncate it. Use “Open externally”.</div>` : ""}`;
  }

  async function saveConfigFile(path) {
    const box = document.getElementById("cfg-textarea");
    if (!box) return;
    const project = ASM.scope.currentProject();
    const result = State.agent === "codex"
      ? await ASM.api.call("writeCodexFile", path, box.value, (project && project.path) || "")
      : await ASM.api.call("writeClaudeFile", path, box.value);
    ASM.toast(result && result.ok
      ? `Saved ${String(path).split(/[\\/]/).pop()}`
      : ((result && result.error) || "Save failed"), result && result.ok ? "ok" : "err");
  }

  async function saveMemory(path) {
    const box = document.getElementById("mem-textarea");
    if (!box) return;
    const result = await ASM.api.call("saveMemory", path, box.value);
    ASM.toast(result && result.ok ? "Saved" : "Save failed", result && result.ok ? "ok" : "err");
  }

  function confirmDeleteMemory(path) {
    ASM.confirm("Delete this memory file?",
      "It is permanently removed from disk and Claude will not recall it again.",
      async () => {
        const result = await ASM.api.call("deleteMemory", path);
        if (result && result.ok) {
          ASM.toast("Deleted", "ok");
          State._memFile = null;
          await ASM.router.loadMemory(State.projectId);
        } else ASM.toast("Delete failed", "err");
      });
  }

  ASM.views = ASM.views || {};
  ASM.views.misc = {
    memoryView, memoryEditor, searchView, previewFile,
    openConfigFile, saveConfigFile, saveMemory, confirmDeleteMemory,
  };
})(window.ASM = window.ASM || {});
