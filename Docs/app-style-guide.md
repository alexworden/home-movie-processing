# VidOrient — App Style Guide

| Field | Value |
| --- | --- |
| Status | Active |
| Related | [TDD](./TechDesign/TDD.md), [PRD](./Requirements/PRD.md), [URD](./Requirements/URD.md) |
| Implementation source | `frontend/src/index.css` (authoritative). Do not use `App.css` — it is not imported. |

## Purpose

Visual and interaction conventions for the VidOrient SPA. Extend these tokens and classes; do not invent a separate SaaS palette.

## Mood and materials

- Dark, slate-forward workspace for long library sessions.
- Subtle blue radial atmosphere on `body` (not flat single-color fills).
- Glass-style cards: translucent `--bg-card`, light `--border`, `backdrop-filter` where already used.
- Brand title uses a blue gradient text treatment (`h1`); product name remains the primary header signal. Subtitle sits on the **same header row**, right-aligned, muted.

## Color tokens

| Token | Role | Value |
| --- | --- | --- |
| `--primary` | Primary actions, brand accent | `#3b82f6` |
| `--primary-hover` | Primary hover | `#2563eb` |
| `--primary-glow` | CTA glow | `rgba(59, 130, 246, 0.5)` |
| `--bg-dark` | Page background | `#020617` |
| `--bg-card` | Card surface | `rgba(15, 23, 42, 0.6)` |
| `--bg-inner` | Nested inset surface | `rgba(0, 0, 0, 0.3)` |
| `--text-main` | Primary text | `#f8fafc` |
| `--text-muted` | Secondary text | `#94a3b8` |
| `--border` | Hairline borders | `rgba(255, 255, 255, 0.08)` |
| `--success` | Success / completed | `#10b981` |
| `--warning` | Warning / rotation attention | `#f59e0b` |
| `--danger` | Destructive / error | `#ef4444` |

Tag colors in use: `.tag-rotate` (amber / warning family), `.tag-optimize` (blue / primary family). If adding `.tag-convert`, define it in `index.css` alongside the others.

## Typography

- Family: `--font-family` → `'Inter', system-ui, -apple-system, sans-serif` (Inter may fall back if not loaded).
- Page title: large, heavy weight, tight tracking, gradient fill.
- Subtitle and muted labels use `--text-muted`.
- Prefer existing type sizes on header, cards, and table rows over one-off font sizes.

## Layout

- Centered column: `#root` `max-width: 1100px`, horizontal padding.
- Composition: one header row (brand + pill badge, subtitle on the right) → one navigation/browse card that also shows analysis and process actions on video rows.
- Opening a folder lists contents immediately, then analysis fills in on those same rows. Do not add a second results card.
- Cards are interaction containers for navigation and results — keep chrome consistent with existing card classes.

## Path bar and file list

- **Path bar**: full-width editable text field for the current directory (copy, paste, edit, Enter to go). Do not bury it inside Scan controls. The last successfully listed folder is restored from `localStorage` (`vidorient.lastFolder`, same browser storage as `vidorient.favorites`); if that folder cannot be opened, the path falls back to `/Volumes`.
- **Breadcrumbs**: muted clickable ancestor segments under or beside the path bar; they navigate but never replace the full path field.
- **Browse list**: table-like rows with checkbox, 72×42 thumbnail (or muted video placeholder), Name / Type / Size / Status. Folders use primary-blue folder icons and open on click. Name shows dimensions, convert/role tags — not rotation or “optimization suggested” tags. A muted pencil (`.name-rename`, lucide `Pencil`) sits to the right of the filename; it does not toggle selection. Inline rename uses `.name-rename-input` for the stem only (selected on open) and a muted `.name-rename-ext` suffix so the extension is clearly kept. After a rename, that row updates in place and keeps its position (even if Name sort would place it elsewhere) until Rescan or a sort header is clicked. Size may stack **Orig / Conv / Arch** lines when a group has more than one member. When both original and converted sizes are known, add a `.size-saved` line in `--success`: **−N% · {size}** (percent of original size removed, then bytes). If the converted file is not smaller, use muted `.size-saved-none` **No size saved**. Orig size may come from stored metadata after the original file is gone. Status: **Optimize & Rotate** when orientation still needs baking in; **Optimize** when a large MOV still needs shrinking (no rotation); **Optimized** after a converted copy exists or a job completed; **OK** when analysis shows no optimize or rotate is needed. Progress / Failed / Queued as before.
- **Favorites**: star the current folder (amber when favorited). Home and `/Volumes` stay pinned. A labeled `.filter-menu` **Favorites** select jumps to a saved folder.
- **Destructive actions**: confirm in a native dialog first, then run from the scan-row **Actions** menu (never a glowing primary for delete).
- **Scan row**: one line under breadcrumbs: Include subfolders, quiet Rescan, then an **Actions** `.filter-menu` for the selected videos (disabled until a row is checked). File Type and Status menus on the right of the same row.
- **Nested relative path**: when a listed video is below the current folder (recursive scan), show the extra folders as muted `.file-relpath` text above the filename (`2026/July/`), then the filename on its own line. Do not repeat the filename in the path line. Files in the current folder have no path line.
- **Sort headers**: quiet text buttons; active column uses `--text-main`; caret indicates direction.
- **List filters**: labeled `.filter-menu` dropdowns for **File Type** and **Status** on the scan row (not a separate toolbar).
- **Role tags**: **Converted** and **Archived** are clickable `.file-role-tag`s when those copies exist. If neither exists, an **Original** tag (`.tag-original`, muted slate) is shown instead. Click opens a small `.file-open-menu`: Show in Finder / Open in Preview. Clicking a tag does not toggle row selection.

## Controls

- Primary CTAs: glowing primary buttons (`.btn-primary-glow`, `.scan-master-btn` pattern).
- Secondary / quiet actions: muted borders and text, not competing glow (`.secondary.small`).
- **Actions** for selected videos: labeled `.filter-menu` on the scan row. Options that do not apply to the current selection are disabled. Confirm before Restore / Delete archive.
- Pills/badges: `.badge-modern` (rounded-full, low-contrast border).
- Prefer lucide-react icons already used for folder/video cues; keep icon colors on token blues/muted greys (`#3b82f6` / `#94a3b8`).

## Motion

- Existing: `fade-in` for results appearance; `spin` for in-progress affordances.
- Use motion for hierarchy/progress presence only — no decorative animation noise.

## Checklist (before shipping UI)

- [ ] Opened this style guide for the change
- [ ] Used documented primary controls / card chrome (no ad-hoc flat SaaS buttons)
- [ ] Used color tokens / existing tag classes (no one-off purple palette)
- [ ] Typography uses `--font-family` and existing scales
- [ ] Layout stays within the centered column and section pattern
- [ ] Motion limited to existing fade/spin (or documented extension)
- [ ] New reusable visual rules added here in the same change set
- [ ] Styles land in `index.css`, not the unused `App.css`
