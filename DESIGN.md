---
name: rconsole
description: A quiet, neutral operations console for a single Minecraft server; one violet accent, status colour only where it carries meaning.
colors:
  accent-violet: "#7c3aed"
  ok-green: "#15803d"
  warn-amber: "#b45309"
  danger-red: "#dc2626"
  page: "#fafafa"
  surface: "#ffffff"
  sunken: "#f4f4f5"
  line: "#e5e5e5"
  line-strong: "#d4d4d4"
  text: "#171717"
  text-2: "#525252"
  text-3: "#6b6b6b"
  accent-violet-dark: "#a78bfa"
  ok-green-dark: "#22c55e"
  warn-amber-dark: "#f5a524"
  danger-red-dark: "#f87171"
  page-dark: "#0a0a0a"
  surface-dark: "#111111"
  surface-raised-dark: "#171717"
  sunken-dark: "#1a1a1a"
  hover-dark: "#1c1c1c"
  line-dark: "#262626"
  line-strong-dark: "#383838"
  text-dark: "#ededed"
  text-2-dark: "#a3a3a3"
  text-3-dark: "#8f8f8f"
typography:
  page-title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.02em"
  metric:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    letterSpacing: "-0.03em"
    fontFeature: "'tnum'"
  title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.006em"
    fontFeature: "'cv11', 'ss01'"
  control:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 500
    letterSpacing: "-0.006em"
  readout:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    letterSpacing: "-0.01em"
    fontFeature: "'tnum'"
  label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
  log:
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.65
  prompt:
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "14px"
    fontWeight: 400
rounded:
  r: "6px"
  track: "9px"
  r-lg: "10px"
  overlay: "12px"
  sheet: "14px"
  full: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
  gutter: "28px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
    padding: "0 14px"
    height: "34px"
  button-hover:
    backgroundColor: "{colors.sunken}"
  button-primary:
    backgroundColor: "{colors.text}"
    textColor: "{colors.page}"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
    padding: "0 14px"
    height: "34px"
  button-danger:
    backgroundColor: "{colors.danger-red}"
    textColor: "#ffffff"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
    padding: "0 14px"
    height: "34px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
    padding: "0 14px"
    height: "34px"
  button-sm:
    padding: "0 10px"
    height: "30px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.r}"
    padding: "0 11px"
    height: "34px"
  segmented-track:
    backgroundColor: "{colors.sunken}"
    rounded: "{rounded.track}"
    padding: "3px"
  segmented-option:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.r}"
    padding: "0 12px"
    height: "28px"
  segmented-option-selected:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.r}"
    padding: "0 8px"
    height: "34px"
  nav-item-selected:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.text}"
  pill:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.text-2}"
    rounded: "{rounded.full}"
    padding: "0 8px"
    height: "20px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.r-lg}"
    padding: "20px"
  dialog:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.overlay}"
    width: "460px"
---

# Design System: rconsole

## Overview

**Creative North Star: "The Quiet Control Room"**

rconsole is the room an operator walks into to check on one server and leave again. Everything resident on screen is neutral: near-white or near-black surfaces, hairline borders, grey text in three steps. Colour is spent only where it says something, either the single violet accent (focus, links, switches, charts, unsaved state) or a status hue (ok, warning, danger). The result reads like a Vercel-class enterprise console and sits beside winterstetter.io as the same family: Inter, JetBrains Mono, the same violet, the same hairline neutrals.

Density is moderate: 34px controls, 14px body, 20px panel padding, 28px page gutters. Hierarchy comes from weight (500/600) and the three text greys, not from size jumps or colour fields. Light and dark follow `prefers-color-scheme`; dark is not an inversion but its own neutral ramp with the accent and status hues lifted for contrast.

The previous "identity program" world (per-area colours, coloured title fields, 4px bands, 2px corners, uppercase condensed labels) is retired. Its variable names survive only as aliases (see Colors).

**Key Characteristics:**
- Neutral surfaces with 1px hairlines; no colour fields.
- One violet accent, used sparingly; primary actions are the inverted neutral.
- Status colour keeps meaning: green ok, amber warning, red danger.
- Inter for UI, JetBrains Mono for machine text; sentence-case labels; tabular numerals.
- Radii 6 / 10 / 12px; sunken-track segmented controls.
- Flat at rest; shadows only on things that float.

## Colors

A neutral grey ramp carries the whole interface; violet and three status hues are the only chroma.

### Primary
- **Signal Violet** (accent-violet, dark: accent-violet-dark): focus rings (`--ring`, 3px at 22%) and focus outlines, links, caret and native `accent-color`, checked switches, chart lines/bars/dots, the dirty-setting edge and pending-restart bar, the running op-bar progress, command echoes in the log, the active parameter in the command hint, `.own` pills, the update dot on the Server tab, selected radio rows, search-hit `mark`, and the wordmark tile.

### Status
- **Ok Green** (ok-green / ok-green-dark): connected dot, active power light, player joins in the log, inserted values in diffs, ok pills and toasts.
- **Warn Amber** (warn-amber / warn-amber-dark): maintenance badge, warning log lines, "needs attention" readout icons, warn advice icons.
- **Danger Red** (danger-red / danger-red-dark): failure states, error text, disconnected chip, alert dot on Players, failed audit rows.
- **Danger Solid** (`--danger-solid`, #dc2626 in both themes): the fill of destructive buttons, so their white label keeps 4.8:1 contrast in dark mode too.

### Neutral
- **Page** (page / page-dark): app background, rail, topbar.
- **Surface** (surface / surface-dark): panels, buttons, fields in light. Dark fields sit on page-dark; dark overlays use surface-raised-dark.
- **Sunken** (sunken / sunken-dark): segmented tracks, selected nav item, pills, counts, jobs, log replies, palette and hint footers, skeletons. Light hover equals sunken; dark hover is hover-dark.
- **Line / Line Strong**: every divider and container border is line; control borders (buttons, fields, day chips) and the scrollbar thumb are line-strong.
- **Text / Text 2 / Text 3**: primary copy; secondary copy and idle controls; labels, placeholders, meta and axis text.

### Aliases
`--area`, `--c-console`, `--c-worlds`, `--c-server`, `--c-insights` and `--c-map` all resolve to the accent; `--c-players` resolves to ok and `--c-schedule` to warn. They exist for compatibility with older markup and scripts; new code uses `--accent`, `--ok`, `--warn`, `--c-danger` directly.

### Named Rules
**The One Violet Rule.** Violet marks focus, links, live data and unsaved or pending state. It never fills a button or a panel; if a screen shows more than a few violet marks at rest, one is wrong.

**The Inverted Primary Rule.** The primary action is the text colour as fill with the page colour as text (near-black on light, near-white on dark). Emphasis comes from contrast, not hue.

**The Status Keeps Meaning Rule.** Green, amber and red appear only for ok, warning and danger. Red is never decorative; tinted status surfaces mix 5-14% of the hue into the surface with a 30-45% hue border.

**The Quiet Health Rule.** Health readouts are neutral text when nominal; "needs attention" adds an amber pictogram, "critical" turns the value red.

## Typography

**Body Font:** Inter (with -apple-system, Segoe UI, system-ui), self-hosted variable 100-900 from `/fonts/inter.woff2`, features `cv11` and `ss01`, tracking -0.006em.
**Mono Font:** JetBrains Mono (with ui-monospace, SF Mono, Menlo), self-hosted from `/fonts/jetbrains-mono.woff2`.

**Character:** A neutral, slightly tightened grotesque for every word the operator reads, and a crisp mono for every string the server reads: log lines, the prompt, setting keys, versions, command suggestions.

### Hierarchy
- **Page title** (600, 18px, line-height 1, -0.02em): area name in the topbar; 17px on phones. Login and `h1` at 20px.
- **Metric** (600, 26px, -0.03em, tabular): KPI tiles (21px on phones); installed version uses 24px.
- **Title** (600, 14px, -0.01em): panel heads; dialog titles at 16px.
- **Body** (400, 14px/1.5): default copy. Notes and meta are 12.5-13px in text-3.
- **Control** (500, 13.5px): buttons, nav items at 14px, segmented options at 13px.
- **Readout** (600, 14px, tabular): health strip values; chart stats at 15px.
- **Label** (500, 12px, text-3, sentence case): readout terms, table headers, palette groups, form legends (13px text-2 for field labels).
- **Log** (mono 400, 12.5px/1.65): console log, log search results, diff values.
- **Prompt** (mono 400, 14px): command input; 16px on phones to prevent zoom.

### Named Rules
**The Sentence Case Rule.** Labels are 12px, weight 500, text-3, sentence case, no letter-spacing. The stylesheet carries no `text-transform`.

**The Tabular Rule.** Every number that can change (readouts, counts, tables, charts, versions, countdown) uses tabular numerals.

**The Machine Text Rule.** Anything typed to or emitted by the server is JetBrains Mono; anything written for a person is Inter.

## Layout

A two-column app shell: a 232px rail (`--rail-w`) beside a scrolling column of topbar plus main. The topbar is 64px minimum with 28px side padding and holds area title, connection chip, maintenance badge and the health strip (pushed right). Main has 28px padding (48px bottom); areas are a vertical stack with 20px gaps, capped at 1400px and centred. The Console area is a grid of log (fluid) plus a 300px side column (260px under 1180px).

Panels: 56px min head with 12px 20px padding and a hairline under it; 20px body. Paired panels sit in a two-up grid with 20px gaps and share row height. Forms are 4-column grids with 16px gaps and a form-actions footer that bleeds to the panel edge. Spacing rhythm is 4 / 8 / 12 / 16 / 20 / 24 / 28px.

Breakpoints:
- **1180px**: health strip wraps under the title in a scrollable row; gutters 20px; forms two-up.
- **900px**: paired panels stack; console log becomes 62dvh; KPIs two-up.
- **760px**: rail becomes a fixed bottom tab bar (first four areas plus More sheet); health becomes a 4-column grid; tables restack as label/value rows; inputs go to 16px; toasts span the width above the tab bar.
- **hover: none**: hover tints are dropped so taps don't leave stuck states.

## Elevation & Depth

Flat at rest. Depth is tonal: page, surface and sunken steps plus hairlines. Light surfaces get a 1px hairline-level shadow (`--shadow-sm`) on panels, KPI rows, advice items and default buttons; in dark `--shadow-sm` is `none`. A real shadow means the element floats above the page and will go away.

### Shadow Vocabulary
- **Hairline** (`0 1px 2px rgba(0, 0, 0, 0.04)`, light only): resident panels and default buttons.
- **Overlay, light** (`0 12px 32px rgba(0, 0, 0, 0.1), 0 2px 6px rgba(0, 0, 0, 0.05)`): dialogs, command palette, suggestions, chart tooltip, toasts, sticky save bar, the map's open button, the login card.
- **Overlay, dark** (`0 16px 40px rgba(0, 0, 0, 0.55), 0 0 0 1px var(--line)`): same roles; the 1px ring keeps edges visible on black.
- **Raised option** (`0 0 0 1px var(--line), 0 1px 2px rgba(0, 0, 0, 0.06)`): the selected segment in light; dark uses a lighter fill and no shadow.
- **Backdrop**: `rgba(10, 10, 10, 0.35)` light, `rgba(0, 0, 0, 0.6)` dark.

### Named Rules
**The Only Overlays Float Rule.** Shadows belong to dialogs, the palette, popovers, tooltips, toasts and the sticky save bar. Anything resident in the layout is flat, with at most the light hairline.

## Shapes

Gently rounded and consistent. Controls, nav items, inner rows, jobs and log replies use 6px; panels, cards, KPI rows, toasts, popovers, banners and selectable radio rows use 10px; dialogs, the command palette and the login card use 12px; the phone More sheet is 14px on its top corners. Segmented tracks are 9px (control radius plus their 3px padding) so the inner option nests concentrically. Pills, counts, the connection chip, switches and status dots are fully round. Small fixed tiles keep their own corners: kbd 4px, avatars 5px, plugin tiles 7px. Every border is 1px.

### Named Rules
**The Three Radii Rule.** 6px for things you operate, 10px for things that contain, 12px for things that float above. Round shapes only for pills, dots and switches.

## Components

Refined and restrained: neutral by default, colour only on state.

### Buttons
- **Shape:** 6px corners, 34px tall (30px small, 40px on login), 14px side padding, 15px pictogram with a 7px gap.
- **Default:** surface fill, line-strong border, text colour, light hairline shadow; hover sunken/hover, active sunken.
- **Primary:** inverted neutral (text fill, page-colour text); hover mixes 14% of the page colour in.
- **Danger:** solid danger red with white text; reserved for confirming destructive actions.
- **Quiet:** borderless, transparent, text-2; hover tints to hover and lifts text to full contrast; `.danger` quiet buttons tint red on hover.
- **Focus / Disabled:** 2px accent outline at 2px offset; disabled and busy at 50% opacity.
- **Motion:** colour transitions at 120ms ease-out.

### Pills and Counts
- **Style:** 20px fully round, sunken fill, line border, 11.5px weight 500 text-2.
- **State:** `.own` in accent tint, `.ok` green tint, `.bad` red tint (10-12% fill, 30% border). Counts are the same shape with tabular numerals and hide when empty.

### Cards / Containers
- **Corner Style:** 10px (12px for login card).
- **Background:** surface; form footers and table heads use a light sunken mix.
- **Shadow Strategy:** hairline in light, none in dark (see Elevation).
- **Border:** 1px line; head and rows divided by line hairlines.
- **Internal Padding:** 20px; heads 12px 20px at 56px minimum.

### Inputs / Fields
- **Style:** 34px, 6px corners, line-strong border, field background, 11px side padding, 14px Inter (13px mono variant).
- **Focus:** border turns accent with a 3px accent ring at 22%.
- **Error / Disabled:** `aria-invalid` turns the border danger red.
- **Switch:** 32 x 18px round track in line-strong, white 14px knob; checked track is accent, knob slides on a spring curve.
- **Day chips:** 32px bordered chips; checked uses the inverted primary treatment.

### Navigation
- **Rail:** 34px items, 6px corners, 500 14px text-2 with a 16px text-3 pictogram. Hover tints to hover; selected sits on sunken with a 1px inset line ring and full-contrast text. Wordmark (15px, 600) with the violet mark tile on top; palette launcher (with kbd hint) and footer (version, user, sign out) below.
- **Segmented / Sub-nav:** a sunken 3px-padded track with a hairline border; options 28px, 13px weight 500, text-2; the selected option is raised on surface with the raised-option shadow (dark: `#262626` fill, no shadow).
- **Phone:** bottom tab bar of 54px items with 11px labels; the selected item's pictogram sits in a 40 x 26px round sunken capsule.

### Health Strip
A definition list of readouts divided by hairlines: 12px sentence-case term over a 14px 600 tabular value, unit in 12px text-3. Follows The Quiet Health Rule.

### Log and Prompt
The log is JetBrains Mono 12.5px/1.65 in text-2 on the log background. Warnings amber, errors red, chat full-contrast 600, joins green, leaves text-3, command echoes accent 600; replies sit in 6px sunken boxes. The prompt row has a hairline top border, a violet 1px top edge when focused, a mono `/` marker in accent, and an autocomplete popover (10px, overlay shadow) with a sunken signature hint.

### Status Bars and Jobs
Running work (op bar, jobs) shows a 2px accent indeterminate bar along the bottom edge (1.4s). Jobs are 6px sunken rows that tint with the accent while running or done, red on failure. The pending-restart bar is a 10px accent-tinted strip; the restart countdown is an inverted neutral band across the column.

### Dialog and Palette
Dialogs are 460px, 12px corners, raised surface, overlay shadow, with a 36px 10px-corner icon tile tinted by tone (danger red or neutral), body indented under the title, and a sunken-mixed action footer. The command palette is 640px with a 52px search input at 16px, grouped options (12px labels) with hover-tinted 6px selection, and a sunken kbd footer. Both enter with a short fade-and-rise on `cubic-bezier(0.2, 0.8, 0.2, 1)`.

### Toasts
Bottom-right, 10px corners, raised surface, overlay shadow, 13.5px 500; ok and bad toasts colour only their pictogram (bad also its border).

### Charts
Accent line at 2px with a 10% accent area fill; comparison series is a dashed text-2 line; dotted line-coloured gridlines, 11px tabular text-3 axis labels, tooltips as 10px overlays.

### Loading and Empty States
Skeleton bars are 12px sunken strips pulsing in opacity; empty states are plain text-3 sentences with the key term in full-contrast text.

## Do's and Don'ts

### Do:
- **Do** build every resident surface from page, surface and sunken with 1px line borders.
- **Do** use the inverted neutral for the one primary action in a panel, and the default bordered button for the rest.
- **Do** reserve violet for focus, links, live data and unsaved or pending state (The One Violet Rule).
- **Do** keep status hues to their meaning and tint status surfaces lightly (5-14% fill, 30-45% border).
- **Do** write labels in sentence case at 12px weight 500 in text-3, and use tabular numerals for changing numbers.
- **Do** set machine text (log, prompt, keys, versions) in JetBrains Mono.
- **Do** use 6px for controls, 10px for containers, 12px for overlays.
- **Do** design both themes; check dark values against the dark ramp, not by inverting light.

### Don't:
- **Don't** fill buttons, panels or headers with the accent or any status hue except a confirming danger button.
- **Don't** reintroduce per-area colours, coloured title fields, bands or 2px corners from the retired identity program.
- **Don't** use uppercase, letter-spaced labels or kickers above headings.
- **Don't** put shadows on resident layout beyond the light hairline.
- **Don't** use red for anything that is not a danger or failure.
- **Don't** reference the legacy `--c-*` or `--area` aliases in new code; use `--accent`, `--ok`, `--warn`, `--c-danger`.
