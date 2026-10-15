'use strict';
/* =========================================================
   tension —— 紧张值系统：出拳之后，考场开始"不对劲"
   ---------------------------------------------------------
   紧张值 0→1 由三部分决定（见 tensionTarget）：
   - 基础值：随已击倒保安数上升，TENSION_KILLS_FULL 人封顶；
   - 逼近增益：最近的保安越近，加成越高（最多 TENSION_NEAR_MAX）；
   - 平静通道：回到座位附近且几乎不动时，整体压到 TENSION_CALM_FLOOR
     倍——紧张不是单向的，给玩家一个"息事宁人"的出口。
   数值用两个时间常数平滑：上升快（RISE），回落慢（FALL）。

   所有氛围效果都挂在这个值上，各自渐变：
   灯光压暗 + 雾色/半球光向暗红偏移、canvas 对比度/去饱和/压暗、
   屏幕暗角 + 心跳节拍收缩、心跳音（BPM 随紧张度上升）、
   镜头抖动幅度、全局拖影强度（setPostDamp）、假接触阴影加深。
   ========================================================= */

const TENSION_KILLS_FULL = 120;    // 击倒这么多人 → 基础紧张值拉满
const TENSION_NEAR_MAX   = 0.18;   // 贴身时的最大增益
const TENSION_NEAR_RANGE = 4.0;    // 增益起作用的距离（米）
const TENSION_CALM_RADIUS = 1.6;   // 座位多大半径内算"坐定了"
const TENSION_CALM_SPEED  = 0.3;   // 坐定判定的移动速度阈值
const TENSION_CALM_FLOOR  = 0.55;  // 平静通道最多压到基础值的这个比例
const TENSION_RISE_TAU    = 1.1;   // 上升时间常数（秒）
const TENSION_FALL_TAU    = 3.4;   // 回落时间常数（秒）
const TENSION_NIGHTMARE_FLOOR = 0.22;   // 已经叫过保安后的紧张值下限

const TENSION_FOG_CALM = 0x090b11;   // 平时雾色
const TENSION_FOG_TENSE = 0x1d0709;  // 紧张态雾色（暗红）
const TENSION_SKY_CALM = 0xc8d8ff;   // 半球光天空色
const TENSION_SKY_TENSE = 0x8a3535;
const TENSION_GROUND_CALM = 0x232833;
const TENSION_GROUND_TENSE = 0x160a0a;

let tension = 0;
let tAmbient = null, tHemi = null, tPoints = [];
let heartPhase = 0, lastBeatIdx = -1;
const _tFogA = new THREE.Color(TENSION_FOG_CALM);
const _tFogB = new THREE.Color(TENSION_FOG_TENSE);
const _tSkyA = new THREE.Color(TENSION_SKY_CALM);
const _tSkyB = new THREE.Color(TENSION_SKY_TENSE);
const _tGndA = new THREE.Color(TENSION_GROUND_CALM);
const _tGndB = new THREE.Color(TENSION_GROUND_TENSE);

/* 纯函数：由击杀数 / 最近保安距离 / 是否坐定 / 噩梦是否开始 计算目标紧张值 */
function tensionTarget(kills, nearestDist, atSeat, nightmare){
  /* 基础值 = 屠杀记忆（击杀数 / 噩梦下限），只有它能被"坐定"平息 */
  let base = Math.min(1, (kills || 0) / TENSION_KILLS_FULL);
  if (nightmare) base = Math.max(base, TENSION_NIGHTMARE_FLOOR);
  if (atSeat) base *= TENSION_CALM_FLOOR;
  /* 贴身威胁是即时的，不打折——保安贴在脸上时坐在座位上也没用 */
  let near = 0;
  if (nearestDist < TENSION_NEAR_RANGE){
    near = TENSION_NEAR_MAX * (1 - nearestDist / TENSION_NEAR_RANGE);
  }
  return clamp(base + near, 0, 1);
}

function getTension(){
  return tension;
}

function initTension(){
  scene.traverse(o => {
    if (!tAmbient && o.isAmbientLight) tAmbient = o;
    if (!tHemi && o.isHemisphereLight) tHemi = o;
    if (o.isPointLight) tPoints.push(o);
  });
}

/* 每帧：平滑 + 施加全部氛围效果 */
function updateTension(dt, kills, nearestDist, playerSpeed){
  const dx = state.pos.x, dz = state.pos.z + 3;
  const atSeat = Math.hypot(dx, dz) < TENSION_CALM_RADIUS &&
                 playerSpeed < TENSION_CALM_SPEED;
  const nightmare = (state.guardsSpawned || 0) > 0;
  let target = tensionTarget(kills, nearestDist, atSeat, nightmare);
  /* 嘴硬是有代价的：每次违抗通报直接推高紧张值（最多 +0.25） */
  if (state.defiance > 0){
    target = clamp(target + Math.min(0.25, state.defiance * 0.12), 0, 1);
  }

  const tau = target > tension ? TENSION_RISE_TAU : TENSION_FALL_TAU;
  tension += (target - tension) * (1 - Math.exp(-dt / tau));

  applyTension(tension, dt);
  return tension;
}

function applyTension(t, dt){
  const cvs = $('scene');

  /* 1. 整体调色：压暗 + 对比度 + 去饱和（只作用于 WebGL 画面，不污染 HUD） */
  if (cvs){
    cvs.style.filter = !graphicsProfile().effects || t < 0.01 ? '' :
      'contrast(' + (1 + 0.24 * t).toFixed(3) + ') ' +
      'saturate(' + (1 - 0.30 * t).toFixed(3) + ') ' +
      'brightness(' + (1 - 0.26 * t).toFixed(3) + ')';
  }

  /* 2. 灯光压暗 + 色偏 */
  if (tAmbient) tAmbient.intensity = lerp(0.42, 0.09, t);
  if (tHemi){
    tHemi.intensity = lerp(0.5, 0.14, t);
    tHemi.color.copy(_tSkyA).lerp(_tSkyB, t);
    tHemi.groundColor.copy(_tGndA).lerp(_tGndB, t);
  }
  for (const p of tPoints){
    /* 警灯与终局白光的强度各自驱动，不随紧张值调光 */
    if (p.userData && p.userData.noTensionDim) continue;
    p.intensity = lerp(0.42, 0.12, t);
  }
  if (scene.fog) scene.fog.color.copy(_tFogA).lerp(_tFogB, t);

  /* 3. 假接触阴影加深（阴影更深的一种廉价实现） */
  if (typeof deepenContactShadows === 'function') deepenContactShadows(t);

  /* 4. 全局拖影强度（postfx 未加载时静默跳过） */
  if (typeof setPostDamp === 'function') setPostDamp(t);

  /* 5. 暗角 + 心跳收缩 */
  const vig = $('tenseVignette');
  if (t < 0.02){
    if (vig) vig.style.opacity = '0';
    heartPhase = 0; lastBeatIdx = -1;
  } else {
    const bpm = 68 + 84 * t;                       // 68 → 152
    heartPhase += dt * (bpm / 60) * Math.PI * 2;
    const idx = Math.floor(heartPhase / Math.PI);  // 每周期两声（扑-扑）
    if (idx !== lastBeatIdx){
      lastBeatIdx = idx;
      const second = idx % 2 === 1;
      audio.beep(second ? 52 : 44, second ? 0.16 : 0.20, 0.09 + 0.06 * t, 'sine');
    }
    if (vig){
      const beat = Math.pow(Math.max(0, Math.sin(heartPhase)), 6);
      vig.style.opacity = (0.40 * t + 0.26 * t * beat).toFixed(3);
    }
  }
}
