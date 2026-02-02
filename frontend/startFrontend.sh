#!/bin/bash

# startFrontend.sh
# This script starts the VidOrient frontend development server with auto-reload.

# Color constants for better logging
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}>>> Starting VidOrient Frontend Development Server...${NC}"

# Ensure node_modules exists
if [ ! -d "node_modules" ]; then
    echo -e "${BLUE}>>> node_modules not found. Installing dependencies...${NC}"
    npm install
fi

# Run the vite dev server
# Vite provides built-in Hot Module Replacement (HMR) for auto-updating.
echo -e "${GREEN}>>> Vite dev server is running on http://localhost:5173${NC}"
npm run dev
