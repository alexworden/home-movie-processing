/**
 * processor.js
 * 
 * This module handles all the heavy lifting for the VidOrient backend.
 * It uses ffprobe to extract video metadata and ffmpeg to perform transcoding.
 * 
 * Logic is heavily commented to ensure ease of maintenance as requested.
 */

const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v']);
const ARCHIVE_DIR = 'archive';

/**
 * Scans a directory for video files, optionally recursively.
 * @param {string} dir - The directory to scan.
 * @param {string} root - The original root directory (for relative paths).
 * @param {boolean} recursive - Whether to scan subdirectories recursively (default: true).
 * @returns {Promise<Array>} - A list of video file objects.
 */
async function scanDirectory(dir, root = dir, recursive = true) {
    let results = [];
    const list = await fs.readdir(dir, { withFileTypes: true });

    for (const file of list) {
        const fullPath = path.join(dir, file.name);
        if (file.isDirectory()) {
            // Omit archive directories and hidden directories
            if (file.name === ARCHIVE_DIR || file.name.startsWith('.')) continue;

            // Recurse into subdirectories only if recursive is true
            if (recursive) {
                const inner = await scanDirectory(fullPath, root, recursive);
                results = results.concat(inner);
            }
        } else {
            const ext = path.extname(file.name).toLowerCase();
            if (VIDEO_EXTS.has(ext)) {
                // Get basic file stats
                const stats = await fs.stat(fullPath);
                results.push({
                    id: crypto.randomUUID(),
                    name: file.name,
                    path: fullPath,
                    relativePath: path.relative(root, fullPath),
                    size: stats.size,
                    mtimeMs: stats.mtimeMs,
                    extension: ext
                });
            }
        }
    }
    return results;
}

/**
 * Parses rotation from display matrix (3x3 matrix used by iPhone videos).
 * The matrix encodes rotation: [0,1,0,-1,0,0,0,0,1] = 90° clockwise, etc.
 * @param {Array} matrix - 9-element array representing 3x3 matrix
 * @returns {number} - Rotation in degrees (0, 90, 180, or 270)
 */
function parseRotationFromMatrix(matrix) {
    if (!matrix || matrix.length !== 9) return 0;

    // Common rotation matrices:
    // 90° clockwise:   [0,1,0,-1,0,0,0,0,1]
    // 180°:           [-1,0,0,0,-1,0,0,0,1]
    // 270° clockwise:  [0,-1,0,1,0,0,0,0,1]

    const [a, b, c, d, e, f, g, h, i] = matrix;

    // 90° clockwise
    if (a === 0 && b === 1 && d === -1 && e === 0) return 90;
    // 180°
    if (a === -1 && e === -1 && b === 0 && d === 0) return 180;
    // 270° clockwise (or -90°)
    if (a === 0 && b === -1 && d === 1 && e === 0) return 270;

    return 0;
}

/**
 * Probes a video file for metadata using ffprobe.
 * Specifically looks for rotation and dimensions.
 * @param {string} filePath - Path to the video file.
 * @returns {Promise<Object>} - Metadata including rotation, width, height.
 */
function probeVideo(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);

            const videoStream = metadata.streams.find(s => s.codec_type === 'video');
            if (!videoStream) return reject(new Error('No video stream found'));

            // Rotation can be in several places. iPhone videos often use display matrix.
            let rotation = 0;

            // 1. Check format-level tags (common for iPhone videos)
            if (metadata.format && metadata.format.tags) {
                if (metadata.format.tags.rotate) {
                    rotation = parseInt(metadata.format.tags.rotate, 10);
                }
            }

            // 2. Check stream-level tags
            if (rotation === 0 && videoStream.tags) {
                if (videoStream.tags.rotate) {
                    rotation = parseInt(videoStream.tags.rotate, 10);
                }
            }

            // 3. Check top-level rotation property (fluent-ffmpeg sometimes flattens this)
            if (rotation === 0 && videoStream.rotation !== undefined) {
                rotation = parseInt(videoStream.rotation, 10);
            }

            // 4. Check side_data_list for display matrix (most reliable for iPhone)
            if (rotation === 0 && videoStream.side_data_list) {
                for (const sideData of videoStream.side_data_list) {
                    // Check rotation field directly (often -90, 90, 180, 270)
                    if (sideData.rotation !== undefined && sideData.rotation !== null) {
                        rotation = parseInt(sideData.rotation, 10);
                        break;
                    }
                    // Also check for matrix data directly
                    if (sideData.side_data_type === 'Display Matrix' && sideData.matrix) {
                        const matrixRotation = parseRotationFromMatrix(sideData.matrix);
                        if (matrixRotation !== 0) {
                            rotation = matrixRotation;
                            break;
                        }
                    }
                }
            }

            // 5. Try to infer rotation from display matrix string (if present as string)
            if (rotation === 0 && videoStream.display_aspect_ratio) {
                // Sometimes the matrix is in tags as a string
                if (videoStream.tags && videoStream.tags['display-matrix']) {
                    try {
                        const matrixStr = videoStream.tags['display-matrix'];
                        // Format might be like "0,1,0,-1,0,0,0,0,1"
                        const matrix = matrixStr.split(',').map(Number);
                        const matrixRotation = parseRotationFromMatrix(matrix);
                        if (matrixRotation !== 0) {
                            rotation = matrixRotation;
                        }
                    } catch (e) {
                        // Ignore parsing errors
                    }
                }
            }

            // Normalize rotation to 0, 90, 180, 270 (clockwise rotation needed)
            // The rotation metadata indicates how much the video needs to be rotated to display correctly.
            // If metadata says -90°, it means "rotate -90° to display correctly"
            // To "burn in" this rotation, we rotate the pixels by the OPPOSITE amount.
            // So: -90° metadata → rotate +90° clockwise to fix (not 270°)
            //     +90° metadata → rotate -90° clockwise (or +270°) to fix
            // The current logic was backwards - fixing it now.
            if (rotation === -90) {
                rotation = 90; // -90° metadata → rotate 90° clockwise to fix
            } else if (rotation === 90) {
                rotation = 270; // +90° metadata → rotate 270° clockwise to fix
            } else if (rotation === -270) {
                rotation = 270; // -270° = +90°, so rotate 270° clockwise to fix
            } else if (rotation === 270) {
                rotation = 90; // +270° = -90°, so rotate 90° clockwise to fix
            } else if (rotation === -180 || rotation === 180) {
                rotation = 180; // 180° either way needs 180° rotation
            } else {
                // Normalize to 0-360 range first
                rotation = ((rotation % 360) + 360) % 360;
                // Round to nearest 90° increment if needed
                if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
                    rotation = Math.round(rotation / 90) * 90;
                    rotation = ((rotation % 360) + 360) % 360;
                }
                // Convert: 270° → 90°, 90° → 270° (opposite direction)
                if (rotation === 270) rotation = 90;
                else if (rotation === 90) rotation = 270;
            }

            // Log rotation detection result for debugging
            console.log(`Probed ${filePath}: detected rotation=${rotation}° (normalized), dimensions=${videoStream.width}x${videoStream.height}`);

            resolve({
                rotation: rotation,
                width: videoStream.width,
                height: videoStream.height,
                duration: metadata.format.duration,
                codec: videoStream.codec_name
            });
        });
    });
}

/**
 * Transcodes a video file to fix rotation and/or optimize size.
 * @param {string} inputPath - Original file path.
 * @param {string} outputPath - Target file path.
 * @param {Object} options - { fixRotation: boolean, targetSize: number }
 * @param {Function} onProgress - Callback for progress reporting (0-100).
 */
function processVideo(inputPath, outputPath, options, onProgress) {
    return new Promise((resolve, reject) => {
        let command = ffmpeg(inputPath);

        // Disable FFmpeg's auto-rotation so we have full control.
        // We want to manually apply rotation and remove metadata for maximum compatibility.
        command.inputOptions('-noautorotate');

        const remuxOnly = options.convert && !options.fixRotation && !options.optimize;

        if (remuxOnly) {
            console.log('Remuxing to MP4 without re-encode (convert only)');
            command
                .videoCodec('copy')
                .audioCodec('copy')
                .format('mp4')
                .outputOptions('-movflags', '+faststart')
                .on('progress', (progress) => {
                    if (onProgress) onProgress(progress.percent);
                })
                .on('end', () => resolve())
                .on('error', (err) => reject(err))
                .save(outputPath);
            return;
        }

        // If we need to fix rotation, apply transpose filter based on detected rotation.
        // The rotation value tells us how much to rotate clockwise to fix the orientation.
        if (options.fixRotation && options.rotation !== 0) {
            let filter = '';
            if (options.rotation === 90) {
                filter = 'transpose=1'; // Rotate 90° clockwise
            } else if (options.rotation === 180) {
                filter = 'transpose=1,transpose=1'; // Rotate 180° (two 90° clockwise)
            } else if (options.rotation === 270) {
                filter = 'transpose=2'; // Rotate 90° counter-clockwise = 270° clockwise
            }

            // CRITICAL: Remove rotation side data using the sidedata filter
            // This must be done AFTER transpose so the rotation is applied first, then side data is stripped
            // mode=delete (1) removes side data, type=DISPLAYMATRIX (6) targets rotation metadata
            filter += ',sidedata=mode=delete:type=6'; // Delete DISPLAYMATRIX side data (which contains rotation)

            console.log(`Applying rotation fix: ${options.rotation}° clockwise using filter: ${filter}`);
            command.videoFilters(filter);

            // Also remove metadata tags (though sidedata filter should handle side_data_list)
            command.outputOptions('-map_metadata', '-1');
            command.outputOptions('-metadata:s:v:0', 'rotate=0');
            command.outputOptions('-metadata', 'rotate=0');
        } else if (options.fixRotation) {
            console.log('Warning: fixRotation requested but rotation is 0 - no rotation applied');
        }

        // If converting (e.g., MOV to MP4) without rotation, still remove rotation metadata if present
        // This ensures the output file has no rotation metadata for better compatibility
        if (options.convert && !options.fixRotation && options.rotation !== 0) {
            console.log(`Converting file and removing rotation metadata (rotation=${options.rotation}° detected but not applying)`);
            // Remove rotation side data without applying rotation
            command.videoFilters('sidedata=mode=delete:type=6');
            command.outputOptions('-map_metadata', '-1');
            command.outputOptions('-metadata:s:v:0', 'rotate=0');
            command.outputOptions('-metadata', 'rotate=0');
        } else if (options.convert && !options.fixRotation) {
            console.log('Converting file to MP4 (no rotation needed)');
        }

        // H.264 8-bit: Shield/Plex-friendly. CRF 26 when optimizing (a bit more quality than 28);
        // CRF 23 for rotation/other re-encodes. Convert-only remuxes above (no re-encode).
        const crf = options.optimize ? '26' : '23';
        console.log(`Encoding libx264 crf=${crf} pix_fmt=yuv420p optimize=${!!options.optimize}`);
        command
            .videoCodec('libx264')
            .addOption('-crf', crf)
            .addOption('-preset', 'medium')
            .outputOptions('-pix_fmt', 'yuv420p')
            .audioCodec('copy')
            .format('mp4')
            .outputOptions('-movflags', '+faststart')
            .on('progress', (progress) => {
                if (onProgress) onProgress(progress.percent);
            })
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .save(outputPath);
    });
}

/**
 * Lists subdirectories and files of a given directory.
 * @param {string} dir - The directory to browse.
 * @returns {Promise<Object>} - Subfolders and video file names.
 */
async function listContent(dir) {
    const list = await fs.readdir(dir, { withFileTypes: true });
    const subdirs = list
        .filter(item => item.isDirectory() && !item.name.startsWith('.') && item.name !== ARCHIVE_DIR)
        .map(item => ({
            name: item.name,
            path: path.join(dir, item.name)
        }));

    const files = await Promise.all(list
        .filter(item => !item.isDirectory() && VIDEO_EXTS.has(path.extname(item.name).toLowerCase()))
        .map(async (item) => {
            const fullPath = path.join(dir, item.name);
            const stats = await fs.stat(fullPath);
            return {
                name: item.name,
                path: fullPath,
                size: stats.size,
                mtimeMs: stats.mtimeMs,
                relativePath: item.name,
                extension: path.extname(item.name).toLowerCase()
            };
        }));

    return { subdirs, files };
}

async function fileRecordFromPath(fullPath, rootDir) {
    const ext = path.extname(fullPath).toLowerCase();
    if (!VIDEO_EXTS.has(ext)) {
        throw new Error(`Unsupported file type: ${path.basename(fullPath)}`);
    }
    const stats = await fs.stat(fullPath);
    if (!stats.isFile()) {
        throw new Error(`Not a file: ${fullPath}`);
    }
    const root = rootDir || path.dirname(fullPath);
    return {
        id: crypto.randomUUID(),
        name: path.basename(fullPath),
        path: fullPath,
        relativePath: path.relative(root, fullPath) || path.basename(fullPath),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        extension: ext
    };
}

/**
 * Confirm a path is a real video before we move or delete any original/archive.
 * Duration must stay close to the source when that is known, so a truncated encode cannot replace it.
 */
async function assertPlayableVideo(filePath, { expectedDuration } = {}) {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
        throw new Error(`Not a file: ${filePath}`);
    }
    if (stats.size < 1024) {
        throw new Error(`File is too small to be a valid video (${stats.size} bytes): ${filePath}`);
    }
    const meta = await probeVideo(filePath);
    if (expectedDuration && meta.duration) {
        const delta = Math.abs(meta.duration - expectedDuration);
        if (delta > Math.max(2, expectedDuration * 0.05)) {
            throw new Error(
                `Converted duration (${Math.round(meta.duration)}s) does not match original (${Math.round(expectedDuration)}s)`
            );
        }
    }
    return { size: stats.size, meta };
}

function extractThumbnail(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const run = (seekSeconds) => {
            ffmpeg(inputPath)
                .outputOptions([
                    '-ss', String(seekSeconds),
                    '-vframes', '1',
                    '-vf', 'scale=320:-2'
                ])
                .output(outputPath)
                .on('end', () => resolve(outputPath))
                .on('error', (err) => {
                    if (seekSeconds > 0) {
                        run(0);
                        return;
                    }
                    reject(err);
                })
                .run();
        };
        run(1);
    });
}

module.exports = {
    scanDirectory,
    probeVideo,
    processVideo,
    listContent,
    fileRecordFromPath,
    assertPlayableVideo,
    extractThumbnail,
    ARCHIVE_DIR
};
