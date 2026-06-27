/**
 * ⚽ Penalty Shootout – game.js
 * ─────────────────────────────────────────────────────────────
 * Architecture:
 *  - GameState   : data store (score, phase, difficulty)
 *  - Renderer    : all canvas drawing
 *  - Physics     : ball arc / trajectory maths
 *  - GoalkeeperAI: decision + animation
 *  - UI          : DOM wiring, controls, toasts
 *  - Game        : top-level loop + orchestration
 */

'use strict';

/* ══════════════════════════════════════════════════════════════
   CONFIG
══════════════════════════════════════════════════════════════ */
const CFG = {
  // Canvas logical size (scaled to fill width)
  W: 900, H: 500,

  // Goal geometry (logical px)
  goalW: 320, goalH: 110,
  postW: 8,

  // Ball
  ballRadius: 11,
  ballStartX: 450, ballStartY: 420,

  // Goalkeeper
  gkW: 46, gkH: 72,
  gkStartX: 450, gkStartY: 295,   // feet-base Y

  // Pitch colours
  pitchStripes: ['#1d4a10', '#225612'],
  lineColour: 'rgba(255,255,255,0.55)',
  netColour: 'rgba(220,230,255,0.18)',

  // Animation
  shotDuration: 900,   // ms for ball to travel to goal
  gkDiveDuration: 500,

  // Difficulty modifiers (applied at runtime)
  difficulty: {
    easy:   { reactionMs: 420, accuracy: 0.48, predBias: 0.15 },
    medium: { reactionMs: 260, accuracy: 0.65, predBias: 0.35 },
    hard:   { reactionMs: 120, accuracy: 0.82, predBias: 0.60 },
  },
};

/* ══════════════════════════════════════════════════════════════
   GAME STATE
══════════════════════════════════════════════════════════════ */
const State = {
  goals: 0, shots: 0, saves: 0, misses: 0,
  streak: 0, bestStreak: 0, points: 0,
  phase: 'idle',   // idle | animating | result
  difficulty: 'medium',
  diffLevel: 1,    // increases over shots
  shot: null,      // current shot params
  result: null,    // 'goal'|'save'|'miss'|'post'
  particles: [],
  netWave: 0,      // net celebration ripple

  reset() {
    Object.assign(this, {
      goals:0, shots:0, saves:0, misses:0,
      streak:0, bestStreak:0, points:0,
      phase:'idle', diffLevel:1,
      shot:null, result:null, particles:[], netWave:0,
    });
  },
};

/* ══════════════════════════════════════════════════════════════
   PHYSICS  (all in logical canvas coordinates)
══════════════════════════════════════════════════════════════ */
const Physics = {
  /**
   * Map shot params → target pixel on goal line.
   * h: left|center|right  v: top|mid|low  power: 20–100  curve: -1|0|1
   */
  targetXY(h, v, curve) {
    const gLeft  = (CFG.W - CFG.goalW) / 2 + CFG.postW + 4;
    const gRight = (CFG.W + CFG.goalW) / 2 - CFG.postW - 4;
    const gTop   = CFG.H - CFG.goalH - 108;   // goal top (logical)
    const gBot   = CFG.H - 108;               // goal bottom / ground line

    const xMap = { left: gLeft + 40, center: CFG.W / 2, right: gRight - 40 };
    const yMap = { top: gTop + 18, mid: (gTop + gBot) / 2, low: gBot - 18 };

    // Apply curve (shifts x slightly)
    const tx = xMap[h] + curve * 38;
    const ty = yMap[v];
    return { tx, ty };
  },

  /**
   * Ball arc position at time t (0→1).
   * Returns {x, y, scale} where scale simulates depth.
   */
  ballPos(t, tx, ty, power, curve) {
    const sx = CFG.ballStartX;
    const sy = CFG.ballStartY;

    // Lateral: linear + curve drift
    const x = sx + (tx - sx) * t + curve * 60 * t * (1 - t);

    // Vertical: starts at ground, rises then reaches ty
    // Height peak depends on power and vertical target
    const peak = sy - (0.3 + power / 250) * CFG.H * 0.55;
    // Quadratic Bezier: P0=sy, P1=peak (control), P2=ty
    const y = (1 - t) * (1 - t) * sy + 2 * (1 - t) * t * peak + t * t * ty;

    // Scale: ball appears smaller at distance (near top)
    const scale = 0.45 + 0.55 * (1 - t * 0.6);
    return { x, y, scale };
  },
};

/* ══════════════════════════════════════════════════════════════
   GOALKEEPER AI
══════════════════════════════════════════════════════════════ */
const GK = {
  x: CFG.gkStartX,
  y: CFG.gkStartY,
  targetX: CFG.gkStartX,
  targetY: CFG.gkStartY,
  diveAngle: 0,
  state: 'idle',     // idle | diving | saved | recovering
  diveT: 0,
  armRaise: 0,
  legKick: 0,
  bodyLean: 0,

  reset() {
    this.x = CFG.gkStartX;
    this.y = CFG.gkStartY;
    this.targetX = CFG.gkStartX;
    this.diveAngle = 0;
    this.state = 'idle';
    this.diveT = 0;
    this.armRaise = 0;
    this.legKick = 0;
    this.bodyLean = 0;
  },

  /**
   * Decide where to dive based on shot params & difficulty.
   * Called as soon as player shoots (but movement starts after reaction delay).
   */
  decide(shotH, shotV, shotPower, curve, diffKey, diffLevel) {
    const cfg = CFG.difficulty[diffKey];
    // Effective accuracy increases with diffLevel
    const accuracy = Math.min(0.95, cfg.accuracy + diffLevel * 0.018);
    const predBias  = Math.min(0.9,  cfg.predBias + diffLevel * 0.012);

    // Predict player's likely direction
    let diveH, diveV;
    if (Math.random() < accuracy) {
      // Correct read
      diveH = shotH;
    } else {
      const dirs = ['left','center','right'];
      diveH = dirs[Math.floor(Math.random() * 3)];
    }
    if (Math.random() < predBias) {
      diveV = shotV;
    } else {
      const vDirs = ['top','mid','low'];
      diveV = vDirs[Math.floor(Math.random() * 3)];
    }

    // Translate to canvas coordinates
    const gLeft   = (CFG.W - CFG.goalW) / 2 + CFG.postW;
    const gRight  = (CFG.W + CFG.goalW) / 2 - CFG.postW;
    const xMap = { left: gLeft + 55, center: CFG.W / 2, right: gRight - 55 };
    const yMap = { top: CFG.gkStartY - 60, mid: CFG.gkStartY - 20, low: CFG.gkStartY + 10 };

    this.targetX = xMap[diveH];
    this.targetY = yMap[diveV];

    // Dive angle
    const dx = this.targetX - CFG.gkStartX;
    this.diveAngle = dx < -30 ? -1 : dx > 30 ? 1 : 0;  // -1=left, 0=up, 1=right

    // Store what the GK predicted so outcome logic can compare
    this.predictedH = diveH;
    this.predictedV = diveV;

    return cfg.reactionMs;  // caller uses this for delay
  },

  /** Called on each animation frame while animating. t: 0→1 */
  updateDive(t) {
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    this.x = CFG.gkStartX + (this.targetX - CFG.gkStartX) * ease;
    this.y = CFG.gkStartY + (this.targetY - CFG.gkStartY) * ease;
    this.diveT = t;
    this.armRaise = Math.min(1, t * 2);
    this.legKick  = t > 0.3 ? (t - 0.3) / 0.7 : 0;
    this.bodyLean = this.diveAngle * Math.min(1, t * 3) * 0.5; // radians
  },

  recover() {
    this.state = 'recovering';
  },
};

/* ══════════════════════════════════════════════════════════════
   PARTICLE SYSTEM
══════════════════════════════════════════════════════════════ */
const Particles = {
  spawn(cx, cy, count, type) {
    const colours = {
      goal: ['#3bff6c','#fff','#e8c229','#a3ffbe'],
      save: ['#ff5f3b','#ffb347','#fff'],
      post: ['#e8c229','#fff','#aaa'],
    };
    const palette = colours[type] || colours.goal;
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - .5) * 0.8;
      const speed = 2 + Math.random() * 5;
      State.particles.push({
        x: cx, y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - Math.random() * 3,
        life: 1,
        decay: 0.016 + Math.random() * 0.02,
        r: 3 + Math.random() * 5,
        colour: palette[Math.floor(Math.random() * palette.length)],
      });
    }
  },

  update() {
    for (const p of State.particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.18; // gravity
      p.life -= p.decay;
      p.r = Math.max(0, p.r - 0.04);
    }
    State.particles = State.particles.filter(p => p.life > 0);
  },

  draw(ctx) {
    for (const p of State.particles) {
      ctx.save();
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.colour;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  },
};

/* ══════════════════════════════════════════════════════════════
   RENDERER
══════════════════════════════════════════════════════════════ */
const Renderer = {
  ctx: null,
  W: CFG.W, H: CFG.H,

  init(canvas) {
    this.ctx = canvas.getContext('2d');
    canvas.width  = CFG.W;
    canvas.height = CFG.H;
  },

  /* ── Main draw ─────────────────────────────────────── */
  draw(ballX, ballY, ballScale, showBall) {
    const { ctx } = this;
    ctx.clearRect(0, 0, CFG.W, CFG.H);

    this.drawField();
    this.drawCrowd();
    this.drawGoal();
    this.drawNet();
    if (State.netWave > 0) this.drawNetCelebration();
    this.drawPenaltySpot();
    this.drawGoalkeeper();
    if (showBall) this.drawBall(ballX, ballY, ballScale);
    Particles.draw(ctx);
    this.drawFloodlightGlow();
  },

  /* ── Pitch ─────────────────────────────────────────── */
  drawField() {
    const { ctx } = this;
    const stripeW = CFG.W / 8;
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = CFG.pitchStripes[i % 2];
      ctx.fillRect(i * stripeW, 0, stripeW, CFG.H);
    }

    // Ground gradient – make horizon darker
    const grad = ctx.createLinearGradient(0, 0, 0, CFG.H);
    grad.addColorStop(0,   'rgba(0,0,0,0.45)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0.05)');
    grad.addColorStop(1,   'rgba(0,0,0,0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, CFG.W, CFG.H);

    // Ground line (below goal)
    const groundY = CFG.H - 108;
    ctx.strokeStyle = CFG.lineColour;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(CFG.W, groundY);
    ctx.stroke();

    // Penalty area box
    const boxW = 420, boxH = 155;
    const boxX = (CFG.W - boxW) / 2;
    const boxY = groundY - boxH;
    ctx.strokeStyle = CFG.lineColour;
    ctx.lineWidth = 2;
    ctx.strokeRect(boxX, boxY, boxW, boxH);

    // 6-yard box
    const smW = 200, smH = 65;
    const smX = (CFG.W - smW) / 2;
    ctx.strokeRect(smX, boxY, smW, smH);

    // Penalty spot
    ctx.fillStyle = CFG.lineColour;
    ctx.beginPath();
    ctx.arc(CFG.W / 2, CFG.ballStartY, 3, 0, Math.PI * 2);
    ctx.fill();

    // Centre circle arc (partial, for aesthetic)
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(CFG.W / 2, CFG.H + 40, 160, Math.PI, 0);
    ctx.stroke();
  },

  /* ── Crowd silhouettes ─────────────────────────────── */
  drawCrowd() {
    const { ctx } = this;
    // Simple tiled crowd silhouettes near the top
    ctx.save();
    ctx.globalAlpha = 0.35;
    const heads = ['#1a3a5c','#162e4a','#0e2236'];
    const rowY = [18, 38, 58];
    const spacing = 22;
    for (let row = 0; row < 3; row++) {
      for (let xi = 0; xi < Math.ceil(CFG.W / spacing) + 1; xi++) {
        const x = xi * spacing + (row % 2) * 11;
        const y = rowY[row];
        // Head
        ctx.fillStyle = heads[row];
        ctx.beginPath();
        ctx.arc(x, y, 7 - row, 0, Math.PI * 2);
        ctx.fill();
        // Shoulders
        ctx.fillRect(x - 10 + row * 2, y + 6, 20 - row * 4, 10);
      }
    }
    // Occasional colour splash (fans with scarves)
    const scarfColours = ['#e8c229','#e63946','#3bff6c','#4a90d9'];
    for (let i = 0; i < 28; i++) {
      const x = (i * 33 + 5) % CFG.W;
      const y = rowY[i % 3];
      ctx.fillStyle = scarfColours[i % scarfColours.length];
      ctx.globalAlpha = 0.25;
      ctx.fillRect(x - 8, y - 4, 16, 3);
    }
    ctx.restore();
  },

  /* ── Goal posts ────────────────────────────────────── */
  drawGoal() {
    const { ctx } = this;
    const gL = (CFG.W - CFG.goalW) / 2;
    const gR = (CFG.W + CFG.goalW) / 2;
    const gTop  = CFG.H - CFG.goalH - 108;
    const gBot  = CFG.H - 108;
    const pW = CFG.postW;

    // Shadow under posts
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 10;

    // Posts & crossbar – bright white with 3-D bevel
    const drawPost = (x, y, w, h) => {
      const grad = ctx.createLinearGradient(x, 0, x + w, 0);
      grad.addColorStop(0,   '#ffffff');
      grad.addColorStop(0.4, '#dde8ff');
      grad.addColorStop(1,   '#a0b8cc');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, w, h);
    };

    drawPost(gL, gTop, pW, gBot - gTop);                 // left post
    drawPost(gR - pW, gTop, pW, gBot - gTop);            // right post
    drawPost(gL, gTop, gR - gL, pW);                     // crossbar

    ctx.restore();
  },

  /* ── Net ───────────────────────────────────────────── */
  drawNet() {
    const { ctx } = this;
    const gL = (CFG.W - CFG.goalW) / 2 + CFG.postW;
    const gR = (CFG.W + CFG.goalW) / 2 - CFG.postW;
    const gTop  = CFG.H - CFG.goalH - 108 + CFG.postW;
    const gBot  = CFG.H - 108;
    const netDepth = 38; // how far back the net goes

    ctx.save();
    ctx.strokeStyle = CFG.netColour;
    ctx.lineWidth = 0.8;

    // Horizontal lines
    const hSpacing = 14;
    for (let y = gTop; y <= gBot; y += hSpacing) {
      const ratio = (y - gTop) / (gBot - gTop);
      const shrink = ratio * netDepth;
      ctx.beginPath();
      ctx.moveTo(gL + shrink * 0.4, y);
      ctx.lineTo(gR - shrink * 0.4, y);
      ctx.stroke();
    }
    // Vertical lines
    const vSpacing = 22;
    for (let x = gL; x <= gR; x += vSpacing) {
      const relX = (x - gL) / (gR - gL);
      ctx.beginPath();
      ctx.moveTo(x, gTop);
      ctx.lineTo(gL + relX * (gR - gL - netDepth * 0.4), gBot);
      ctx.stroke();
    }

    ctx.restore();
  },

  /* ── Net ripple on goal ────────────────────────────── */
  drawNetCelebration() {
    const { ctx } = this;
    const gL = (CFG.W - CFG.goalW) / 2 + CFG.postW;
    const gR = (CFG.W + CFG.goalW) / 2 - CFG.postW;
    const gTop = CFG.H - CFG.goalH - 108 + CFG.postW;
    const gBot = CFG.H - 108;
    const w = State.netWave;

    ctx.save();
    ctx.fillStyle = `rgba(59,255,108,${w * 0.08})`;
    ctx.fillRect(gL, gTop, gR - gL, gBot - gTop);
    ctx.restore();

    State.netWave = Math.max(0, State.netWave - 0.03);
  },

  /* ── Penalty spot marker ───────────────────────────── */
  drawPenaltySpot() {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    const s = 10;
    ctx.beginPath();
    ctx.moveTo(CFG.W / 2 - s, CFG.ballStartY);
    ctx.lineTo(CFG.W / 2 + s, CFG.ballStartY);
    ctx.moveTo(CFG.W / 2, CFG.ballStartY - s);
    ctx.lineTo(CFG.W / 2, CFG.ballStartY + s);
    ctx.stroke();
    ctx.restore();
  },

  /* ── Goalkeeper ────────────────────────────────────── */
  drawGoalkeeper() {
    const { ctx } = this;
    const { x, y, diveT, armRaise, diveAngle, bodyLean } = GK;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(bodyLean * 0.35);

    const gkW = CFG.gkW;
    const gkH = CFG.gkH;

    // Shadow
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#000';
    ctx.scale(1, 0.25);
    ctx.beginPath();
    ctx.ellipse(0, gkH * 0.05, gkW * 0.6, gkW * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Legs
    const legSpread = diveT * 20 * Math.abs(diveAngle || 0.1);
    const legColour = '#1a237e';
    // Left leg
    ctx.save();
    ctx.fillStyle = legColour;
    ctx.beginPath();
    ctx.roundRect(-gkW * 0.22 - legSpread * 0.3, -gkH * 0.38,
                   gkW * 0.28, gkH * 0.42, 5);
    ctx.fill();
    ctx.restore();
    // Right leg
    ctx.save();
    ctx.fillStyle = legColour;
    ctx.beginPath();
    ctx.roundRect(gkW * 0.22 - gkW * 0.28 + legSpread * 0.3, -gkH * 0.38,
                   gkW * 0.28, gkH * 0.42, 5);
    ctx.fill();
    ctx.restore();

    // Boots
    const bootColour = '#111';
    const bootW = gkW * 0.25, bootH = gkH * 0.1;
    ctx.fillStyle = bootColour;
    ctx.beginPath();
    ctx.roundRect(-gkW * 0.28 - legSpread * 0.35, -gkH * 0.06,
                   bootW + 4, bootH, 3);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(gkW * 0.06 + legSpread * 0.35, -gkH * 0.06,
                   bootW + 4, bootH, 3);
    ctx.fill();

    // Body / jersey
    const jerseyGrad = ctx.createLinearGradient(-gkW * 0.35, -gkH, gkW * 0.35, -gkH * 0.3);
    jerseyGrad.addColorStop(0,   '#f5c518');
    jerseyGrad.addColorStop(0.5, '#e8ac10');
    jerseyGrad.addColorStop(1,   '#c98800');
    ctx.fillStyle = jerseyGrad;
    ctx.beginPath();
    ctx.roundRect(-gkW * 0.35, -gkH * 0.9, gkW * 0.7, gkH * 0.54, 7);
    ctx.fill();

    // Jersey number
    ctx.fillStyle = '#000';
    ctx.font = `bold ${gkW * 0.22}px Inter`;
    ctx.textAlign = 'center';
    ctx.fillText('1', 0, -gkH * 0.52);

    // Arms – raised on dive
    const armAngleL = -(0.3 + armRaise * 1.1 + (diveAngle < 0 ? 0.6 : 0));
    const armAngleR =  (0.3 + armRaise * 1.1 + (diveAngle > 0 ? 0.6 : 0));
    const armLen = gkW * 0.65;
    const armW   = gkW * 0.18;

    ctx.fillStyle = '#e8ac10';
    // Left arm
    ctx.save();
    ctx.translate(-gkW * 0.32, -gkH * 0.72);
    ctx.rotate(armAngleL);
    ctx.beginPath();
    ctx.roundRect(-armW / 2, 0, armW, armLen, 5);
    ctx.fill();
    // Glove
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(-armW / 2 + armW / 2, armLen, armW * 0.75, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Right arm
    ctx.save();
    ctx.translate(gkW * 0.32, -gkH * 0.72);
    ctx.rotate(armAngleR);
    ctx.beginPath();
    ctx.fillStyle = '#e8ac10';
    ctx.roundRect(-armW / 2, 0, armW, armLen, 5);
    ctx.fill();
    // Glove
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(armW / 2 - armW / 2, armLen, armW * 0.75, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Head
    ctx.fillStyle = '#e8b88a';
    ctx.beginPath();
    ctx.arc(0, -gkH * 1.0, gkW * 0.28, 0, Math.PI * 2);
    ctx.fill();

    // Hair
    ctx.fillStyle = '#3d2200';
    ctx.beginPath();
    ctx.ellipse(0, -gkH * 1.1, gkW * 0.27, gkW * 0.14, 0, Math.PI, 0);
    ctx.fill();

    // Eyes
    ctx.fillStyle = '#333';
    ctx.beginPath();
    ctx.ellipse(-gkW * 0.1, -gkH * 1.0, 2.5, 3, 0, 0, Math.PI * 2);
    ctx.ellipse( gkW * 0.1, -gkH * 1.0, 2.5, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Keeper gloves (on hands near body when idle)
    if (diveT < 0.05) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(-gkW * 0.38, -gkH * 0.42, 7, 0, Math.PI * 2);
      ctx.arc( gkW * 0.38, -gkH * 0.42, 7, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  },

  /* ── Ball ──────────────────────────────────────────── */
  drawBall(bx, by, scale) {
    const { ctx } = this;
    const r = CFG.ballRadius * scale;

    ctx.save();
    ctx.translate(bx, by);

    // Shadow
    ctx.globalAlpha = 0.25 * scale;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(0, r * 0.5, r * 0.9, r * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Ball base
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    const ballGrad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.05, 0, 0, r);
    ballGrad.addColorStop(0, '#ffffff');
    ballGrad.addColorStop(1, '#cccccc');
    ctx.fillStyle = ballGrad;
    ctx.fill();
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 0.6;
    ctx.stroke();

    // Pentagon patches
    ctx.fillStyle = '#222';
    const patchAngles = [0, 72, 144, 216, 288];
    for (const a of patchAngles) {
      const rad = (a * Math.PI) / 180;
      const px = Math.cos(rad) * r * 0.5;
      const py = Math.sin(rad) * r * 0.5;
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const pa = rad + (i * 2 * Math.PI) / 5;
        const pr = r * 0.25;
        if (i === 0) ctx.moveTo(px + Math.cos(pa) * pr, py + Math.sin(pa) * pr);
        else ctx.lineTo(px + Math.cos(pa) * pr, py + Math.sin(pa) * pr);
      }
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  },

  /* ── Floodlight glow overlay ───────────────────────── */
  drawFloodlightGlow() {
    const { ctx } = this;
    // Left floodlight
    const addGlow = (cx, cy) => {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 220);
      g.addColorStop(0,   'rgba(255,255,220,0.08)');
      g.addColorStop(0.5, 'rgba(255,255,200,0.03)');
      g.addColorStop(1,   'transparent');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, CFG.W, CFG.H);
    };
    addGlow(60, 10);
    addGlow(CFG.W - 60, 10);
  },
};

/* ══════════════════════════════════════════════════════════════
   UI  HELPERS
══════════════════════════════════════════════════════════════ */
const UI = {
  toast: null,
  toastTimer: null,

  init() {
    this.toast = document.getElementById('resultToast');
  },

  updateScoreboard() {
    document.getElementById('sbGoals').textContent  = State.goals;
    document.getElementById('sbShots').textContent  = State.shots;
    document.getElementById('sbSaves').textContent  = State.saves;
    document.getElementById('sbMisses').textContent = State.misses;
    document.getElementById('sbStreak').textContent = State.streak;
    document.getElementById('sbPoints').textContent = State.points;
  },

  showToast(text, type) {
    clearTimeout(this.toastTimer);
    const t = this.toast;
    t.textContent = text;
    t.className = `result-toast show ${type}`;
    this.toastTimer = setTimeout(() => {
      t.className = 'result-toast hidden';
    }, 1600);
  },

  setShootEnabled(enabled) {
    document.getElementById('shootBtn').disabled = !enabled;
  },

  showOverlay(stats) {
    const ov = document.getElementById('overlay');
    const accuracy = stats.shots > 0
      ? Math.round((stats.goals / stats.shots) * 100) : 0;

    ov.innerHTML = `
      <h2>GAME OVER</h2>
      <p>Your penalty shootout session is complete.</p>
      <div class="overlay-stats">
        <div class="ov-stat"><span class="val">${stats.goals}</span><span class="lbl">GOALS</span></div>
        <div class="ov-stat"><span class="val">${stats.shots}</span><span class="lbl">SHOTS</span></div>
        <div class="ov-stat"><span class="val">${accuracy}%</span><span class="lbl">ACCURACY</span></div>
        <div class="ov-stat"><span class="val">${stats.bestStreak}</span><span class="lbl">BEST STREAK</span></div>
        <div class="ov-stat"><span class="val">${stats.points}</span><span class="lbl">POINTS</span></div>
      </div>
      <button class="ov-btn" onclick="Game.restart()">PLAY AGAIN</button>
    `;
    ov.classList.remove('hidden');
  },

  hideOverlay() {
    document.getElementById('overlay').classList.add('hidden');
  },
};

/* ══════════════════════════════════════════════════════════════
   GAME  ORCHESTRATOR
══════════════════════════════════════════════════════════════ */
const Game = {
  canvas: null,
  animId: null,

  // Current shot tracking
  ballX: CFG.ballStartX,
  ballY: CFG.ballStartY,
  ballScale: 1,
  showBall: true,

  animStart: 0,
  gkMoveStart: 0,
  gkMoveStarted: false,

  // Selected shot params (from controls)
  shotH: 'center', shotV: 'mid', shotPower: 70, shotCurve: 0,

  // Max shots per session
  MAX_SHOTS: 20,

  /* ── Init ────────────────────────────────────────── */
  init() {
    this.canvas = document.getElementById('gameCanvas');
    Renderer.init(this.canvas);
    UI.init();
    this.bindControls();
    this.reset();
    this.loop(0);
  },

  /* ── Reset / Restart ─────────────────────────────── */
  reset() {
    State.reset();
    State.difficulty = document.getElementById('diffSelect').value;
    GK.reset();
    this.ballX = CFG.ballStartX;
    this.ballY = CFG.ballStartY;
    this.ballScale = 1;
    this.showBall = true;
    UI.updateScoreboard();
    UI.hideOverlay();
    UI.setShootEnabled(true);
    State.phase = 'idle';
  },

  restart() {
    this.reset();
  },

  /* ── Control binding ─────────────────────────────── */
  bindControls() {
    // Direction grid
    document.querySelectorAll('.dir-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.dir-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.shotH = btn.dataset.h;
        this.shotV = btn.dataset.v;
      });
    });

    // Power slider
    const powerSlider = document.getElementById('powerSlider');
    powerSlider.addEventListener('input', () => {
      this.shotPower = parseInt(powerSlider.value, 10);
      document.getElementById('powerVal').textContent = this.shotPower;
    });

    // Curve buttons
    document.querySelectorAll('.curve-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.curve-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.shotCurve = parseInt(btn.dataset.curve, 10);
      });
    });

    // Shoot
    document.getElementById('shootBtn').addEventListener('click', () => this.shoot());

    // Reset
    document.getElementById('resetBtn').addEventListener('click', () => this.restart());

    // Difficulty change
    document.getElementById('diffSelect').addEventListener('change', e => {
      State.difficulty = e.target.value;
    });
  },

  /* ── Shoot ───────────────────────────────────────── */
  shoot() {
    if (State.phase !== 'idle') return;

    State.shots++;
    State.phase = 'animating';
    UI.setShootEnabled(false);

    const h = this.shotH, v = this.shotV;
    const power = this.shotPower, curve = this.shotCurve;

    // Compute target
    const { tx, ty } = Physics.targetXY(h, v, curve);

    // Ask GK to decide first (sets GK.predictedH/V) — returns reaction delay
    const reactionMs = GK.decide(h, v, power, curve, State.difficulty, State.diffLevel);

    // NOW determine outcome — uses GK.predictedH/V set above
    const outcome = this.resolveOutcome(h, v, power, curve, State.difficulty);

    // Track animation
    this.animStart = performance.now();
    this.gkMoveStarted = false;

    const shotDur = CFG.shotDuration * (0.6 + (1 - power / 100) * 0.8);

    const animate = (now) => {
      const elapsed = now - this.animStart;
      const t = Math.min(1, elapsed / shotDur);

      // Ball position
      const pos = Physics.ballPos(t, tx, ty, power, curve);
      this.ballX = pos.x;
      this.ballY = pos.y;
      this.ballScale = pos.scale;

      // GK movement after reaction time
      if (!this.gkMoveStarted && elapsed >= reactionMs) {
        this.gkMoveStarted = true;
        GK.state = 'diving';
        this.gkDiveStart = now;
      }
      if (GK.state === 'diving') {
        const gkT = Math.min(1, (now - this.gkDiveStart) / CFG.gkDiveDuration);
        GK.updateDive(gkT);
      }

      if (t < 1) {
        this.animId = requestAnimationFrame(animate);
      } else {
        // Animation done – resolve
        this.resolveResult(outcome, tx, ty);
      }
    };
    requestAnimationFrame(animate);
  },

  /* ── Outcome logic ───────────────────────────────── */
  // Called AFTER GK.decide() so GK.predictedH/V are already set.
  // Outcome is driven by whether the GK dived to the RIGHT zone.
  resolveOutcome(h, v, power, curve, diff) {
    const isTopCorner = (v === 'top') && (h !== 'center');

    // Small chance of miss (wayward shot) regardless of GK
    const missChance = power > 88 ? 0.10 : 0.04;
    const postChance = isTopCorner ? 0.06 : 0.02;
    const r = Math.random();
    if (r < missChance) return 'miss';
    if (r < missChance + postChance) return 'post';

    // Did the GK dive to the correct horizontal AND vertical zone?
    const hMatch = GK.predictedH === h;
    const vMatch = GK.predictedV === v;

    if (hMatch && vMatch) {
      // GK got it exactly right — save, but harder shots still slip through
      // on Easy the GK always saves a correct read; on Hard same, but harder to fool
      const saveChance = diff === 'easy' ? 0.80 : diff === 'medium' ? 0.88 : 0.94;
      return Math.random() < saveChance ? 'save' : 'goal';
    }

    if (hMatch && !vMatch) {
      // Right direction but wrong height — partial reach, low save chance
      return Math.random() < 0.18 ? 'save' : 'goal';
    }

    if (!hMatch && vMatch) {
      // Wrong side — GK dives away, no save
      return Math.random() < 0.05 ? 'save' : 'goal';
    }

    // Completely wrong — ball flies into empty corner → GOAL
    return Math.random() < 0.03 ? 'save' : 'goal';
  },

  /* ── Apply outcome after animation ──────────────── */
  resolveResult(outcome, tx, ty) {
    State.result = outcome;
    State.phase  = 'result';

    // Points calculation
    let pts = 0;
    if (outcome === 'goal') {
      pts = 10;
      // Bonus: top corner
      const h = this.shotH, v = this.shotV;
      if (v === 'top' && h !== 'center') pts += 5;
      // Bonus: powerful shot
      if (this.shotPower >= 85) pts += 3;
      // Streak bonus
      State.streak++;
      if (State.streak > State.bestStreak) State.bestStreak = State.streak;
      if (State.streak >= 3) pts += State.streak * 2;

      State.goals++;
      State.points += pts;
      State.netWave = 1;

      // Goal particles at target
      Particles.spawn(tx, ty, 55, 'goal');
      // Extra burst
      setTimeout(() => Particles.spawn(tx, ty - 20, 30, 'goal'), 120);

      UI.showToast(`⚽ GOAL! +${pts}pts`, 'goal');
    } else if (outcome === 'save') {
      State.streak = 0;
      State.saves++;
      Particles.spawn(GK.x, GK.y - CFG.gkH * 0.6, 22, 'save');
      UI.showToast('🧤 SAVED!', 'save');
    } else if (outcome === 'miss') {
      State.streak = 0;
      State.misses++;
      UI.showToast('❌ MISS', 'miss');
    } else if (outcome === 'post') {
      State.streak = 0;
      State.misses++;
      Particles.spawn(tx, ty, 18, 'post');
      UI.showToast('🔔 POST!', 'post');
    }

    UI.updateScoreboard();

    // Increase difficulty level every 5 shots
    if (State.shots % 5 === 0) State.diffLevel++;

    // Show ball at goal for a moment then reset
    setTimeout(() => this.afterShot(), 1800);
  },

  /* ── Reset after each shot ───────────────────────── */
  afterShot() {
    // Check session end
    if (State.shots >= this.MAX_SHOTS) {
      UI.showOverlay({
        goals:       State.goals,
        shots:       State.shots,
        bestStreak:  State.bestStreak,
        points:      State.points,
      });
      State.phase = 'gameover';
      return;
    }

    // Reset ball and GK positions
    this.ballX = CFG.ballStartX;
    this.ballY = CFG.ballStartY;
    this.ballScale = 1;
    this.showBall = true;
    GK.reset();
    State.phase = 'idle';
    UI.setShootEnabled(true);
  },

  /* ── Main render loop ────────────────────────────── */
  loop(now) {
    Particles.update();
    Renderer.draw(this.ballX, this.ballY, this.ballScale, this.showBall);
    requestAnimationFrame(t => this.loop(t));
  },
};

/* ── Boot ─────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => Game.init());
