# Brand asset provenance

Give Codex a team of external co-engineers without giving up control.

This is the UX-05 record for bounded Co-Engineer visual assets. It freezes
source identity, derivation commands, hashes, and the GitHub/README-compatible
relative-path contract. README may embed these accepted derivatives; this
inventory does not change runtime, skills, package version, changelog, or
release surfaces. Plugin and marketplace version stay
`3.3.0` until REL-01.

The honest product claim is:

up to eight isolated external co-engineers, one bounded run, one coordinated wait, one verified decision.

Do not claim credit reduction, 8x speed, universal UI, or SOTA routing.
Four raster-logo originals were not supplied. This tree does not add, alter,
or hash-claim those absent bytes. The interlocking-link SVG is a bounded
vector derivation of the visible mark. It is not pixel-faithful to missing
rasters.

```json
{
  "schema": "codex-co-engineer.brand-asset-provenance.v1",
  "slice": "UX-05",
  "plugin_version": "3.3.0",
  "asset_dir": "docs/assets/co-engineer-3.4.0",
  "product_lead": "Give Codex a team of external co-engineers without giving up control.",
  "honest_claim": "up to eight isolated external co-engineers, one bounded run, one coordinated wait, one verified decision",
  "canonical_phrases": [
    "Delegating to Co-Engineer",
    "Chatting with Co-Engineer",
    "Using Grok Co-Engineer",
    "Using Cursor Co-Engineer",
    "Using Muse Co-Engineer"
  ],
  "absent_raster_logos": {
    "count": 4,
    "bytes": null,
    "statement": "Four raster-logo originals were not supplied. This tree does not add, alter, or hash-claim those absent bytes."
  },
  "historical_unaltered": {
    "path": "plugins/codex-co-engineer/assets/co-engineer.png",
    "sha256": "e0533f0e428e6621680c1fdd639b4787f79339ffacc73d095ca89961d37c2fa5",
    "note": "Existing plugin PNG is left untouched. It is not one of the absent four raster logos and is not claimed as a 3.4.0 official raster."
  },
  "tool_versions": {
    "ffmpeg": "ffmpeg version 6.1.1-3ubuntu5",
    "ffprobe": "ffprobe version 6.1.1-3ubuntu5",
    "libvpx_vp9": "v1.14.0",
    "pillow": "12.1.1",
    "poster_font": "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf and DejaVuSans.ttf"
  },
  "sources": [
    {
      "id": "A",
      "attachment_id": "465bfaf5-536b-4748-96de-6ca2ec2e8af4",
      "original_filename": "grok-video-12e75a57-7a2e-4ef4-8fef-3144538d9c2e (1).mp4",
      "redacted_origin": "~/.codex/attachments/465bfaf5-536b-4748-96de-6ca2ec2e8af4/grok-video-12e75a57-7a2e-4ef4-8fef-3144538d9c2e (1).mp4",
      "repo_path": "docs/assets/co-engineer-3.4.0/sources/source-a.mp4",
      "sha256": "43952f17186800caa0fb024f5f9169509dac4921749a03af0b8c832d7bd31787",
      "bytes": 2561860,
      "duration_s": "6.041667",
      "width": 1920,
      "height": 1088,
      "fps": "24/1",
      "video_codec": "h264",
      "audio_codec": "aac",
      "cover_codec": "mjpeg",
      "nb_streams": 3
    },
    {
      "id": "B",
      "attachment_id": "465bfaf5-536b-4748-96de-6ca2ec2e8af4",
      "original_filename": "grok-video-12e75a57-7a2e-4ef4-8fef-3144538d9c2e.mp4",
      "redacted_origin": "~/.codex/attachments/465bfaf5-536b-4748-96de-6ca2ec2e8af4/grok-video-12e75a57-7a2e-4ef4-8fef-3144538d9c2e.mp4",
      "repo_path": "docs/assets/co-engineer-3.4.0/sources/source-b.mp4",
      "sha256": "7d2bca8d1481d5142a92ed10024710080fb887b5f539bb2de9ef943875c29bf7",
      "bytes": 1581977,
      "duration_s": "6.041667",
      "width": 1920,
      "height": 1088,
      "fps": "24/1",
      "video_codec": "h264",
      "audio_codec": "aac",
      "cover_codec": "mjpeg",
      "nb_streams": 3
    }
  ],
  "source_note": "A and B are distinct originals. Bounded muted web/plugin derivatives use source A, the clearer interlocking-link lockup. Source B is preserved byte-for-byte and is not a substitute original.",
  "commands": [
    "cp -- original-A docs/assets/co-engineer-3.4.0/sources/source-a.mp4",
    "cp -- original-B docs/assets/co-engineer-3.4.0/sources/source-b.mp4",
    "ffmpeg -y -i docs/assets/co-engineer-3.4.0/sources/source-a.mp4 -map 0:v:0 -an -c:v libx264 -pix_fmt yuv420p -profile:v high -level 4.1 -vf 'scale=1920:1088:flags=lanczos' -r 24 -crf 28 -preset slow -movflags +faststart -map_metadata -1 docs/assets/co-engineer-3.4.0/hero-muted.mp4",
    "ffmpeg -y -i docs/assets/co-engineer-3.4.0/sources/source-a.mp4 -map 0:v:0 -an -c:v libvpx-vp9 -pix_fmt yuv420p -b:v 0 -crf 42 -row-mt 1 -deadline good -vf 'scale=1920:1088:flags=lanczos' -r 24 -map_metadata -1 docs/assets/co-engineer-3.4.0/hero-muted.webm",
    "ffmpeg -y -i docs/assets/co-engineer-3.4.0/sources/source-a.mp4 -map 0:v:0 -an -c:v libx264 -pix_fmt yuv420p -profile:v high -level 4.0 -vf 'scale=960:544:flags=lanczos' -r 24 -crf 32 -preset slow -movflags +faststart -map_metadata -1 plugins/codex-co-engineer/assets/experience/hero-muted.mp4",
    "ffmpeg -y -i docs/assets/co-engineer-3.4.0/sources/source-a.mp4 -map 0:v:0 -an -c:v libvpx-vp9 -pix_fmt yuv420p -b:v 0 -crf 38 -row-mt 1 -deadline good -vf 'scale=960:544:flags=lanczos' -r 24 -map_metadata -1 plugins/codex-co-engineer/assets/experience/hero-muted.webm",
    "ffmpeg -y -ss 0.20 -i docs/assets/co-engineer-3.4.0/sources/source-a.mp4 -map 0:v:0 -frames:v 1 -q:v 5 docs/assets/co-engineer-3.4.0/frame-poster.jpg",
    "ffmpeg -y -ss 0.20 -i docs/assets/co-engineer-3.4.0/sources/source-a.mp4 -map 0:v:0 -frames:v 1 -q:v 6 -vf 'scale=960:544:flags=lanczos' plugins/codex-co-engineer/assets/experience/frame-poster.jpg",
    "Playwright Chromium renders docs/assets/co-engineer-3.4.0/poster.svg at an exact 1920x1088 viewport to a temporary PNG",
    "ffmpeg -y -i <rendered-poster.png> -frames:v 1 -q:v 5 docs/assets/co-engineer-3.4.0/poster.jpg",
    "ffmpeg -y -i <rendered-poster.png> -vf 'scale=960:544:flags=lanczos' -frames:v 1 -q:v 3 plugins/codex-co-engineer/assets/experience/poster.jpg"
  ],
  "github_readme_contract": [
    "docs/assets/co-engineer-3.4.0/poster.jpg",
    "docs/assets/co-engineer-3.4.0/poster.svg",
    "docs/assets/co-engineer-3.4.0/hero-muted.mp4",
    "docs/assets/co-engineer-3.4.0/hero-muted.webm",
    "docs/assets/co-engineer-3.4.0/mark.svg",
    "docs/assets/co-engineer-3.4.0/frame-poster.jpg"
  ],
  "size_ceilings": {
    "docs/assets/co-engineer-3.4.0/hero-muted.mp4": 800000,
    "docs/assets/co-engineer-3.4.0/hero-muted.webm": 800000,
    "docs/assets/co-engineer-3.4.0/poster.jpg": 200000,
    "docs/assets/co-engineer-3.4.0/frame-poster.jpg": 80000,
    "docs/assets/co-engineer-3.4.0/mark.svg": 8192,
    "docs/assets/co-engineer-3.4.0/poster.svg": 8192,
    "plugins/codex-co-engineer/assets/experience/hero-muted.mp4": 200000,
    "plugins/codex-co-engineer/assets/experience/hero-muted.webm": 400000,
    "plugins/codex-co-engineer/assets/experience/poster.jpg": 80000,
    "plugins/codex-co-engineer/assets/experience/frame-poster.jpg": 40000,
    "plugins/codex-co-engineer/assets/experience/mark.svg": 8192,
    "plugins/codex-co-engineer/assets/experience/poster.svg": 8192,
    "plugin_experience_total": 750000
  },
  "inventory": [
    {
      "path": "docs/assets/co-engineer-3.4.0/sources/source-a.mp4",
      "role": "source-a-original",
      "sha256": "43952f17186800caa0fb024f5f9169509dac4921749a03af0b8c832d7bd31787",
      "bytes": 2561860,
      "width": 1920,
      "height": 1088,
      "codec": "h264+aac+mjpeg",
      "audio": true,
      "muted": false
    },
    {
      "path": "docs/assets/co-engineer-3.4.0/sources/source-b.mp4",
      "role": "source-b-original",
      "sha256": "7d2bca8d1481d5142a92ed10024710080fb887b5f539bb2de9ef943875c29bf7",
      "bytes": 1581977,
      "width": 1920,
      "height": 1088,
      "codec": "h264+aac+mjpeg",
      "audio": true,
      "muted": false
    },
    {
      "path": "docs/assets/co-engineer-3.4.0/hero-muted.mp4",
      "role": "docs-hero-muted-mp4",
      "sha256": "2a80676d256186753fd7d24bd2578d737491edabc006346d27a24cebcb4bf328",
      "bytes": 683074,
      "width": 1920,
      "height": 1088,
      "codec": "h264",
      "audio": false,
      "muted": true,
      "derived_from": "A"
    },
    {
      "path": "docs/assets/co-engineer-3.4.0/hero-muted.webm",
      "role": "docs-hero-muted-webm",
      "sha256": "3c1e8c1081bb34e58cc7fdfe059c4409a8b4ecacb5c4ff98a264550a1e7f5673",
      "bytes": 717227,
      "width": 1920,
      "height": 1088,
      "codec": "vp9",
      "audio": false,
      "muted": true,
      "derived_from": "A"
    },
    {
      "path": "docs/assets/co-engineer-3.4.0/frame-poster.jpg",
      "role": "docs-content-poster",
      "sha256": "e0448826a0f132db2a143b046b4b54e7d6301ad408de61581479c68e413e5f68",
      "bytes": 41762,
      "width": 1920,
      "height": 1088,
      "codec": "jpeg",
      "audio": false,
      "muted": true,
      "derived_from": "A"
    },
    {
      "path": "docs/assets/co-engineer-3.4.0/poster.jpg",
      "role": "docs-readable-poster",
      "sha256": "abc2bb22bf120486ce94c8c8894cd8b913d29f7f1b122ddd5a9448a17094c8f5",
      "bytes": 158143,
      "width": 1920,
      "height": 1088,
      "codec": "jpeg",
      "audio": false,
      "muted": true
    },
    {
      "path": "docs/assets/co-engineer-3.4.0/poster.svg",
      "role": "docs-readable-poster-vector",
      "sha256": "c61b77eae87c93b6a7c5a05219eebdd427c50d65f0bd4d50dd9695213c456250",
      "bytes": 3613,
      "width": 1920,
      "height": 1088,
      "codec": "svg"
    },
    {
      "path": "docs/assets/co-engineer-3.4.0/mark.svg",
      "role": "interlocking-link-mark",
      "sha256": "798ca6e8ed6daa0a38f5da435016f0d6d61b75b94f0c4e1750c758ad91e546bb",
      "bytes": 1158,
      "codec": "svg"
    },
    {
      "path": "plugins/codex-co-engineer/assets/experience/hero-muted.mp4",
      "role": "plugin-hero-muted-mp4",
      "sha256": "3b3fb1f8f9b043fbbdc10afab4d59f613182113ac09bf22242271d64118b6e04",
      "bytes": 124003,
      "width": 960,
      "height": 544,
      "codec": "h264",
      "audio": false,
      "muted": true,
      "derived_from": "A"
    },
    {
      "path": "plugins/codex-co-engineer/assets/experience/hero-muted.webm",
      "role": "plugin-hero-muted-webm",
      "sha256": "07eb980e6c985dc7e135a9638ed2c1f0b3a2424ea920eab189e6c4af602a64f3",
      "bytes": 298178,
      "width": 960,
      "height": 544,
      "codec": "vp9",
      "audio": false,
      "muted": true,
      "derived_from": "A"
    },
    {
      "path": "plugins/codex-co-engineer/assets/experience/frame-poster.jpg",
      "role": "plugin-content-poster",
      "sha256": "9166fb78043c5dcad1fc7e467ef44129cb95befa763fbd0c0f4396fa0f703865",
      "bytes": 17056,
      "width": 960,
      "height": 544,
      "codec": "jpeg",
      "audio": false,
      "muted": true,
      "derived_from": "A"
    },
    {
      "path": "plugins/codex-co-engineer/assets/experience/poster.jpg",
      "role": "plugin-readable-poster",
      "sha256": "081c7f88bd03c32596a5a99b1d8b89b150f48d1ab8d67861484f93f30e1715ad",
      "bytes": 65939,
      "width": 960,
      "height": 544,
      "codec": "jpeg",
      "audio": false,
      "muted": true
    },
    {
      "path": "plugins/codex-co-engineer/assets/experience/poster.svg",
      "role": "plugin-readable-poster-vector",
      "sha256": "c61b77eae87c93b6a7c5a05219eebdd427c50d65f0bd4d50dd9695213c456250",
      "bytes": 3613,
      "codec": "svg"
    },
    {
      "path": "plugins/codex-co-engineer/assets/experience/mark.svg",
      "role": "plugin-interlocking-link-mark",
      "sha256": "798ca6e8ed6daa0a38f5da435016f0d6d61b75b94f0c4e1750c758ad91e546bb",
      "bytes": 1158,
      "codec": "svg"
    }
  ]
}
```

## GitHub and README relative contract

The README cites these exact relative paths and keeps the readable poster as
the GitHub, reduced-motion, and embedded-playback fallback:

```markdown
![Give Codex a team of external co-engineers without giving up control.](docs/assets/co-engineer-3.4.0/poster.jpg)

<video src="docs/assets/co-engineer-3.4.0/hero-muted.mp4" muted playsinline controls poster="docs/assets/co-engineer-3.4.0/poster.jpg"></video>
```

Plugin-local copies live under `plugins/codex-co-engineer/assets/experience/`
so the packaged plugin does not depend on repository-root docs. Original
source bytes stay in `docs/assets/co-engineer-3.4.0/sources/` and are not
packed as plugin experience media. Derivatives are muted: no AAC, no MJPEG
cover, no autoplay audio.
