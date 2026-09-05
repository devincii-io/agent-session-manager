from __future__ import annotations

import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from asm import scanner as scanner_module
from asm import sources
from asm.scanner import Scanner


class SourceDiscoveryTests(unittest.TestCase):
    def tearDown(self) -> None:
        sources.discover_sources.cache_clear()
        sources.resolve_source.cache_clear()

    def test_wsl_names_are_discovered_without_starting_distributions(self) -> None:
        sources.discover_sources.cache_clear()
        sources.resolve_source.cache_clear()
        listed = "Ubuntu-24.04\r\nDebian\r\n".encode("utf-16-le")
        with patch.object(sources.platform, "system", return_value="Windows"), \
                patch.object(sources, "_run", return_value=SimpleNamespace(returncode=0, stdout=listed)) as run:
            found = sources.discover_sources()
        self.assertEqual([item.id for item in found], ["windows", "wsl:Ubuntu-24.04", "wsl:Debian"])
        self.assertFalse(found[1].resolved)
        run.assert_called_once_with(["wsl.exe", "-l", "-q"])

    def test_container_tooling_distros_are_never_offered(self) -> None:
        listed = "Ubuntu-24.04\r\ndocker-desktop\r\ndocker-desktop-data\r\npodman-machine-default\r\nrancher-desktop\r\n"
        with patch.object(sources.platform, "system", return_value="Windows"), \
                patch.object(sources, "_run", return_value=SimpleNamespace(returncode=0, stdout=listed.encode("utf-16-le"))):
            found = sources.discover_sources()
        self.assertEqual([item.id for item in found], ["windows", "wsl:Ubuntu-24.04"])

    def test_a_distro_is_resolved_once_and_a_failure_is_remembered(self) -> None:
        listed = SimpleNamespace(returncode=0, stdout="Ubuntu-24.04\r\n".encode("utf-16-le"))
        calls: list[list[str]] = []

        def run(args, timeout=8):
            calls.append(args)
            return listed if args[:2] == ["wsl.exe", "-l"] else None  # resolving times out

        with patch.object(sources.platform, "system", return_value="Windows"), patch.object(sources, "_run", run):
            first = sources.resolve_source("wsl:Ubuntu-24.04")
            second = sources.resolve_source("wsl:Ubuntu-24.04")
        self.assertFalse(first.available)
        self.assertIs(first, second)
        self.assertEqual(sum(1 for args in calls if "-d" in args), 1, "the twelve-second timeout must not be retried")


class IndexMemoTests(unittest.TestCase):
    def test_a_change_during_a_walk_is_not_memoised(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
                patch("asm.paths.cache_dir", return_value=Path(tmp) / "cache"):
            home = Path(tmp) / ".claude"
            (home / "projects" / "-work").mkdir(parents=True)
            (home / "projects" / "-work" / "one.jsonl").write_text("{}\n", "utf-8")
            scanner = Scanner(home, cache_namespace="memo-test", temp_roots=[], index_ttl=60.0)
            scanner._index()
            self.assertIsNotNone(scanner._index_memo)
            scanner.invalidate()
            self.assertIsNone(scanner._index_memo)

            real = scanner_module.iter_jsonl_files

            def walk_then_change(root, *, recursive):
                yield from real(root, recursive=recursive)
                scanner.invalidate()  # a watcher event lands while the walk runs

            with patch.object(scanner_module, "iter_jsonl_files", walk_then_change):
                result = scanner._index()
            self.assertEqual(len(result), 1)
            self.assertIsNone(scanner._index_memo, "a walk that started before the change must not be served again")


class StorageAssetTests(unittest.TestCase):
    def test_current_uploads_are_visible_and_recent_orphans_are_protected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / ".claude"
            upload = home / "uploads" / "orphan-session"
            upload.mkdir(parents=True)
            image = upload / "screen shot.png"
            image.write_bytes(b"png")
            scanner = Scanner(home, cache_namespace="test", temp_roots=[])
            inventory = scanner.storage_assets()
            images = scanner.get_images("orphan-session")
        self.assertEqual(inventory["items"][0]["kind"], "uploads")
        self.assertTrue(inventory["items"][0]["orphaned"])
        self.assertTrue(inventory["items"][0]["protected"])
        self.assertEqual(images[0]["name"], "screen shot.png")

    def test_old_orphan_upload_is_cleanable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / ".claude"
            upload = home / "uploads" / "old-orphan"
            upload.mkdir(parents=True)
            image = upload / "image.webp"
            image.write_bytes(b"data")
            old = time.time() - 601
            os.utime(image, (old, old)); os.utime(upload, (old, old))
            scanner = Scanner(home, cache_namespace="test-old", temp_roots=[])
            item = scanner.storage_assets()["items"][0]
        self.assertFalse(item["protected"])


if __name__ == "__main__":
    unittest.main()
