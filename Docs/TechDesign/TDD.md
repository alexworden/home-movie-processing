# VidOrient — Technical Design Document (TDD)

| Field | Value |
| --- | --- |
| Status | Active |
| Related | [PRD](../Requirements/PRD.md), [URD](../Requirements/URD.md), [Style Guide](../app-style-guide.md) |

## Purpose

Architecture, API/data contracts, and implementation patterns for VidOrient. Prefer HTTP APIs for all state changes; clients poll for job progress (no WebSocket/SSE today).

## Architecture overview

| ID | Design | Traces |
| --- | --- | --- |
| TDD-001 | Local split app: Express API (`backend/`) + React/Vite SPA (`frontend/`). Default ports: API `3001` (`PORT` env override), Vite `5173`. Frontend `API_BASE` is hardcoded to `http://localhost:3001/api`. | PRD-001–PRD-015 |
| TDD-002 | Modules: `backend/server.js` owns HTTP routes, in-memory `scanResults` / `jobs` / `queue` / `activeJobCount`. `backend/processor.js` owns browse, scan/probe, FFmpeg transcode, thumbnail extract, and playable-file verify. `backend/scanStore.js` owns `.vidorient/` persistence and grouping. | PRD-012, PRD-015, PRD-027 |
| TDD-003 | No database. Jobs live in process memory. Scan metadata is `{dir}/.vidorient/metadata.json` (legacy `{dir}/.vidorient.json` is migrated on read). Thumbnails are `{dir}/.vidorient/thumbs/{basename}.jpg`. Filesystem side effects: write output MP4; after verified `.mov` success, `rename` original into sibling `archive/` unless that dest exists. | PRD-011, PRD-015, PRD-027, PRD-032 |
| TDD-004 | Progress is **poll-only**: `GET /api/jobs`. Realtime channels must not be introduced as the mutation or bulk state-transfer path; if added later, notify-only then re-fetch. | PRD-013 |

## HTTP API contracts

| ID | Design | Traces |
| --- | --- | --- |
| TDD-010 | `GET /api/browse?folder=&recursive=` — default folder `/Volumes`. Recursive lists nested videos via `scanDirectory`. Response `{ current, parent, subdirs, files, groups }`. `groups` is original/converted/archive coalesced via `groupListedFiles`. Files include cached probe fields and thumbnail flags from `.vidorient/` when present. Does not probe. Omits hidden and `archive` dirs. | PRD-001, PRD-003, PRD-026, PRD-027, PRD-029 |
| TDD-011 | `GET /api/scan?folder=&recursive=&force=` — `folder` required. Recursive unless `recursive` is `'false'` or `'0'`. Reuses `.vidorient/metadata.json` when a record matches by path, current/original/converted name, or stem, unless `force` or size/mtime (2s slack) changed. Converted MP4s must not re-probe when the original record already has analysis. | PRD-002, PRD-015, PRD-027 |
| TDD-012 | Scan item (success): `id` (UUID), `name`, `path`, `relativePath`, `size`, `extension`, probe fields (`rotation`, `width`, `height`, `duration`, `codec`), `suggestRotation`, `suggestOptimization`, `suggestConversion`, `status: 'idle'`. Probe failure: `status: 'error'`, `error`. | PRD-004, PRD-005 |
| TDD-013 | Suggestion rules in scan: `suggestRotation = rotation !== 0`; `suggestOptimization = .mov && size > 100MB`; `suggestConversion = .mov`. Sort prefers MOV+rotation, then rotation, then large MOV. | PRD-005 |
| TDD-014 | `POST /api/process` body `{ fileId, options: { fixRotation?, optimize?, convert? } }`. Looks up `fileId` in last `scanResults`. Rejects unknown id (`404`) and duplicate job unless prior status is `failed` (`400`). Refuses if output path exists (`409`). Response job `{ id, progress: 0, status: 'queued', outputPath }`. | PRD-007, PRD-008, PRD-014, PRD-033, PRD-034 |
| TDD-015 | Output naming: same directory as source; `.mov` → `{basename}.mp4`; else → `{basename}.fixed.mp4` (extension stripped case-insensitively). | PRD-008 |
| TDD-016 | `GET /api/jobs` returns `Object.values(jobs)` with `id`, `progress`, `status` (`queued` \| `processing` \| `completed` \| `failed`), optional `outputPath` / `error` / `warning`. | PRD-012, PRD-013, PRD-034 |
| TDD-017 | `POST /api/scan/files` body `{ paths: string[], rootFolder?, force? }`. Probe only paths that `needsProbe`. Persist into each file’s directory `.vidorient/metadata.json`. Client sends only files that browse did not already mark `analyzed`. `POST /api/scan/cancel` increments `scanGeneration` so in-flight probe chunks stop. | PRD-026, PRD-027 |
| TDD-018 | `GET /api/places` returns `{ home: os.homedir(), volumes: '/Volumes' }`. `GET /api/thumbnail?file=` serves a jpeg from that video’s directory `.vidorient/thumbs/` using `sendFile` with `dotfiles: 'allow'`. Do not re-extract a thumbnail when the jpeg already exists. `POST /api/thumbs/status` body `{ paths }` returns ready flags. Background thumb queue max 2. | PRD-027, PRD-028 |
| TDD-019 | `POST /api/restore` body `{ folder, recordKey, deleteConverted? }`. Renames archive to original path; refuses overwrite; verifies playable; optional unlink of converted only after original is back. `POST /api/archive/delete` body `{ folder, recordKey }` unlinks archive only after converted exists and `assertPlayableVideo` succeeds. | PRD-030, PRD-031 |

## Queue and processing

| ID | Design | Traces |
| --- | --- | --- |
| TDD-020 | FIFO queue; `MAX_CONCURRENT_JOBS = 3`. On complete/fail, decrement active count and drain queue again. | PRD-012 |
| TDD-021 | `processVideo`: input `-noautorotate`. Rotation filters unchanged. If `convert` and not `fixRotation` and not `optimize`, remux with video+audio copy. Otherwise encode `libx264` `-pix_fmt yuv420p` `preset medium`: CRF **26** when `optimize`, CRF **23** otherwise. Always `audioCodec('copy')`, MP4, `+faststart`. | PRD-009, PRD-010, PRD-022, PRD-023 |
| TDD-022 | Rotation probe reads format/stream tags and side data, then **inverts** 90↔270 so burn-in transpose matches intended upright frame. | PRD-009 |
| TDD-023 | After encode, `assertPlayableVideo` on the output (duration check). Then for `.mov`: if `{sourceDir}/archive/{name}` exists, skip move and set `warning`; else `rename` original into `archive/`. Archive skip/errors do not fail the job if encode+verify succeeded. Then `markProcessed`. | PRD-011, PRD-032 |
| TDD-024 | Do not re-encode to HEVC. 8-bit H.264 avoids High 10 bitrate bloat; CRF 26 is slightly higher quality than CRF 28 while staying smaller than CRF 20. | PRD-022, PRD-023 |

## Frontend patterns

| ID | Design | Traces |
| --- | --- | --- |
| TDD-030 | Single-screen SPA in `frontend/src/App.jsx` (no router). Styles: import `index.css` only (`App.css` is unused/stale). | PRD-001–PRD-021 |
| TDD-031 | After scan, auto-select items with `suggestRotation` or `suggestOptimization`. Process options per row/bulk derive from those suggestions (`fixRotation`, `optimize`, `convert`). | PRD-006, PRD-007 |
| TDD-032 | While any job is `queued` or `processing`, poll `GET /api/jobs` every **2 seconds** and merge progress into UI state. | PRD-013 |
| TDD-033 | Last browse path persists in `localStorage` key `vidorient.lastFolder` (sibling of `vidorient.favorites`). Launch uses that path; if browse fails, fall back to `/Volumes`. Home uses `GET /api/places` `home` (`os.homedir()`). Pinned favorites: Home + `/Volumes`. Extra favorites persist in `vidorient.favorites`. | PRD-001, PRD-028, PRD-038 |
| TDD-034 | Type and size filter/sort are **client-side** on `browseData` and scan `allFiles`. No API query params. Derive type from filename / `extension` (MOV, MP4, M4V). Browse always lists folders first, then filtered/sorted files. | PRD-018, PRD-019, PRD-020 |
| TDD-035 | Path chrome: Home + Up, full-path `<input>`, breadcrumbs. One `.scan-row` under the path: **Include subfolders** (off by default), quiet Rescan, **Actions** `.filter-menu` for the current selection, then File Type and Status `.filter-menu`s on the right. Opening a folder auto-starts `POST /api/scan/files`. Navigating away aborts the fetch and calls `POST /api/scan/cancel`. | PRD-016, PRD-024, PRD-026 |
| TDD-036 | File Type and Status filters are labeled `<select>` menus (`.filter-menu`). Type: `all` \| `mov` \| `mp4` \| `m4v`. Status: `all` \| `rotation` \| `optimize` \| `work`. Both apply to the same browse list (AND). | PRD-018, PRD-021 |
| TDD-038 | Browse file rows are selectable for processing (checkbox, row click, shift-click, header select-all). Folder rows navigate. | PRD-024 |
| TDD-039 | With Include subfolders, browse files include `relativePath` from the current folder. Name shows `relativeFolder/` muted above the filename. | PRD-025 |
| TDD-040 | Single browse card: role/convert tags and status live on video rows. Status shows Optimize & Rotate (`fixRotation: true`) when `suggestRotation`; Optimize (`optimize: true`) when `suggestOptimization` only; Optimized after convert/complete; OK when neither is needed. Restore/delete stay on the scan-row Actions menu. | PRD-026, PRD-005, PRD-024 |
| TDD-041 | Browse list prefers `groups` from `/api/browse`; fallback is `files`. An **Actions** menu on the scan row runs process / restore / restore-drop / delete-archive for selected rows (`id` or `storeDir` + `recordKey`) after `window.confirm` for restore/delete. Failed jobs show error text; retry is Actions → Process. After a job reaches `completed` or `failed`, re-fetch the current folder. | PRD-024, PRD-029, PRD-030, PRD-031, PRD-034 |
| TDD-042 | `processor.assertPlayableVideo(path, { expectedDuration })` is the proof used before archiving a MOV and before deleting an archive. | PRD-032, PRD-031 |
| TDD-044 | Each `.vidorient` record keeps `originalSize` and `convertedSize`. `markProcessed` writes both. Probing a converted file must not overwrite `originalSize`. `needsProbe` compares listing size to `convertedSize` when the path is the converted file. Archive delete leaves those sizes in place. Groups expose `originalSize` / `convertedSize` for the UI savings line. | PRD-036, PRD-027, PRD-029 |
| TDD-045 | `POST /api/rename` body `{ folder, recordKey, name, fileId?, path?, currentName?, members? }`. `name` is a base name (video extension stripped if typed). Renames converted, in-folder original, archive, and `path` / members without duplicating the same source. Thumbnails follow. Record key stays stable. Response includes `displayName`, `capturedName`, paths, and `moves`. Client patches that listing row in place and freezes row order until Rescan or a sort-header click. UI edits stem only and shows the kept extension beside the field. Refuses overwrite (`409`). | PRD-037 |

## Conventions agents must follow

- Extend existing HTTP endpoints or add new REST routes for state changes; do not use WebSockets as a state bus.
- Keep scan→process coupling explicit: process only by `fileId` from the current in-memory scan.
- Preserve `archive` exclusion in browse/scan.
- Document new API fields and queue rules in this TDD in the same change set.
