"""
YouTube Multi-Audio Dub Downloader (Desktop Application)
Tech Stack: CustomTkinter (Dark UI) + yt-dlp + FFmpeg + Threading

Single-file desktop application that fetches YouTube video metadata,
parses available video resolutions and multi-language dubbed audio tracks,
and merges the user's chosen video + audio streams into MP4 using FFmpeg.
"""

from __future__ import annotations

import os
import re
import shutil
import threading
from pathlib import Path
from tkinter import filedialog
from typing import Any, Callable, Dict, List, Optional, Tuple

import customtkinter as ctk
import yt_dlp


# Common ISO-639-1 / BCP-47 language codes used by YouTube multi-audio tracks
LANGUAGE_NAMES: Dict[str, str] = {
    "ar": "Arabic",
    "bn": "Bengali",
    "de": "German",
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "gu": "Gujarati",
    "hi": "Hindi",
    "id": "Indonesian",
    "it": "Italian",
    "ja": "Japanese",
    "kn": "Kannada",
    "ko": "Korean",
    "ml": "Malayalam",
    "mr": "Marathi",
    "nl": "Dutch",
    "pa": "Punjabi",
    "pl": "Polish",
    "pt": "Portuguese",
    "ru": "Russian",
    "ta": "Tamil",
    "te": "Telugu",
    "th": "Thai",
    "tr": "Turkish",
    "uk": "Ukrainian",
    "ur": "Urdu",
    "vi": "Vietnamese",
    "zh": "Chinese",
}

ANSI_ESCAPE_RE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def strip_ansi(value: str) -> str:
    """Remove ANSI color sequences from yt-dlp formatted strings."""
    return ANSI_ESCAPE_RE.sub("", value or "").strip()


def format_bytes_rate(speed_bps: Optional[float]) -> str:
    """Format download speed in bytes/sec into a human-readable string."""
    if not speed_bps or speed_bps <= 0:
        return "-- MB/s"
    units = ["B/s", "KB/s", "MB/s", "GB/s"]
    value = float(speed_bps)
    unit_idx = 0
    while value >= 1024.0 and unit_idx < len(units) - 1:
        value /= 1024.0
        unit_idx += 1
    return f"{value:.2f} {units[unit_idx]}"


def format_eta(eta_seconds: Optional[float]) -> str:
    """Format ETA in seconds into HH:MM:SS or MM:SS."""
    if eta_seconds is None or eta_seconds < 0:
        return "--:--"
    total = int(round(eta_seconds))
    hours, rem = divmod(total, 3600)
    minutes, seconds = divmod(rem, 60)
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"


def format_duration(seconds: Optional[float]) -> str:
    """Format video duration seconds into readable timestamp."""
    if not seconds or seconds <= 0:
        return "Unknown"
    return format_eta(seconds)


def resolve_language_name(lang_code: Optional[str]) -> str:
    """Resolve an ISO language tag (e.g. 'hi', 'en-US') into a readable name."""
    if not lang_code:
        return "Original"
    normalized = lang_code.strip()
    base = normalized.split("-")[0].split("_")[0].lower()
    friendly = LANGUAGE_NAMES.get(base)
    if friendly:
        return f"{friendly} ({normalized})"
    return normalized.upper()


def parse_video_formats(formats: List[Dict[str, Any]]) -> List[Tuple[str, str]]:
    """
    Filter video streams (height present and vcodec != 'none') and return
    a deduplicated list of (display_label, format_id) sorted highest quality first.
    """
    best_by_bucket: Dict[Tuple[int, int], Tuple[Tuple[int, int, float], str, str]] = {}

    for fmt in formats:
        vcodec = fmt.get("vcodec")
        height = fmt.get("height")
        format_id = fmt.get("format_id")

        if not format_id or not vcodec or vcodec == "none" or not height:
            continue

        height_int = int(height)
        fps = int(round(float(fmt.get("fps") or 30)))
        acodec = fmt.get("acodec")
        is_video_only = 1 if (not acodec or acodec == "none") else 0
        ext = fmt.get("ext") or "mp4"
        is_mp4 = 1 if ext == "mp4" else 0
        tbr = float(fmt.get("tbr") or fmt.get("vbr") or 0.0)

        # Bucket by (height, fps) so users see clean choices like 1080p 60fps, 1080p 30fps, 720p
        bucket = (height_int, fps)
        score = (is_video_only, is_mp4, tbr)

        res_tag = f"{height_int}p"
        if height_int >= 2160:
            res_tag = f"{height_int}p (4K)"
        elif height_int == 1440:
            res_tag = f"{height_int}p (2K)"

        fps_tag = f" {fps}fps" if fps > 30 else ""
        codec_short = str(vcodec).split(".")[0]
        label = f"{res_tag}{fps_tag} · {ext.upper()} ({codec_short})"

        existing = best_by_bucket.get(bucket)
        if existing is None or score > existing[0]:
            best_by_bucket[bucket] = (score, label, str(format_id))

    sorted_items = sorted(
        best_by_bucket.items(),
        key=lambda item: (item[0][0], item[0][1]),
        reverse=True,
    )
    return [(data[1], data[2]) for _, data in sorted_items]


def parse_audio_dubs(formats: List[Dict[str, Any]]) -> List[Tuple[str, str]]:
    """
    Filter audio streams (acodec != 'none' and language metadata) and return
    a clean list of (display_label, format_id) with Original first, followed by dubs.
    """
    best_by_track: Dict[Tuple[str, bool], Tuple[Tuple[int, int, float], str, str, bool]] = {}

    for fmt in formats:
        acodec = fmt.get("acodec")
        format_id = fmt.get("format_id")
        if not format_id or not acodec or acodec == "none":
            continue

        vcodec = fmt.get("vcodec")
        is_audio_only = 1 if (not vcodec or vcodec == "none") else 0

        lang = fmt.get("language")
        format_note = str(fmt.get("format_note") or "")
        lang_pref = fmt.get("language_preference")
        note_lower = format_note.lower()

        is_original = (
            "original" in note_lower
            or (isinstance(lang_pref, (int, float)) and lang_pref >= 10)
            or lang is None
        )

        lang_key = str(lang).strip() if lang else "original"
        track_key = (lang_key.lower(), is_original)

        ext = fmt.get("ext") or "m4a"
        is_m4a = 1 if ext == "m4a" else 0
        abr = float(fmt.get("abr") or fmt.get("tbr") or 0.0)
        score = (is_audio_only, is_m4a, abr)

        readable_lang = resolve_language_name(lang) if lang else "Original (Default)"
        if lang and is_original:
            readable_lang = f"{readable_lang} · Original"
        elif lang and "dub" in note_lower:
            readable_lang = f"{readable_lang} · Dubbed"

        abr_tag = f" · {int(round(abr))}kbps" if abr > 0 else ""
        label = f"{readable_lang}{abr_tag} [{ext}]"

        existing = best_by_track.get(track_key)
        if existing is None or score > existing[0]:
            best_by_track[track_key] = (score, label, str(format_id), is_original)

    # Sort Original tracks first, then alphabetically by language label
    sorted_tracks = sorted(
        best_by_track.values(),
        key=lambda item: (0 if item[3] else 1, item[1].lower()),
    )
    return [(item[1], item[2]) for item in sorted_tracks]


def resolve_local_cookiefile() -> Optional[str]:
    """Return path to cookies.txt if present in cwd or env var."""
    env_path = os.environ.get("YOUTUBE_COOKIES_PATH", "").strip()
    if env_path and os.path.isfile(env_path):
        return env_path
    local_path = os.path.join(os.getcwd(), "cookies.txt")
    if os.path.isfile(local_path):
        return local_path
    return None


def build_ydl_download_opts(
    video_format_id: str,
    audio_format_id: str,
    output_dir: str,
    progress_hook: Optional[Callable[[Dict[str, Any]], None]] = None,
    postprocessor_hook: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> Dict[str, Any]:
    """Build yt-dlp options dictionary for merging chosen video & dubbed audio into MP4."""
    opts: Dict[str, Any] = {
        "format": f"{video_format_id}+{audio_format_id}",
        "merge_output_format": "mp4",
        "outtmpl": os.path.join(output_dir, "%(title)s [%(height)sp].%(ext)s"),
        "noplaylist": True,
        "nocolor": True,
        "quiet": True,
        "no_warnings": True,
    }
    cookiefile = resolve_local_cookiefile()
    if cookiefile:
        opts["cookiefile"] = cookiefile
    if progress_hook is not None:
        opts["progress_hooks"] = [progress_hook]
    if postprocessor_hook is not None:
        opts["postprocessor_hooks"] = [postprocessor_hook]
    return opts


def format_progress_stats(status_dict: Dict[str, Any]) -> Tuple[float, str]:
    """Compute normalized progress [0.0, 1.0] and status line with speed & ETA."""
    status = status_dict.get("status")
    if status == "downloading":
        downloaded = float(status_dict.get("downloaded_bytes") or 0.0)
        total = float(
            status_dict.get("total_bytes")
            or status_dict.get("total_bytes_estimate")
            or 0.0
        )
        progress = min(max(downloaded / total, 0.0), 1.0) if total > 0 else 0.0
        pct_text = f"{progress * 100:.1f}%" if total > 0 else strip_ansi(
            str(status_dict.get("_percent_str") or "0.0%")
        )
        speed_text = format_bytes_rate(status_dict.get("speed"))
        eta_text = format_eta(status_dict.get("eta"))
        return progress, f"Downloading: {pct_text}  |  Speed: {speed_text}  |  ETA: {eta_text}"

    if status == "finished":
        return 1.0, "Stream downloaded. Merging video & dubbed audio with FFmpeg..."

    if status == "error":
        return 0.0, "Download error encountered."

    return 0.0, "Preparing download..."


class YouTubeDubDownloaderApp(ctk.CTk):
    """Modern dark-mode CustomTkinter application for multi-audio YouTube downloads."""

    def __init__(self) -> None:
        super().__init__()

        ctk.set_appearance_mode("dark")
        ctk.set_default_color_theme("blue")

        self.title("YouTube Multi-Audio Dub Downloader")
        self.geometry("760x560")
        self.minsize(680, 520)

        self.video_map: Dict[str, str] = {}
        self.audio_map: Dict[str, str] = {}
        self.current_info: Optional[Dict[str, Any]] = None
        self.is_busy: bool = False
        self.output_dir: str = str(Path.home() / "Downloads")
        if not os.path.isdir(self.output_dir):
            self.output_dir = os.getcwd()

        self._build_ui()
        self._check_ffmpeg_startup()

    def _build_ui(self) -> None:
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(0, weight=1)

        container = ctk.CTkFrame(self, corner_radius=14)
        container.grid(row=0, column=0, padx=20, pady=20, sticky="nsew")
        container.grid_columnconfigure(0, weight=1)

        # Header
        header_label = ctk.CTkLabel(
            container,
            text="YouTube Multi-Audio Dub Downloader",
            font=ctk.CTkFont(size=22, weight="bold"),
        )
        header_label.grid(row=0, column=0, padx=24, pady=(22, 4), sticky="w")

        subtitle_label = ctk.CTkLabel(
            container,
            text="Select any video resolution and dubbed audio language track, merged cleanly into MP4 via FFmpeg.",
            font=ctk.CTkFont(size=13),
            text_color=("gray40", "gray70"),
        )
        subtitle_label.grid(row=1, column=0, padx=24, pady=(0, 18), sticky="w")

        # URL Input Row
        url_frame = ctk.CTkFrame(container, fg_color="transparent")
        url_frame.grid(row=2, column=0, padx=24, pady=(0, 14), sticky="ew")
        url_frame.grid_columnconfigure(0, weight=1)

        self.url_entry = ctk.CTkEntry(
            url_frame,
            height=42,
            placeholder_text="Paste YouTube video URL (e.g., https://www.youtube.com/watch?v=...)",
            font=ctk.CTkFont(size=13),
        )
        self.url_entry.grid(row=0, column=0, padx=(0, 10), sticky="ew")
        self.url_entry.bind("<Return>", lambda _event: self.on_fetch_clicked())

        self.fetch_button = ctk.CTkButton(
            url_frame,
            text="Fetch Video Info",
            height=42,
            width=155,
            font=ctk.CTkFont(size=13, weight="bold"),
            command=self.on_fetch_clicked,
        )
        self.fetch_button.grid(row=0, column=1, sticky="e")

        # Video Metadata Summary
        info_card = ctk.CTkFrame(container, corner_radius=10, fg_color=("gray88", "gray17"))
        info_card.grid(row=3, column=0, padx=24, pady=(0, 16), sticky="ew")
        info_card.grid_columnconfigure(0, weight=1)

        self.video_title_label = ctk.CTkLabel(
            info_card,
            text="No video loaded yet",
            font=ctk.CTkFont(size=14, weight="bold"),
            anchor="w",
            wraplength=640,
            justify="left",
        )
        self.video_title_label.grid(row=0, column=0, padx=16, pady=(12, 2), sticky="ew")

        self.video_meta_label = ctk.CTkLabel(
            info_card,
            text="Enter a YouTube URL and click 'Fetch Video Info' to load video qualities and audio dubs.",
            font=ctk.CTkFont(size=12),
            text_color=("gray45", "gray65"),
            anchor="w",
        )
        self.video_meta_label.grid(row=1, column=0, padx=16, pady=(0, 12), sticky="ew")

        # Dropdowns Row (Video Quality + Audio Language)
        dropdown_frame = ctk.CTkFrame(container, fg_color="transparent")
        dropdown_frame.grid(row=4, column=0, padx=24, pady=(0, 16), sticky="ew")
        dropdown_frame.grid_columnconfigure((0, 1), weight=1)

        quality_label = ctk.CTkLabel(
            dropdown_frame,
            text="Video Quality",
            font=ctk.CTkFont(size=13, weight="bold"),
            anchor="w",
        )
        quality_label.grid(row=0, column=0, padx=(0, 10), pady=(0, 6), sticky="w")

        audio_label = ctk.CTkLabel(
            dropdown_frame,
            text="Audio Language (Original & Dubs)",
            font=ctk.CTkFont(size=13, weight="bold"),
            anchor="w",
        )
        audio_label.grid(row=0, column=1, padx=(10, 0), pady=(0, 6), sticky="w")

        self.quality_combo = ctk.CTkComboBox(
            dropdown_frame,
            height=40,
            values=["Fetch a video first..."],
            state="disabled",
            font=ctk.CTkFont(size=13),
        )
        self.quality_combo.grid(row=1, column=0, padx=(0, 10), sticky="ew")

        self.audio_combo = ctk.CTkComboBox(
            dropdown_frame,
            height=40,
            values=["Fetch a video first..."],
            state="disabled",
            font=ctk.CTkFont(size=13),
        )
        self.audio_combo.grid(row=1, column=1, padx=(10, 0), sticky="ew")

        # Output Folder Selector
        folder_frame = ctk.CTkFrame(container, fg_color="transparent")
        folder_frame.grid(row=5, column=0, padx=24, pady=(0, 18), sticky="ew")
        folder_frame.grid_columnconfigure(0, weight=1)

        self.folder_label = ctk.CTkLabel(
            folder_frame,
            text=f"Save to: {self.output_dir}",
            font=ctk.CTkFont(size=12),
            text_color=("gray40", "gray70"),
            anchor="w",
        )
        self.folder_label.grid(row=0, column=0, padx=(0, 10), sticky="ew")

        self.browse_button = ctk.CTkButton(
            folder_frame,
            text="Choose Folder",
            width=120,
            height=32,
            fg_color="transparent",
            border_width=1,
            command=self.on_choose_folder,
        )
        self.browse_button.grid(row=0, column=1, sticky="e")

        # Progress Bar & Status Label
        self.progress_bar = ctk.CTkProgressBar(container, height=14, corner_radius=7)
        self.progress_bar.grid(row=6, column=0, padx=24, pady=(0, 8), sticky="ew")
        self.progress_bar.set(0)

        self.status_label = ctk.CTkLabel(
            container,
            text="Ready",
            font=ctk.CTkFont(size=12),
            text_color=("gray35", "gray75"),
            anchor="w",
        )
        self.status_label.grid(row=7, column=0, padx=24, pady=(0, 18), sticky="ew")

        # Download Button
        self.download_button = ctk.CTkButton(
            container,
            text="Download & Merge MP4",
            height=46,
            font=ctk.CTkFont(size=15, weight="bold"),
            state="disabled",
            command=self.on_download_clicked,
        )
        self.download_button.grid(row=8, column=0, padx=24, pady=(0, 22), sticky="ew")

    def _check_ffmpeg_startup(self) -> None:
        if shutil.which("ffmpeg") is None:
            self.status_label.configure(
                text="Warning: FFmpeg was not found in PATH. Install FFmpeg to merge video & audio.",
                text_color="#F59E0B",
            )

    def _set_busy(self, busy: bool) -> None:
        self.is_busy = busy
        if busy:
            self.fetch_button.configure(state="disabled")
            self.download_button.configure(state="disabled")
            self.browse_button.configure(state="disabled")
            self.url_entry.configure(state="disabled")
        else:
            self.fetch_button.configure(state="normal")
            self.browse_button.configure(state="normal")
            self.url_entry.configure(state="normal")
            has_streams = bool(self.video_map and self.audio_map)
            self.download_button.configure(state="normal" if has_streams else "disabled")

    def on_choose_folder(self) -> None:
        chosen = filedialog.askdirectory(initialdir=self.output_dir)
        if chosen:
            self.output_dir = chosen
            self.folder_label.configure(text=f"Save to: {self.output_dir}")

    def on_fetch_clicked(self) -> None:
        if self.is_busy:
            return

        url = self.url_entry.get().strip()
        if not url:
            self.status_label.configure(
                text="Please enter a valid YouTube URL first.",
                text_color="#EF4444",
            )
            return

        self._set_busy(True)
        self.progress_bar.configure(mode="indeterminate")
        self.progress_bar.start()
        self.status_label.configure(
            text="Fetching video metadata and audio dub tracks...",
            text_color="#60A5FA",
        )

        worker = threading.Thread(target=self._fetch_worker, args=(url,), daemon=True)
        worker.start()

    def _fetch_worker(self, url: str) -> None:
        try:
            ydl_opts: Dict[str, Any] = {
                "noplaylist": True,
                "quiet": True,
                "no_warnings": True,
            }
            cookiefile = resolve_local_cookiefile()
            if cookiefile:
                ydl_opts["cookiefile"] = cookiefile
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)

            formats = info.get("formats") or []
            video_options = parse_video_formats(formats)
            audio_options = parse_audio_dubs(formats)

            self.after(0, self._on_fetch_success, info, video_options, audio_options)
        except Exception as exc:
            self.after(0, self._on_fetch_error, str(exc))

    def _on_fetch_success(
        self,
        info: Dict[str, Any],
        video_options: List[Tuple[str, str]],
        audio_options: List[Tuple[str, str]],
    ) -> None:
        self.progress_bar.stop()
        self.progress_bar.configure(mode="determinate")
        self.progress_bar.set(0)

        self.current_info = info
        self.video_map = {label: fmt_id for label, fmt_id in video_options}
        self.audio_map = {label: fmt_id for label, fmt_id in audio_options}

        title = info.get("title") or "Untitled Video"
        uploader = info.get("uploader") or info.get("channel") or "Unknown Channel"
        duration = format_duration(info.get("duration"))
        self.video_title_label.configure(text=title)
        self.video_meta_label.configure(
            text=f"{uploader}  ·  Duration: {duration}  ·  {len(video_options)} video qualities, {len(audio_options)} audio tracks"
        )

        if video_options:
            labels = [label for label, _ in video_options]
            self.quality_combo.configure(values=labels, state="readonly")
            self.quality_combo.set(labels[0])
        else:
            self.quality_combo.configure(values=["No video streams found"], state="disabled")
            self.quality_combo.set("No video streams found")

        if audio_options:
            labels = [label for label, _ in audio_options]
            self.audio_combo.configure(values=labels, state="readonly")
            self.audio_combo.set(labels[0])
        else:
            self.audio_combo.configure(values=["No audio streams found"], state="disabled")
            self.audio_combo.set("No audio streams found")

        self._set_busy(False)
        if video_options and audio_options:
            self.status_label.configure(
                text="Ready to download. Choose your Video Quality & Audio Language, then click Download.",
                text_color="#10B981",
            )
        else:
            self.status_label.configure(
                text="Could not locate both video and audio streams for this URL.",
                text_color="#EF4444",
            )

    def _on_fetch_error(self, error_msg: str) -> None:
        self.progress_bar.stop()
        self.progress_bar.configure(mode="determinate")
        self.progress_bar.set(0)
        self._set_busy(False)
        self.status_label.configure(
            text=f"Fetch failed: {error_msg}",
            text_color="#EF4444",
        )

    def on_download_clicked(self) -> None:
        if self.is_busy:
            return

        if shutil.which("ffmpeg") is None:
            self.status_label.configure(
                text="FFmpeg is required to merge video & dubbed audio. Please install FFmpeg and add it to PATH.",
                text_color="#EF4444",
            )
            return

        url = self.url_entry.get().strip()
        selected_quality = self.quality_combo.get()
        selected_audio = self.audio_combo.get()

        video_format_id = self.video_map.get(selected_quality)
        audio_format_id = self.audio_map.get(selected_audio)

        if not url or not video_format_id or not audio_format_id:
            self.status_label.configure(
                text="Please fetch a video and select both a quality and an audio language.",
                text_color="#EF4444",
            )
            return

        self._set_busy(True)
        self.progress_bar.configure(mode="determinate")
        self.progress_bar.set(0)
        self.status_label.configure(
            text=f"Starting download ({video_format_id}+{audio_format_id})...",
            text_color="#60A5FA",
        )

        worker = threading.Thread(
            target=self._download_worker,
            args=(url, video_format_id, audio_format_id),
            daemon=True,
        )
        worker.start()

    def _download_worker(self, url: str, video_format_id: str, audio_format_id: str) -> None:
        def progress_hook(d: Dict[str, Any]) -> None:
            progress, text = format_progress_stats(d)
            self.after(0, self._update_progress_ui, progress, text)

        def postprocessor_hook(d: Dict[str, Any]) -> None:
            if d.get("status") == "started":
                self.after(
                    0,
                    self._update_progress_ui,
                    1.0,
                    "Merging video & dubbed audio via FFmpeg...",
                )
            elif d.get("status") == "finished":
                self.after(
                    0,
                    self._update_progress_ui,
                    1.0,
                    "FFmpeg muxing complete!",
                )

        try:
            ydl_opts = build_ydl_download_opts(
                video_format_id=video_format_id,
                audio_format_id=audio_format_id,
                output_dir=self.output_dir,
                progress_hook=progress_hook,
                postprocessor_hook=postprocessor_hook,
            )
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])

            self.after(0, self._on_download_complete)
        except Exception as exc:
            self.after(0, self._on_download_error, str(exc))

    def _update_progress_ui(self, progress: float, status_text: str) -> None:
        self.progress_bar.set(progress)
        self.status_label.configure(text=status_text, text_color="#60A5FA")

    def _on_download_complete(self) -> None:
        self.progress_bar.set(1.0)
        self._set_busy(False)
        self.status_label.configure(
            text=f"Completed! Saved MP4 to {self.output_dir}",
            text_color="#10B981",
        )

    def _on_download_error(self, error_msg: str) -> None:
        self._set_busy(False)
        self.status_label.configure(
            text=f"Download failed: {error_msg}",
            text_color="#EF4444",
        )


if __name__ == "__main__":
    app = YouTubeDubDownloaderApp()
    app.mainloop()
