'use strict';
/* 无 WebGL 时的低多边形软件渲染。沿用 Three 的场景、相机与拾取，
   只用 Canvas 2D 绘制；不创建 WebGL context、shader 或 render target。 */
class CanvasSceneRenderer {
  constructor(canvas){
    this.domElement = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    if (!this.ctx) throw new Error('浏览器不支持 Canvas 2D');
    this.isCanvasRenderer = true;
    this.pixelRatio = 1;
    this.width = 1;
    this.height = 1;
    this.faces = new WeakMap();
    this.texturedFaces = new WeakMap();
    this.viewMatrix = new THREE.Matrix4();
    this.normalMatrix = new THREE.Matrix3();
    this.normal = new THREE.Vector3();
    this.light = new THREE.Vector3(-0.3, 0.85, 0.45).normalize();
    this.frustum = new THREE.Frustum();
    this.projectionView = new THREE.Matrix4();
  }

  getPixelRatio(){ return this.pixelRatio; }
  setPixelRatio(ratio){ this.pixelRatio = ratio; }
  setSize(width, height){
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.domElement.width = Math.max(1, Math.floor(width * this.pixelRatio));
    this.domElement.height = Math.max(1, Math.floor(height * this.pixelRatio));
    this.domElement.style.width = width + 'px';
    this.domElement.style.height = height + 'px';
  }
  dispose(){}

  geometryFaces(geo, textured){
    const cache = textured ? this.texturedFaces : this.faces;
    if (cache.has(geo)) return cache.get(geo);
    const p = geo.parameters || {};
    let faces;
    if (geo.type === 'PlaneGeometry' || geo.type === 'PlaneBufferGeometry'){
      /* 分成小格再做仿射贴图，降低斜看屏幕/弹窗时的透视变形。 */
      const steps = textured ? 4 : 1;
      faces = [];
      for (let row=0; row<steps; row++) for (let col=0; col<steps; col++){
        const u0=col/steps,u1=(col+1)/steps,v0=row/steps,v1=(row+1)/steps;
        const left=(u0-0.5)*p.width,right=(u1-0.5)*p.width;
        const top=(0.5-v0)*p.height,bottom=(0.5-v1)*p.height;
        faces.push({points:[[left,top,0,u0,v0],[left,bottom,0,u0,v1],
          [right,bottom,0,u1,v1],[right,top,0,u1,v0]],normal:[0,0,1]});
      }
    } else {
      /* 曲面用包围盒代替，避免在 CPU 上处理人物头部的数百个三角形。
         使用实际包围盒也能正确保留半球头发的位置。 */
      if (!geo.boundingBox) geo.computeBoundingBox();
      const b = geo.boundingBox, a = b.min, z = b.max;
      const v = [[a.x,a.y,a.z],[z.x,a.y,a.z],[z.x,z.y,a.z],[a.x,z.y,a.z],
                 [a.x,a.y,z.z],[z.x,a.y,z.z],[z.x,z.y,z.z],[a.x,z.y,z.z]];
      faces = [
        [[0,3,2,1],[0,0,-1]], [[4,5,6,7],[0,0,1]],
        [[0,4,7,3],[-1,0,0]], [[1,2,6,5],[1,0,0]],
        [[3,7,6,2],[0,1,0]], [[0,1,5,4],[0,-1,0]]
      ].map(f => ({ points: f[0].map((i,j) => v[i].concat([[0,1],[0,0],[1,0],[1,1]][j])), normal: f[1] }));
    }
    cache.set(geo, faces);
    return faces;
  }

  /* 近裁剪时同时插值纹理坐标，防止贴近桌面/弹窗时多边形翻到身后。 */
  clipNear(points, near){
    const result = [];
    for (let i = 0; i < points.length; i++){
      const a = points[i], b = points[(i + 1) % points.length];
      const insideA = a.z <= -near, insideB = b.z <= -near;
      if (insideA) result.push(a);
      if (insideA !== insideB){
        const t = (-near - a.z) / (b.z - a.z);
        result.push({ x: lerp(a.x,b.x,t), y: lerp(a.y,b.y,t), z: -near,
          u: lerp(a.u,b.u,t), v: lerp(a.v,b.v,t) });
      }
    }
    return result;
  }

  render(world, view){
    const ctx = this.ctx, w = this.domElement.width, h = this.domElement.height;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = world.background ? '#' + world.background.getHexString() : '#090b11';
    ctx.fillRect(0,0,w,h);
    world.updateMatrixWorld();
    view.updateMatrixWorld();
    view.matrixWorldInverse.copy(view.matrixWorld).invert();
    this.projectionView.multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projectionView);
    const fx = view.projectionMatrix.elements[0] * w / 2;
    const fy = view.projectionMatrix.elements[5] * h / 2;
    const queue = [];

    world.traverseVisible(obj => {
      /* 准星在最后用 2D 画，shader 材质不进入软件渲染器。 */
      if (!obj.isMesh || !obj.layers.test(view.layers) || obj === retRing ||
          (reticle && obj.parent === reticle)) return;
      const material = obj.material;
      if (!material || !material.visible || material.opacity <= 0 || material.isShaderMaterial) return;
      if (!this.frustum.intersectsObject(obj)) return;
      this.viewMatrix.multiplyMatrices(view.matrixWorldInverse, obj.matrixWorld);
      this.normalMatrix.getNormalMatrix(obj.matrixWorld);
      const e = this.viewMatrix.elements;
      const isUI = (obj.layers.mask & 2) !== 0;
      const texturedPlane = material.map && (obj.geometry.type==='PlaneGeometry' || obj.geometry.type==='PlaneBufferGeometry');
      for (const face of this.geometryFaces(obj.geometry,!!material.map)){
        let points = face.points.map(p => ({
          x: e[0]*p[0] + e[4]*p[1] + e[8]*p[2] + e[12],
          y: e[1]*p[0] + e[5]*p[1] + e[9]*p[2] + e[13],
          z: e[2]*p[0] + e[6]*p[1] + e[10]*p[2] + e[14],
          u: p[3] || 0, v: p[4] || 0
        }));
        /* 使用裁剪前的中心排序，避免贴近大面板时，裁剪改变中心，
           使贴图被它后面的薄边框盖住。房间外壳独立先画。 */
        const depth = texturedPlane ? -e[14] : -points.reduce((sum,p) => sum + p.z,0) / points.length;
        points = this.clipNear(points, view.near);
        if (points.length < 3) continue;
        if (depth > view.far) continue;
        const projected = points.map(p => ({ x: w/2 - fx*p.x/p.z, y: h/2 + fy*p.y/p.z, u:p.u, v:p.v }));
        const a = projected[0], b = projected[1], c = projected[2];
        const area = (b.x-a.x)*(c.y-a.y) - (b.y-a.y)*(c.x-a.x);
        if (material.side !== THREE.DoubleSide &&
            (material.side === THREE.BackSide ? area < 0 : area > 0)) continue;
        if (projected.every(p => p.x < 0) || projected.every(p => p.x > w) ||
            projected.every(p => p.y < 0) || projected.every(p => p.y > h)) continue;
        this.normal.fromArray(face.normal).applyMatrix3(this.normalMatrix).normalize();
        const shade = material.isMeshBasicMaterial ? 1 : 0.65 + 0.35 * Math.max(0, this.normal.dot(this.light));
        const color = material.color || new THREE.Color(0xffffff);
        queue.push({ points: projected, depth, ui: isUI, background:!!obj.userData.canvasBackground, material,
          color: 'rgb(' + [color.r,color.g,color.b].map(n => Math.round(clamp(n*shade,0,1)*255)).join(',') + ')',
          image: face.points[0].length === 5 && material.map ? material.map.image : null });
      }
    });

    queue.sort((a,b) => Number(a.ui)-Number(b.ui) || Number(b.background)-Number(a.background) || b.depth-a.depth);
    for (const face of queue){
      ctx.globalAlpha = face.material.opacity;
      const p = face.points;
      ctx.beginPath();
      ctx.moveTo(p[0].x,p[0].y);
      for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x,p[i].y);
      ctx.closePath();
      if (face.image){
        /* 透明的阴影/辉光贴图不先填底色。 */
        if (!face.material.transparent){ ctx.fillStyle = face.color; ctx.fill(); }
        for (let i = 1; i < p.length - 1; i++) this.drawTexturedTriangle(face.image,p[0],p[i],p[i+1]);
      } else {
        ctx.fillStyle = face.color;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    this.drawReticle(w,h);
  }

  drawTexturedTriangle(img,a,b,c){
    if (!img.width || !img.height) return;
    const u0=a.u*img.width, v0=a.v*img.height;
    const u1=b.u*img.width, v1=b.v*img.height;
    const u2=c.u*img.width, v2=c.v*img.height;
    const det = u0*(v1-v2)+u1*(v2-v0)+u2*(v0-v1);
    if (Math.abs(det) < 0.001) return;
    const solve = (x0,x1,x2) => [
      (x0*(v1-v2)+x1*(v2-v0)+x2*(v0-v1))/det,
      (x0*(u2-u1)+x1*(u0-u2)+x2*(u1-u0))/det,
      (x0*(u1*v2-u2*v1)+x1*(u2*v0-u0*v2)+x2*(u0*v1-u1*v0))/det
    ];
    const x=solve(a.x,b.x,c.x), y=solve(a.y,b.y,c.y), ctx=this.ctx;
    ctx.save();
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.lineTo(c.x,c.y); ctx.closePath(); ctx.clip();
    ctx.setTransform(x[0],y[0],x[1],y[1],x[2],y[2]);
    ctx.drawImage(img,0,0);
    ctx.restore();
  }

  drawReticle(w,h){
    if (!reticle || !reticle.visible) return;
    const ctx = this.ctx, ratio = this.pixelRatio;
    ctx.save();
    ctx.translate(w/2,h/2);
    const scale = h / (2 * Math.tan(camera.fov * Math.PI / 360) * RETICLE_DIST);
    ctx.scale(reticle.scale.x,reticle.scale.y);
    ctx.strokeStyle = '#' + retBars[0].material.color.getHexString();
    ctx.lineWidth = Math.max(ratio, RETICLE_TH*scale);
    ctx.rotate(retAngle);
    const half = RETICLE_LEN*scale/2;
    ctx.beginPath(); ctx.moveTo(-half,0); ctx.lineTo(half,0); ctx.moveTo(0,-half); ctx.lineTo(0,half); ctx.stroke();
    ctx.rotate(-retAngle);
    if (retRing.visible){
      ctx.lineWidth = 2*ratio;
      ctx.strokeStyle = retRingU.uDark.value ? '#192438' : '#8badff';
      ctx.beginPath(); ctx.arc(0,0,RETICLE_RING_R*scale*0.87,-Math.PI/2,-Math.PI/2+2*Math.PI*retRingU.uProgress.value); ctx.stroke();
    }
    ctx.restore();
  }
}
