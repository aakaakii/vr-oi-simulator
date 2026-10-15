'use strict';
/* =========================================================
   core —— 工具函数 / 全局状态 / 几何材质缓存 / 音频 / DOM 引用 / 视角设置
   （自 index.html 内联脚本拆出）
   ========================================================= */
/* =========================================================
   VR OI 考场 · 模拟器
   ========================================================= */

/* ---------- 工具函数 ---------- */
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

function fmtTime(sec){
  sec = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor(sec % 3600 / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/* 确定性随机：用代码 hash 作为种子，避免反复提交刷分 */
function hashStr(s){
  let h = 2166136261;
  for (let i = 0; i < s.length; i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed){
  return function(){
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ---------- 全局状态 ---------- */
const CONTEST_LEN = 4 * 3600;

const state = {
  started: false, ended: false, frozen: false,
  view: 'world',
  elapsed: 0,
  yaw: 0, pitch: 0,
  pos: new THREE.Vector3(0, 1.65, -1.72),
  keys: {},
  code: {}, score: {}, curProb: '', totalScore: 0,
  problems: [],
  npcProbId: '',       // 本局所有 NPC 展示的题目 id
  bob: 0,
  warnCount: 0, wanderTimer: 0,
  teacherWarnActive: false, bathroomApproved: false,
  teacherDown: false,             // 是否已打倒监考（决定同学可否被攻击）
  hp: 3, hpVisible: false,        // 血条（监考倒台后才显示）
  doorOpen: false,                // 终局：门已开
  lastDamageAt: -999,             // 玩家上次受击时间（世界时钟；-999 = 还没挨过打）
  worldTime: 0,                   // 世界时钟（秒）：只累计 worldDt，慢放时同比例变慢
  guardKills: 0, submitCount: {}, achievements: new Set(),
  guardsSpawned: 0,
  defiance: 0,                // 违抗保安通报的次数（推高紧张值）
  startTime: 0,
  wanderCount: 0,              // 离开座位触发警告的次数
  wanderPenaltyApplied: false  // 是否已触发"时间锁定"惩罚
};

/* ---------- 性能：几何 / 材质缓存 ---------- */
const geoCache = new Map();
const matCache = new Map();

function getBoxGeo(w, h, d){
  const k = `${w}|${h}|${d}`;
  let g = geoCache.get(k);
  if (!g){ g = new THREE.BoxGeometry(w, h, d); geoCache.set(k, g); }
  return g;
}
function getSphereGeo(r, sw, sh){
  const k = `s${r}|${sw}|${sh}`;
  let g = geoCache.get(k);
  if (!g){ g = new THREE.SphereGeometry(r, sw, sh); geoCache.set(k, g); }
  return g;
}
function mat(color, opts){
  const k = color + '|' + JSON.stringify(opts || {});
  let m = matCache.get(k);
  if (!m){
    m = new THREE.MeshStandardMaterial(Object.assign(
      { color, roughness: 0.88, metalness: 0.04 }, opts || {}));
    matCache.set(k, m);
  }
  return m;
}
function box(w, h, d, color, x, y, z, parent, opts){
  const m = new THREE.Mesh(getBoxGeo(w, h, d), mat(color, opts));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/* ---------- 碰撞障碍 ---------- */
const obstacles = []; // {x, z, hw, hd}
function addObstacle(x, z, hw, hd){ obstacles.push({ x, z, hw, hd }); }
function collides(x, z, r){
  for (let i = 0; i < obstacles.length; i++){
    const o = obstacles[i];
    if (Math.abs(x - o.x) < o.hw + r && Math.abs(z - o.z) < o.hd + r) return true;
  }
  return false;
}

/* ---------- 音频 ---------- */
const audio = {
  ctx: null, master: null, muted: false, volume: 0.6,
  init(){
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
    } catch(e){}
  },
  setVolume(v){
    this.volume = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  },
  setMuted(m){
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  },
  key(){
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.value = 1400 + Math.random() * 900;
    g.gain.setValueAtTime(0.012, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.04);
  },
  step(){
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const buf = this.ctx.createBuffer(1, 1024, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const s = this.ctx.createBufferSource(); s.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 800;
    const g = this.ctx.createGain(); g.gain.value = 0.05;
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t);
  },
  beep(freq, dur, vol, type){
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  },
  punch(){
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const buf = this.ctx.createBuffer(1, 4096, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / 700);
    const s = this.ctx.createBufferSource(); s.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500;
    const g = this.ctx.createGain(); g.gain.value = 0.5;
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t);
    const o = this.ctx.createOscillator(), g2 = this.ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    g2.gain.setValueAtTime(0.4, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g2); g2.connect(this.master);
    o.start(t); o.stop(t + 0.32);
  }
};

/* ---------- 全局引用 ---------- */
let scene, camera, renderer, clock;
const raycaster = new THREE.Raycaster();
raycaster.layers.enable(1);   // 准星射线也要能命中 UI 层（3D 弹窗按钮）
const CENTER = new THREE.Vector2(0, 0);
let interactables = [];
const deskScreens = [];   // 每台显示器的 { ctx, tex }，用于后续刷新
let actionE = null;       // E 键动作：交互（电脑/水杯/草稿纸/出口）
let actionF = null;       // F 键动作：干扰同学
let actionSpace = null;   // 空格键动作：打老师 / 打保安
let npcs = [], teacher = null;
let achTimer = null;

const hud = $('hud'), promptEl = $('prompt'), crosshair = $('crosshair');
const hudTimer = $('hudTimer'), hudScore = $('hudScore'), hudProbs = $('hudProbs');
const codeUI = $('codeUI'), codeArea = $('codeArea'), verdictEl = $('verdict');
const paperUI = $('paperUI'), paperCanvas = $('paperCanvas');
const corridorUI = $('corridorUI'), corrBar = $('corrBar');
const bathroomUI = $('bathroomUI'), bathBar = $('bathBar'),
      bathStepText = $('bathStepText'), bathHint = $('bathHint'),
      bathSub = $('bathSub'), bathDots = $('bathDots');
const endingUI = $('ending');
const toastStack = $('toastStack');
const pauseMenu = $('pauseMenu'), npcComputerUI = $('npcComputerUI');
const redFlash = $('redFlash');   // 受击闪红（出拳不再闪，只保留这一处）
const minimapWrap = $('minimapWrap');
const minimap = $('minimap'), mmCtx = minimap.getContext('2d');
const achNotify = $('achNotify');

/* ---------- 视角参数（FPS：指针锁定 + 鼠标视角） ---------- */
const SENS_MIN = 0.35, SENS_MAX = 3.5;   // 灵敏度档位（对应滑条 1~20）
const SENS_SCALE = 0.0011;               // 档位 → 弧度 / 像素
let mouseSens = 1.925, smoothAmount = 0.35, timeScale = 15;
let shakeEnabled = true;          // 紧张态镜头抖动（晕动症友好开关）
let yawTarget = 0, pitchTarget = 0;

function sliderToSens(v){ return SENS_MIN + ((v - 1) / 19) * (SENS_MAX - SENS_MIN); }
function sensToSlider(s){
  return Math.round(clamp((s - SENS_MIN) / (SENS_MAX - SENS_MIN), 0, 1) * 19) + 1;
}

const SETTINGS_KEY = 'oi_view_v8';
function loadViewSettings(){
  try {
    const o = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (typeof o.sens === 'number')      mouseSens = clamp(o.sens, SENS_MIN, SENS_MAX);
    /* 兼容旧存档：turn 字段当时存的是滑条位置 */
    else if (typeof o.turn === 'number') mouseSens = sliderToSens(clamp(o.turn, 1, 20));
    if (typeof o.smooth === 'number') smoothAmount = clamp(o.smooth, 0, 0.9);
    if (typeof o.time === 'number')   timeScale    = clamp(o.time, 1, 60);
    if (typeof o.shake === 'boolean') shakeEnabled = o.shake;
    if (typeof o.vol === 'number')    audio.volume = clamp(o.vol, 0, 1);
    if (typeof o.muted === 'boolean') audio.muted  = o.muted;
    if (o.quality === 'auto' || Object.prototype.hasOwnProperty.call(QUALITY_PRESETS,o.quality)) qualityPreference = o.quality;
    if (['auto','webgl','canvas'].includes(o.renderer)) rendererPreference = o.renderer;
  } catch(e){}
}
function saveViewSettings(){
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      sens: mouseSens, smooth: smoothAmount, time: timeScale,
      vol: audio.volume, muted: audio.muted, shake: shakeEnabled,
      quality: qualityPreference, renderer: rendererPreference
    }));
  } catch(e){}
}
/* 防抖：拖动滑块时避免每次 input 都同步写 localStorage */
let saveSettingsTimer = null;
function scheduleSaveViewSettings(){
  if (saveSettingsTimer) return;
  saveSettingsTimer = setTimeout(() => {
    saveSettingsTimer = null;
    saveViewSettings();
  }, 400);
}

function syncViewUI(){
  const tv = sensToSlider(mouseSens);
  const smv = Math.round(smoothAmount * 100);
  const volv = Math.round(audio.volume * 100);
  ['turnSliderStart', 'turnSlider'].forEach(id => { const e = $(id); if (e) e.value = tv; });
  ['turnValueStart', 'turnValue'].forEach(id => { const e = $(id); if (e) e.textContent = mouseSens.toFixed(1); });
  ['smoothSliderStart', 'smoothSlider'].forEach(id => { const e = $(id); if (e) e.value = smv; });
  ['smoothValueStart', 'smoothValue'].forEach(id => { const e = $(id); if (e) e.textContent = smv + '%'; });
  ['timeSliderStart', 'timeSlider'].forEach(id => { const e = $(id); if (e) e.value = timeScale; });
  ['timeValueStart', 'timeValue'].forEach(id => { const e = $(id); if (e) e.textContent = Math.round(timeScale) + '×'; });
  ['volSliderStart', 'volSlider'].forEach(id => { const e = $(id); if (e) e.value = volv; });
  ['volValueStart', 'volValue'].forEach(id => { const e = $(id); if (e) e.textContent = volv + '%'; });
  const mt = $('muteToggle');
  if (mt) mt.classList.toggle('on', !audio.muted);
  const st = $('shakeToggle');
  if (st) st.classList.toggle('on', shakeEnabled);
  const st2 = $('shakeToggleStart');
  if (st2) st2.classList.toggle('on', shakeEnabled);
}
