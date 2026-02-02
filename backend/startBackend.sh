#!/bin/bash

# startBackend.sh - Start the VidOrient backend server with hot reload
# This script uses nodemon to automatically restart the server when code changes

cd "$(dirname "$0")"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed. Please install Node.js."
    exit 1
fi

# Check if node_modules exists, install if not
if [ ! -d "node_modules" ]; then
    echo "Installing backend dependencies..."
    npm install
fi

echo "🚀 Starting VidOrient Backend with hot reload..."
echo "📍 Backend will be available at http://localhost:3001"
echo "🔄 Server will automatically restart when you modify server.js or processor.js"
echo "⏹️  Press Ctrl+C to stop"
echo ""

# Use nodemon (via npm script) to watch for changes and auto-restart
# nodemon.json config file specifies what to watch
npm run dev
