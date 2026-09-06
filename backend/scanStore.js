const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const SCAN_DOTFILE = '.vidorient.json';
const VIDORIENT_DIR = '.vidorient';
const METADATA_FILE = 'metadata.json';
const THUMBS_SUBDIR = 'thumbs';

function emptyStore() {
  return { version: 2, updatedAt: new Date().toISOString(), records: {} };
}

function vidorientDir(dir) {
  return path.join(dir, VIDORIENT_DIR);
}

function metadataPath(dir) {
  return path.join(dir, VIDORIENT_DIR, METADATA_FILE);
}

function thumbnailRel(name) {
  return path.join(THUMBS_SUBDIR, `${name}.jpg`);
}

function thumbnailAbs(dir, name) {
  return path.join(dir, VIDORIENT_DIR, THUMBS_SUBDIR, `${name}.jpg`);
}

function thumbnailUrlPath(videoPath) {
  return `/thumbnail?file=${encodeURIComponent(videoPath)}`;
}

function stem(name) {
  if (!name) return '';
  const i = name.lastIndexOf('.');
  return (i > 0 ? name.slice(0, i) : name).toLowerCase();
}

function groupStem(name) {
  let s = stem(name);
  if (s.endsWith('.fixed')) s = s.slice(0, -6);
  return s;
}

function findRecordKey(store, file) {
  const records = store.records || {};
  const name = file.name;
  const p = file.path;
  if (name && records[name]) return name;
  for (const [key, rec] of Object.entries(records)) {
    if (rec.originalPath === p || rec.convertedPath === p || rec.archivePath === p) return key;
    if (rec.originalName === name || rec.convertedName === name || rec.capturedName === name || rec.displayName === name) return key;
    if (stem(rec.originalName) === stem(name) || stem(rec.convertedName) === stem(name) || stem(rec.capturedName) === stem(name) || stem(rec.displayName) === stem(name)) return key;
  }
  return null;
}

async function fileExists(p) {
  if (!p) return false;
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readScanStore(dir) {
  const filePath = metadataPath(dir);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.records || typeof parsed.records !== 'object') return emptyStore();
    return parsed;
  } catch {
    try {
      const legacy = await fs.readFile(path.join(dir, SCAN_DOTFILE), 'utf8');
      const parsed = JSON.parse(legacy);
      if (!parsed.records || typeof parsed.records !== 'object') return emptyStore();
      await writeScanStore(dir, parsed);
      return parsed;
    } catch {
      return emptyStore();
    }
  }
}

const writeLocks = new Map();

async function withStoreLock(dir, fn) {
  const prev = writeLocks.get(dir) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  writeLocks.set(dir, prev.then(() => gate, () => gate));
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (writeLocks.get(dir) === gate) writeLocks.delete(dir);
  }
}

async function writeScanStore(dir, store) {
  store.updatedAt = new Date().toISOString();
  store.version = 2;
  await fs.mkdir(vidorientDir(dir), { recursive: true });
  const filePath = metadataPath(dir);
  const tmp = filePath + '.tmp';
  await withStoreLock(dir, async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
        await fs.rename(tmp, filePath);
        return;
      } catch (err) {
        if ((err.code !== 'EBUSY' && err.code !== 'EAGAIN') || attempt === 7) throw err;
        await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }
  });
}

function recordFromProbe(file) {
  const existingId = file.id;
  return {
    id: existingId || crypto.randomUUID(),
    name: file.name,
    capturedName: file.capturedName || file.name,
    displayName: file.displayName || file.name,
    originalName: file.name,
    originalPath: file.path,
    originalSize: file.size,
    originalExtension: file.extension,
    sourceMtimeMs: file.mtimeMs ?? file.sourceMtimeMs ?? null,
    convertedName: null,
    convertedPath: null,
    convertedSize: null,
    archivePath: null,
    lastScannedAt: new Date().toISOString(),
    rotation: file.rotation ?? 0,
    width: file.width ?? null,
    height: file.height ?? null,
    duration: file.duration ?? null,
    codec: file.codec ?? null,
    suggestRotation: !!file.suggestRotation,
    suggestOptimization: !!file.suggestOptimization,
    suggestConversion: !!file.suggestConversion,
    scanError: file.error || null,
    processStatus: file.status === 'error' ? 'error' : 'idle'
  };
}

function upsertProbedFiles(store, probedFiles) {
  for (const file of probedFiles) {
    const key = findExactRecordKey(store, file) || file.name;
    const prev = store.records[key] || {};
    const probingConverted = prev.convertedPath === file.path || prev.convertedName === file.name;
    if (probingConverted) {
      store.records[key] = {
        ...prev,
        capturedName: prev.capturedName || prev.originalName || file.name,
        convertedPath: file.path,
        convertedName: file.name,
        convertedSize: file.size ?? prev.convertedSize,
        lastScannedAt: new Date().toISOString()
      };
      continue;
    }
    const next = recordFromProbe({ ...file, id: prev.id || file.id });
    store.records[key] = {
      ...prev,
      ...next,
      capturedName: prev.capturedName || next.capturedName,
      displayName: prev.displayName || next.displayName,
      originalSize: next.originalSize ?? prev.originalSize,
      convertedName: prev.convertedName || null,
      convertedPath: prev.convertedPath || null,
      convertedSize: prev.convertedSize || null,
      archivePath: prev.archivePath || null,
      thumbnail: prev.thumbnail || null,
      thumbnailSourceMtimeMs: prev.thumbnailSourceMtimeMs || null,
      processStatus: prev.processStatus === 'completed' ? prev.processStatus : next.processStatus
    };
  }
  return store;
}

async function markProcessed(dir, originalFile, outputPath) {
  const store = await readScanStore(dir);
  const key = originalFile.name;
  const rec = store.records[key] || recordFromProbe(originalFile);
  let convertedSize = null;
  try {
    convertedSize = (await fs.stat(outputPath)).size;
  } catch {
    convertedSize = null;
  }
  const proposedArchive = originalFile.extension && originalFile.extension.toLowerCase() === '.mov'
    ? path.join(dir, 'archive', originalFile.name)
    : rec.archivePath;
  const archived = proposedArchive && await fileExists(proposedArchive) ? proposedArchive : null;
  store.records[key] = {
    ...rec,
    capturedName: rec.capturedName || rec.originalName || originalFile.name,
    originalSize: rec.originalSize ?? originalFile.size ?? null,
    convertedName: path.basename(outputPath),
    convertedPath: outputPath,
    convertedSize,
    archivePath: archived,
    processStatus: 'completed'
  };
  await writeScanStore(dir, store);
  return store.records[key];
}

const VIDEO_RENAME_EXTS = new Set(['.mov', '.mp4', '.m4v']);

function cleanRenameBase(raw) {
  let s = String(raw || '').trim();
  if (!s) {
    const err = new Error('Name is required');
    err.status = 400;
    throw err;
  }
  s = s.replace(/\\/g, '/');
  if (s.includes('/') || s.includes('\0')) {
    const err = new Error('Name cannot contain a path');
    err.status = 400;
    throw err;
  }
  s = path.basename(s);
  const ext = path.extname(s).toLowerCase();
  if (VIDEO_RENAME_EXTS.has(ext)) s = s.slice(0, -ext.length).trim();
  if (!s || s === '.' || s === '..') {
    const err = new Error('Name is not valid');
    err.status = 400;
    throw err;
  }
  if (s.length > 180) {
    const err = new Error('Name is too long');
    err.status = 400;
    throw err;
  }
  return s;
}

async function planMove(fromPath, newBase) {
  if (!fromPath || !(await fileExists(fromPath))) return null;
  const dest = path.join(path.dirname(fromPath), newBase + path.extname(fromPath));
  if (path.resolve(fromPath) === path.resolve(dest)) return null;
  if (await fileExists(dest)) {
    const err = new Error(`A file already exists named ${path.basename(dest)}`);
    err.status = 409;
    throw err;
  }
  return { from: fromPath, to: dest };
}

async function renameThumbForVideo(dir, fromPath, toPath) {
  const fromThumb = thumbnailAbs(dir, path.basename(fromPath));
  const toThumb = thumbnailAbs(dir, path.basename(toPath));
  if (!(await fileExists(fromThumb))) return null;
  if (path.resolve(fromThumb) === path.resolve(toThumb)) return thumbnailRel(path.basename(toPath));
  if (await fileExists(toThumb)) return thumbnailRel(path.basename(toPath));
  await fs.rename(fromThumb, toThumb);
  return thumbnailRel(path.basename(toPath));
}

async function renameRecordFiles(dir, recordKey, rawName, hint) {
  const newBase = cleanRenameBase(rawName);
  const store = await readScanStore(dir);
  let found = getRecord(store, recordKey);
  if (!found && hint?.name) found = getRecord(store, hint.name);
  if (!found && hint?.path) {
    const fake = { name: path.basename(hint.path), path: hint.path };
    const key = findRecordKey(store, fake);
    if (key) found = { key, rec: store.records[key] };
  }

  let rec;
  let key;
  if (found) {
    key = found.key;
    rec = found.rec;
  } else {
    const seedName = hint?.name || recordKey;
    const seedPath = hint?.path || path.join(dir, seedName);
    rec = recordFromProbe({
      name: seedName,
      path: seedPath,
      size: hint?.size,
      extension: path.extname(seedName)
    });
    key = seedName;
    store.records[key] = rec;
  }

  rec.capturedName = rec.capturedName || rec.originalName || rec.name || hint?.name;

  const convertedMove = await planMove(rec.convertedPath, newBase);
  const originalInFolder = rec.originalPath && !String(rec.originalPath).includes(`${path.sep}archive${path.sep}`)
    ? await planMove(rec.originalPath, newBase)
    : null;
  const archiveMove = await planMove(rec.archivePath, newBase);
  const extraMoves = [];
  const hintPathMove = await planMove(hint?.path, newBase);
  if (hint?.members) {
    for (const m of hint.members) {
      if (!m?.path) continue;
      const extra = await planMove(m.path, newBase);
      if (extra) extraMoves.push(extra);
    }
  }

  const planned = [];
  const seenFrom = new Set();
  for (const mv of [convertedMove, originalInFolder, archiveMove, hintPathMove, ...extraMoves]) {
    if (!mv) continue;
    const id = path.resolve(mv.from);
    if (seenFrom.has(id)) continue;
    seenFrom.add(id);
    planned.push(mv);
  }
  if (!planned.length) {
    const err = new Error('Nothing to rename');
    err.status = 404;
    throw err;
  }

  const done = [];
  try {
    for (const mv of planned) {
      await fs.rename(mv.from, mv.to);
      done.push(mv);
    }
  } catch (err) {
    for (const mv of done.reverse()) {
      await fs.rename(mv.to, mv.from).catch(() => {});
    }
    throw err;
  }

  const applyPath = (current, mv) => {
    if (!current || !mv) return current;
    if (path.resolve(current) === path.resolve(mv.from) || path.resolve(current) === path.resolve(mv.to)) return mv.to;
    return current;
  };

  for (const mv of planned) {
    rec.convertedPath = applyPath(rec.convertedPath, mv);
    rec.originalPath = applyPath(rec.originalPath, mv);
    rec.archivePath = applyPath(rec.archivePath, mv);
  }
  if (rec.convertedPath) rec.convertedName = path.basename(rec.convertedPath);
  const origExt = rec.originalExtension
    || path.extname(rec.originalName || rec.capturedName || '')
    || '.mov';
  rec.originalName = `${newBase}${origExt}`;
  rec.originalExtension = origExt;
  const libraryDirOf = (p) => {
    if (!p) return dir;
    const parent = path.dirname(p);
    return path.basename(parent) === 'archive' ? path.dirname(parent) : parent;
  };
  rec.originalPath = path.join(libraryDirOf(rec.originalPath || rec.archivePath), rec.originalName);
  rec.displayName = rec.convertedName || rec.originalName;
  rec.name = rec.displayName;

  let thumbRel = rec.thumbnail;
  for (const mv of planned) {
    const nextThumb = await renameThumbForVideo(dir, mv.from, mv.to);
    if (nextThumb) thumbRel = nextThumb;
  }
  if (thumbRel) rec.thumbnail = thumbRel;

  store.records[key] = rec;
  await writeScanStore(dir, store);
  return { key, rec, moves: planned };
}

async function attachToListing(files, store) {
  const out = [];
  for (const file of files) {
    const key = findRecordKey(store, file);
    const rec = key ? store.records[key] : null;
    const archiveExists = rec ? await fileExists(rec.archivePath) : false;
    const convertedExists = rec ? await fileExists(rec.convertedPath) : false;
    out.push({
      ...file,
      id: rec?.id || null,
      scanned: !!rec && !rec.scanError,
      recordKey: key,
      rotation: rec?.rotation,
      width: rec?.width,
      height: rec?.height,
      duration: rec?.duration,
      codec: rec?.codec,
      suggestRotation: rec?.suggestRotation,
      suggestOptimization: rec?.suggestOptimization,
      suggestConversion: rec?.suggestConversion,
      originalSize: rec?.originalSize ?? file.size,
      originalPath: rec?.originalPath,
      capturedName: rec?.capturedName,
      displayName: rec?.displayName,
      originalName: rec?.originalName,
      archivePath: rec?.archivePath,
      convertedPath: rec?.convertedPath,
      convertedSize: rec?.convertedSize,
      canRestore: archiveExists,
      convertedPresent: convertedExists,
      processStatus: rec?.processStatus,
      lastScannedAt: rec?.lastScannedAt,
      scanError: rec?.scanError || null
    });
  }
  return out;
}

function findExactRecordKey(store, file) {
  return findRecordKey(store, file);
}

function isConvertedListing(file, rec) {
  if (!rec) return false;
  const p = file.path;
  if (rec.convertedPath && p && path.resolve(rec.convertedPath) === path.resolve(p)) return true;
  if (rec.convertedName && file.name && rec.convertedName === file.name) return true;
  const ext = String(file.extension || path.extname(file.name || '')).toLowerCase();
  if (ext !== '.mp4' && ext !== '.m4v') return false;
  if (rec.originalPath && p && path.resolve(rec.originalPath) === path.resolve(p)) return false;
  if (rec.originalName && rec.originalName !== file.name && groupStem(rec.originalName) === groupStem(file.name)) return true;
  const origExt = String(rec.originalExtension || path.extname(rec.originalName || rec.capturedName || '')).toLowerCase();
  return origExt === '.mov';
}

function hasProbeData(rec) {
  return rec && (rec.width != null || rec.duration != null || rec.rotation != null);
}

function needsProbe(file, store) {
  const key = findRecordKey(store, file);
  if (!key) return true;
  const rec = store.records[key];
  if (!rec || rec.scanError) return true;
  if (!hasProbeData(rec)) return true;
  if (isConvertedListing(file, rec)) {
    if (file.size != null && rec.convertedSize != null && Number(file.size) !== Number(rec.convertedSize)) return true;
    return false;
  }
  if (file.size != null && rec.originalSize != null && Number(file.size) !== Number(rec.originalSize)) return true;
  if (file.mtimeMs != null && rec.sourceMtimeMs != null && Math.abs(Number(file.mtimeMs) - Number(rec.sourceMtimeMs)) >= 2000) return true;
  return false;
}

function hydrateFromStore(file, rec) {
  return {
    ...file,
    id: rec.id || file.id,
    rotation: rec.rotation ?? 0,
    width: rec.width ?? null,
    height: rec.height ?? null,
    duration: rec.duration ?? null,
    codec: rec.codec ?? null,
    suggestRotation: !!rec.suggestRotation,
    suggestOptimization: !!rec.suggestOptimization,
    suggestConversion: !!rec.suggestConversion,
    status: rec.scanError ? 'error' : 'idle',
    error: rec.scanError || undefined,
    analyzed: !rec.scanError && (rec.width != null || rec.duration != null || rec.rotation != null),
    thumbnail: rec.thumbnail || null,
    hasThumbnail: false,
    thumbnailUrl: null
  };
}

async function attachThumbnailState(file, dir) {
  const abs = thumbnailAbs(dir, file.name);
  const ready = await fileExists(abs);
  return {
    ...file,
    thumbnail: file.thumbnail || (ready ? thumbnailRel(file.name) : null),
    hasThumbnail: ready,
    thumbnailUrl: ready ? thumbnailUrlPath(file.path) : null
  };
}

function needsThumbnail(file, store) {
  const key = findRecordKey(store, file);
  const rec = key ? store.records[key] : null;
  if (!rec || !rec.thumbnail) return true;
  if (file.mtimeMs != null && rec.thumbnailSourceMtimeMs != null && Math.abs(Number(file.mtimeMs) - Number(rec.thumbnailSourceMtimeMs)) >= 2000) {
    return true;
  }
  return false;
}

async function markThumbnail(dir, file, relPath) {
  const store = await readScanStore(dir);
  const key = findRecordKey(store, file) || file.name;
  const rec = store.records[key] || recordFromProbe(file);
  store.records[key] = {
    ...rec,
    thumbnail: relPath,
    thumbnailSourceMtimeMs: file.mtimeMs ?? rec.thumbnailSourceMtimeMs ?? null
  };
  await writeScanStore(dir, store);
  return store.records[key];
}

function unseenFiles(files, store) {
  return files.filter((file) => needsProbe(file, store));
}

function member(role, name, filePath, size) {
  return { role, name, path: filePath, size: size || 0 };
}

async function groupListing(files, store, dir) {
  const archiveDir = path.join(dir, 'archive');
  let archiveNames = [];
  try {
    archiveNames = await fs.readdir(archiveDir);
  } catch {
    archiveNames = [];
  }

  const byStem = new Map();
  const take = (filePath, name, size, roleHint) => {
    const g = groupStem(name);
    if (!byStem.has(g)) byStem.set(g, { stem: g, files: [] });
    byStem.get(g).files.push({ path: filePath, name, size, roleHint });
  };

  for (const file of files) {
    take(file.path, file.name, file.size, null);
  }
  for (const rec of Object.values(store.records || {})) {
    if (rec.convertedPath && rec.convertedName) {
      const g = groupStem(rec.originalName || rec.convertedName);
      if (!byStem.has(g)) byStem.set(g, { stem: g, files: [] });
    }
  }
  for (const name of archiveNames) {
    const ext = path.extname(name).toLowerCase();
    if (!['.mov', '.mp4', '.m4v'].includes(ext)) continue;
    const archivePath = path.join(archiveDir, name);
    let size = 0;
    try {
      size = (await fs.stat(archivePath)).size;
    } catch {
      continue;
    }
    take(archivePath, name, size, 'archive');
  }

  const groups = [];
  const seenGroups = new Set();

  for (const file of files) {
    const recKey = findRecordKey(store, file) || Object.keys(store.records || {}).find((k) => groupStem(k) === groupStem(file.name));
    const groupId = recKey ? `rec:${recKey}` : `stem:${groupStem(file.name)}`;
    if (seenGroups.has(groupId)) continue;
    seenGroups.add(groupId);
    const rec = recKey ? store.records[recKey] : null;
    const bucket = byStem.get(groupStem(file.name)) || { files: [] };

    const listing = files.filter((f) => {
      const k = findRecordKey(store, f);
      if (recKey) return k === recKey;
      return !findRecordKey(store, f) && groupStem(f.name) === groupStem(file.name);
    });

    const members = [];
    for (const f of listing) {
      const ext = path.extname(f.name).toLowerCase();
      const role = ext === '.mov' ? 'original' : (rec && rec.convertedName === f.name ? 'converted' : (ext === '.mp4' || ext === '.m4v' ? 'converted' : 'original'));
      members.push(member(role, f.name, f.path, f.size));
    }
    if (rec?.convertedPath && await fileExists(rec.convertedPath) && !members.some((m) => m.path === rec.convertedPath)) {
      let cSize = rec.convertedSize || 0;
      try { cSize = (await fs.stat(rec.convertedPath)).size; } catch { /* keep */ }
      members.push(member('converted', path.basename(rec.convertedPath), rec.convertedPath, cSize));
    }
    if (rec?.archivePath && await fileExists(rec.archivePath) && !members.some((m) => m.path === rec.archivePath)) {
      let aSize = rec.originalSize || 0;
      try {
        aSize = (await fs.stat(rec.archivePath)).size;
      } catch { /* keep */ }
      members.push(member('archive', path.basename(rec.archivePath), rec.archivePath, aSize));
    } else {
      for (const item of bucket.files) {
        if (item.roleHint === 'archive' && !members.some((m) => m.path === item.path)) {
          members.push(member('archive', item.name, item.path, item.size));
        }
      }
    }

    const originalMember = members.find((m) => m.role === 'original');
    const convertedMember = members.find((m) => m.role === 'converted');
    const archiveMember = members.find((m) => m.role === 'archive');
    const primary = convertedMember || originalMember || members[0];
    const displayName = rec?.displayName || primary?.name || file.name;
    const capturedName = rec?.capturedName || rec?.originalName || null;

    groups.push({
      key: recKey || groupStem(file.name),
      id: rec?.id || null,
      recordKey: recKey || (originalMember ? originalMember.name : file.name),
      name: displayName,
      displayName,
      capturedName,
      path: primary?.path || file.path,
      size: primary?.size || file.size,
      scanned: !!rec && !rec.scanError,
      rotation: rec?.rotation,
      width: rec?.width,
      height: rec?.height,
      duration: rec?.duration,
      codec: rec?.codec,
      suggestRotation: rec?.suggestRotation,
      suggestOptimization: rec?.suggestOptimization,
      suggestConversion: rec?.suggestConversion,
      originalSize: rec?.originalSize ?? originalMember?.size ?? archiveMember?.size,
      originalPath: rec?.originalPath || originalMember?.path,
      originalName: rec?.originalName || originalMember?.name,
      archivePath: archiveMember?.path || rec?.archivePath,
      convertedPath: convertedMember?.path || rec?.convertedPath,
      convertedName: convertedMember?.name || rec?.convertedName,
      convertedSize: convertedMember?.size || rec?.convertedSize,
      canRestore: !!archiveMember && !(originalMember && originalMember.path && !String(originalMember.path).includes(`${path.sep}archive${path.sep}`)),
      canDeleteArchive: !!archiveMember && !!convertedMember && (convertedMember.size || 0) > 1024,
      canProcess: !!originalMember && extIsVideoOriginal(originalMember.name) && rec && (rec.suggestRotation || rec.suggestOptimization || rec.suggestConversion) && rec.processStatus !== 'completed',
      convertedPresent: !!convertedMember,
      hasThumbnail: listing.some((f) => f.hasThumbnail) || !!rec?.thumbnail,
      processStatus: rec?.processStatus,
      lastScannedAt: rec?.lastScannedAt,
      scanError: rec?.scanError || null,
      members,
      extension: path.extname(primary?.name || file.name).toLowerCase()
    });
  }

  return groups;
}

async function groupListedFiles(files) {
  const byDir = new Map();
  for (const file of files) {
    const dir = path.dirname(file.path);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(file);
  }
  const groups = [];
  for (const [dir, dirFiles] of byDir.entries()) {
    const store = await readScanStore(dir);
    const listed = await groupListing(dirFiles, store, dir);
    for (const group of listed) {
      groups.push({ ...group, storeDir: dir });
    }
  }
  return groups;
}

function extIsVideoOriginal(name) {
  const ext = path.extname(name).toLowerCase();
  return ext === '.mov' || ext === '.mp4' || ext === '.m4v';
}

function getRecord(store, recordKey) {
  if (!recordKey) return null;
  if (store.records[recordKey]) return { key: recordKey, rec: store.records[recordKey] };
  const wanted = groupStem(recordKey);
  for (const [key, rec] of Object.entries(store.records || {})) {
    if (groupStem(key) === wanted || groupStem(rec.originalName) === wanted || groupStem(rec.convertedName) === wanted || groupStem(rec.capturedName) === wanted || groupStem(rec.displayName) === wanted) {
      return { key, rec };
    }
  }
  return null;
}

function recordsAsProcessFiles(store, dir) {
  return Object.values(store.records || {}).map((rec) => ({
    id: rec.id,
    name: rec.originalName || rec.name,
    path: rec.originalPath,
    size: rec.originalSize,
    extension: rec.originalExtension,
    rotation: rec.rotation,
    width: rec.width,
    height: rec.height,
    duration: rec.duration,
    codec: rec.codec,
    suggestRotation: rec.suggestRotation,
    suggestOptimization: rec.suggestOptimization,
    suggestConversion: rec.suggestConversion,
    status: rec.processStatus || 'idle',
    relativePath: rec.originalName || rec.name,
    _storeDir: dir
  }));
}

module.exports = {
  SCAN_DOTFILE,
  emptyStore,
  findRecordKey,
  fileExists,
  readScanStore,
  writeScanStore,
  upsertProbedFiles,
  markProcessed,
  attachToListing,
  groupListing,
  groupListedFiles,
  unseenFiles,
  recordsAsProcessFiles,
  getRecord,
  findExactRecordKey,
  needsProbe,
  hydrateFromStore,
  VIDORIENT_DIR,
  thumbnailRel,
  thumbnailAbs,
  thumbnailUrlPath,
  attachThumbnailState,
  needsThumbnail,
  markThumbnail,
  vidorientDir,
  renameRecordFiles
};
