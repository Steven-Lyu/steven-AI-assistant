---
version: alpha
name: Personal AI
description: A quiet personal workspace built around reviewing and completing everyday tasks.
colors:
  primary: "#245b4e"
  primary-hover: "#194538"
  background: "#f6f8f7"
  surface: "#ffffff"
  text: "#182f30"
  muted: "#617171"
  border: "#dce5e1"
  sidebar: "#183c3d"
  sidebar-text: "#d8e7e2"
  accent: "#d7efb0"
  success: "#316348"
  warning: "#805e1b"
  danger: "#a33f35"
  mint: "#eaf3ed"
  peach: "#faeee6"
  blue: "#eaf0f7"
typography:
  body:
    fontFamily: "Segoe UI, Arial, sans-serif"
  display:
    fontFamily: "Trebuchet MS, Segoe UI, sans-serif"
  mono:
    fontFamily: "Consolas, monospace"
rounded:
  DEFAULT: "16px"
  control: "10px"
spacing:
  base: "24px"
  page-max: "1450px"
components:
  button:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
---

# Personal AI Design System

## Overview

The reference is a tidy personal desk: a dark teal organizer beside a bright work surface, with small paper cards moving into place. This is an operational product, not a marketing landing page. The user requested less copy, English and meaningful animation on 2026-11-10.

Audience: a student demonstrating a personal assistant on desktop, with a usable narrow web layout. UI locale is English; user-authored content and paths remain verbatim. No Japan-market requirement. The signature is the file-to-folder transition on actual completion. Keep permission and business approvals readable and separate. Avoid dense tutorial text, invented metrics and marketing sections.

Runtime ownership: `public/style.css :root` is canonical (Model B). `colors.*` maps directly to `--color-*`; typography maps to `--font-body`, `--font-display`, `--font-mono`; radius maps to `--radius` and `--radius-control`. Shared button, panel, status, input and navigation recipes consume these variables. This document mirrors accepted values; no generated theme or framework adapter exists.

## Colors

Teal carries navigation and primary actions, mint supports file work, peach denotes review and blue marks email. Text uses text/muted tokens on background/surface. Success, warning and danger always have text labels. One light workspace with a fixed dark sidebar, not a switchable dark theme. Forced colors retain system outlines and operable scrollbars.

## Typography

Trebuchet display adds a human quality to the short greeting; Segoe UI makes controls familiar on the target Windows system. Consolas distinguishes small activity timestamps. Fonts are local to avoid loading shifts and network dependencies. Updated by user request on 2026-11-11: body 16px/1.55, controls and file names 15px, supporting text 13–14px, small metadata 12px, panel headings 18px, display 36–48px. Shared scale is owned by `--text-body`, `--text-control`, `--text-meta`, `--text-small`, and `--text-section` in CSS. Sentence case for actions; short uppercase metadata only. On narrow screens assistant cards stack to preserve readable type.

## Layout

Desktop sidebar 232px, content max 1450px, 24px base spacing. Three assistant shortcuts precede the two-column task workspace. Below 980px task panels stack; below 650px navigation becomes a normal-flow header. Document owns scrolling; long details and input may scroll internally. Activity starts with five records and an explicit Show more action. Input draft survives route changes.

## Elevation & Depth

User-approved depth refresh (2026-11-11): the workspace is a physical desk with a consistent top-left light source. Large panels use a white top highlight, a 3px lower rim and a broad green-tinted contact shadow. Assistant cards sit one level lower and lift 3px on pointer hover. Inputs, the sample inbox and the transfer surface are recessed; primary buttons have a 4px base and depress on activation. Decorative paper, icon tiles and folders use smaller contact shadows. The hero's decorative core has a static perspective treatment, while text and operational panels stay flat and readable.

Canonical CSS depth tokens: `--surface-raised`, `--surface-inset`, `--shadow-panel`, `--shadow-card`, `--shadow-card-hover`, `--shadow-inset`, `--shadow-button`, `--shadow-button-pressed`, `--shadow-icon`, `--edge-highlight` and `--depth-lift`. All are authored in the tactile-workspace section of `public/style.css`; shared components consume them. Hover transforms are limited to fine pointers and disabled by reduced motion. No cursor-following tilt, new continuous animation, translucent text surface or layout-shifting border changes. Forced colors replaces depth with system boundaries. Existing file-transfer keyframes and large typography remain authoritative.

## Shapes

16px panels, 10px controls, small circular status dots accompanied by words. Consistent 1.5px vector strokes. Large decorations are hidden from accessibility APIs.

## Components

Buttons: primary, secondary and ghost share size, focus and pressed behavior. Disabled and pending states use native semantics. Error messages persist inline. Navigation uses real hash links and aria-current. Details use native disclosures. No modal or select is needed for this workflow; approvals are persistent inline panels.

Motion: 160ms hover, 440ms state entrance, 550ms file completion stagger. Entrance only on task/state transitions, never every stream event. The decorative introduction stops within five seconds. Indeterminate activity runs only while a task is active. The reduce-motion switch and OS preference suppress all motion. Focus and disclosure state survive stream updates.

Organization motion (2026-11-11): after approval, the executing view shows an indeterminate file-to-folder visualization grouped by actual plan destinations. A locally approved, confirmed completion plays a 1700ms file transfer with up to 450ms folder stagger. The status immediately reflects the real backend result; the animation is a completion visualization, never an artificial execution delay or progress counter. Previously completed tasks show the static folder receipt. Reduced motion shows the same receipt without moving cards. File names and destinations remain available in a native disclosure.

Global scrollbar tokens: thumb #a6b9af, track #eef2ef, hover #7b9789, active #506f60. Standards-based scrollbar properties plus WebKit fallback apply to every element. Forced colors use system defaults.

## Do's and Don'ts

- Do show what will move before confirmation.
- Do put rationale and diagnostics behind accessible disclosures.
- Do preserve raw file names and permission scopes.
- Don't imply calendar or email are connected.
- Don't invent progress percentages or replay entry motion on streamed tokens.
