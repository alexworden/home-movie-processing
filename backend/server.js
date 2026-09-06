/**
 * server.js
 * 
 * Express server that provides the API for the VidOrient frontend.
 * Manages video scanning, metadata retrieval, and processing jobs.
 */

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { spawn } = require('child_process');

function spawnDetached(command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', (err) => console.error(`[Open] ${command}:`, err.message));
  child.unref();
}

function posixForAppleScript(filePath) {
  return path.resolve(filePath).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function revealInFinder(filePath) {
  const posix = posixForAppleScript(filePath);
  spawnDetached('/usr/bin/osascript', [
    '-e', `tell application "Finder" to reveal POSIX file "${posix}"`,
    '-e', 'tell application "Finder" to activate'
  ]);
}

const VIDEO_EXTS = new Set(['.mov', '.mp4', '.m4v']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.heic', '.webp', '.tif', '.tiff']);

function previewFile(filePath) {
  const abs = path.resolve(filePath);
  const ext = path.extname(abs).toLowerCase();
  if (VIDEO_EXTS.has(ext)) {
    spawnDetached('/usr/bin/open', ['-a', 'QuickTime Player', abs]);
    return;
  }
  if (IMAGE_EXTS.has(ext)) {
    spawnDetached('/usr/bin/open', ['-a', 'Preview', abs]);
    return;
  }
  spawnDetached('/usr/bin/open', [abs]);
}
const {
  scanDirectory, probeVideo, processVideo, listContent, fileRecordFromPath, extractThumbnail, assertPlayableVideo, ARCHIVE_DIR
} = require('./processor');
const {
  readScanStore, writeScanStore, upsertProbedFiles,
  findExactRecordKey, needsProbe, hydrateFromStore,
  attachThumbnailState, needsThumbnail, markThumbnail,
  thumbnailAbs, thumbnailRel, thumbnailUrlPath, fileExists, VIDORIENT_DIR,
  groupListedFiles, getRecord, markProcessed, renameRecordFiles
} = require('./scanStore');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors()); // Allow frontend to talk to backend
app.use(express.json()); // Support JSON request bodies
app.use(morgan('dev')); // Log requests for easy debugging

// In-memory store for active jobs and scan results
// (For a larger app, you'd use a database, but for a local tool this is sufficient)
let scanResults = [];
let jobs = {};
let queue = [];
let activeJobCount = 0;
const MAX_CONCURRENT_JOBS = 3;
let scanGeneration = 0;

function sanitizeUserPath(input) {
  let folder = input.replace(/\\ /g, ' ');
  if (folder.startsWith('~/')) {
    folder = path.join(process.env.HOME, folder.slice(2));
  }
  return folder;
}

function rememberScanResults(files) {
  for (const file of files) {
    if (!file || (!file.id && !file.path)) continue;
    const idx = scanResults.findIndex((s) => (file.id && s.id === file.id) || (file.path && s.path === file.path));
    if (idx >= 0) {
      scanResults[idx] = { ...scanResults[idx], ...file, id: file.id || scanResults[idx].id };
    } else if (file.id) {
      scanResults.push(file);
    }
  }
}

async function attachCachedMeta(files) {
  const stores = new Map();
  const out = [];
  for (const file of files) {
    const dir = path.dirname(file.path);
    if (!stores.has(dir)) stores.set(dir, await readScanStore(dir));
    const store = stores.get(dir);
    const key = findExactRecordKey(store, file);
    if (key) out.push(hydrateFromStore(file, store.records[key]));
    else out.push({ ...file, analyzed: false });
    out[out.length - 1] = await attachThumbnailState(out[out.length - 1], dir);
  }
  return out;
}

let thumbQueue = [];
let thumbActive = 0;
const MAX_THUMB_JOBS = 2;
const thumbQueued = new Set();

function enqueueThumbnails(files) {
  for (const file of files || []) {
    if (!file?.path || thumbQueued.has(file.path)) continue;
    thumbQueued.add(file.path);
    thumbQueue.push(file);
  }
  drainThumbs();
}

function drainThumbs() {
  while (thumbActive < MAX_THUMB_JOBS && thumbQueue.length > 0) {
    const file = thumbQueue.shift();
    thumbActive += 1;
    generateThumbnail(file)
      .catch((err) => console.error(`[Thumb] ${file.name}:`, err.message))
      .finally(() => {
        thumbActive -= 1;
        thumbQueued.delete(file.path);
        drainThumbs();
      });
  }
}

async function generateThumbnail(file) {
  const dir = path.dirname(file.path);
  const dest = thumbnailAbs(dir, file.name);
  if (await fileExists(dest)) return;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await extractThumbnail(file.path, dest);
  await markThumbnail(dir, file, thumbnailRel(file.name));
}

async function probeFileList(files, { generation } = {}) {
  const enrichedFiles = [];
  const CHUNK_SIZE = 5;

  for (let i = 0; i < files.length; i += CHUNK_SIZE) {
    if (generation != null && generation !== scanGeneration) {
      console.log('Scan aborted before remaining probe chunks');
      return { files: enrichedFiles, aborted: true };
    }
    const chunk = files.slice(i, i + CHUNK_SIZE);
    console.log(`Probing chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(files.length / CHUNK_SIZE)}...`);

    const chunkResults = await Promise.all(chunk.map(async (file) => {
      try {
        const meta = await probeVideo(file.path);
        const needsRotation = meta.rotation !== 0;
        const isLargeMOV = file.extension === '.mov' && file.size > 100 * 1024 * 1024;
        const isMOV = file.extension === '.mov';

        return {
          ...file,
          ...meta,
          suggestRotation: needsRotation,
          suggestOptimization: isLargeMOV,
          suggestConversion: isMOV,
          status: 'idle',
          analyzed: true
        };
      } catch (err) {
        console.error(`Error probing ${file.path}:`, err.message);
        return { ...file, status: 'error', error: err.message, analyzed: false };
      }
    }));

    if (generation != null && generation !== scanGeneration) {
      console.log('Scan aborted; skipping persist of last chunk');
      return { files: enrichedFiles, aborted: true };
    }

    await persistProbes(chunkResults);
    rememberScanResults(chunkResults);
    enrichedFiles.push(...chunkResults);
  }

  return { files: enrichedFiles, aborted: false };
}

async function persistProbes(probedFiles) {
  const byDir = new Map();
  for (const file of probedFiles) {
    const dir = path.dirname(file.path);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(file);
  }
  for (const [dir, files] of byDir.entries()) {
    const store = await readScanStore(dir);
    upsertProbedFiles(store, files);
    await writeScanStore(dir, store);
  }
}

async function enrichFromCacheOrProbe(files, { force = false, generation } = {}) {
  const stores = new Map();
  const ready = [];
  const toProbe = [];
  for (const file of files) {
    const dir = path.dirname(file.path);
    if (!stores.has(dir)) stores.set(dir, await readScanStore(dir));
    const store = stores.get(dir);
    if (!force && !needsProbe(file, store)) {
      const key = findExactRecordKey(store, file);
      ready.push(hydrateFromStore(file, store.records[key]));
    } else {
      toProbe.push(file);
    }
  }
  rememberScanResults(ready);
  console.log(`Scan cache: ${ready.length} unchanged, probing ${toProbe.length}`);
  const probed = toProbe.length ? await probeFileList(toProbe, { generation }) : { files: [], aborted: false };
  const byPath = new Map();
  for (const file of ready) byPath.set(file.path, file);
  for (const file of probed.files) byPath.set(file.path, file);
  const ordered = files.map((file) => byPath.get(file.path) || file);
  return { files: ordered, aborted: probed.aborted };
}

/**
 * Helper to process the next jobs in the queue.
 */
function processQueue() {
  while (queue.length > 0 && activeJobCount < MAX_CONCURRENT_JOBS) {
    const jobToProcess = queue.shift();
    const { fileId, options, file, outputPath } = jobToProcess;

    activeJobCount++;
    jobs[fileId].status = 'processing';
    jobs[fileId].warning = null;

    console.log(`[Queue] Starting job ${fileId} for ${file.name}. Active jobs: ${activeJobCount}/${MAX_CONCURRENT_JOBS}`);

    processVideo(file.path, outputPath, { ...options, rotation: file.rotation }, (percent) => {
      jobs[fileId].progress = Math.round(percent);
    })
      .then(async () => {
        try {
          await assertPlayableVideo(outputPath, { expectedDuration: file.duration });
        } catch (verifyErr) {
          throw new Error(`Converted file is not a safe replacement for the original: ${verifyErr.message}`);
        }

        jobs[fileId].status = 'completed';
        jobs[fileId].progress = 100;

        const fileDir = path.dirname(file.path);
        if (file.extension && file.extension.toLowerCase() === '.mov') {
          try {
            const archiveDir = path.join(fileDir, ARCHIVE_DIR);
            const archivePath = path.join(archiveDir, file.name);
            if (await fileExists(archivePath)) {
              jobs[fileId].warning = 'Converted file is ready; original was not moved because an archive file with that name already exists.';
              console.warn(`[Archive] Skipping move; destination exists: ${archivePath}`);
            } else {
              await fs.mkdir(archiveDir, { recursive: true });
              await fs.rename(file.path, archivePath);
              console.log(`[Archive] Moved original to ${archivePath}`);
            }
          } catch (archiveErr) {
            jobs[fileId].warning = `Converted file is ready; original was not archived: ${archiveErr.message}`;
            console.error(`[Archive] Failed to archive ${file.name}:`, archiveErr.message);
          }
        }
        try {
          await markProcessed(fileDir, file, outputPath);
        } catch (storeErr) {
          console.error(`[Store] markProcessed failed for ${file.name}:`, storeErr.message);
        }
      })
      .catch((err) => {
        console.error(`[Queue] Job ${fileId} failed:`, err.message);
        jobs[fileId].status = 'failed';
        jobs[fileId].error = err.message;
      })
      .finally(() => {
        activeJobCount--;
        processQueue();
      });
  }
}

/**
 * GET /api/scan
 * Scans a folder for video files and suggests actions based on rotation and size.
 */
app.get('/api/scan', async (req, res) => {
  let { folder, recursive, force } = req.query;
  if (!folder) return res.status(400).json({ error: 'Folder path is required' });

  const isRecursive = recursive !== 'false' && recursive !== '0';
  const forceProbe = force === 'true' || force === '1';
  folder = sanitizeUserPath(folder);
  const generation = ++scanGeneration;

  try {
    await fs.access(folder);
    const stats = await fs.stat(folder);
    if (!stats.isDirectory()) {
      throw new Error('Provided path is not a directory');
    }

    const files = await scanDirectory(folder, folder, isRecursive);
    console.log(`Scanning: ${folder} - Found ${files.length} files (${isRecursive ? 'recursive' : 'non-recursive'} scan).`);
    const result = await enrichFromCacheOrProbe(files, { force: forceProbe, generation });
    scanResults = result.files.filter((f) => f.id);
    enqueueThumbnails(result.files);
    res.json(result.aborted ? { aborted: true, files: result.files } : result.files);
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/scan/files
 * Probes an explicit list of video file paths (browse auto-scan).
 */
app.post('/api/scan/files', async (req, res) => {
  const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
  if (paths.length < 1) return res.status(400).json({ error: 'paths array is required' });
  const rootFolder = req.body?.rootFolder ? sanitizeUserPath(String(req.body.rootFolder)) : null;
  const forceProbe = !!req.body?.force;
  const generation = ++scanGeneration;

  try {
    const files = [];
    for (const raw of paths) {
      const fullPath = sanitizeUserPath(String(raw));
      const rec = await fileRecordFromPath(fullPath, rootFolder || path.dirname(fullPath));
      files.push(rec);
    }
    console.log(`Scanning ${files.length} listed file(s).`);
    const result = await enrichFromCacheOrProbe(files, { force: forceProbe, generation });
    rememberScanResults(result.files);
    enqueueThumbnails(result.files);
    res.json(result.aborted ? { aborted: true, files: result.files } : result.files);
  } catch (err) {
    console.error('Scan files error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scan/cancel', (_req, res) => {
  scanGeneration += 1;
  console.log('Scan cancelled by client');
  res.json({ ok: true });
});

/**
 * GET /api/browse
 * Lists folders and videos. Attaches cached analysis from .vidorient/ (no probe).
 */
app.get('/api/browse', async (req, res) => {
  let { folder, recursive } = req.query;
  if (!folder) folder = '/Volumes';
  folder = sanitizeUserPath(folder);
  const isRecursive = recursive === 'true' || recursive === '1';

  try {
    const listed = await listContent(folder);
    const files = isRecursive
      ? await scanDirectory(folder, folder, true)
      : listed.files;
    const withMeta = await attachCachedMeta(files);
    const groups = await groupListedFiles(withMeta);
    rememberScanResults(withMeta.filter((f) => f.id));
    enqueueThumbnails(withMeta);
    res.json({
      current: folder,
      parent: path.dirname(folder),
      subdirs: listed.subdirs,
      files: withMeta,
      groups
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/places', (_req, res) => {
  res.json({
    home: os.homedir(),
    volumes: '/Volumes'
  });
});

app.post('/api/open', async (req, res) => {
  const action = req.body?.action;
  const target = sanitizeUserPath(String(req.body?.file || req.body?.path || ''));
  if (!target) return res.status(400).json({ error: 'file is required' });
  if (action !== 'reveal' && action !== 'preview') {
    return res.status(400).json({ error: 'action must be reveal or preview' });
  }
  try {
    const stats = await fs.stat(target);
    if (!stats.isFile()) return res.status(400).json({ error: 'Path is not a file' });
    if (action === 'reveal') revealInFinder(target);
    else previewFile(target);
    console.log(`[Open] ${action} ${target}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[Open] failed ${action} ${target}:`, err.message);
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/thumbnail', async (req, res) => {
  const videoPath = sanitizeUserPath(String(req.query.file || ''));
  if (!videoPath) return res.status(400).json({ error: 'file is required' });
  const dir = path.dirname(videoPath);
  const abs = path.resolve(thumbnailAbs(dir, path.basename(videoPath)));
  const thumbsRoot = path.resolve(path.join(dir, VIDORIENT_DIR, 'thumbs')) + path.sep;
  if (!abs.startsWith(thumbsRoot) && abs !== thumbsRoot.slice(0, -1)) {
    return res.status(400).json({ error: 'Invalid thumbnail path' });
  }
  try {
    await fs.access(abs);
    res.sendFile(abs, { dotfiles: 'allow', headers: { 'Content-Type': 'image/jpeg' } }, (err) => {
      if (!err || res.headersSent) return;
      res.status(err.statusCode || 404).json({ error: 'Thumbnail not ready' });
    });
  } catch {
    res.status(404).json({ error: 'Thumbnail not ready' });
  }
});

app.post('/api/thumbs/status', async (req, res) => {
  const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
  const out = {};
  for (const raw of paths) {
    const videoPath = sanitizeUserPath(String(raw));
    const dir = path.dirname(videoPath);
    const ready = await fileExists(thumbnailAbs(dir, path.basename(videoPath)));
    out[videoPath] = {
      ready,
      url: ready ? thumbnailUrlPath(videoPath) : null
    };
  }
  res.json(out);
});

/**
 * POST /api/process
 * Starts processing a specific file (adds to queue).
 */
app.post('/api/process', async (req, res) => {
  const { fileId, options } = req.body;
  const file = scanResults.find(f => f.id === fileId);

  if (!file) return res.status(404).json({ error: 'File not found' });
  if (jobs[fileId] && jobs[fileId].status !== 'failed') {
    return res.status(400).json({ error: 'Job already in progress or queued' });
  }

  // Define output path
  const originalExt = path.extname(file.path);
  // Case-insensitive removal of the extension
  const baseName = path.basename(file.path).replace(new RegExp(`${originalExt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), '');
  const outputExt = '.mp4';

  let outputFileName;
  // Use lowercase for comparison to determine if we need the .fixed suffix
  const lowerExt = originalExt.toLowerCase();
  if (lowerExt === '.mp4' || lowerExt === '.m4v') {
    // Same or similar extension, add "fixed" to avoid overwriting original
    outputFileName = `${baseName}.fixed${outputExt}`;
  } else {
    // Different extension (e.g., .mov -> .mp4), just change the extension
    outputFileName = `${baseName}${outputExt}`;
  }

  const outputPath = path.join(path.dirname(file.path), outputFileName);

  if (await fileExists(outputPath)) {
    return res.status(409).json({ error: `Refusing to overwrite existing file: ${outputPath}` });
  }

  // Initialize job status as queued
  jobs[fileId] = {
    id: fileId,
    progress: 0,
    status: 'queued',
    outputPath
  };

  // Add to queue
  queue.push({
    fileId,
    options,
    file,
    outputPath
  });

  console.log(`[Queue] Added ${file.name} to queue. Queue length: ${queue.length}`);

  // Start processing if possible
  processQueue();

  res.json(jobs[fileId]);
});

app.post('/api/rename', async (req, res) => {
  const folder = sanitizeUserPath(String(req.body?.folder || ''));
  const recordKey = req.body?.recordKey;
  const name = req.body?.name;
  if (!folder || !recordKey) return res.status(400).json({ error: 'folder and recordKey are required' });

  const fileId = req.body?.fileId;
  if (fileId && jobs[fileId] && (jobs[fileId].status === 'queued' || jobs[fileId].status === 'processing')) {
    return res.status(409).json({ error: 'Cannot rename a file while it is processing' });
  }

  try {
    const result = await renameRecordFiles(folder, recordKey, name, {
      name: req.body?.currentName,
      path: req.body?.path ? sanitizeUserPath(String(req.body.path)) : null,
      members: Array.isArray(req.body?.members) ? req.body.members : []
    });

    const recId = result.rec.id;
    for (const file of scanResults) {
      if (file.id !== recId && file.name !== recordKey) continue;
      for (const mv of result.moves) {
        if (file.path && path.resolve(file.path) === path.resolve(mv.from)) {
          file.path = mv.to;
          file.name = path.basename(mv.to);
        }
      }
    }

    res.json({
      ok: true,
      recordKey: result.key,
      displayName: result.rec.displayName,
      capturedName: result.rec.capturedName,
      originalName: result.rec.originalName,
      convertedName: result.rec.convertedName,
      convertedPath: result.rec.convertedPath,
      originalPath: result.rec.originalPath,
      archivePath: result.rec.archivePath,
      moves: result.moves
    });
  } catch (err) {
    const status = err.status || (err.code === 'ENOENT' ? 404 : 500);
    if (status >= 500) console.error('[Rename]', err);
    res.status(status).json({ error: err.message });
  }
});

app.post('/api/restore', async (req, res) => {
  const folder = sanitizeUserPath(String(req.body?.folder || ''));
  const recordKey = req.body?.recordKey;
  const deleteConverted = !!req.body?.deleteConverted;
  if (!folder || !recordKey) return res.status(400).json({ error: 'folder and recordKey are required' });

  try {
    const store = await readScanStore(folder);
    const found = getRecord(store, recordKey);
    if (!found) return res.status(404).json({ error: 'No scan record for that file' });
    const rec = found.rec;
    if (!rec.archivePath || !(await fileExists(rec.archivePath))) {
      return res.status(409).json({ error: 'No archive file to restore' });
    }
    const dest = rec.originalPath || path.join(folder, rec.originalName || rec.name);
    if (await fileExists(dest)) {
      return res.status(409).json({ error: `Refusing to overwrite existing file: ${dest}` });
    }
    await fs.rename(rec.archivePath, dest);
    try {
      await assertPlayableVideo(dest, { expectedDuration: rec.duration });
    } catch (err) {
      await fs.rename(dest, rec.archivePath).catch(() => {});
      return res.status(409).json({ error: `Restore aborted; archive left in place: ${err.message}` });
    }
    rec.archivePath = null;
    rec.originalPath = dest;
    if (deleteConverted) {
      if (!rec.convertedPath || !(await fileExists(rec.convertedPath))) {
        await writeScanStore(folder, store);
        return res.status(409).json({ error: 'Original restored; converted file was missing so nothing was deleted' });
      }
      await fs.unlink(rec.convertedPath);
      rec.convertedPath = null;
      rec.convertedName = null;
      rec.convertedSize = null;
    }
    rec.processStatus = 'idle';
    store.records[found.key] = rec;
    await writeScanStore(folder, store);
    res.json({ ok: true, restored: dest, convertedDeleted: deleteConverted && !rec.convertedPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/archive/delete', async (req, res) => {
  const folder = sanitizeUserPath(String(req.body?.folder || ''));
  const recordKey = req.body?.recordKey;
  if (!folder || !recordKey) return res.status(400).json({ error: 'folder and recordKey are required' });

  try {
    const store = await readScanStore(folder);
    const found = getRecord(store, recordKey);
    if (!found) return res.status(404).json({ error: 'No scan record for that file' });
    const rec = found.rec;
    if (!rec.convertedPath || !(await fileExists(rec.convertedPath))) {
      return res.status(409).json({ error: 'Refusing to delete the archive: no converted file is present' });
    }
    try {
      await assertPlayableVideo(rec.convertedPath, { expectedDuration: rec.duration });
    } catch (err) {
      return res.status(409).json({ error: `Refusing to delete the archive: converted file is not a verified video (${err.message})` });
    }
    if (!rec.archivePath || !(await fileExists(rec.archivePath))) {
      return res.status(409).json({ error: 'No archive file to delete' });
    }
    await fs.unlink(rec.archivePath);
    rec.archivePath = null;
    store.records[found.key] = rec;
    await writeScanStore(folder, store);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/jobs
 * Returns the status of all active and completed jobs.
 */
app.get('/api/jobs', (req, res) => {
  res.json(Object.values(jobs));
});

app.listen(PORT, () => {
  console.log(`VidOrient Backend running at http://localhost:${PORT}`);
});
