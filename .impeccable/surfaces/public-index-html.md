---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: ["public/login.html","public/style.css","public/app.js"]
---

# rconsole console (all tabs + login)

Scope: the authenticated console (`public/index.html`, `app.js`, `style.css`) and the login page. Visitor mode: Operate. One expert admin, desktop and phone.

Task: run commands and read the live log; manage whitelist/ops/bans; take, download and prune backups; schedule restarts/backups/commands; update Paper. Critical states: RCON disconnected, log unreadable, job running (backup/update), restart countdown, job failure, empty lists.

## Direction contract

THESIS: A quiet operations console in the Vercel register, aligned with the owner's site winterstetter.io: neutral surfaces, hairline borders and precise type carry the structure, so the few colours left (one violet accent, ok/warn/danger) always mean something. Chosen by the owner on 2026-10-12 to replace the Aicher '72 identity program ("cleaner, more enterprise").

OWN-WORLD: Dark: near-black ground #0a0a0a, panels #111, hairlines #262626, ink #ededed. Light: #fafafa ground, white panels, hairlines #e5e5e5, ink #171717. Accent violet (#a78bfa dark / #7c3aed light) for focus, links, switches, charts and unsaved state only; primary buttons are inverted neutral. Inter for UI, JetBrains Mono for log/prompt/code (both self-hosted, OFL). Radii 6px controls, 10px panels, 12px overlays; segmented controls as a sunken track with a raised selection; sentence-case labels; shadows only on overlays. Pictograms kept, rendered monochrome.

STORY: The admin sees connection and server health in the top bar, knows which area they are in by colour and pictogram, acts with standard controls, and is never surprised by a disruptive action.

FIRST VIEWPORT: Desktop: left rail (wordmark, area list with monochrome pictograms, selected item on a subtle raised fill), top bar with area name, connection chip and the health readouts, hairline under it. Console: log fills the work area, command bar docked at its bottom, right column with online players, quick actions, restart. Phone: compact top bar with the readout grid, bottom tab bar, the same work areas stacked.

FORM: Vercel/Geist-style neutral console (owner-directed restyle of the earlier Aicher '72 program). Signature: restraint; the accent and status colours are the only colour in the interface.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

- Degraded roll: no challengers or quality-bar boards; code-led (no image generation).
