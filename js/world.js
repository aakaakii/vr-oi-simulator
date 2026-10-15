'use strict';
/* =========================================================
   world —— 考场场景：房间 / 桌椅 / 显示器 / 人物 / 保安
   （自 index.html 内联脚本拆出）
   ========================================================= */
/* =========================================================
   场景搭建
   ========================================================= */
const ROOM_W = 16, ROOM_D = 14, ROOM_H = 3.4;
const DOOR_W = 0.95, DOOR_H = 2.15;   // 门洞尺寸（+X 墙上的开口）

/* 终局白光：门板 / 门口光面 / 外扩辉光 / 地面投射 / 点光源 */
let doorGroup = null, doorLightMesh = null, doorGlowMesh = null,
    doorFloorMesh = null, doorPointLight = null, doorFloorTex = null;
let doorOpenT = 0;

function buildRoom(){
  const W = ROOM_W, D = ROOM_D, H = ROOM_H;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    mat(0x22262e, { roughness: 0.96 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.userData.canvasBackground = true;
  scene.add(floor);

  const gridHelper = new THREE.GridHelper(W, 16, 0x2e3442, 0x2a2f3b);
  gridHelper.position.y = 0.005;
  scene.add(gridHelper);

  const ceil = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    mat(0x171b23, { roughness: 1 })
  );
  ceil.rotation.x = Math.PI / 2;
  ceil.userData.canvasBackground = true;
  ceil.position.y = H;
  scene.add(ceil);

  const wallMat = mat(0x2b313d, { roughness: 0.92 });
  const mkWall = (w, h, x, y, z, ry) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
    m.userData.canvasBackground = true;
    m.position.set(x, y, z); m.rotation.y = ry; scene.add(m);
  };
  mkWall(W, H,  0, H/2, -D/2, 0);
  mkWall(W, H,  0, H/2,  D/2, Math.PI);
  mkWall(D, H, -W/2, H/2, 0, Math.PI/2);
  /* +X 墙留出门洞：左右两段 + 顶部一段 */
  const sideW = (D - DOOR_W) / 2;
  mkWall(sideW, H, W/2, H/2, -(D/2 - sideW / 2), -Math.PI/2);
  mkWall(sideW, H, W/2, H/2,  (D/2 - sideW / 2), -Math.PI/2);
  mkWall(DOOR_W, H - DOOR_H, W/2, DOOR_H + (H - DOOR_H) / 2, 0, -Math.PI/2);

  /* 墙面障碍 */
  addObstacle(-W/2 - 0.5, 0, 0.5, D/2 + 1);
  addObstacle( W/2 + 0.5, 0, 0.5, D/2 + 1);
  addObstacle(0, -D/2 - 0.5, W/2 + 1, 0.5);
  addObstacle(0,  D/2 + 0.5, W/2 + 1, 0.5);

  /* 吊灯（只保留 3 个 PointLight，显示器不再单独挂灯） */
  for (let i = -1; i <= 1; i++){
    const lamp = new THREE.Mesh(
      getBoxGeo(3.4, 0.06, 0.42),
      new THREE.MeshBasicMaterial({ color: 0xfff4dc })
    );
    lamp.position.set(i * 4.6, H - 0.08, 0);
    scene.add(lamp);
    const pl = new THREE.PointLight(0xfff0d8, 0.42, 22, 2);
    pl.position.set(i * 4.6, H - 0.4, 0);
    scene.add(pl);
  }

  /* 黑板 */
  box(6, 2.0, 0.06, 0xf2f4f0, 0, 1.85, -D/2 + 0.05, scene,
    { roughness: 0.35, emissive: 0x1a1c1e, emissiveIntensity: 0.4 });
  box(6.16, 2.16, 0.03, 0x3a4150, 0, 1.85, -D/2 + 0.03, scene);

  const bc = document.createElement('canvas');
  bc.width = 1024; bc.height = 320;
  const bx = bc.getContext('2d');
  bx.fillStyle = '#f2f4f0'; bx.fillRect(0, 0, 1024, 320);
  bx.fillStyle = '#c0392b'; bx.font = 'bold 54px "Microsoft YaHei", sans-serif';
  bx.fillText('NOI 2026  竞赛守则', 60, 90);
  bx.fillStyle = '#2c3e50'; bx.font = '30px "Microsoft YaHei", sans-serif';
  bx.fillText('1. 禁止随意走动、禁止交头接耳、禁止干扰他人', 60, 160);
  bx.fillText('2. 如需去洗手间请举手示意监考老师', 60, 205);
  bx.fillText('3. 尊重监考老师，禁止任何形式的暴力行为', 60, 250);
  const boardTex = new THREE.CanvasTexture(bc);
  boardTex.anisotropy = 4;
  const boardFace = new THREE.Mesh(
    new THREE.PlaneGeometry(5.96, 1.96),
    new THREE.MeshBasicMaterial({ map: boardTex })
  );
  boardFace.position.set(0, 1.85, -D/2 + 0.085);
  scene.add(boardFace);

  /* 挂钟 */
  const clockBody = new THREE.Mesh(
    new THREE.CylinderGeometry(0.32, 0.32, 0.07, 32),
    mat(0xe8ecf2, { roughness: 0.4 })
  );
  clockBody.rotation.x = Math.PI / 2;
  clockBody.position.set(6.2, 2.6, -D/2 + 0.08);
  scene.add(clockBody);
  const clockFace = new THREE.Mesh(
    new THREE.CircleGeometry(0.29, 32),
    new THREE.MeshBasicMaterial({ color: 0xfbfcfe })
  );
  clockFace.position.set(6.2, 2.6, -D/2 + 0.13);
  scene.add(clockFace);
  const hh = box(0.022, 0.15, 0.01, 0x1a1a1a, 6.2, 2.65, -D/2 + 0.14, scene);
  const mm = box(0.018, 0.23, 0.01, 0x333333, 6.2, 2.71, -D/2 + 0.145, scene);
  hh.rotation.z = 0.6; mm.rotation.z = -1.1;

  /* 门 */
  /* 注意：必须赋值给模块级 doorGroup（不能加 const，否则会遮蔽它，
     updateDoorLight / openTheDoor 拿到的就永远是 null） */
  doorGroup = new THREE.Group();
  doorGroup.position.set(W/2 - 0.04, 0, -0.475);   /* 铰链在门左侧 */
  scene.add(doorGroup);
  box(0.07, 2.15, 0.95, 0x4a3a2e, 0, 1.075, 0.475, doorGroup, { roughness: 0.7 });
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.16, 10),
    mat(0xc9b037, { metalness: 0.85, roughness: 0.28 })
  );
  handle.rotation.x = Math.PI / 2;
  handle.position.set(-0.08, 1.05, 0.155);
  doorGroup.add(handle);

  const signC = document.createElement('canvas');
  signC.width = 256; signC.height = 96;
  const sx = signC.getContext('2d');
  sx.fillStyle = '#1f6b4a'; sx.fillRect(0, 0, 256, 96);
  sx.fillStyle = '#fff'; sx.font = 'bold 46px "Microsoft YaHei"';
  sx.textAlign = 'center'; sx.fillText('出 口', 128, 64);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 0.19),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(signC) })
  );
  sign.position.set(W/2 - 0.09, 2.42, 0);
  sign.rotation.y = -Math.PI / 2;
  scene.add(sign);

  /* ---------- 终局白光（打完全部保安后才点亮） ---------- */
  /* 门口光面：填满门洞的极亮白面，从房内可见 */
  doorLightMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(DOOR_W, DOOR_H),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide
    })
  );
  doorLightMesh.position.set(W/2 + 0.14, DOOR_H / 2, 0);
  doorLightMesh.rotation.y = -Math.PI / 2;
  doorLightMesh.visible = false;
  scene.add(doorLightMesh);

  /* 外扩辉光：门口外侧更大的一层加法白光 */
  doorGlowMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 3.4),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  doorGlowMesh.position.set(W/2 + 0.42, 1.5, 0);
  doorGlowMesh.rotation.y = -Math.PI / 2;
  doorGlowMesh.visible = false;
  scene.add(doorGlowMesh);

  /* 地面投射：门口洒进房内的光斑，亮度随距离衰减 */
  const fc = document.createElement('canvas');
  fc.width = 256; fc.height = 256;
  const fx = fc.getContext('2d');
  /* 亮端在画布右侧：plane 的 u 轴朝 +X，即门口一侧最亮、向房内衰减 */
  const grad = fx.createLinearGradient(256, 0, 0, 0);
  grad.addColorStop(0.0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  fx.fillStyle = grad;
  fx.fillRect(0, 0, 256, 256);
  doorFloorTex = new THREE.CanvasTexture(fc);
  doorFloorMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(4.2, 2.8),
    new THREE.MeshBasicMaterial({
      map: doorFloorTex, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false
    })
  );
  doorFloorMesh.rotation.x = -Math.PI / 2;
  doorFloorMesh.position.set(W/2 - 2.1, 0.03, 0);
  doorFloorMesh.visible = false;
  scene.add(doorFloorMesh);

  /* 门口点光源：让白光真正照到考场里（压迫感中的唯一亮源） */
  doorPointLight = new THREE.PointLight(0xffffff, 0, 16, 2);
  doorPointLight.userData.noTensionDim = true;   /* 豁免紧张值调光 */
  doorPointLight.position.set(W/2 + 0.5, 1.6, 0);
  scene.add(doorPointLight);

  /* 窗 */
  box(0.06, 1.6, 3.0, 0x3a4150, -W/2 + 0.04, 1.9, 0, scene);
  const winGlass = new THREE.Mesh(
    new THREE.PlaneGeometry(2.8, 1.42),
    new THREE.MeshBasicMaterial({ color: 0x6d8fb8 })
  );
  winGlass.position.set(-W/2 + 0.09, 1.9, 0);
  winGlass.rotation.y = Math.PI / 2;
  scene.add(winGlass);

  /* 饮水机 */
  const cooler = new THREE.Group();
  cooler.position.set(-6.6, 0, 5.6);
  scene.add(cooler);
  box(0.36, 1.0, 0.36, 0xdfe4ec, 0, 0.5, 0, cooler, { roughness: 0.5 });
  box(0.3, 0.36, 0.3, 0x8fd0f0, 0, 1.18, 0, cooler,
    { transparent: true, opacity: 0.75, roughness: 0.15 });
  box(0.4, 0.04, 0.4, 0x9aa4b4, 0, 1.0, 0, cooler);
  addObstacle(-6.6, 5.6, 0.25, 0.25);
}

function drawDeskScreen(cx, w, h){
  cx.fillStyle = '#0b0f16'; cx.fillRect(0, 0, w, h);
  cx.fillStyle = '#131b26'; cx.fillRect(0, 0, w, 34);
  cx.fillStyle = '#5b8cff'; cx.fillRect(0, 32, w, 2);
  cx.fillStyle = '#8ea6d8'; cx.font = 'bold 16px Consolas, monospace';
  cx.fillText('NOI 2026  Contest Environment', 14, 23);

  /* 题目列表 */
  cx.fillStyle = '#1a2330'; cx.fillRect(12, 48, w - 24, 100);
  cx.font = '15px Consolas, monospace';
  const probs = (state.problems && state.problems.length) ? state.problems : [];
  probs.slice(0, 4).forEach((p, i) => {
    const sc = state.score[p.id] || 0;
    const maxScore = p.max || 100;
    const label = (p.id + '  ' + p.name).slice(0, 24);
    const pad = ' '.repeat(Math.max(1, 24 - label.length));
    let status, color;
    if (sc >= maxScore)      { status = '[ 已 AC ]';  color = '#4fd1c5'; }
    else if (sc > 0)         { status = '[ 部分分 ]'; color = '#ffcc57'; }
    else                     { status = '[ 未提交 ]'; color = '#8a92a5'; }
    cx.fillStyle = color;
    cx.fillText(label + pad + status, 26, 76 + i * 24);
  });

  cx.fillStyle = '#3a4456'; cx.fillRect(12, 152, w - 24, 2);

  /* 代码预览：当前第一题的 starter 前 9 行 */
  cx.font = '14px Consolas, monospace';
  const first = probs[0];
  const lines = (first && first.starter)
    ? first.starter.split('\n').slice(0, 9)
    : ['#include <bits/stdc++.h>', 'using namespace std;', '', 'int main() {', '    // ...', '    return 0;', '}'];
  lines.forEach((l, i) => {
    let color = '#8fa8c8';
    if (/^\s*#/.test(l))                     color = '#c586c0';
    else if (/\/\//.test(l))                 color = '#5a6b80';
    else if (/(cin|cout|return|int main)/.test(l)) color = '#9cdcfe';
    cx.fillStyle = color;
    cx.fillText(l.slice(0, 62), 24, 182 + i * 22);
  });
}

function updateAllDeskScreens(){
  for (const s of deskScreens){
    drawDeskScreen(s.ctx, 640, 384);
    s.tex.needsUpdate = true;
  }
}

/* 合并短时间内的多次调用（例如连续提交），避免 6 张画布反复全量重绘 */
let deskScreenTimer = null;
function scheduleDeskScreensUpdate(){
  if (deskScreenTimer) return;
  deskScreenTimer = setTimeout(() => {
    deskScreenTimer = null;
    updateAllDeskScreens();
  }, 80);
}

function buildDesk(x, z, withMonitor){
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  scene.add(g);

  const woodTop = 0x6b5137;
  box(1.9, 0.06, 0.95, woodTop, 0, 0.74, 0, g);
  for (const dx of [-0.88, 0.88])
    for (const dz of [-0.4, 0.4])
      box(0.06, 0.74, 0.06, 0x2b303b, dx, 0.37, dz, g);
  box(1.9, 0.4, 0.03, 0x50596a, 0, 0.55, -0.44, g);

  /* 桌子碰撞（桌腿范围） */
  addObstacle(x, z, 0.92, 0.45);

  if (withMonitor){
    box(0.46, 0.025, 0.22, 0x22262e, 0, 0.775, -0.28, g);
    box(0.07, 0.34, 0.07, 0x2e3440, 0, 0.95, -0.30, g);
    box(0.80, 0.48, 0.035, 0x15181f, 0, 1.26, -0.30, g);

    /* 屏幕贴图 */
    const sc = document.createElement('canvas');
    sc.width = 640; sc.height = 384;
    const sx = sc.getContext('2d');
    drawDeskScreen(sx, 640, 384);
    const tex = new THREE.CanvasTexture(sc);
    tex.anisotropy = 4;
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(0.75, 0.44),
      new THREE.MeshBasicMaterial({ map: tex })
    );
    face.position.set(0, 1.26, -0.278);
    g.add(face);

    /* 记录以便后续刷新（切题 / 得分 / 读档时重新绘制） */
    deskScreens.push({ ctx: sx, tex: tex });

    /* 原先每台显示器一盏 PointLight，累计 6 盏，会把光照 shader 拖慢；
       这里换成一块微弱自发光平面，零光照开销。 */
    const glowPanel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.55, 0.34),
      new THREE.MeshBasicMaterial({
        color: 0x35507f, transparent: true, opacity: 0.18, depthWrite: false
      })
    );
    glowPanel.position.set(0, 1.26, -0.06);
    glowPanel.userData.qualityDetail = true;
    g.add(glowPanel);

    /* 键盘 */
    const kbC = document.createElement('canvas');
    kbC.width = 512; kbC.height = 180;
    const kx = kbC.getContext('2d');
    kx.fillStyle = '#1c2028'; kx.fillRect(0, 0, 512, 180);
    kx.fillStyle = '#2c323e';
    for (let r = 0; r < 6; r++)
      for (let c = 0; c < 16; c++){
        const w = (r === 5 && c > 3 && c < 9) ? 40 : 26;
        kx.fillRect(10 + c * 31, 12 + r * 27, w, 21);
      }
    const kbTex = new THREE.CanvasTexture(kbC);
    const kb = new THREE.Mesh(
      getBoxGeo(0.46, 0.022, 0.16),
      new THREE.MeshStandardMaterial({ map: kbTex, roughness: 0.75 })
    );
    kb.position.set(0, 0.775, 0.08);
    g.add(kb);

    box(0.065, 0.028, 0.105, 0x1e222a, 0.38, 0.778, 0.10, g, { roughness: 0.6 });

    /* 水杯 */
    const cup = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.03, 0.10, 16),
      new THREE.MeshStandardMaterial({
        color: 0xdfe6f2, transparent: true, opacity: 0.55, roughness: 0.2
      })
    );
    cup.position.set(0.66, 0.82, -0.02);
    g.add(cup);
    cup.userData.interact = { label: '喝水', action: () => drinkWater() };
    interactables.push(cup);

    /* 草稿纸 */
    const paper = new THREE.Mesh(
      new THREE.PlaneGeometry(0.30, 0.42),
      new THREE.MeshStandardMaterial({
        color: 0xf2eee3, roughness: 0.95, side: THREE.DoubleSide
      })
    );
    paper.rotation.x = -Math.PI / 2;
    paper.rotation.z = 0.14;
    paper.position.set(-0.62, 0.772, 0.06);
    g.add(paper);
    paper.userData.interact = { label: '查看草稿纸', action: () => openPaper() };
    interactables.push(paper);

    /* 笔 */
    const pen = new THREE.Mesh(
      new THREE.CylinderGeometry(0.006, 0.006, 0.15, 8),
      mat(0x2a2f3a, { roughness: 0.5 })
    );
    pen.rotation.z = Math.PI / 2;
    pen.rotation.y = 0.3;
    pen.position.set(-0.62, 0.782, 0.20);
    g.add(pen);

    face.userData.interact = { label: '使用电脑', action: () => openCode() };
    interactables.push(face);
  }

  /* 椅子 */
  const chair = new THREE.Group();
  chair.position.set(0, 0, 0.92);
  g.add(chair);
  box(0.46, 0.05, 0.46, 0x2e3440, 0, 0.45, 0, chair);
  box(0.46, 0.52, 0.05, 0x2e3440, 0, 0.72, 0.21, chair);
  box(0.05, 0.45, 0.05, 0x242a34, 0, 0.22, 0, chair);

  return g;
}

function buildPerson(x, z, shirtColor, rotY, startPose){
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = rotY || 0;
  scene.add(g);

  const skin = 0xd8a878, pants = 0x2a3140;

  // 坐姿腿组
  const legsSit = new THREE.Group();
  box(0.17, 0.17, 0.44, pants, -0.115, 0.52, 0.22, legsSit);
  box(0.17, 0.17, 0.44, pants,  0.115, 0.52, 0.22, legsSit);
  box(0.16, 0.44, 0.16, pants, -0.115, 0.24, 0.42, legsSit);
  box(0.16, 0.44, 0.16, pants,  0.115, 0.24, 0.42, legsSit);
  g.add(legsSit);

  // 站姿腿组（垂直向下）
  const legsStand = new THREE.Group();
  box(0.17, 0.9, 0.17, pants, -0.115, 0.45, 0, legsStand);
  box(0.17, 0.9, 0.17, pants,  0.115, 0.45, 0, legsStand);
  g.add(legsStand);

  if (startPose === 'stand') legsSit.visible = false;
  else legsStand.visible = false;

  box(0.44, 0.58, 0.27, shirtColor, 0, 1.09, 0.01, g);
  const armL = box(0.115, 0.42, 0.115, shirtColor, -0.29, 1.06, 0.13, g);
  const armR = box(0.115, 0.42, 0.115, shirtColor,  0.29, 1.06, 0.13, g);

  const head = new THREE.Mesh(getSphereGeo(0.135, 16, 12), mat(skin, { roughness: 0.75 }));
  head.position.set(0, 1.52, 0.02);
  g.add(head);
  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.142, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62),
    mat(0x18181c, { roughness: 1 })
  );
  hair.position.set(0, 1.535, 0.02);
  g.add(hair);

  addContactShadow(g, 0.52);

  return { group: g, armL, armR, head, legsSit, legsStand,
           phase: Math.random() * Math.PI * 2 };
}

function buildSecurityGuard(x, z){
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  scene.add(g);

  const skin = 0xd0a070;
  const uniform = 0x1c2a44;
  const pants = 0x141e30;

  /* ---------- 腿 ---------- */
  box(0.18, 0.17, 0.46, pants, -0.115, 0.52, 0.22, g);
  box(0.18, 0.17, 0.46, pants,  0.115, 0.52, 0.22, g);
  box(0.17, 0.46, 0.17, pants, -0.115, 0.24, 0.42, g);
  box(0.17, 0.46, 0.17, pants,  0.115, 0.24, 0.42, g);

  /* ---------- 制服 ---------- */
  box(0.50, 0.62, 0.29, uniform, 0, 1.10, 0.01, g);
  box(0.52, 0.035, 0.31, 0xffcc33, 0, 0.90, 0.01, g);
  box(0.52, 0.035, 0.31, 0xffcc33, 0, 1.28, 0.01, g);
  box(0.52, 0.045, 0.31, 0x0a1525, 0, 1.40, 0.01, g);
  box(0.52, 0.05, 0.31, 0x080808, 0, 0.80, 0.01, g);

  /* ---------- 手臂：独立几何 + 独立材质 ---------- */
  const armL = new THREE.Mesh(
    new THREE.BoxGeometry(0.14, 0.55, 0.14),
    new THREE.MeshStandardMaterial({ color: uniform, roughness: 0.88, metalness: 0.04 })
  );
  armL.position.set(-0.33, 1.12, 0.10);
  armL.rotation.x = -0.2;
  g.add(armL);

  const armR = new THREE.Mesh(
    new THREE.BoxGeometry(0.14, 0.55, 0.14),
    new THREE.MeshStandardMaterial({ color: uniform, roughness: 0.88, metalness: 0.04 })
  );
  armR.position.set(0.33, 1.12, 0.10);
  armR.rotation.x = -0.2;
  g.add(armR);

  /* ---------- 头 ---------- */
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 16, 12),
    new THREE.MeshStandardMaterial({ color: skin, roughness: 0.75, metalness: 0.04 })
  );
  head.position.set(0, 1.58, 0.02);
  g.add(head);

  /* ---------- 帽子 ---------- */
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.17, 0.17, 0.06, 16),
    new THREE.MeshStandardMaterial({ color: 0x0a1525, roughness: 0.5, metalness: 0.04 })
  );
  cap.position.set(0, 1.76, 0.02);
  g.add(cap);

  /* ---------- 帽檐 ---------- */
  const brim = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 0.02, 0.18),
    new THREE.MeshStandardMaterial({ color: 0x050c18, roughness: 0.5, metalness: 0.04 })
  );
  brim.position.set(0, 1.73, 0.13);
  g.add(brim);

  /* ---------- 徽章 ---------- */
  const badge = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 0.01, 8),
    new THREE.MeshStandardMaterial({ color: 0xffcc33, roughness: 0.3, metalness: 0.8 })
  );
  badge.rotation.x = Math.PI / 2;
  badge.position.set(0, 1.76, 0.15);
  g.add(badge);

  /* ---------- 头顶警告灯 ---------- */
  const warnLight = new THREE.Mesh(
    getSphereGeo(0.05, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xff3333 })
  );
  warnLight.position.set(0, 1.84, 0.02);
  g.add(warnLight);

  /* 加法混合的红色光晕：配合点光源与拖影，就是"红灯拖影"的主角 */
  const glow = new THREE.Mesh(
    getSphereGeo(0.13, 8, 8),
    new THREE.MeshBasicMaterial({
      color: 0xff3333, transparent: true, opacity: 0.30,
      blending: THREE.AdditiveBlending, depthWrite: false
    })
  );
  glow.position.set(0, 1.84, 0.02);
  glow.userData.qualityDetail = true;
  g.add(glow);

  addContactShadow(g, 0.58);
  applyQualityToObject(g);

  return {
    group: g, armL, armR, head, warnLight,
    glow,
    phase: Math.random() * Math.PI * 2
  };
}

/* ---------- 保安系统 ---------- */
const securityGuards = [];
const GUARD_SPEED_BASE = 0.55;
const GUARD_SPAWN_DIST = 5.0;
const GUARD_HIT_RADIUS = 0.95;
const GUARD_PUNCH_RANGE = 2.2;
const GUARD_MAX_TOTAL = 200;   // 全场最多排出多少保安；耗尽后不再补充

/* ---------- 假接触阴影：径向渐变贴片，比真阴影便宜且可随紧张态加深 ---------- */
const _shadowGeo = new THREE.PlaneGeometry(1, 1);
const _shadowTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 1, 32, 32, 31);
  grad.addColorStop(0, 'rgba(0,0,0,0.9)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.5)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const contactShadows = [];

function addContactShadow(parent, radius){
  const m = new THREE.Mesh(_shadowGeo, new THREE.MeshBasicMaterial({
    map: _shadowTex, transparent: true, opacity: 0.45, depthWrite: false
  }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.012;
  m.scale.set(radius * 2, radius * 2, 1);
  m.renderOrder = 1;
  m.userData.qualityDetail = true;
  parent.add(m);
  contactShadows.push(m);
  return m;
}

/* 紧张态：阴影变深（"阴影更深"的廉价实现，无需 shadowMap） */
function deepenContactShadows(t){
  /* 清扫：组已被移出场景的角色（父级的父级为空）其阴影不再需要 */
  for (let i = contactShadows.length - 1; i >= 0; i--){
    const m = contactShadows[i];
    if (m.parent && m.parent.parent === null) contactShadows.splice(i, 1);
  }
  for (const m of contactShadows) m.material.opacity = 0.42 + 0.46 * t;
}

/* ---------- 保安警灯：最多 2 盏真实点光源，挂到最近的保安头顶 ----------
   点光源数量直接进光照 shader，不能按保安数无限添加，故做上限并常驻。 */
const guardLights = [];
/* ---------- 终局：门开 + 强光投射 ---------- */
function openTheDoor(){
  state.doorOpen = true;
  doorLightMesh.visible = true;
  doorGlowMesh.visible = true;
  doorFloorMesh.visible = true;
}

/* 每帧推进开门与点灯（1.6s 平滑完成） */
function updateDoorLight(dt){
  if (!state.doorOpen || !doorGroup) return;
  if (doorOpenT >= 1) return;
  doorOpenT = Math.min(1, doorOpenT + dt / 1.6);
  const e = doorOpenT * doorOpenT * (3 - 2 * doorOpenT);       /* smoothstep */
  doorGroup.rotation.y = -1.9 * e;                              /* 开门约 109° */
  doorLightMesh.material.opacity = 0.45 + 0.55 * e;             /* 门口白面 */
  doorGlowMesh.material.opacity   = 0.75 * e;                   /* 外侧辉光 */
  doorFloorMesh.material.opacity  = 0.9 * e;                    /* 地面投射 */
  doorPointLight.intensity        = 7 * e;                      /* 照进考场 */
}

/* 准星是否指着白光区域（用于反色，保证可读） */
function aimingAtWhiteLight(){
  if (!state.doorOpen || doorOpenT < 0.12 || !doorLightMesh) return false;
  raycaster.setFromCamera(CENTER, camera);
  raycaster.far = 16;
  return raycaster.intersectObject(doorLightMesh, false).length > 0;
}

function initGuardLights(){
  for (let i = 0; i < 2; i++){
    const l = new THREE.PointLight(0xff2211, 0, 7, 2);
    l.userData.noTensionDim = true;   /* 紧张值调光时跳过，强度由闪烁驱动 */
    scene.add(l);
    guardLights.push(l);
  }
}

/* guards：按距离排序后的前两名（可为 null） */
function updateGuardLights(guards, t){
  for (let i = 0; i < guardLights.length; i++){
    const l = guardLights[i];
    const g = guards[i];
    if (g && g.userData.alive){
      g.group.add(l);                                  // 自动从上一个父节点摘离
      l.position.set(0, 1.84, 0.02);
      l.intensity = (0.9 + 2.4 * (g.userData.blink || 0)) * (1 + 0.5 * t);
    } else {
      l.intensity = 0;                                // 保留在场景里，避免 shader 重编译
    }
  }
}

/* 剩余可派出名额（纯函数，便于测试） */
function guardPoolRemaining(){
  return Math.max(0, GUARD_MAX_TOTAL - (state.guardsSpawned || 0));
}

function aliveGuardCount(){
  let n = 0;
  for (const g of securityGuards) if (g.userData.alive) n++;
  return n;
}

/* 清理已死亡的保安，防止数组无限增长导致每帧遍历膨胀 */
function pruneDeadGuards(){
  for (let i = securityGuards.length - 1; i >= 0; i--){
    if (!securityGuards[i].userData.alive) securityGuards.splice(i, 1);
  }
}

function spawnTwoGuards(){
  if (state.ended) return;
  pruneDeadGuards();

  /* 名额耗尽：不再派出新保安 */
  const n = Math.min(2, guardPoolRemaining());
  if (n <= 0) return;

  const baseAngles = [
    Math.random() * Math.PI * 2,
    Math.random() * Math.PI * 2 + Math.PI
  ];
  const speedBonus = Math.min(0.35, state.guardKills * 0.04);

  for (let i = 0; i < n; i++){
    let angle = baseAngles[i];
    const dist = GUARD_SPAWN_DIST + Math.random() * 1.2;
    let gx = state.pos.x + Math.cos(angle) * dist;
    let gz = state.pos.z + Math.sin(angle) * dist;
    gx = clamp(gx, -7.5, 7.5);
    gz = clamp(gz, -6.5, 6.5);

    let tries = 0;
    while (Math.hypot(gx - state.pos.x, gz - state.pos.z) < 3.6 && tries++ < 14){
      angle += 0.9;
      gx = clamp(state.pos.x + Math.cos(angle) * dist, -7.5, 7.5);
      gz = clamp(state.pos.z + Math.sin(angle) * dist, -6.5, 6.5);
    }

    const g = buildSecurityGuard(gx, gz);
    g.userData = {
      speed: GUARD_SPEED_BASE + speedBonus,
      alive: true
    };
    securityGuards.push(g);
    state.guardsSpawned = (state.guardsSpawned || 0) + 1;
  }
}

/* ---------- 构建世界 ---------- */
function buildWorld(){
  buildRoom();
  buildDesk(0, -3, true);

  const seats = [
    { x: -4.5, z: -3.0, color: 0x3b5ba5 },
    { x:  4.5, z: -3.0, color: 0x8a4a6b },
    { x: -4.5, z:  2.5, color: 0x4a7a5a },
    { x:  0.0, z:  2.5, color: 0x7a6a3a },
    { x:  4.5, z:  2.5, color: 0x5a4a8a }
  ];
  const NPC_NAMES = ['小明', '小红', '小刚', '小强', '小丽'];
  seats.forEach((s, i) => {
      buildDesk(s.x, s.z, true);
      const p = buildPerson(s.x, s.z + 0.92, s.color, Math.PI);
      p.userData = {
        id: i, name: NPC_NAMES[i],
        seatX: s.x, seatZ: s.z + 0.92,
        state: 'seated', anger: 0, baseRot: Math.PI, timer: 0
      };
      npcs.push(p);
  });

  teacher = buildPerson(2.4, 0, 0x2f3a4d, 0, 'stand');
  teacher.userData = { mode: 'patrol' };
}
