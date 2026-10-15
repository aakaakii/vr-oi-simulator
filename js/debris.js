'use strict';
/* =========================================================
   debris —— 击中爆散：身体部件飞散 + 形状感知的刚体物理
   ---------------------------------------------------------
   出拳命中（保安倒地 / 打中老师胳膊）时，把目标身上所有"极小单元"
   从角色组上摘下来丢进场景，作为独立刚体模拟：
   - 初速度 = 视线前向 + 部件相对视线的横向偏移（视角偏移量）
     + 随机散布与上抛；
   - 碰撞只针对地板 / 天花板 / 四面墙（房间 AABB，尺寸取 world.js 的
     ROOM_W / ROOM_D / ROOM_H）；碎块之间互不碰撞（按需求从略）；
   - 按几何形状取接触支撑点：盒 = OBB 支撑点（会磕角翻转）、
     球 = 球面（会滚）、柱 = 局部 AABB 近似；
   - 用完整的法向冲量 + 库仑摩擦冲量解算（含转动惯量），
     所以斜落会弹开、平落地会磕一下翻倒、球会越滚越慢；
   - 持续低速后进入 sleep，避免静止抖动；约 1.6s 后淡出移除；
     材质按部件克隆，不污染共享的几何/材质缓存。
   配套手感：kickView（look.js）视角回弹、hitStop（main.js）顿帧。
   ========================================================= */

const DEBRIS_GRAVITY = 10;       // 重力（m/s^2）
const DEBRIS_LIFE    = 2.5;      // 基础存活（秒）
const DEBRIS_FADE    = 0.5;      // 淡出时长（秒）
const DEBRIS_DRAG    = 1.2;      // 空气阻尼（1/s）
const DEBRIS_RESTITUTION = 0.1; // 弹性系数（低速时归零防抖）
const DEBRIS_FRICTION = 0.3;    // 摩擦系数
const DEBRIS_SLEEP_V   = 0.28;   // 线速度休眠阈值
const DEBRIS_SLEEP_W   = 1.1;    // 角速度休眠阈值
const DEBRIS_SLEEP_T   = 0.35;   // 低速持续多久后休眠
const DEBRIS_MAX_OMEGA = 22;     // 角速度钳制（rad/s）：小部件冲量极大，防变陀螺
const DEBRIS_ANG_DRAG  = 2.5;    // 自旋阻尼（1/s）
const DEBRIS_ROLL_RESIST = 1.6;  // 接触时的滚动/滑动阻力（1/s）

/* 房间碰撞平面：约束为 n*p >= d（n 指向房间内部） */
const DEBRIS_PLANES = [
  { n: new THREE.Vector3(0,  1, 0), d:  0 },            // 地板
  { n: new THREE.Vector3(0, -1, 0), d: -ROOM_H },       // 天花板
  { n: new THREE.Vector3(1,  0, 0), d: -ROOM_W / 2 },   // -X 墙
  { n: new THREE.Vector3(-1, 0, 0), d: -ROOM_W / 2 },   // +X 墙
  { n: new THREE.Vector3(0,  0, 1), d: -ROOM_D / 2 },   // -Z 墙
  { n: new THREE.Vector3(0,  0, -1), d: -ROOM_D / 2 }   // +Z 墙
];

const debrisList = [];
const _dbPos  = new THREE.Vector3();
const _dbQuat = new THREE.Quaternion();
const _dbScl  = new THREE.Vector3();
const _dbFwd  = new THREE.Vector3();
const _dbTo   = new THREE.Vector3();
const _dbSide = new THREE.Vector3();
const _dbDir  = new THREE.Vector3();
const _dbJit  = new THREE.Vector3();
/* 物理临时量（全部复用，避免每帧分配） */
const _dbAx = new THREE.Vector3(), _dbAy = new THREE.Vector3(), _dbAz = new THREE.Vector3();
const _dbR = new THREE.Vector3(), _dbCP = new THREE.Vector3();
const _dbVp = new THREE.Vector3(), _dbW = new THREE.Vector3(), _dbRn = new THREE.Vector3();
const _dbT1 = new THREE.Vector3(), _dbT2 = new THREE.Vector3(), _dbT3 = new THREE.Vector3();
const _dbTan = new THREE.Vector3(), _dbRt = new THREE.Vector3();
const _dbQ = new THREE.Quaternion(), _dbAxisN = new THREE.Vector3();

/* ---------- 形状描述：半长 + 转动惯量倒数 ---------- */
function boxShape(w, h, d){
  return {
    kind: 'box',
    half: new THREE.Vector3(w / 2, h / 2, d / 2),
    /* 单位质量盒体：Ix=(h^2+d^2)/12 ...，这里存倒数 */
    inv: new THREE.Vector3(12 / (h * h + d * d), 12 / (w * w + d * d), 12 / (w * w + h * h))
  };
}

function debrisShape(geo, scale){
  const p = (geo && geo.parameters) || {};
  const t = geo && geo.type;
  const sx = Math.abs(scale.x), sy = Math.abs(scale.y), sz = Math.abs(scale.z);
  if (t === 'SphereGeometry'){
    const r = (p.radius || 0.1) * Math.max(sx, sy, sz);
    return {
      kind: 'sphere',
      half: new THREE.Vector3(r, r, r),
      inv: new THREE.Vector3(1 / (0.4 * r * r), 1 / (0.4 * r * r), 1 / (0.4 * r * r))
    };
  }
  if (t === 'CylinderGeometry'){
    const r = Math.max(p.radiusTop || 0, p.radiusBottom || 0) * Math.max(sx, sz);
    const h = (p.height || 0.1) * sy;
    return boxShape(r * 2, h, r * 2);   /* 柱体用局部 AABB 近似 */
  }
  return boxShape((p.width || 0.1) * sx, (p.height || 0.1) * sy, (p.depth || 0.1) * sz);
}

/* OBB 沿某世界方向的支撑长度 */
function supportExtent(shape, n){
  if (shape.kind === 'sphere') return shape.half.x;
  _dbAx.set(1, 0, 0).applyQuaternion(shape.quat);
  _dbAy.set(0, 1, 0).applyQuaternion(shape.quat);
  _dbAz.set(0, 0, 1).applyQuaternion(shape.quat);
  return Math.abs(_dbAx.dot(n)) * shape.half.x +
         Math.abs(_dbAy.dot(n)) * shape.half.y +
         Math.abs(_dbAz.dot(n)) * shape.half.z;
}

/* 沿 -n 方向的最深支撑点（接触点） */
function supportPoint(shape, pos, n, out){
  if (shape.kind === 'sphere') return out.copy(pos).addScaledVector(n, -shape.half.x);
  _dbAx.set(1, 0, 0).applyQuaternion(shape.quat);
  _dbAy.set(0, 1, 0).applyQuaternion(shape.quat);
  _dbAz.set(0, 0, 1).applyQuaternion(shape.quat);
  out.copy(pos)
    .addScaledVector(_dbAx, Math.sign(_dbAx.dot(n)) * shape.half.x)
    .addScaledVector(_dbAy, Math.sign(_dbAy.dot(n)) * shape.half.y)
    .addScaledVector(_dbAz, Math.sign(_dbAz.dot(n)) * shape.half.z);
  return out;
}

/* 世界向量过一遍 I^-1 = R * diag(inv) * R^T */
function applyInvInertia(shape, v, out){
  _dbQ.copy(shape.quat).invert();
  out.copy(v).applyQuaternion(_dbQ);
  out.set(out.x * shape.inv.x, out.y * shape.inv.y, out.z * shape.inv.z);
  out.applyQuaternion(shape.quat);
  return out;
}

/* 角速度钳制 */
function clampOmega(d){
  const w = d.omega.length();
  if (w > DEBRIS_MAX_OMEGA) d.omega.multiplyScalar(DEBRIS_MAX_OMEGA / w);
}

/* ---------- 单个平面的碰撞解算：位置修正 + 法向/摩擦冲量 ---------- */
function resolvePlane(d, plane){
  const n = plane.n;
  const dist = n.dot(d.mesh.position) - plane.d;
  const pen = supportExtent(d.shape, n) - dist;
  if (pen <= 0) return false;

  /* 位置修正：沿法线推出穿透 */
  d.mesh.position.addScaledVector(n, pen);

  /* 接触点与力臂 */
  supportPoint(d.shape, d.mesh.position, n, _dbCP);
  _dbR.copy(_dbCP).sub(d.mesh.position);

  /* 接触点速度 v + w x r */
  _dbVp.copy(d.vel).add(_dbW.copy(d.omega).cross(_dbR));
  const vn = _dbVp.dot(n);
  if (vn >= 0) return true;              /* 正在分离：只推位置 */

  if (-vn < 0.6){
    /* 静置/轻微接触：只做速度级响应。此时做完整刚体解算会因支撑点
       随转角跳变而自激（越转越快、永远不休眠），故法向只抵掉接近速度 */
    d.vel.addScaledVector(n, -vn);
    _dbVp.copy(d.vel).add(_dbW.copy(d.omega).cross(_dbR));
    _dbTan.copy(_dbVp).addScaledVector(n, -_dbVp.dot(n));
    const ts = _dbTan.length();
    if (ts > 1e-4){
      _dbTan.divideScalar(ts);
      /* 摩擦带角项：滑动才会滚起来（球/头滚远更有质感）；
         角项只在摩擦里出现，法向不做角冲量，避免自激 */
      _dbRt.copy(_dbR).cross(_dbTan);
      applyInvInertia(d.shape, _dbRt, _dbT1);
      _dbT2.copy(_dbR).cross(_dbT1);
      const denomT = 1 + _dbTan.dot(_dbT2);
      const jt = Math.max(-DEBRIS_FRICTION * 0.35 * Math.abs(vn), -ts / Math.max(denomT, 1e-6));
      d.vel.addScaledVector(_dbTan, jt);
      applyInvInertia(d.shape, _dbRt, _dbT3);
      d.omega.addScaledVector(_dbT3, jt);
      clampOmega(d);
    }
    return true;
  }

  /* 明显撞击：完整法向 + 库仑摩擦冲量（含角冲量）——磕角翻倒的手感来源 */
  const e = DEBRIS_RESTITUTION;
  _dbRn.copy(_dbR).cross(n);
  applyInvInertia(d.shape, _dbRn, _dbT1);
  _dbT2.copy(_dbR).cross(_dbT1);
  const denom = 1 + n.dot(_dbT2);
  const j = -(1 + e) * vn / Math.max(denom, 1e-6);
  d.vel.addScaledVector(n, j);
  applyInvInertia(d.shape, _dbRn, _dbT3);
  d.omega.addScaledVector(_dbT3, j);

  /* 切向摩擦冲量 */
  _dbVp.copy(d.vel).add(_dbW.copy(d.omega).cross(_dbR));
  _dbTan.copy(_dbVp).addScaledVector(n, -_dbVp.dot(n));
  const tanSpeed = _dbTan.length();
  if (tanSpeed > 1e-4){
    _dbTan.divideScalar(tanSpeed);
    _dbRt.copy(_dbR).cross(_dbTan);
    applyInvInertia(d.shape, _dbRt, _dbT1);
    _dbT2.copy(_dbR).cross(_dbT1);
    const denomT = 1 + _dbTan.dot(_dbT2);
    const jt = Math.max(-DEBRIS_FRICTION * j, -tanSpeed / Math.max(denomT, 1e-6));
    d.vel.addScaledVector(_dbTan, jt);
    applyInvInertia(d.shape, _dbRt, _dbT3);
    d.omega.addScaledVector(_dbT3, jt);
  }
  clampOmega(d);
  return true;
}

/* ---------- 生成 ---------- */
function spawnBodyDebris(group, opt){
  if (!group) return;
  opt = opt || {};
  const speed = opt.speed || 3.4;
  group.updateMatrixWorld(true);

  const parts = [];
  group.traverseVisible(o => { if (o.isMesh && !o.userData.qualityDetail) parts.push(o); });
  const profile = graphicsProfile();
  const stride = Math.max(1, Math.ceil(parts.length / profile.perHit));
  let partIndex = 0;

  /* 视线前向（用于计算每个部件的视角偏移量） */
  _dbFwd.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();

  for (const p of parts){
    if (partIndex++ % stride !== 0){
      if (p.parent) p.parent.remove(p);
      continue;
    }
    p.updateWorldMatrix(true, false);
    p.matrixWorld.decompose(_dbPos, _dbQuat, _dbScl);

    /* 视角偏移量：部件所在位置相对准星射线的横向分量 */
    _dbTo.copy(_dbPos).sub(camera.position);
    const along = _dbTo.dot(_dbFwd);
    _dbSide.copy(_dbTo).addScaledVector(_dbFwd, -along);
    if (_dbSide.lengthSq() < 1e-6){
      _dbSide.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    }
    _dbSide.normalize();

    /* 前向主冲量 + 横向偏移分量 + 随机散布 */
    _dbJit.set((Math.random() - 0.5) * 0.6,
               Math.random() * 0.55 + 0.3,
               (Math.random() - 0.5) * 0.6);
    _dbDir.copy(_dbFwd).multiplyScalar(0.5)
      .addScaledVector(_dbSide, 0.95)
      .add(_dbJit)
      .normalize()
      .multiplyScalar(speed * (0.75 + Math.random() * 0.55));
    /* 归一化会压掉竖直分量，补一段独立上抛，保证抛物线好看 */
    _dbDir.y += 2.0 + Math.random() * 1.2;

    /* 按部件克隆材质（要淡出，不能动共享缓存材质） */
    const m = p.material.clone();
    m.transparent = true;
    m.opacity = 1;

    const mesh = new THREE.Mesh(p.geometry, m);
    mesh.position.copy(_dbPos);
    mesh.quaternion.copy(_dbQuat);
    mesh.scale.copy(_dbScl);
    scene.add(mesh);

    const shape = debrisShape(p.geometry, _dbScl);
    shape.quat = mesh.quaternion;      /* 刚体姿态实时引用 */

    /* 初始角速度：随机轴 + 随机速率 */
    _dbAxisN.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();

    debrisList.push({
      mesh, mat: m, shape,
      vel: _dbDir.clone(),
      omega: _dbAxisN.clone().multiplyScalar(3 + Math.random() * 8),
      life: DEBRIS_LIFE * (0.8 + Math.random() * 0.5),
      calm: 0, sleep: false
    });

    /* 从角色身上摘掉该部件：打爆即分离，不再跟随角色动画 */
    if (p.parent) p.parent.remove(p);
  }
  trimDebris(profile.debris);
}

/* 跨目标共用碎块预算，避免一拳扫倒多人后 CPU/显存持续膨胀。 */
function trimDebris(limit){
  while (debrisList.length > limit){
    const d = debrisList.shift();
    scene.remove(d.mesh);
    d.mat.dispose();
  }
}

/* ---------- 每帧物理 ---------- */
function updateDebris(dt){
  for (let i = debrisList.length - 1; i >= 0; i--){
    const d = debrisList[i];
    d.life -= dt;
    if (d.life <= 0){
      scene.remove(d.mesh);
      d.mat.dispose();          /* 只销毁克隆材质，共享几何不动 */
      debrisList.splice(i, 1);
      continue;
    }

    if (!d.sleep){
      /* 收尾段：生命最后 25% 额外增强阻尼，让所有碎块必然安定
         （接触求解里自旋与平移会互相转换，单靠阻尼存在极限环） */
      const settle = (d.life < DEBRIS_LIFE * 0.25) ? 6 : 1;

      /* 线运动积分：重力 + 空气阻尼 */
      d.vel.y -= DEBRIS_GRAVITY * dt;
      d.vel.multiplyScalar(Math.max(0, 1 - DEBRIS_DRAG * settle * dt));
      d.mesh.position.addScaledVector(d.vel, dt);

      /* 姿态积分：角速度 → 四元数 */
      const w = d.omega.length();
      if (w > 1e-5){
        _dbAxisN.copy(d.omega).divideScalar(w);
        _dbQ.setFromAxisAngle(_dbAxisN, w * dt);
        d.mesh.quaternion.multiply(_dbQ);
      }
      d.omega.multiplyScalar(Math.max(0, 1 - DEBRIS_ANG_DRAG * settle * dt));
      clampOmega(d);

      /* 与房间六面碰撞 */
      let touched = false;
      for (const pl of DEBRIS_PLANES){
        if (resolvePlane(d, pl)) touched = true;
      }

      /* 接触阻力（滚动/滑动阻力）：纯滚动在库仑模型里无损，
        不补这项碎块会永远滚下去、永远达不到休眠条件 */
      if (touched){
        const rr = Math.max(0, 1 - DEBRIS_ROLL_RESIST * settle * dt);
        d.vel.multiplyScalar(rr);
        d.omega.multiplyScalar(rr);
      }

      /* 贴地打转假象：有着地、自旋很高但平移很小 —— 盒体转角让 OBB
         支撑长度振荡，位置修正会持续注入能量。强阻尼收拾掉 */
      if (touched && d.omega.lengthSq() > 4 && d.vel.lengthSq() < 1.0){
        d.omega.multiplyScalar(Math.max(0, 1 - 12 * dt));
      }

      /* 休眠：有着地且持续低速 */
      if (touched &&
          d.vel.lengthSq() < DEBRIS_SLEEP_V * DEBRIS_SLEEP_V &&
          d.omega.lengthSq() < DEBRIS_SLEEP_W * DEBRIS_SLEEP_W){
        d.calm += dt;
        if (d.calm > DEBRIS_SLEEP_T){
          d.sleep = true;
          d.vel.set(0, 0, 0);
          d.omega.set(0, 0, 0);
        }
      } else {
        d.calm = 0;
      }
    }

    /* 尾部淡出 */
    if (d.life < DEBRIS_FADE) d.mat.opacity = Math.max(0, d.life / DEBRIS_FADE);
  }
}
