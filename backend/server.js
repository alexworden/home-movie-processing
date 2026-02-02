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
const fs = require('fs/promises');
const { scanDirectory, probeVideo, processVideo, listContent } = require('./processor');

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

/**
 * Helper to process the next jobs in the queue.
 */
function processQueue() {
  while (queue.length > 0 && activeJobCount < MAX_CONCURRENT_JOBS) {
    // Take the next job from the queue
    const jobToProcess = queue.shift();
    const { fileId, options, file, outputPath } = jobToProcess;

    activeJobCount++;
    jobs[fileId].status = 'processing';

    console.log(`[Queue] Starting job ${fileId} for ${file.name}. Active jobs: ${activeJobCount}/${MAX_CONCURRENT_JOBS}`);
    console.log(`[Queue] Processing ${file.name}: rotation=${file.rotation}°, fixRotation=${options.fixRotation}`);

    processVideo(file.path, outputPath, { ...options, rotation: file.rotation }, (percent) => {
      jobs[fileId].progress = Math.round(percent);
    })
      .then(() => {
        console.log(`[Queue] Job ${fileId} completed.`);
        jobs[fileId].status = 'completed';
        jobs[fileId].progress = 100;
      })
      .catch((err) => {
        console.error(`[Queue] Job ${fileId} failed:`, err.message);
        jobs[fileId].status = 'failed';
        jobs[fileId].error = err.message;
      })
      .finally(() => {
        activeJobCount--;
        console.log(`[Queue] Job ${fileId} finished. Active jobs: ${activeJobCount}/${MAX_CONCURRENT_JOBS}. Picking next...`);
        processQueue(); // Try to start the next job
      });
  }
}

/**
 * GET /api/scan
 * Scans a folder for video files and suggests actions based on rotation and size.
 */
app.get('/api/scan', async (req, res) => {
  let { folder, recursive } = req.query;
  if (!folder) return res.status(400).json({ error: 'Folder path is required' });

  // Parse recursive flag (default to true for backward compatibility)
  const isRecursive = recursive !== 'false' && recursive !== '0';

  // Sanitize path: 
  // 1. Remove backslashes used to escape spaces (Common when copying from Mac Terminal)
  folder = folder.replace(/\\ /g, ' ');
  // 2. Expand tilde if present
  if (folder.startsWith('~/')) {
    folder = path.join(process.env.HOME, folder.slice(2));
  }

  try {
    // Check if path exists and is a directory
    await fs.access(folder);
    const stats = await fs.stat(folder);
    if (!stats.isDirectory()) {
      throw new Error('Provided path is not a directory');
    }

    const files = await scanDirectory(folder, folder, isRecursive);
    console.log(`Scanning: ${folder} - Found ${files.length} files (${isRecursive ? 'recursive' : 'non-recursive'} scan). Probing metadata...`);

    // Prioritize .mov files, especially those likely to need rotation
    // Sort so .mov files come first
    files.sort((a, b) => {
      if (a.extension === '.mov' && b.extension !== '.mov') return -1;
      if (a.extension !== '.mov' && b.extension === '.mov') return 1;
      return 0;
    });

    const enrichedFiles = [];
    const CHUNK_SIZE = 5;

    for (let i = 0; i < files.length; i += CHUNK_SIZE) {
      const chunk = files.slice(i, i + CHUNK_SIZE);
      console.log(`Probing chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(files.length / CHUNK_SIZE)}...`);

      const chunkResults = await Promise.all(chunk.map(async (file) => {
        try {
          const meta = await probeVideo(file.path);

          // Suggestions logic:
          // 1. Rotation detected - HIGH PRIORITY
          // 2. Large MOV file (>100MB) - Optimization suggested
          // 3. MOV file (general compatibility) - But we'll only "recommend" (auto-select) 
          //    if it meets priority criteria.
          const needsRotation = meta.rotation !== 0;
          const isLargeMOV = file.extension === '.mov' && file.size > 100 * 1024 * 1024;
          const isMOV = file.extension === '.mov';

          return {
            ...file,
            ...meta,
            suggestRotation: needsRotation,
            suggestOptimization: isLargeMOV,
            suggestConversion: isMOV,
            status: 'idle'
          };
        } catch (err) {
          console.error(`Error probing ${file.path}:`, err.message);
          return { ...file, status: 'error', error: err.message };
        }
      }));

      enrichedFiles.push(...chunkResults);
    }

    // Sort results to prioritize .mov files that need rotation
    enrichedFiles.sort((a, b) => {
      const aIsMOVWithRotation = a.extension === '.mov' && a.suggestRotation;
      const bIsMOVWithRotation = b.extension === '.mov' && b.suggestRotation;

      // .mov files with rotation first
      if (aIsMOVWithRotation && !bIsMOVWithRotation) return -1;
      if (!aIsMOVWithRotation && bIsMOVWithRotation) return 1;

      // Then other .mov files
      if (a.extension === '.mov' && b.extension !== '.mov') return -1;
      if (a.extension !== '.mov' && b.extension === '.mov') return 1;

      // Then files with rotation
      if (a.suggestRotation && !b.suggestRotation) return -1;
      if (!a.suggestRotation && b.suggestRotation) return 1;

      return 0;
    });

    scanResults = enrichedFiles;
    res.json(enrichedFiles);
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/browse
 * Returns a list of subdirectories for a given folder.
 */
app.get('/api/browse', async (req, res) => {
  let { folder } = req.query;
  if (!folder) folder = '/Volumes'; // Default to root or Volumes

  // Sanitize path (same logic as scan)
  folder = folder.replace(/\\ /g, ' ');
  if (folder.startsWith('~/')) {
    folder = path.join(process.env.HOME, folder.slice(2));
  }

  try {
    const { subdirs, files } = await listContent(folder);
    res.json({
      current: folder,
      parent: path.dirname(folder),
      subdirs,
      files
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/process
 * Starts processing a specific file (adds to queue).
 */
app.post('/api/process', async (req, res) => {
  const { fileId, options } = req.body;
  const file = scanResults.find(f => f.id === fileId);

  if (!file) return res.status(404).json({ error: 'File not found' });
  if (jobs[fileId]) return res.status(400).json({ error: 'Job already in progress or queued' });

  // Define output path
  // Only add "fixed" if the extension stays the same (.mp4 -> .mp4)
  // If extension changes (.mov -> .mp4), the extension change already distinguishes it
  const ext = path.extname(file.path).toLowerCase();
  const baseName = path.basename(file.path, ext);
  const outputExt = '.mp4';

  let outputFileName;
  if (ext === '.mp4') {
    // Same extension, add "fixed" to avoid overwriting original
    outputFileName = `${baseName}.fixed${outputExt}`;
  } else {
    // Different extension, just change the extension
    outputFileName = `${baseName}${outputExt}`;
  }

  const outputPath = path.join(path.dirname(file.path), outputFileName);

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
