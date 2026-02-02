import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Play, CheckCircle, Loader2, Folder, X, Home, ArrowUp, Video, Search, Filter } from 'lucide-react';

const API_BASE = 'http://localhost:3001/api';

function App() {
  const [folderPath, setFolderPath] = useState('/Volumes/Home Movies/Lori Movies');
  const [loading, setLoading] = useState(false);
  const [recursiveScan, setRecursiveScan] = useState(true); // Recursive scan option
  const [files, setFiles] = useState([]); // Analyzed files (after "Scan Now")
  const [allFiles, setAllFiles] = useState([]); // All files (before filtering)
  const [showOnlyRecommended, setShowOnlyRecommended] = useState(true); // Filter toggle
  const [jobs, setJobs] = useState({});
  const [browseData, setBrowseData] = useState({ subdirs: [], files: [] }); // Folders and names for browsing
  const [browsingLoading, setBrowsingLoading] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState(new Set());
  const inputRef = useRef(null);

  // Fetch directory contents
  const fetchSubdirs = useCallback(async (path) => {
    if (!path || path.length < 1) return setBrowseData({ subdirs: [], files: [] });
    setBrowsingLoading(true);
    try {
      const res = await fetch(`${API_BASE}/browse?folder=${encodeURIComponent(path)}`);
      if (res.ok) {
        const data = await res.json();
        setBrowseData({ subdirs: data.subdirs || [], files: data.files || [] });
      } else {
        setBrowseData({ subdirs: [], files: [] });
      }
    } catch (err) {
      console.error('Browse error:', err);
      setBrowseData({ subdirs: [], files: [] });
    } finally {
      setBrowsingLoading(false);
    }
  }, []);

  // Fetch subdirs on mount
  useEffect(() => {
    fetchSubdirs(folderPath);
  }, []);

  // Apply filter when showOnlyRecommended changes
  useEffect(() => {
    if (allFiles.length > 0) {
      const filtered = showOnlyRecommended 
        ? allFiles.filter(f => f.suggestRotation || f.suggestOptimization || f.suggestConversion)
        : allFiles;
      setFiles(filtered);
      // Update selection to only include visible files
      const visibleIds = new Set(filtered.map(f => f.id));
      setSelectedFiles(prev => new Set([...prev].filter(id => visibleIds.has(id))));
    }
  }, [showOnlyRecommended, allFiles]);

  // Poll for job updates
  useEffect(() => {
    const activeJobs = Object.values(jobs).some(j => j.status === 'processing');
    if (!activeJobs) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/jobs`);
        const data = await res.json();
        const newJobs = {};
        data.forEach(job => {
          newJobs[job.id] = job;
        });
        setJobs(prev => ({ ...prev, ...newJobs }));
      } catch (err) {
        console.error('Failed to poll jobs:', err);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [jobs]);

  const handleScan = async () => {
    if (!folderPath) return alert('Please enter or select a folder path');
    setLoading(true);
    setFiles([]);
    try {
      const res = await fetch(`${API_BASE}/scan?folder=${encodeURIComponent(folderPath)}&recursive=${recursiveScan}`);
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to scan');
      }
      const data = await res.json();
      setAllFiles(data); // Store all files
      // Apply filter if enabled
      const filtered = showOnlyRecommended 
        ? data.filter(f => f.suggestRotation || f.suggestOptimization || f.suggestConversion)
        : data;
      setFiles(filtered);
      // Auto-select files that need work
      const needWork = filtered.filter(f => f.suggestRotation || f.suggestOptimization || f.suggestConversion).map(f => f.id);
      setSelectedFiles(new Set(needWork));
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      setLoading(false);
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
      setJobs(prev => ({ ...prev, [fileId]: data }));
    } catch (err) {
      alert('Failed to start processing: ' + err.message);
    }
  };

  const toggleSelection = (id) => {
    setSelectedFiles(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    const selectable = files.filter(f => (f.suggestRotation || f.suggestOptimization || f.suggestConversion) && jobs[f.id]?.status !== 'processing' && jobs[f.id]?.status !== 'completed');
    if (selectedFiles.size === selectable.length && selectable.length > 0) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(selectable.map(f => f.id)));
    }
  };

  const handleBulkProcess = async () => {
    const toProcess = files.filter(f => selectedFiles.has(f.id));
    for (const file of toProcess) {
      // Don't restart if already working
      if (jobs[file.id]?.status === 'processing') continue;

      startProcess(file.id, {
        fixRotation: file.suggestRotation,
        optimize: file.suggestOptimization,
        convert: file.suggestConversion
      });
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
    setFiles([]);
    fetchSubdirs(newPath);
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
      fetchSubdirs(folderPath);
    }
  };

  const handleClear = () => {
    setFolderPath('');
    setBrowseData({ subdirs: [], files: [] });
    setFiles([]);
    setSelectedFiles(new Set());
    if (inputRef.current) inputRef.current.focus();
  };

  return (
    <div className="dashboard-container">
      <header>
        <div className="title-row">
          <h1>VidOrient</h1>
          <div className="header-badges">
            <span className="badge-modern">Plex / Shield Optimized</span>
          </div>
        </div>
        <p className="subtitle">Automatic iPhone video rotation & high-quality compression</p>
      </header>

      <div className="card navigation-card">
        <div className="nav-header">
          <div className="nav-controls-main">
            <button className="nav-circle-btn" onClick={() => navigateTo('/Volumes')} title="Root Volumes"><Home size={20} /></button>
            <button className="nav-circle-btn" onClick={goUp} disabled={folderPath === '/' || !folderPath} title="Back">
              <ArrowUp size={20} />
            </button>
          </div>

          <div className="input-row">
            <div className="path-input-wrapper">
              <div className="scan-options-row">
                <label className="recursive-checkbox-label">
                  <input
                    type="checkbox"
                    checked={recursiveScan}
                    onChange={(e) => setRecursiveScan(e.target.checked)}
                    className="recursive-checkbox"
                  />
                  <span>Recursive Scan</span>
                </label>
              </div>
              <div className="path-input-container">
                <input
                  ref={inputRef}
                  type="text"
                  value={folderPath}
                  onChange={(e) => setFolderPath(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="/Volumes/path/to/movies"
                />
                {folderPath && <button className="clear-btn-inline" onClick={handleClear}><X size={18} /></button>}
              </div>
            </div>

            <button
              className={`scan-master-btn ${loading ? 'scanning' : ''}`}
              onClick={handleScan}
              disabled={loading}
              title={recursiveScan ? "Scan all subfolders recursively" : "Scan only the selected folder"}
            >
              {loading ? <Loader2 className="animate-spin" /> : <Search size={20} />}
              {loading ? 'Scanning...' : 'Scan & Analyze'}
            </button>
          </div>
        </div>

        <div className="browser-content">
          <div className="browser-scroll">
            {browsingLoading ? (
              <div className="loading-state"><Loader2 className="animate-spin" /> Loading contents...</div>
            ) : (folderPath && (browseData.subdirs.length > 0 || browseData.files.length > 0)) ? (
              <div className="items-grid">
                {browseData.subdirs.map(dir => (
                  <button key={dir.path} className="browser-item dir" onClick={() => navigateTo(dir.path)}>
                    <Folder size={18} fill="#3b82f6" stroke="#3b82f6" />
                    <span className="name">{dir.name}</span>
                  </button>
                ))}
                {browseData.files.map(file => (
                  <div key={file.path} className="browser-item file">
                    <Video size={18} color="#94a3b8" />
                    <div className="file-info-mini">
                      <span className="name">{file.name}</span>
                      <span className="size-mini">{formatSize(file.size)}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : folderPath ? (
              <div className="empty-state">No folders or videos found here</div>
            ) : (
              <div className="empty-state">Enter a path or start at <button className="link-btn" onClick={() => navigateTo('/Volumes')}>/Volumes</button></div>
            )}
          </div>
        </div>
      </div>

      {allFiles.length > 0 && (
        <div className="card results-card fade-in">
          <div className="results-header">
            <div className="results-title-group">
              <input
                type="checkbox"
                checked={selectedFiles.size > 0 && selectedFiles.size === files.filter(f => (f.suggestRotation || f.suggestOptimization || f.suggestConversion) && jobs[f.id]?.status !== 'processing' && jobs[f.id]?.status !== 'completed').length}
                onChange={toggleAll}
                className="header-checkbox"
              />
              <h2>
                Detailed Analysis ({files.length} {showOnlyRecommended ? 'recommended' : ''} of {allFiles.length} videos)
              </h2>
            </div>
            <div className="results-actions">
              <button
                className={`secondary small ${showOnlyRecommended ? 'active' : ''}`}
                onClick={() => setShowOnlyRecommended(!showOnlyRecommended)}
                title={showOnlyRecommended ? 'Show all files' : 'Show only files that need processing'}
              >
                <Filter size={14} /> {showOnlyRecommended ? 'Show All' : 'Show Recommended'}
              </button>
              {selectedFiles.size > 0 && (
                <button className="btn-primary-glow small" onClick={handleBulkProcess}>
                  <Play size={12} fill="white" /> Process {selectedFiles.size} Selected
                </button>
              )}
              <button className="secondary small" onClick={() => { setAllFiles([]); setFiles([]); setSelectedFiles(new Set()); }}>Dismiss</button>
            </div>
          </div>

          <div className="file-list">
            {files.map(file => {
              const job = jobs[file.id];
              const isProcessing = job?.status === 'processing';
              const isCompleted = job?.status === 'completed';
              const canSelect = (file.suggestRotation || file.suggestOptimization || file.suggestConversion) && !isProcessing && !isCompleted;

              return (
                <div key={file.id} className={`file-row ${selectedFiles.has(file.id) ? 'selected' : ''}`}>
                  <div className="file-selection">
                    <input
                      type="checkbox"
                      disabled={!canSelect}
                      checked={selectedFiles.has(file.id)}
                      onChange={() => toggleSelection(file.id)}
                    />
                  </div>
                  <div className="file-info">
                    <span className="file-name">{file.name}</span>
                    <div className="file-meta">
                      <span>{formatSize(file.size)}</span>
                      <span>{file.width}×{file.height}</span>
                      {file.suggestRotation && <span className="tag tag-rotate">Requires Rotation ({file.rotation}°)</span>}
                      {file.suggestOptimization && <span className="tag tag-optimize">MOV Optimization Suggested</span>}
                      {file.suggestConversion && !file.suggestOptimization && <span className="tag tag-convert">Convert to MP4</span>}
                    </div>
                    {isProcessing && (
                      <div className="progress-container">
                        <div className="progress-fill" style={{ width: `${job.progress}%` }}></div>
                      </div>
                    )}
                  </div>

                  <div className="file-actions">
                    {isCompleted ? (
                      <div className="status-complete">
                        <CheckCircle size={18} /> Optimized
                      </div>
                    ) : isProcessing ? (
                      <div className="status-working">
                        <Loader2 className="animate-spin" size={18} /> {job.progress}%
                      </div>
                    ) : (file.suggestRotation || file.suggestOptimization || file.suggestConversion) ? (
                      <button
                        onClick={() => startProcess(file.id, {
                          fixRotation: file.suggestRotation,
                          optimize: file.suggestOptimization,
                          convert: file.suggestConversion
                        })}
                        className="btn-primary-glow"
                      >
                        <Play size={14} fill="white" /> {file.suggestConversion && !file.suggestRotation && !file.suggestOptimization ? 'Convert to MP4' : 'Fix & Optimize'}
                      </button>
                    ) : (
                      <div className="status-perfect">
                        <CheckCircle size={16} /> Perfect
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
