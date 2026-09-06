# VidOrient — User Requirements Document (URD)

| Field | Value |
| --- | --- |
| Status | Active |
| Related | [PRD](./PRD.md), [TDD](../TechDesign/TDD.md), [Style Guide](../app-style-guide.md) |

## Purpose

Capture user needs and goals for VidOrient in implementation-neutral language. VidOrient is a local tool for preparing home movies (especially iPhone captures) for playback on media centers such as Plex and NVIDIA Shield.

## User needs

| ID | Need | Notes |
| --- | --- | --- |
| URD-001 | Browse local folders to find home movie libraries | Operator works on machine-mounted paths (e.g. external volumes). |
| URD-002 | Discover video files in a chosen folder (optionally including subfolders) | Focus on common home-video containers. |
| URD-003 | See which videos need orientation fixes or size/format preparation | Users should not have to inspect every file manually. |
| URD-004 | Select individual videos or a recommended set for processing | Bulk work is common for large libraries. |
| URD-005 | Process selected videos so rotation is corrected in the output file | iPhone metadata rotation must not leave playback wrong on target devices. |
| URD-006 | Produce playback-friendly MP4 outputs suitable for Plex / Shield | Especially convert large MOV sources. |
| URD-007 | Keep original MOV sources available after a successful conversion | Prefer archiving originals rather than deleting them. |
| URD-008 | Observe processing progress and completion for queued work | Multiple files may run over time. |
| URD-009 | Avoid re-scanning archived originals as if they were still active library files | Archive folders should stay out of browse/scan noise. |
| URD-010 | Navigate folders the way a normal file browser works, with a visible current path that can be copied, pasted, and edited | Operator may type or paste a path rather than only clicking folders. |
| URD-011 | Locate videos by file type and size in the current folder listing and in scan results | e.g. large `.mov` files. |
| URD-012 | Isolate videos that need rotation fixing or that would benefit from optimization without scanning the whole list by eye | Identification happens after analyze; filtering uses those flags. |
| URD-013 | When requesting size optimization, get a smaller playback file than the original without a large quality drop | H.264 8-bit at a moderate CRF, not near-lossless CRF 20. |
| URD-014 | Analyze only the videos chosen in the folder listing, without scanning the rest of the folder | Useful for a handful of large MOVs. |
| URD-015 | When looking at nested videos, see which subfolder each one lives in | Recursive listings should stay spatially readable. |
| URD-016 | See analysis on the same folder listing used to browse, without a separate scan step | Opening a folder should start analysis; leaving the folder should stop it. |
| URD-017 | Jump quickly to Home, mounted volumes, and folders the operator marked as favorites | Typical libraries live under `/Volumes`; Home is the operator’s user folder. |
| URD-018 | Treat an original, its converted copy, and its archived original as one item, with sizes for each | Avoid listing the same movie as unrelated files. |
| URD-019 | Restore an archived original, optionally removing the converted copy only after the original is back | Recovery must not race with deletion. |
| URD-020 | Never destroy an original unless a converted playback file is present and proven good | Includes archive-after-process and deleting an archive later. |
| URD-022 | Open a specific original, converted, or archived file in the desktop file browser or a quick preview | From the listing, without hunting for the path by hand. |
| URD-023 | See how much smaller a converted file is than the original, and how much space that saved, even after the original is gone | Percent smaller and bytes saved should remain after archive delete. |
