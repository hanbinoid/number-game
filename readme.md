# Number Game

A fun family number game where players compete to add the most numbers each day.

## Features

- 🎮 Real-time multiplayer gameplay (up to 30 players)
- 📊 Live rankings and leaderboard
- 📅 Daily reset at 21:00 GMT
- 🎥 YouTube video background with audio control
- 💾 Player name persistence
- 📈 Historical leaderboard view
- 🎨 Modern green & purple UI

## Setup

1. Clone this repo
2. Install dependencies: `bun install`
3. Update the YouTube URL in `src/index.ts` (line with `YOUR_YOUTUBE_URL_HERE`)
4. Run locally: `bun run dev`
5. Deploy to Railway (see below)

## Deploy to Railway

1. Push this repo to GitHub
2. Go to [railway.com](https://railway.com)
3. Click "New Project" → "Deploy from GitHub"
4. Select this repo
5. Railway auto-detects Bun and deploys!