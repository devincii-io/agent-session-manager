"""The figures the dashboard is built on: per-day spend, active time, and the
trace of skills, agents, kills and interruptions — reconstructed once per
session, cached on disk, and rolled up across projects.
"""

from __future__ import annotations

import json
import tempfile
import time
import unittest
import unittest.mock
from pathlib import Path

from asm import codex_session_parser, session_parser
from asm.codex_scanner import CodexScanner
from asm.scanner import Scanner


def write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n", encoding="utf-8")


def user(text: str, ts: str, **extra) -> dict:
    return {"type": "user", "timestamp": ts, "uuid": ts, "cwd": "/work/demo",
            "message": {"role": "user", "content": [{"type": "text", "text": text}]}, **extra}


def assistant(ts: str, blocks: list[dict], *, message_id: str, model: str = "claude-opus-4-8",
              input_tokens: int = 100, cache_read: int = 900) -> dict:
    return {"type": "assistant", "timestamp": ts, "uuid": ts + "-a", "cwd": "/work/demo", "message": {
        "role": "assistant", "id": message_id, "model": model, "content": blocks,
        "usage": {"input_tokens": input_tokens, "output_tokens": 50,
                  "cache_read_input_tokens": cache_read, "cache_creation_input_tokens": 0},
    }}


def tool_use(name: str, call_id: str, **inp) -> dict:
    return {"type": "tool_use", "id": call_id, "name": name, "input": inp}


def tool_result(call_id: str, ts: str, *, error: bool = False) -> dict:
    return {"type": "user", "timestamp": ts, "uuid": ts + "-r", "message": {
        "role": "user",
        "content": [{"type": "tool_result", "tool_use_id": call_id, "content": "out", "is_error": error}],
    }}


class SummaryLedgerTests(unittest.TestCase):
    def test_spend_is_charged_to_the_day_the_turn_happened(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "s.jsonl"
            write_jsonl(path, [
                user("start", "2026-08-01T10:00:00.000Z"),
                assistant("2026-08-01T10:00:05.000Z", [{"type": "text", "text": "hi"}], message_id="m1"),
                assistant("2026-08-03T09:00:05.000Z", [{"type": "text", "text": "later"}], message_id="m2"),
            ])
            summary = session_parser.summarize(path)
        days = sorted(summary.daily)
        self.assertEqual(len(days), 2)
        first, second = (summary.daily[day] for day in days)
        self.assertEqual(first["n"], 1)
        self.assertEqual(second["n"], 1)
        self.assertGreater(first["c"], 0)
        self.assertAlmostEqual(sum(day["c"] for day in summary.daily.values()), summary.cost, places=4)
        self.assertEqual(sum(day["p"] for day in summary.daily.values()), 1)
        self.assertIn("claude-opus-4-8", first["m"])

    def test_active_time_skips_idle_stretches(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "s.jsonl"
            write_jsonl(path, [
                user("start", "2026-08-01T10:00:00.000Z"),
                assistant("2026-08-01T10:01:00.000Z", [{"type": "text", "text": "a"}], message_id="m1"),
                # Two hours of nothing: a break, not work.
                user("continue", "2026-08-01T12:01:00.000Z"),
                assistant("2026-08-01T12:02:30.000Z", [{"type": "text", "text": "b"}], message_id="m2"),
            ])
            summary = session_parser.summarize(path)
            detail = session_parser.detail(path)
        self.assertEqual(summary.active_ms, 60_000 + 90_000)
        self.assertEqual(detail["analytics"]["active_ms"], summary.active_ms)
        self.assertEqual(len(detail["analytics"]["idle"]), 1)

    def test_tool_errors_and_compactions_are_counted_in_the_summary(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "s.jsonl"
            write_jsonl(path, [
                user("go", "2026-08-01T10:00:00.000Z"),
                assistant("2026-08-01T10:00:01.000Z", [tool_use("Bash", "t1", command="x")], message_id="m1", cache_read=90_000),
                tool_result("t1", "2026-08-01T10:00:02.000Z", error=True),
                # The context drops to a third: a compaction.
                assistant("2026-08-01T10:00:03.000Z", [{"type": "text", "text": "ok"}], message_id="m2", cache_read=20_000),
            ])
            summary = session_parser.summarize(path)
        self.assertEqual(summary.tool_errors, 1)
        self.assertEqual(summary.compactions, 1)


class TraceTests(unittest.TestCase):
    def test_skills_agents_kills_and_interruptions_are_traced(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "s.jsonl"
            write_jsonl(path, [
                user("<command-name>/effort</command-name>", "2026-08-01T10:00:00.000Z"),
                user("make it fast", "2026-08-01T10:00:01.000Z"),
                assistant("2026-08-01T10:00:02.000Z", [tool_use("Skill", "s1", skill="unslop")], message_id="m1"),
                tool_result("s1", "2026-08-01T10:00:03.000Z"),
                assistant("2026-08-01T10:00:04.000Z", [
                    tool_use("Agent", "a1", description="Audit the parser", subagent_type="Explore", prompt="..."),
                ], message_id="m2"),
                tool_result("a1", "2026-08-01T10:02:04.000Z"),
                assistant("2026-08-01T10:02:05.000Z", [tool_use("TaskStop", "k1", task_id="b53y0wkqp")], message_id="m3"),
                tool_result("k1", "2026-08-01T10:02:06.000Z"),
                user("[Request interrupted by user for tool use]", "2026-08-01T10:03:00.000Z"),
            ])
            summary = session_parser.summarize(path)
            detail = session_parser.detail(path)
        self.assertEqual(summary.skills, {"unslop": 1})
        self.assertEqual(summary.commands, {"/effort": 1})
        self.assertEqual(summary.agents, {"Explore": 1})
        self.assertEqual(summary.kills, 1)
        self.assertEqual(summary.interrupts, 1)
        self.assertEqual([row["k"] for row in summary.trace], ["command", "skill", "agent", "kill", "interrupt"])
        # The open-session trace also knows how long the agent ran.
        agent_row = next(row for row in detail["trace"]["events"] if row["k"] == "agent")
        self.assertEqual(agent_row["ms"], 120_000)
        self.assertEqual(agent_row["d"], "Audit the parser")
        self.assertEqual(detail["trace"]["kills"], 1)
        # Neither a command nor an interruption is mistaken for the first prompt.
        self.assertEqual(summary.first_prompt, "make it fast")

    def test_traces_roll_up_across_projects(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / ".claude"
            for project, skill in (("-work-a", "unslop"), ("-work-b", "unslop"), ("-work-b", "review")):
                stamp = f"2026-08-0{len(skill) % 7 + 1}T10:00:00.000Z"
                write_jsonl(home / "projects" / project / f"{skill}-{project}.jsonl", [
                    user("go", stamp),
                    assistant(stamp, [tool_use("Skill", "s1", skill=skill)], message_id="m1"),
                ])
            scanner = Scanner(home, cache_namespace="test-trace", temp_roots=[])
            stats = scanner.global_stats()
            events = scanner.trace_events()
        self.assertEqual(stats["skills"]["unslop"]["count"], 2)
        self.assertEqual(stats["skills"]["unslop"]["projects"], 2)
        self.assertEqual(stats["skills"]["review"]["sessions"], 1)
        self.assertEqual(len(events), 3)
        self.assertTrue(all(event["k"] == "skill" and event["project_name"] for event in events))
        self.assertEqual(sum(1 for project in stats["by_project"] if project["skills"]), 2)


class ScannerCacheTests(unittest.TestCase):
    def test_summaries_survive_a_restart_and_a_change_is_noticed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / ".claude"
            path = home / "projects" / "-work" / "one.jsonl"
            write_jsonl(path, [user("first", "2026-08-01T10:00:00.000Z")])
            with unittest.mock.patch("asm.paths.cache_dir", return_value=Path(tmp) / "cache"):
                first = Scanner(home, cache_namespace="restart", temp_roots=[])
                first.scan_projects()
                first.flush()
                second = Scanner(home, cache_namespace="restart", temp_roots=[])
                self.assertEqual(len(second._cache), 1)
                # A cached hit needs no parse state at all.
                second.scan_projects()
                self.assertEqual(second._sum_states, {})
                time.sleep(0.01)
                write_jsonl(path, [user("first", "2026-08-01T10:00:00.000Z"), user("second", "2026-08-01T10:00:01.000Z")])
                sessions = second.list_sessions("-work")
        self.assertEqual(sessions[0]["user_messages"], 2)

    def test_progress_is_reported_while_cold_files_are_parsed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / ".claude"
            for index in range(4):
                write_jsonl(home / "projects" / "-work" / f"{index}.jsonl", [user("x", "2026-08-01T10:00:00.000Z")])
            seen: list[dict] = []
            with unittest.mock.patch("asm.paths.cache_dir", return_value=Path(tmp) / "cache"):
                Scanner(home, cache_namespace="progress", temp_roots=[], on_progress=seen.append).scan_projects()
        self.assertEqual(seen[0]["done"], 0)
        self.assertEqual(seen[-1], {"kind": "index", "source": "progress", "provider": "claude",
                                    "done": 4, "total": 4, "file": ""})


class CodexCacheTests(unittest.TestCase):
    def test_codex_summaries_are_cached_across_scanners(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / ".codex"
            rollout = home / "sessions" / "2026" / "08" / "01" / "rollout-1.jsonl"
            write_jsonl(rollout, [
                {"timestamp": "2026-08-01T10:00:00Z", "type": "session_meta",
                 "payload": {"id": "thread-1", "cwd": str(Path(tmp) / "demo")}},
                {"timestamp": "2026-08-01T10:00:02Z", "type": "event_msg",
                 "payload": {"type": "user_message", "message": "Fix the parser"}},
                {"timestamp": "2026-08-01T10:00:03Z", "type": "response_item", "payload": {
                    "type": "function_call", "name": "spawn_agent", "call_id": "c1",
                    "arguments": json.dumps({"message": "look around"})}},
                {"timestamp": "2026-08-01T10:00:30Z", "type": "response_item", "payload": {
                    "type": "function_call_output", "call_id": "c1", "output": "done"}},
            ])
            with unittest.mock.patch("asm.paths.cache_dir", return_value=Path(tmp) / "cache"):
                first = CodexScanner(home, cache_namespace="codex-test")
                projects = first.scan_projects()
                first.flush()
                second = CodexScanner(home, cache_namespace="codex-test")
                sessions = second.list_sessions(projects[0]["id"])
                self.assertEqual(second._sum_states, {})
        self.assertEqual(sessions[0]["agents"], {"spawn_agent": 1})
        self.assertEqual(sessions[0]["trace"][0]["k"], "agent")
        self.assertEqual(sessions[0]["user_messages"], 1)

    def test_codex_ledger_counts_tokens_but_never_dollars(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rollout.jsonl"
            write_jsonl(path, [
                {"timestamp": "2026-08-01T10:00:00Z", "type": "session_meta", "payload": {"id": "t", "cwd": "/w"}},
                {"timestamp": "2026-08-01T10:00:01Z", "type": "turn_context", "payload": {"model": "gpt-test"}},
                {"timestamp": "2026-08-01T10:00:06Z", "type": "event_msg", "payload": {
                    "type": "token_count", "info": {"total_token_usage": {"total_tokens": 20},
                                                    "last_token_usage": {"total_tokens": 20}}}},
                {"timestamp": "2026-08-01T10:00:09Z", "type": "event_msg", "payload": {
                    "type": "token_count", "info": {"total_token_usage": {"total_tokens": 50},
                                                    "last_token_usage": {"total_tokens": 30}}}},
            ])
            summary = codex_session_parser.summarize(path)
        day = next(iter(summary.daily.values()))
        self.assertEqual(day["t"], 50)
        self.assertEqual(day["c"], 0.0)
        self.assertEqual(day["m"], {})


if __name__ == "__main__":
    unittest.main()
