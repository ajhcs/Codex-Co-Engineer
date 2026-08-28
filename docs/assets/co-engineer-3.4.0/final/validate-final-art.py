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

IDENTITY_SOURCES = {
    "docs/assets/co-engineer-3.4.0/final/sources/grok-image-d7f8b7c9-c929-4a3f-96d0-35f69ffb1403.png": {
        "sha256": "fcd7e67237e8bac3d2dd5c7c21b37e61df4acefac01cd2172c25c80372e03bca",
        "bytes": 1250372,
        "width": 1792,
        "height": 1008,
    },
    "docs/assets/co-engineer-3.4.0/final/sources/chatgpt-image-aug-27-2026-square-mark.png": {
        "sha256": "6282ebb40e87fe0ef71069e1e2cd7603d05f21dfe0ad2623605194702f5180fa",
        "bytes": 736141,
        "width": 1254,
        "height": 1254,
    },
}

FROZEN_ACCEPTED_STATICS = {
    "docs/assets/co-engineer-3.4.0/final/derived/hero-demo.jpg": "e266f0432fe70d2f48711a1c19628f7a9371fa23e46bf83824bc54844ded3edd",
    "docs/assets/co-engineer-3.4.0/final/derived/first-delegation.jpg": "d7e95ac17fb15e8e4a6001a2101a60c501c48d38dc4103c524b4da0c1b2ac17d",
    "docs/assets/co-engineer-3.4.0/final/derived/provider-choices.jpg": "039400f467beaecab450dccdffea67b42260a076c5aa325707b1aa4fd644c638",
    "docs/assets/co-engineer-3.4.0/final/derived/failure-unresolved.jpg": "874ab09c0e62f97c394e5edfc1d5f31e172447130fa0bb3a6854196f4ee7029d",
    "docs/assets/co-engineer-3.4.0/final/derived/install-auth.jpg": "66619555d45ad54112a3d4968f5e69e05c0718501675af0300b57600a21e3157",
    "plugins/codex-co-engineer/assets/experience/final/derived/hero-demo.jpg": "bfccc468b6531d3f5015fff7962e7405065d9d98c65a3437a71f4794945a8966",
    "plugins/codex-co-engineer/assets/experience/final/derived/first-delegation.jpg": "d66071aab429662e4d5aedf7f08caa90a3b88f348a1649f5fa6e02a21be1af99",
    "plugins/codex-co-engineer/assets/experience/final/derived/provider-choices.jpg": "a88047dbdf1acac5e45b17d4a2db91b8eaad42d7afcdba413e086f44ce51d994",
    "plugins/codex-co-engineer/assets/experience/final/derived/failure-unresolved.jpg": "050e92109a28d6977398737e87b1365558a9cbbbf9af02931ecdef9284d83461",
    "plugins/codex-co-engineer/assets/experience/final/derived/install-auth.jpg": "46858a4e2ec2cf153f6c30f4aec2824250cf60b3149c18068a5529487eb478e8",
}


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
    by_path = {entry["path"]: entry for entry in docs["inventory"]}
    for rel_path, expected in IDENTITY_SOURCES.items():
        entry = by_path.get(rel_path)
        if not entry:
            errors.append(f"missing-identity-source {rel_path}")
            continue
        for key, value in expected.items():
            if entry.get(key) != value:
                errors.append(f"identity-source {rel_path} {key}")
        plugin_path = rel_path.replace(
            "docs/assets/co-engineer-3.4.0/final/",
            "plugins/codex-co-engineer/assets/experience/final/",
        )
        plugin_entry = by_path.get(plugin_path)
        if not plugin_entry or plugin_entry.get("sha256") != expected["sha256"]:
            errors.append(f"identity-source-mirror {plugin_path}")
    for rel_path, digest in FROZEN_ACCEPTED_STATICS.items():
        entry = by_path.get(rel_path)
        if not entry or entry.get("sha256") != digest or entry.get("publishable") is not True:
            errors.append(f"frozen-static {rel_path}")
    shipping = docs.get("shipping_interface") or {}
    if shipping.get("composerIcon") != "plugins/codex-co-engineer/assets/experience/final/derived/square-mark.png":
        errors.append("shipping composerIcon")
    if shipping.get("logo") != "plugins/codex-co-engineer/assets/experience/final/derived/wordmark.png":
        errors.append("shipping logo")
    if shipping.get("heroMp4") is not None or shipping.get("heroWebm") is not None:
        errors.append("shipping hero motion still linked")
    if shipping.get("static_first") is not True:
        errors.append("static_first")
    for slot in ("grouped-attention", "verified-final-decision", "multi-lane-run"):
        mapping = (docs.get("slot_mapping") or {}).get(slot) or {}
        if mapping.get("rel01_required") is not False or mapping.get("optional") is not True:
            errors.append(f"optional-slot {slot}")
    if errors:
        print("FAILED")
        for item in errors:
            print(f" - {item}")
        return 1
    print("OK hashes, dimensions, budgets, audio absence, relative inventory, identity, frozen statics")
    return 0


if __name__ == "__main__":
    sys.exit(main())
