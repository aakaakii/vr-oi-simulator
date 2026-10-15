'use strict';
(async function(){
  const results = [], saved = new Map(['oi_view_v8','oi_save_v8'].map(key => [key,localStorage.getItem(key)]));
  let frame;
  function check(name,condition){
    results.push({name,pass:!!condition});
    const li = document.createElement('li');
    li.className = condition ? 'pass' : 'fail';
    li.textContent = (condition ? 'PASS ' : 'FAIL ') + name;
    document.getElementById('results').appendChild(li);
    if (!condition) throw new Error(name);
  }
  function game(code){ return frame.contentWindow.eval(code); }
  async function load(mode,settings){
    if (frame) frame.remove();
    localStorage.setItem('oi_view_v8',JSON.stringify(settings));
    localStorage.removeItem('oi_save_v8');
    const html = await (await fetch('../index.html')).text();
    const bootstrap = `<base href="${new URL('../',location.href).href}"><script>
      window.testErrors=[];window.testGLCalls=0;
      window.addEventListener('error',event=>testErrors.push(event.message));
      window.requestAnimationFrame=callback=>{window.testNextFrame=callback;return 1;};
      const originalGetContext=HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext=function(type,...args){
        if(type==='webgl'||type==='webgl2'||type==='experimental-webgl'){
          testGLCalls++;if(${JSON.stringify(mode)}==='no-webgl')return null;
        }
        return originalGetContext.call(this,type,...args);
      };
    <\/script>`;
    frame = document.createElement('iframe');
    const loaded = new Promise(resolve => frame.onload = resolve);
    frame.srcdoc = html.replace('<head>','<head>' + bootstrap);
    document.body.appendChild(frame);
    await loaded;
    game('requestLock=()=>{};');
    check(mode + '：完整初始化，无未捕获异常',game('!!renderer && !!clock && !testErrors.length'));
  }
  try {
    await load('no-webgl',{quality:'auto',renderer:'auto'});
    check('无 WebGL 自动切换 Canvas，默认低画质',game('renderer.isCanvasRenderer && activeQuality==="low" && testGLCalls>0'));
    check('兼容模式没有后处理缓冲',game('!postOK && !rtFrame && !rtAccA && !rtAccB'));
    check('兼容模式绘制了考场，而非仅显示空白背景',game(`(() => {
      renderFrame(1/30);const ctx=renderer.ctx,w=renderer.domElement.width,h=renderer.domElement.height;
      const colors=new Set();for(let y=0;y<h;y+=30)for(let x=0;x<w;x+=30)colors.add(Array.from(ctx.getImageData(x,y,1,1).data).join(','));
      return colors.size>12;
    })()`));
    check('斜看黑板时文字纹理仍可见',game(`(() => {
      camera.rotation.y=-0.8;renderFrame(1/30);
      const ctx=renderer.ctx,w=renderer.domElement.width,h=renderer.domElement.height;
      const pixels=ctx.getImageData(0,0,w,h).data;let red=0;
      for(let i=0;i<pixels.length;i+=16)if(pixels[i]>150&&pixels[i+1]<100&&pixels[i+2]<100)red++;
      camera.rotation.y=0;return red>20;
    })()`));
    check('开始游戏后方向键可转头，WASD 可移动',game(`(() => {
      $('btnStart').click();const yaw=state.yaw,x=state.pos.x;
      state.keys={lookRight:true,d:true};applyLook(0.1);updatePlayer(0.1);state.keys={};
      return state.yaw<yaw && state.pos.x>x;
    })()`));
    check('Canvas 下电脑射线拾取与 E 键交互可用',game(`(() => {
      state.pos.set(0,1.65,-1.72);camera.position.copy(state.pos);
      const monitor=interactables.find(o=>o.userData.interact.label==='使用电脑');
      monitor.updateWorldMatrix(true,false);const target=monitor.getWorldPosition(new THREE.Vector3());
      camera.lookAt(target);scene.updateMatrixWorld(true);updateInteract();
      if(!actionE)return false;doInteract('e');return state.view==='code' && !codeUI.classList.contains('hidden');
    })()`));
    check('答题内容在切换画质和渲染模式后保留',game(`(() => {
      codeArea.value='// graphics regression';saveCode();const elapsed=state.elapsed;
      for(const q of ['high','medium','low']){qualityPreference=q;applyGraphicsQuality();renderFrame(1/30);}
      switchSceneRenderer('webgl');
      return renderer.isCanvasRenderer && state.code[state.curProb]==='// graphics regression' && state.elapsed===elapsed && !postOK;
    })()`));
    check('高、中、低档位立即生效，选择框同步并持久保存',game(`(() => {
      $('qualitySelect').value='medium';$('qualitySelect').dispatchEvent(new Event('change'));
      const stored=JSON.parse(localStorage.getItem(SETTINGS_KEY));
      return activeQuality==='medium' && $('qualitySelectStart').value==='medium' && stored.quality==='medium';
    })()`));
    check('Canvas 弹窗绘制和数字键确认可用',game(`(() => {
      closeCode();let selected=false;
      const dlg=openDialog({title:'兼容模式测试',text:'选项与纹理应可见',options:[{label:'确认',cb:d=>{selected=true;closeDialog(d);}}]});
      updateDialogs(0.05);renderFrame(1/30);selectDialogOption(0);
      return selected && !dialogs.includes(dlg);
    })()`));
    check('低画质限制连续击倒产生的碎块总数',game(`(() => {
      qualityPreference='low';applyGraphicsQuality();
      for(let i=0;i<8;i++){const g=buildSecurityGuard(3,3);spawnBodyDebris(g.group);scene.remove(g.group);}
      return debrisList.length>0 && debrisList.length<=graphicsProfile().debris;
    })()`));
    check('低画质关闭点光、接触阴影和辉光',game(`(() => {
      let lights=0,details=0;scene.traverse(o=>{if(o.isPointLight&&o.visible)lights++;if(o.userData.qualityDetail&&o.visible)details++;});
      return lights===0 && details===0 && renderer.getPixelRatio()<=0.65;
    })()`));
    check('持续低帧率自动降档，保留“自动”偏好',game(`(() => {
      qualityPreference='auto';activeQuality='medium';configureGraphics();qualityWarmup=0;
      for(let i=0;i<70;i++)sampleGraphicsPerformance(0.05);
      return activeQuality==='low' && qualityPreference==='auto' && $('qualitySelect').value==='auto';
    })()`));
    check('严重卡顿（每帧 500ms）也会自动降档',game(`(() => {
      activeQuality='medium';configureGraphics();qualityWarmup=0;
      for(let i=0;i<8;i++)sampleGraphicsPerformance(0.5);
      return activeQuality==='low';
    })()`));
    check('手动画质不会被性能采样覆盖',game(`(() => {
      qualityPreference='high';applyGraphicsQuality();qualityWarmup=0;
      for(let i=0;i<80;i++)sampleGraphicsPerformance(0.1);
      return activeQuality==='high';
    })()`));
    check('帧率限制不改变比赛时钟的流速',game(`(() => {
      qualityPreference='low';applyGraphicsQuality();state.view='pause';
      const getDelta=clock.getDelta.bind(clock),before=state.elapsed;
      clock.getDelta=()=>0.5;forceRedraw=false;lastFrameAt=null;animate(1000000);clock.getDelta=getDelta;
      return Math.abs(state.elapsed-before-0.5*timeScale)<0.001;
    })()`));
    check('近裁剪及窗口缩放可正确绘制',game(`(() => {
      state.view='world';renderer.setSize(400,300);camera.aspect=4/3;camera.updateProjectionMatrix();
      camera.position.set(0,0.8,-3);renderFrame(1/30);
      return renderer.domElement.width===260 && renderer.domElement.height===195 && !testErrors.length;
    })()`));
    check('设置重新加载后保留画质和渲染偏好',game(`(() => {
      qualityPreference='medium';rendererPreference='canvas';saveViewSettings();
      qualityPreference='auto';rendererPreference='auto';loadViewSettings();
      return qualityPreference==='medium' && rendererPreference==='canvas';
    })()`));

    await load('native',{quality:'high',renderer:'webgl'});
    if (!game('renderer.isCanvasRenderer')){
      check('真实 WebGL 高画质启用拖影',game('postOK && !!rtFrame && renderer.getPixelRatio()<=1.5'));
      check('降低画质释放后处理缓冲和材质复杂度',game(`(() => {
        const rt=rtFrame;let disposed=false;rt.addEventListener('dispose',()=>disposed=true);
        qualityPreference='low';applyGraphicsQuality();let standard=0;
        scene.traverse(o=>{if(o.isMesh&&o.material.isMeshStandardMaterial)standard++;});
        renderFrame(1/30);return disposed && !postOK && rtFrame===null && standard===0;
      })()`));
      check('恢复高画质重建拖影并恢复材质',game(`(() => {
        qualityPreference='high';applyGraphicsQuality();let standard=0;
        scene.traverse(o=>{if(o.isMesh&&o.material.isMeshStandardMaterial)standard++;});renderFrame(1/60);
        return postOK && standard>0;
      })()`));
      check('运行中 WebGL context 丢失时保留当前对局',game(`(() => {
        $('btnStart').click();state.code[state.curProb]='// survives context loss';const time=state.elapsed;
        renderer.domElement.dispatchEvent(new Event('webglcontextlost',{cancelable:true}));renderFrame(1/30);
        return renderer.isCanvasRenderer && state.started && state.elapsed===time && state.code[state.curProb]==='// survives context loss' && !postOK;
      })()`));
      check('Canvas 可以切回 WebGL，并继续同一局',game(`(() => {
        switchSceneRenderer('webgl');renderFrame(1/60);
        return !renderer.isCanvasRenderer && state.started && state.code[state.curProb]==='// survives context loss' && postOK;
      })()`));
    } else {
      const li=document.createElement('li');li.textContent='SKIP 当前环境不提供原生 WebGL，已验证自动回退。';document.getElementById('results').appendChild(li);
    }
    check('整个测试过程没有未捕获的脚本异常',game('testErrors.length===0'));
  } catch(error){
    if (!results.some(r=>!r.pass)){
      const li=document.createElement('li');li.className='fail';li.textContent='ERROR '+error.stack;document.getElementById('results').appendChild(li);
      results.push({name:error.message,pass:false});
    }
  } finally {
    if (frame) frame.remove();
    for (const [key,value] of saved){ if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value); }
    window.graphicsTestResults = results;
    const passed=results.filter(r=>r.pass).length;
    document.getElementById('summary').textContent = passed + ' / ' + results.length + ' 项通过';
    document.body.dataset.testStatus = passed===results.length ? 'passed' : 'failed';
  }
})();
