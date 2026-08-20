"""Guards on the frontend that a browser cannot enforce for us.

Each test here encodes a regression that actually happened or a rule the
architecture depends on. They are deliberately structural — they check that
the mechanism exists, not that a particular pixel is a particular colour.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"


def read(*parts: str) -> str:
    return WEB.joinpath(*parts).read_text("utf-8")


def all_css() -> str:
    return "\n".join(path.read_text("utf-8") for path in sorted(WEB.glob("css/*.css")))


def all_js() -> str:
    return "\n".join(path.read_text("utf-8") for path in sorted(WEB.rglob("js/**/*.js")))


class FrontendConventionTests(unittest.TestCase):
    def test_native_browser_confirm_is_never_used(self) -> None:
        native_confirm = re.compile(r"\b(?:window\s*\.\s*)?confirm\s*\(")
        offenders = []
        for path in sorted(WEB.rglob("*")):
            if path.suffix.lower() not in {".js", ".html"}:
                continue
            for number, line in enumerate(path.read_text("utf-8").splitlines(), 1):
                # ASM.confirm(...) is the app's own styled dialog, not the native one.
                if native_confirm.search(line) and "ASM.confirm" not in line:
                    offenders.append(f"{path.relative_to(ROOT)}:{number}")
        self.assertEqual(
            offenders,
            [],
            "A native dialog blocks the QtWebEngine event loop and cannot carry the "
            "extra choice destructive actions need. Use ASM.confirm(...): "
            + ", ".join(offenders),
        )

    def test_every_stylesheet_and_script_is_loaded_by_the_page(self) -> None:
        html = read("index.html")
        for path in sorted(WEB.glob("css/*.css")):
            self.assertIn(f'href="css/{path.name}"', html, f"{path.name} is never linked")
        for path in sorted(WEB.rglob("js/**/*.js")):
            rel = path.relative_to(WEB).as_posix()
            self.assertIn(f'src="{rel}"', html, f"{rel} is never loaded")

    def test_scripts_are_classic_and_namespaced(self) -> None:
        """file:// + ES modules = CORS failures inside QtWebEngine.

        Every script must be a classic script wrapped in an IIFE that extends
        the single `ASM` global, or two files could not both declare a local of
        the same name.
        """
        html = read("index.html")
        self.assertNotIn('type="module"', html)
        for path in sorted(WEB.rglob("js/**/*.js")):
            source = path.read_text("utf-8")
            self.assertIn(
                "window.ASM = window.ASM || {}",
                source,
                f"{path.name} must be an IIFE over the shared ASM namespace",
            )

    def test_no_colour_literal_escapes_the_token_file(self) -> None:
        """Two themes, one palette. A literal hex in a component is wrong in one of them."""
        hex_colour = re.compile(r"#[0-9a-fA-F]{3,8}\b")
        offenders = []
        for path in sorted(WEB.glob("css/*.css")):
            if path.name == "tokens.css":
                continue
            for number, line in enumerate(path.read_text("utf-8").splitlines(), 1):
                if hex_colour.search(line) and "#fff" not in line and "#12100c" not in line:
                    offenders.append(f"{path.name}:{number}")
        self.assertEqual(offenders, [], "Colours belong in css/tokens.css: " + ", ".join(offenders))

    def test_both_themes_define_the_whole_category_palette(self) -> None:
        tokens = read("css", "tokens.css")
        light = tokens.split(':root[data-theme="light"]', 1)
        self.assertEqual(len(light), 2, "The light theme block is missing")
        for category in ("read", "search", "edit", "exec", "web", "agent", "plan", "ask", "mcp", "other"):
            self.assertIn(f"--cat-{category}:", light[0], f"--cat-{category} missing from the dark theme")
            self.assertIn(f"--cat-{category}:", light[1], f"--cat-{category} missing from the light theme")

    def test_bar_fill_accepts_a_calculated_width(self) -> None:
        rules = re.findall(r"\.bar-fill\s*\{([^}]+)\}", all_css())
        self.assertTrue(rules, "Missing the shared .bar-fill style")
        self.assertTrue(
            any(re.search(r"\bdisplay\s*:\s*(?:block|inline-block|flex)\s*;", rule) for rule in rules),
            "The bar fill is a span; without a non-inline display its percentage width is ignored",
        )

    def test_main_pane_responds_to_its_own_width(self) -> None:
        """The sidebar sets the main pane's width as much as the window does."""
        css = all_css()
        self.assertRegex(css, r"\.main-pane\s*\{[^}]*container\s*:\s*main\s*/\s*inline-size\s*;")
        self.assertRegex(css, r"@container\s+main\s*\(max-width:")
        self.assertRegex(css, r"@media\s*\(max-width:\s*860px\)")
        self.assertRegex(css, r"\.view\s*\{[^}]*max-width\s*:\s*none\s*;")

    def test_sidebar_is_resizable_and_remembers_its_width(self) -> None:
        css = all_css()
        js = all_js()
        html = read("index.html")
        self.assertIn("--sidebar-width", css)
        self.assertNotIn("--rail-width", css)
        self.assertEqual(html.count('role="separator"'), 1)
        self.assertIn("function initPaneResizers()", js)
        self.assertIn('storage: "asm.sidebarWidth"', js)
        self.assertIn("MIN_MAIN_WIDTH = 420", js)

    def test_desktop_window_launch_size_is_screen_bounded(self) -> None:
        app = (ROOT / "asm" / "app.py").read_text("utf-8")
        self.assertIn("availableGeometry()", app)
        self.assertNotIn("self.setMinimumSize(1040, 680)", app)

    def test_selftest_probe_matches_the_shipped_markup(self) -> None:
        """A packaged build is smoke-tested through this probe; it must stay true."""
        app = (ROOT / "asm" / "app.py").read_text("utf-8")
        html = read("index.html")
        for selector in ("#view-rail", "#agent-switch", "#source-switch", "#sidebar", "#main-pane"):
            self.assertIn(selector, app, f"{selector} is not checked by the selftest probe")
            self.assertIn(f'id="{selector[1:]}"', html, f"{selector} is missing from index.html")

    def test_long_lists_paginate_instead_of_rendering_everything(self) -> None:
        js = all_js()
        self.assertIn("browseLimit", js)
        self.assertIn('data-action="browse-more"', js)
        self.assertIn("cleanupLimit", js)
        self.assertIn('data-action="cleanup-more"', js)
        self.assertIn("MAX_BROWSER_TRANSCRIPT_EVENTS", js)

    def test_async_loads_are_guarded_against_stale_renders(self) -> None:
        js = all_js()
        for key in ("session", "project", "search", "cleanup", "overview", "recent"):
            self.assertIn(
                f"ticket !== State.requestSeq.{key}",
                js,
                f"the {key} loader can paint a stale result",
            )

    def test_cleanup_keeps_a_filter_set_per_mode(self) -> None:
        self.assertIn("cleanupFilterSets", all_js())

    def test_journey_repaints_when_the_theme_changes(self) -> None:
        """The canvas is the one thing that cannot follow a CSS custom property."""
        journey = read("js", "views", "journey.js")
        self.assertIn("ASM.theme.onChange", journey)
        self.assertIn("dom.token(", journey)


if __name__ == "__main__":
    unittest.main()
