import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle, Loader2, Folder, X, Home, ArrowUp, Video, ChevronUp, ChevronDown, Star, Play, Pencil } from 'lucide-react';

const API_BASE = 'http://localhost:3001/api';
const SCAN_PATH_CHUNK = 200;
const FAVORITES_KEY = 'vidorient.favorites';
const LAST_FOLDER_KEY = 'vidorient.lastFolder';
const VOLUMES_PATH = '/Volumes';
const TYPE_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'mov', label: 'MOV' },
  { id: 'mp4', label: 'MP4' },
  { id: 'm4v', label: 'M4V' }
];
const NEED_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'rotation', label: 'Needs rotation' },
  { id: 'optimize', label: 'Optimize' },
  { id: 'work', label: 'Needs work' }
];

function fileTypeFromName(name, extension) {
  const ext = (extension || (name.includes('.') ? name.slice(name.lastIndexOf('.')) : '')).replace('.', '').toLowerCase();
  if (ext === 'mov') return 'MOV';
  if (ext === 'mp4') return 'MP4';
  if (ext === 'm4v') return 'M4V';
  return ext ? ext.toUpperCase() : '—';
}

function relativeFolder(relativePath, name, absolutePath, currentFolder) {
  if (relativePath) {
    const n = String(relativePath).replace(/\\/g, '/');
    if (n && n !== name) {
      const suffix = '/' + name;
      if (n.endsWith(suffix)) return n.slice(0, -suffix.length);
      const slash = n.lastIndexOf('/');
      if (slash > 0) return n.slice(0, slash);
    }
  }
  if (absolutePath && currentFolder) {
    const parent = absolutePath.slice(0, Math.max(0, absolutePath.lastIndexOf('/')));
    const root = String(currentFolder).replace(/\/$/, '');
    if (parent !== root && parent.startsWith(root + '/')) {
      return parent.slice(root.length + 1);
    }
  }
  return '';
}

function matchesTypeFilter(typeLabel, typeFilter) {
  if (typeFilter === 'all') return true;
  return typeLabel.toLowerCase() === typeFilter;
}

function compareValues(a, b, dir) {
  if (a < b) return dir === 'asc' ? -1 : 1;
  if (a > b) return dir === 'asc' ? 1 : -1;
  return 0;
}

function sortByKey(aName, bName, aType, bType, aSize, bSize, sortKey, sortDir) {
  if (sortKey === 'type') return compareValues(aType, bType, sortDir) || compareValues(aName.toLowerCase(), bName.toLowerCase(), 'asc');
  if (sortKey === 'size') return compareValues(aSize, bSize, sortDir) || compareValues(aName.toLowerCase(), bName.toLowerCase(), 'asc');
  return compareValues(aName.toLowerCase(), bName.toLowerCase(), sortDir);
}

function breadcrumbParts(folderPath) {
  const parts = (folderPath || '').split('/').filter(Boolean);
  const crumbs = [{ label: '/', path: '/' }];
  let acc = '';
  parts.forEach((part) => {
    acc += '/' + part;
    crumbs.push({ label: part, path: acc });
  });
  return crumbs;
}

function mergeFilesByPath(current, incoming) {
  const byPath = new Map((current || []).map((file) => [file.path, file]));
  for (const file of incoming || []) {
    byPath.set(file.path, { ...byPath.get(file.path), ...file });
  }
  return [...byPath.values()];
}

function applyScanToGroups(groups, scanned) {
  const byPath = new Map((scanned || []).map((file) => [file.path, file]));
  return (groups || []).map((group) => {
    const hit = (group.members || []).map((member) => byPath.get(member.path)).find(Boolean) || byPath.get(group.path);
    if (!hit) return group;
    return {
      ...group,
      id: hit.id || group.id,
      analyzed: hit.analyzed ?? group.analyzed,
      rotation: hit.rotation ?? group.rotation,
      width: hit.width ?? group.width,
      height: hit.height ?? group.height,
      duration: hit.duration ?? group.duration,
      suggestRotation: hit.suggestRotation ?? group.suggestRotation,
      suggestOptimization: hit.suggestOptimization ?? group.suggestOptimization,
      suggestConversion: hit.suggestConversion ?? group.suggestConversion,
      hasThumbnail: hit.hasThumbnail || group.hasThumbnail,
      scanError: hit.error || group.scanError
    };
  });
}

function rowKey(file) {
  if (file.storeDir && file.recordKey) return `${file.storeDir}::${file.recordKey}`;
  if (file.key && file.path) return `${file.path}::${file.key}`;
  return file.path;
}

function thumbQueryPath(file) {
  if (file.thumbFile) return file.thumbFile;
  const converted = (file.members || []).find((m) => m.role === 'converted');
  if (converted?.path) return converted.path;
  if (file.path) return file.path;
  return file.originalPath || '';
}

function sizeLines(file) {
  const lines = [];
  if (file.originalSize) lines.push({ label: 'Orig', bytes: file.originalSize });
  if (file.convertedSize) lines.push({ label: 'Conv', bytes: file.convertedSize });
  const archive = (file.members || []).find((m) => m.role === 'archive');
  if (archive?.size) lines.push({ label: 'Arch', bytes: archive.size });
  if (!lines.length && file.size) lines.push({ label: '', bytes: file.size });
  return lines;
}

function sizeSavings(file) {
  const orig = Number(file.originalSize);
  const conv = Number(file.convertedSize);
  if (!(orig > 0) || !(conv > 0)) return null;
  const saved = orig - conv;
  const rawPct = Math.round((saved / orig) * 100);
  const pct = saved > 0 && rawPct === 0 ? '<1' : rawPct;
  return { saved, pct };
}

function scanPayload(data) {
  if (Array.isArray(data)) return { aborted: false, files: data };
  return { aborted: !!data?.aborted, files: data?.files || [] };
}

async function postPathChunks(url, paths, extra, signal) {
  const merged = [];
  for (let i = 0; i < paths.length; i += SCAN_PATH_CHUNK) {
    const chunk = paths.slice(i, i + SCAN_PATH_CHUNK);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...extra, paths: chunk }),
      signal
    });
    if (!res.ok) return { ok: false, files: merged, aborted: false };
    const payload = scanPayload(await res.json());
    merged.push(...(payload.files || []));
    if (payload.aborted) return { ok: true, files: merged, aborted: true };
  }
  return { ok: true, files: merged, aborted: false };
}

function normalizeFolderPath(p) {
  if (!p) return '';
  let n = String(p).replace(/\\/g, '/');
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  return n;
}

function folderLabel(folderPath) {
  const n = normalizeFolderPath(folderPath);
  if (n === '/' || !n) return '/';
  return n.split('/').filter(Boolean).pop() || n;
}

function loadCustomFavorites() {
  try {
    const raw = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item) => item && item.path)
      .map((item) => ({
        id: item.id || item.path,
        label: item.label || folderLabel(item.path),
        path: normalizeFolderPath(item.path)
      }));
  } catch {
    return [];
  }
}

function saveCustomFavorites(list) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
}

function loadLastFolder() {
  try {
    const n = normalizeFolderPath(localStorage.getItem(LAST_FOLDER_KEY) || '');
    return n || VOLUMES_PATH;
  } catch {
    return VOLUMES_PATH;
  }
}

function saveLastFolder(folder) {
  const n = normalizeFolderPath(folder);
  if (!n) return;
  try {
    localStorage.setItem(LAST_FOLDER_KEY, n);
  } catch {
    /* ignore quota / private mode */
  }
}

function SortHeader({ label, column, sortKey, sortDir, onSort }) {
  const active = sortKey === column;
  return (
    <button type="button" className={`sort-header ${active ? 'active' : ''}`} onClick={() => onSort(column)}>
      {label}
      {active ? (sortDir === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />) : null}
    </button>
  );
}

function FilterMenu({ label, options, value, onChange }) {
  return (
    <label className={`filter-menu ${value !== 'all' ? 'active' : ''} ${value}`}>
      <span className="filter-menu-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {options.map((opt) => (
          <option key={opt.id} value={opt.id}>{opt.label}</option>
        ))}
      </select>
    </label>
  );
}

function rowCanProcess(file, jobs) {
  if (!file.id) return false;
  const status = jobs[file.id]?.status;
  if (status === 'processing' || status === 'queued' || status === 'completed') return false;
  if (status === 'failed') return true;
  if (file.canProcess != null) return !!file.canProcess;
  return !!(file.suggestRotation || file.suggestOptimization || file.suggestConversion);
}

function listingTitle(file) {
  const converted = (file.members || []).find((m) => m.role === 'converted');
  return file.displayName || converted?.name || file.convertedName || file.originalName || file.name;
}

function nameStem(name) {
  if (!name) return '';
  const i = String(name).lastIndexOf('.');
  return i > 0 ? String(name).slice(0, i) : String(name);
}

function listingExtension(file) {
  const title = listingTitle(file);
  const fromTitle = title.includes('.') ? title.slice(title.lastIndexOf('.')) : '';
  let fromField = file.extension ? String(file.extension) : '';
  if (fromField && !fromField.startsWith('.')) fromField = `.${fromField}`;
  return (fromTitle || fromField || '').toLowerCase();
}

function basenameOf(p) {
  if (!p) return '';
  const n = String(p).replace(/\\/g, '/');
  const i = n.lastIndexOf('/');
  return i >= 0 ? n.slice(i + 1) : n;
}

function applyMovedPath(current, moves) {
  if (!current || !Array.isArray(moves)) return current;
  const hit = moves.find((mv) => mv.from === current);
  return hit ? hit.to : current;
}

function sameListingRow(entry, file) {
  if (file.storeDir && file.recordKey && entry.storeDir && entry.recordKey) {
    return file.storeDir === entry.storeDir && file.recordKey === entry.recordKey;
  }
  return rowKey(entry) === rowKey(file);
}

function applyRenameToEntry(entry, file, result) {
  if (!sameListingRow(entry, file)) return entry;
  const moves = result.moves || [];
  const members = (entry.members || []).map((m) => {
    const path = applyMovedPath(m.path, moves);
    return path === m.path ? m : { ...m, path, name: basenameOf(path) };
  });
  const converted = members.find((m) => m.role === 'converted');
  const original = members.find((m) => m.role === 'original');
  const displayName = result.displayName || converted?.name || original?.name || entry.displayName;
  return {
    ...entry,
    members,
    displayName,
    name: displayName,
    capturedName: result.capturedName || entry.capturedName,
    originalName: result.originalName || entry.originalName,
    convertedName: result.convertedName || converted?.name || entry.convertedName,
    convertedPath: applyMovedPath(entry.convertedPath, moves) || result.convertedPath || entry.convertedPath,
    originalPath: applyMovedPath(entry.originalPath, moves) || result.originalPath || entry.originalPath,
    archivePath: applyMovedPath(entry.archivePath, moves) || result.archivePath || entry.archivePath,
    path: applyMovedPath(entry.path, moves)
  };
}

function FileRenameField({ value, extension, onChange, onSubmit, onCancel }) {
  const inputRef = useRef(null);
  const skipBlurRef = useRef(false);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  return (
    <span
      className="name-line name-rename-wrap"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        className="name-rename-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit(e.currentTarget.value);
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            skipBlurRef.current = true;
            onCancel();
          }
        }}
        onBlur={(e) => {
          if (skipBlurRef.current) return;
          onSubmit(e.currentTarget.value);
        }}
        aria-label="New file name"
      />
      {extension ? (
        <span className="name-rename-ext" title="The file extension is kept">
          {extension}
        </span>
      ) : null}
    </span>
  );
}

function hasConvertedCopy(file) {
  return !!(file.convertedPresent || file.convertedPath || (file.members || []).some((m) => m.role === 'converted' && m.path));
}

function hasArchiveCopy(file) {
  return !!(file.canRestore || file.archivePath || (file.members || []).some((m) => m.role === 'archive' && m.path));
}

function memberPath(file, role) {
  const hit = (file.members || []).find((m) => m.role === role);
  if (hit?.path) return hit.path;
  if (role === 'converted') return file.convertedPath || null;
  if (role === 'archive') return file.archivePath || null;
  if (role === 'original') return file.originalPath || file.path || null;
  return null;
}

function FileRoleTag({ label, className, filePath, menuId, openMenuId, setOpenMenuId, onOpen }) {
  const [menuPos, setMenuPos] = useState(null);
  if (!filePath) return null;
  const open = openMenuId === menuId;

  const pick = (event, action) => {
    event.preventDefault();
    event.stopPropagation();
    onOpen(filePath, action);
    setOpenMenuId(null);
  };

  return (
    <span className="file-role-wrap">
      <button
        type="button"
        className={`tag ${className} file-role-tag`}
        onClick={(e) => {
          e.stopPropagation();
          if (open) {
            setOpenMenuId(null);
            return;
          }
          const rect = e.currentTarget.getBoundingClientRect();
          setMenuPos({ top: rect.bottom + 4, left: rect.left });
          setOpenMenuId(menuId);
        }}
      >
        {label}
      </button>
      {open && menuPos && createPortal(
        <span
          className="file-open-menu"
          role="menu"
          style={{ top: menuPos.top, left: menuPos.left }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button type="button" role="menuitem" onPointerDown={(e) => pick(e, 'reveal')}>
            Show in Finder
          </button>
          <button type="button" role="menuitem" onPointerDown={(e) => pick(e, 'preview')}>
            Open in Preview
          </button>
        </span>,
        document.body
      )}
    </span>
  );
}

function ActionMenu({ disabled, options, onAction }) {
  return (
    <label className={`filter-menu actions-menu ${disabled ? 'disabled' : ''}`}>
      <span className="filter-menu-label">Actions</span>
      <select
        value=""
        disabled={disabled}
        onChange={(e) => {
          const value = e.target.value;
          e.target.selectedIndex = 0;
          if (value) onAction(value);
        }}
        aria-label="Actions"
      >
        <option value="">{disabled ? 'Select files' : 'Choose…'}</option>
        {options.map((opt) => (
          <option key={opt.id} value={opt.id} disabled={opt.disabled}>{opt.label}</option>
        ))}
      </select>
    </label>
  );
}

function App() {
  const [folderPath, setFolderPath] = useState(loadLastFolder);
  const [recursiveScan, setRecursiveScan] = useState(false);
  const [jobs, setJobs] = useState({});
  const [browseData, setBrowseData] = useState({ subdirs: [], files: [], groups: [] });
  const [browsingLoading, setBrowsingLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [browseSelected, setBrowseSelected] = useState(new Set());
  const lastBrowseClickRef = useRef(null);
  const [browseTypeFilter, setBrowseTypeFilter] = useState('all');
  const [browseNeedFilter, setBrowseNeedFilter] = useState('all');
  const [browseSort, setBrowseSort] = useState({ key: 'name', dir: 'asc' });
  const [places, setPlaces] = useState({ home: '', volumes: VOLUMES_PATH });
  const [customFavorites, setCustomFavorites] = useState(loadCustomFavorites);
  const [failedThumbs, setFailedThumbs] = useState(() => new Set());
  const [fileRoleMenuId, setFileRoleMenuId] = useState(null);
  const [renamingKey, setRenamingKey] = useState(null);
  const [listOrderKeys, setListOrderKeys] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const renameBusyRef = useRef(false);
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const openSeqRef = useRef(0);

  const favorites = useMemo(() => {
    const pinned = [];
    if (places.home) {
      pinned.push({ id: 'home', label: 'Home', path: normalizeFolderPath(places.home), pinned: true });
    }
    pinned.push({ id: 'volumes', label: 'Volumes', path: VOLUMES_PATH, pinned: true });
    const pinnedPaths = new Set(pinned.map((item) => item.path));
    const extras = customFavorites.filter((item) => !pinnedPaths.has(item.path)).map((item) => ({ ...item, pinned: false }));
    return [...pinned, ...extras];
  }, [places, customFavorites]);

  const currentFolder = normalizeFolderPath(folderPath);
  const activeFavorite = favorites.find((item) => item.path === currentFolder);
  const isFavorite = !!activeFavorite;
  const isPinnedFavorite = !!activeFavorite?.pinned;

  const cancelOpenFolder = useCallback(() => {
    openSeqRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    fetch(`${API_BASE}/scan/cancel`, { method: 'POST' }).catch(() => {});
    setScanning(false);
  }, []);

  const openFolder = useCallback(async (path, { force = false } = {}) => {
    if (!path) {
      setBrowseData({ subdirs: [], files: [], groups: [] });
      return;
    }
    cancelOpenFolder();
    setListOrderKeys(null);
    const seq = openSeqRef.current;
    const ac = new AbortController();
    abortRef.current = ac;
    setBrowsingLoading(true);
    setBrowseSelected(new Set());
    setFailedThumbs(new Set());
    lastBrowseClickRef.current = null;

    try {
      const browseRes = await fetch(
        `${API_BASE}/browse?folder=${encodeURIComponent(path)}&recursive=${recursiveScan}`,
        { signal: ac.signal }
      );
      if (seq !== openSeqRef.current) return;
      if (!browseRes.ok) {
        setBrowseData({ subdirs: [], files: [], groups: [] });
        if (normalizeFolderPath(path) !== VOLUMES_PATH) {
          setFolderPath(VOLUMES_PATH);
          openFolder(VOLUMES_PATH);
        }
        return;
      }
      const data = await browseRes.json();
      if (seq !== openSeqRef.current) return;
      const resolved = normalizeFolderPath(data.current || path);
      setFolderPath(resolved);
      saveLastFolder(resolved);
      setBrowseData({ subdirs: data.subdirs || [], files: data.files || [], groups: data.groups || [] });
      setBrowsingLoading(false);

      const paths = (data.files || [])
        .filter((file) => force || !file.analyzed)
        .map((file) => file.path);
      if (paths.length < 1) {
        setScanning(false);
        return;
      }

      setScanning(true);
      const scan = await postPathChunks(
        `${API_BASE}/scan/files`,
        paths,
        { rootFolder: path, force },
        ac.signal
      );
      if (seq !== openSeqRef.current) return;
      if (!scan.ok || scan.aborted) return;
      setBrowseData((prev) => ({
        ...prev,
        files: mergeFilesByPath(prev.files, scan.files),
        groups: applyScanToGroups(prev.groups, scan.files)
      }));
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('Browse/scan error:', err);
      if (seq === openSeqRef.current) setBrowseData({ subdirs: [], files: [], groups: [] });
    } finally {
      if (seq === openSeqRef.current) {
        setBrowsingLoading(false);
        setScanning(false);
      }
    }
  }, [cancelOpenFolder, recursiveScan]);

  useEffect(() => {
    fetch(`${API_BASE}/places`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.home || data?.volumes) {
          setPlaces({ home: data.home || '', volumes: data.volumes || VOLUMES_PATH });
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    openFolder(folderPath);
    return () => cancelOpenFolder();
  }, [recursiveScan]);

  useEffect(() => {
    const activeJobs = Object.values(jobs).some((j) => j.status === 'processing' || j.status === 'queued');
    if (!activeJobs) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/jobs`);
        const data = await res.json();
        const newJobs = {};
        data.forEach((job) => {
          newJobs[job.id] = job;
        });
        setJobs((prev) => ({ ...prev, ...newJobs }));
      } catch (err) {
        console.error('Failed to poll jobs:', err);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [jobs]);

  const seenTerminalJobsRef = useRef(new Set());
  useEffect(() => {
    let refresh = false;
    for (const job of Object.values(jobs)) {
      if ((job.status === 'completed' || job.status === 'failed') && !seenTerminalJobsRef.current.has(job.id)) {
        seenTerminalJobsRef.current.add(job.id);
        refresh = true;
      }
    }
    if (refresh && folderPath) openFolder(folderPath);
  }, [jobs, folderPath, openFolder]);

  const missingThumbKey = [
    ...browseData.files.filter((file) => !file.hasThumbnail).map((file) => file.path),
    ...(browseData.groups || []).filter((group) => !group.hasThumbnail).map((group) => thumbQueryPath(group))
  ].join('|');
  useEffect(() => {
    if (!missingThumbKey) return;
    const paths = missingThumbKey.split('|').filter(Boolean);
    const interval = setInterval(async () => {
      try {
        const data = {};
        for (let i = 0; i < paths.length; i += SCAN_PATH_CHUNK) {
          const chunk = paths.slice(i, i + SCAN_PATH_CHUNK);
          const res = await fetch(`${API_BASE}/thumbs/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: chunk })
          });
          if (!res.ok) return;
          Object.assign(data, await res.json());
        }
        setFailedThumbs((prev) => {
          let changed = false;
          const next = new Set(prev);
          for (const [videoPath, info] of Object.entries(data)) {
            if (info?.ready && next.has(videoPath)) {
              next.delete(videoPath);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        setBrowseData((prev) => ({
          ...prev,
          files: prev.files.map((file) => (
            data[file.path]?.ready
              ? { ...file, hasThumbnail: true, thumbnailUrl: data[file.path].url, thumbFile: file.path }
              : file
          )),
          groups: (prev.groups || []).map((group) => {
            const candidates = [
              group.thumbFile,
              group.path,
              ...(group.members || []).map((member) => member.path),
              group.convertedPath,
              group.originalPath
            ].filter(Boolean);
            const readyPath = candidates.find((candidate) => data[candidate]?.ready);
            return readyPath ? { ...group, hasThumbnail: true, thumbFile: readyPath } : group;
          })
        }));
      } catch (err) {
        console.error('Thumb status error:', err);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [missingThumbKey]);

  useEffect(() => {
    if (!fileRoleMenuId) return;
    const close = (event) => {
      if (event.target.closest?.('.file-role-wrap')) return;
      setFileRoleMenuId(null);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [fileRoleMenuId]);

  const openLocalFile = async (filePath, action) => {
    try {
      const res = await fetch(`${API_BASE}/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: filePath, action })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not open file');
    } catch (err) {
      alert(err.message);
    }
  };

  const startProcess = async (fileId, options) => {
    try {
      const res = await fetch(`${API_BASE}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, options })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start processing');
      setJobs((prev) => ({ ...prev, [fileId]: data }));
    } catch (err) {
      alert('Failed to start processing: ' + err.message);
    }
  };

  const browseRows = useMemo(() => {
    const folders = [...browseData.subdirs].sort((a, b) =>
      sortByKey(a.name, b.name, 'Folder', 'Folder', 0, 0, browseSort.key === 'size' ? 'name' : browseSort.key, browseSort.key === 'size' ? 'asc' : browseSort.dir)
    );
    const listedFiles = (browseData.groups && browseData.groups.length ? browseData.groups : browseData.files)
      .map((file) => ({
        ...file,
        typeLabel: fileTypeFromName(listingTitle(file), file.extension),
        relativeFolder: relativeFolder(file.relativePath || file.originalName, listingTitle(file), file.path, folderPath)
      }))
      .filter((file) => {
        if (!matchesTypeFilter(file.typeLabel, browseTypeFilter)) return false;
        if (browseNeedFilter === 'rotation') return !!file.suggestRotation;
        if (browseNeedFilter === 'optimize') return !!file.suggestOptimization;
        if (browseNeedFilter === 'work') return !!(file.suggestRotation || file.suggestOptimization);
        return true;
      })
      .sort((a, b) => {
        if (listOrderKeys) {
          const rank = new Map(listOrderKeys.map((k, i) => [k, i]));
          const ia = rank.has(rowKey(a)) ? rank.get(rowKey(a)) : Number.MAX_SAFE_INTEGER;
          const ib = rank.has(rowKey(b)) ? rank.get(rowKey(b)) : Number.MAX_SAFE_INTEGER;
          if (ia !== ib) return ia - ib;
        }
        if (browseSort.key === 'name') {
          return compareValues(
            `${a.relativeFolder}/${listingTitle(a)}`.toLowerCase(),
            `${b.relativeFolder}/${listingTitle(b)}`.toLowerCase(),
            browseSort.dir
          );
        }
        return sortByKey(listingTitle(a), listingTitle(b), a.typeLabel, b.typeLabel, a.size || 0, b.size || 0, browseSort.key, browseSort.dir);
      });
    return { folders, files: listedFiles };
  }, [browseData, browseTypeFilter, browseNeedFilter, browseSort, folderPath, listOrderKeys]);

  const allBrowseFilesSelected = browseRows.files.length > 0 && browseRows.files.every((f) => browseSelected.has(rowKey(f)));

  const toggleBrowseAllFiles = () => {
    if (allBrowseFilesSelected) {
      setBrowseSelected(new Set());
      lastBrowseClickRef.current = null;
      return;
    }
    setBrowseSelected(new Set(browseRows.files.map((f) => rowKey(f))));
  };

  const toggleBrowseFile = (file, shiftKey) => {
    const listed = browseRows.files.map((f) => rowKey(f));
    const filePath = rowKey(file);
    const idx = listed.indexOf(filePath);
    setBrowseSelected((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastBrowseClickRef.current != null) {
        const from = Math.min(lastBrowseClickRef.current, idx);
        const to = Math.max(lastBrowseClickRef.current, idx);
        for (let i = from; i <= to; i++) next.add(listed[i]);
      } else if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
    lastBrowseClickRef.current = idx;
  };

  const selectedRows = browseRows.files.filter((f) => browseSelected.has(rowKey(f)));

  const postJson = async (url, body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  };

  const runSelectedAction = async (action) => {
    if (action === 'process') {
      for (const file of selectedRows) {
        if (!rowCanProcess(file, jobs)) continue;
        startProcess(file.id, {
          fixRotation: file.suggestRotation,
          optimize: file.suggestOptimization,
          convert: file.suggestConversion
        });
      }
      return;
    }

    const restoreTargets = selectedRows.filter((f) => f.canRestore && f.storeDir && f.recordKey);
    const deleteTargets = selectedRows.filter((f) => f.canDeleteArchive && f.storeDir && f.recordKey);

    if (action === 'restore' || action === 'restore-drop') {
      if (!restoreTargets.length) return;
      const drop = action === 'restore-drop';
      const ok = window.confirm(
        drop
          ? `Restore ${restoreTargets.length} archived original${restoreTargets.length === 1 ? '' : 's'}, then delete each converted file?\n\nEach original is moved back first. Converted files are deleted only after that succeeds.`
          : `Restore ${restoreTargets.length} archived original${restoreTargets.length === 1 ? '' : 's'}?\n\nConverted files will be kept.`
      );
      if (!ok) return;
      const errors = [];
      for (const group of restoreTargets) {
        try {
          await postJson(`${API_BASE}/restore`, {
            folder: group.storeDir,
            recordKey: group.recordKey,
            deleteConverted: drop
          });
        } catch (err) {
          errors.push(`${group.originalName || group.name}: ${err.message}`);
        }
      }
      openFolder(folderPath);
      if (errors.length) alert(errors.join('\n'));
      return;
    }

    if (action === 'delete-archive') {
      if (!deleteTargets.length) return;
      const ok = window.confirm(
        `Permanently delete ${deleteTargets.length} archived original${deleteTargets.length === 1 ? '' : 's'}?\n\nThis happens only if a converted file is present and checks out as a real video. This cannot be undone.`
      );
      if (!ok) return;
      const errors = [];
      for (const group of deleteTargets) {
        try {
          await postJson(`${API_BASE}/archive/delete`, {
            folder: group.storeDir,
            recordKey: group.recordKey
          });
        } catch (err) {
          errors.push(`${group.originalName || group.name}: ${err.message}`);
        }
      }
      openFolder(folderPath);
      if (errors.length) alert(errors.join('\n'));
    }
  };

  const beginRename = (file, key) => {
    setRenamingKey(key);
    setRenameValue(nameStem(listingTitle(file)));
  };

  const submitRename = async (file, typed) => {
    if (renameBusyRef.current) return;
    const next = String(typed ?? renameValue).trim();
    const current = nameStem(listingTitle(file));
    setRenamingKey(null);
    if (!next || next === current) return;
    const folder = file.storeDir || (file.path ? file.path.slice(0, file.path.lastIndexOf('/')) : folderPath);
    const recordKey = file.recordKey || file.originalName || file.name;
    renameBusyRef.current = true;
    try {
      const result = await postJson(`${API_BASE}/rename`, {
        folder,
        recordKey,
        name: next,
        fileId: file.id,
        currentName: file.originalName || file.name,
        path: file.convertedPath || file.path,
        members: file.members || []
      });
      setListOrderKeys((prev) => prev || browseRows.files.map((row) => rowKey(row)));
      setBrowseData((prev) => ({
        ...prev,
        groups: (prev.groups || []).map((entry) => applyRenameToEntry(entry, file, result)),
        files: (prev.files || []).map((entry) => applyRenameToEntry(entry, file, result))
      }));
    } catch (err) {
      alert(err.message);
    } finally {
      renameBusyRef.current = false;
    }
  };

  const formatSize = (bytes) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const navigateTo = (newPath) => {
    setFolderPath(newPath);
    openFolder(newPath);
  };

  const toggleFavorite = () => {
    if (!currentFolder || isPinnedFavorite) return;
    if (isFavorite) {
      const next = customFavorites.filter((item) => item.path !== currentFolder);
      setCustomFavorites(next);
      saveCustomFavorites(next);
      return;
    }
    const next = [
      ...customFavorites,
      { id: currentFolder, label: folderLabel(folderPath), path: currentFolder }
    ];
    setCustomFavorites(next);
    saveCustomFavorites(next);
  };

  const jumpToFavorite = (id) => {
    const match = favorites.find((item) => item.id === id);
    if (match) navigateTo(match.path);
  };

  const goUp = () => {
    const parts = folderPath.split('/').filter(Boolean);
    if (parts.length > 0) {
      parts.pop();
      navigateTo('/' + parts.join('/'));
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      openFolder(folderPath);
    }
  };

  const handleClear = () => {
    cancelOpenFolder();
    setFolderPath('');
    setBrowseData({ subdirs: [], files: [], groups: [] });
    setBrowseSelected(new Set());
    setFileRoleMenuId(null);
    lastBrowseClickRef.current = null;
    if (inputRef.current) inputRef.current.focus();
  };

  const cycleSort = (current, column) => {
    if (current.key === column) {
      return { key: column, dir: current.dir === 'asc' ? 'desc' : 'asc' };
    }
    return { key: column, dir: column === 'size' ? 'desc' : 'asc' };
  };

  const selectedProcessable = selectedRows.filter((f) => rowCanProcess(f, jobs)).length;
  const selectedRestorable = selectedRows.filter((f) => f.canRestore).length;
  const selectedDeletableArchive = selectedRows.filter((f) => f.canDeleteArchive).length;
  const crumbs = breadcrumbParts(folderPath);

  return (
    <div className="dashboard-container">
      <header>
        <div className="title-row">
          <h1>VidOrient</h1>
          <div className="header-badges">
            <span className="badge-modern">Plex / Shield Optimized</span>
          </div>
          <p className="subtitle">Automatic iPhone video rotation & high-quality compression</p>
        </div>
      </header>

      <div className="card navigation-card">
        <div className="nav-header">
          <div className="path-toolbar">
            <div className="nav-controls-main">
              <button
                className="nav-circle-btn"
                onClick={() => navigateTo(places.home || '/')}
                title="Home folder"
              >
                <Home size={20} />
              </button>
              <button className="nav-circle-btn" onClick={goUp} disabled={folderPath === '/' || !folderPath} title="Up">
                <ArrowUp size={20} />
              </button>
              <button
                className={`nav-circle-btn ${isFavorite ? 'favorited' : ''}`}
                onClick={toggleFavorite}
                disabled={!folderPath || isPinnedFavorite}
                title={isPinnedFavorite ? 'Home and Volumes stay in Favorites' : (isFavorite ? 'Remove from Favorites' : 'Add to Favorites')}
              >
                <Star size={20} fill={isFavorite ? '#f59e0b' : 'none'} color={isFavorite ? '#f59e0b' : 'currentColor'} />
              </button>
            </div>
            <div className="path-input-container">
              <input
                ref={inputRef}
                type="text"
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={(e) => e.target.select()}
                placeholder="/Volumes/path/to/movies"
                spellCheck={false}
                autoComplete="off"
              />
              {folderPath && <button className="clear-btn-inline" onClick={handleClear} title="Clear path"><X size={18} /></button>}
            </div>
            <label className="filter-menu favorites-menu">
              <span className="filter-menu-label">Favorites</span>
              <select
                value={activeFavorite?.id || ''}
                onChange={(e) => jumpToFavorite(e.target.value)}
                aria-label="Favorites"
              >
                {!activeFavorite && <option value="">Jump to folder</option>}
                {favorites.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </label>
          </div>

          {folderPath && (
            <nav className="breadcrumbs" aria-label="Current path">
              {crumbs.map((crumb, i) => (
                <span key={crumb.path} className="breadcrumb-item">
                  {i > 1 && <span className="breadcrumb-sep">/</span>}
                  <button type="button" className="breadcrumb-link" onClick={() => navigateTo(crumb.path)}>{crumb.label}</button>
                </span>
              ))}
            </nav>
          )}

          <div className="scan-row">
            <div className="scan-options">
              <label className="recursive-checkbox-label">
                <input
                  type="checkbox"
                  checked={recursiveScan}
                  onChange={(e) => setRecursiveScan(e.target.checked)}
                  className="recursive-checkbox"
                />
                <span>Include subfolders</span>
              </label>
              <button
                className="secondary small"
                onClick={() => openFolder(folderPath, { force: true })}
                disabled={scanning || !folderPath}
                title="Re-probe every listed video even if it has not changed"
              >
                Rescan
              </button>
              <ActionMenu
                disabled={selectedRows.length === 0}
                onAction={runSelectedAction}
                options={[
                  { id: 'process', label: selectedProcessable ? `Process (${selectedProcessable})` : 'Process', disabled: selectedProcessable === 0 },
                  { id: 'restore', label: selectedRestorable ? `Restore (${selectedRestorable})` : 'Restore', disabled: selectedRestorable === 0 },
                  { id: 'restore-drop', label: selectedRestorable ? `Restore, drop converted (${selectedRestorable})` : 'Restore, drop converted', disabled: selectedRestorable === 0 },
                  { id: 'delete-archive', label: selectedDeletableArchive ? `Delete archive (${selectedDeletableArchive})` : 'Delete archive', disabled: selectedDeletableArchive === 0 }
                ]}
              />
              {scanning && (
                <span className="scan-status">
                  <Loader2 className="animate-spin" size={16} /> Analyzing videos…
                </span>
              )}
            </div>
            <div className="scan-row-filters">
              <FilterMenu label="File Type" options={TYPE_FILTERS} value={browseTypeFilter} onChange={setBrowseTypeFilter} />
              <FilterMenu label="Status" options={NEED_FILTERS} value={browseNeedFilter} onChange={setBrowseNeedFilter} />
            </div>
          </div>
        </div>

        <div className="browser-content">
          <div className="list-header browse-list-header">
            <span className="col-check">
              {browseRows.files.length > 0 && (
                <input
                  type="checkbox"
                  className="header-checkbox"
                  checked={allBrowseFilesSelected}
                  onChange={toggleBrowseAllFiles}
                  title="Select all videos in this listing"
                />
              )}
            </span>
            <span className="col-icon" />
            <SortHeader label="Name" column="name" sortKey={browseSort.key} sortDir={browseSort.dir} onSort={(col) => { setListOrderKeys(null); setBrowseSort((s) => cycleSort(s, col)); }} />
            <SortHeader label="Type" column="type" sortKey={browseSort.key} sortDir={browseSort.dir} onSort={(col) => { setListOrderKeys(null); setBrowseSort((s) => cycleSort(s, col)); }} />
            <SortHeader label="Size" column="size" sortKey={browseSort.key} sortDir={browseSort.dir} onSort={(col) => { setListOrderKeys(null); setBrowseSort((s) => cycleSort(s, col)); }} />
            <span className="col-actions-label">Status</span>
          </div>
          <div className="browser-scroll">
            {browsingLoading ? (
              <div className="loading-state"><Loader2 className="animate-spin" /> Loading contents...</div>
            ) : (folderPath && (browseRows.folders.length > 0 || browseRows.files.length > 0)) ? (
              <div className="browser-list">
                {browseRows.folders.map((dir) => (
                  <button key={dir.path} className="list-row dir" onClick={() => navigateTo(dir.path)}>
                    <span className="col-check" />
                    <span className="col-thumb"><Folder size={18} fill="#3b82f6" stroke="#3b82f6" /></span>
                    <span className="name">{dir.name}</span>
                    <span className="type-cell">Folder</span>
                    <span className="size-cell">—</span>
                    <span className="row-actions" />
                  </button>
                ))}
                {browseRows.files.map((file) => {
                  const key = rowKey(file);
                  const job = file.id ? jobs[file.id] : null;
                  const isProcessing = job?.status === 'processing';
                  const isQueued = job?.status === 'queued';
                  const isCompleted = job?.status === 'completed' || file.processStatus === 'completed';
                  const isFailed = job?.status === 'failed';
                  const analyzed = file.analyzed || file.scanned || !!(file.width && file.height);
                  const wasOptimized = isCompleted || hasConvertedCopy(file);
                  const needsRotate = analyzed && !!file.suggestRotation && !wasOptimized && !!file.id;
                  const needsOptimize = analyzed && !!file.suggestOptimization && !wasOptimized && !!file.id;
                  const sizes = sizeLines(file);
                  const savings = sizeSavings(file);
                  return (
                    <div
                      key={key}
                      className={`list-row file ${browseSelected.has(key) ? 'selected' : ''}`}
                      onClick={(e) => toggleBrowseFile(file, e.shiftKey)}
                    >
                      <span className="col-check" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={browseSelected.has(key)}
                          onChange={(e) => toggleBrowseFile(file, e.nativeEvent.shiftKey)}
                        />
                      </span>
                    <span className="col-thumb">
                      {file.hasThumbnail && !failedThumbs.has(thumbQueryPath(file)) ? (
                        <img
                          className="list-thumb"
                          src={`${API_BASE}/thumbnail?file=${encodeURIComponent(thumbQueryPath(file))}`}
                          alt=""
                          onError={() => {
                            const thumbPath = thumbQueryPath(file);
                            setFailedThumbs((prev) => {
                              if (prev.has(thumbPath)) return prev;
                              const next = new Set(prev);
                              next.add(thumbPath);
                              return next;
                            });
                          }}
                        />
                      ) : (
                        <span className="list-thumb placeholder"><Video size={18} color="#94a3b8" /></span>
                      )}
                    </span>
                      <span className="name">
                        {file.relativeFolder ? <span className="file-relpath">{file.relativeFolder}/</span> : null}
                        {renamingKey === key ? (
                          <FileRenameField
                            value={renameValue}
                            extension={listingExtension(file)}
                            onChange={setRenameValue}
                            onSubmit={(typed) => submitRename(file, typed)}
                            onCancel={() => setRenamingKey(null)}
                          />
                        ) : (
                          <span className="name-line">
                            <span className="name-file">{listingTitle(file)}</span>
                            <button
                              type="button"
                              className="name-rename"
                              aria-label="Rename"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                beginRename(file, key);
                              }}
                            >
                              <Pencil size={14} />
                            </button>
                          </span>
                        )}
                        {file.capturedName && nameStem(file.capturedName) !== nameStem(listingTitle(file)) ? (
                          <span className="name-captured">Original: {file.capturedName}</span>
                        ) : null}
                        <span className="file-meta-inline">
                          {file.width && file.height ? <span>{file.width}×{file.height}</span> : null}
                          {file.suggestConversion && !file.suggestOptimization && !file.convertedPresent && <span className="tag tag-convert">Convert to MP4</span>}
                          {hasConvertedCopy(file) && (
                            <FileRoleTag
                              label="Converted"
                              className="tag-convert"
                              filePath={memberPath(file, 'converted')}
                              menuId={`${key}-converted`}
                              openMenuId={fileRoleMenuId}
                              setOpenMenuId={setFileRoleMenuId}
                              onOpen={openLocalFile}
                            />
                          )}
                          {hasArchiveCopy(file) && (
                            <FileRoleTag
                              label="Archived"
                              className="tag-optimize"
                              filePath={memberPath(file, 'archive')}
                              menuId={`${key}-archive`}
                              openMenuId={fileRoleMenuId}
                              setOpenMenuId={setFileRoleMenuId}
                              onOpen={openLocalFile}
                            />
                          )}
                          {!hasConvertedCopy(file) && !hasArchiveCopy(file) && (
                            <FileRoleTag
                              label="Original"
                              className="tag-original"
                              filePath={memberPath(file, 'original')}
                              menuId={`${key}-original`}
                              openMenuId={fileRoleMenuId}
                              setOpenMenuId={setFileRoleMenuId}
                              onOpen={openLocalFile}
                            />
                          )}
                        </span>
                        {isProcessing && (
                          <span className="progress-container">
                            <span className="progress-fill" style={{ width: `${job.progress}%` }} />
                          </span>
                        )}
                        {isFailed && job?.error && <span className="job-error">{job.error}</span>}
                        {job?.warning && <span className="job-warning">{job.warning}</span>}
                      </span>
                      <span className="type-cell">{file.typeLabel}</span>
                      <span className="size-cell">
                        {sizes.length ? (
                          <span className="size-stack">
                            {sizes.map((line) => (
                              <span key={line.label || 'size'}>
                                {line.label ? <span className="size-role">{line.label}</span> : null}
                                {formatSize(line.bytes)}
                              </span>
                            ))}
                            {savings ? (
                              <span className={savings.saved > 0 ? 'size-saved' : 'size-saved size-saved-none'}>
                                {savings.saved > 0
                                  ? `−${savings.pct}% · ${formatSize(savings.saved)}`
                                  : 'No size saved'}
                              </span>
                            ) : null}
                          </span>
                        ) : '—'}
                      </span>
                      <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                        {isFailed ? (
                          <span className="status-failed">Failed</span>
                        ) : isProcessing ? (
                          <span className="status-working"><Loader2 className="animate-spin" size={16} /> {job.progress}%</span>
                        ) : isQueued ? (
                          <span className="status-working"><Loader2 className="animate-spin" size={16} /> Queued</span>
                        ) : !analyzed && scanning ? (
                          <span className="status-working"><Loader2 className="animate-spin" size={16} /></span>
                        ) : needsRotate ? (
                          <button
                            type="button"
                            className="btn-primary-glow small"
                            onClick={() => startProcess(file.id, {
                              fixRotation: true,
                              optimize: !!file.suggestOptimization,
                              convert: !!file.suggestConversion
                            })}
                          >
                            <Play size={12} fill="white" /> Optimize &amp; Rotate
                          </button>
                        ) : needsOptimize ? (
                          <button
                            type="button"
                            className="btn-primary-glow small"
                            onClick={() => startProcess(file.id, {
                              fixRotation: !!file.suggestRotation,
                              optimize: true,
                              convert: !!file.suggestConversion
                            })}
                          >
                            <Play size={12} fill="white" /> Optimize
                          </button>
                        ) : wasOptimized ? (
                          <span className="status-complete"><CheckCircle size={16} /> Optimized</span>
                        ) : analyzed ? (
                          <span className="status-perfect"><CheckCircle size={14} /> OK</span>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : folderPath ? (
              <div className="empty-state">No folders or videos found here</div>
            ) : (
              <div className="empty-state">Enter a path or start at <button className="link-btn" onClick={() => navigateTo('/Volumes')}>/Volumes</button></div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
