#!/usr/bin/env python3
"""Deterministic 3.4.0 final-art packaging. Writes only under owned final trees."""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
DOCS_FINAL = REPO / "docs" / "assets" / "co-engineer-3.4.0" / "final"
PLUGIN_FINAL = REPO / "plugins" / "codex-co-engineer" / "assets" / "experience" / "final"
DOCS_SOURCES = DOCS_FINAL / "sources"
PLUGIN_SOURCES = PLUGIN_FINAL / "sources"
DOCS_DERIVED = DOCS_FINAL / "derived"
PLUGIN_DERIVED = PLUGIN_FINAL / "derived"

PRODUCT_LEAD = "Give Codex a team of external co-engineers without giving up control."
HONEST_CLAIM = (
    "up to eight isolated external co-engineers, one bounded run, "
    "one coordinated wait, one verified decision"
)
PLUGIN_VERSION = "3.3.0"

SOURCE_SPECS = (
    {
        "id": "co-engineer-wordmark",
        "filename": "grok-image-d7f8b7c9-c929-4a3f-96d0-35f69ffb1403.png",
        "sha256": "fcd7e67237e8bac3d2dd5c7c21b37e61df4acefac01cd2172c25c80372e03bca",
        "original_filename": "grok-image-d7f8b7c9-c929-4a3f-96d0-35f69ffb1403.png",
        "redacted_origin": "owner-intake/CheapTesting/grok-image-d7f8b7c9-c929-4a3f-96d0-35f69ffb1403.png",
        "attachment_id": None,
        "kind": "image",
    },
    {
        "id": "co-engineer-square-mark",
        "filename": "chatgpt-image-aug-27-2026-square-mark.png",
        "sha256": "6282ebb40e87fe0ef71069e1e2cd7603d05f21dfe0ad2623605194702f5180fa",
        "original_filename": "ChatGPT Image Aug 27, 2026, 01_51_12 PM.png",
        "redacted_origin": "owner-intake/CheapTesting/ChatGPT Image Aug 27, 2026, 01_51_12 PM.png",
        "attachment_id": None,
        "kind": "image",
    },
    {
        "id": "architecture-static",
        "filename": "856Qz.png",
        "sha256": "aad77a7e0c19919e6325c555ace274759bb81e0c7341487b998a76f05acaeb74",
        "original_filename": "856Qz.png",
        "redacted_origin": "owner-intake/CheapTesting/856Qz.png",
        "attachment_id": None,
        "kind": "image",
    },
    {
        "id": "first-delegation-static",
        "filename": "grok-image-7845770e-036e-42aa-baf0-4fdf1737fe5d.jpg",
        "sha256": "0aa5595d0d71438b14ded380857483e61dd807b25db9cda59b143c02faafc678",
        "original_filename": "grok-image-7845770e-036e-42aa-baf0-4fdf1737fe5d.jpg",
        "redacted_origin": "owner-intake/CheapTesting/grok-image-7845770e-036e-42aa-baf0-4fdf1737fe5d.jpg",
        "attachment_id": None,
        "kind": "image",
    },
    {
        "id": "multi-lane-static-malformed",
        "filename": "grok-image-688b2e53-8327-4db7-8fca-017315787f0f.jpg",
        "sha256": "37bc5cd0382829799aea0b638b54636be1d8a575546aa16f9aa9809703d8e44f",
        "original_filename": "grok-image-688b2e53-8327-4db7-8fca-017315787f0f.jpg",
        "redacted_origin": "owner-intake/CheapTesting/grok-image-688b2e53-8327-4db7-8fca-017315787f0f.jpg",
        "attachment_id": None,
        "kind": "image",
    },
    {
        "id": "provider-choices-static",
        "filename": "grok-image-9a20c1b8-8377-48d5-b85a-0000d1677bbb.jpg",
        "sha256": "7d523040163f376498f2e472101b1c7319d015990a36a1d6273957e1833d129e",
        "original_filename": "grok-image-9a20c1b8-8377-48d5-b85a-0000d1677bbb.jpg",
        "redacted_origin": "owner-intake/CheapTesting/grok-image-9a20c1b8-8377-48d5-b85a-0000d1677bbb.jpg",
        "attachment_id": None,
        "kind": "image",
    },
    {
        "id": "conceptual-combined-outcome",
        "filename": "grok-image-0bf969e7-4d27-49d5-9887-6dfa7a93fb87.jpg",
        "sha256": "046cddc8debe68c1b7ea1dbee0650bb472e16dfbb47703036b7f270bf06edec2",
        "original_filename": "grok-image-0bf969e7-4d27-49d5-9887-6dfa7a93fb87.jpg",
        "redacted_origin": "owner-intake/CheapTesting/grok-image-0bf969e7-4d27-49d5-9887-6dfa7a93fb87.jpg",
        "attachment_id": None,
        "kind": "image",
    },
    {
        "id": "install-auth-static",
        "filename": "grok-image-a8a1cd99-2dad-434d-b622-522d395e4ace.jpg",
        "sha256": "88e2bae21b9417dea21f9ab224d68a040920e458a0c34995daf35ea5eea1f9fc",
        "original_filename": "grok-image-a8a1cd99-2dad-434d-b622-522d395e4ace.jpg",
        "redacted_origin": "owner-intake/CheapTesting/grok-image-a8a1cd99-2dad-434d-b622-522d395e4ace.jpg",
        "attachment_id": None,
        "kind": "image",
    },
    {
        "id": "architecture-motion",
        "filename": "grok-video-8f9d1b07-38f2-4b3e-8116-cc5f928755ee.mp4",
        "sha256": "aebc54839ab39e5d402e2935af35ba829af4608f0f7d76f5adbe0560fd131117",
        "original_filename": "grok-video-8f9d1b07-38f2-4b3e-8116-cc5f928755ee.mp4",
        "redacted_origin": (
            "~/.codex/attachments/f69decc1-9912-4582-a096-8c1b0edd18c2/"
            "grok-video-8f9d1b07-38f2-4b3e-8116-cc5f928755ee.mp4"
        ),
        "attachment_id": "f69decc1-9912-4582-a096-8c1b0edd18c2",
        "kind": "video",
    },
    {
        "id": "multi-lane-motion",
        "filename": "grok-video-a9b4de81-33fa-4f93-83e7-cee955480531.mp4",
        "sha256": "0ddffd0bd7478b645211fa3aa3707ec62f8777591f73ec5c32c5f0af4c9467e4",
        "original_filename": "grok-video-a9b4de81-33fa-4f93-83e7-cee955480531.mp4",
        "redacted_origin": (
            "~/.codex/attachments/f69decc1-9912-4582-a096-8c1b0edd18c2/"
            "grok-video-a9b4de81-33fa-4f93-83e7-cee955480531.mp4"
        ),
        "attachment_id": "f69decc1-9912-4582-a096-8c1b0edd18c2",
        "kind": "video",
    },
)

SIZE_CEILINGS = {
    "docs/assets/co-engineer-3.4.0/final/derived/hero-demo.jpg": 200000,
    "docs/assets/co-engineer-3.4.0/final/derived/hero-frame-poster.jpg": 200000,
    "docs/assets/co-engineer-3.4.0/final/derived/hero-muted.mp4": 800000,
    "docs/assets/co-engineer-3.4.0/final/derived/hero-muted.webm": 800000,
    "docs/assets/co-engineer-3.4.0/final/derived/first-delegation.jpg": 358400,
    "docs/assets/co-engineer-3.4.0/final/derived/provider-choices.jpg": 358400,
    "docs/assets/co-engineer-3.4.0/final/derived/failure-unresolved.jpg": 358400,
    "docs/assets/co-engineer-3.4.0/final/derived/install-auth.jpg": 358400,
    "docs/assets/co-engineer-3.4.0/final/derived/multi-lane-run.held.jpg": 358400,
    "docs/assets/co-engineer-3.4.0/final/derived/multi-lane-frame-poster.held.jpg": 358400,
    "docs/assets/co-engineer-3.4.0/final/derived/multi-lane-muted.held.mp4": 800000,
    "docs/assets/co-engineer-3.4.0/final/derived/multi-lane-muted.held.webm": 800000,
    "plugins/codex-co-engineer/assets/experience/final/derived/hero-demo.jpg": 80000,
    "plugins/codex-co-engineer/assets/experience/final/derived/hero-frame-poster.jpg": 40000,
    "plugins/codex-co-engineer/assets/experience/final/derived/hero-muted.mp4": 200000,
    "plugins/codex-co-engineer/assets/experience/final/derived/hero-muted.webm": 400000,
    "plugins/codex-co-engineer/assets/experience/final/derived/first-delegation.jpg": 100000,
    "plugins/codex-co-engineer/assets/experience/final/derived/provider-choices.jpg": 100000,
    "plugins/codex-co-engineer/assets/experience/final/derived/failure-unresolved.jpg": 100000,
    "plugins/codex-co-engineer/assets/experience/final/derived/install-auth.jpg": 100000,
    "plugins/codex-co-engineer/assets/experience/final/derived/multi-lane-run.held.jpg": 100000,
    "plugins/codex-co-engineer/assets/experience/final/derived/multi-lane-frame-poster.held.jpg": 40000,
    "plugins/codex-co-engineer/assets/experience/final/derived/multi-lane-muted.held.mp4": 200000,
    "plugins/codex-co-engineer/assets/experience/final/derived/multi-lane-muted.held.webm": 400000,
    "docs/assets/co-engineer-3.4.0/final/derived/wordmark.png": 100000,
    "docs/assets/co-engineer-3.4.0/final/derived/square-mark.png": 180000,
    "plugins/codex-co-engineer/assets/experience/final/derived/wordmark.png": 100000,
    "plugins/codex-co-engineer/assets/experience/final/derived/square-mark.png": 180000,
}

IDENTITY_JOBS = (
    {
        "name": "wordmark.png",
        "source_id": "co-engineer-wordmark",
        "width": 1024,
        "height": 576,
        "mode": "RGBA",
        "slot": "identity-wordmark",
        "role_docs": "docs-identity-wordmark",
        "role_plugin": "plugin-identity-wordmark",
        "alt_text": "Approved Co-Engineer wordmark",
        "notes": "Deterministic LANCZOS raster of the approved Co-Engineer wordmark. Alpha preserved for light and dark chrome. Not an SVG approximation.",
    },
    {
        "name": "square-mark.png",
        "source_id": "co-engineer-square-mark",
        "width": 512,
        "height": 512,
        "mode": "RGB",
        "slot": "identity-square-mark",
        "role_docs": "docs-identity-square-mark",
        "role_plugin": "plugin-identity-square-mark",
        "alt_text": "Approved Co-Engineer square interlocking mark",
        "notes": "Deterministic LANCZOS raster of the approved square interlocking mark for composerIcon. Not an SVG approximation.",
    },
)

WHITE = "white"
DARK = "0x0C0B10"
LIGHT = "0xECECEC"


def fail(message: str) -> None:
    raise SystemExit(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tool_version(binary: str) -> str:
    raw = subprocess.check_output([binary, "-version"], text=True)
    return raw.splitlines()[0]


def run(argv: list[str]) -> None:
    subprocess.check_call(argv)


def probe(path: Path) -> dict:
    raw = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-print_format",
            "json",
            str(path),
        ],
        text=True,
    )
    return json.loads(raw)


def jpeg_size(path: Path) -> tuple[int, int]:
    from PIL import Image

    with Image.open(path) as image:
        return image.size


def pad_filter(width: int, height: int, color: str) -> str:
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease:"
        f"force_divisible_by=2:flags=lanczos,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color={color},setsar=1"
    )


def encode_png_identity(src: Path, dest: Path, width: int, height: int, mode: str) -> list[str]:
    from PIL import Image

    dest.parent.mkdir(parents=True, exist_ok=True)
    image = Image.open(src).convert(mode).resize((width, height), Image.Resampling.LANCZOS)
    image.save(dest, format="PNG", compress_level=9, optimize=False)
    return [
        "python3",
        "PIL.Image.convert+resize(LANCZOS)+PNG(compress_level=9,optimize=False)",
        rel(src),
        rel(dest),
        mode,
        str(width),
        str(height),
    ]


def identity_argv(src: Path, dest: Path, width: int, height: int, mode: str) -> list[str]:
    return [
        "python3",
        "PIL.Image.convert+resize(LANCZOS)+PNG(compress_level=9,optimize=False)",
        rel(src),
        rel(dest),
        mode,
        str(width),
        str(height),
    ]


def rel(path: Path) -> str:
    return path.relative_to(REPO).as_posix()


def encode_still(src: Path, dest: Path, width: int, height: int, color: str, ceiling: int) -> list[str]:
    dest.parent.mkdir(parents=True, exist_ok=True)
    vf = pad_filter(width, height, color)
    chosen: list[str] | None = None
    for quality in range(3, 16):
        argv = [
            "ffmpeg",
            "-hide_banner",
            "-y",
            "-i",
            str(src),
            "-frames:v",
            "1",
            "-vf",
            vf,
            "-q:v",
            str(quality),
            "-map_metadata",
            "-1",
            "-fflags",
            "+bitexact",
            str(dest),
        ]
        run(argv)
        if dest.stat().st_size <= ceiling:
            chosen = argv
            break
    if chosen is None:
        fail(f"{dest} still exceeds ceiling {ceiling} at q:v 15 ({dest.stat().st_size} bytes)")
    return chosen


def encode_frame(
    src: Path,
    dest: Path,
    width: int,
    height: int,
    color: str,
    ceiling: int,
    seek: str,
) -> list[str]:
    dest.parent.mkdir(parents=True, exist_ok=True)
    vf = pad_filter(width, height, color)
    chosen: list[str] | None = None
    for quality in range(4, 16):
        argv = [
            "ffmpeg",
            "-hide_banner",
            "-y",
            "-ss",
            seek,
            "-i",
            str(src),
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-vf",
            vf,
            "-q:v",
            str(quality),
            "-map_metadata",
            "-1",
            "-fflags",
            "+bitexact",
            str(dest),
        ]
        run(argv)
        if dest.stat().st_size <= ceiling:
            chosen = argv
            break
    if chosen is None:
        fail(f"{dest} frame poster exceeds ceiling {ceiling}")
    return chosen


def encode_mp4(src: Path, dest: Path, width: int, height: int, color: str, ceiling: int, start_crf: int) -> list[str]:
    dest.parent.mkdir(parents=True, exist_ok=True)
    vf = pad_filter(width, height, color)
    chosen: list[str] | None = None
    for crf in range(start_crf, 45):
        argv = [
            "ffmpeg",
            "-hide_banner",
            "-y",
            "-i",
            str(src),
            "-map",
            "0:v:0",
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-profile:v",
            "high",
            "-level",
            "4.1",
            "-preset",
            "slow",
            "-crf",
            str(crf),
            "-threads",
            "1",
            "-x264-params",
            "threads=1",
            "-vf",
            vf,
            "-r",
            "24",
            "-movflags",
            "+faststart",
            "-map_metadata",
            "-1",
            "-fflags",
            "+bitexact",
            str(dest),
        ]
        run(argv)
        if dest.stat().st_size <= ceiling:
            chosen = argv
            break
    if chosen is None:
        fail(f"{dest} mp4 exceeds ceiling {ceiling} ({dest.stat().st_size} bytes)")
    return chosen


def encode_webm(src: Path, dest: Path, width: int, height: int, color: str, ceiling: int, start_crf: int) -> list[str]:
    dest.parent.mkdir(parents=True, exist_ok=True)
    vf = pad_filter(width, height, color)
    chosen: list[str] | None = None
    for crf in range(start_crf, 56):
        argv = [
            "ffmpeg",
            "-hide_banner",
            "-y",
            "-i",
            str(src),
            "-map",
            "0:v:0",
            "-an",
            "-c:v",
            "libvpx-vp9",
            "-pix_fmt",
            "yuv420p",
            "-b:v",
            "0",
            "-crf",
            str(crf),
            "-row-mt",
            "0",
            "-deadline",
            "good",
            "-cpu-used",
            "1",
            "-threads",
            "1",
            "-vf",
            vf,
            "-r",
            "24",
            "-map_metadata",
            "-1",
            "-fflags",
            "+bitexact",
            str(dest),
        ]
        run(argv)
        if dest.stat().st_size <= ceiling:
            chosen = argv
            break
    if chosen is None:
        fail(f"{dest} webm exceeds ceiling {ceiling} ({dest.stat().st_size} bytes)")
    return chosen


def stream_summary(probed: dict) -> dict:
    streams = []
    for stream in probed.get("streams", []):
        entry = {
            "index": stream.get("index"),
            "codec_type": stream.get("codec_type"),
            "codec_name": stream.get("codec_name"),
            "width": stream.get("width"),
            "height": stream.get("height"),
            "avg_frame_rate": stream.get("avg_frame_rate"),
            "duration": stream.get("duration"),
            "channels": stream.get("channels"),
            "sample_rate": stream.get("sample_rate"),
            "attached_pic": bool(stream.get("disposition", {}).get("attached_pic")),
        }
        streams.append(entry)
    fmt = probed.get("format", {})
    return {
        "nb_streams": int(fmt.get("nb_streams") or len(streams)),
        "duration_s": fmt.get("duration"),
        "format_name": fmt.get("format_name"),
        "bit_rate": fmt.get("bit_rate"),
        "streams": streams,
    }


def assert_silent_video(path: Path, codec: str, width: int, height: int) -> dict:
    probed = probe(path)
    summary = stream_summary(probed)
    audio = [stream for stream in summary["streams"] if stream["codec_type"] == "audio"]
    video = [stream for stream in summary["streams"] if stream["codec_type"] == "video"]
    attached = [stream for stream in video if stream["attached_pic"]]
    if audio:
        fail(f"{path} still has audio: {audio}")
    if summary["nb_streams"] != 1:
        fail(f"{path} expected one stream, found {summary['nb_streams']}")
    if attached:
        fail(f"{path} still has cover art")
    if video[0]["codec_name"] != codec:
        fail(f"{path} codec {video[0]['codec_name']} != {codec}")
    if video[0]["width"] != width or video[0]["height"] != height:
        fail(f"{path} dimensions {video[0]['width']}x{video[0]['height']}")
    if video[0]["avg_frame_rate"] != "24/1":
        fail(f"{path} fps {video[0]['avg_frame_rate']}")
    return summary


def copy_plugin_sources() -> None:
    PLUGIN_SOURCES.mkdir(parents=True, exist_ok=True)
    for spec in SOURCE_SPECS:
        src = DOCS_SOURCES / spec["filename"]
        dest = PLUGIN_SOURCES / spec["filename"]
        if not src.is_file():
            fail(f"missing source {src}")
        actual = sha256_file(src)
        if actual != spec["sha256"]:
            fail(f"source hash mismatch {src}: {actual}")
        shutil.copyfile(src, dest)
        copied = sha256_file(dest)
        if copied != spec["sha256"]:
            fail(f"plugin source copy mismatch {dest}")
        if dest.stat().st_size != src.stat().st_size:
            fail(f"plugin source size mismatch {dest}")


def source_record(spec: dict, path: Path) -> dict:
    probed = probe(path)
    summary = stream_summary(probed)
    width = summary["streams"][0].get("width") if summary["streams"] else None
    height = summary["streams"][0].get("height") if summary["streams"] else None
    if spec["kind"] == "image":
        width, height = jpeg_size(path) if path.suffix.lower() in {".jpg", ".jpeg"} else jpeg_size(path)
    return {
        "id": spec["id"],
        "role": "byte-exact-original",
        "path": rel(path),
        "original_filename": spec["original_filename"],
        "redacted_origin": spec["redacted_origin"],
        "attachment_id": spec["attachment_id"],
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size,
        "width": width,
        "height": height,
        "duration_s": summary["duration_s"] if spec["kind"] == "video" else None,
        "avg_frame_rate": (
            summary["streams"][0].get("avg_frame_rate") if spec["kind"] == "video" else None
        ),
        "codecs_streams": summary,
        "source_sha256": spec["sha256"],
        "transformation": "cp -- <verified-original> <repo-path>",
        "intended_slot": None,
        "publishable": False,
        "hold_reason": "Provenance original; not a shipping derivative.",
        "kind": "source",
    }


def derived_record(
    path: Path,
    *,
    source_id: str,
    source_sha: str,
    slot: str,
    publishable: bool,
    hold_reason: str | None,
    role: str,
    command: list[str],
    codec: str,
    width: int,
    height: int,
    muted: bool,
    exact_host_screenshot: bool,
    alt_text: str | None,
    notes: str,
) -> dict:
    probed = probe(path) if path.suffix.lower() in {".mp4", ".webm"} else None
    summary = stream_summary(probed) if probed else {
        "nb_streams": 1,
        "duration_s": None,
        "format_name": "image2",
        "bit_rate": None,
        "streams": [
            {
                "index": 0,
                "codec_type": "video",
                "codec_name": codec,
                "width": width,
                "height": height,
                "avg_frame_rate": None,
                "duration": None,
                "channels": None,
                "sample_rate": None,
                "attached_pic": False,
            }
        ],
    }
    if path.suffix.lower() in {".jpg", ".jpeg", ".png"}:
        actual_w, actual_h = jpeg_size(path)
        if (actual_w, actual_h) != (width, height):
            fail(f"{path} image size {actual_w}x{actual_h} != {width}x{height}")
    ceiling = SIZE_CEILINGS.get(rel(path))
    if ceiling is not None and path.stat().st_size > ceiling:
        fail(f"{path} exceeds ceiling {ceiling}")
    display_command = []
    for item in command:
        try:
            item_path = Path(item)
            if item_path.is_absolute() and str(item_path).startswith(str(REPO)):
                display_command.append(rel(item_path))
            else:
                display_command.append(item)
        except Exception:
            display_command.append(item)
    return {
        "id": rel(path).replace("/", "__"),
        "role": role,
        "path": rel(path),
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size,
        "width": width,
        "height": height,
        "duration_s": summary.get("duration_s") if path.suffix.lower() in {".mp4", ".webm"} else None,
        "avg_frame_rate": "24/1" if path.suffix.lower() in {".mp4", ".webm"} else None,
        "codecs_streams": summary,
        "source_id": source_id,
        "source_sha256": source_sha,
        "transformation": " ".join(display_command),
        "transformation_argv": display_command,
        "intended_slot": slot,
        "publishable": publishable,
        "hold_reason": hold_reason,
        "muted": muted,
        "audio": False if muted or path.suffix.lower() in {".jpg", ".jpeg", ".png"} else None,
        "exact_host_screenshot": exact_host_screenshot,
        "alt_text": alt_text,
        "notes": notes,
        "kind": "derived",
        "size_ceiling": ceiling,
    }


def expected_derived_paths() -> list[Path]:
    names = [
        "hero-demo.jpg",
        "hero-frame-poster.jpg",
        "hero-muted.mp4",
        "hero-muted.webm",
        "first-delegation.jpg",
        "provider-choices.jpg",
        "failure-unresolved.jpg",
        "install-auth.jpg",
        "multi-lane-run.held.jpg",
        "multi-lane-frame-poster.held.jpg",
        "multi-lane-muted.held.mp4",
        "multi-lane-muted.held.webm",
    ]
    return [tree / name for tree in (DOCS_DERIVED, PLUGIN_DERIVED) for name in names]


def load_existing_commands() -> dict[str, list[str]]:
    manifest_path = DOCS_FINAL / "manifest.json"
    if not manifest_path.is_file():
        fail("derived files exist but docs manifest is missing; re-run with --force-encode")
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    commands: dict[str, list[str]] = {}
    for entry in data.get("inventory", []):
        argv = entry.get("transformation_argv")
        if entry.get("kind") == "derived" and argv:
            commands[entry["path"]] = argv
    return commands


def main() -> None:
    inspect = DOCS_FINAL / "_inspect"
    if inspect.exists():
        shutil.rmtree(inspect)

    copy_plugin_sources()
    DOCS_DERIVED.mkdir(parents=True, exist_ok=True)
    PLUGIN_DERIVED.mkdir(parents=True, exist_ok=True)

    src = {spec["id"]: DOCS_SOURCES / spec["filename"] for spec in SOURCE_SPECS}
    hashes = {spec["id"]: spec["sha256"] for spec in SOURCE_SPECS}

    derived_commands: dict[str, list[str]] = {}
    skip_encode = all(path.is_file() for path in expected_derived_paths()) and "--force-encode" not in sys.argv
    if skip_encode:
        derived_commands = load_existing_commands()

    identity_paths = [
        tree / job["name"] for tree in (DOCS_DERIVED, PLUGIN_DERIVED) for job in IDENTITY_JOBS
    ]
    skip_identity = all(path.is_file() for path in identity_paths) and "--force-encode" not in sys.argv
    for job in IDENTITY_JOBS:
        docs_path = DOCS_DERIVED / job["name"]
        plugin_path = PLUGIN_DERIVED / job["name"]
        source_path = src[job["source_id"]]
        if skip_identity:
            derived_commands.setdefault(
                rel(docs_path),
                identity_argv(source_path, docs_path, job["width"], job["height"], job["mode"]),
            )
            derived_commands.setdefault(
                rel(plugin_path),
                ["cp", "--", rel(docs_path), rel(plugin_path)],
            )
            continue
        derived_commands[rel(docs_path)] = encode_png_identity(
            source_path, docs_path, job["width"], job["height"], job["mode"]
        )
        shutil.copyfile(docs_path, plugin_path)
        if sha256_file(docs_path) != sha256_file(plugin_path):
            fail(f"identity mirror mismatch {plugin_path}")
        derived_commands[rel(plugin_path)] = ["cp", "--", rel(docs_path), rel(plugin_path)]

    still_jobs = [
        ("hero-demo.jpg", "architecture-static", 1920, 1088, WHITE, 960, 544, "hero-demo"),
        ("first-delegation.jpg", "first-delegation-static", 1600, 1000, DARK, 800, 500, "first-delegation"),
        ("provider-choices.jpg", "provider-choices-static", 1600, 1000, DARK, 800, 500, "provider-choices"),
        ("failure-unresolved.jpg", "conceptual-combined-outcome", 1600, 1000, DARK, 800, 500, "failure-unresolved"),
        ("install-auth.jpg", "install-auth-static", 1600, 1000, DARK, 800, 500, "install-auth"),
        ("multi-lane-run.held.jpg", "multi-lane-static-malformed", 1600, 1000, DARK, 800, 500, "multi-lane-run"),
    ]
    if not skip_encode:
        for name, source_id, dw, dh, color, pw, ph, _slot in still_jobs:
            docs_path = DOCS_DERIVED / name
            plugin_path = PLUGIN_DERIVED / name
            derived_commands[rel(docs_path)] = encode_still(
                src[source_id], docs_path, dw, dh, color, SIZE_CEILINGS[rel(docs_path)]
            )
            derived_commands[rel(plugin_path)] = encode_still(
                src[source_id], plugin_path, pw, ph, color, SIZE_CEILINGS[rel(plugin_path)]
            )

        derived_commands[rel(DOCS_DERIVED / "hero-frame-poster.jpg")] = encode_frame(
            src["architecture-motion"],
            DOCS_DERIVED / "hero-frame-poster.jpg",
            1920,
            1088,
            WHITE,
            SIZE_CEILINGS[rel(DOCS_DERIVED / "hero-frame-poster.jpg")],
            "0.20",
        )
        derived_commands[rel(PLUGIN_DERIVED / "hero-frame-poster.jpg")] = encode_frame(
            src["architecture-motion"],
            PLUGIN_DERIVED / "hero-frame-poster.jpg",
            960,
            544,
            WHITE,
            SIZE_CEILINGS[rel(PLUGIN_DERIVED / "hero-frame-poster.jpg")],
            "0.20",
        )
        derived_commands[rel(DOCS_DERIVED / "multi-lane-frame-poster.held.jpg")] = encode_frame(
            src["multi-lane-motion"],
            DOCS_DERIVED / "multi-lane-frame-poster.held.jpg",
            1600,
            1000,
            LIGHT,
            SIZE_CEILINGS[rel(DOCS_DERIVED / "multi-lane-frame-poster.held.jpg")],
            "8.00",
        )
        derived_commands[rel(PLUGIN_DERIVED / "multi-lane-frame-poster.held.jpg")] = encode_frame(
            src["multi-lane-motion"],
            PLUGIN_DERIVED / "multi-lane-frame-poster.held.jpg",
            800,
            500,
            LIGHT,
            SIZE_CEILINGS[rel(PLUGIN_DERIVED / "multi-lane-frame-poster.held.jpg")],
            "8.00",
        )
        derived_commands[rel(DOCS_DERIVED / "hero-muted.mp4")] = encode_mp4(
            src["architecture-motion"],
            DOCS_DERIVED / "hero-muted.mp4",
            1920,
            1088,
            WHITE,
            SIZE_CEILINGS[rel(DOCS_DERIVED / "hero-muted.mp4")],
            28,
        )
        derived_commands[rel(PLUGIN_DERIVED / "hero-muted.mp4")] = encode_mp4(
            src["architecture-motion"],
            PLUGIN_DERIVED / "hero-muted.mp4",
            960,
            544,
            WHITE,
            SIZE_CEILINGS[rel(PLUGIN_DERIVED / "hero-muted.mp4")],
            32,
        )
        derived_commands[rel(DOCS_DERIVED / "hero-muted.webm")] = encode_webm(
            src["architecture-motion"],
            DOCS_DERIVED / "hero-muted.webm",
            1920,
            1088,
            WHITE,
            SIZE_CEILINGS[rel(DOCS_DERIVED / "hero-muted.webm")],
            42,
        )
        derived_commands[rel(PLUGIN_DERIVED / "hero-muted.webm")] = encode_webm(
            src["architecture-motion"],
            PLUGIN_DERIVED / "hero-muted.webm",
            960,
            544,
            WHITE,
            SIZE_CEILINGS[rel(PLUGIN_DERIVED / "hero-muted.webm")],
            38,
        )
        derived_commands[rel(DOCS_DERIVED / "multi-lane-muted.held.mp4")] = encode_mp4(
            src["multi-lane-motion"],
            DOCS_DERIVED / "multi-lane-muted.held.mp4",
            1600,
            1000,
            LIGHT,
            SIZE_CEILINGS[rel(DOCS_DERIVED / "multi-lane-muted.held.mp4")],
            34,
        )
        derived_commands[rel(PLUGIN_DERIVED / "multi-lane-muted.held.mp4")] = encode_mp4(
            src["multi-lane-motion"],
            PLUGIN_DERIVED / "multi-lane-muted.held.mp4",
            800,
            500,
            LIGHT,
            SIZE_CEILINGS[rel(PLUGIN_DERIVED / "multi-lane-muted.held.mp4")],
            36,
        )
        derived_commands[rel(DOCS_DERIVED / "multi-lane-muted.held.webm")] = encode_webm(
            src["multi-lane-motion"],
            DOCS_DERIVED / "multi-lane-muted.held.webm",
            1600,
            1000,
            LIGHT,
            SIZE_CEILINGS[rel(DOCS_DERIVED / "multi-lane-muted.held.webm")],
            46,
        )
        derived_commands[rel(PLUGIN_DERIVED / "multi-lane-muted.held.webm")] = encode_webm(
            src["multi-lane-motion"],
            PLUGIN_DERIVED / "multi-lane-muted.held.webm",
            800,
            500,
            LIGHT,
            SIZE_CEILINGS[rel(PLUGIN_DERIVED / "multi-lane-muted.held.webm")],
            42,
        )

    for path, codec, width, height in (
        (DOCS_DERIVED / "hero-muted.mp4", "h264", 1920, 1088),
        (PLUGIN_DERIVED / "hero-muted.mp4", "h264", 960, 544),
        (DOCS_DERIVED / "hero-muted.webm", "vp9", 1920, 1088),
        (PLUGIN_DERIVED / "hero-muted.webm", "vp9", 960, 544),
        (DOCS_DERIVED / "multi-lane-muted.held.mp4", "h264", 1600, 1000),
        (PLUGIN_DERIVED / "multi-lane-muted.held.mp4", "h264", 800, 500),
        (DOCS_DERIVED / "multi-lane-muted.held.webm", "vp9", 1600, 1000),
        (PLUGIN_DERIVED / "multi-lane-muted.held.webm", "vp9", 800, 500),
    ):
        assert_silent_video(path, codec, width, height)

    conceptual_note = (
        "Conceptual illustration, not an exact Codex host screenshot. "
        "Do not treat painted UI as live branch/head/tree/scope/tests/reviews evidence."
    )
    inventory = []
    for spec in SOURCE_SPECS:
        inventory.append(source_record(spec, DOCS_SOURCES / spec["filename"]))
        inventory.append(source_record(spec, PLUGIN_SOURCES / spec["filename"]))

    derived_meta = [
        {
            "name": "wordmark.png",
            "source_id": "co-engineer-wordmark",
            "slot": "identity-wordmark",
            "publishable": True,
            "hold_reason": None,
            "role_docs": "docs-identity-wordmark",
            "role_plugin": "plugin-identity-wordmark",
            "docs_wh": (1024, 576),
            "plugin_wh": (1024, 576),
            "muted": True,
            "exact": False,
            "alt_text": "Approved Co-Engineer wordmark",
            "notes": (
                "Deterministic LANCZOS raster of the approved Co-Engineer wordmark. "
                "Alpha preserved for light and dark chrome. Used as logo/marketplace identity. "
                "Not an SVG approximation."
            ),
        },
        {
            "name": "square-mark.png",
            "source_id": "co-engineer-square-mark",
            "slot": "identity-square-mark",
            "publishable": True,
            "hold_reason": None,
            "role_docs": "docs-identity-square-mark",
            "role_plugin": "plugin-identity-square-mark",
            "docs_wh": (512, 512),
            "plugin_wh": (512, 512),
            "muted": True,
            "exact": False,
            "alt_text": "Approved Co-Engineer square interlocking mark",
            "notes": (
                "Deterministic LANCZOS raster of the approved square interlocking mark. "
                "Used as composerIcon. Not an SVG approximation."
            ),
        },
        {
            "name": "hero-demo.jpg",
            "source_id": "architecture-static",
            "slot": "hero-demo",
            "publishable": True,
            "hold_reason": None,
            "role_docs": "docs-hero-demo-static",
            "role_plugin": "plugin-hero-demo-static",
            "docs_wh": (1920, 1088),
            "plugin_wh": (960, 544),
            "muted": True,
            "exact": False,
            "alt_text": PRODUCT_LEAD,
            "notes": (
                "Architecture still: Codex remains chief engineer; Grok, Cursor, and Muse "
                "work in isolated workspaces; the user is the only merge authority. "
                "Not a fake live run."
            ),
        },
        {
            "name": "hero-frame-poster.jpg",
            "source_id": "architecture-motion",
            "slot": "hero-demo",
            "publishable": False,
            "hold_reason": (
                "Rejected from public README, plugin, and marketplace interfaces. "
                "Static-first shipping uses hero-demo.jpg only. Motion poster retained "
                "as non-publishable provenance and is not repaired."
            ),
            "role_docs": "docs-hero-motion-frame-poster",
            "role_plugin": "plugin-hero-motion-frame-poster",
            "docs_wh": (1920, 1088),
            "plugin_wh": (960, 544),
            "muted": True,
            "exact": False,
            "alt_text": None,
            "notes": "Non-publishable frame poster from the architecture motion source at 0.20s.",
        },
        {
            "name": "hero-muted.mp4",
            "source_id": "architecture-motion",
            "slot": "hero-demo",
            "publishable": False,
            "hold_reason": (
                "Rejected from public README, plugin, and marketplace interfaces. "
                "Static-first shipping uses hero-demo.jpg only. Motion retained as "
                "non-publishable provenance and is not repaired."
            ),
            "role_docs": "docs-hero-muted-mp4",
            "role_plugin": "plugin-hero-muted-mp4",
            "docs_wh": (1920, 1088),
            "plugin_wh": (960, 544),
            "muted": True,
            "exact": False,
            "alt_text": None,
            "notes": "Silent architecture motion retained as non-publishable provenance. Not linked publicly.",
        },
        {
            "name": "hero-muted.webm",
            "source_id": "architecture-motion",
            "slot": "hero-demo",
            "publishable": False,
            "hold_reason": (
                "Rejected from public README, plugin, and marketplace interfaces. "
                "Static-first shipping uses hero-demo.jpg only. Motion retained as "
                "non-publishable provenance and is not repaired."
            ),
            "role_docs": "docs-hero-muted-webm",
            "role_plugin": "plugin-hero-muted-webm",
            "docs_wh": (1920, 1088),
            "plugin_wh": (960, 544),
            "muted": True,
            "exact": False,
            "alt_text": None,
            "notes": "Silent architecture motion retained as non-publishable provenance. Not linked publicly.",
        },
        {
            "name": "first-delegation.jpg",
            "source_id": "first-delegation-static",
            "slot": "first-delegation",
            "publishable": True,
            "hold_reason": None,
            "role_docs": "docs-first-delegation-static",
            "role_plugin": "plugin-first-delegation-static",
            "docs_wh": (1600, 1000),
            "plugin_wh": (800, 500),
            "muted": True,
            "exact": False,
            "alt_text": "First natural-language delegation and one verified candidate",
            "notes": conceptual_note + " One-lane Grok delegation sequence.",
        },
        {
            "name": "provider-choices.jpg",
            "source_id": "provider-choices-static",
            "slot": "provider-choices",
            "publishable": True,
            "hold_reason": None,
            "role_docs": "docs-provider-choices-static",
            "role_plugin": "plugin-provider-choices-static",
            "docs_wh": (1600, 1000),
            "plugin_wh": (800, 500),
            "muted": True,
            "exact": False,
            "alt_text": "Explicit Grok, Cursor, and Muse assignment choices",
            "notes": conceptual_note + " Explicit Grok, Cursor, and Muse assignment, not a learned router.",
        },
        {
            "name": "failure-unresolved.jpg",
            "source_id": "conceptual-combined-outcome",
            "slot": "failure-unresolved",
            "publishable": True,
            "hold_reason": None,
            "role_docs": "docs-failure-unresolved-static",
            "role_plugin": "plugin-failure-unresolved-static",
            "docs_wh": (1600, 1000),
            "plugin_wh": (800, 500),
            "muted": True,
            "exact": False,
            "alt_text": "Required lane failed or remains unresolved, so no verified candidate is claimed",
            "notes": (
                "Conceptual combined outcome used only for failure/unresolved. "
                "It also paints a verified-candidate panel but does not show branch, head, tree, "
                "scope, tests, reviews, candidate, or sanitized-evidence details required by "
                "verified-final-decision. Not relabeled as that slot."
            ),
        },
        {
            "name": "install-auth.jpg",
            "source_id": "install-auth-static",
            "slot": "install-auth",
            "publishable": True,
            "hold_reason": None,
            "role_docs": "docs-install-auth-static",
            "role_plugin": "plugin-install-auth-static",
            "docs_wh": (1600, 1000),
            "plugin_wh": (800, 500),
            "muted": True,
            "exact": False,
            "alt_text": "Clean install and provider readiness without exposing credentials",
            "notes": (
                "Conceptual Codex-direction artwork mapped to install-auth. "
                "It is not an exact host screenshot of plugin install, setup:check, or provider login, "
                "and it exposes no credentials or private paths."
            ),
        },
        {
            "name": "multi-lane-run.held.jpg",
            "source_id": "multi-lane-static-malformed",
            "slot": "multi-lane-run",
            "publishable": False,
            "hold_reason": (
                "Malformed multi-lane static contains the unreadable phrase "
                "'Changes return ition'. Preserved byte-exact as a source and as a "
                "fit-padded shipping derivative, but not approved for public README use."
            ),
            "role_docs": "docs-multi-lane-static-held",
            "role_plugin": "plugin-multi-lane-static-held",
            "docs_wh": (1600, 1000),
            "plugin_wh": (800, 500),
            "muted": True,
            "exact": False,
            "alt_text": None,
            "notes": "Held malformed static. Do not publish.",
        },
        {
            "name": "multi-lane-frame-poster.held.jpg",
            "source_id": "multi-lane-motion",
            "slot": "multi-lane-run",
            "publishable": False,
            "hold_reason": (
                "Supplemental multi-lane motion uses hierarchical Main task / Sub-task framing "
                "rather than independent assignments, and does not depict provider, scope, state, "
                "or base SHA on a run card. Packaged after frame inspection; not publishable."
            ),
            "role_docs": "docs-multi-lane-motion-frame-poster-held",
            "role_plugin": "plugin-multi-lane-motion-frame-poster-held",
            "docs_wh": (1600, 1000),
            "plugin_wh": (800, 500),
            "muted": True,
            "exact": False,
            "alt_text": None,
            "notes": "Truthful completed-state frame at 8.00s from the held multi-lane motion.",
        },
        {
            "name": "multi-lane-muted.held.mp4",
            "source_id": "multi-lane-motion",
            "slot": "multi-lane-run",
            "publishable": False,
            "hold_reason": (
                "Supplemental multi-lane motion uses hierarchical Main task / Sub-task framing "
                "rather than independent assignments, and does not depict provider, scope, state, "
                "or base SHA on a run card. Frames do not contain 'Changes return ition', but the "
                "unsupported hierarchy is enough to keep publishable=false."
            ),
            "role_docs": "docs-multi-lane-muted-mp4-held",
            "role_plugin": "plugin-multi-lane-muted-mp4-held",
            "docs_wh": (1600, 1000),
            "plugin_wh": (800, 500),
            "muted": True,
            "exact": False,
            "alt_text": None,
            "notes": "Silent supplemental motion. Audio and cover art stripped. Not for README.",
        },
        {
            "name": "multi-lane-muted.held.webm",
            "source_id": "multi-lane-motion",
            "slot": "multi-lane-run",
            "publishable": False,
            "hold_reason": (
                "Supplemental multi-lane motion uses hierarchical Main task / Sub-task framing "
                "rather than independent assignments, and does not depict provider, scope, state, "
                "or base SHA on a run card. Frames do not contain 'Changes return ition', but the "
                "unsupported hierarchy is enough to keep publishable=false."
            ),
            "role_docs": "docs-multi-lane-muted-webm-held",
            "role_plugin": "plugin-multi-lane-muted-webm-held",
            "docs_wh": (1600, 1000),
            "plugin_wh": (800, 500),
            "muted": True,
            "exact": False,
            "alt_text": None,
            "notes": "Silent supplemental motion. Audio and cover art stripped. Not for README.",
        },
    ]

    codec_by_suffix = {".jpg": "mjpeg", ".png": "png", ".mp4": "h264", ".webm": "vp9"}
    for meta in derived_meta:
        for tree, role_key, wh in (
            (DOCS_DERIVED, "role_docs", meta["docs_wh"]),
            (PLUGIN_DERIVED, "role_plugin", meta["plugin_wh"]),
        ):
            path = tree / meta["name"]
            inventory.append(
                derived_record(
                    path,
                    source_id=meta["source_id"],
                    source_sha=hashes[meta["source_id"]],
                    slot=meta["slot"],
                    publishable=meta["publishable"],
                    hold_reason=meta["hold_reason"],
                    role=meta[role_key],
                    command=derived_commands[rel(path)],
                    codec=codec_by_suffix[path.suffix.lower()],
                    width=wh[0],
                    height=wh[1],
                    muted=meta["muted"],
                    exact_host_screenshot=meta["exact"],
                    alt_text=meta["alt_text"],
                    notes=meta["notes"],
                )
            )

    holds = [
        {
            "slot": "grouped-attention",
            "publishable": False,
            "optional": True,
            "rel01_required": False,
            "reason": (
                "Optional future exact-host enhancement, not a 3.4.0 REL-01 input. "
                "No host UI was fabricated."
            ),
        },
        {
            "slot": "verified-final-decision",
            "publishable": False,
            "optional": True,
            "rel01_required": False,
            "reason": (
                "Optional future exact-host enhancement, not a 3.4.0 REL-01 input. "
                "No host UI was fabricated."
            ),
        },
        {
            "slot": "multi-lane-run",
            "publishable": False,
            "optional": True,
            "rel01_required": False,
            "reason": (
                "Optional future exact-host enhancement, not a 3.4.0 REL-01 input. "
                "Existing motion is retained as non-publishable provenance and is not repaired."
            ),
        },
    ]

    manifest = {
        "schema": "codex-co-engineer.final-art-provenance.v1",
        "slice": "3.4.0-final-art-asset-packaging",
        "plugin_version": PLUGIN_VERSION,
        "package_version": PLUGIN_VERSION,
        "product_lead": PRODUCT_LEAD,
        "honest_claim": HONEST_CLAIM,
        "asset_dirs": [
            "docs/assets/co-engineer-3.4.0/final",
            "plugins/codex-co-engineer/assets/experience/final",
        ],
        "readme_replacement": True,
        "static_first": True,
        "note": (
            "Static-first 3.4.0 closure. Public README, plugin, and marketplace interfaces "
            "ship the clean static hero and approved Co-Engineer raster identity. Rejected "
            "hero motion and optional multi-lane/grouped-attention/verified-final slots stay "
            "unlinked. Plugin version stays 3.3.0. No missing host UI was fabricated."
        ),
        "tool_versions": {
            "ffmpeg": tool_version("ffmpeg"),
            "ffprobe": tool_version("ffprobe"),
            "libvpx_vp9": "v1.14.0",
        },
        "canonical_phrases": [
            "Delegating to Co-Engineer",
            "Chatting with Co-Engineer",
            "Using Grok Co-Engineer",
            "Using Cursor Co-Engineer",
            "Using Muse Co-Engineer",
        ],
        "size_ceilings": SIZE_CEILINGS,
        "slot_mapping": {
            "hero-demo": {
                "static": "architecture-static",
                "motion": "architecture-motion",
                "publishable": True,
                "motion_publishable": False,
                "note": "Static-first. Only hero-demo.jpg is public.",
            },
            "first-delegation": {"static": "first-delegation-static", "publishable": True},
            "provider-choices": {"static": "provider-choices-static", "publishable": True},
            "failure-unresolved": {
                "static": "conceptual-combined-outcome",
                "publishable": True,
                "note": "Conceptual combined outcome only; not verified-final-decision.",
            },
            "install-auth": {"static": "install-auth-static", "publishable": True},
            "identity-wordmark": {
                "static": "co-engineer-wordmark",
                "publishable": True,
                "role": "logo",
            },
            "identity-square-mark": {
                "static": "co-engineer-square-mark",
                "publishable": True,
                "role": "composerIcon",
            },
            "multi-lane-run": {
                "static": "multi-lane-static-malformed",
                "motion": "multi-lane-motion",
                "publishable": False,
                "optional": True,
                "rel01_required": False,
            },
            "grouped-attention": {
                "static": None,
                "publishable": False,
                "optional": True,
                "rel01_required": False,
            },
            "verified-final-decision": {
                "static": None,
                "publishable": False,
                "optional": True,
                "rel01_required": False,
            },
        },
        "shipping_interface": {
            "composerIcon": "plugins/codex-co-engineer/assets/experience/final/derived/square-mark.png",
            "logo": "plugins/codex-co-engineer/assets/experience/final/derived/wordmark.png",
            "marketplace_logo": "plugins/codex-co-engineer/assets/experience/final/derived/wordmark.png",
            "poster": "docs/assets/co-engineer-3.4.0/final/derived/hero-demo.jpg",
            "plugin_poster": "plugins/codex-co-engineer/assets/experience/final/derived/hero-demo.jpg",
            "heroMp4": None,
            "heroWebm": None,
            "static_first": True,
        },
        "holds": holds,
        "inventory": inventory,
    }

    encoded = json.dumps(manifest, indent=2) + "\n"
    (DOCS_FINAL / "manifest.json").write_text(encoded, encoding="utf-8")
    (PLUGIN_FINAL / "manifest.json").write_text(encoded, encoding="utf-8")
    if sha256_file(DOCS_FINAL / "manifest.json") != sha256_file(PLUGIN_FINAL / "manifest.json"):
        fail("manifest copies diverged")

    print(f"wrote {len(inventory)} inventory entries")
    print(f"docs manifest {sha256_file(DOCS_FINAL / 'manifest.json')}")


if __name__ == "__main__":
    sys.exit(main())
