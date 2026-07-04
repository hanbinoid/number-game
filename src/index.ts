import { Hono } from "hono";
import { serveStatic } from "hono/bun";

const app = new Hono();

// ── Config ──────────────────────────────────────────────────────────────────

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? "";
const VAPID_SUBJECT = "mailto:admin@example.com"; // change to your email

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL ?? "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? "";

// ── Redis helpers ────────────────────────────────────────────────────────────

async function redisGet<T>(key: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const data = await res.json() as { result: string | null };
    if (data.result === null) return fallback;
    return JSON.parse(data.result) as T;
  } catch (e) {
    console.error(`Redis GET ${key} failed:`, e);
    return fallback;
  }
}

async function redisSet(key: string, value: unknown): Promise<void> {
  try {
    await fetch(`${REDIS_URL}/set/${key}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value: JSON.stringify(value) }),
    });
  } catch (e) {
    console.error(`Redis SET ${key} failed:`, e);
  }
}

// ── State ────────────────────────────────────────────────────────────────────

let players: Record<string, { name: string; count: number }> = {};
let dailyHistory: Record<string, Record<string, { name: string; count: number }>> = {};
let subscriptions: Record<string, PushSubscriptionJSON> = {};
let allTimeBase: number = 0;
let currentDay = new Date().toISOString().split("T")[0];
let gameActive = true;
let stateLoaded = false;

async function ensureStateLoaded() {
  if (stateLoaded) return;
  const [loadedHistory, loadedSubscriptions, loadedAllTimeBase, loadedPlayers] = await Promise.all([
    redisGet("history", {} as Record<string, Record<string, { name: string; count: number }>>),
    redisGet("subscriptions", {} as Record<string, PushSubscriptionJSON>),
    redisGet("allTimeBase", 0),
    redisGet("players", {} as Record<string, { name: string; count: number }>),
  ]);

  dailyHistory = loadedHistory && typeof loadedHistory === "object" ? loadedHistory : {};
  subscriptions = loadedSubscriptions && typeof loadedSubscriptions === "object" ? loadedSubscriptions : {};

  const numericAllTimeBase = Number(loadedAllTimeBase);
  if (Number.isFinite(numericAllTimeBase)) {
    allTimeBase = numericAllTimeBase;
  } else {
    console.warn(`Corrupt allTimeBase in Redis (was ${JSON.stringify(loadedAllTimeBase)}), resetting to 0`);
    allTimeBase = 0;
    redisSet("allTimeBase", 0);
  }

  players = {};
  if (loadedPlayers && typeof loadedPlayers === "object") {
    for (const [id, p] of Object.entries(loadedPlayers)) {
      const count = Number((p as any)?.count);
      if (p && typeof (p as any).name === "string" && Number.isFinite(count)) {
        players[id] = { name: (p as any).name, count };
      } else {
        console.warn(`Dropping corrupt player entry "${id}":`, p);
      }
    }
  }

  ensureBotsExist();
  stateLoaded = true;
}

// ── Game logic ───────────────────────────────────────────────────────────────

function updateGameStatus() {
  const now = new Date();
  const currentTime = now.getUTCHours() * 60 + now.getUTCMinutes();
  gameActive = currentTime < 22 * 60;

  const newDay = new Date().toISOString().split("T")[0];
  if (newDay !== currentDay) {
    if (Object.keys(players).length > 0) {
      dailyHistory[currentDay] = { ...players };
      redisSet("history", dailyHistory);
      const dayTotal = Object.values(players).reduce(
        (sum, p) => sum + (Number.isFinite(p.count) ? p.count : 0),
        0
      );
      allTimeBase += dayTotal;
      redisSet("allTimeBase", allTimeBase);
    }
    currentDay = newDay;
    players = {};
    ensureBotsExist();
    gameActive = true;
    redisSet("players", players);
  }

  if (gameActive) tickBots();
}

function getRankings() {
  return Object.entries(players)
    .map(([id, p]) => ({ id, name: p.name, count: p.count }))
    .sort((a, b) => b.count - a.count);
}

function sanitizeName(name: string): string {
  return name
    .trim()
    .replace(/[^0-9]/g, "")
    .slice(0, 20);
}

// ── Bot players ──────────────────────────────────────────────────────────────
// Fake "players" that quietly rack up points on their own, so the leaderboard
// never feels empty/static. Each one just needs a 9-digit id/name and a
// tickChance (the odds it increments by 1 on any given check). Add more bots
// to this array later if you want a bigger "crowd".

interface BotConfig {
  id: string;
  tickChance: number;
}

const BOTS: BotConfig[] = [
  { id: "482917364", tickChance: 0.12 },
];

function ensureBotsExist() {
  for (const bot of BOTS) {
    if (!players[bot.id]) {
      players[bot.id] = { name: bot.id, count: 0 };
    }
  }
}

function tickBots() {
  let changed = false;
  for (const bot of BOTS) {
    if (!players[bot.id]) continue;
    if (Math.random() < bot.tickChance) {
      players[bot.id].count++;
      changed = true;
    }
  }
  if (changed) redisSet("players", players);
}

// ── VAPID / Push helpers ─────────────────────────────────────────────────────

function base64urlToUint8Array(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function uint8ArrayToBase64url(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function buildVapidAuthorization(audience: string): Promise<string> {
  const header = uint8ArrayToBase64url(
    new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" }))
  );
  const now = Math.floor(Date.now() / 1000);
  const payload = uint8ArrayToBase64url(
    new TextEncoder().encode(
      JSON.stringify({ aud: audience, exp: now + 3600, sub: VAPID_SUBJECT })
    )
  );
  const signingInput = `${header}.${payload}`;
  const keyData = base64urlToUint8Array(VAPID_PRIVATE_KEY);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${uint8ArrayToBase64url(new Uint8Array(signature))}`;
  return `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`;
}

async function sendPushNotification(
  subscription: PushSubscriptionJSON,
  title: string,
  body: string
): Promise<boolean> {
  try {
    const endpoint = subscription.endpoint!;
    const audience = new URL(endpoint).origin;
    const authorization = await buildVapidAuthorization(audience);
    const payload = new TextEncoder().encode(JSON.stringify({ title, body }));
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(payload.length),
        TTL: "60",
      },
      body: payload,
    });
    console.log(`Push response: ${res.status} ${res.statusText}`);
    if (res.status === 410) return false;
    return true;
  } catch (e) {
    console.error("Push error:", e);
    return false;
  }
}

async function notifyOvertaken(overtakenId: string) {
  console.log(`notifyOvertaken called for: ${overtakenId}`);
  const sub = subscriptions[overtakenId];
  if (!sub) {
    console.log(`No subscription found for: ${overtakenId}`);
    return;
  }
  console.log(`Sending push to: ${overtakenId}`);
  const ok = await sendPushNotification(
    sub,
    "Number Game",
    `${players[overtakenId]?.name ?? "You"} has been overtaken! Fight back!`
  );
  console.log(`Push result for ${overtakenId}: ${ok}`);
  if (!ok) {
    delete subscriptions[overtakenId];
    redisSet("subscriptions", subscriptions);
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.use("/public/*", serveStatic({ root: "./" }));

app.get("/service-worker.js", serveStatic({ path: "./public/service-worker.js" }));

app.post("/api/player/login", async (c) => {
  await ensureStateLoaded();
  const { name } = await c.req.json();
  if (!name || name.trim().length === 0) {
    return c.json({ error: "Name required" }, 400);
  }

  const sanitized = sanitizeName(name);
  if (!sanitized) {
    return c.json({ error: "Invalid ID Number" }, 400);
  }
if (sanitized.length < 4) {
  return c.json({ error: "ID must be at least 4 digits" }, 400);
}

  const playerId = sanitized.toLowerCase().replace(/\s+/g, "-");
  if (BOTS.some((bot) => bot.id === playerId)) {
    return c.json({ error: "That ID is taken, please choose another" }, 400);
  }
  if (!players[playerId]) {
    players[playerId] = { name: sanitized, count: 0 };
  }

  return c.json({ playerId, player: players[playerId], vapidPublicKey: VAPID_PUBLIC_KEY });
});

app.post("/api/subscribe", async (c) => {
  const { playerId, subscription } = await c.req.json();
  if (!playerId || !subscription?.endpoint) {
    return c.json({ error: "Invalid subscription" }, 400);
  }
  subscriptions[playerId] = subscription;
  redisSet("subscriptions", subscriptions);
  return c.json({ ok: true });
});

app.post("/api/increment", async (c) => {
  await ensureStateLoaded();
  updateGameStatus();
  if (!gameActive) return c.json({ error: "Game is closed for the day" }, 403);

  const { playerId } = await c.req.json();
  if (!players[playerId]) return c.json({ error: "Player not found" }, 404);

  const rankingsBefore = getRankings();
  const positionBefore = rankingsBefore.findIndex((p) => p.id === playerId);

  players[playerId].count++;
  redisSet("players", players);

  const rankingsAfter = getRankings();
  const positionAfter = rankingsAfter.findIndex((p) => p.id === playerId);

  console.log(`Position before: ${positionBefore}, after: ${positionAfter}`);
  if (positionAfter < positionBefore) {
    for (let i = positionAfter; i < positionBefore; i++) {
      const overtaken = rankingsAfter[i + 1];
      console.log(`Checking overtake at position ${i + 1}:`, overtaken?.id);
      if (overtaken && overtaken.id !== playerId) {
        notifyOvertaken(overtaken.id);
      }
    }
  }

  return c.json({
  totalCount: Object.values(players).reduce((sum, p) => sum + (Number.isFinite(p.count) ? p.count : 0), 0),
  allTimeTotal: allTimeBase + Object.values(players).reduce((sum, p) => sum + (Number.isFinite(p.count) ? p.count : 0), 0),
  playerCount: players[playerId].count,
  rankings: rankingsAfter,
  gameActive,
  });
});

app.get("/api/state", async (c) => {
  await ensureStateLoaded();
  updateGameStatus();
  const todayTotal = Object.values(players).reduce((sum, p) => sum + (Number.isFinite(p.count) ? p.count : 0), 0);
  return c.json({
    totalCount: todayTotal,
    allTimeTotal: allTimeBase + todayTotal,
    rankings: getRankings(),
    gameActive,
    currentDay,
    players: Object.entries(players).map(([id, p]) => ({ id, name: p.name, count: p.count })),
  });
});

app.get("/api/history", async (c) => {
  await ensureStateLoaded();
  return c.json(dailyHistory);
});

// ── Frontend ─────────────────────────────────────────────────────────────────

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no">
  <title>Number Game</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #000; color: #fff; overflow: hidden; touch-action: manipulation;}
    #bg-gif { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1; opacity: 0.5; object-fit: cover; pointer-events: none; }
    .container { position: relative; z-index: 1; width: 100%; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; background: rgba(0, 0, 0, 0.4); overflow-y: auto; }
    .login-screen { text-align: center; background: rgba(0, 0, 0, 0.8); padding: 40px; border-radius: 10px; border: 2px solid #00FF00; }
    .login-screen h1 { color: #00FF00; margin-bottom: 20px; font-size: 2.5em; }
    .login-screen input { padding: 12px; font-size: 1.1em; border: 2px solid #FF00FF; background: #000; color: #00FF00; border-radius: 5px; width: 100%; max-width: 300px; margin-bottom: 20px; }
    .login-screen button { padding: 12px 30px; font-size: 1.1em; background: #00FF00; color: #000; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; transition: all 0.3s; }
    .login-screen button:hover { background: #FF00FF; color: #fff; }
    .game-screen { display: none; text-align: center; width: 100%; max-width: 1200px; }
    .game-screen.active { display: flex; flex-direction: column; align-items: center; gap: 20px; }
    .counter { font-size: 4em; color: #00FF00; font-weight: bold; text-shadow: 0 0 20px #00FF00; }
    .alltime-total { font-size: 1.2em; color: #FFD700; letter-spacing: 1px; margin-top: -10px; }
    .player-count { font-size: 1.5em; color: #FF00FF; }
    .button-group { display: flex; gap: 20px; justify-content: center; flex-wrap: wrap; }
    .increment-btn { padding: 20px 40px; font-size: 1.5em; background: #00FF00; color: #000; border: none; border-radius: 10px; cursor: pointer; font-weight: bold; transition: all 0.3s; min-width: 200px; }
    .increment-btn:hover:not(:disabled) { background: #FF00FF; color: #fff; transform: scale(1.05); }
    .increment-btn:disabled { background: #666; color: #999; cursor: not-allowed; opacity: 0.5; }
    .nav-btn { padding: 10px 20px; font-size: 1em; background: #FF00FF; color: #fff; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; transition: all 0.3s; }
    .nav-btn:hover { background: #00FF00; color: #000; }
    .audio-btn { padding: 10px 16px; font-size: 1.1em; background: rgba(0, 0, 0, 0.7); color: #00FF00; border: 2px solid #00FF00; border-radius: 5px; cursor: pointer; font-weight: bold; transition: all 0.3s; min-width: 48px; }
    .audio-btn:hover { background: #00FF00; color: #000; }
    .rankings { background: rgba(0, 0, 0, 0.8); padding: 20px; border-radius: 10px; border: 2px solid #FF00FF; width: 100%; max-width: 600px; max-height: 100px; overflow-y: auto; }
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
<p style="color: #00FF00; font-size: 1em; margin-bottom: 20px;">Enter your ID number</p>
      <input type="text" id="player-name" placeholder="e.g. 1234" inputmode="numeric" />
<p style="color: #FF00FF; font-size: 0.85em; margin-top: -10px; margin-bottom: 20px;">Choose a number you will remember. 4+ digits</p>
<button onclick="login()">Play</button>
    </div>
    <div class="game-screen" id="game-screen">
      <div class="counter" id="counter">0</div>
      <div class="alltime-total" id="alltime-total">All-time: 0</div>
      <div class="player-count" id="player-count">Your count: 0</div>
      <div class="button-group">
        <button class="increment-btn" id="increment-btn" onclick="increment()">+1</button>
        <button class="audio-btn" id="audio-btn" onclick="cycleAudio()" title="Change music">🎵</button>
      </div>
      <div class="rankings" id="rankings"></div>
      <div class="button-group"><button class="nav-btn" onclick="showHistory()">History</button></div>
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
    let vapidPublicKey = null;

    const audioTracks = [
      null,
      '/public/audio/track001.mp3',
      '/public/audio/track002.mp3',
      '/public/audio/track003.mp3',
      '/public/audio/track004.mp3',
      '/public/audio/track005.mp3',
    ];
    const audioLabels = ['🔇', '🎵', '🎵', '🎵', '🎵', '🎵'];
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

    function urlBase64ToUint8Array(base64String) {
      const padding = '='.repeat((4 - base64String.length % 4) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const rawData = atob(base64);
      return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
    }

    async function registerPush(key) {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
      try {
        const reg = await navigator.serviceWorker.register('/service-worker.js');
        await navigator.serviceWorker.ready;
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key),
        });
        await fetch('/api/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerId, subscription: sub.toJSON() }),
        });
      } catch (e) {
        console.warn('Push registration failed:', e);
      }
    }

    async function login() {
  const name = document.getElementById('player-name').value.trim();
  if (!name) return;
  if (name.length < 4 || isNaN(Number(name))) {
    alert('Please enter a number with at least 4 digits.');
    return;
  }
      const res = await fetch('/api/player/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
        return;
      }
      playerId = data.playerId;
      vapidPublicKey = data.vapidPublicKey;
      localStorage.setItem('playerName', name);
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('game-screen').classList.add('active');
      updateState();
      setInterval(updateState, 1000);
      registerPush(vapidPublicKey);
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
      document.getElementById('alltime-total').textContent = \`All-time total: \${data.allTimeTotal}\`;
      const player = data.players?.find(p => p.id === playerId);
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
        rankingsEl.innerHTML = data.rankings.map((p, i) =>
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
        historyScreen.innerHTML = '<button class="nav-btn" onclick="location.reload()" style="margin-bottom: 20px;">Back</button>' +
          Object.entries(history).reverse().map(([day, players]) =>
            '<div class="history-day"><h3>📅 ' + day + '</h3>' +
            Object.entries(players).sort((a, b) => b[1].count - a[1].count).map(([id, player], idx) =>
              '<div class="ranking-item"><span class="ranking-position">#' + (idx + 1) + '</span><span>' +
              player.name + '</span><span>' + player.count + '</span></div>'
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
