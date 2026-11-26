---
name: Helium Sync
description: A Swiss-grid technical service manual that happens to be interactive.
colors:
  paper: "#F2F1EC"
  ink: "#141414"
  muted: "#5E5E58"
  rule: "#C9C7BE"
  accent: "#C8322A"
  paper-dark: "#121212"
  ink-dark: "#EDEDE8"
  muted-dark: "#8A8A82"
  rule-dark: "#2A2A26"
  accent-dark: "#FF5A4E"
typography:
  display:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "clamp(3rem, 10vw, 6rem)"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.035em"
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "1rem"
    lineHeight: 1.5
  data:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.8125rem"
rounded:
  sm: "2px"
spacing:
  gutter: "24px"
  gutter-narrow: "16px"
---

## Overview

Swiss International Typographic Style applied to a service manual: a strict grid, ruled sections, paper and ink, one signal red. Think of a rail timetable or a workshop manual. Hierarchy comes from type weight, size and rule weight, never from boxes or depth.

## Colors

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#F2F1EC` | `#121212` | The only ground |
| `--ink` | `#141414` | `#EDEDE8` | Text, heavy rules, primary buttons |
| `--muted` | `#5E5E58` | `#8A8A82` | Secondary text, input borders |
| `--rule` | `#C9C7BE` | `#2A2A26` | Hairlines between rows (decorative only) |
| `--accent` | `#C8322A` | `#FF5A4E` | Step numerals, current rail item, errors and destructive actions, primary hover, focus, selection |

There is one accent. There is no green or amber: status is a shape plus a word. Dark mode follows `prefers-color-scheme`; there is no toggle.

## Typography

- System UI sans everywhere. No web fonts, no serif.
- Body 16px/1.5. Secondary 14px, meta 13px.
- Headings weight 800, balanced wrapping, tracking no tighter than -0.035em.
- Display: install page up to 6rem, index headline up to 4.5rem, extension page titles 1.5rem to 2.5rem.
- Monospace only for commands, IDs, versions, invite codes, server addresses and times.
- Tabular numerals for times and counts.
- Sentence case. No uppercase tracked labels.

## Layout

- 12 columns, 24px gutters, content width up to 1120px. Side margins 24px, 16px on small screens.
- Asymmetric splits: index 7 + 5; options rail 3 + sheet 8; install 6 + 5.
- A 2px ink rule opens a page or a major section; 1px ink separates sections of a sheet; 1px `--rule` separates rows.
- Single column on narrow screens (index below 920px, install and options below 760px). The options rail becomes a sticky horizontal tab strip.
- Popup: 360px wide, sticky header and footer, ruled sections.
- History: a ledger of `time · icon · title · host · source`; host and source drop to a second line below 640px.

## Elevation & Depth

None. No shadows, gradients, blur or glass. Sticky bars are opaque paper with a rule.

## Shapes

Square, with a 2px radius on buttons, inputs and boxes. Status and presence marks are 8px squares. The mark is the sync-arrows line icon: bare in page headers (`currentColor`), paper on a flat ink square for browser icons (`extension/icons/`).

## Components

| Component | Default | States |
|---|---|---|
| Primary button | Solid ink, paper text | Hover accent; disabled 45% opacity |
| Secondary button | 1px ink outline | Hover inverts to solid ink |
| Danger button | 1px accent outline, accent text | Hover solid accent |
| Link button | Underlined text | Hover accent |
| Input | 1px muted border, 40px high | Hover ink border; focus accent outline; invalid accent border |
| Switch | Outlined track, square knob | On: solid ink; disabled 40% |
| Segmented choice | Two joined outlined cells | Selected prints in reverse (ink ground) |
| Status (`.chip`) | Square mark + words | `ok` filled; `busy` pulsing; `warn` accent outline; `danger` accent fill and text; none: hollow |
| Presence (`.dot`) | Hollow square | `.on` filled |
| Notice | 1px box | `error` accent border and text; `warn` accent border; `info` ink border |
| Command block | Mono text, wraps, attached Copy button | Button reads "Copied" for 1.5s |
| Index rail | Ruled anchor list | Current item accent with square mark (`aria-current`) |
| Ruled list | Rows between hairlines | Empty and unavailable states are a plain muted row |

Focus is a 2px accent outline. Text selection is accent on paper. Motion is limited to 150ms state changes, the busy pulse and the spinner, all off under `prefers-reduced-motion`.

## Do's and Don'ts

- Do separate with rules and space. Don't wrap sections in cards.
- Do use ink for emphasis. Don't add a second accent or tint backgrounds.
- Do pair every state colour with a shape or a word.
- Don't use pills, emoji, icon-plus-card grids, eyebrows or serif display type.
- Server pages (`web/`) must stay self-contained: their Content-Security-Policy allows only inline CSS and JS and `data:` images. That is why their tokens are repeated rather than shared with `extension/ui/ui.css`.
