/* ============================================================
   Preview fixtures.

   Opening web/index.html in a plain browser — no Qt, no backend —
   boots the app against these instead of a live machine. That makes
   the frontend workable on its own for a design pass, and it is what
   the repository screenshots are taken from, so no real project name
   or prompt of anyone's ever ends up in the README.

   The data is shaped exactly like the backend's, including the goal
   records asm/goals.py emits, so the preview exercises the real
   rendering path rather than a simplified one.
   ============================================================ */

(function (ASM) {
  "use strict";

  const HOUR = 3600 * 1000;
  const MINUTE = 60 * 1000;

  /** A fixed clock so screenshots are reproducible run to run. */
  const BASE = new Date();
  BASE.setHours(9, 12, 0, 0);

  function at(offsetMs) { return new Date(BASE.getTime() + offsetMs).toISOString(); }
  function seconds(value) { return value * 1000; }

  /** Build one goal record in the shape asm/goals.py produces. */
  function goal(index, spec) {
    const start = spec.start;
    const end = start + spec.ms;
    // Interleave the work rather than emitting it in blocks: a real goal
    // reads, edits, runs something, reads again — and the step strip is only
    // honest if the fixture looks like that too.
    const remaining = spec.work.map(([category, count, name]) => ({ category, count, name }));
    const steps = [];
    const byCategory = {};
    let cursor = start + seconds(4);
    const totalSteps = remaining.reduce((sum, entry) => sum + entry.count, 0);
    const tick = totalSteps ? Math.max(seconds(1), (spec.ms * 0.85) / totalSteps) : 0;
    while (remaining.some((entry) => entry.count > 0)) {
      for (const entry of remaining) {
        if (entry.count <= 0) continue;
        entry.count -= 1;
        byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
        const step = { t: at(cursor), c: entry.category, n: entry.name };
        if (spec.failAt && spec.failAt.includes(steps.length)) step.e = true;
        steps.push(step);
        cursor += tick;
      }
    }
    const tools = Object.values(byCategory).reduce((sum, count) => sum + count, 0);
    const errors = (spec.failAt || []).length;
    // Each call occupies a slice of the request; shells take the longest.
    const weight = { exec: 4, agent: 6, web: 3, read: 1, search: 1, edit: 1, plan: 1, ask: 8, mcp: 2, other: 1 };
    const catMs = {};
    let weighted = 0;
    Object.entries(byCategory).forEach(([category, count]) => {
      weighted += count * (weight[category] || 1);
    });
    Object.entries(byCategory).forEach(([category, count]) => {
      catMs[category] = Math.round((count * (weight[category] || 1) / (weighted || 1)) * spec.ms * 0.62);
    });
    return {
      i: index,
      kind: spec.kind || "prompt",
      prompt: spec.prompt,
      start: at(start),
      end: at(end),
      first_response: at(start + (spec.latency || seconds(3))),
      ms: spec.ms,
      latency_ms: spec.latency || seconds(3),
      turns: spec.turns,
      tools,
      by_cat: byCategory,
      cat_ms: catMs,
      tool_ms: Object.values(catMs).reduce((sum, value) => sum + value, 0),
      steps,
      dropped_steps: 0,
      errors,
      error_names: errors ? { Bash: errors } : {},
      subagents: byCategory.agent || 0,
      asked: !!byCategory.ask,
      compactions: spec.compactions || 0,
      files: spec.files || [],
      commands: spec.commands || [],
      tokens: spec.tokens,
      output_tokens: Math.round(spec.tokens * 0.06),
      cost: spec.cost,
      models: ["claude-opus-5"],
      thinking_chars: spec.thinking || 0,
      text_chars: spec.text || 0,
      outcome: spec.outcome,
    };
  }

  const GOAL_SPECS = [
    { prompt: "Read the payment webhook handler and tell me why retries duplicate charges.",
      start: 0, ms: 4 * MINUTE + seconds(20), latency: seconds(2), turns: 6, tokens: 148000, cost: 0.94,
      work: [["read", 7, "Read"], ["search", 4, "Grep"]], files: ["api/payments/webhook.py", "api/payments/retry.py"],
      thinking: 4200, text: 3100, outcome: "done" },
    { prompt: "Make the handler idempotent — key on the provider event id, and add the migration.",
      start: 5 * MINUTE, ms: 18 * MINUTE, latency: seconds(4), turns: 21, tokens: 612000, cost: 4.18,
      work: [["read", 6, "Read"], ["edit", 9, "Edit"], ["exec", 7, "Bash"], ["plan", 2, "TodoWrite"]],
      failAt: [16, 19], files: ["api/payments/webhook.py", "migrations/0042_event_key.py"],
      commands: ["alembic", "pytest", "ruff"], thinking: 18400, text: 9200, outcome: "recovered" },
    { prompt: "/compact", kind: "command",
      start: 24 * MINUTE, ms: seconds(38), latency: seconds(6), turns: 1, tokens: 24000, cost: 0.11,
      work: [], compactions: 1, outcome: "done" },
    { prompt: "Now the same for the refund path. Use a subagent to audit every caller first.",
      start: 26 * MINUTE, ms: 26 * MINUTE, latency: seconds(3), turns: 28, tokens: 940000, cost: 6.72,
      work: [["agent", 2, "Agent"], ["read", 5, "Read"], ["search", 6, "Grep"], ["edit", 7, "Edit"], ["exec", 9, "Bash"]],
      files: ["api/payments/refund.py", "api/payments/webhook.py"], commands: ["pytest", "git", "rg"],
      thinking: 26100, text: 14300, outcome: "done" },
    { prompt: "Should the refund key include the original charge id, or just the refund event id?",
      start: 54 * MINUTE, ms: 3 * MINUTE + seconds(10), latency: seconds(5), turns: 4, tokens: 96000, cost: 0.61,
      work: [["read", 2, "Read"], ["ask", 1, "AskUserQuestion"]], thinking: 5600, text: 2100, outcome: "question" },
    { prompt: "Run the full suite and the load test, then write up what changed.",
      start: 4 * HOUR + 12 * MINUTE, ms: 21 * MINUTE, latency: seconds(2), turns: 17, tokens: 488000, cost: 3.31,
      work: [["exec", 14, "Bash"], ["read", 3, "Read"], ["edit", 4, "Write"], ["web", 1, "WebFetch"]],
      failAt: [2, 5, 7, 9], commands: ["pytest", "k6", "docker"], files: ["docs/idempotency.md"],
      thinking: 12800, text: 18600, outcome: "error" },
    { prompt: "Fix the flaky load-test threshold and re-run just that one.",
      start: 4 * HOUR + 36 * MINUTE, ms: 7 * MINUTE + seconds(45), latency: seconds(3), turns: 9, tokens: 214000, cost: 1.44,
      work: [["read", 2, "Read"], ["edit", 3, "Edit"], ["exec", 5, "Bash"]],
      commands: ["k6", "git"], files: ["load/checkout.js"], thinking: 6100, text: 4400, outcome: "done" },
  ];

  const GOALS = GOAL_SPECS.map((spec, index) => goal(index, spec));
  const totalTools = GOALS.reduce((sum, entry) => sum + entry.tools, 0);
  const byCategory = {};
  const categoryTime = {};
  GOALS.forEach((entry) => {
    Object.entries(entry.by_cat).forEach(([category, count]) => {
      byCategory[category] = (byCategory[category] || 0) + count;
    });
    Object.entries(entry.cat_ms).forEach(([category, value]) => {
      categoryTime[category] = (categoryTime[category] || 0) + value;
    });
  });

  /** Roll a set of requests up into the /goal run that contained them. */
  function goalRun(index, spec) {
    const inside = spec.requests.map((i) => GOALS[i]);
    const by = {};
    const times = {};
    inside.forEach((entry) => {
      Object.entries(entry.by_cat).forEach(([category, count]) => {
        by[category] = (by[category] || 0) + count;
      });
      Object.entries(entry.cat_ms).forEach(([category, value]) => {
        times[category] = (times[category] || 0) + value;
      });
    });
    const blocked = spec.checks.filter((check) => !check.met);
    return {
      i: index,
      condition: spec.condition,
      start: at(spec.start),
      end: spec.end == null ? "" : at(spec.end),
      ms: (spec.end == null ? 5 * HOUR : spec.end) - spec.start,
      open: spec.end == null,
      met: !!spec.met,
      superseded: !!spec.superseded,
      status: spec.met ? "met" : spec.superseded ? "superseded" : spec.end == null ? "open" : "ended",
      checks: spec.checks.map((check) => ({ t: at(check.t), met: check.met, reason: check.reason })),
      dropped_checks: 0,
      blocked_stops: blocked.length,
      last_reason: blocked.length ? blocked[blocked.length - 1].reason : "",
      follow_ups: inside.filter((entry) => entry.kind === "prompt").length,
      commands: inside.filter((entry) => entry.kind === "command").length,
      request_ids: inside.map((entry) => entry.i),
      turns: inside.reduce((sum, entry) => sum + entry.turns, 0),
      tools: inside.reduce((sum, entry) => sum + entry.tools, 0),
      by_cat: by,
      cat_ms: times,
      tool_ms: Object.values(times).reduce((sum, value) => sum + value, 0),
      errors: inside.reduce((sum, entry) => sum + entry.errors, 0),
      asked: inside.filter((entry) => entry.asked).length,
      subagents: inside.reduce((sum, entry) => sum + entry.subagents, 0),
      compactions: inside.reduce((sum, entry) => sum + entry.compactions, 0),
      tokens: inside.reduce((sum, entry) => sum + entry.tokens, 0),
      cost: Number(inside.reduce((sum, entry) => sum + entry.cost, 0).toFixed(2)),
      files: [...new Set(inside.flatMap((entry) => entry.files))],
    };
  }

  const GOAL_RUNS = [
    goalRun(0, {
      condition: "make the webhook idempotent and prove it with the tests",
      start: 4 * MINUTE, end: 25 * MINUTE, superseded: true,
      requests: [1, 2], checks: [],
    }),
    goalRun(1, {
      condition: "keep going until refunds are idempotent too, the full suite is green, and it is written up",
      start: 25 * MINUTE, end: 4 * HOUR + 44 * MINUTE, met: true,
      requests: [3, 4, 5, 6],
      checks: [
        { t: 55 * MINUTE, met: false, reason: "Refunds are guarded but the load test has not been run since the change." },
        { t: 4 * HOUR + 33 * MINUTE, met: false, reason: "The load test failed its p95 threshold; the write-up is still missing." },
        { t: 4 * HOUR + 44 * MINUTE, met: true, reason: "Both paths key on the provider event id, the full suite and the load test pass, and docs/idempotency.md describes the change." },
      ],
    }),
  ];

  const PROJECTS = [
    { provider: "claude", id: "preview::checkout-service", name: "checkout-service",
      path: "~/code/checkout-service", session_count: 24, active_count: 1, total_cost: 128.4,
      total_tokens: 18_400_000, last_activity: Date.now() / 1000 - 120, memory_count: 6, exists: true },
    { provider: "claude", id: "preview::design-system", name: "design-system",
      path: "~/code/design-system", session_count: 11, active_count: 0, total_cost: 42.15,
      total_tokens: 6_100_000, last_activity: Date.now() / 1000 - 5 * 3600, memory_count: 3, exists: true },
    { provider: "codex", id: "preview::infra-terraform", name: "infra-terraform",
      path: "~/code/infra-terraform", session_count: 9, active_count: 0, total_cost: 0,
      total_tokens: 3_900_000, last_activity: Date.now() / 1000 - 26 * 3600, memory_count: 0, exists: true },
    { provider: "claude", id: "preview::docs-site", name: "docs-site",
      path: "~/code/docs-site", session_count: 7, active_count: 0, total_cost: 18.9,
      total_tokens: 2_300_000, last_activity: Date.now() / 1000 - 3 * 86400, memory_count: 1, exists: true },
  ];

  const SESSION_TITLES = [
    ["checkout-service", "Make the payment webhook idempotent", 1, 96, 141, 17.31, 46],
    ["checkout-service", "Refund path audit and rollout plan", 3600, 74, 108, 12.04, 61],
    ["design-system", "Token contrast pass for the light theme", 5 * 3600, 41, 63, 6.88, 28],
    ["checkout-service", "Trace the duplicate-charge report from support", 9 * 3600, 58, 92, 9.42, 71],
    ["infra-terraform", "Split the staging state file", 26 * 3600, 33, 51, 0, 39],
    ["design-system", "Replace the ad-hoc spacing scale", 30 * 3600, 22, 30, 3.11, 18],
    ["docs-site", "Rewrite the getting-started page", 3 * 86400, 19, 24, 2.40, 12],
    ["checkout-service", "Backfill the event-key column safely", 4 * 86400, 64, 97, 11.72, 55],
    ["infra-terraform", "Pin provider versions and re-plan", 6 * 86400, 15, 26, 0, 22],
    ["docs-site", "Search index rebuild on deploy", 8 * 86400, 12, 17, 1.60, 9],
  ];

  const RECENT = SESSION_TITLES.map(([project, title, ago, turns, tools, cost, context], index) => {
    const entry = PROJECTS.find((item) => item.name === project);
    return {
      provider: entry.provider,
      source_id: "windows",
      source_label: "Windows",
      source_writable: true,
      project_id: entry.id,
      project_name: project,
      project_path: entry.path,
      session_id: `preview-session-${index + 1}`,
      title,
      first_prompt: title,
      cost,
      tokens: turns * 26000,
      usage: { total: turns * 26000 },
      user_messages: Math.round(turns / 4),
      assistant_messages: turns,
      tool_calls: tools,
      size_bytes: 1_200_000 + index * 340_000,
      extra_bytes: 180_000,
      asset_bytes: { total: 180_000, images: 40_000 },
      mtime: Date.now() / 1000 - ago,
      updated: new Date(Date.now() - ago * 1000).toISOString(),
      created: new Date(Date.now() - (ago + 5400) * 1000).toISOString(),
      active: ago < 120,
      protected: ago < 600,
      has_subagents: index % 3 === 0,
      context_pct: context,
      models: entry.provider === "codex" ? ["gpt-5.6-sol"] : ["claude-opus-5"],
    };
  });

  const DETAIL = {
    provider: "claude",
    session_id: "preview-session-1",
    project_id: "preview::checkout-service",
    path: "~/.claude/projects/checkout-service/preview-session-1.jsonl",
    total_events: 412,
    events_start: 400,
    cost: 17.31,
    usage: { input: 214_000, output: 148_000, cache_read: 2_180_000, cache_write: 156_000, total: 2_698_000 },
    usage_by_model: {
      "claude-opus-5": { input: 214_000, output: 148_000, cache_read: 2_180_000, cache_write: 156_000, total: 2_698_000, cost: 17.31 },
    },
    tool_counts: { Bash: 35, Read: 25, Edit: 23, Grep: 10, Agent: 2, TodoWrite: 2, WebFetch: 1, AskUserQuestion: 1 },
    timeline: Array.from({ length: 42 }, (_, index) => ({
      t: at(index * 7 * MINUTE),
      // A compaction at step 22 — the drop the chart is there to show.
      ctx: index < 22 ? 40_000 + index * 7_400 : 52_000 + (index - 22) * 6_900,
      cost: Number((index * 0.42).toFixed(2)),
    })),
    requests: {
      requests: GOALS,
      dropped: 0,
      count: GOALS.length,
      by_cat: byCategory,
      cat_ms: categoryTime,
      tool_ms: Object.values(categoryTime).reduce((sum, value) => sum + value, 0),
      total_ms: GOALS.reduce((sum, entry) => sum + entry.ms, 0),
      median_ms: 7 * MINUTE + seconds(45),
      questions: GOALS.filter((entry) => entry.asked).length,
      failed: GOALS.filter((entry) => entry.outcome === "error").length,
      priced: true,
      categories: ASM.ui ? ASM.ui.CATEGORIES : [],
    },
    goals: {
      goals: GOAL_RUNS,
      dropped: 0,
      count: GOAL_RUNS.length,
      open: GOAL_RUNS.filter((run) => run.open).length,
      met: GOAL_RUNS.filter((run) => run.met).length,
      superseded: GOAL_RUNS.filter((run) => run.superseded).length,
      total_ms: GOAL_RUNS.reduce((sum, run) => sum + run.ms, 0),
      median_ms: GOAL_RUNS.length ? GOAL_RUNS[0].ms : 0,
      blocked_stops: GOAL_RUNS.reduce((sum, run) => sum + run.blocked_stops, 0),
      follow_ups: GOAL_RUNS.reduce((sum, run) => sum + run.follow_ups, 0),
    },
    analytics: {
      user_prompts: GOALS.length,
      assistant_turns: 86,
      tool_calls: totalTools,
      tool_error_total: 6,
      tool_errors: { Bash: 5, Edit: 1 },
      files_touched: {
        "api/payments/webhook.py": 14, "api/payments/refund.py": 9,
        "migrations/0042_event_key.py": 5, "load/checkout.js": 4, "docs/idempotency.md": 3,
      },
      bash_commands: { pytest: 18, git: 9, alembic: 5, k6: 4, ruff: 3, docker: 2 },
      thinking_chars: 73_200,
      text_chars: 51_700,
      output_per_turn: Array.from({ length: 42 }, (_, index) => 900 + Math.round(2600 * Math.abs(Math.sin(index / 3)))),
      hourly_utc: Array.from({ length: 24 }, (_, hour) => (hour > 7 && hour < 20 ? 2 + ((hour * 5) % 9) : 0)),
      daily: [],
      compactions: 1,
      first_ts: at(0),
      last_ts: at(4 * HOUR + 44 * MINUTE),
    },
    subagents: {
      count: 2,
      agent_calls: [
        { name: "Agent", desc: "Audit every caller of the refund path and report unguarded retries", ts: at(27 * MINUTE) },
        { name: "Agent", desc: "Check the migration against the staging schema snapshot", ts: at(34 * MINUTE) },
      ],
      events: [],
    },
    tasks: [
      { subject: "Key the webhook on the provider event id", status: "completed" },
      { subject: "Add the migration and backfill", status: "completed" },
      { subject: "Apply the same guard to refunds", status: "completed" },
      { subject: "Stabilise the load-test threshold", status: "in_progress" },
      { subject: "Write up the change for the runbook", status: "pending" },
    ],
    scratchpad: { exists: false, files: [] },
    images: [],
    file_history: { count: 18, bytes: 940_000, dir: "~/.claude/file-history/preview-session-1" },
  };

  DETAIL.events = [
    { role: "user", ts: at(4 * HOUR + 36 * MINUTE), blocks: [
      { type: "text", text: "Fix the flaky load-test threshold and re-run just that one." }] },
    { role: "assistant", ts: at(4 * HOUR + 36 * MINUTE + seconds(3)), model: "claude-opus-5", blocks: [
      { type: "thinking", text: "The p95 assertion is 180ms against a warm cache. The first iteration runs cold, so the threshold is measuring warm-up, not the change." },
      { type: "text", text: "The threshold is being applied to the cold first iteration. I'll add a warm-up stage and assert on the steady-state window only." }] },
    { role: "assistant", ts: at(4 * HOUR + 37 * MINUTE), model: "claude-opus-5", blocks: [
      { type: "tool_use", id: "t1", name: "Read", input_preview: '{"file_path": "load/checkout.js"}' }] },
    { role: "user", ts: at(4 * HOUR + 37 * MINUTE + seconds(1)), blocks: [
      { type: "tool_result", tool_use_id: "t1", content_preview: "export const options = { stages: [...], thresholds: { http_req_duration: ['p(95)<180'] } }" }] },
    { role: "assistant", ts: at(4 * HOUR + 38 * MINUTE), model: "claude-opus-5", blocks: [
      { type: "tool_use", id: "t2", name: "Edit", input_preview: '{"file_path": "load/checkout.js", "old_string": "stages: [{ duration: \'2m\' ...", "new_string": "stages: [{ duration: \'30s\', target: 5 }, ..."}' }] },
    { role: "user", ts: at(4 * HOUR + 38 * MINUTE + seconds(2)), blocks: [
      { type: "tool_result", tool_use_id: "t2", content_preview: "load/checkout.js updated" }] },
    { role: "assistant", ts: at(4 * HOUR + 39 * MINUTE), model: "claude-opus-5", blocks: [
      { type: "tool_use", id: "t3", name: "Bash", input_preview: '{"command": "k6 run load/checkout.js", "description": "Re-run the load test"}' }] },
    { role: "user", ts: at(4 * HOUR + 43 * MINUTE), blocks: [
      { type: "tool_result", tool_use_id: "t3", content_preview: "checks.........................: 100.00%\nhttp_req_duration..............: p(95)=142.3ms\n✓ threshold met" }] },
    { role: "assistant", ts: at(4 * HOUR + 44 * MINUTE), model: "claude-opus-5", blocks: [
      { type: "text", text: "Green. p95 is 142ms against the steady-state window; the earlier failures were the cold first iteration being measured. The warm-up stage is 30s at 5 VUs, which is enough for the connection pool to fill." }] },
  ];

  const GLOBAL = {
    cost: 189.45,
    sessions: 51,
    active: 1,
    prompts: 1_284,
    turns: 4_916,
    tool_calls: 8_742,
    subagent_sessions: 14,
    usage: { input: 2_140_000, output: 1_486_000, cache_read: 24_800_000, cache_write: 2_270_000, total: 30_696_000 },
    by_model: {
      "claude-opus-5": { total: 19_400_000, output: 1_010_000, cost: 148.2 },
      "claude-sonnet-5": { total: 8_100_000, output: 372_000, cost: 41.25 },
      "claude-haiku-4-5": { total: 3_196_000, output: 104_000, cost: 0 },
    },
    tool_counts: {
      Read: 2_140, Edit: 1_486, Bash: 1_402, Grep: 968, Write: 604, Glob: 512,
      TodoWrite: 388, Agent: 214, WebFetch: 142, AskUserQuestion: 61,
    },
    sessions_by_day: Array.from({ length: 90 }, (_, index) => {
      const date = new Date(Date.now() - (89 - index) * 86400000);
      const weekday = date.getDay();
      const weekend = weekday === 0 || weekday === 6;
      const recent = index > 62;
      const value = weekend ? (index % 5 === 0 ? 1 : 0) : (recent ? 2 + (index % 4) : (index % 3 === 0 ? 1 : 0));
      return [date.toISOString().slice(0, 10), value];
    }),
    activity: Array.from({ length: 7 }, (_, day) => Array.from({ length: 24 }, (_, hour) => {
      if (day > 4) return hour > 13 && hour < 19 ? (hour + day) % 3 : 0;
      if (hour < 8 || hour > 22) return 0;
      return 1 + ((hour * 3 + day * 5) % 6);
    })),
  };

  ASM.preview = { PROJECTS, RECENT, DETAIL, GLOBAL, GOALS };
})(window.ASM = window.ASM || {});
