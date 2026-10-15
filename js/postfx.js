'use strict';
/* =========================================================
   postfx —— 全局动态模糊（自研 afterimage 通道，无外部依赖）
   ---------------------------------------------------------
   之前用 three examples 的 EffectComposer + AfterimagePass，但那五个
   CDN 脚本一旦加载失败就会静默回退成"无拖影"，且很难察觉。现在改为
   自研三通道 ping-pong，只用 three 内核的 WebGLRenderTarget：
     rtFrame  当前帧世界（不写 UI 层）
     rtAccA/B 累积缓冲：accum = mix(rtFrame, rtAccA, damp)
   流程：世界 → rtFrame；混合 → rtAccB；交换 A/B；A 以 linear→sRGB
    blit 到屏幕；最后再叠一层 UI（准星/弹窗，保持锐利）。
   所有常量 ramp 见 POST_DAMP_MIN/MAX，由紧张值驱动（setPostDamp）。
   ========================================================= */

const POST_DAMP_MIN = 0.2;    // 初始：安静考场也有一层薄拖影
const POST_DAMP_MAX = 0.9;    // 紧张值拉满：几乎复刻上一帧的长拖影

let postOK = false;
let rtFrame = null, rtAccA = null, rtAccB = null;
let postScene = null, postCamera = null, postQuad = null;
let blendMat = null, blitMat = null;
let postDamp = POST_DAMP_MIN;
let postPrimed = false;

const POST_VERT = `
  varying vec2 vUv;
  void main(){
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const POST_BLEND_FRAG = `
  precision mediump float;
  uniform sampler2D tNew;
  uniform sampler2D tOld;
  uniform float damp;
  varying vec2 vUv;
  void main(){
    vec4 n = texture2D(tNew, vUv);
    vec4 o = texture2D(tOld, vUv);
    gl_FragColor = mix(n, o, damp);
  }`;

const POST_BLIT_FRAG = `
  precision mediump float;
  uniform sampler2D tSrc;
  varying vec2 vUv;
  vec3 toSRGB(vec3 c){
    return mix(c * 12.92, 1.055 * pow(c, vec3(0.4166667)) - 0.055, step(0.0031308, c));
  }
  void main(){
    gl_FragColor = vec4(toSRGB(texture2D(tSrc, vUv).rgb), 1.0);
  }`;

function initPostFX(){
  if (renderer.isCanvasRenderer || !graphicsProfile().post) return false;
  try {
    const dpr = renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
    const w = Math.max(1, Math.floor(innerWidth * dpr));
    const h = Math.max(1, Math.floor(innerHeight * dpr));
    const mkRT = () => {
      const rt = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false
      });
      return rt;
    };
    rtFrame = mkRT();
    rtAccA = mkRT();
    rtAccB = mkRT();

    postScene = new THREE.Scene();
    postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    postQuad.frustumCulled = false;

    blendMat = new THREE.ShaderMaterial({
      uniforms: {
        tNew: { value: null },
        tOld: { value: null },
        damp: { value: postDamp }
      },
      vertexShader: POST_VERT, fragmentShader: POST_BLEND_FRAG,
      depthTest: false, depthWrite: false
    });
    blitMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader: POST_VERT, fragmentShader: POST_BLIT_FRAG,
      depthTest: false, depthWrite: false
    });
    postQuad.material = blendMat;
    postScene.add(postQuad);

    postOK = true;
    postPrimed = false;
  } catch(e){
    disposePostFX();
  }
  return postOK;
}

function disposePostFX(){
  for (const resource of [rtFrame,rtAccA,rtAccB,blendMat,blitMat]){
    if (resource) resource.dispose();
  }
  if (postQuad) postQuad.geometry.dispose();
  rtFrame = rtAccA = rtAccB = null;
  postScene = postCamera = postQuad = blendMat = blitMat = null;
  postOK = false;
  postPrimed = false;
}

/* 紧张值 → 拖影强度 */
function setPostDamp(t){
  postDamp = POST_DAMP_MIN + (POST_DAMP_MAX - POST_DAMP_MIN) * clamp(t, 0, 1);
}

function resizePostFX(){
  if (!postOK) return;
  const dpr = renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
  const w = Math.max(1, Math.floor(innerWidth * dpr));
  const h = Math.max(1, Math.floor(innerHeight * dpr));
  rtFrame.setSize(w, h);
  rtAccA.setSize(w, h);
  rtAccB.setSize(w, h);
  postPrimed = false;
}

/* 每帧渲染入口。注意两个坑：
   1) 相机 layers 默认只含 layer 0，准星/弹窗在 layer 1，
      任何路径都必须保证 layer 1 被渲染；
   2) three 对 Color 背景会 forceClear，即使 autoClear=false 也清屏，
      所以 UI 覆盖 pass 前要临时摘掉 scene.background。 */
function renderFrame(dt){
  if (!postOK){
    camera.layers.enable(1);
    try { renderer.render(scene, camera); }
    finally { camera.layers.disable(1); }
    return;
  }

  /* 首帧用 damp=0 播种，避免从黑屏渐入 */
  const damp = postPrimed ? postDamp : 0;
  postPrimed = true;

  /* 1. 世界 → rtFrame（不含 UI 层） */
  camera.layers.disable(1);
  renderer.setRenderTarget(rtFrame);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);

  /* 2. 累积：accum = mix(rtFrame, rtAccA, damp) → rtAccB，然后交换 */
  blendMat.uniforms.tNew.value = rtFrame.texture;
  blendMat.uniforms.tOld.value = rtAccA.texture;
  blendMat.uniforms.damp.value = damp;
  postQuad.material = blendMat;
  renderer.setRenderTarget(rtAccB);
  renderer.render(postScene, postCamera);
  renderer.setRenderTarget(null);
  const tmp = rtAccA; rtAccA = rtAccB; rtAccB = tmp;

  /* 3. blit 到屏幕（linear → sRGB） */
  blitMat.uniforms.tSrc.value = rtAccA.texture;
  postQuad.material = blitMat;
  renderer.render(postScene, postCamera);

  /* 4. UI 层叠加：摘背景、清深度、只渲染 layer 1 */
  const bg = scene.background;
  scene.background = null;
  camera.layers.enable(1);
  camera.layers.disable(0);
  renderer.autoClear = false;
  try {
    renderer.clearDepth();
    renderer.render(scene, camera);
  } finally {
    renderer.autoClear = true;
    camera.layers.enable(0);
    scene.background = bg;
  }
}
