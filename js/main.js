'use strict';
/* =========================================================
   main —— 事件绑定 / 主循环 / 初始化入口
   （自 index.html 内联脚本拆出）
   ========================================================= */
/* =========================================================
   事件绑定
   ========================================================= */
function bindSceneEvents(){
  renderer.domElement.addEventListener('contextmenu',e => { if (canLockView()) e.preventDefault(); });
  renderer.domElement.addEventListener('mousedown',e => {
    if (e.button === 2 && !pointerLocked && canLockView()){
      dragLookPoint = { x:e.clientX, y:e.clientY };
      e.preventDefault();
    }
  });
  /* 左键交互；未锁定时点击画面重新捕获鼠标，不触发交互 */
  renderer.domElement.addEventListener('click', () => {
    if (!state.started || state.ended) return;
    /* 弹窗存在期间左键不消除面板（只允许视线停留确认），
       避免点击造成状态中断而进度环仍残留的问题；此时点击仅用于
       在指针意外释放时重新捕获鼠标 */
    if (hasDialog()){ if (!pointerLocked) requestLock(); return; }
    /* 未锁定时：有可攻击目标就直接出拳（锁定失效也能打），
       否则重新捕获鼠标——避免误触其他交互 */
    if (!pointerLocked && !actionSpace){ requestLock(); return; }
    /* 左键即原空格键语义：准星指向可攻击目标（老师/保安，且在范围内）
       时执行攻击，否则执行普通交互 */
    doInteract(actionSpace ? 'space' : 'e');
  });
}

function bindEvents(){
  bindSceneEvents();
  bindGraphicsEvents();

  document.addEventListener('keydown', e => {
    /* 走廊 */
    if (state.view === 'corridor'){
      if (e.code === 'KeyW' || e.code === 'ArrowUp'){
        state.keys['w'] = true; e.preventDefault();
      }
      return;
    }
    /* 洗手间 */
    if (state.view === 'bathroom'){
      if (e.code === 'KeyW'){ state.keys['w'] = true; e.preventDefault(); }
      if (e.code === 'Space'){ state.keys['space'] = true; e.preventDefault(); }
      const step = BATHROOM_STEPS[bathroomStepIdx];
      if (step && step.key === 'e' && e.code === 'KeyE'){
        finishBathroom(); e.preventDefault();
      }
      return;
    }
    /* NPC 电脑 */
    if (state.view === 'npcComputer'){
      if (e.code === 'Escape' || e.code === 'KeyE'){
        closeNPCComputer(); e.preventDefault();
      }
      return;
    }
    /* Esc 关闭面板 */
    if (e.code === 'Escape'){
      if (state.view === 'pause'){ closePauseMenu(); return; }
      if (state.view === 'code'){ closeCode(); return; }
      if (state.view === 'paper'){ closePaper(); return; }
      if (hasDialog()){ closeTeacherDialog(); return; }
      if (state.view === 'world' && state.started && !state.ended){
        /* 已锁定时交给 pointerlockchange 处理，避免一次 Esc 开两次面板 */
        if (!pointerLocked) openPauseMenu();
        return;
      }
      return;
    }
    if (state.view !== 'world') return;

    /* 数字键 1-9：直接选择弹窗上的第 n 个选项 */
    if (hasDialog() && /^Digit[1-9]$/.test(e.code)){
      selectDialogOption(Number(e.code.slice(5)) - 1);
      e.preventDefault();
      return;
    }

    const k = KEYMAP[e.code];
    if (k){
      state.keys[k] = true;
      if ('wasd'.includes(k) || k.startsWith('look')) e.preventDefault();
    }
    if (e.code === 'KeyE'){
      /* 弹窗优先：E 用来点按钮，不作用于场景 */
      if (hasDialog()) activateDialogButton();
      /* 与左键同优先级：可攻击则出拳，否则交互。
         这条路径不依赖指针锁定，锁定失效时也能打 */
      else doInteract(actionSpace ? 'space' : 'e');
    }
    if (e.code === 'KeyF'){ doInteract('f'); }
    if (e.code === 'Space'){
      /* 空格跳跃；弹窗悬浮期间不跳，避免误触 */
      if (!hasDialog()) tryJump();
      e.preventDefault();
    }
    if (e.code === 'KeyH') callTeacher();
  });

  document.addEventListener('keyup', e => {
    if (state.view === 'corridor'){
      if (e.code === 'KeyW' || e.code === 'ArrowUp') state.keys['w'] = false;
      return;
    }
    if (state.view === 'bathroom'){
      if (e.code === 'KeyW') state.keys['w'] = false;
      if (e.code === 'Space') state.keys['space'] = false;
      return;
    }
    const k = KEYMAP[e.code];
    if (k) state.keys[k] = false;
  });

  window.addEventListener('blur', () => { state.keys = {}; dragLookPoint = null; });
  document.addEventListener('mouseup', () => { dragLookPoint = null; });
  document.addEventListener('visibilitychange', () => {
    /* 恢复可见后的首帧包含后台停留时间，不用它判断设备性能。 */
    qualitySampleTime = 0; qualitySampleFrames = 0; qualityWarmup = 2;
  });

  /* ---------- 指针锁定 ---------- */
  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === lockElement();
    if (pointerLocked) lastLockAt = performance.now();
    /* 锁定被释放（通常是 Esc）：世界视图下打开设置面板 */
    else if (state.view === 'world' && state.started && !state.ended) openPauseMenu();
  });
  document.addEventListener('pointerlockerror', () => {
    if (canLockView()) toast('可按住右键拖动或用方向键转动视角。', 2200);
  });
  /* 鼠标位移 → 视角目标角，平滑由 applyLook 完成 */
  document.addEventListener('mousemove', e => {
    if (pointerLocked || (dragLookPoint && canLockView())){
      if (!LOOK_VIEWS.has(state.view)) return;
      /* 锁定瞬间浏览器可能补发一次巨大位移，忽略前 120ms 内的事件 */
      if (pointerLocked && performance.now() - lastLockAt < 120) return;
      const mx = clamp(pointerLocked ? e.movementX || 0 : e.clientX-dragLookPoint.x, -MAX_MOUSE_STEP, MAX_MOUSE_STEP);
      const my = clamp(pointerLocked ? e.movementY || 0 : e.clientY-dragLookPoint.y, -MAX_MOUSE_STEP, MAX_MOUSE_STEP);
      if (dragLookPoint) dragLookPoint = { x:e.clientX, y:e.clientY };
      yawTarget   -= mx * mouseSens * SENS_SCALE;   // 鼠标右移 → 向右转身
      pitchTarget -= my * mouseSens * SENS_SCALE;   // 鼠标下移 → 低头
      pitchTarget = clamp(pitchTarget, -1.35, 1.35);
      return;
    }
    /* 未锁定：记录鼠标 NDC，供弹窗按钮拾取（此时可用鼠标直接点选） */
    dlgMouseNdc.set((e.clientX / innerWidth) * 2 - 1,
                    -(e.clientY / innerHeight) * 2 + 1);
  });

  /* resize 防抖：拖窗口时避免反复重建 drawing buffer */
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1,graphicsProfile().dpr));
      renderer.setSize(innerWidth, innerHeight);
      resizePostFX();
      forceRedraw = true;
    }, 150);
  });

  /* 滑条 */
  function bindSlider(id, apply){
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      apply(parseFloat(el.value));
      scheduleSaveViewSettings();
      syncViewUI();
    });
  }
  bindSlider('turnSliderStart',   v => mouseSens = sliderToSens(v));
  bindSlider('turnSlider',        v => mouseSens = sliderToSens(v));
  bindSlider('smoothSliderStart', v => smoothAmount = v / 100);
  bindSlider('smoothSlider',      v => smoothAmount = v / 100);
  bindSlider('timeSliderStart',   v => timeScale = v);
  bindSlider('timeSlider',        v => timeScale = v);
  bindSlider('volSliderStart',    v => audio.setVolume(v / 100));
  bindSlider('volSlider',         v => audio.setVolume(v / 100));

  /* 静音开关 */
  const mt = $('muteToggle');
  if (mt){
    mt.classList.toggle('on', !audio.muted);
    mt.onclick = () => {
      audio.setMuted(!audio.muted);
      mt.classList.toggle('on', !audio.muted);
      saveViewSettings();
    };
  }

  /* 镜头晃动开关（紧张态抖动，晕动症友好） */
  const st = $('shakeToggle');
  if (st){
    st.classList.toggle('on', shakeEnabled);
    st.onclick = () => {
      shakeEnabled = !shakeEnabled;
      st.classList.toggle('on', shakeEnabled);
      saveViewSettings();
    };
  }
  const st2 = $('shakeToggleStart');
  if (st2){
    st2.classList.toggle('on', shakeEnabled);
    st2.onclick = () => {
      shakeEnabled = !shakeEnabled;
      st2.classList.toggle('on', shakeEnabled);
      saveViewSettings();
    };
  }

  /* 暂停菜单按钮 */
  $('btnResume').onclick = closePauseMenu;
  $('btnPauseEnd').onclick = () => {
    if (confirm('确定要提前交卷离场吗？')){
      pauseMenu.classList.add('hidden');
      endContest(true);
    }
  };
  $('btnSave').onclick = () => { persistSave(); toast('进度已保存', 1200); };
  $('btnClearSave').onclick = () => { clearSave(); toast('存档已清除', 1200); };

  $('btnSettings').onclick = openPauseMenu;
  $('btnCloseNPCComp').onclick = closeNPCComputer;

  /* 代码编辑器 */
  codeArea.addEventListener('input', () => {
    saveCode();
    scheduleHighlight();
    if (Math.random() < 0.7) audio.key();
  });
  codeArea.addEventListener('keydown', e => {
    if (e.code === 'Tab'){
      e.preventDefault();
      const s = codeArea.selectionStart, en = codeArea.selectionEnd;
      codeArea.value = codeArea.value.substring(0, s) + '    ' +
                       codeArea.value.substring(en);
      codeArea.selectionStart = codeArea.selectionEnd = s + 4;
      saveCode();
      scheduleHighlight();
    }
    if (e.code !== 'Escape') e.stopPropagation();
  });
  codeArea.addEventListener('scroll', () => {
    codeHighlight.scrollTop = codeArea.scrollTop;
    codeHighlight.scrollLeft = codeArea.scrollLeft;
  });
  codeArea.addEventListener('keyup', e => {
    if (e.code !== 'Escape') e.stopPropagation();
  });
  codeArea.addEventListener('click', updateCursorInfo);
  codeArea.addEventListener('keyup', updateCursorInfo);

  function updateCursorInfo(){
    const v = codeArea.value.substring(0, codeArea.selectionStart);
    const lines = v.split('\n');
    $('cursorInfo').textContent =
      `Ln ${lines.length}, Col ${lines[lines.length - 1].length + 1}  ·  C++14  ·  g++ -O2`;
  }

  $('btnSubmit').onclick = submitCode;
  $('btnLeave').onclick = closeCode;
  $('btnReset').onclick = () => {
    const p = state.problems.find(x => x.id === state.curProb);
    if (confirm('确定要重置本题代码吗？')){
      codeArea.value = p.starter;
      state.code[state.curProb] = p.starter;
      scheduleHighlight();
    }
  };
  $('btnEnd').onclick = () => {
    if (state.ended) return;
    if (confirm('确定要提前交卷离场吗？')) endContest(true);
  };
  $('btnRestart').onclick = () => {
    clearSave();
    location.reload();
  };

  $('btnClearSaveStart').onclick = () => {
    if (confirm('确定要清空存档吗？已保存的代码和进度都会丢失。')){
      clearSave();
      toast('存档已清除', 1500);
    }
  };

  $('btnStart').onclick = () => {
    audio.init();
    audio.setVolume(audio.volume);
    $('start').classList.add('hidden');
    hud.classList.remove('hidden');
    minimapWrap.classList.remove('hidden');
    crosshair.classList.remove('hidden');
    state.started = true;
    state.startTime = performance.now();
    yawTarget = state.yaw; pitchTarget = state.pitch;
    clock.getDelta();
    toast('比赛开始！WASD 移动，鼠标转动视角，左键交互 / 攻击。', 2600);
    /* 点击按钮是用户手势，此时申请指针锁定成功率最高 */
    requestLock();
    /* 尝试恢复存档 */
    if (tryLoadSave()) toast('已恢复上次的答题进度。', 2200);
  };
}

/* =========================================================
   主循环
   ========================================================= */
let lastInteractUpdate = 0;
let forceRedraw = false;
let lastFrameAt = null;
let lastMinimapAt = 0;
let hitStop = 0;                // 命中顿帧剩余时间（出拳命中时置位）
let worldTimeScale = 1;         // 全局世界时间倍率（通报弹窗期间的子弹时间）
let slowMoDlg = null;           // 引发慢放的弹窗；它一消失就恢复原速

/* 世界时间步长：顿帧 × 全局慢放。考试计时（state.elapsed）用 elapsedDt，
   不受这里影响——慢的是世界，不是钟。 */
function worldDtFor(realDt){
  const hs = hitStop > 0 ? 0.12 : 1;
  return realDt * hs * worldTimeScale;
}

function beginSlowMo(){
  worldTimeScale = 0.1;
}

function endSlowMo(){
  worldTimeScale = 1;
}

/* 这些视图下，3D 世界不可见（被全屏覆盖层盖住），可以跳过 render；
   其中 code/paper/corridor/bathroom/npcComputer 也跳过世界逻辑更新。 */
const VIEW_NO_RENDER = new Set([
  'code','paper','corridor','bathroom','npcComputer','ending','pause'
]);

function animate(frameAt){
  requestAnimationFrame(animate);
  const now = frameAt === undefined ? performance.now() : frameAt;
  const interval = 1000 / graphicsProfile().fps;
  if (document.hidden) return;
  if (!forceRedraw && lastFrameAt !== null && now - lastFrameAt < interval - 0.5) return;
  lastFrameAt = now - (lastFrameAt === null ? 0 : (now - lastFrameAt) % interval);
  if ((!state.started || state.ended) && !forceRedraw) return;
  const elapsedDt = clock.getDelta();
  const realDt = Math.min(elapsedDt, 0.1);
  sampleGraphicsPerformance(elapsedDt);
  const t = performance.now() * 0.001;

  if (state.started && !state.ended){
    state.elapsed += elapsedDt * timeScale;
    if (state.elapsed >= CONTEST_LEN) endContest(false);
  }

  /* 命中顿帧：命中瞬间世界逻辑减速到 12%，相机/UI/计时不受影响 */
  if (hitStop > 0) hitStop -= realDt;
  /* 通报弹窗把世界放到 0.1x；弹窗消失（选项或 Esc）即恢复 */
  if (slowMoDlg && dialogs.indexOf(slowMoDlg) < 0){
    slowMoDlg = null;
    endSlowMo();
  }
  const worldDt = worldDtFor(realDt);
  /* 世界时钟：受击间隔等"世界内"计时都以它为准，慢放时一并变慢 */
  state.worldTime += worldDt;

  const inWorld = state.view === 'world';

  if (inWorld && state.started && !state.ended && !state.frozen){
    applyLook(realDt);
    updatePlayer(worldDt);       /* 移动也吃慢放：通报期间世界真的变慢 */
  }

  /* 3D 悬浮弹窗：惯性追随 + 相切朝向 + 按钮拾取 */
  if (dialogs.length) updateDialogs(realDt);
  /* 爆散碎块的物理积分（顿帧同样生效，打出凝滞感） */
  if (debrisList.length) updateDebris(worldDt);
  /* 3D 准星：旋转 / 缩放 / 变色 / 停留进度环 */
  updateReticle(realDt);

  if (state.view === 'corridor') updateCorridor(realDt);
  if (state.view === 'bathroom') updateBathroom(realDt);
  /* 终局：开门动画与白光投射的推进 */
  if (state.doorOpen) updateDoorLight(realDt);

  /* 世界逻辑：只在世界视图下运行，避免在 IDE / 草稿纸里空跑 NPC 与 AI */
  if (inWorld && state.started && !state.ended){
    updateNPCs(worldDt, t);

    /* 老师 AI */
    if (teacher && !state.frozen){
      const tm = teacher.userData;
      const pos = teacher.group.position;

      if (tm.mode === 'patrol'){
        const theta = t * 0.15;
        const a = 6.5, b = 5.5, n = 0.7;
        const c1 = Math.cos(theta), s1 = Math.sin(theta);
        const c2 = Math.cos(theta + 0.02), s2 = Math.sin(theta + 0.02);
        const x1 = a * Math.sign(c1) * Math.pow(Math.abs(c1), n);
        const z1 = b * Math.sign(s1) * Math.pow(Math.abs(s1), n);
        const x2 = a * Math.sign(c2) * Math.pow(Math.abs(c2), n);
        const z2 = b * Math.sign(s2) * Math.pow(Math.abs(s2), n);
        pos.x = x1;
        pos.z = z1;
        teacher.group.rotation.y = Math.atan2(x2 - x1, z2 - z1);
        pos.y = Math.abs(Math.sin(t * 4)) * 0.008;
      } else if (tm.mode === 'approach'){
        const dx = state.pos.x - pos.x;
        const dz = state.pos.z - pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 1.4){
          tm.mode = 'warn';
          teacher.group.rotation.y = Math.atan2(dx, dz);
          showTeacherWarning();
        } else {
          const sp = 3.2 * worldDt;
          const nx = pos.x + (dx / d) * sp;
          const nz = pos.z + (dz / d) * sp;
          if (!collides(nx, pos.z, 0.3)) pos.x = nx;
          if (!collides(pos.x, nz, 0.3)) pos.z = nz;
          teacher.group.rotation.y = Math.atan2(dx, dz);
        }
      } else if (tm.mode === 'warn'){
        const dx = state.pos.x - pos.x;
        const dz = state.pos.z - pos.z;
        teacher.group.rotation.y = Math.atan2(dx, dz);
      } else if (tm.mode === 'returning'){
        const theta = t * 0.15;
        const a = 6.5, b = 5.5, n = 0.7;
        const c = Math.cos(theta), s = Math.sin(theta);
        const targetX = a * Math.sign(c) * Math.pow(Math.abs(c), n);
        const targetZ = b * Math.sign(s) * Math.pow(Math.abs(s), n);
        const dx = targetX - pos.x;
        const dz = targetZ - pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.3) tm.mode = 'patrol';
        else {
          const sp = 3.0 * worldDt;
          pos.x += (dx / d) * sp; pos.z += (dz / d) * sp;
          teacher.group.rotation.y = Math.atan2(dx, dz);
        }
      }
    }

    /* 保安 */
    updateGuards(worldDt, t);

    /* 紧张值：随击倒数与贴身程度上升，坐定可回落 */
    updateTension(worldDt, state.guardKills, nearestGuardDist, lastMoveSpeed);

    /* 走动警告检测 */
    if (state.started && !state.ended && !state.frozen
        && !state.bathroomApproved && !state.teacherWarnActive && teacher
        && teacher.userData.mode === 'patrol'
        && securityGuards.length === 0){
      const dx = state.pos.x - 0;
      const dz = state.pos.z - (-3);
      const distFromSeat = Math.hypot(dx, dz);
      if (distFromSeat > 3.5){
        state.wanderTimer += realDt;
        if (state.wanderTimer > 2.0) triggerTeacherWarning();
      } else {
        state.wanderTimer = 0;
      }
    }
    /* 离开座位 5 次 → 触发时间锁定 */
    if (state.started && !state.ended && !state.wanderPenaltyApplied
      && state.wanderCount >= 5){
      applyWanderPenalty();
    }

    /* 交互提示：只在必要时刷新（每 80ms） */
    const now = performance.now();
    if (now - lastInteractUpdate > 80){
      lastInteractUpdate = now;
      updateInteract();
    }
  }

  /* HUD */
  if (state.started && !state.ended){
    const remain = CONTEST_LEN - state.elapsed;
    const txt = fmtTime(remain);
    if (hudTimer.textContent !== txt){
      hudTimer.textContent = txt;
      const ideTime = $('ideTime');
      if (ideTime) ideTime.textContent = txt;
      hudTimer.classList.toggle('warn', remain < 1800);
    }
    const alive = aliveGuardCount();
    const key = `${state.totalScore}|${state.warnCount}|${alive}`;
    if (hudScore.dataset.key !== key){
      hudScore.dataset.key = key;
      const guardInfo = alive > 0
        ? `　<span style="color:#ff6b78;font-size:16px">\u26A0 保安 ${alive}</span>`
        : '';
      hudScore.innerHTML =
        `总分 <b>${state.totalScore}</b> / 400　` +
        `<span style="color:#5d6880;font-size:16px">警告 ${state.warnCount} 次</span>${guardInfo}`;
    }
    /* HUD 陪葬：计时器与小地图随紧张值进入红色警戒 */
    const tn = getTension();
    hudTimer.classList.toggle('tense', tn > 0.05);
    minimapWrap.classList.toggle('tense', tn > 0.05);
    if (now - lastMinimapAt >= (activeQuality === 'low' ? 150 : 66)){
      drawMinimap();
      lastMinimapAt = now;
    }
  }

  /* 关键优化：IDE / 草稿纸 / 走廊等视图下跳过渲染 */
  if (!VIEW_NO_RENDER.has(state.view) || forceRedraw){
    renderFrame(realDt);
    forceRedraw = false;
  }
}

/* =========================================================
   初始化
   ========================================================= */
function init(){
  loadViewSettings();
  syncViewUI();

  renderer = createSceneRenderer();
  if (THREE.sRGBEncoding) renderer.outputEncoding = THREE.sRGBEncoding;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x090b11);
  scene.fog = new THREE.FogExp2(0x090b11, 0.038);

  camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 0.05, 120);
  camera.rotation.order = 'YXZ';
  camera.position.set(0, 1.65, -1.72);

  scene.add(new THREE.AmbientLight(0xffffff, 0.42));
  scene.add(new THREE.HemisphereLight(0xc8d8ff, 0x232833, 0.5));

  state.problems = pickProblems();
  state.curProb = state.problems[0].id;
  state.npcProbId = state.problems[Math.floor(Math.random() * state.problems.length)].id;

  buildWorld();
  updateAllDeskScreens();
  initReticle();
  /* 氛围系统：拖影后处理（可失败回退）/ 保安警灯 / 紧张值 */
  initGuardLights();
  initTension();
  applyGraphicsQuality();
  initHp();
  bindEvents();
  initPaperEvents();
  renderHudProbs();

  clock = new THREE.Clock();
  animate();
}

try {
  init();
} catch(e){
  console.error(e);
  const s = document.getElementById('start');
  if (s){
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);' +
      'background:#3a1a1a;color:#f88;padding:12px 22px;border-radius:8px;z-index:999;font-size:13px';
    d.textContent = '初始化失败：' + e.message + '（按 F12 查看详情）';
    document.body.appendChild(d);
  }
}
