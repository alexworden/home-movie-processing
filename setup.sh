#!/bin/bash

# setup.sh - VidOrient Launcher
# This script ensures all dependencies are installed and starts both the frontend and backend.

echo "🚀 Initializing VidOrient..."

# Check if Node modules exist, if not install them
if [ ! -d "node_modules" ]; then
    echo "Installing root dependencies..."
    npm install
fi

if [ ! -d "backend/node_modules" ]; then
    echo "Installing backend dependencies..."
    (cd backend && npm install)
fi

if [ ! -d "frontend/node_modules" ]; then
    echo "Installing frontend dependencies..."
    (cd frontend && npm install)
fi

echo "✅ Dependencies verified."
echo "🌟 Starting VidOrient Dashboard..."
echo "Backend: http://localhost:3001"
echo "Frontend: http://localhost:5173"

# Start the application
npm start
