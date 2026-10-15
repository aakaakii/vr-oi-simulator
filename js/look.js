'use strict';
/* =========================================================
   look —— FPS 视角 / 指针锁定 / 玩家移动 / 小地图
   （自 index.html 内联脚本拆出）
   ========================================================= */
/* =========================================================
   视角 / 玩家
   ========================================================= */
function applyLook(dt){
  /* 指针锁定不可用时仍可用方向键或右键拖动转头。 */
  yawTarget += ((state.keys.lookLeft ? 1 : 0) - (state.keys.lookRight ? 1 : 0)) * dt * 1.8;
  pitchTarget += ((state.keys.lookUp ? 1 : 0) - (state.keys.lookDown ? 1 : 0)) * dt * 1.4;
  /* 出拳回弹衰减：命中时 kickView 注入的视觉偏移平滑归零 */
  const kr = 1 - Math.exp(-dt * 11);
  recoilPitch += (0 - recoilPitch) * kr;
  recoilYaw   += (0 - recoilYaw)   * kr;

  /* 旋转输入由 mousemove（指针锁定）写入 yawTarget / pitchTarget，
     这里只负责平滑插值与俯仰限位 */
  pitchTarget = clamp(pitchTarget, -1.35, 1.35);

  if (smoothAmount < 0.01){
    state.yaw = yawTarget;
    state.pitch = pitchTarget;
  } else {
    const tau = smoothAmount * 0.16;
    const k = 1 - Math.exp(-dt / Math.max(tau, 0.001));
    state.yaw   += (yawTarget   - state.yaw)   * k;
    state.pitch += (pitchTarget - state.pitch) * k;
  }
}

/* =========================================================
   指针锁定：FPS 式鼠标捕获
   ========================================================= */
const LOOK_VIEWS = new Set(['world']);   // 仅世界视图捕获鼠标（走廊/IDE/面板一律释放）
const MAX_MOUSE_STEP = 80;               // 单次位移钳制（px），防异常跳变
let pointerLocked = false;
let dragLookPoint = null;
let lastLockAt = 0;

function lockElement(){
  return renderer ? renderer.domElement : document.body;
}
function canLockView(){
  return LOOK_VIEWS.has(state.view) && state.started && !state.ended;
}
function requestLock(){
  if (pointerLocked || !renderer || !canLockView()) return;
  const el = lockElement();
  if (!el.requestPointerLock) return;
  try {
    /* 新版 Chrome 返回 Promise；Esc 后短时间内申请会被拒绝，静默即可 */
    const r = el.requestPointerLock();
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch(e){}
}
function releaseLock(){
  if (!pointerLocked) return;
  try { document.exitPointerLock(); } catch(e){}
}

const KEYMAP = {
  KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd',
  ArrowLeft:'lookLeft', ArrowRight:'lookRight', ArrowUp:'lookUp', ArrowDown:'lookDown',
  ShiftLeft: 'shift', ShiftRight: 'shift',
};

/* 复用的临时向量，避免每帧 new Vector3 触发 GC */
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();

function updatePlayer(dt){
  updateJump(dt);
  const sprinting = !!state.keys['shift'];
  const speed = sprinting ? 5.0 : 3.1;   // Shift 加速
  _fwd.set(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
  _right.set(Math.cos(state.yaw), 0, -Math.sin(state.yaw));
  _move.set(0, 0, 0);
  if (state.keys['w']) _move.add(_fwd);
  if (state.keys['s']) _move.sub(_fwd);
  if (state.keys['d']) _move.add(_right);
  if (state.keys['a']) _move.sub(_right);

  const moving = _move.lengthSq() > 0;
  lastMoveSpeed = moving ? speed : 0;
  if (moving){
    _move.normalize().multiplyScalar(speed * dt);
    const nx = clamp(state.pos.x + _move.x, -7.5, 7.5);
    const nz = clamp(state.pos.z + _move.z, -6.5, 6.5);
    /* 分轴滑动碰撞 */
    /* 空中不碰障碍：可以翻身过桌面；落地时若卡进去会回溯到起跳点 */
    const air = !onGround;
    if (air || !collides(nx, state.pos.z, 0.28)) state.pos.x = nx;
    if (air || !collides(state.pos.x, nz, 0.28)) state.pos.z = nz;

    state.bob += dt * (sprinting ? 15 : 11);   // 疾走时脚步更急促
    if (Math.sin(state.bob) > 0.96 && Math.random() < 0.4) audio.step();
  } else {
    state.bob += dt * 1.2;
  }
  const bobY = moving ? Math.sin(state.bob) * 0.022 : Math.sin(state.bob) * 0.004;
  camera.position.set(state.pos.x, 1.65 + bobY, state.pos.z);
  camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
  /* 回弹是纯视觉叠加，不写回 state.yaw/pitch，不影响真实朝向 */
  camera.rotation.x += recoilPitch;
  camera.rotation.y += recoilYaw;
  /* 紧张态镜头抖动（同样只做视觉叠加） */
  applyShake(dt);
}

/* ---------- 跳跃 ----------
   空格起跳；重力积分 + 落地回零。dt 用世界步长，所以通报慢放期间
   跳跃也会一起变慢，与移动速度保持一致。 */
const JUMP_GRAVITY = 20;          // 重力（m/s²）
const JUMP_VELOCITY = 6.4;        // 起跳初速度（m/s）→ 跳高约 1.0m
let jumpY = 0, velY = 0, onGround = true;
const _jumpSafe = new THREE.Vector3(0, 0, -2.08);

function tryJump(){
  if (!onGround || state.view !== 'world' || state.ended) return;
  velY = JUMP_VELOCITY;
  onGround = false;
  _jumpSafe.set(state.pos.x, 0, state.pos.z);   /* 记下起跳点，落地回溯用 */
  audio.beep(420, 0.05, 0.03, 'triangle');
}

function updateJump(dt){
  if (onGround) return;
  velY -= JUMP_GRAVITY * dt;
  jumpY += velY * dt;
  if (jumpY <= 0){
    jumpY = 0;
    velY = 0;
    onGround = true;
    audio.step();
    /* 落点卡进障碍（比如桌面）→ 退回起跳点，不会卡死 */
    if (collides(state.pos.x, state.pos.z, 0.28)){
      state.pos.x = _jumpSafe.x;
      state.pos.z = _jumpSafe.z;
    }
  }
}

/* ---------- 紧张态镜头抖动 ----------
   多频率正弦叠加：高频细颤 + 低频摇摆，幅度 ∝ 紧张值 × 移动强度。
   抖动是"吓到手抖"，不是晕动症模拟器，上限刻意压得很小。 */
const SHAKE_MAX = 0.011;          // 最大角偏移（弧度，约 0.63°）
let lastMoveSpeed = 0;
let shakeT = 0;

function applyShake(dt){
  const t = getTension();
  if (t < 0.02 || !shakeEnabled){ lastMoveSpeed = 0; return; }
  shakeT += dt;
  const move = clamp(lastMoveSpeed / 5, 0, 1);
  const amp = SHAKE_MAX * t * (0.30 + 0.70 * move);
  const n1 = Math.sin(shakeT * 37.3) * Math.sin(shakeT * 11.7);
  const n2 = Math.sin(shakeT * 23.1 + 1.3) * Math.sin(shakeT * 7.9 + 0.6);
  camera.rotation.x += (n2 * 0.6 - n1 * 0.4) * amp;
  camera.rotation.y += (n1 * 0.7 + n2 * 0.5) * amp;
}

/* ---------- 出拳视角回弹 ---------- */
let recoilPitch = 0, recoilYaw = 0;
function kickView(pitchAmt, yawAmt){
  recoilPitch = clamp(recoilPitch + pitchAmt, -0.10, 0.10);
  recoilYaw   = clamp(recoilYaw   + yawAmt,   -0.10, 0.10);
}

/* =========================================================
   小地图
   ========================================================= */
function drawMinimap(){
  const c = minimap, ctx = mmCtx;
  const W = c.width, H = c.height;
  ctx.fillStyle = 'rgba(10,13,20,.85)';
  ctx.fillRect(0, 0, W, H);

  /* 世界：x∈[-8,8], z∈[-7,7] */
  const sx = W / 16, sy = H / 14;
  const tx = x => (x + 8) * sx;
  const ty = z => (z + 7) * sy;

  /* 障碍 */
  ctx.fillStyle = '#2a3242';
  for (const o of obstacles){
    ctx.fillRect(
      tx(o.x - o.hw), ty(o.z - o.hd),
      o.hw * 2 * sx, o.hd * 2 * sy
    );
  }

  /* NPC */
  for (const n of npcs){
    const ud = n.userData;
    if (!ud) continue;
    ctx.fillStyle = ud.state === 'seated' ? '#6a7a9a' : '#c08050';
    ctx.beginPath();
    ctx.arc(tx(n.group.position.x), ty(n.group.position.z), 2.2, 0, 7);
    ctx.fill();
  }

  /* 老师 */
  if (teacher){
    ctx.fillStyle = '#ffcc57';
    ctx.beginPath();
    ctx.arc(tx(teacher.group.position.x), ty(teacher.group.position.z), 2.8, 0, 7);
    ctx.fill();
  }

  /* 保安 */
  for (const g of securityGuards){
    if (!g.userData.alive) continue;
    const pulse = 0.7 + 0.3 * Math.sin(performance.now() * 0.01);
    ctx.fillStyle = `rgba(255,68,68,${pulse})`;
    ctx.beginPath();
    ctx.arc(tx(g.group.position.x), ty(g.group.position.z), 3.2, 0, 7);
    ctx.fill();
  }

  /* 玩家 + 朝向 */
  const px = tx(state.pos.x), py = ty(state.pos.z);
  ctx.fillStyle = '#5b8cff';
  ctx.beginPath();
  ctx.arc(px, py, 3.4, 0, 7);
  ctx.fill();
  ctx.strokeStyle = 'rgba(91,140,255,.85)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px - Math.sin(state.yaw) * 9, py - Math.cos(state.yaw) * 9);
  ctx.stroke();
}
