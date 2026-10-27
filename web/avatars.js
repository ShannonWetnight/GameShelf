/* Original built-ins plus local-only, square upload cropping. The server
   revalidates and re-encodes custom photos before accepting a profile. */
(() => {
 const avatars=[{"id":"star-pilot","label":"Star Pilot"},{"id":"ember-knight","label":"Ember Knight"},{"id":"meadow-ranger","label":"Meadow Ranger"},{"id":"pixel-robot","label":"Pixel Robot"},{"id":"neon-racer","label":"Neon Racer"},{"id":"moon-mage","label":"Moon Mage"},{"id":"deep-diver","label":"Deep Diver"},{"id":"sky-courier","label":"Sky Courier"},{"id":"garden-sprout","label":"Garden Sprout"},{"id":"pirate-captain","label":"Pirate Captain"},{"id":"arcane-scholar","label":"Arcane Scholar"},{"id":"desert-nomad","label":"Desert Nomad"},{"id":"frost-guardian","label":"Frost Guardian"},{"id":"puzzle-owl","label":"Puzzle Owl"},{"id":"circuit-cat","label":"Circuit Cat"},{"id":"crystal-dragon","label":"Crystal Dragon"},{"id":"iron-engineer","label":"Iron Engineer"},{"id":"court-champion","label":"Court Champion"},{"id":"rhythm-dj","label":"Rhythm DJ"},{"id":"wandering-chef","label":"Wandering Chef"},{"id":"shadow-detective","label":"Shadow Detective"},{"id":"ocean-navigator","label":"Ocean Navigator"},{"id":"retro-astronaut","label":"Retro Astronaut"},{"id":"forest-sprite","label":"Forest Sprite"},{"id":"cosmic-fox","label":"Cosmic Fox"}];

 const $=id=>document.getElementById(id),known=new Set(avatars.map(item=>item.id));
 const fallback='builtin:pixel-robot',dialog=$('avatar-dialog'),canvas=$('avatar-canvas');
 let draft='',photo=null,zoom=1,tilt=0,pan={x:0,y:0},drag=null,version=0,resolveChoice=null,selected=null,dirty=false;
 function url(value){if(value?.startsWith('builtin:')&&known.has(value.slice(8)))return '/profile-avatars/'+value.slice(8)+'.webp';if(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value||'')&&value.length<132000)return value;return '/profile-avatars/pixel-robot.webp';}
 function resetTools(){zoom=1;tilt=0;pan={x:0,y:0};$('avatar-zoom').value='1';$('avatar-tilt').value='0';$('avatar-zoom').dataset.tooltip='Zoom: 100%';$('avatar-tilt').dataset.tooltip='Tilt: 0°';}
 function render(){
  $('avatar-preview-image').hidden=true;canvas.hidden=!photo;$('avatar-empty').hidden=!!photo;
  $('avatar-upload').textContent=draft||photo?'Clear Photo':'Upload Photo';
  for(const id of ['avatar-zoom','avatar-tilt'])$(id).disabled=!photo;
  for(const button of $('avatar-options').children)button.setAttribute('aria-pressed',String(button.dataset.avatar===draft));
  if(photo)draw();
 }
 function draw(){
  const context=canvas.getContext('2d'),angle=tilt*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),extent=256*(Math.abs(c)+Math.abs(s));
  const scale=Math.max(extent/photo.naturalWidth,extent/photo.naturalHeight)*zoom,w=photo.naturalWidth*scale,h=photo.naturalHeight*scale;
  let x=pan.x*c+pan.y*s,y=-pan.x*s+pan.y*c;x=Math.max(-(w-extent)/2,Math.min((w-extent)/2,x));y=Math.max(-(h-extent)/2,Math.min((h-extent)/2,y));pan={x:x*c-y*s,y:x*s+y*c};
  context.fillStyle='#0b1220';context.fillRect(0,0,256,256);context.save();context.translate(128+pan.x,128+pan.y);context.rotate(angle);context.drawImage(photo,-w/2,-h/2,w,h);context.restore();
 }
 function loadPhoto(source,uploaded=false){
  const current=++version,image=new Image();
  return new Promise((resolve,reject)=>{image.onload=()=>{if(current!==version||!dialog.open){resolve();return;}if(image.naturalWidth>16384||image.naturalHeight>16384){reject(new Error('Choose a photo smaller than 16384 pixels per side.'));return;}photo=image;dirty=uploaded;resetTools();render();resolve();};image.onerror=()=>reject(new Error('Could not read this photo. Choose PNG, JPEG, or WebP.'));image.src=source;});
 }
 for(const item of avatars){const button=document.createElement('button');button.type='button';button.dataset.avatar='builtin:'+item.id;button.className='gs-avatar-option';button.dataset.tooltip=item.label;button.setAttribute('aria-label',item.label);const img=document.createElement('img');img.src=url(button.dataset.avatar);img.alt='';img.loading='lazy';button.append(img);button.addEventListener('click',()=>{draft=button.dataset.avatar;photo=null;dirty=false;render();loadPhoto(url(draft)).catch(error=>showNotification(error.message,'error'));});$('avatar-options').append(button);}
 $('avatar-upload').addEventListener('click',()=>{if(draft||photo){version++;draft='';photo=null;dirty=false;resetTools();render();}else $('avatar-file').click();});
 $('avatar-file').addEventListener('change',async()=>{const file=$('avatar-file').files?.[0];if(!file)return;if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8*1024*1024){showNotification('Choose a PNG, JPEG, or WebP photo smaller than 8 MB.','error');$('avatar-file').value='';return;}const objectURL=URL.createObjectURL(file);$('avatar-select').disabled=true;try{await loadPhoto(objectURL,true);draft='';$('avatar-upload').textContent='Clear Photo';}catch(error){showNotification(error.message,'error');}finally{URL.revokeObjectURL(objectURL);$('avatar-file').value='';$('avatar-select').disabled=false;}});
 for(const id of ['avatar-zoom','avatar-tilt'])$(id).addEventListener('input',()=>{zoom=Number($('avatar-zoom').value);tilt=Number($('avatar-tilt').value);dirty=true;$(id).dataset.tooltip=id==='avatar-zoom'?'Zoom: '+Math.round(zoom*100)+'%':'Tilt: '+tilt+'°';if(photo)draw();});
 canvas.addEventListener('pointerdown',event=>{if(!photo)return;drag={x:event.clientX,y:event.clientY,pan:{...pan}};canvas.setPointerCapture(event.pointerId);});
 canvas.addEventListener('pointermove',event=>{if(!drag)return;const rect=canvas.getBoundingClientRect();pan={x:drag.pan.x+(event.clientX-drag.x)*256/rect.width,y:drag.pan.y+(event.clientY-drag.y)*256/rect.height};dirty=true;draw();});
 for(const event of ['pointerup','pointercancel'])canvas.addEventListener(event,()=>drag=null);
 $('avatar-select').addEventListener('click',()=>{selected=photo&&dirty?canvas.toDataURL('image/jpeg',.88):draft;dialog.close();});
 for(const id of ['avatar-close','avatar-cancel'])$(id).addEventListener('click',()=>dialog.close());
 dialog.addEventListener('close',()=>{version++;photo=null;drag=null;$('avatar-file').value='';const resolve=resolveChoice;resolveChoice=null;resolve?.(selected);});closeOnBackdropClick(dialog);
 function choose(value){if(resolveChoice)return Promise.resolve(null);selected=null;draft=value||'';photo=null;dirty=false;resetTools();version++;openModal(dialog);render();if(draft)loadPhoto(url(draft),draft.startsWith('data:')).catch(error=>showNotification(error.message,'error'));return new Promise(resolve=>resolveChoice=resolve);}
 window.GameShelfAvatars={avatars,url,choose,fallback};
})();
