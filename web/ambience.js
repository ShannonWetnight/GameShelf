/* Independent star pulses keep sparkle fields alive even when the pointer is still. */
(() => {
  const covers=new Set();let background=null;
  function start(host,theme,speed,viewport=false) {
    const canvas=document.createElement('canvas');canvas.className=viewport?'gs-space-canvas':'gs-sparkle-canvas';canvas.setAttribute('aria-hidden','true');
    const context=canvas.getContext('2d');if(!context)return {move(){},stop(){},refresh(){}};
    const ratio=Math.min(devicePixelRatio||1,1.5);let width,height;
    const resize=()=>{const b=host.getBoundingClientRect();width=Math.max(1,viewport?innerWidth:b.width);height=Math.max(1,viewport?innerHeight:b.height);canvas.width=width*ratio;canvas.height=height*ratio;context.scale(ratio,ratio);};
    resize();host.appendChild(canvas);
    const palette=theme==='rose'?['#fff3f9','#ffc5e5','#e7bfff']:theme==='retro'?['#f46dff','#78c9ff','#d2afff']:['#d8e7ff','#a9bfff','#f6d9ff','#fff5d9'];
    const count=viewport?Math.min(650,Math.max(150,Math.round(width*height/3500))):Math.round(Math.max(35,width*height/1400));
    const stars=Array.from({length:count},()=>({x:Math.random(),y:Math.random(),radius:(viewport ? .35 : .55)+Math.random()*(viewport?1:1.4),phase:Math.random()*Math.PI*2,frequency:.9+Math.random()*2.2,glint:Math.random()<.2,color:palette[Math.floor(Math.random()*palette.length)]}));
    const media=matchMedia('(prefers-reduced-motion: reduce)');let frame=null,last=0,time=0,stopped=false,pointer=null;
    function draw(now) {
      frame=null;if(stopped)return;if(!host.isConnected){effect.stop();return;}
      const rate=media.matches?0:speed();time+=Math.min(40,last?now-last:16)/1000*rate;last=now;
      context.clearRect(0,0,width,height);
      for(const star of stars){const pulse=(.5+.5*Math.sin(star.phase+time*star.frequency))**3;const x=star.x*width,y=star.y*height;
        const near=pointer?Math.max(0,1-Math.hypot(x-pointer.x,y-pointer.y)/100):0;
        const alpha=(viewport ? .18 : .25)+pulse*(.7);const r=star.radius*(.65+pulse*.65+near*.3);
        context.fillStyle=star.color;context.globalAlpha=Math.min(1,alpha+near*.2);context.beginPath();context.arc(x,y,r,0,Math.PI*2);context.fill();
        if(star.glint&&pulse>.55){context.strokeStyle=star.color;context.lineWidth=.7;context.globalAlpha=(pulse-.55)*1.8;const arm=r*(viewport?2.5:4);context.beginPath();context.moveTo(x-arm,y);context.lineTo(x+arm,y);context.moveTo(x,y-arm);context.lineTo(x,y+arm);context.stroke();}
      }
      context.globalAlpha=1;if(rate>0)frame=requestAnimationFrame(draw);
    }
    const onResize=()=>{resize();effect.refresh();};
    const effect={get stopped(){return stopped;},move(x,y){pointer={x,y};effect.refresh();},refresh(){if(!frame&&!stopped)draw(performance.now());},stop(){stopped=true;cancelAnimationFrame(frame);canvas.remove();covers.delete(effect);if(viewport)window.removeEventListener('resize',onResize);media.removeEventListener?.('change',effect.refresh);}};
    if(viewport)window.addEventListener('resize',onResize);else covers.add(effect);media.addEventListener?.('change',effect.refresh);draw(performance.now());return effect;
  }
  window.GameShelfAmbience={
    startCover:(host,theme,speed)=>start(host,theme,speed),
    stopCovers(){for(const effect of [...covers])effect.stop();},
    refresh(){background?.refresh();for(const effect of covers)effect.refresh();},
    setTheme(theme,speed){background?.stop();background=null;for(const effect of [...covers])effect.stop();if(theme==='cosmos'){for(const [key,value]of Object.entries({'--nebula-x':10+Math.random()*35,'--nebula-y':Math.random()*40,'--nebula-x2':60+Math.random()*35,'--nebula-y2':50+Math.random()*45}))document.documentElement.style.setProperty(key,value+'%');background=start(document.body,theme,speed,true);}}
  };
})();
