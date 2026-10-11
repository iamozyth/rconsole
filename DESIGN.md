---
name: rconsole
description: A single-server Minecraft operator console run as an identity program, Munich '72 discipline applied to server operations.
colors:
  console-sky: "#0a70b5"
  players-green: "#0a7a3f"
  backups-deep-blue: "#2a4596"
  schedule-orange: "#b35000"
  updates-violet: "#6a3d9e"
  danger-red: "#c0262d"
  on-area: "#ffffff"
  ground-white: "#ffffff"
  surface-silver: "#f4f6f8"
  field-white: "#ffffff"
  sunken-grey: "#e9ecf0"
  rail-grey: "#eceff3"
  line: "#d9dee4"
  line-strong: "#b8c0ca"
  ink: "#12171e"
  ink-2: "#444e5b"
  ink-3: "#636d79"
  console-sky-dark: "#5ab8f2"
  players-green-dark: "#4fcb87"
  backups-deep-blue-dark: "#98aeff"
  schedule-orange-dark: "#ffa452"
  updates-violet-dark: "#bf9af4"
  danger-red-dark: "#ff7b7b"
  on-area-dark: "#061226"
  navy-ground: "#08172e"
  navy-surface: "#0d203d"
  navy-field: "#0a1a33"
  navy-rail: "#061226"
  navy-raised: "#112a4d"
  navy-line: "#1c3659"
  navy-line-strong: "#2d4d7a"
  navy-ink: "#e9eff8"
  navy-ink-2: "#b6c4d8"
  navy-ink-3: "#8fa2be"
typography:
  display:
    fontFamily: "Archivo, 'Helvetica Neue', Helvetica, 'Segoe UI', system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 750
    lineHeight: 1.45
    letterSpacing: "-0.025em"
    fontVariation: "'wdth' 112"
  headline:
    fontFamily: "Archivo, 'Helvetica Neue', Helvetica, 'Segoe UI', system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 650
    lineHeight: 1.45
    letterSpacing: "-0.015em"
  numeral:
    fontFamily: "Archivo, 'Helvetica Neue', Helvetica, 'Segoe UI', system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 700
    letterSpacing: "-0.02em"
    fontFeature: "'tnum'"
    fontVariation: "'wdth' 105"
  title:
    fontFamily: "Archivo, 'Helvetica Neue', Helvetica, 'Segoe UI', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 650
    lineHeight: 1.45
    letterSpacing: "-0.005em"
  body:
    fontFamily: "Archivo, 'Helvetica Neue', Helvetica, 'Segoe UI', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  control:
    fontFamily: "Archivo, 'Helvetica Neue', Helvetica, 'Segoe UI', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 550
  readout:
    fontFamily: "Archivo, 'Helvetica Neue', Helvetica, 'Segoe UI', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 650
    fontFeature: "'tnum'"
  label:
    fontFamily: "Archivo, 'Helvetica Neue', Helvetica, 'Segoe UI', system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.06em"
    fontVariation: "'wdth' 92"
  log:
    fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  none: "0px"
  r: "2px"
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
    backgroundColor: "{colors.field-white}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
    padding: "0 14px"
    height: "34px"
  button-hover:
    backgroundColor: "{colors.sunken-grey}"
  button-primary:
    backgroundColor: "{colors.console-sky}"
    textColor: "{colors.on-area}"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
    padding: "0 14px"
    height: "34px"
  button-danger:
    backgroundColor: "{colors.danger-red}"
    textColor: "{colors.on-area}"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
    padding: "0 14px"
    height: "34px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
    padding: "0 14px"
    height: "34px"
  button-sm:
    padding: "0 10px"
    height: "30px"
  field:
    backgroundColor: "{colors.field-white}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.r}"
    padding: "0 10px"
    height: "34px"
  panel:
    backgroundColor: "{colors.surface-silver}"
    textColor: "{colors.ink}"
    rounded: "{rounded.r}"
  panel-head:
    padding: "12px 16px"
    height: "52px"
  area-title:
    backgroundColor: "{colors.console-sky}"
    textColor: "{colors.on-area}"
    typography: "{typography.display}"
    padding: "16px 28px"
    width: "232px"
  rail-tab:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
    padding: "7px 8px"
  rail-tab-active:
    backgroundColor: "{colors.console-sky}"
    textColor: "{colors.on-area}"
  pill:
    backgroundColor: "{colors.sunken-grey}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.r}"
    padding: "2px 8px"
  count:
    backgroundColor: "{colors.sunken-grey}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.full}"
    padding: "1px 7px"
  countdown-banner:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground-white}"
    padding: "10px 28px"
  dialog:
    backgroundColor: "{colors.surface-silver}"
    textColor: "{colors.ink}"
    rounded: "{rounded.r}"
    width: "460px"
  toast:
    backgroundColor: "{colors.surface-silver}"
    textColor: "{colors.ink}"
    rounded: "{rounded.r}"
    padding: "12px 14px"
---

# Design System: rconsole

## Overview

**Creative North Star: "The Identity Program"**

rconsole is run the way Otl Aicher ran the Munich '72 Games: a strict program of colours and geometric pictograms in which every place owns one hue and one sign, so the operator knows where they are and what state the server is in before reading a word. The five work areas (Console, Players, Backups, Schedule, Updates) are venues; each venue's colour lands on its signage (the solid area-title field), its rail tile, a 4px band under the top bar, and its primary actions. Everything else stays neutral so that colour keeps its meaning.

The density is an operator's: 14px body, 34px controls, hairline rules, tabular numerals in every readout and table. Surfaces are flat solid fills on 2px corners; depth exists only where something genuinely floats above the work (dialogs, toasts). Two themes share one program: the light theme is the Munich program on white with silver panels, the dark theme is Lufthansa navy with the same hues lifted for a dark ground.

The system rejects the category default of a grey-black dashboard with one neon accent and monospace everywhere. Monospace belongs to the log and the command prompt only; the UI speaks in Archivo, a Univers-like variable grotesk whose width axis carries hierarchy.

**Key Characteristics:**
- One program colour per work area, applied as solid fields, never as gradients or glows.
- Filled geometric pictograms on a 24-unit grid, 45/90 degree angles, round heads, for every area and action.
- Flat 2px-cornered panels, hairline borders, shadows only on overlays.
- Archivo variable for all UI, width axis used for signage (112%) and labels (92%); tabular numerals for every number.
- Neutral health strip; colour appears only when something is off-nominal.

## Colors

A strict five-hue program plus one danger red, on cool white/silver (light) or Lufthansa navy (dark) neutrals; the active area's hue is exposed to every component as the `--area` variable.

### Primary
The primary is not one colour but the program: whichever area is active supplies `--area`. Each hue is defined for both themes (light value, then lifted dark value with `-dark` suffix).
- **Console Sky** (console-sky / console-sky-dark): Console area; also the login page and the rconsole mark tile, since Console is the home venue.
- **Players Green** (players-green / players-green-dark): Players area.
- **Backups Deep Blue** (backups-deep-blue / backups-deep-blue-dark): Backups area.
- **Schedule Orange** (schedule-orange / schedule-orange-dark): Schedule area.
- **Updates Violet** (updates-violet / updates-violet-dark): Updates area.
- **On-Area** (on-area / on-area-dark): text and pictograms placed on a solid program field: white in light, deep navy in dark.

### Secondary
- **Danger Red** (danger-red / danger-red-dark): the one non-program hue. Destructive actions (delete, ban, deop, rollback confirmations), failures (job failed, toast error, log ERROR lines, area errors, invalid fields), RCON down, and critical health readouts. Never decoration, never an area.

### Neutral
- **Ground White / Navy Ground** (ground-white / navy-ground): page ground behind the work area and top bar.
- **Surface Silver / Navy Surface** (surface-silver / navy-surface): panels, dialogs, toasts.
- **Field White / Navy Field** (field-white / navy-field): inputs, default buttons, the command prompt; in light theme fields sit white inside silver panels.
- **Sunken Grey** (sunken-grey; navy-field in dark): table header rows, neutral pills and counts, skeletons, idle job strips, dialog action bar, quiet-button hover.
- **Rail Grey / Navy Rail** (rail-grey / navy-rail): the side rail, phone tab bar and login ground.
- **Line / Line Strong** (line, line-strong / navy-line, navy-line-strong): hairline rules between rows and panels; stronger stroke for control borders.
- **Ink 1-3** (ink, ink-2, ink-3 / navy-ink, navy-ink-2, navy-ink-3): primary text, secondary text and nav labels, tertiary text (labels, meta, placeholders).
- **Navy Raised** (navy-raised): dark-theme dialog surface, one step lighter than navy-surface, paired with a line-strong border instead of a shadow.

### Named Rules
**The One Venue, One Colour Rule.** Each work area owns exactly one program colour and shows it in four places only: the solid area-title field, the active rail tile, the 4px band, and primary actions (plus in-area accents such as switches, selected segments, selected days, running/done jobs, `.own` pills, focus rings). No area borrows another's hue.

**The Red Means Danger Rule.** Red is reserved for destructive actions and failure or critical states. A red element is always a warning; nothing red is merely decorative.

**The Quiet Health Rule.** Health readouts are neutral ink when nominal. Off-nominal values gain the alert pictogram; "needs attention" stays ink with an ink-2 pictogram, "critical" turns the value red. The strip never borrows an area colour.

**The Hue-Free Countdown Rule.** The restart countdown banner is a solid ink field with ground-coloured text, deliberately outside the program so it reads as a server-wide event, not as any area.

**The Universal Signals Exception.** Two hues appear outside their area by design: log WARN lines stay schedule-orange (and joins players-green, commands console-sky) because they are log data, and the connection dot stays players-green as a universal state light.

## Typography

**Display Font:** Archivo variable, self-hosted (weight 100-900, width 62-125%), with 'Helvetica Neue', Helvetica, 'Segoe UI', system-ui fallback
**Body Font:** Archivo (same family)
**Label/Mono Font:** system monospace stack (ui-monospace, SF Mono, Cascadia Mono, Menlo, Consolas) for the log, command prompt, codes and kbd only

**Character:** One grotesk doing all the work, signage-wide at the top and condensed for labels, like a stadium sign system set in Univers; the mono face is confined to machine output.

### Hierarchy
- **Display** (750, 24px, width 112%, -0.025em): the area name on its solid colour field; 20px on phones.
- **Headline** (650, 22px, -0.015em): standalone page headings (login "Sign in").
- **Numeral** (700, 26px, width 105%, -0.02em, tabular): the installed version on Updates; 20px on phones. The wordmark uses the same width (700, 18px, 105%).
- **Title** (650, 15px, -0.005em): panel headings; dialog titles step up to 17px.
- **Body** (400, 14px/1.45): all running text and table cells; secondary meta at 12.5-13px in ink-3.
- **Control** (550, 14px): buttons, rail tabs, segmented controls; 13px in small buttons.
- **Readout** (650, 15px, tabular): health values, units in 12px/500 ink-3.
- **Label** (600, 11px, width 92%, 0.06em, uppercase): health readout terms and table column headers only.
- **Log** (mono 12.5px/1.6): the live log; command input in mono 14px.

### Named Rules
**The Width Axis Rule.** Hierarchy is carried by Archivo's width axis as much as by size: wide (105-112%) for signage and identity, normal for reading, condensed (92%) for data labels.

**The Tabular Rule.** Every number that can change (readouts, counts, tables, versions, countdown) uses tabular numerals.

## Layout

Desktop is a two-column grid: a 224px rail and a fluid work column (full viewport height, the work area scrolls on its own). The top bar holds the area-title field flush left (min 232px), the connection chip, and the health strip pushed right as a row of readouts divided by hairlines; a 4px band in the area colour runs under it. The restart countdown, when active, sits as a full-width banner below the band. Work areas are capped at 1400px with 20px gaps between panels and 24px/28px main padding. Console fills the area: log panel plus a 300px side column (Online, Quick actions, Restart). Other areas use a two-up panel grid or full-width tables; the schedule form is a four-column field grid.

Spacing runs on 4px steps, mostly 8/12/16/20/24 with 28px as the outer gutter. Panel heads are 52px tall with 12/16 padding; panel bodies 16px.

Responsive steps: at 1180px the health strip wraps under the title onto its own scrolling row, gutters drop to 20px, the console side column narrows to 260px and the schedule form goes two-up. At 900px panels stack to one column and the console log takes 62dvh. At 760px (phone) the rail becomes a fixed bottom tab bar of five pictogram tiles with labels; the health strip becomes a 4-column, 2-row grid with every readout visible (units hidden); the band is dropped; tables become stacked cards with each cell's label absolutely positioned in a 100px left column; form actions go full width; inputs use 16px text; main reserves bottom padding for the tab bar; toasts span the width above it.

## Elevation & Depth

Flat by default. Panels, rail and top bar separate by tone (ground, silver/navy surface, sunken) and 1px hairlines, never by shadow. No glass, no backdrop-filter, no gradients. Shadows exist only for things that float over the work.

### Shadow Vocabulary
- **Overlay (light)** (`box-shadow: 0 12px 32px rgba(14, 24, 40, 0.18), 0 2px 6px rgba(14, 24, 40, 0.08)`): the confirmation dialog in light theme.
- **Toast** (`box-shadow: 0 6px 16px rgba(14, 24, 40, 0.14)`): toasts, both themes.
- **Dark dialog**: no shadow; navy-raised surface with a 1px line-strong border.
- **Focus halo** (`box-shadow: 0 0 0 3px` area at 22%): focused fields and search; the prompt shows an inset 2px area-coloured top rule on focus. These are focus indicators, not elevation.

### Named Rules
**The Only Overlays Float Rule.** A shadow means "this is above the page and will go away": dialogs and toasts. Anything resident in the layout is flat.

## Shapes

Square-ish and engineered: a single 2px radius on panels, buttons, fields, pills, tiles, kbd and skeletons. Fully round shapes are reserved for things that are round by nature: the connection chip and count badge (999px), the switch, the connection dot. The login panel drops to 0px corners under a 4px console-sky top rule, echoing the band. The rconsole mark is a 32-unit square tile with 3-unit corners carrying a three-face isometric block in white at 100/72/45% opacity.

Pictograms are filled, never stroked: geometry on a 24-unit grid, 45 and 90 degree angles, round heads and circles, evenodd cut-outs for interior detail. Sizes: 18px default, 16px in buttons and jobs, 14px in readouts, 12px in pills, 30px in the area title (24px phone).

## Components

### Buttons
Calm, standard, unmistakable.
- **Shape:** 2px corners, 34px tall (30px small, 40px on login), 14px side padding, pictogram plus label with 8px gap.
- **Default:** field fill, line-strong border, ink text; hover to sunken fill with ink-3 border; active darkens slightly.
- **Primary:** solid area colour with on-area text; hover mixes 14% ink into the area colour. It always takes the active area's hue.
- **Danger:** solid danger red with on-area text; used for the confirming button of destructive dialogs and destructive actions.
- **Quiet:** transparent, ink-2 text; hover to sunken fill. Quiet-danger (row Remove/Deop/Delete) turns red only on hover.
- **Busy/Disabled:** 55% opacity, progress or not-allowed cursor.
- **Touch:** under `(hover: none)` hover tints are disabled so taps do not leave buttons or rows stuck in a hover state.

### Pills and Counts
- **Pill:** 2px corners, 12px/600, neutral sunken fill with ink-2 text by default; `.own` variant tints 14% of the area colour with area-coloured text (Active task, stable channel).
- **Count:** fully round sunken badge with tabular 12px/600 numerals beside panel titles; hidden when empty.

### Cards / Containers
- **Corner Style:** 2px.
- **Background:** surface-silver / navy-surface with a 1px line border.
- **Shadow Strategy:** none (see Elevation).
- **Internal Padding:** 52px head (12px 16px) with a hairline under it, 16px body.

### Inputs / Fields
- **Style:** 34px, field fill, 1px line-strong border, 2px corners, 14px text (16px on phones); hover to ink-3 border.
- **Focus:** border turns area colour plus a 3px area halo at 22%.
- **Error:** border turns danger red (`aria-invalid`); form errors in red 13px text.
- **Switch:** 34x20 round track in line-strong, white knob, area colour when on.
- **Segmented control:** bordered 2px group, selected segment solid area colour.
- **Day picker:** bordered 2px chips, checked chips solid area colour.

### Navigation
- **Desktop rail:** wordmark, then five tabs (30px pictogram tile + 14px/550 label). Each tile is tinted 14% of its own area colour with the pictogram in that colour, so every venue is identifiable at rest. Hover tints 8%. The active tab is a solid field in its area colour with on-area text and pictogram. Signed-in user and Sign out sit in the rail foot.
- **Phone:** fixed bottom tab bar on rail ground; tabs stack a 40x28 tile over an 11px label. Active tab: solid area-colour tile, label in area colour.

### Area Title and Band (signature)
The area's name in Display type with its 30px pictogram, white (on-area) on a solid field of the area colour, flush to the top-left of the work column, with a 4px band of the same colour running the full width beneath the top bar. Colour changes animate over 200ms ease-out when switching areas.

### Health Strip
A definition list of readouts (TPS, Players, Game time, CPU, Memory, Disk free, Host up): uppercase condensed labels over 15px tabular values, divided by hairlines. Follows The Quiet Health Rule.

### Connection Chip
Fully round 1px-bordered chip with an 8px dot: grey while connecting, green when connected, red text, border and dot when RCON is down.

### Log and Prompt
Mono log on its own ground (white / deep navy) in ink-2; chat lines bold ink, joins green, leaves ink-3, WARN orange, ERROR red, sent commands console-sky bold with replies in a lightly tinted 2px block. A red-tinted status strip appears above the log when it cannot be read. The prompt is docked under the log: a mono "/" in area colour, a borderless mono input, a kbd hint, and a small primary Run button.

### Jobs
A sunken strip with pictogram and message for backup/update jobs. Running: area-tinted fill and border with a 2px area-coloured indeterminate bar sliding along the bottom (1.4s). Done: area tint with area pictogram. Failed: red tint and red text.

### Dialog
Confirmation dialog, 460px max: a 36px solid tile with the action's pictogram (area colour for primary tone, red for danger tone), 17px title, ink-2 body, and a sunken action bar with Cancel plus a primary or danger confirm button. Enters with 180ms fade/rise. Overlay scrim on the backdrop.

### Toasts
Bottom-right stack (full width above the tab bar on phones): surface panel, check pictogram in area colour for success, alert pictogram and red-tinted border for errors (errors persist 8s, successes 4s).

### Loading and Empty States
Skeleton bars (12px, 2px corners, sunken, 1.2s pulse) in the shape of the rows that will load. Empty lists and tables show a plain ink-3 sentence with any key term in bold ink, no illustration.

## Do's and Don'ts

### Do:
- **Do** route every area accent through `--area`, so the active venue's program colour drives fields, primary buttons, focus, switches and selected states automatically.
- **Do** give every new area or action a filled geometric pictogram on the 24-unit grid (45/90 degree angles, round heads) and add it to the sprite.
- **Do** keep panels flat: surface fill, 1px line border, 2px corners.
- **Do** use tabular numerals for every changing number.
- **Do** mark off-nominal states with the alert pictogram and, when critical or failed, danger red; leave nominal states neutral.
- **Do** confirm destructive actions in the dialog with a red tile and a danger confirm button.
- **Do** keep the light theme white ground / silver panels / white fields, and the dark theme Lufthansa navy with lifted program hues.
- **Do** disable hover tints under `(hover: none)`; on phones use the bottom tab bar, the 2-row health grid and stacked tables with positioned labels.

### Don't:
- **Don't** use a second area's colour inside an area, or put a program colour on the health strip or countdown banner.
- **Don't** use red for anything that is not destructive or failing.
- **Don't** add glass, backdrop-filter, gradients, glows, or shadows on resident surfaces; only dialogs and toasts float, and the dark dialog uses a border instead.
- **Don't** set UI text in monospace; mono is for the log, the prompt and codes.
- **Don't** use stroked or outline icon sets or emoji; pictograms are filled geometry.
- **Don't** round beyond 2px except for things that are round by nature (chips, counts, switches, dots).
