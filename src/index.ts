import { Hono } from "hono";
import { serveStatic } from "hono/bun";

const app = new Hono();

app.use("/public/*", serveStatic({ root: "./" }));

let players: Record<string, { name: string; count: number }> = {};
let dailyHistory: Record<string, Record<string, { name: string; count: number }>> = {};
let currentDay = new Date().toISOString().split("T")[0];
let gameActive = true;

function updateGameStatus() {
  const now = new Date();
  const hours = now.getUTCHours();
  const minutes = now.getUTCMinutes();
  const currentTime = hours * 60 + minutes;
  const cutoffTime = 21 * 60;

  gameActive = currentTime < cutoffTime;

  const newDay = new Date().toISOString().split("T")[0];
  if (newDay !== currentDay) {
    if (Object.keys(players).length > 0) {
      dailyHistory[currentDay] = { ...players };
    }
    currentDay = newDay;
    players = {};
    gameActive = true;
  }
}

app.post("/api/player/login", async (c) => {
  const { name } = await c.req.json();
  if (!name || name.trim().length === 0) {
    return c.json({ error: "Name required" }, 400);
  }

  const playerId = name.toLowerCase().replace(/\s+/g, "-");
  if (!players[playerId]) {
    players[playerId] = { name, count: 0 };
  }

  return c.json({ playerId, player: players[playerId] });
});

app.post("/api/increment", async (c) => {
  updateGameStatus();

  if (!gameActive) {
    return c.json({ error: "Game is closed for the day" }, 403);
  }

  const { playerId } = await c.req.json();
  if (!players[playerId]) {
    return c.json({ error: "Player not found" }, 404);
  }

  players[playerId].count++;

  return c.json({
    totalCount: Object.values(players).reduce((sum, p) => sum + p.count, 0),
    playerCount: players[playerId].count,
    rankings: getRankings(),
    gameActive,
  });
});

app.get("/api/state", (c) => {
  updateGameStatus();

  const totalCount = Object.values(players).reduce((sum, p) => sum + p.count, 0);
  const rankings = getRankings();

  return c.json({
    totalCount,
    rankings,
    gameActive,
    currentDay,
    players: Object.entries(players).map(([id, p]) => ({
      id,
      name: p.name,
      count: p.count,
    })),
  });
});

app.get("/api/history", (c) => {
  return c.json(dailyHistory);
});

function getRankings() {
  return Object.entries(players)
    .map(([id, p]) => ({ id, name: p.name, count: p.count }))
    .sort((a, b) => b.count - a.count);
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Number Game</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #000; color: #fff; overflow: hidden; }
    #bg-gif { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1; opacity: 0.3; object-fit: cover; pointer-events: none; }
    .container { position: relative; z-index: 1; width: 100%; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; background: rgba(0, 0, 0, 0.6); overflow-y: auto; }
    .login-screen { text-align: center; background: rgba(0, 0, 0, 0.8); padding: 40px; border-radius: 10px; border: 2px solid #00FF00; }
    .login-screen h1 { color: #00FF00; margin-bottom: 20px; font-size: 2.5em; }
    .login-screen input { padding: 12px; font-size: 1.1em; border: 2px solid #FF00FF; background: #000; color: #00FF00; border-radius: 5px; width: 100%; max-width: 300px; margin-bottom: 20px; }
    .login-screen button { padding: 12px 30px; font-size: 1.1em; background: #00FF00; color: #000; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; transition: all 0.3s; }
    .login-screen button:hover { background: #FF00FF; color: #fff; }
    .game-screen { display: none; text-align: center; width: 100%; max-width: 1200px; }
    .game-screen.active { display: flex; flex-direction: column; align-items: center; gap: 20px; }
    .counter { font-size: 4em; color: #00FF00; font-weight: bold; text-shadow: 0 0 20px #00FF00; }
    .player-count { font-size: 1.5em; color: #FF00FF; }
    .button-group { display: flex; gap: 20px; justify-content: center; flex-wrap: wrap; }
    .increment-btn { padding: 20px 40px; font-size: 1.5em; background: #00FF00; color: #000; border: none; border-radius: 10px; cursor: pointer; font-weight: bold; transition: all 0.3s; min-width: 200px; }
    .increment-btn:hover:not(:disabled) { background: #FF00FF; color: #fff; transform: scale(1.05); }
    .increment-btn:disabled { background: #666; color: #999; cursor: not-allowed; opacity: 0.5; }
    .nav-btn { padding: 10px 20px; font-size: 1em; background: #FF00FF; color: #fff; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; transition: all 0.3s; }
    .nav-btn:hover { background: #00FF00; color: #000; }
    .audio-btn { padding: 10px 16px; font-size: 1.1em; background: rgba(0, 0, 0, 0.7); color: #00FF00; border: 2px solid #00FF00; border-radius: 5px; cursor: pointer; font-weight: bold; transition: all 0.3s; min-width: 48px; }
    .audio-btn:hover { background: #00FF00; color: #000; }
    .rankings { background: rgba(0, 0, 0, 0.8); padding: 20px; border-radius: 10px; border: 2px solid #FF00FF; width: 100%; max-width: 600px; max-height: 300px; overflow-y: auto; }
    .rankings h2 { color: #00FF00; margin-bottom: 15px; }
    .ranking-item { display: flex; justify-content: space-between; padding: 10px; border-bottom: 1px solid #FF00FF; color: #fff; }
    .ranking-item:last-child { border-bottom: none; }
    .ranking-position { color: #00FF00; font-weight: bold; min-width: 30px; }
    .game-closed { background: rgba(0, 0, 0, 0.8); padding: 40px; border-radius: 10px; border: 2px solid #FF00FF; text-align: center; }
    .game-closed h2 { color: #FF00FF; font-size: 2em; margin-bottom: 20px; }
    .history-screen { display: none; width: 100%; max-width: 1200px; max-height: 80vh; overflow-y: auto; }
    .history-screen.active { display: block; }
    .history-day { background: rgba(0, 0, 0, 0.8); padding: 20px; margin-bottom: 20px; border-radius: 10px; border: 2px solid #00FF00; }
    .history-day h3 { color: #00FF00; margin-bottom: 15px; }
  </style>
</head>
<body>
  <img id="bg-gif" src="/public/bg.gif" alt="background" />
  <audio id="audio-player" loop></audio>
  <div class="container">
    <div class="login-screen" id="login-screen">
      <h1>🎮 Number Game</h1>
      <input type="text" id="player-name" placeholder="Enter your name" />
      <button onclick="login()">Play</button>
    </div>
    <div class="game-screen" id="game-screen">
      <div class="counter" id="counter">0</div>
      <div class="player-count" id="player-count">Your count: 0</div>
      <div class="button-group">
        <button class="increment-btn" id="increment-btn" onclick="increment()">+1</button>
        <button class="audio-btn" id="audio-btn" onclick="cycleAudio()" title="Change music">🎵</button>
        <button class="nav-btn" onclick="showHistory()">History</button>
      </div>
      <div class="rankings" id="rankings"></div>
    </div>
    <div class="game-closed" id="game-closed" style="display: none;">
      <h2>🏆 Today's Winners</h2>
      <div class="rankings" id="final-rankings"></div>
      <button class="nav-btn" onclick="showHistory()" style="margin-top: 20px;">View History</button>
    </div>
    <div class="history-screen" id="history-screen"></div>
  </div>
  <script>
    let playerId = null;

    const audioTracks = [
      null,
      '/public/audio/track001.mp3',
      '/public/audio/track002.mp3',
      '/public/audio/track003.mp3',
      '/public/audio/track004.mp3',
      '/public/audio/track005.mp3',
    ];
    const audioLabels = ['🔇', '🎵', '🎶', '🎸'];
    let currentTrackIndex = 0;

    function cycleAudio() {
      currentTrackIndex = (currentTrackIndex + 1) % audioTracks.length;
      const player = document.getElementById('audio-player');
      const btn = document.getElementById('audio-btn');
      const track = audioTracks[currentTrackIndex];
      btn.textContent = audioLabels[currentTrackIndex];
      if (track === null) {
        player.pause();
        player.src = '';
      } else {
        player.src = track;
        player.play().catch(() => {});
      }
    }

    async function login() {
      const name = document.getElementById('player-name').value.trim();
      if (!name) return;
      const res = await fetch('/api/player/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      playerId = data.playerId;
      localStorage.setItem('playerName', name);
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('game-screen').classList.add('active');
      updateState();
      setInterval(updateState, 1000);
    }
    async function increment() {
      const res = await fetch('/api/increment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId })
      });
      if (res.ok) {
        const data = await res.json();
        updateUI(data);
      }
    }
    async function updateState() {
      const res = await fetch('/api/state');
      const data = await res.json();
      updateUI(data);
    }
    function updateUI(data) {
      document.getElementById('counter').textContent = data.totalCount;
      const player = data.players.find(p => p.id === playerId);
      if (player) {
        document.getElementById('player-count').textContent = \`Your count: \${player.count}\`;
      }
      const btn = document.getElementById('increment-btn');
      btn.disabled = !data.gameActive;
      if (!data.gameActive) {
        document.getElementById('game-screen').classList.remove('active');
        document.getElementById('game-closed').style.display = 'block';
        const finalRankings = document.getElementById('final-rankings');
        finalRankings.innerHTML = '<h2 style="color: #00FF00; margin-bottom: 15px;">Leaderboard</h2>' + data.rankings.map((p, i) =>
          \`<div class="ranking-item"><span class="ranking-position">#\${i + 1}</span><span>\${p.name}</span><span>\${p.count}</span></div>\`
        ).join('');
      } else {
        const rankingsEl = document.getElementById('rankings');
        rankingsEl.innerHTML = '<h2>Live Rankings</h2>' + data.rankings.map((p, i) =>
          \`<div class="ranking-item"><span class="ranking-position">#\${i + 1}</span><span>\${p.name}</span><span>\${p.count}</span></div>\`
        ).join('');
      }
    }
    async function showHistory() {
      const res = await fetch('/api/history');
      const history = await res.json();
      document.getElementById('game-screen').classList.remove('active');
      document.getElementById('game-closed').style.display = 'none';
      const historyScreen = document.getElementById('history-screen');
      historyScreen.classList.add('active');
      if (Object.keys(history).length === 0) {
        historyScreen.innerHTML = '<button class="nav-btn" onclick="location.reload()" style="margin-bottom: 20px;">Back</button><div style="text-align: center; color: #FF00FF; font-size: 1.2em;">No history yet</div>';
      } else {
        historyScreen.innerHTML = '<button class="nav-btn" onclick="location.reload()" style="margin-bottom: 20px;">Back</button>' + Object.entries(history).reverse().map(([day, players]) =>
          '<div class="history-day"><h3>📅 ' + day + '</h3>' + Object.entries(players).sort((a, b) => b[1].count - a[1].count).map(([id, player], idx) =>
            '<div class="ranking-item"><span class="ranking-position">#' + (idx + 1) + '</span><span>' + player.name + '</span><span>' + player.count + '</span></div>'
          ).join('') + '</div>'
        ).join('');
      }
    }
    const saved = localStorage.getItem('playerName');
    if (saved) {
      document.getElementById('player-name').value = saved;
    }
    document.getElementById('player-name').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') login();
    });
  </script>
</body>
</html>`;

app.get("/", (c) => c.html(html));
app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
