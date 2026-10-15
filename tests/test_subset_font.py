import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "subset_font", Path(__file__).resolve().parents[1] / "scripts" / "subset_font.py")
font = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(font)


class SubsetFontTests(unittest.TestCase):
    def run_main(self, root, *args):
        html = root / "index.html"
        source = root / "source.woff2"
        if not html.exists():
            html.write_text('<style>@font-face { font-family: Nebulove; }</style><p>数独</p>', encoding="utf-8")
        source.write_bytes(b"original font")
        with patch.object(font, "HERE", str(root)), \
                patch.object(font, "build_subset", return_value=(b"subset", {ord("数")})), \
                patch("sys.argv", ["subset_font.py", "--html", str(html), "--ttf", str(source), *args]), \
                contextlib.redirect_stdout(io.StringIO()):
            font.main()
        return html

    def test_check_does_not_write_html_or_subset(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            html = root / "index.html"
            html.write_text('<style>@font-face {}</style>', encoding="utf-8")
            before = html.read_bytes()
            self.run_main(root, "--check")
            self.assertEqual(html.read_bytes(), before)
            self.assertFalse((root / "Nebulove-subset.woff2").exists())
            artifact = root / "Nebulove-subset.woff2"
            artifact.write_bytes(b"keep me")
            self.run_main(root, "--check")
            self.assertEqual(artifact.read_bytes(), b"keep me")

    def test_generated_css_is_offline_only(self):
        css = font.make_font_face("Zm9udA==", 1, 2, 3, "test")
        self.assertIn("data:font/woff2", css)
        self.assertNotIn("https://", css)
        self.assertNotIn("http://", css)

    def test_repeated_generation_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            html = self.run_main(root)
            before = html.read_bytes()
            self.run_main(root)
            self.assertEqual(html.read_bytes(), before)
            self.assertEqual(before.count(b"@font-face"), 1)
            self.assertEqual((root / "Nebulove-subset.woff2").read_bytes(), b"subset")

    def test_download_uses_private_temporary_file_and_cleans_up(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            html = root / "index.html"
            html.write_text('<style>@font-face {}</style>', encoding="utf-8")
            downloads = []

            def download(url, dest):
                downloads.append(Path(dest))
                Path(dest).write_bytes(b"source")

            for fail in [False, True]:
                with patch.object(font, "HERE", str(root)), \
                        patch.object(font, "download", side_effect=download), \
                        patch.object(font, "build_subset", side_effect=ValueError("invalid font") if fail else None,
                                     return_value=(b"subset", set())), \
                        patch("sys.argv", ["subset_font.py", "--html", str(html), "--check"]), \
                        contextlib.redirect_stdout(io.StringIO()):
                    if fail:
                        with self.assertRaises(ValueError):
                            font.main()
                    else:
                        font.main()
                self.assertFalse(downloads[-1].exists())
            self.assertNotEqual(downloads[0], downloads[1])

    def test_character_collection_keeps_ui_text_and_excludes_css_and_comments(self):
        chars = font.collect_chars('<style>样</style><p>数独</p><!--注--><script>/*释*/ const x = "提示";</script>', extra="梨")
        self.assertTrue(set("数独提示梨").issubset(chars))
        self.assertTrue(set("样注释").isdisjoint(chars))
        self.assertTrue(set("0123456789").issubset(chars))


if __name__ == "__main__":
    unittest.main()
