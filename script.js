// === RealSocket wrapper (replaces WebsimSocket) ===
const SERVER_URL = "wss://tiled-io-server.onrender.com";

class RealSocket {
  constructor(roomName) {
    this.roomName = roomName;
    this.ws = null;

    this.clientId = null;
    this.presence = {};
    this.roomState = {};
    this.peers = {};

    this._presenceSubs = [];
    this._roomStateSubs = [];
    this._presenceUpdateRequestSubs = [];

    this.onmessage = null;
  }

  async initialize() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${SERVER_URL}?room=${encodeURIComponent(this.roomName)}`);
      this.ws = ws;

      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

if (msg.type === "init") {
  multiplayer.clientId = msg.clientId;
  multiplayer.presence = msg.presence || {};
  multiplayer.roomState = msg.roomState || {};
  multiplayer.peers = msg.peers || {};

  

  resolve();
  return;
}


        if (msg.type === "presence") {
  multiplayer.presence = msg.presence || {};
  reconcilePresence(multiplayer.presence);
  return;
}


        if (msg.type === "room_state") {
  multiplayer.roomState = msg.roomState || {};
  applyRoomState(multiplayer.roomState);
  return;
}


        if (msg.type === "presence_update_request") {
          this._presenceUpdateRequestSubs.forEach(cb => cb(msg.payload, msg.fromClientId));
          return;
        }

        if (this.onmessage) {
          this.onmessage({ data: msg });
        }
      };

      ws.onerror = reject;
    });
  }

  updatePresence(data, targetId) {
    this.ws?.send(JSON.stringify({ type: "update_presence", data, targetId }));
  }

  updateRoomState(data) {
    this.ws?.send(JSON.stringify({ type: "update_room_state", data }));
  }

  subscribePresence(cb) { this._presenceSubs.push(cb); }
  subscribeRoomState(cb) { this._roomStateSubs.push(cb); }
  subscribePresenceUpdateRequests(cb) { this._presenceUpdateRequestSubs.push(cb); }

  requestPresenceUpdate(targetId, payload) {
    this.ws?.send(JSON.stringify({ type: "request_presence_update", targetId, payload }));
  }

  send(payload) {
    this.ws?.send(JSON.stringify({ type: "event", payload }));
  }
}
// === Multiplayer state (replaces Websim room) ===
const multiplayer = {
  clientId: null,
  presence: {},
  roomState: {},
  peers: {}
};


const VIEW = document.getElementById('viewport');
const grid = document.getElementById('grid');
const overlay = document.getElementById('overlay');
const countdownEl = document.getElementById('match-countdown');
const countdownTimer = document.getElementById('countdown-timer');
const leaderList = document.getElementById('leader-list');

 // preloaded movement sound for local player moves (use provided pop SFX)
const moveSfx = new Audio('ui-pop-sound-316482.mp3');
moveSfx.volume = 0.9;
moveSfx.preload = 'auto';

 // preloaded eat and death sounds
const eatSfx = new Audio('roblox-eating-sound-effect-nom-nom-nom (1).mp3');
eatSfx.volume = 0.9;
eatSfx.preload = 'auto';

const deathSfx = new Audio('death.mp3');
deathSfx.volume = 0.9;
deathSfx.preload = 'auto';

// axe-related sounds
const crowbarSfx = new Audio('hcrowbar.mp3'); // wall-breaking sound
crowbarSfx.volume = 0.9;
crowbarSfx.preload = 'auto';

const selectSfx = new Audio('Select.wav'); // axe pickup sound
selectSfx.volume = 0.9;
selectSfx.preload = 'auto';

const MAP_COLS = 50;
const MAP_ROWS = 50;

let cols = MAP_COLS;
let rows = MAP_ROWS;
let tilePx = 32; // computed
let logicalTileSize = 32; // authoritative tile size used for positioning
const clientEls = {};
let room = null;
let localNickname = localStorage.getItem('nickname') || null;

// lightweight cache of usernames observed from connection events or presence payloads.
// Some clients/accounts may not appear immediately in multiplayer.peers; prefer presence.username
// then this cache, then peers to ensure labels are shown globally.
const remoteUsernames = {};

// state guards / performance helpers
let lastMapSeed = null;           // avoid regenerating tiles unless map seed changes
let localControlsBound = false;   // avoid binding controls multiple times
let lastLocalMove = 0;            // movement cooldown timestamp (ms)

// Smooth camera state for lerp animation
const camera = {
  targetX: 0,
  targetY: 0,
  x: 0,
  y: 0,
  easing: 0.14,
  running: false
};

// utility color and id helpers
function getRandomColor() {
  const h = Math.floor(Math.random() * 360);
  const s = 65 + Math.floor(Math.random() * 20);
  const l = 45 + Math.floor(Math.random() * 10);
  return `hsl(${h} ${s}% ${l}%)`;
}

// deterministic color fallback for peers without an explicit color in their presence
function colorForUser(username, clientId) {
  // create a stable hash from username (fall back to clientId)
  const key = String(username || clientId || '').trim() || String(clientId);
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  h = Math.abs(h) % 360;
  const s = 62;
  const l = 52;
  return `hsl(${h} ${s}% ${l}%)`;
}

/* chooseMatchMode: always resolve to either 'normal' or 'main' (no 'random' placeholder).
   We use a simple 50/50 split so every reset deterministically picks one of the two gameplay modes. */
function chooseMatchMode() {
  return (Math.random() < 0.5) ? 'main' : 'normal';
}

function keyFor(r,c){return `${r}:${c}`;}

// create player DOM node
function createPlayerElement(clientId, isLocal = false){
  let el = clientEls[clientId];
  if (el) return el;
  el = document.createElement('div');
  el.className = 'player' + (isLocal ? ' local' : '');
  el.setAttribute('data-client-id', clientId);

  const label = document.createElement('div');
  label.className = 'player-label';
  label.textContent = '';
  el.appendChild(label);

  const content = document.createElement('div');
  content.className = 'player-content';
  content.style.pointerEvents = 'none';
  content.style.zIndex = '2';
  el.appendChild(content);

  const popup = document.createElement('div');
  popup.className = 'popup';
  popup.textContent = '';
  el.appendChild(popup);

  // Ensure a dedicated avatar layer so we can apply images for specific accounts
  // (we style the element background directly when positioning, but keep a placeholder class)
  el.classList.add('player-has-avatar');

  // attach players to the grid so they move together with grid transforms
  grid.appendChild(el);
  clientEls[clientId] = el;
  return el;
}
function removePlayerElement(clientId){
  const el = clientEls[clientId];
  if (!el) return;
  el.remove();
  delete clientEls[clientId];
}

// position and scale a player element; also updates displayed number
function positionClientElement(clientId, r, c, color, value = 1, instant = false){
  const el = clientEls[clientId];
  if (!el) return;
  r = Math.max(0, Math.min(rows - 1, r));
  c = Math.max(0, Math.min(cols - 1, c));

  // compute tile centers using logical tile size and grid padding/gap
  const gap = parseInt(getComputedStyle(grid).getPropertyValue('gap')) || 0;
  const pad = parseInt(getComputedStyle(grid).getPropertyValue('padding')) || 0;
  const tileSize = logicalTileSize;
  const gridOffsetX = pad;
  const gridOffsetY = pad;

  // center within grid coordinates (before grid transform)
  const centerX = gridOffsetX + c * (tileSize + gap) + tileSize / 2;
  const centerY = gridOffsetY + r * (tileSize + gap) + tileSize / 2;

  // scale based on value (slightly larger growth) — removed hard cap so growth is unbounded
  const size = Math.round(tileSize * (0.62 + (Math.log2(value+1)/5)));
  tilePx = tileSize;
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;

  // set color and border for player square (no special-case accounts)
  const peer = room && multiplayer.peers ? multiplayer.peers[clientId] : null;
  if (color) {
    el.style.background = color;
  } else {
    // fallback deterministic color if none provided
    el.style.background = colorForUser(peer ? (peer.username || '') : clientId, clientId);
  }
  el.style.borderColor = 'rgba(0,0,0,0.25)';

  // px/py are coordinates relative to the grid element (absolute positioning inside grid)
  const px = Math.round(centerX - size / 2);
  const py = Math.round(centerY - size / 2);

  const pc = el.querySelector('.player-content');
  if (pc) pc.textContent = String(value);

  // Position the player element (translate within grid)
  if (instant) {
    el.style.transition = 'none';
    el.style.transform = `translate3d(${px}px, ${py}px, 0)`;
    // force reflow
    el.offsetHeight;
    el.style.transition = '';
  } else {
    el.style.transform = `translate3d(${px}px, ${py}px, 0)`;
  }

  // Explicitly anchor the name label using the computed size so it stays aligned in real time.
  // Use pixel coordinates relative to the player element to avoid drifting from transforms/scale.
  try {
    const labelEl = el.querySelector('.player-label');
    if (labelEl) {
      // Center horizontally over the player and position slightly above (use player's height/2)
      labelEl.style.left = `${Math.round(size / 2)}px`;
      labelEl.style.top = `${-12}px`;
      labelEl.style.transform = 'translateX(-50%)';
      labelEl.style.pointerEvents = 'none';
    }
  } catch (err) { /* ignore label positioning errors */ }
}

// generate full map tiles based on MAP_COLS/ROWS and room state (walls/dots)
function applyWallsToDOM(walls = {}) {
  // Apply or remove .wall classes on tiles to match the provided walls object (truthy => wall)
  try {
    // iterate all tiles and sync classes
    const allTiles = document.querySelectorAll('.tile');
    allTiles.forEach(t => {
      const r = Number(t.dataset.r);
      const c = Number(t.dataset.c);
      const k = keyFor(r, c);
      if (walls && walls[k]) {
        t.classList.add('wall');
      } else {
        t.classList.remove('wall');
      }
    });
  } catch (err) {
    // ignore DOM sync errors
    console.warn('applyWallsToDOM error', err);
  }
}

// Apply axes DOM state to match authoritative room state: add missing axes and remove ones that no longer exist.
function applyAxesToDOM(axes = {}) {
  try {
    // remove axe items that no longer exist in state
    const allAxes = document.querySelectorAll('.axe-item');
    allAxes.forEach(img => {
      const tile = img.closest('.tile');
      if (!tile) return;
      const r = Number(tile.dataset.r);
      const c = Number(tile.dataset.c);
      const k = keyFor(r, c);
      if (!axes || !axes[k]) {
        if (img.parentNode) img.parentNode.removeChild(img);
      }
    });

    // ensure axes present in state are rendered
    if (axes) {
      for (const k in axes) {
        const a = axes[k];
        if (!a) continue;
        const el = document.querySelector(`.tile[data-r="${a.r}"][data-c="${a.c}"]`);
        if (el) {
          // ensure only one axe node per tile
          if (el.querySelector('.axe-item')) continue;
          const img = document.createElement('img');
          img.className = 'axe-item';
          img.src = 'Stone_Axe_JE2_BE2.png';
          img.style.position = 'absolute';
          img.style.width = `${Math.max(28, Math.round(logicalTileSize * 0.72))}px`;
          img.style.height = 'auto';
          img.style.left = '50%';
          img.style.top = '50%';
          img.style.transform = 'translate(-50%,-50%)';
          img.style.pointerEvents = 'none';
          img.style.imageRendering = 'pixelated';
          el.appendChild(img);
        }
      }
    }
  } catch (e) {
    console.warn('applyAxesToDOM error', e);
  }
}

function generateTiles(stateOverride) {
  grid.innerHTML = '';

  // compute a fixed tile size so the full map fits within viewport (keeps resolution)
  const candidateCols = Math.min(MAP_COLS, Math.max(8, Math.floor(window.innerWidth / 48)));
  const candidateRows = Math.min(MAP_ROWS, Math.max(6, Math.floor(window.innerHeight / 48)));
  const tileW = Math.floor(window.innerWidth / candidateCols);
  const tileH = Math.floor(window.innerHeight / candidateRows);
  const tileSize = Math.min(tileW, tileH);

  logicalTileSize = tileSize; // save authoritative tile size for positioning
  grid.style.gridTemplateColumns = `repeat(${MAP_COLS}, ${tileSize}px)`;
  grid.style.gridAutoRows = `${tileSize}px`;

  // create tiles with coordinates
  for (let r = 0; r < MAP_ROWS; r++) {
    for (let c = 0; c < MAP_COLS; c++) {
      const t = document.createElement('div');
      t.className = 'tile';
      t.dataset.r = r;
      t.dataset.c = c;

      // subtle two-tone
      if ((r + c) % 2 === 0) {
        t.style.background = 'linear-gradient(180deg,#9b9b9b 0%, #b0b0b0 100%)';
      } else {
        t.style.background = 'linear-gradient(180deg,#a8a8a8 0%, #c0c0c0 100%)';
      }

      grid.appendChild(t);
    }
  }

  // determine which state to use
  const state = stateOverride || (room && multiplayer.roomState) || {};

  // apply walls
  applyWallsToDOM(state.walls || {});

  // apply axes
  applyAxesToDOM(state.axes || {});

  // render dots + triangles
  if (state.dots) {
    for (const k in state.dots) {
      const p = state.dots[k];
      if (!p) continue;

      const el = document.querySelector(`.tile[data-r="${p.r}"][data-c="${p.c}"]`);
      if (!el) continue;

      if (p.type === 'triangle') {
        const tri = document.createElement('div');
        tri.className = 'triangle';
        tri.style.position = 'absolute';
        tri.style.left = '50%';
        tri.style.top = '50%';
        tri.style.transform = 'translate(-50%,-50%)';
        tri.style.width = '0';
        tri.style.height = '0';
        tri.style.borderLeft = '7px solid transparent';
        tri.style.borderRight = '7px solid transparent';
        tri.style.borderBottom = '14px solid rgba(255,255,255,0.95)';
        tri.style.boxShadow = '0 1px 3px rgba(0,0,0,0.35)';
        el.appendChild(tri);
      } else {
        const dot = document.createElement('div');
        dot.className = 'dot';
        el.appendChild(dot);
      }
    }
  }
}

    // note: axes are now handled by applyAxesToDOM above
// haha domer! ding!
  

  // reattach existing player nodes into the grid so they stay in sync with grid transforms
  for (const id in clientEls) {
    grid.appendChild(clientEls[id]);
  }
//} THIS BRACKET IS GONE.

 // center camera on a given tile (r,c) only when the tile is outside the viewport (with margin)
function centerCameraOn(r,c){
  r = Math.max(0, Math.min(rows - 1, r || 0));
  c = Math.max(0, Math.min(cols - 1, c || 0));
  const gap = parseInt(getComputedStyle(grid).getPropertyValue('gap')) || 0;
  const pad = parseInt(getComputedStyle(grid).getPropertyValue('padding')) || 0;
  const tileSize = logicalTileSize;

  const centerX = pad + c * (tileSize + gap) + tileSize / 2;
  const centerY = pad + r * (tileSize + gap) + tileSize / 2;

  const vpRect = VIEW.getBoundingClientRect();

  // compute current transformed position of the center (grid is translated by camera.x/camera.y)
  const transformedX = camera.x + centerX;
  const transformedY = camera.y + centerY;

  // margin so the player can move a few tiles before camera moves
  const MARGIN = Math.max(48, Math.min(vpRect.width, vpRect.height) * 0.12);

  const withinX = transformedX >= MARGIN && transformedX <= (vpRect.width - MARGIN);
  const withinY = transformedY >= MARGIN && transformedY <= (vpRect.height - MARGIN);

  // if center is within the visible area with margin, do not move camera
  if (withinX && withinY) return;

  const offsetX = centerX - vpRect.width / 2;
  const offsetY = centerY - vpRect.height / 2;

  camera.targetX = -offsetX;
  camera.targetY = -offsetY;

  // kick off animation loop only if not already running
  if (!camera.running) {
    camera.running = true;
    requestAnimationFrame(cameraLoop);
  }
}

// camera animation loop (lerp)
function cameraLoop(){
  const dx = camera.targetX - camera.x;
  const dy = camera.targetY - camera.y;
  const moveX = dx * camera.easing;
  const moveY = dy * camera.easing;
  camera.x += moveX;
  camera.y += moveY;
  // if very close to target, snap
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
    camera.x = camera.targetX;
    camera.y = camera.targetY;
  }
  grid.style.transform = `translate(${camera.x}px, ${camera.y}px)`;
  if (camera.x !== camera.targetX || camera.y !== camera.targetY) {
    requestAnimationFrame(cameraLoop);
  } else {
    camera.running = false;
  }
}

// check whether a position is blocked by wall
function isBlocked(r,c){
  if (!room || !multiplayer.roomState || !multiplayer.roomState.walls) return false;
  return !!multiplayer.roomState.walls[keyFor(r,c)];
}

 // When collected, remove the dot from room state (so it disappears), reward the collector,
 // and immediately remove the dot DOM locally for snappy feedback.
function collectDotAt(r,c,myId){
  if (!room || !multiplayer.roomState || !multiplayer.roomState.dots) return false;
  const entries = multiplayer.roomState.dots;
  for (const k in entries){
    const p = entries[k];
    if (p && p.r === r && p.c === c){
      // award to player by increasing presence value
      const pres = multiplayer.presence[myId] || {};
      const amount = (p.type === 'triangle') ? 2 : 1;
      const newVal = (typeof pres.value === 'number' ? pres.value : 1) + amount;
      socket.updatePresence({ value: newVal });

      // optimistically remove dot DOM in the tile for immediate feedback
      const tile = document.querySelector(`.tile[data-r="${r}"][data-c="${c}"]`);
      if (tile) {
        const dotEl = tile.querySelector('.dot, .triangle');
        if (dotEl) {
          dotEl.style.opacity = '0';
          dotEl.style.transform = 'translate(-50%,-50%) scale(0.3)';
          setTimeout(()=>{ if (dotEl && dotEl.parentNode) dotEl.remove(); }, 120);
        }
      }

      // play eat sound for collection (local immediate feedback)
      try {
        eatSfx.currentTime = 0;
        eatSfx.play().catch(()=>{ /* ignore play rejections */ });
      } catch (err){ /* ignore */ }

      // remove dot from room state so it disappears for everyone
      const removal = {};
      removal[k] = null;
      socket.updateRoomState({ dots: removal });

      return true;
    }
  }
  return false;
}

// bind WASD / arrow keys and handle movement with wall checks and dot collection
/* central move action that can be called by keyboard or on-screen buttons */
function performLocalMove(direction) {
  const myId = room && multiplayer.clientId;
  if (!room || !myId) return;
  const myPresence = multiplayer.presence[myId] || {};
  let r = typeof myPresence.row === 'number' ? myPresence.row : Math.floor(rows/2);
  let c = typeof myPresence.col === 'number' ? myPresence.col : Math.floor(cols/2);
  let nr = r, nc = c;
  switch(direction){
    case 'up': nr = Math.max(0, r - 1); break;
    case 'down': nr = Math.min(rows - 1, r + 1); break;
    case 'left': nc = Math.max(0, c - 1); break;
    case 'right': nc = Math.min(cols - 1, c + 1); break;
    default: return;
  }
  // wall block check — if blocked but we have axe uses, break the wall instead of blocking
  const wallKey = keyFor(nr, nc);
  if (isBlocked(nr,nc)) {
    const pres = multiplayer.presence[myId] || {};
    const uses = typeof pres.axeUses === 'number' ? pres.axeUses : 0;
    if (uses > 0) {
      // play breaking sound and remove wall from room state
      try {
        crowbarSfx.currentTime = 0;
        crowbarSfx.play().catch(()=>{});
      } catch (err){/*ignore*/}

      const removal = {};
      removal[wallKey] = null;
      try { socket.updateRoomState({ walls: removal }); } catch(e){ /* ignore */ }

      // Optimistically update local room state so other clients see the change immediately
      try {
        if (room && multiplayer.roomState) {
          multiplayer.roomState.walls = { ...(multiplayer.roomState.walls || {}) };
          multiplayer.roomState.walls[wallKey] = null;
        }
      } catch(e){ /* ignore */ }

      // locally remove wall class immediately for snappy feedback (DOM sync)
      try {
        const [wr,wc] = wallKey.split(':').map(Number);
        const tileEl = document.querySelector(`.tile[data-r="${wr}"][data-c="${wc}"]`);
        if (tileEl) tileEl.classList.remove('wall');
        // also ensure applyWallsToDOM is run to reconcile any remaining visual state
        applyWallsToDOM(room && multiplayer.roomState ? multiplayer.roomState.walls : {});
      } catch (domErr) { /* ignore */ }

      // decrement axe uses
      const newUses = Math.max(0, uses - 1);
      try { socket.updatePresence({ axeUses: newUses }); } catch(e){ /* ignore */ }
      // if uses hit zero, clear any axe flag (visual)
      if (newUses <= 0) {
        try { socket.updatePresence({ hasAxe: false }); } catch(e){ /* ignore */ }
      }
      // still allow movement into the now-free tile
    } else {
      return;
    }
  }

  // movement cooldown guard
  const now = performance.now();
  const MOVE_COOLDOWN_MS = 110;
  if (now - lastLocalMove < MOVE_COOLDOWN_MS) return;

  // update presence once per valid movement (include username if available so anonymous names sync)
  const color = myPresence.color || getRandomColor();
  const value = typeof myPresence.value === 'number' ? myPresence.value : 1;
  const uname = (myPresence && myPresence.username) ? myPresence.username : (localNickname || undefined);
  // ensure we always advertise a username so anonymous users appear for everyone
  const unameToSend = (myPresence && myPresence.username) ? myPresence.username
                        : (localNickname ? localNickname
                        : (room && multiplayer.clientId ? `Anon${String(multiplayer.clientId).slice(0,4)}` : undefined));
  const presPatch = { row: nr, col: nc, color, value, username: unameToSend };
  // also preserve nickname if available
  if (myPresence && myPresence.nickname) presPatch.nickname = myPresence.nickname;
  socket.updatePresence(presPatch);

  // play local move sound
  try {
    moveSfx.currentTime = 0;
    moveSfx.play().catch(()=>{ /* ignore */ });
  } catch (err){ /* ignore */ }

  // attempt to collect dot or axe on the new tile
  collectDotAt(nr, nc, myId);
  collectAxeAt(nr, nc, myId);

  lastLocalMove = now;
}

function bindLocalControls(){
  if (localControlsBound) return;
  localControlsBound = true;

  window.addEventListener('keydown', (e) => {
    // ignore typing in inputs/textareas or any contenteditable element
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;

    // ignore key repeats
    if (e.repeat) return;
    const key = e.key.toLowerCase();

    // respawn with 'r'
    if (key === 'r') {
      e.preventDefault();
      if (room && multiplayer.clientId) {
        const pos = getRandomFreePosition();
        try {
          socket.updatePresence({ row: pos.r, col: pos.c, color: getRandomColor(), value: 1 });
        } catch (err) { /* ignore */ }
        // show a quick popup confirming respawn (use global fallback)
        showGlobalPopup('Respawned');
      }
      return;
    }

    let dir = null;
    if (['w','arrowup'].includes(key)) dir = 'up';
    if (['s','arrowdown'].includes(key)) dir = 'down';
    if (['a','arrowleft'].includes(key)) dir = 'left';
    if (['d','arrowright'].includes(key)) dir = 'right';
    if (!dir) return;
    e.preventDefault();
    performLocalMove(dir);
  }, {passive:false});
}

// handle requests from others (e.g., when consumed)
function bindPresenceRequests(){
  socket.subscribePresenceUpdateRequests((updateRequest, fromClientId) => {
    const myId = multiplayer.clientId;
    if (updateRequest.type === 'consume' && updateRequest.victim === myId) {
      // we got consumed; reduce/reset and notify attacker
      const resetValue = 1;
      const pos = getRandomFreePosition();
      try {
        socket.updatePresence({ row: pos.r, col: pos.c, color: getRandomColor(), value: resetValue });
      } catch(e){ /* ignore */ }

      // send a small event to the attacker to award points
      try {
        socket.send({ type: 'consumed', attacker: fromClientId, victim: myId, amount: updateRequest.amount, echo: false });
      } catch(e){ /* ignore */ }

      // show local popup on player element; if missing (lag), use global popup fallback
      const el = clientEls[myId];
      let shown = false;
      if (el) {
        const popup = el.querySelector('.popup');
        if (popup) {
          popup.textContent = 'You were consumed';
          popup.style.opacity = '1';
          popup.style.transform = 'translate(-50%,-60%)';
          setTimeout(()=>{ popup.style.opacity='0'; popup.style.transform='translate(-50%,-50%)'; }, 1800);
          shown = true;
        }
      }
      if (!shown) {
        showGlobalPopup('You were consumed');
      }

      // play death + eat combo for the victim as immediate feedback
      try {
        deathSfx.currentTime = 0;
        deathSfx.play().catch(()=>{ /* ignore */ });
      } catch (err){ /* ignore */ }
      try {
        eatSfx.currentTime = 0;
        eatSfx.play().catch(()=>{ /* ignore */ });
      } catch (err){ /* ignore */ }
    }
  });
}

 // when someone sends 'consumed' event, attacker should increase value; also handle synchronized reset start
function bindEvents(){
  socket.onmessage = (event) => {
    const data = event.data;

    // cache simple usernames from built-in connect/disconnect events (helps cases where multiplayer.peers
    // isn't immediately populated or visible due to account differences)
    if (data && (data.type === 'connected' || data.type === 'disconnected')) {
      try {
        if (data.clientId && data.username) {
          if (data.type === 'connected') remoteUsernames[data.clientId] = data.username;
          if (data.type === 'disconnected') delete remoteUsernames[data.clientId];
        }
      } catch (e) { /* ignore */ }
    }

    // respond to name-sync requests by advertising our username in presence (helps accounts that don't
    // expose peer metadata immediately). We intentionally do this without blocking on async/await.
    if (data && data.type === 'request_name_sync') {
      try {
        // read our account username if available and push it into presence so everyone sees it.
        // If account info isn't available but we have a localNickname, advertise that as username too.
        window.websim.getCurrentUser().then((currentUser) => {
          try {
            const accountName = currentUser && currentUser.username ? currentUser.username : undefined;
            const fallbackName = localNickname || undefined;
            const usernameToAdvertise = accountName || fallbackName;
            if (usernameToAdvertise) {
              // merge a username into our presence to make sure names propagate globally
              socket.updatePresence({ username: usernameToAdvertise });
              // also cache locally so UI updates immediately
              remoteUsernames[multiplayer.clientId] = usernameToAdvertise;
              // force a reconcile so labels update right away
              reconcilePresence();
            }
          } catch (err) { /* ignore presence update errors */ }
        }).catch(()=>{ 
          // as a last-ditch, if getCurrentUser failed but we have a localNickname, advertise it
          try {
            if (localNickname && room && multiplayer.clientId) {
              socket.updatePresence({ username: localNickname });
              remoteUsernames[multiplayer.clientId] = localNickname;
              reconcilePresence();
            }
          } catch(e){/*ignore*/}
        });
      } catch (err) { /* ignore */ }
    }

    // map reset pushed immediately (legacy fallback)
    if (data.type === 'map_reset') {
      if (data.roomState) {
        generateTiles();
        // reposition ourselves to a free position and reset our value
        const pos = getRandomFreePosition();
        socket.updatePresence({ row: pos.r, col: pos.c, color: getRandomColor(), value: 1 });
      }
    }

    // Attacker receives a 'consumed' broadcast: only the attacker should increment their own presence value.
    if (data.type === 'consumed') {
      const attacker = data.attacker;
      const amount = Number(data.amount) || 0;
      if (attacker === multiplayer.clientId) {
        const prev = multiplayer.presence[multiplayer.clientId] || {};
        const newVal = (typeof prev.value === 'number' ? prev.value : 1) + amount;
        socket.updatePresence({ value: newVal });
        // show small popup confirmation for attacker
        const el = clientEls[multiplayer.clientId];
        if (el) {
          const popup = el.querySelector('.popup');
          if (popup) {
            popup.textContent = `+${amount}`;
            popup.style.opacity = '1';
            popup.style.transform = 'translate(-50%,-60%)';
            setTimeout(()=>{ popup.style.opacity='0'; popup.style.transform='translate(-50%,-50%)'; }, 1200);
          }
        }

        // play death + eat combo for attacker feedback
        try {
          deathSfx.currentTime = 0;
          deathSfx.play().catch(()=>{ /* ignore */ });
        } catch (err){ /* ignore */ }
        try {
          eatSfx.currentTime = 0;
          eatSfx.play().catch(()=>{ /* ignore */ });
        } catch (err){ /* ignore */ }
      }
    }

    // Legacy onmessage handler: kept but prefer authoritative multiplayer.roomState.start_reset_at to trigger resets.
    if (data.type === 'start_reset' && data.startAt) {
      // convert to the same behavior as roomState-driven resets for compatibility
      const startAt = Number(data.startAt);
      if (!startAt || isNaN(startAt)) return;

      // If another client is already handling the reset, don't schedule another reset handler.
      if (resetInProgress) {
        // show the countdown UI for user awareness but do not execute duplicate reset logic
        const now = Date.now();
        const msUntil = Math.max(0, startAt - now);
        countdownEl.style.display = 'flex';
        countdownEl.style.opacity = '1';
        countdownTimer.textContent = String(Math.ceil(msUntil / 1000));
        return;
      }

      resetInProgress = true;

      // show countdown UI immediately and schedule the reset to happen exactly at startAt
      const now = Date.now();
      const msUntil = Math.max(0, startAt - now);
      countdownEl.style.display = 'flex';
      countdownEl.style.opacity = '1';
      let remaining = Math.ceil(msUntil / 1000);
      countdownTimer.textContent = String(remaining);
      const countdownTick = setInterval(()=>{
        remaining = Math.max(0, Math.ceil((startAt - Date.now()) / 1000));
        countdownTimer.textContent = String(remaining);
        if (Date.now() >= startAt) {
          clearInterval(countdownTick);
          // hide countdown UI reliably
          try { countdownEl.style.display = 'none'; countdownEl.style.opacity = '0'; } catch(e){/*ignore*/}

          // perform the synchronized reset: compute new room state and apply
          const seed = Math.floor(Math.random()*1e9);
          const walls = generateRandomWalls(seed);
          const dots = generateRandomDots(seed+1);
          const axes = generateRandomAxes(seed+2);

          // determine matchMode: prefer authoritative room state selection if present, otherwise default to 'random'
          const requestedMode = (room && multiplayer.roomState && multiplayer.roomState.matchMode) ? multiplayer.roomState.matchMode : 'random';
          try {
            // persist the mode as part of room state so everyone knows what happened
            socket.updateRoomState({ seed, walls, dots, axes, matchMode: requestedMode });
          } catch(e) {
            // If a merge write fails, try writing full payload without mode, then mode separately
            try { socket.updateRoomState({ seed, walls, dots, axes }); } catch(e2){/*ignore*/ }
            try { socket.updateRoomState({ matchMode: requestedMode }); } catch(e3){/*ignore*/ }
          }

          // apply mode effects on the client that executes the reset (assign main character if needed)
          try { applyMatchModeEffects(requestedMode); } catch(e){/*ignore*/}

          const pos = getRandomFreePosition();
          try { socket.updatePresence({ row: pos.r, col: pos.c, color: getRandomColor(), value: 1 }); } catch(e){ /* ignore */ }

          // clear start_reset_at so subsequent cycles behave correctly (only the nextNext drives the next trigger)
          try { socket.updateRoomState({ start_reset_at: null }); } catch(e){ /* ignore */ }

          // small delay to allow room state to propagate, then clear local guard
          setTimeout(()=>{ resetInProgress = false; }, 800);
        }
      }, 250);
    }
  };
}



/* produce pseudo-random dot distribution (with occasional triangles worth 2 points)
   Avoid placing dots/triangles inside walls by checking the current room state walls.
   If a walls object is passed via room state, respect it; otherwise fall back to empty.
*/
function generateRandomDots(seed) {
  const dots = {};
  const rng = mulberry32(seed);
  // Increased density: ~8% of tiles now (was 2%)
  const total = Math.floor((MAP_COLS * MAP_ROWS) * 0.08);
  const walls = room && multiplayer.roomState && multiplayer.roomState.walls ? multiplayer.roomState.walls : {};
  let attempts = 0;
  // Try to place 'total' dots but guard against infinite loops
  while (Object.keys(dots).length < total && attempts < total * 8) {
    attempts++;
    const r = Math.floor(rng() * MAP_ROWS);
    const c = Math.floor(rng() * MAP_COLS);
    const key = keyFor(r, c);
    // skip if there's a wall at this tile or we've already placed something here
    if (walls[key] || dots[key]) continue;
    // make triangles still rarer than dots but more common than before (~20% chance)
    const isTriangle = rng() < 0.20;
    dots[key] = { r, c, type: isTriangle ? 'triangle' : 'dot' };
  }
  return dots;
}

// generate axes sparsely across the map; axes are collectibles that grant 3 wall-break uses
function generateRandomAxes(seed) {
  const axes = {};
  const rng = mulberry32(seed);
  // Less rare: ~1% of tiles as an upper cap to allow more axes (was 0.3%)
  const maxAxes = Math.max(1, Math.floor((MAP_COLS * MAP_ROWS) * 0.01));
  let attempts = 0;
  while (Object.keys(axes).length < maxAxes && attempts < maxAxes * 60) {
    attempts++;
    const r = Math.floor(rng() * MAP_ROWS);
    const c = Math.floor(rng() * MAP_COLS);
    const key = keyFor(r, c);
    const walls = room && multiplayer.roomState && multiplayer.roomState.walls ? multiplayer.roomState.walls : {};
    const existingDots = room && multiplayer.roomState && multiplayer.roomState.dots ? multiplayer.roomState.dots : {};
    if (walls[key] || existingDots[key] || axes[key]) continue;
    // higher probability to spawn an axe so they're noticeably more common
    if (rng() < 0.60) {
      axes[key] = { r, c, type: 'axe' };
    }
  }
  return axes;
}

 // Apply match mode effects after a synchronized reset: if 'main' then pick a random connected player
// and set their presence value to 5000. This is only applied by the client that performs the reset.
function applyMatchModeEffects(mode) {
  try {
    if (!room) return;
    // If mode is 'random', choose between 'normal' and 'main'
    let resolved = mode;
    if (!resolved || resolved === 'random') {
      resolved = (Math.random() < 0.18) ? 'main' : 'normal'; // small chance to pick main by default
    }

    // persist the resolved mode back into room state so UI and other clients show the actual chosen mode
    try {
      socket.updateRoomState({ matchMode: resolved });
    } catch (e) {
      // best-effort fallback: try to write without throwing
      try { socket.updateRoomState({ matchMode: resolved }); } catch (e2) { /* ignore */ }
    }

    // if 'main', pick a random player from the current presence and assign value 5000
    if (resolved === 'main') {
      const ids = Object.keys(multiplayer.presence || {}).filter(id => id);
      if (ids.length > 0) {
        const chosen = ids[Math.floor(Math.random() * ids.length)];
        try {
          // Attempt to set chosen player's value; some SDKs may not accept target client in this call.
          socket.updatePresence({ value: 5000 }, chosen);
        } catch (e) {
          // fallback attempt: notify via event so the chosen client can adjust itself if needed
          try { socket.send({ type: 'assign_main_value', chosen, echo: true }); } catch(e2){/*ignore*/}
        }
        // also try to notify others via a short event so clients can show a quick highlight
        try { socket.send({ type: 'main_character_assigned', chosen, echo: true }); } catch(e){/*ignore*/}
      }
    }
  } catch (err) { console.warn('applyMatchModeEffects error', err); }
}

/* Replenish a modest number of dots mid-match so the map doesn't run out.
   This picks several random free tiles (avoiding walls and existing dots) and
   updates the room state with new dot entries. */
function replenishDots(count = 24) {
  if (!room || !multiplayer.roomState) return;
  const walls = multiplayer.roomState.walls || {};
  const existing = multiplayer.roomState.dots || {};
  const existingAxes = multiplayer.roomState.axes || {};
  const additions = {};
  let placed = 0;
  let tries = 0;
  while (placed < count && tries < count * 40) {
    tries++;
    const r = Math.floor(Math.random() * MAP_ROWS);
    const c = Math.floor(Math.random() * MAP_COLS);
    const k = keyFor(r, c);
    if (walls[k]) continue;
    if (existing[k] || additions[k] || existingAxes[k]) continue;
    // triangles are now more common during replenishes (~18%)
    const isTriangle = Math.random() < 0.18;
    additions[k] = { r, c, type: isTriangle ? 'triangle' : 'dot' };
    placed++;
  }
  if (Object.keys(additions).length > 0) {
    try {
      socket.updateRoomState({ dots: { ...additions, ...existing } });
    } catch (err) {
      // If updateRoomState doesn't accept full merge, send incremental removals/additions:
      // prefer incremental approach: set each new key individually
      for (const k in additions) {
        const patch = {};
        patch[k] = additions[k];
        try { socket.updateRoomState({ dots: patch }); } catch(e){ /* ignore */ }
      }
    }
  }

  // increased chance to spawn an axe occasionally during replenishes
  if (Math.random() < 0.35) {
    const r = Math.floor(Math.random() * MAP_ROWS);
    const c = Math.floor(Math.random() * MAP_COLS);
    const k = keyFor(r, c);
    if (!walls[k] && !existing[k] && !existingAxes[k]) {
      const ax = {};
      ax[k] = { r, c, type: 'axe' };
      try { socket.updateRoomState({ axes: ax }); } catch(e){
        // try incremental
        try { for (const kk in ax) { const patch = {}; patch[kk]=ax[kk]; socket.updateRoomState({ axes: patch }); } } catch(e2) { /* ignore */ }
      }
    }
  }
}

/* start a background replenisher that runs periodically during a match */
function startDotReplenisher(){
  // add a small burst every ~12-18 seconds
  setInterval(()=>{
    replenishDots(6 + Math.floor(Math.random() * 8));
  }, 12000 + Math.floor(Math.random() * 6000));
}

 /* produce pseudo-random walls grouping (mini-mazes) with winding corridors and isolated singles
   Slightly increased wall density while preserving open space: a bit longer walks and a slightly
   higher placement probability, but carving remains aggressive to avoid full coverage. */
function generateRandomWalls(seed) {
  // stronger wall generator: more blobs, longer walks and higher placement odds to increase wall density
  const walls = {};
  const rng = mulberry32(seed);

  // increase blob count and walk lengths for denser coverage
  const blobs = 2 + Math.floor(rng() * 3); // 2-4 blobs
  for (let b = 0; b < blobs; b++) {
    let br = 2 + Math.floor(rng() * (MAP_ROWS - 4));
    let bc = 2 + Math.floor(rng() * (MAP_COLS - 4));
    const walkLen = 30 + Math.floor(rng() * 70); // longer walks
    let r = br, c = bc;
    let lastDir = Math.floor(rng() * 4);
    for (let i = 0; i < walkLen; i++) {
      // make thicker sections more often to form larger obstacles
      const makeThick = rng() < 0.16;
      const blockH = makeThick ? 2 + (rng() < 0.5 ? 1 : 0) : 1;
      const blockW = makeThick ? 2 + (rng() < 0.5 ? 1 : 0) : 1;
      for (let rr = r; rr < Math.min(MAP_ROWS, r + blockH); rr++) {
        for (let cc = c; cc < Math.min(MAP_COLS, c + blockW); cc++) {
          // increase placement probability for denser walls
          if (rng() < 0.56) walls[keyFor(rr, cc)] = true;
        }
      }
      // bias to continue in similar direction often, but allow turns
      if (rng() < 0.66) {
        const dir = lastDir;
        if (dir === 0) r = Math.max(1, r - 1);
        else if (dir === 1) r = Math.min(MAP_ROWS - 2, r + 1);
        else if (dir === 2) c = Math.max(1, c - 1);
        else c = Math.min(MAP_COLS - 2, c + 1);
        if (rng() < 0.28) lastDir = Math.floor(rng() * 4);
      } else {
        const dir = Math.floor(rng() * 4);
        if (dir === 0) r = Math.max(1, r - 1);
        else if (dir === 1) r = Math.min(MAP_ROWS - 2, r + 1);
        else if (dir === 2) c = Math.max(1, c - 1);
        else c = Math.min(MAP_COLS - 2, c + 1);
        lastDir = dir;
      }
      // occasional teleport to start a new branch
      if (rng() < 0.04) {
        r = 2 + Math.floor(rng() * (MAP_ROWS - 4));
        c = 2 + Math.floor(rng() * (MAP_COLS - 4));
      }
    }
  }

  // lighter carving pass but still remove tiny isolated tiles to keep playability
  const carveAttempts = 120 + Math.floor(rng() * 160);
  for (let i = 0; i < carveAttempts; i++) {
    const r = Math.floor(rng() * MAP_ROWS);
    const c = Math.floor(rng() * MAP_COLS);
    const neighbors =
      (walls[keyFor(r - 1, c)] ? 1 : 0) +
      (walls[keyFor(r + 1, c)] ? 1 : 0) +
      (walls[keyFor(r, c - 1)] ? 1 : 0) +
      (walls[keyFor(r, c + 1)] ? 1 : 0);
    // reduce aggressive carving so majority of walls remain
    if (neighbors >= 3 && rng() < 0.78) {
      walls[keyFor(r, c)] = false;
    } else if (neighbors <= 1 && rng() < 0.12) {
      walls[keyFor(r, c)] = false;
    }
  }

  // increased occasional singles and chokepoints to create interesting bottlenecks
  const singles = Math.floor((MAP_COLS * MAP_ROWS) * (0.003 + rng() * 0.004));
  let placed = 0;
  let attempts = 0;
  while (placed < singles && attempts < Math.max(60, singles * 20)) {
    attempts++;
    const r = Math.floor(rng() * MAP_ROWS);
    const c = Math.floor(rng() * MAP_COLS);
    const k = keyFor(r, c);
    const adj =
      walls[keyFor(r - 1, c)] || walls[keyFor(r + 1, c)] ||
      walls[keyFor(r, c - 1)] || walls[keyFor(r, c + 1)];
    if (!walls[k] && !adj && rng() < 0.48) {
      walls[k] = true;
      placed++;
    }
  }

  // tidy up (remove false entries)
  for (const k in walls) {
    if (!walls[k]) delete walls[k];
    else walls[k] = true;
  }

  return walls;
}

// deterministic RNG for map generation
function mulberry32(a) {
  return function() {
    var t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

// pick a random free tile (not a wall) — avoids spawning inside walls
function getRandomFreePosition() {
  const walls = room && multiplayer.roomState && multiplayer.roomState.walls ? multiplayer.roomState.walls : {};
  // try a number of random attempts, then fallback to scanning
  for (let i=0;i<200;i++){
    const r = Math.floor(Math.random()*rows);
    const c = Math.floor(Math.random()*cols);
    if (!walls[keyFor(r,c)]) return { r, c };
  }
  for (let r=0;r<rows;r++){
    for (let c=0;c<cols;c++){
      if (!walls[keyFor(r,c)]) return { r, c };
    }
  }
  // worst-case, return center
  return { r: Math.floor(rows/2), c: Math.floor(cols/2) };
}

 // When a client tries to collect, remove the dot from room state and award the player;
 // also remove the dot DOM immediately for responsive feedback.
function tryCollectAt(r,c,clientId) {
  if (!room || !multiplayer.roomState || !multiplayer.roomState.dots) return false;
  const dots = multiplayer.roomState.dots;
  for (const k in dots) {
    const p = dots[k];
    if (p && p.r === r && p.c === c) {
      const pres = multiplayer.presence[clientId] || {};
      const amount = (p.type === 'triangle') ? 2 : 1;
      const newVal = (typeof pres.value === 'number' ? pres.value : 1) + amount;
      socket.updatePresence({ value: newVal });

      // optimistically remove dot/triangle DOM locally
      const tile = document.querySelector(`.tile[data-r="${r}"][data-c="${c}"]`);
      if (tile) {
        const dotEl = tile.querySelector('.dot, .triangle');
        if (dotEl) {
          dotEl.style.opacity = '0';
          dotEl.style.transform = 'translate(-50%,-50%) scale(0.3)';
          setTimeout(()=>{ if (dotEl && dotEl.parentNode) dotEl.remove(); }, 120);
        }
      }

      // play eat sound for collection (local immediate feedback)
      try {
        eatSfx.currentTime = 0;
        eatSfx.play().catch(()=>{ /* ignore play rejections */ });
      } catch (err){ /* ignore */ }

      // remove dot globally
      const removal = {};
      removal[k] = null;
      socket.updateRoomState({ dots: removal });

      return true;
    }
  }
  return false;
}

// collect an axe (if present) — grants 3 uses to break walls
function collectAxeAt(r,c,clientId){
  if (!room || !multiplayer.roomState || !multiplayer.roomState.axes) return false;
  const axes = multiplayer.roomState.axes;
  for (const k in axes) {
    const a = axes[k];
    if (a && a.r === r && a.c === c) {
      // award axe: add 3 uses to existing uses (stack)
      const pres = multiplayer.presence[clientId] || {};
      const prevUses = typeof pres.axeUses === 'number' ? pres.axeUses : 0;
      const newUses = prevUses + 3;
      try { socket.updatePresence({ hasAxe: true, axeUses: newUses }); } catch(e){ /* ignore */ }

      // optimistic local remove of axe DOM
      const tile = document.querySelector(`.tile[data-r="${r}"][data-c="${c}"]`);
      if (tile) {
        const axEl = tile.querySelector('.axe-item');
        if (axEl) {
          axEl.style.opacity = '0';
          axEl.style.transform = 'translate(-50%,-50%) scale(0.3)';
          setTimeout(()=>{ if (axEl && axEl.parentNode) axEl.remove(); }, 160);
        }
      }

      // play select (pickup) sound
      try { selectSfx.currentTime = 0; selectSfx.play().catch(()=>{}); } catch(e){/*ignore*/}

      // remove axe globally
      const removal = {};
      removal[k] = null;
      try { socket.updateRoomState({ axes: removal }); } catch(e){ /* ignore */ }

      return true;
    }
  }
  return false;
}

let nextResetAt = null;
let nextResetInterval = null;

 // periodic reset: every 5 minutes announce 10s countdown then emit reset
function startPeriodicReset(){
  const interval = 5 * 60 * 1000; // 5 minutes

  // If room state doesn't have an authoritative nextResetAt, the first client to notice will set it.
  try {
    const stateNext = room && multiplayer.roomState && Number(multiplayer.roomState.nextResetAt);
    if (!stateNext || isNaN(stateNext) || stateNext <= Date.now()) {
      const initialNext = Date.now() + interval;
      // choose an initial match mode deterministically here (no "random" placeholder on first join)
      const resolvedInitialMode = (room && multiplayer.roomState && multiplayer.roomState.matchMode) ? multiplayer.roomState.matchMode : ((Math.random() < 0.18) ? 'main' : 'normal');
      socket.updateRoomState({ nextResetAt: initialNext, matchMode: resolvedInitialMode });
    }
  } catch (err) {
    console.warn('Could not persist initial nextResetAt', err);
  }

  // ensure visible UI
  const nextResetEl = document.getElementById('next-reset');
  if (nextResetEl) nextResetEl.setAttribute('aria-hidden', 'false');

  // Periodically check the authoritative room state; when nextResetAt is reached, one client
  // will atomically write start_reset_at and a new nextResetAt into room state so everyone follows it.
  nextResetInterval = setInterval(()=>{
    if (!room || !multiplayer.roomState) return;
    const state = multiplayer.roomState;
    const stateNext = Number(state.nextResetAt) || 0;
    const now = Date.now();
    // If a start_reset already exists and is in the future, don't overwrite it.
    const existingStart = Number(state.start_reset_at) || 0;
    if (stateNext && now >= stateNext && (!existingStart || existingStart <= now) && !resetInProgress) {
      const startAt = now + 10000; // 10s countdown
      const subsequentNext = now + interval;
      // mark locally to avoid races where multiple clients write almost simultaneously
      resetInProgress = true;
      try {
        // write authoritative start_reset_at and new nextResetAt into room state so all clients sync
        socket.updateRoomState({ start_reset_at: startAt, nextResetAt: subsequentNext });

        // Additionally, schedule a local fallback to execute the reset exactly at startAt
        // in case the room state write doesn't propagate quickly enough for this client to
        // observe the change via subscribeRoomState. This ensures the match actually starts.
        const msUntil = Math.max(0, startAt - Date.now());
        setTimeout(() => {
          try {
            // double-check guard so we don't run duplicate resets
            if (!resetInProgress) return;
            // perform the synchronized reset: compute new room state and apply
            const seed = Math.floor(Math.random()*1e9);
            const walls = generateRandomWalls(seed);
            const dots = generateRandomDots(seed+1);
            const axes = generateRandomAxes(seed+2);

            // determine mode to persist: prefer existing room state choice if any, else 'random'
            const requestedMode = (room && multiplayer.roomState && multiplayer.roomState.matchMode) ? multiplayer.roomState.matchMode : 'random';
            try {
              socket.updateRoomState({ seed, walls, dots, axes, matchMode: requestedMode });
            } catch(e) {
              try { socket.updateRoomState({ seed, walls, dots, axes }); } catch(e2){/*ignore*/}
              try { socket.updateRoomState({ matchMode: requestedMode }); } catch(e3){/*ignore*/}
            }

            // apply the effects for the mode (assign main-character if applicable)
            try { applyMatchModeEffects(requestedMode); } catch(e){/*ignore*/}

            const pos = getRandomFreePosition();
            try { socket.updatePresence({ row: pos.r, col: pos.c, color: getRandomColor(), value: 1 }); } catch(e){ /* ignore */ }

            // clear authoritative start_reset_at locally (also safe to attempt on room state)
            try { socket.updateRoomState({ start_reset_at: null }); } catch(e){ /* ignore */ }

            // hide any countdown UI just in case
            try { countdownEl.style.display = 'none'; countdownEl.style.opacity = '0'; } catch(e){/*ignore*/}

          } finally {
            // small delay then allow future resets
            setTimeout(()=>{ resetInProgress = false; }, 800);
          }
        }, msUntil + 50); // small buffer to ensure timing edge cases are covered

      } catch (err) {
        console.warn('Could not write start/reset times to room state', err);
        // if write failed, clear guard so others can attempt later
        resetInProgress = false;
      }
    }
  }, 1000);

  // keep a lightweight visual updater running
  updateNextResetTimer();
  // update once per second
  setInterval(updateNextResetTimer, 1000);
}

let resetInProgress = false;
function triggerResetSequence(){
  // Deprecated: triggerResetSequence is now handled by writing to room state (start_reset_at)
  // This function is kept for backward compatibility but will no-op.
  return;
}

// display helper for top-center next reset countdown
function updateNextResetTimer(){
  const el = document.getElementById('next-reset-timer');
  const container = document.getElementById('next-reset');
  if (!container) return;
  // derive mode from authoritative room state if available
  const modeRaw = room && multiplayer.roomState && multiplayer.roomState.matchMode ? String(multiplayer.roomState.matchMode) : 'random';
  const modeLabel = (modeRaw === 'random') ? 'Random' : (modeRaw === 'main' ? "I'm the main character" : (modeRaw === 'normal' ? 'Normal' : modeRaw));
  if (!el || !nextResetAt) {
    container.setAttribute('aria-hidden', 'true');
    return;
  }
  const ms = Math.max(0, nextResetAt - Date.now());
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  // update content to include mode so players can see current match mode
  container.innerHTML = `Next reset in: <span id="next-reset-timer">${min}:${String(sec).padStart(2,'0')}</span> • Mode: <strong style="font-weight:800">${modeLabel}</strong>`;
  container.setAttribute('aria-hidden', 'false');
}

 // on resize regenerate tiles and reposition camera
function showGlobalPopup(message, duration = 1600) {
  try {
    // remove existing global popup if present
    const existing = document.getElementById('global-popup');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    const popup = document.createElement('div');
    popup.id = 'global-popup';
    popup.textContent = String(message || '');
    // basic styling to match other UI: centered, unobtrusive
    popup.style.position = 'fixed';
    popup.style.left = '50%';
    popup.style.top = '40%';
    popup.style.transform = 'translate(-50%,-50%)';
    popup.style.background = 'rgba(0,0,0,0.78)';
    popup.style.color = '#fff';
    popup.style.padding = '8px 12px';
    popup.style.borderRadius = '8px';
    popup.style.fontSize = '14px';
    popup.style.zIndex = '10006';
    popup.style.pointerEvents = 'none';
    popup.style.opacity = '0';
    popup.style.transition = 'opacity .18s ease, transform .18s ease';
    document.body.appendChild(popup);
    // trigger show
    requestAnimationFrame(() => {
      popup.style.opacity = '1';
      popup.style.transform = 'translate(-50%,-60%)';
    });
    // hide after duration
    setTimeout(() => {
      try {
        popup.style.opacity = '0';
        popup.style.transform = 'translate(-50%,-50%)';
        setTimeout(() => { if (popup && popup.parentNode) popup.parentNode.removeChild(popup); }, 180);
      } catch (e) { /* ignore */ }
    }, duration);
  } catch (err) {
    // silent fallback
    console.warn('showGlobalPopup error', err);
  }
}

function onResize(){
  generateTiles();
  if (room && multiplayer.presence && multiplayer.presence[multiplayer.clientId]) {
    const p = multiplayer.presence[multiplayer.clientId];
    centerCameraOn(p.row || 0, p.col || 0);
  }
}

// small FPS counter
const fpsEl = document.getElementById('fps');
let _fpsLast = performance.now();
let _fpsFrames = 0;
function fpsLoop(ts){
  _fpsFrames++;
  const dt = ts - _fpsLast;
  if (dt >= 250) {
    const fps = Math.round((_fpsFrames * 1000) / dt);
    if (fpsEl) fpsEl.textContent = `${fps} FPS`;
    _fpsFrames = 0;
    _fpsLast = ts;
  }
  requestAnimationFrame(fpsLoop);
}
requestAnimationFrame(fpsLoop);

/* --- Mini-map rendering --- */
const minimapCanvas = document.getElementById('minimap');
const minimapCtx = minimapCanvas && minimapCanvas.getContext ? minimapCanvas.getContext('2d') : null;
let minimapSize = 140; // display size (CSS), canvas resolution will be set for clarity

function resizeMinimap(){
  if (!minimapCanvas || !minimapCtx) return;
  // keep a crisp pixel-like representation: set internal resolution to minimapSize*devicePixelRatio
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  minimapSize = 140;
  minimapCanvas.width = minimapSize * dpr;
  minimapCanvas.height = minimapSize * dpr;
  minimapCanvas.style.width = `${minimapSize}px`;
  minimapCanvas.style.height = `${minimapSize}px`;
  minimapCtx.setTransform(dpr,0,0,dpr,0,0);
}
resizeMinimap();
window.addEventListener('resize', resizeMinimap, {passive:true});

// Draw minimap using current room state & presence. lightweight, runs periodically.
function drawMinimap(){
  if (!minimapCtx) return;
  // clear
  minimapCtx.clearRect(0,0,minimapSize,minimapSize);
  // background
  minimapCtx.fillStyle = '#f2f2f2';
  minimapCtx.fillRect(0,0,minimapSize,minimapSize);

  // compute scale from full map to minimap
  const colsTotal = MAP_COLS;
  const rowsTotal = MAP_ROWS;
  const cellW = minimapSize / colsTotal;
  const cellH = minimapSize / rowsTotal;

  // draw walls
  if (room && multiplayer.roomState && multiplayer.roomState.walls) {
    minimapCtx.fillStyle = '#222';
    for (const k in multiplayer.roomState.walls) {
      if (!multiplayer.roomState.walls[k]) continue;
      const [r,c] = k.split(':').map(Number);
      minimapCtx.fillRect(c*cellW, r*cellH, Math.max(1,cellW), Math.max(1,cellH));
    }
  }

  // draw dots
  if (room && multiplayer.roomState && multiplayer.roomState.dots) {
    minimapCtx.fillStyle = '#ffffff';
    for (const k in multiplayer.roomState.dots) {
      const p = multiplayer.roomState.dots[k];
      if (!p) continue;
      minimapCtx.fillRect(p.c*cellW + cellW*0.35, p.r*cellH + cellH*0.35, Math.max(1,cellW*0.3), Math.max(1,cellH*0.3));
    }
  }

  // draw players (presence)
  if (room && multiplayer.presence) {
    for (const id in multiplayer.presence) {
      const p = multiplayer.presence[id] || {};
      if (p.row === undefined || p.col === undefined) continue;
      const x = (p.col) * cellW + cellW/2;
      const y = (p.row) * cellH + cellH/2;
      const radius = Math.max(2, Math.min(cellW, cellH) * (0.35 + Math.min(0.8, (Math.log2((p.value||1)+1)/6))));
      minimapCtx.beginPath();
      minimapCtx.fillStyle = p.color || '#0077cc';
      minimapCtx.arc(x, y, radius, 0, Math.PI*2);
      minimapCtx.fill();
      // highlight local player
      if (id === (room && multiplayer.clientId)) {
        minimapCtx.strokeStyle = '#fff';
        minimapCtx.lineWidth = 1.5;
        minimapCtx.stroke();
      } else {
        minimapCtx.strokeStyle = 'rgba(0,0,0,0.15)';
        minimapCtx.lineWidth = 0.5;
        minimapCtx.stroke();
      }
    }
  }
}

// keep minimap updated periodically and on relevant events
setInterval(drawMinimap, 650);
window.addEventListener('resize', drawMinimap, {passive:true});

/* Reconcile authoritative presence -> DOM, leaderboard, collision checks.
   This central routine ensures player names, sizes, colors and positions are always
   driven by multiplayer.presence (which is kept up-to-date by the SDK). Running frequently
   smooths out jitters and prevents missing/placeholder labels. */
function reconcilePresence(presenceArg) {
  // authoritative presence from server
  const authoritative = (presenceArg && typeof presenceArg === 'object') ? presenceArg : {};

  // local snapshot from multiplayer state
  const sdkPresence = multiplayer.presence || {};

  // merge them (server wins)
  const mergedPresence = { ...sdkPresence, ...authoritative };

  // ensure peers exist even if they temporarily have no presence
  if (multiplayer.peers) {
    for (const pid in multiplayer.peers) {
      if (!mergedPresence[pid]) mergedPresence[pid] = {};
    }
  }

  // now update the DOM / player objects
 // updatePlayersFromPresence(mergedPresence); <-- haha chud line 



  // Pull any usernames that may now be available via multiplayer.peers into the remoteUsernames cache
  try {
    if (room && multiplayer.peers) {
      for (const pid in multiplayer.peers) {
        const pp = multiplayer.peers[pid];
        if (pp && pp.username && !remoteUsernames[pid]) {
          remoteUsernames[pid] = pp.username;
        }
      }
    }
  } catch (e) { /* ignore */ }

  // update DOM nodes for every present or known client
  for (const clientId in mergedPresence) {
    // create element if missing (maintain elements for peers even if they temporarily lack coordinates)
    createPlayerElement(clientId, clientId === multiplayer.clientId);
    const el = clientEls[clientId];
    if (!el) continue;

    const p = mergedPresence[clientId] || {};
    // label: prefer presence.username, then presence.nickname, then cached remoteUsernames, then peers username, then generic "Player"
    const label = el.querySelector('.player-label');
    const peer = multiplayer.peers ? multiplayer.peers[clientId] : null;
    const presenceName = (p.username && String(p.username).trim()) ? p.username
                       : ((p.nickname && String(p.nickname).trim()) ? p.nickname : null);
    const name = presenceName || remoteUsernames[clientId] || (peer && peer.username) || 'Player';
    if (label) label.textContent = name;

    // display color: prefer presence.color otherwise deterministic based on username/clientId
    const displayColor = (p.color && String(p.color).trim()) ? p.color : colorForUser(peer ? (peer.username || remoteUsernames[clientId]) : clientId, clientId);

    // apply regular styling (no account-specific overrides)
    el.style.background = displayColor;
    el.style.borderColor = 'rgba(0,0,0,0.25)';

    // position and size derived from presence when coordinates exist; if no coords, preserve last visual position
    const hasCoords = (typeof p.row === 'number') && (typeof p.col === 'number');
    const row = hasCoords ? p.row : (el.dataset.lastRow !== undefined ? Number(el.dataset.lastRow) : Math.floor(rows/2));
    const col = hasCoords ? p.col : (el.dataset.lastCol !== undefined ? Number(el.dataset.lastCol) : Math.floor(cols/2));
    const value = (typeof p.value === 'number') ? p.value : (el.dataset.lastValue ? Number(el.dataset.lastValue) : 1);
    positionClientElement(clientId, row, col, displayColor, value, false);

    // store last known coords/value so temporary absence of presence doesn't teleport the element
    el.dataset.lastRow = String(row);
    el.dataset.lastCol = String(col);
    el.dataset.lastValue = String(value);

    // center camera on local player when they move
    if (clientId === multiplayer.clientId) {
      centerCameraOn(row, col);
    }
  }

  // leaderboard update from authoritative mergedPresence
  try {
    const entries = [];
    for (const clientId in mergedPresence) {
      const p = mergedPresence[clientId] || {};
      const peer = multiplayer.peers ? multiplayer.peers[clientId] || {} : {};
      const lbName = (p.username && String(p.username).trim()) ? p.username
                     : ((p.nickname && String(p.nickname).trim()) ? p.nickname
                     : (remoteUsernames[clientId] || (peer && peer.username) || 'Player'));
      const value = typeof p.value === 'number' ? p.value : (clientEls[clientId] && clientEls[clientId].dataset.lastValue ? Number(clientEls[clientId].dataset.lastValue) : 1);
      entries.push({ id: clientId, name: lbName, value });
    }
    entries.sort((a,b) => b.value - a.value);
    const top = entries.slice(0, 8);
    leaderList.innerHTML = '';
    for (const e of top) {
      const li = document.createElement('li');
      li.textContent = `${e.name} — ${e.value}`;
      leaderList.appendChild(li);
    }
  } catch (err) {
    console.warn('Leaderboard reconcile error', err);
  }

  // collision detection based on authoritative mergedPresence
  try {
    const pres = mergedPresence;
    for (const a in pres) {
      for (const b in pres) {
        if (a === b) continue;
        const pa = pres[a] || {};
        const pb = pres[b] || {};
        // expanded collision: allow larger players to consume nearby smaller players (hitbox scales with size)
    // compute tile-chebyshev distance and per-player effective radius based on their displayed value
    const ra = (typeof pa.value === 'number') ? Math.max(0, Math.floor(Math.log2(pa.value + 1) / 1.8)) : 0;
    const rb = (typeof pb.value === 'number') ? Math.max(0, Math.floor(Math.log2(pb.value + 1) / 1.8)) : 0;
    const dr = Math.abs((pa.row || 0) - (pb.row || 0));
    const dc = Math.abs((pa.col || 0) - (pb.col || 0));
    const dist = Math.max(dr, dc);
    // if either player's effective radius reaches the other, consider it a collision
    if (dist <= Math.max(ra, rb)) {
      if (typeof pa.value === 'number' && typeof pb.value === 'number' && pa.value !== pb.value) {
        const attackerId = pa.value > pb.value ? a : b;
        const victimId = pa.value > pb.value ? b : a;
        const amount = pa.value > pb.value ? Math.max(1, Math.floor(pb.value)) : Math.max(1, Math.floor(pa.value));
        try { socket.requestPresenceUpdate(victimId, { type: 'consume', victim: victimId, attacker: attackerId, amount }); } catch(e){ /* ignore */ }
      }
    }
      }
    }
  } catch (err) {
    console.warn('Collision reconcile error', err);
  }

  // remove any DOM players for clients no longer present AND no longer listed in peers
  try {
    const keys = Object.keys(clientEls);
    for (const clientId of keys) {
      const stillPresent = !!mergedPresence[clientId];
      const stillPeer = !!(room && multiplayer.peers && multiplayer.peers[clientId]);
      if (!stillPresent && !stillPeer) removePlayerElement(clientId);
    }
  } catch (e) { /* ignore */ }
}

async function initMultiplayer() {
  const socket = new RealSocket("global_v1");
  window.socket = socket;

  await socket.initialize();

  // Copy server snapshot into multiplayer state
  multiplayer.clientId = socket.clientId;
  multiplayer.presence = socket.presence;
  multiplayer.roomState = socket.roomState;
  multiplayer.peers = socket.peers;

  // Apply initial state
  reconcilePresence(multiplayer.presence);
  applyRoomState(multiplayer.roomState);

  // Subscribe to updates
  socket.subscribePresence((presence) => {
    multiplayer.presence = presence;
    reconcilePresence(presence);
  });

  socket.subscribeRoomState((state) => {
    multiplayer.roomState = state;
    applyRoomState(state);
  });

  socket.subscribePresenceUpdateRequests((payload, fromId) => {
    // handle consume, collisions, etc.
  });

  // Send initial presence
  const pos = getRandomFreePosition();
  const color = getRandomColor();
  const value = 1 + Math.floor(Math.random() * 2);

  socket.updatePresence({
    row: pos.r,
    col: pos.c,
    color,
    value
  });

  // Start dot replenisher
  startDotReplenisher();
}

function applyRoomState(state = {}) {
  // 1. Apply walls
  if (state.walls) {
    applyWallsToDOM(state.walls);
  }

  // 2. Apply axes
  if (state.axes) {
    applyAxesToDOM(state.axes);
  }

  // 3. Re-render dots + triangles
  // Dots are rendered inline inside generateTiles(),
  // so we must call it again with the updated state.
  generateTiles(state);
}

function startReconcileLoop() {
  reconcilePresence();
  setInterval(reconcilePresence, 150);
}


async function startGame() {
  // 1. Build empty visual grid FIRST
  generateTiles();

  // 2. Connect multiplayer and wait for initial room state
  await initMultiplayer();

  // 3. Create local player AFTER multiplayer.clientId exists
  const myId = multiplayer.clientId;
  localPlayerId = myId;


  if (!multiplayer.presence[myId]) {
    const pos = getRandomFreePosition();

    socket.updatePresence({
      row: pos.r,
      col: pos.c,
      color: getRandomColor(),
      value: 1,
      username: localNickname || `Anon${String(myId).slice(0,4)}`
    });
  }

  // create local DOM player immediately
  createPlayerElement(myId, true);

  // 4. NOW controls are safe
  bindLocalControls();

  // 5. Apply authoritative room state AFTER tiles exist
  applyRoomState(multiplayer.roomState);

  // fallback generation if room empty
  if (
    !multiplayer.roomState ||
    !multiplayer.roomState.walls ||
    Object.keys(multiplayer.roomState.walls).length === 0
  ) {
    const seed = Math.floor(Math.random() * 1e9);

    socket.updateRoomState({
      seed,
      walls: generateRandomWalls(seed),
      dots: generateRandomDots(seed + 1),
      axes: generateRandomAxes(seed + 2)
    });
  }

  // 6. Presence reconciliation AFTER local player exists
  reconcilePresence(multiplayer.presence);
  startReconcileLoop();


  // 7. Start loops LAST
  startPeriodicReset();
}

startGame();


 // Tutorial modal behavior
 const tutorialBtn = document.getElementById('tutorial-btn');
 const tutorialModal = document.getElementById('tutorial-modal');
 const tutorialClose = document.getElementById('tutorial-close');
 // Change-name button
 const changeNickBtn = document.getElementById('change-nick-btn');
 const changeNickClose = document.getElementById('change-nick-close');

 // match mode UI (allow players to pick the upcoming match mode and persist it into room state)
 const matchModeSelect = document.getElementById('match-mode-select');
 const matchModeApply = document.getElementById('match-mode-apply');
 const matchModeChooser = document.getElementById('match-mode-chooser');

 // wire the apply button to persist the chosen mode to room state
 if (matchModeApply && matchModeSelect) {
   matchModeApply.addEventListener('click', (e) => {
     e.preventDefault();
     const chosen = matchModeSelect.value || 'random';
     if (!room) {
       showGlobalPopup('Unable to set mode (not connected)');
       return;
     }
     try {
       // persist selection so the reset logic will pick it up
       socket.updateRoomState({ matchMode: chosen });
       // reflect change immediately in the UI next-reset display
       if (typeof updateNextResetTimer === 'function') updateNextResetTimer();
       showGlobalPopup(`Match mode set: ${chosen === 'normal' ? 'Normal' : (chosen === 'main' ? "I'm the main character" : 'Random')}`, 1300);
     } catch (err) {
       showGlobalPopup('Failed to set match mode');
     }
   }, {passive:false});
 }

 // container for on-screen controls (created dynamically when user opts in)
 let mobileControlsEl = null;

 function showTutorial(show = true){
   if (!tutorialModal) return;
   tutorialModal.setAttribute('aria-hidden', String(!show));
   // trap focus only minimally: focus close button when opened
   if (show && tutorialClose) tutorialClose.focus();
 }

 if (tutorialBtn){
   tutorialBtn.addEventListener('click', (e) => {
     e.preventDefault();
     showTutorial(true);
   }, {passive:true});
 }
 if (tutorialClose){
   tutorialClose.addEventListener('click', (e) => {
     e.preventDefault();
     showTutorial(false);
   }, {passive:true});
 }
 // close on backdrop click
 if (tutorialModal){
   tutorialModal.addEventListener('click', (e) => {
     if (e.target === tutorialModal) showTutorial(false);
   }, {passive:true});
 }
 // close on Escape
 window.addEventListener('keydown', (e) => {
   if (e.key === 'Escape') showTutorial(false);
 });

 // hide/remove the change name button if user closes it
 if (changeNickClose) {
   changeNickClose.addEventListener('click', (e) => {
     e.preventDefault();
     const wrap = document.getElementById('change-nick-wrap');
     if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
   }, {passive:true});
 }

 // Auto-enable mobile controls for touch devices
 if (('ontouchstart' in window || navigator.maxTouchPoints > 0)) {
   try { createMobileControls(); } catch (e) { /* ignore */ }
 }

 // create simple on-screen WASD controls (bottom-left) and wire them to movement
 function createMobileControls() {
   if (mobileControlsEl) return;
   mobileControlsEl = document.createElement('div');
   mobileControlsEl.id = 'mobile-controls';
   mobileControlsEl.style.position = 'fixed';
   mobileControlsEl.style.left = '12px';
   // keep mobile controls above lower UI (tutorial button / change-name) so they don't overlap
   mobileControlsEl.style.bottom = '72px';
   mobileControlsEl.style.zIndex = '10005';
   mobileControlsEl.style.display = 'grid';
   mobileControlsEl.style.gridTemplateColumns = 'repeat(4,56px)';
   mobileControlsEl.style.gridTemplateRows = 'repeat(2,56px)';
   mobileControlsEl.style.gap = '10px';
   mobileControlsEl.style.pointerEvents = 'auto';

   const btn = (label, dirOrFn) => {
     const b = document.createElement('button');
     b.textContent = label;
     b.style.width = '56px';
     b.style.height = '56px';
     b.style.borderRadius = '12px';
     b.style.border = 'none';
     b.style.background = 'rgba(255,255,255,0.95)';
     b.style.boxShadow = '0 6px 18px rgba(0,0,0,0.12)';
     b.style.fontWeight = '700';
     b.style.fontSize = '16px';
     const handler = (ev) => {
       ev.preventDefault();
       if (typeof dirOrFn === 'function') dirOrFn();
       else performLocalMove(dirOrFn);
     };
     b.addEventListener('touchstart', handler, {passive:false});
     b.addEventListener('mousedown', handler, {passive:false});
     return b;
   };

   // layout grid (4 columns): [ , up, , respawn ]
   //                       [left, down, right,  ]
   const spacer = document.createElement('div');
   spacer.style.width = '56px';
   spacer.style.height = '56px';
   mobileControlsEl.appendChild(spacer);
   mobileControlsEl.appendChild(btn('↑','up'));
   mobileControlsEl.appendChild(document.createElement('div'));
   mobileControlsEl.appendChild(btn('R', () => {
     if (room && multiplayer.clientId) {
       const pos = getRandomFreePosition();
       try {
         socket.updatePresence({ row: pos.r, col: pos.c, color: getRandomColor(), value: 1 });
       } catch(e){ /* ignore */ }
       showGlobalPopup('Respawned');
     }
   }));
   mobileControlsEl.appendChild(btn('←','left'));
   mobileControlsEl.appendChild(btn('↓','down'));
   mobileControlsEl.appendChild(btn('→','right'));
   // filler to keep grid shape
   mobileControlsEl.appendChild(document.createElement('div'));

   document.body.appendChild(mobileControlsEl);
 }

 // Show change-nick button (always visible on load); button opens the nickname modal.
// After a successful save the button is removed so it can't be changed again in this session.
if (changeNickBtn) {
  changeNickBtn.style.display = 'inline-block';
  changeNickBtn.addEventListener('click', (e) => {
    e.preventDefault();
    showNicknameModal(true);
  }, {passive:true});
}

// NICKNAME modal: show on first load if no local nickname, and handle save/skip
const nicknameModal = document.getElementById('nickname-modal');
const nickInput = document.getElementById('nick-input');
const nickSave = document.getElementById('nick-save');
const nickSkip = document.getElementById('nick-skip');

function showNicknameModal(show = true) {
  if (!nicknameModal) return;
  nicknameModal.setAttribute('aria-hidden', String(!show));
  if (show) {
    if (nickInput) {
      nickInput.value = localNickname || '';
      nickInput.focus();
    }
  }
}

if (!localNickname) {
  // show the modal once when page loads if no saved nickname
  showNicknameModal(true);
}

if (nickSave) {
  nickSave.addEventListener('click', (e) => {
    e.preventDefault();
    const v = nickInput && nickInput.value.trim();
    if (v) {
      localStorage.setItem('nickname', v);
      localNickname = v;
      // update our presence nickname and username if room initialized so others see the change immediately
      if (room && multiplayer.clientId) {
        try {
          socket.updatePresence({ nickname: v, username: v });
          // also update local cache so UI updates without waiting for presence roundtrip
          if (multiplayer.clientId) remoteUsernames[multiplayer.clientId] = v;
        } catch (err) { /* ignore */ }
      }
      // remove/hide the change button so name can't be changed anymore in this session
      const changeBtn = document.getElementById('change-nick-btn');
      if (changeBtn && changeBtn.parentNode) {
        changeBtn.parentNode.removeChild(changeBtn);
      }
    }
    showNicknameModal(false);
  }, {passive:true});
}

if (nickSkip) {
  nickSkip.addEventListener('click', (e) => {
    e.preventDefault();
    showNicknameModal(false);
  }, {passive:true});
}

