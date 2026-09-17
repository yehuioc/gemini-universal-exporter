# Gemini Universal Exporter

A Tampermonkey userscript for exporting Gemini conversation history to ZIP with JSON and Markdown,
including best-effort recovery of Gemini Canvas document/code artifacts.

Current repository version: **v0.4.3**

## Features

- Conversation-list-first workflow: fetch metadata first, then export one conversation or the full history.
- Gemini internal `MaZiqc` / `hNvQHb` history retrieval with conservative pacing, retries and failure manifests.
- `/app/<conversationId>` and `/gem/<gemId>/<conversationId>` route-aware resume.
- Lazy-history DOM preload before Canvas recovery.
- Canvas document/code extraction from ProseMirror / Monaco surfaces.
- JSON + Markdown + ZIP output and diagnostics for incomplete Canvas recovery.

## Install

Install a userscript manager such as Tampermonkey, then import:

`Gemini_Universal_Exporter.user.js`

Gemini's internal RPC and DOM are undocumented, so future Gemini changes may require maintenance.

## Validation

The current v0.4.3 build includes QA notes under `docs/`. The exporter was developed conservatively:
already-proven RPC/route/extraction paths are kept stable while live-DOM-specific fixes are isolated.

## Support

If this tool saves you time and you would like to support ongoing maintenance, you can buy me a coffee ☕.

**Sponsor link: coming soon.**

See [SPONSORING.md](SPONSORING.md).

## License & attribution

The userscript header declares MIT and contains design-source/inspiration notes. Keep those notices
and third-party attributions intact when redistributing modifications. See [NOTICE.md](NOTICE.md).
