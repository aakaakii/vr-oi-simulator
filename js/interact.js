'use strict';
/* =========================================================
   interact —— 准星交互判定（E / F / 空格）
   （自 index.html 内联脚本拆出）
   ========================================================= */
/* =========================================================
   交互判定
   ========================================================= */
let lastInteractKey = '';

/* 干扰同学的判定半径：必须贴到"他的人"身边，而非整个座位区 */
const NPC_DISTURB_RANGE = 0.72;

function updateInteract(){
  actionE = null;
  actionF = null;
  actionSpace = null;
  promptEl.classList.add('hidden');
  /* 准星指着门口白光时，交互提示切换浅底深字，保证可读 */
  promptEl.classList.toggle('bright', aimingAtWhiteLight());

  if (state.view !== 'world' || !state.started || state.ended || state.frozen) return;

  /* 弹窗存在期间：屏蔽场景交互提示，准星操作优先给弹窗按钮。
     放在指针锁定检查之前：弹窗期内不提示"点击画面"，避免误导 */
  if (hasDialog()){
    actionE = null; actionF = null; actionSpace = null;
    promptEl.classList.add('hidden');
    return;
  }

  /* 优先：保安 → 空格 */
  for (let i = 0; i < securityGuards.length; i++){
    const g = securityGuards[i];
    if (!g.userData.alive) continue;
    const d = Math.hypot(state.pos.x - g.group.position.x, state.pos.z - g.group.position.z);
    if (d < GUARD_PUNCH_RANGE){
      /* 扇形窗口内才判定命中；出拳会扫倒范围内全部保安 */
      if (!inAttackArc(g.group.position.x, g.group.position.z)) continue;
      actionSpace = { fn: punchGuardsArc };
      const txt = `[ 左键 ] 出拳（拳锋 ${GUARD_PUNCH_RANGE.toFixed(1)}m · 前方扇形）`;
      if (lastInteractKey !== txt){ promptEl.textContent = txt; lastInteractKey = txt; }
      promptEl.classList.remove('hidden');
      return;
    }
  }

  /* 老师 → 空格 */
  if (teacher && !teacher.userData.leaving){
    const d = Math.hypot(state.pos.x - teacher.group.position.x,
                         state.pos.z - teacher.group.position.z);
    /* 同样要求落在视角扇形窗口内 */
    if (d < 2.4 && teacher.userData.mode !== 'warn' &&
        inAttackArc(teacher.group.position.x, teacher.group.position.z)){
      actionSpace = { fn: punchTeacher };
      const txt = '[ 左键 ] 殴打监考老师（后果自负）';
      if (lastInteractKey !== txt){ promptEl.textContent = txt; lastInteractKey = txt; }
      promptEl.classList.remove('hidden');
      return;
    }
  }

  /* 其他选手：坐着的 → F 干扰；离开的 → E 用电脑 */
  for (let i = 0; i < npcs.length; i++){
    const n = npcs[i];
    const ud = n.userData;
    if (!ud) continue;
    const d = Math.hypot(state.pos.x - ud.seatX, state.pos.z - ud.seatZ);
    if (d < 2.3){
      if (ud.state === 'seated'){
        /* 监考倒台之后，同学也进入可攻击范围（此前不应有此交互） */
        if (state.teacherDown){
          const dBody = Math.hypot(state.pos.x - n.group.position.x,
                                   state.pos.z - n.group.position.z);
          if (dBody <= GUARD_PUNCH_RANGE &&
              inAttackArc(n.group.position.x, n.group.position.z)){
            actionSpace = { fn: () => downNPC(n) };
            const txt = `[ 左键 ] 殴打同学 ${ud.name}（他已经不敢告老师了）`;
            if (lastInteractKey !== txt){ promptEl.textContent = txt; lastInteractKey = txt; }
            promptEl.classList.remove('hidden');
            return;
          }
        }
        /* 干扰的判定从"座位 2.3m"收紧到"他的人"：以身体实际位置为圆心 */
        const dBody = Math.hypot(state.pos.x - n.group.position.x,
                                 state.pos.z - n.group.position.z);
        if (dBody > NPC_DISTURB_RANGE) continue;
        actionF = { fn: () => disturbNPC(i) };
        const txt = `[ F ] 干扰${ud.name}（他可能会报告老师）`;
        if (lastInteractKey !== txt){ promptEl.textContent = txt; lastInteractKey = txt; }
        promptEl.classList.remove('hidden');
        return;
      } else if (ud.state === 'walking_away' || ud.state === 'away'){
        actionE = { fn: () => useNPCComputer(i) };
        const txt = `[ E ] 使用${ud.name}的电脑`;
        if (lastInteractKey !== txt){ promptEl.textContent = txt; lastInteractKey = txt; }
        promptEl.classList.remove('hidden');
        return;
      }
    }
  }

  /* 出口 → E */
  const dDoor = Math.hypot(state.pos.x - 7.85, state.pos.z - 0);
  if (dDoor < 3.0){
    /* 终局：门已开，走向白光即可走出去 */
    if (state.doorOpen){
      actionE = { fn: walkOutOfTheRoom };
      const txt = '[ E ] 走出去';
      if (lastInteractKey !== txt){ promptEl.textContent = txt; lastInteractKey = txt; }
      promptEl.classList.remove('hidden');
      return;
    }
    if (state.bathroomApproved){
      actionE = { fn: () => enterCorridor('toilet') };
      const txt = '[ E ] 离开考场去洗手间';
      if (lastInteractKey !== txt){ promptEl.textContent = txt; lastInteractKey = txt; }
    } else {
      const txt = '离开考场需要先按 H 举手征得老师同意';
      if (lastInteractKey !== txt){ promptEl.textContent = txt; lastInteractKey = txt; }
    }
    promptEl.classList.remove('hidden');
    return;
  }

  /* 桌上物品（射线拾取） → E */
  raycaster.setFromCamera(CENTER, camera);
  raycaster.far = 3.2;
  const hits = raycaster.intersectObjects(interactables, false);
  if (hits.length && hits[0].object.userData.interact){
    const it = hits[0].object.userData.interact;
    actionE = { fn: it.action };
    const txt = '[ E ] ' + it.label;
    if (lastInteractKey !== txt){ promptEl.textContent = txt; lastInteractKey = txt; }
    promptEl.classList.remove('hidden');
  }

  /* 兜底提示：没有任何可交互/可攻击目标时，才提醒重新捕获鼠标。
     注意动作判定不依赖指针锁定——锁定失效时 E / 左键依然能交互和出拳。 */
  if (!pointerLocked && !actionE && !actionF && !actionSpace){
    const txt = '点击画面锁定鼠标 · 也可右键拖动或用方向键转动视角';
    if (lastInteractKey !== txt){ promptEl.textContent = txt; lastInteractKey = txt; }
    promptEl.classList.remove('hidden');
  }
}

function doInteract(key){
  if (state.view !== 'world' || state.ended || state.frozen) return;
  if (key === 'e'     && actionE)     actionE.fn();
  if (key === 'f'     && actionF)     actionF.fn();
  if (key === 'space' && actionSpace) actionSpace.fn();
}

function drinkWater(){
  audio.beep(520, 0.08, 0.05);
  setTimeout(() => audio.beep(420, 0.1, 0.04), 110);
  toast('\u{1F964} 你喝了一口水，感觉清醒了一些。', 1600);
}
