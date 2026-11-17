"""Unit tests for yt_dub_downloader.py pure logic and yt-dlp option construction."""

import sys
import types
import unittest


def _install_stubs() -> None:
    """Provide lightweight stubs when tkinter / customtkinter / yt_dlp are not installed."""
    if "tkinter" not in sys.modules:
        tk_stub = types.ModuleType("tkinter")
        filedialog_stub = types.ModuleType("tkinter.filedialog")
        filedialog_stub.askdirectory = lambda **_kw: ""
        tk_stub.filedialog = filedialog_stub
        sys.modules["tkinter"] = tk_stub
        sys.modules["tkinter.filedialog"] = filedialog_stub

    if "customtkinter" not in sys.modules:
        ctk_stub = types.ModuleType("customtkinter")

        class _CTk:
            pass

        class _CTkFont:
            def __init__(self, *args, **kwargs):
                pass

        ctk_stub.CTk = _CTk
        ctk_stub.CTkFont = _CTkFont
        ctk_stub.set_appearance_mode = lambda *_a, **_kw: None
        ctk_stub.set_default_color_theme = lambda *_a, **_kw: None
        sys.modules["customtkinter"] = ctk_stub

    if "yt_dlp" not in sys.modules:
        yt_dlp_stub = types.ModuleType("yt_dlp")
        yt_dlp_stub.YoutubeDL = object
        sys.modules["yt_dlp"] = yt_dlp_stub


_install_stubs()
import yt_dub_downloader as app_mod  # noqa: E402


SAMPLE_FORMATS = [
    # Video-only streams
    {"format_id": "137", "vcodec": "avc1.640028", "acodec": "none", "height": 1080, "fps": 30, "ext": "mp4", "tbr": 4200},
    {"format_id": "299", "vcodec": "avc1.64002a", "acodec": "none", "height": 1080, "fps": 60, "ext": "mp4", "tbr": 6100},
    {"format_id": "248", "vcodec": "vp9", "acodec": "none", "height": 1080, "fps": 30, "ext": "webm", "tbr": 3800},
    {"format_id": "136", "vcodec": "avc1.4d401f", "acodec": "none", "height": 720, "fps": 30, "ext": "mp4", "tbr": 2100},
    {"format_id": "313", "vcodec": "vp9", "acodec": "none", "height": 2160, "fps": 30, "ext": "webm", "tbr": 16500},
    # Legacy muxed stream
    {"format_id": "18", "vcodec": "avc1.42001E", "acodec": "mp4a.40.2", "height": 360, "fps": 30, "ext": "mp4", "tbr": 500},
    # Audio-only streams with multi-language dubs
    {"format_id": "140-drc", "vcodec": "none", "acodec": "mp4a.40.2", "language": "en", "language_preference": 10, "format_note": "English original", "ext": "m4a", "abr": 128},
    {"format_id": "251-hi", "vcodec": "none", "acodec": "opus", "language": "hi", "language_preference": -1, "format_note": "Hindi (dubbed)", "ext": "webm", "abr": 132},
    {"format_id": "140-hi", "vcodec": "none", "acodec": "mp4a.40.2", "language": "hi", "language_preference": -1, "format_note": "Hindi (dubbed)", "ext": "m4a", "abr": 128},
    {"format_id": "140-fr", "vcodec": "none", "acodec": "mp4a.40.2", "language": "fr", "language_preference": -1, "format_note": "French (dubbed)", "ext": "m4a", "abr": 128},
    {"format_id": "140-bn", "vcodec": "none", "acodec": "mp4a.40.2", "language": "bn", "language_preference": -1, "format_note": "Bengali (dubbed)", "ext": "m4a", "abr": 128},
    {"format_id": "139-es", "vcodec": "none", "acodec": "mp4a.40.2", "language": "es", "language_preference": -1, "format_note": "Spanish (dubbed)", "ext": "m4a", "abr": 48},
    {"format_id": "140-es", "vcodec": "none", "acodec": "mp4a.40.2", "language": "es", "language_preference": -1, "format_note": "Spanish (dubbed)", "ext": "m4a", "abr": 128},
]


class TestYouTubeDubDownloaderLogic(unittest.TestCase):
    def test_parse_video_formats_sorts_highest_first_and_prefers_mp4_video_only(self) -> None:
        parsed = app_mod.parse_video_formats(SAMPLE_FORMATS)
        format_ids = [fmt_id for _, fmt_id in parsed]
        self.assertEqual(format_ids[0], "313")  # 2160p (4K)
        self.assertEqual(format_ids[1], "299")  # 1080p 60fps
        self.assertEqual(format_ids[2], "137")  # 1080p 30fps mp4 preferred over webm 248
        self.assertIn("136", format_ids)
        self.assertIn("18", format_ids)
        self.assertNotIn("248", format_ids)

    def test_parse_audio_dubs_puts_original_first_and_picks_best_per_language(self) -> None:
        parsed = app_mod.parse_audio_dubs(SAMPLE_FORMATS)
        labels = [label for label, _ in parsed]
        ids = [fmt_id for _, fmt_id in parsed]

        self.assertTrue(labels[0].startswith("English (en) · Original"))
        self.assertEqual(ids[0], "140-drc")

        # Spanish should pick 140-es (128kbps) over 139-es (48kbps)
        self.assertIn("140-es", ids)
        self.assertNotIn("139-es", ids)

        # Hindi, French, Bengali dubs are all represented
        self.assertIn("140-hi", ids)
        self.assertIn("140-fr", ids)
        self.assertIn("140-bn", ids)

    def test_parse_audio_dubs_handles_missing_language_metadata(self) -> None:
        formats = [
            {"format_id": "140", "vcodec": "none", "acodec": "mp4a.40.2", "ext": "m4a", "abr": 128}
        ]
        parsed = app_mod.parse_audio_dubs(formats)
        self.assertEqual(len(parsed), 1)
        self.assertTrue(parsed[0][0].startswith("Original (Default)"))
        self.assertEqual(parsed[0][1], "140")

    def test_build_ydl_download_opts_sets_format_merge_and_mp4(self) -> None:
        opts = app_mod.build_ydl_download_opts("299", "140-hi", "/tmp/videos")
        self.assertEqual(opts["format"], "299+140-hi")
        self.assertEqual(opts["merge_output_format"], "mp4")
        self.assertTrue(opts["noplaylist"])
        self.assertIn("/tmp/videos", opts["outtmpl"])

    def test_format_progress_stats_downloading_and_finished(self) -> None:
        progress, text = app_mod.format_progress_stats(
            {
                "status": "downloading",
                "downloaded_bytes": 5 * 1024 * 1024,
                "total_bytes": 10 * 1024 * 1024,
                "speed": 2.5 * 1024 * 1024,
                "eta": 65,
            }
        )
        self.assertAlmostEqual(progress, 0.5)
        self.assertIn("50.0%", text)
        self.assertIn("2.50 MB/s", text)
        self.assertIn("01:05", text)

        done_progress, done_text = app_mod.format_progress_stats({"status": "finished"})
        self.assertEqual(done_progress, 1.0)
        self.assertIn("FFmpeg", done_text)


if __name__ == "__main__":
    unittest.main()
