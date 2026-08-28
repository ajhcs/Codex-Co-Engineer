#!/usr/bin/env python3
"""Validate 3.4.0 final-art hashes, dimensions, budgets, silence, and path ceiling."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parents[4]
DOCS_MANIFEST = REPO / "docs" / "assets" / "co-engineer-3.4.0" / "final" / "manifest.json"
PLUGIN_MANIFEST = REPO / "plugins" / "codex-co-engineer" / "assets" / "experience" / "final" / "manifest.json"
OWNED = (
    "docs/assets/co-engineer-3.4.0/final/",
    "plugins/codex-co-engineer/assets/experience/final/",
    "docs/final-art-provenance-3.4.0.md",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe(path: Path) -> dict:
    raw = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-print_format", "json", str(path)],
        text=True,
    )
    return json.loads(raw)


def main() -> int:
    docs = json.loads(DOCS_MANIFEST.read_text(encoding="utf-8"))
    plugin = json.loads(PLUGIN_MANIFEST.read_text(encoding="utf-8"))
    errors: list[str] = []
    if docs != plugin:
        errors.append("manifest copies differ")
    if docs.get("plugin_version") != "3.3.0" or docs.get("package_version") != "3.3.0":
        errors.append("plugin/package version is not 3.3.0")
    seen: set[str] = set()
    for entry in docs["inventory"]:
        rel = entry["path"]
        seen.add(rel)
        path = REPO / rel
        if not path.is_file():
            errors.append(f"missing {rel}")
            continue
        if not rel.startswith(OWNED[:2]):
            errors.append(f"path ceiling {rel}")
        if path.stat().st_size != entry["bytes"]:
            errors.append(f"size {rel}")
        if sha256_file(path) != entry["sha256"]:
            errors.append(f"hash {rel}")
        ceiling = docs["size_ceilings"].get(rel)
        if isinstance(ceiling, int) and entry["bytes"] > ceiling:
            errors.append(f"ceiling {rel}")
        if entry.get("kind") == "derived" and rel.endswith((".mp4", ".webm")):
            probed = probe(path)
            streams = probed.get("streams", [])
            audio = [stream for stream in streams if stream.get("codec_type") == "audio"]
            if audio:
                errors.append(f"audio {rel}")
            if int(probed["format"]["nb_streams"]) != 1:
                errors.append(f"nb_streams {rel}")
            video = next(stream for stream in streams if stream.get("codec_type") == "video")
            if video.get("width") != entry["width"] or video.get("height") != entry["height"]:
                errors.append(f"video dim {rel}")
            if video.get("avg_frame_rate") != "24/1":
                errors.append(f"fps {rel}")
            if entry.get("muted") is not True or entry.get("audio") is not False:
                errors.append(f"mute flags {rel}")
        if rel.endswith((".jpg", ".jpeg", ".png")):
            with Image.open(path) as image:
                if image.size != (entry["width"], entry["height"]):
                    errors.append(f"image dim {rel} {image.size}")
    media: list[str] = []
    for root in (
        REPO / "docs" / "assets" / "co-engineer-3.4.0" / "final",
        REPO / "plugins" / "codex-co-engineer" / "assets" / "experience" / "final",
    ):
        for path in root.rglob("*"):
            if path.is_file() and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".mp4", ".webm"}:
                media.append(path.relative_to(REPO).as_posix())
    extra = sorted(set(media) - seen)
    missing = sorted(seen - set(media))
    print(f"inventory={len(docs['inventory'])} media={len(media)}")
    print(f"publishable_derived={sum(1 for e in docs['inventory'] if e.get('kind')=='derived' and e.get('publishable'))}")
    print(f"held_derived={sum(1 for e in docs['inventory'] if e.get('kind')=='derived' and not e.get('publishable'))}")
    print(f"holds={[h['slot'] for h in docs['holds']]}")
    if extra:
        errors.extend(f"extra {item}" for item in extra)
    if missing:
        errors.extend(f"missing-media {item}" for item in missing)
    if errors:
        print("FAILED")
        for item in errors:
            print(f" - {item}")
        return 1
    print("OK hashes, dimensions, budgets, audio absence, relative inventory")
    return 0


if __name__ == "__main__":
    sys.exit(main())
