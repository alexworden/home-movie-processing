# VidOrient - Home Movie Processing Tool

VidOrient is a desktop application for processing home movies, specifically designed to fix rotation issues in iPhone videos and optimize large MOV files for Plex and NVIDIA Shield compatibility.

## Overview

This project consists of:
- **Backend**: Express.js server that handles video scanning, metadata extraction, and video processing using FFmpeg
- **Frontend**: React application with Vite that provides a user-friendly interface for browsing directories, analyzing videos, and managing processing jobs

## Features

- **Directory Scanning**: Recursively scans directories for video files (MP4, MOV, M4V)
- **Rotation Detection**: Automatically detects rotation metadata in videos (especially iPhone videos)
- **Smart Suggestions**: Identifies videos that need rotation fixes or optimization
- **Video Processing**: Transcodes videos to fix rotation and optimize file size using FFmpeg
- **Progress Tracking**: Real-time progress updates for video processing jobs
- **File Browser**: Navigate through directories to find video files

## Prerequisites

- **Node.js**: Version 14 or higher
- **FFmpeg**: Must be installed and available in your system PATH
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt-get install ffmpeg` (Ubuntu/Debian) or use your distribution's package manager
  - Windows: Download from [FFmpeg website](https://ffmpeg.org/download.html) and add to PATH

## Installation

1. **Clone or navigate to the project directory**:
   ```bash
   cd /path/to/home-movie-processing
   ```

2. **Install dependencies**:
   ```bash
   # Install root dependencies (includes concurrently for running both services)
   npm install

   # Install backend dependencies
   cd backend
   npm install
   cd ..

   # Install frontend dependencies
   cd frontend
   npm install
   cd ..
   ```

   Alternatively, use the provided setup script:
   ```bash
   chmod +x setup.sh
   ./setup.sh
   ```

## Running the Application

### Option 1: Run Both Services Together (Recommended)

From the project root:
```bash
npm start
```

This will start both the backend (port 3001) and frontend (port 5173) services concurrently.

### Option 2: Run Services Separately

**Backend** (Terminal 1):
```bash
cd backend
node server.js
```

The backend will start on `http://localhost:3001`

**Frontend** (Terminal 2):
```bash
cd frontend
npm run dev
```

The frontend will start on `http://localhost:5173` (or the next available port)

### Accessing the Application

Once both services are running:
1. Open your browser and navigate to `http://localhost:5173`
2. The VidOrient dashboard will be displayed

## Project Structure

```
home-movie-processing/
├── backend/
│   ├── server.js          # Express server and API endpoints
│   ├── processor.js       # Video processing logic (FFmpeg operations)
│   ├── package.json       # Backend dependencies
│   └── node_modules/      # Backend dependencies (generated)
├── frontend/
│   ├── src/
│   │   ├── App.jsx        # Main React component
│   │   ├── App.css        # Application styles
│   │   ├── main.jsx       # React entry point
│   │   └── index.css      # Global styles
│   ├── public/            # Static assets
│   ├── package.json       # Frontend dependencies
│   ├── vite.config.js     # Vite configuration
│   └── node_modules/      # Frontend dependencies (generated)
├── package.json           # Root package.json with start scripts
├── setup.sh              # Setup script for dependencies
└── README.md             # This file
```

## API Endpoints

The backend provides the following REST API endpoints:

- `GET /api/scan?folder=<path>` - Scans a directory for video files and analyzes them
- `GET /api/browse?folder=<path>` - Lists subdirectories and files in a given folder
- `POST /api/process` - Starts processing a video file
  - Body: `{ fileId: string, options: { fixRotation: boolean, optimize: boolean } }`
- `GET /api/jobs` - Returns status of all processing jobs

## Development

### Backend Development

The backend uses:
- **Express.js** for the HTTP server
- **fluent-ffmpeg** for video processing
- **morgan** for request logging
- **cors** for cross-origin requests

Key files:
- `backend/server.js`: API routes and server setup
- `backend/processor.js`: Video scanning, metadata extraction, and transcoding logic

### Frontend Development

The frontend uses:
- **React 19** with hooks
- **Vite** for fast development and building
- **lucide-react** for icons

Key files:
- `frontend/src/App.jsx`: Main application component with all UI logic

### Hot Reload

Both services support hot reload:
- **Backend**: Restart manually when `server.js` or `processor.js` changes
- **Frontend**: Vite automatically reloads on file changes

## Building for Production

### Frontend Build

To build the frontend for production:
```bash
cd frontend
npm run build
```

The production build will be in `frontend/dist/`

### Preview Production Build

To preview the production build:
```bash
cd frontend
npm run preview
```

## Debugging

### Backend Debugging

1. **Check server logs**: The backend logs requests using morgan middleware. Check the terminal where the backend is running.

2. **Check server.log**: The backend may write logs to `backend/server.log` (if configured).

3. **Common issues**:
   - **FFmpeg not found**: Ensure FFmpeg is installed and in your PATH
   - **Port already in use**: Change the PORT environment variable or stop the conflicting service
   - **File access errors**: Ensure the application has read/write permissions for the directories you're scanning

4. **Enable verbose logging**: Modify `server.js` to add more console.log statements or use a logging library.

### Frontend Debugging

1. **Browser Developer Tools**: Open browser DevTools (F12) to see:
   - Console errors and warnings
   - Network requests to the backend
   - React component state (with React DevTools extension)

2. **Check API connectivity**: Ensure the frontend can reach `http://localhost:3001/api`

3. **Common issues**:
   - **CORS errors**: Backend should have CORS enabled (already configured)
   - **API connection refused**: Ensure backend is running on port 3001
   - **Build errors**: Run `npm run lint` in the frontend directory to check for linting issues

### Debugging Video Processing

1. **Check FFmpeg installation**:
   ```bash
   ffmpeg -version
   ffprobe -version
   ```

2. **Test video processing manually**:
   ```bash
   ffprobe /path/to/video.mp4
   ```

3. **Monitor processing jobs**: Use the `/api/jobs` endpoint or check the frontend UI for job status

## Environment Variables

- `PORT`: Backend server port (default: 3001)
  ```bash
  PORT=3001 node backend/server.js
  ```

## Troubleshooting

### Services Won't Start

1. **Check Node.js version**:
   ```bash
   node --version
   ```
   Should be 14 or higher.

2. **Reinstall dependencies**:
   ```bash
   rm -rf node_modules backend/node_modules frontend/node_modules
   npm install
   cd backend && npm install && cd ..
   cd frontend && npm install && cd ..
   ```

### FFmpeg Issues

1. **Verify FFmpeg is installed**:
   ```bash
   which ffmpeg
   which ffprobe
   ```

2. **Test FFmpeg with a video file**:
   ```bash
   ffprobe /path/to/test/video.mp4
   ```

### Port Conflicts

If port 3001 or 5173 are already in use:

1. **Backend**: Set PORT environment variable:
   ```bash
   PORT=3002 node backend/server.js
   ```
   Then update `frontend/src/App.jsx` to use the new port in `API_BASE`.

2. **Frontend**: Vite will automatically try the next available port, or specify in `vite.config.js`:
   ```javascript
   export default defineConfig({
     plugins: [react()],
     server: {
       port: 5174
     }
   })
   ```

## License

ISC

## Author

Home Movie Processing Tool - VidOrient

