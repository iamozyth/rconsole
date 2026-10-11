---
name: logo-design
description: Design or refresh logos, logomarks, wordmarks, monograms, favicons and app icons as production-ready SVG. Use when the user asks for a logo, icon, mark, wordmark, lettermark, favicon, BIMI logo or brand symbol, or wants an existing mark refreshed, critiqued or tested at small sizes.
---

# Logo Design

Structured exploration from brief to vector deliverable. Logos are written
directly as SVG (hand-authored geometry or generated from a font glyph by a
script), never as raster images from an image model, so every concept is
already production-ready and scalable.

## 1. Discovery

Before drawing anything, answer these five. Read the codebase first — most
answers are already there (CSS tokens, fonts, existing marks, README), so
only ask the user for what you cannot find.

1. Three adjectives for the brand personality.
2. Primary audience and what they value.
3. Marks in the space that work (for contrast, never copying).
4. Styles that feel wrong — as important as what feels right.
5. Aesthetics or industries that inspire.

Also collect the hard constraints: existing colors and fonts, where the mark
must live (favicon, app icon, BIMI, social card, print), and any design
rules the user has stated (e.g. restraint, no gradients).

## 2. Refresh or new?

**Refresh** — audit the existing mark first:
- Equity: what is recognizable and must survive (shape, color, concept)?
- Debt: what is dated, weak at small sizes, or inconsistent with the site?
- Deliver an *evolution* (keeps the equity, fixes the debt) **and** a
  *revolution* (a genuinely different idea) so the user can calibrate.

**New** — pick 3 contrasting directions from `references/styles.md` and 2
palettes from `references/palettes.md`, then make 5–10 concepts spread
across them. Breadth beats polishing one idea.

## 3. Build rules

- **Black first.** Every concept must work as a single flat color on white
  and on black before color is added.
- **Grid.** Use a `viewBox="0 0 100 100"` (or another round grid) with
  coordinates to at most 2 decimals. Keep optical margins consistent.
- **Paths, not text.** Never ship `<text>`; convert letterforms to paths
  (with CoreText/fontTools, or draw them) so no font is needed.
- **Few shapes.** A mark that needs more than ~4 shapes rarely survives 16px.
  Avoid hairlines under ~6% of the grid, gradients, shadows and filters.
- **Optical, not mathematical.** Round shapes overshoot flat ones by ~2–3%;
  centre by visual mass, not the bounding box.
- If the project already has a generator script for its icons, extend it
  rather than hand-editing its outputs, so they stay reproducible.

## 4. Scale test (required before presenting)

Render every concept on one comparison sheet using
`assets/scale-sheet.html` (copy to the scratchpad, fill the `CONCEPTS` list,
open it in the browser pane and screenshot). It shows each concept at:

| Size | Purpose |
|------|---------|
| 512px | full-color master |
| 128px | app icon |
| 32px / 16px | favicon — must still read |
| monochrome | black on white and white on black |
| circle crop | BIMI / avatar masks |
| 16px / 32px actual | rasterized at true size, enlarged without smoothing — the real favicon test |

A concept that fails at 16px or in monochrome needs a simplified small-size
variant or is dropped. Say which ones failed and why.

Serve the sheet over a local static server (a `preview_start` config in
`.claude/launch.json` pointing at the scratchpad); the browser pane renders
`file://` pages as static snapshots that can't be screenshotted or scripted.
Screenshots are downscaled, so judge small sizes from the "actual" rows, not
from the 16px/32px cells.

## 5. Critique

For each surviving concept, one line on each:
- **Distinct** — could it be confused with a well-known mark?
- **Legible** — does it read at 16px and in one color?
- **Fitting** — does it match the adjectives and the site's existing style?
- **Simple** — could anything be removed?

Recommend one, with the reason.

## 6. Deliverables

- SVG master (plus SVG Tiny PS for BIMI if mail is involved: no `x`/`y` on
  the root, `baseProfile="tiny-ps"`, a `<title>`, square, no scripts/filters)
- Favicon SVG + 512px PNG
- Monochrome SVG
- Small-size variant if the master needed simplifying
- Do not replace files in the project until the user has picked a concept.

## Troubleshooting

- **Fine at 512, mush at 16:** thicken strokes, drop inner details, widen
  counters, or make an icon-only small variant.
- **Letterforms look off:** use the brand's real font glyph as the base and
  adjust it, rather than drawing letters freehand.
- **Too generic:** push one element (a cut, a counter, an extension) that
  carries the brand idea; generic marks usually lack a single idea.
