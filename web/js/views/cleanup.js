/* ============================================================
   Cleanup — reclaiming disk without losing anything you wanted.

   Two independent inventories: transcripts, and the assets around
   them (uploads, image cache, file history, tasks, session-env,
   scratchpads). They are separate because deleting a 40 MB image
   cache and deleting a session are not the same decision.

   Claude transcripts are deleted. Codex sessions are archived
   through the Codex CLI, which reclaims nothing — the UI says so
   rather than reporting bytes that never came back.
   ============================================================ */

(function (ASM) {
  "use strict";

  const { esc, fmt, dom } = ASM.util;
  const ui = ASM.ui;
  const scope = ASM.scope;
  const State = ASM.state;

  function record(session) {
    return {
      provider: session.provider || State.agent,
      source_id: session.source_id,
      pid: session.project_id,
      sid: session.session_id,
      title: session.title,
      cost: session.cost,
      bytes: (session.size_bytes || 0) + (session.extra_bytes || 0),
    };
  }

  function locked(session) {
    return !!session.protected || !!session.archived
      || (session.provider === "claude" && !session.source_writable);
  }

  function filteredSessions() {
    const filters = State.cleanupFilters;
    const query = filters.query.trim().toLowerCase();
    const list = ((State.cleanup && State.cleanup.sessions) || []).filter((session) => {
      const bytes = (session.size_bytes || 0) + (session.extra_bytes || 0);
      const ageDays = (Date.now() - (session.mtime || 0) * 1000) / 86400000;
      const haystack = `${session.title || ""} ${session.project_name || ""} ${session.project_path || ""} ${session.session_id || ""}`.toLowerCase();
      if (query && !haystack.includes(query)) return false;
      if (filters.age && ageDays < filters.age) return false;
      if (filters.minSize && bytes < filters.minSize) return false;
      if (filters.maxTurns >= 0 && (session.assistant_messages || 0) > filters.maxTurns) return false;
      if (filters.state === "active" && session.archived) return false;
      if (filters.state === "archived" && !session.archived) return false;
      if (filters.state === "cleanable" && locked(session)) return false;
      if (filters.asset && !(session.asset_bytes && session.asset_bytes[filters.asset] > 0)) return false;
      return true;
    });
    if (State.cleanupSort === "age") list.sort((a, b) => a.mtime - b.mtime);
    else if (State.cleanupSort === "cost") list.sort((a, b) => b.cost - a.cost);
    else list.sort((a, b) => (b.size_bytes + b.extra_bytes) - (a.size_bytes + a.extra_bytes));
    return list;
  }

  function filteredAssets() {
    const filters = State.cleanupFilters;
    const query = filters.query.trim().toLowerCase();
    return [...((State.assets && State.assets.items) || [])].filter((item) => {
      const ageDays = (Date.now() - (item.mtime || 0) * 1000) / 86400000;
      const haystack = `${item.kind} ${item.project_name || ""} ${item.title || ""} ${item.session_id || ""}`.toLowerCase();
      return (!query || haystack.includes(query))
        && (!filters.age || ageDays >= filters.age)
        && (!filters.minSize || item.size_bytes >= filters.minSize)
        && (!filters.asset || item.kind === filters.asset)
        && (filters.state !== "orphaned" || item.orphaned);
    }).sort((a, b) => b.size_bytes - a.size_bytes);
  }

  function applyPreset(id) {
    const filters = { query: "", age: 0, minSize: 0, maxTurns: -1, state: "active", asset: "" };
    if (id === "stale") filters.age = 30;
    if (id === "large") filters.minSize = 10e6;
    if (id === "empty") filters.maxTurns = 0;
    if (id === "media") filters.asset = "images";
    if (id === "archived") filters.state = "archived";
    State.cleanupFilters = filters;
    State.cleanupFilterSets.sessions = filters;
  }

  /* ---------- markup ---------- */

  function filterGrid(mode) {
    const filters = State.cleanupFilters;
    const option = (value, label, current) =>
      `<option value="${esc(value)}" ${String(current) === String(value) ? "selected" : ""}>${esc(label)}</option>`;
    return `<div class="filter-grid">
      <input class="s-input" data-clean-filter="query" value="${esc(filters.query)}"
        placeholder="${mode === "assets" ? "Category, project or session" : "Title, project, path or ID"}">
      <select class="picker" data-clean-filter="age">
        ${option(0, "Any age", filters.age)}${option(7, "Inactive 7d+", filters.age)}
        ${option(30, "Inactive 30d+", filters.age)}${option(90, "Inactive 90d+", filters.age)}</select>
      <select class="picker" data-clean-filter="minSize">
        ${option(0, "Any size", filters.minSize)}${option(100000, "100 KB+", filters.minSize)}
        ${option(1000000, "1 MB+", filters.minSize)}${option(10000000, "10 MB+", filters.minSize)}</select>
      ${mode === "assets" ? `<select class="picker" data-clean-filter="asset">
          <option value="">All categories</option>
          ${["uploads", "legacy_images", "file_history", "tasks", "session_env", "scratchpad"]
            .map((kind) => option(kind, kind.replace(/_/g, " "), filters.asset)).join("")}</select>
        <select class="picker" data-clean-filter="state">
          ${option("all", "All states", filters.state)}${option("orphaned", "Orphaned only", filters.state)}</select>`
        : `<select class="picker" data-clean-filter="state">
          ${option("active", "Active library", filters.state)}${option("cleanable", "Cleanable", filters.state)}
          ${option("archived", "Archived Codex", filters.state)}${option("all", "All states", filters.state)}</select>
        <select class="picker" data-clean-filter="maxTurns">
          ${option(-1, "Any turns", filters.maxTurns)}${option(0, "No assistant reply", filters.maxTurns)}
          ${option(2, "2 turns or fewer", filters.maxTurns)}</select>`}
    </div>`;
  }

  function modeTabs() {
    return `<div class="seg">
      <button class="chip ${State.cleanupMode === "sessions" ? "on" : ""}" data-action="cleanup-mode" data-mode="sessions">Sessions</button>
      <button class="chip ${State.cleanupMode === "assets" ? "on" : ""}" data-action="cleanup-mode" data-mode="assets">Assets &amp; images</button>
    </div>`;
  }

  function sessionRow(session) {
    const selected = scope.isSelected(session.project_id, session.session_id, session.provider, session.source_id);
    const isLocked = locked(session);
    const bytes = (session.size_bytes || 0) + (session.extra_bytes || 0);
    const tags = [];
    if (session.active) tags.push(`<span class="badge green"><span class="dot-active"></span> live</span>`);
    if (session.has_subagents) tags.push(ui.badge("subagents", "violet"));
    if (session.archived) tags.push(ui.badge("archived"));
    tags.push(ui.providerBadge(session.provider));
    tags.push(ui.sourceBadge(session));
    const reason = session.archived ? "Already archived"
      : (session.provider === "claude" && !session.source_writable) ? "WSL Claude cleanup is inspection-only"
      : "Recently active — protected for ten minutes";
    return `<div class="clean-row ${selected ? "sel" : ""} ${isLocked ? "live" : ""}"
        data-action="cleanup-row" data-provider="${esc(session.provider || State.agent)}"
        data-source="${esc(session.source_id || "")}" data-pid="${esc(session.project_id)}"
        data-sid="${esc(session.session_id)}">
      ${isLocked ? `<span class="chk-lock" title="${esc(reason)}">🔒</span>`
        : `<input type="checkbox" class="chk" ${selected ? "checked" : ""} tabindex="-1">`}
      <div class="cr-main">
        <div class="cr-title">${esc(session.title)}</div>
        <div class="cr-meta"><span class="cr-proj">${esc(session.project_name)}</span>
          <span>${session.assistant_messages} turns</span><span>${session.tool_calls} tools</span>
          <span>${esc(fmt.rel(session.mtime))}</span>${tags.join("")}</div>
      </div>
      <div class="cr-nums">
        ${session.provider === "codex"
          ? `<span class="faint">archive · 0 B reclaimed</span>`
          : `<span class="p-cost">${fmt.cost(session.cost)}</span>`}
        <span class="cr-size">${fmt.bytes(bytes)}</span>
      </div></div>`;
  }

  function selectionBar() {
    const totals = scope.selectionTotals();
    if (!totals.count) return "";
    return `<div class="sel-bar">
      <div class="sb-info"><b>${totals.count}</b> selected · <b>${fmt.bytes(totals.bytes)}</b> indexed</div>
      <button class="btn sm" data-action="sel-clear">Clear</button>
      <button class="btn sm primary" data-action="bulk-delete">Clean up ${totals.count} session${totals.count === 1 ? "" : "s"}</button>
    </div>`;
  }

  function sessionsView() {
    const inventory = State.cleanup;
    const all = filteredSessions();
    const shown = all.slice(0, State.cleanupLimit);
    const totals = scope.selectionTotals();
    const selected = [...State.sel.values()];
    const reclaim = selected.filter((item) => item.provider === "claude").reduce((sum, item) => sum + item.bytes, 0);
    const archived = selected.filter((item) => item.provider === "codex").reduce((sum, item) => sum + item.bytes, 0);
    const safeCount = all.filter((session) => !locked(session)).length;
    const sortChip = (key, label) =>
      `<button class="chip ${State.cleanupSort === key ? "on" : ""}" data-action="cleanup-sort" data-sort="${key}">${label}</button>`;

    return `
      <div class="page-head">
        <div class="ph-title"><h1>Cleanup</h1>
          <div class="ph-sub">Claude transcripts are deleted. Codex sessions are archived through its own CLI and stay recoverable. Anything written to in the last ten minutes is protected.</div></div>
      </div>
      <div class="tiles">
        ${ui.tile("Sessions", fmt.num(inventory.sessions.length), fmt.bytes(inventory.total_bytes) + " on disk",
          { tip: "Every transcript plus its tasks, file history, images and session-env" })}
        ${ui.tile("Selected", fmt.num(totals.count), fmt.bytes(totals.bytes) + " indexed", { accent: !!totals.count })}
        ${ui.tile("Will be deleted", fmt.bytes(reclaim), reclaim ? "Claude storage" : "nothing selected", { accent: !!reclaim })}
        ${ui.tile("Will be archived", fmt.bytes(archived), archived ? "Codex stays on disk" : "nothing selected")}
      </div>
      <div class="section">
        ${modeTabs()}
        ${filterGrid("sessions")}
        <div class="cleanup-toolbar">
          <span class="tb-label">Views</span>
          <button class="chip" data-action="cleanup-view" data-view="stale">Stale 30d+</button>
          <button class="chip" data-action="cleanup-view" data-view="large">Large 10 MB+</button>
          <button class="chip" data-action="cleanup-view" data-view="empty">No reply</button>
          <button class="chip" data-action="cleanup-view" data-view="media">Has media</button>
          ${State.agent !== "claude" ? `<button class="chip" data-action="cleanup-view" data-view="archived">Archived</button>` : ""}
          <button class="chip" data-action="select-filtered">Select ${safeCount} matching safe</button>
          <button class="chip" data-action="sel-clear">None</button>
          <span class="tb-label" style="margin-left:auto">Sort</span>
          ${sortChip("size", "Size")}${sortChip("age", "Age")}${State.agent === "claude" ? sortChip("cost", "Cost") : ""}
        </div>
        <div class="clean-list">
          ${shown.map(sessionRow).join("") || `<div class="sb-empty">No sessions match these filters.</div>`}
          ${all.length > shown.length
            ? `<button class="btn" data-action="cleanup-more" style="width:100%;justify-content:center;border-radius:0">Show 300 more · ${all.length - shown.length} remaining</button>`
            : ""}
        </div>
      </div>
      ${selectionBar()}`;
  }

  function assetsView() {
    if (!State.assets) return ui.skeleton("Inventorying images and agent storage…");
    const all = filteredAssets();
    const shown = all.slice(0, State.cleanupLimit);
    const selected = [...State.assetSel.values()];
    const bytes = selected.reduce((sum, item) => sum + item.size_bytes, 0);
    const safe = all.filter((item) => !item.protected && item.source_writable);

    return `
      <div class="page-head">
        <div class="ph-title"><h1>Assets &amp; images</h1>
          <div class="ph-sub">Clean storage categories independently of transcripts. Recent data stays protected for ten minutes.</div></div>
      </div>
      <div class="tiles">
        ${ui.tile("Asset groups", fmt.num((State.assets.items || []).length), fmt.bytes(State.assets.total_bytes),
          { tip: "Uploads, legacy images, file history, tasks, environments and scratchpads" })}
        ${ui.tile("Matching", fmt.num(all.length), fmt.bytes(all.reduce((sum, item) => sum + item.size_bytes, 0)))}
        ${ui.tile("Selected", fmt.num(selected.length), fmt.bytes(bytes) + " reclaimable", { accent: !!selected.length })}
      </div>
      <div class="section">
        ${modeTabs()}
        ${filterGrid("assets")}
        <div class="cleanup-toolbar">
          <button class="chip" data-action="select-assets">Select ${safe.length} matching safe</button>
          <button class="chip" data-action="asset-clear">None</button>
          <span class="faint">WSL Claude assets are visible but read-only.</span>
        </div>
        <div class="clean-list">${shown.map((item) => {
          const key = `${item.source_id}␟${item.path}`;
          const on = State.assetSel.has(key);
          const isLocked = item.protected || !item.source_writable;
          return `<div class="clean-row ${on ? "sel" : ""} ${isLocked ? "readonly" : ""}" data-action="asset-row" data-key="${esc(key)}">
            ${isLocked ? `<span class="chk-lock" title="Protected or read-only">🔒</span>`
              : `<input type="checkbox" class="chk" ${on ? "checked" : ""} tabindex="-1">`}
            <div class="cr-main">
              <div class="cr-title">${esc(item.kind.replace(/_/g, " "))}
                ${item.orphaned ? ui.badge("orphaned") : ""} ${ui.sourceBadge(item)}</div>
              <div class="cr-meta"><span>${esc(item.project_name)}</span>
                <span>${item.file_count} files</span><span>${esc(fmt.rel(item.mtime))}</span></div>
            </div>
            <div class="cr-nums"><span class="cr-size">${fmt.bytes(item.size_bytes)}</span></div></div>`;
        }).join("") || `<div class="sb-empty">No assets match these filters.</div>`}
        ${all.length > shown.length
          ? `<button class="btn" data-action="cleanup-more" style="width:100%;justify-content:center;border-radius:0">Show 300 more · ${all.length - shown.length} remaining</button>`
          : ""}</div>
      </div>
      ${selected.length ? `<div class="sel-bar">
        <div class="sb-info"><b>${selected.length}</b> groups · <b>${fmt.bytes(bytes)}</b> permanent reclaim</div>
        <button class="btn sm" data-action="asset-clear">Clear</button>
        <button class="btn sm primary danger" data-action="asset-delete">Delete selected assets</button></div>` : ""}`;
  }

  function render() {
    if (!State.cleanup) return ui.skeleton("Scanning every session on disk…");
    return State.cleanupMode === "assets" ? assetsView() : sessionsView();
  }

  /* ---------- actions ---------- */

  function confirmBulkDelete() {
    const totals = scope.selectionTotals();
    if (!totals.count) return;
    const items = scope.selectionItems();
    const hasClaude = items.some((item) => item.provider === "claude");
    const hasCodex = items.some((item) => item.provider === "codex");
    const extra = hasClaude
      ? `<label class="checkbox-row"><input type="checkbox" class="chk" id="bulk-purge">
          Also delete Claude uploads, images, tasks, file history and session-env</label>`
      : "";
    ASM.confirm(`Clean up ${totals.count} session${totals.count === 1 ? "" : "s"}?`,
      `${hasClaude ? "Claude transcripts will be permanently deleted. " : ""}` +
      `${hasCodex ? "Codex sessions will be archived through the Codex CLI and remain recoverable. " : ""}` +
      `${fmt.bytes(totals.bytes)} is currently indexed.`,
      async () => {
        const purge = document.getElementById("bulk-purge");
        const result = await ASM.api.call("cleanupSessions", JSON.stringify(items), !!(purge && purge.checked));
        if (result && result.ok) {
          ASM.toast(`Cleaned up ${result.completed || result.deleted || 0} session${(result.completed || result.deleted) === 1 ? "" : "s"}`, "ok");
          scope.clearSelection();
          await ASM.router.refreshAfterDelete();
        } else {
          ASM.toast((result && result.results && result.results[0] && result.results[0].error) || "Cleanup failed", "err");
        }
      }, extra, { confirmLabel: "Clean up", danger: hasClaude });
  }

  function confirmAssetDelete() {
    const items = [...State.assetSel.values()];
    if (!items.length) return;
    const bytes = items.reduce((sum, item) => sum + item.size_bytes, 0);
    ASM.confirm(`Delete ${items.length} asset group${items.length === 1 ? "" : "s"}?`,
      `${fmt.bytes(bytes)} of uploads, images or agent working data will be permanently removed. Transcripts are untouched.`,
      async () => {
        const payload = items.map((item) => ({
          source_id: item.source_id, kind: item.kind, session_id: item.session_id, path: item.path,
        }));
        const result = await ASM.api.call("deleteStorageAssets", JSON.stringify(payload));
        if (result && result.ok) {
          ASM.toast(`Deleted ${result.completed} asset group${result.completed === 1 ? "" : "s"}`, "ok");
          State.assetSel.clear();
          State.assets = await ASM.api.call("getStorageAssets", scope.sourceScope());
          ASM.router.renderMain();
        } else {
          ASM.toast((result && result.results && result.results[0] && result.results[0].error) || "Asset cleanup failed", "err");
        }
      });
  }

  async function handle(action, element) {
    switch (action) {
      case "cleanup-row": {
        const session = ((State.cleanup && State.cleanup.sessions) || []).find((item) =>
          item.provider === element.dataset.provider && item.source_id === element.dataset.source
          && item.project_id === element.dataset.pid && item.session_id === element.dataset.sid);
        if (!session) return true;
        if (locked(session) || session.active) { ASM.toast("This item is protected or read-only", "err"); return true; }
        scope.toggleSelected(record(session));
        dom.keepScroll(document.getElementById("main-pane"), () => ASM.router.renderMain());
        return true;
      }
      case "cleanup-view":
        applyPreset(element.dataset.view);
        ASM.router.renderMain();
        return true;
      case "cleanup-mode": {
        State.cleanupFilterSets[State.cleanupMode] = State.cleanupFilters;
        State.cleanupMode = element.dataset.mode;
        State.cleanupFilters = State.cleanupFilterSets[State.cleanupMode];
        if (State.cleanupMode === "assets" && !State.assets) {
          ASM.router.renderMain();
          State.assets = await ASM.api.call("getStorageAssets", scope.sourceScope());
        }
        ASM.router.renderMain();
        return true;
      }
      case "cleanup-sort":
        State.cleanupSort = element.dataset.sort;
        ASM.router.renderMain();
        return true;
      case "cleanup-more":
        State.cleanupLimit += 300;
        dom.keepScroll(document.getElementById("main-pane"), () => ASM.router.renderMain());
        return true;
      case "select-filtered":
        filteredSessions().filter((session) => !locked(session) && !session.active)
          .forEach((session) => State.sel.set(
            scope.selKey(session.project_id, session.session_id, session.provider, session.source_id), record(session)));
        ASM.router.renderMain();
        return true;
      case "select-assets":
        filteredAssets().filter((item) => !item.protected && item.source_writable)
          .forEach((item) => State.assetSel.set(`${item.source_id}␟${item.path}`, item));
        ASM.router.renderMain();
        return true;
      case "asset-row": {
        const item = ((State.assets && State.assets.items) || []).find((entry) =>
          `${entry.source_id}␟${entry.path}` === element.dataset.key);
        if (!item || item.protected || !item.source_writable) {
          ASM.toast("This asset group is protected or read-only", "err");
          return true;
        }
        if (State.assetSel.has(element.dataset.key)) State.assetSel.delete(element.dataset.key);
        else State.assetSel.set(element.dataset.key, item);
        dom.keepScroll(document.getElementById("main-pane"), () => ASM.router.renderMain());
        return true;
      }
      case "asset-clear":
        State.assetSel.clear();
        ASM.router.renderMain();
        return true;
      case "asset-delete":
        confirmAssetDelete();
        return true;
      case "sel-clear":
        scope.clearSelection();
        dom.keepScroll(document.getElementById("main-pane"), () => ASM.router.renderMain());
        return true;
      case "bulk-delete":
        confirmBulkDelete();
        return true;
      default:
        return false;
    }
  }

  ASM.views = ASM.views || {};
  ASM.views.cleanup = { render, handle, filteredSessions, filteredAssets };
})(window.ASM = window.ASM || {});
