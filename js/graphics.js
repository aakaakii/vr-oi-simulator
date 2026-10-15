'use strict';
/* 画质偏好与实际档位分开：自动降档不会覆盖玩家保存的“自动”。 */
const QUALITY_PRESETS = {
  high:   { label:'高', dpr:1.5, fps:60, post:true,  lights:6, debris:100, perHit:20, effects:true },
  medium: { label:'中', dpr:1,   fps:60, post:false, lights:2, debris:36,  perHit:10, effects:true },
  low:    { label:'低', dpr:0.65,fps:30, post:false, lights:0, debris:8,   perHit:4,  effects:false }
};
let qualityPreference = 'auto', rendererPreference = 'auto';
let activeQuality = 'medium', rendererFallbackReason = '';
let qualitySampleTime = 0, qualitySampleFrames = 0, qualityWarmup = 2;
const simpleMaterials = new WeakMap();
const originalMaterials = new WeakMap();

function graphicsProfile(){ return QUALITY_PRESETS[activeQuality]; }
function initialAutoQuality(){
  if (renderer && renderer.isCanvasRenderer) return 'low';
  if ((navigator.hardwareConcurrency || 4) <= 4 || (navigator.deviceMemory || 4) <= 4) return 'low';
  return 'medium';
}

function freshSceneCanvas(){
  /* 同一 canvas 一旦取得 WebGL context 就不能再取得 2D context。 */
  const old = $('scene'), canvas = old.cloneNode(false);
  old.parentNode.replaceChild(canvas, old);
  return canvas;
}

function createSceneRenderer(){
  rendererFallbackReason = '';
  let canvas = $('scene');
  if (rendererPreference !== 'canvas'){
    try {
      const result = new THREE.WebGLRenderer({ canvas, antialias:false,
        powerPreference:'low-power', failIfMajorPerformanceCaveat:true });
      result.domElement.addEventListener('webglcontextlost', handleContextLoss, false);
      return result;
    } catch(e){
      rendererFallbackReason = 'WebGL 不可用，已自动使用 Canvas 兼容模式。';
      canvas = freshSceneCanvas();
    }
  }
  return new CanvasSceneRenderer(canvas);
}

function handleContextLoss(event){
  event.preventDefault();
  /* GPU context 丢失也能继续当前对局，不依赖刷新或重开。 */
  switchSceneRenderer('canvas');
  rendererFallbackReason = 'WebGL 上下文已丢失，已切换 Canvas 继续游戏。';
  syncGraphicsUI();
  toast(rendererFallbackReason, 3500);
}

function switchSceneRenderer(preference){
  const wasLocked = pointerLocked;
  releaseLock();
  if (renderer){
    renderer.domElement.removeEventListener('webglcontextlost', handleContextLoss);
    disposePostFX();
    renderer.dispose();
    if (renderer.forceContextLoss && !renderer.getContext().isContextLost()) renderer.forceContextLoss();
  }
  dragLookPoint = null;
  rendererPreference = preference;
  freshSceneCanvas();
  renderer = createSceneRenderer();
  if (THREE.sRGBEncoding) renderer.outputEncoding = THREE.sRGBEncoding;
  bindSceneEvents();
  applyGraphicsQuality();
  if (wasLocked) requestLock();
}

function qualityMaterial(material){
  if (!material.isMeshStandardMaterial) return material;
  if (!simpleMaterials.has(material)){
    simpleMaterials.set(material, new THREE.MeshLambertMaterial({
      color:material.color, map:material.map, emissive:material.emissive,
      emissiveMap:material.emissiveMap, emissiveIntensity:material.emissiveIntensity,
      transparent:material.transparent, opacity:material.opacity, side:material.side,
      depthTest:material.depthTest, depthWrite:material.depthWrite,
      blending:material.blending, fog:material.fog
    }));
  }
  return simpleMaterials.get(material);
}

function applyQualityToObject(root){
  const profile = graphicsProfile();
  root.traverse(obj => {
    if (obj.isMesh){
      if (!originalMaterials.has(obj)) originalMaterials.set(obj,obj.material);
      const original = originalMaterials.get(obj);
      obj.material = activeQuality === 'high' ? original : qualityMaterial(original);
      if (obj.userData.qualityDetail) obj.visible = profile.effects;
    }
  });
}

function applyGraphicsQuality(){
  activeQuality = qualityPreference === 'auto' ? initialAutoQuality() : qualityPreference;
  configureGraphics();
}

function configureGraphics(){
  const profile = graphicsProfile();
  document.body.dataset.quality = activeQuality;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, profile.dpr));
  renderer.setSize(innerWidth,innerHeight);
  if (scene){
    applyQualityToObject(scene);
    let count = 0;
    scene.traverse(obj => { if (obj.isPointLight) obj.visible = ++count <= profile.lights; });
  }
  if (profile.post && !renderer.isCanvasRenderer){
    if (!postOK) initPostFX();
    else resizePostFX();
  } else disposePostFX();
  trimDebris(profile.debris);
  qualitySampleTime = 0; qualitySampleFrames = 0; qualityWarmup = 2;
  forceRedraw = true;
  syncGraphicsUI();
}

function sampleGraphicsPerformance(dt){
  if (qualityPreference !== 'auto' || activeQuality === 'low' || state.view !== 'world' ||
      !state.started || state.ended || document.hidden){
    qualitySampleTime = 0; qualitySampleFrames = 0;
    return;
  }
  if (qualityWarmup > 0){ qualityWarmup -= dt; return; }
  qualitySampleTime += dt;
  qualitySampleFrames++;
  if (qualitySampleTime < 3) return;
  const fps = qualitySampleFrames / qualitySampleTime;
  qualitySampleTime = 0; qualitySampleFrames = 0;
  if (fps < 40){
    activeQuality = activeQuality === 'high' ? 'medium' : 'low';
    configureGraphics();
    toast('已自动降低画质，提高运行流畅度。可在设置中手动调整。',2800);
  }
}

function syncGraphicsUI(){
  ['qualitySelectStart','qualitySelect'].forEach(id => { if ($(id)) $(id).value = qualityPreference; });
  ['rendererSelectStart','rendererSelect'].forEach(id => { if ($(id)) $(id).value = rendererPreference; });
  const mode = renderer && renderer.isCanvasRenderer ? 'Canvas 兼容模式' : 'WebGL';
  const profile = graphicsProfile();
  const text = mode + ' · ' + profile.label + '画质 · ' + profile.fps + ' FPS 上限' +
    (rendererFallbackReason ? '。' + rendererFallbackReason : '。低画质适合老旧设备，设置立即生效。');
  ['graphicsStatusStart','graphicsStatus'].forEach(id => { if ($(id)) $(id).textContent = text; });
}

function bindGraphicsEvents(){
  ['qualitySelectStart','qualitySelect'].forEach(id => $(id).addEventListener('change',e => {
    qualityPreference = e.target.value;
    applyGraphicsQuality();
    saveViewSettings();
  }));
  ['rendererSelectStart','rendererSelect'].forEach(id => $(id).addEventListener('change',e => {
    switchSceneRenderer(e.target.value);
    saveViewSettings();
  }));
}
