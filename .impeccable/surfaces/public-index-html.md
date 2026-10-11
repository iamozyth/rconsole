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

THESIS: The console as an identity program, Otl Aicher's Munich '72 discipline applied to server operations: every work area owns one colour from a strict program and one geometric pictogram, so place and state are known before a word is read. Refuses the category default of a grey-black dashboard with one neon accent and monospace everywhere.

OWN-WORLD: Light (Munich '72): white ground, silver-grey panels, program colours sky blue (Console), green (Players), deep blue (Backups), orange (Schedule), violet (Updates); red only for destructive. Dark (Lufthansa navy): navy ground, lighter navy panels, same program hues lifted. Archivo (Univers-like grotesk, self-hosted) for all UI, tabular numerals; system mono only for the log. Square-ish 2px corners, flat solid fills, hairline rules, no shadows except overlays. Pictograms: authored filled geometric SVG on a 24-unit grid, 45/90 degree angles, round heads.

STORY: The admin sees connection and server health in the top bar, knows which area they are in by colour and pictogram, acts with standard controls, and is never surprised by a disruptive action.

FIRST VIEWPORT: Desktop: left rail (rconsole wordmark, five area tiles pictogram + label, active tile filled in its area colour), top bar with connection state and a health strip of readouts, work area headed by the area name on a colour band. Console: log fills the work area, command bar docked at its bottom, right column with online players, quick actions, restart. Phone: top bar compact, bottom tab bar of five pictograms, the same work areas stacked.

FORM: Aicher '72 identity program (candidate 1 of 7, user-chosen over the assigned Braun front panel); seed key 6abadd5f. Signature move: per-area colour coding plus a pictogram system across nav, headings, actions and states.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

- Degraded roll: no challengers or quality-bar boards; code-led (no image generation).
