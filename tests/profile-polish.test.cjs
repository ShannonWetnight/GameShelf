const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fullUI}=require('./browser-fixture.cjs');

test('fresh setup configures profiles and creates a Guardian PIN without stacked Controls or another unlock',()=>{
 const r=fullUI(`$('setup-next').click();$('setup-family-profiles').click();await pause();result.manager=$('profiles-dialog').open;result.prompt=$('pin-dialog').open;$('profiles-enabled').click();await pause();result.creation=$('family-pin-dialog').open;result.controls=$('family-dialog').open;$('family-new-pin').value='7392';$('family-confirm-pin').value='7392';$('family-pin-save').click();await pause(240);result.staged=$('profiles-enabled').checked;result.pending=!$('profiles-save').disabled;result.enabled=profileState.enabled;result.noRepeat=!$('pin-dialog').open;result.unlocks=requests.filter(r=>r.url==='/api/access/unlock').length;`,{configured:false,setup:true,withProfiles:true,profilesEnabled:false,live:true});
 assert.equal(r.manager,true);assert.equal(r.prompt,false);assert.equal(r.creation,true);assert.equal(r.controls,false);assert.equal(r.enabled,false);assert.equal(r.staged,true);assert.equal(r.pending,true);assert.equal(r.noRepeat,true);assert.equal(r.unlocks,1);
});
test('resumed setup still requires an existing Guardian PIN to manage profiles',()=>{
 const r=fullUI(`$('setup-next').click();$('setup-family-profiles').click();await pause();result.prompt=$('pin-dialog').open;result.manager=$('profiles-dialog').open;`,{configured:true,setup:true,withProfiles:true});
 assert.equal(r.prompt,true);assert.equal(r.manager,false);
});
test('Guardian PIN entry from Profiles opens only the PIN Settings submenu',()=>{
 const r=fullUI(`await GameShelfProfiles.open();$('profiles-pin').click();await pause();result.pin=$('family-pin-dialog').open;result.controls=$('family-dialog').open;result.minutes=getComputedStyle($('family-remember-minutes')).textAlign;`,{configured:false,withProfiles:true});
 assert.equal(r.pin,true);assert.equal(r.controls,false);assert.equal(r.minutes,'center');
});
test('profile tiles are square and selection uses the shared PIN dialog with cancellation back to the picker',()=>{
 const r=fullUI(`profileState.enabled=true;profileState.profiles=[{id:'a',nickname:'Jamie',roles:['child'],avatar:'builtin:star-pilot'},{id:'b',nickname:'Riley',roles:['adult'],avatar:'builtin:cosmic-fox'}];await GameShelfProfiles.initialize();await pause();const tile=$('profile-picker-list').querySelector('button'),rect=tile.getBoundingClientRect(),list=$('profile-picker-list').getBoundingClientRect(),footer=document.querySelector('.gs-profile-picker-footer').getBoundingClientRect();result.square=Math.abs(rect.width-rect.height)<2;result.edges=Math.abs(rect.left-footer.left)<2&&Math.abs($('profile-picker-list').lastElementChild.getBoundingClientRect().right-footer.right)<2;result.photo=tile.querySelector('img').src.includes('star-pilot');tile.click();await pause();result.title=$('pin-title').textContent;result.label=$('pin-entry').getAttribute('aria-label');result.picker=$('profile-picker').open;result.search=!!$('profile-search');$('pin-cancel').click();await pause();result.cancelled=!$('pin-dialog').open&&$('profile-picker').open;`,{withProfiles:true,configured:false,profileNeeded:true});
 assert.equal(r.square,true);assert.equal(r.edges,true);assert.equal(r.photo,true);assert.equal(r.title,'PIN Required');assert.equal(r.label,'PIN for Jamie');assert.equal(r.picker,true);assert.equal(r.search,false);assert.equal(r.cancelled,true);
});
test('all 25 built-ins are selectable and saved as a profile photo',()=>{
 const r=fullUI(`await GameShelfProfiles.open();$('profile-add').click();await pause();$('profile-photo').click();await pause();result.count=$('avatar-options').children.length;const option=$('avatar-options').querySelector('[data-avatar="builtin:cosmic-fox"]');option.click();$('avatar-select').click();await pause(200);result.preview=$('profile-photo-image').src.includes('cosmic-fox');$('profile-nickname').value='Fox';$('profile-new-pin').value='2468';$('profile-confirm-pin').value='2468';$('profile-editor-save').click();await pause(160);result.avatar=profileState.profiles[0].avatar;`,{withProfiles:true,configured:false,live:true});
 assert.equal(r.count,25);assert.equal(r.preview,true);assert.equal(r.avatar,'builtin:cosmic-fox');
});
test('uploading a rectangular photo provides a square crop and cancellation preserves the profile',()=>{
 const r=fullUI(`await GameShelfProfiles.open();$('profile-add').click();await pause();$('profile-photo').click();await pause();const source=document.createElement('canvas');source.width=400;source.height=200;source.getContext('2d').fillRect(0,0,400,200);const blob=await new Promise(resolve=>source.toBlob(resolve,'image/png')),files=new DataTransfer();files.items.add(new File([blob],'photo.png',{type:'image/png'}));$('avatar-file').files=files.files;$('avatar-file').dispatchEvent(new Event('change'));await pause(170);result.crop=!$('avatar-canvas').hidden;result.width=$('avatar-canvas').width;result.height=$('avatar-canvas').height;$('avatar-zoom').value='2';$('avatar-zoom').dispatchEvent(new Event('input'));$('avatar-select').click();await pause(200);result.upload=$('profile-photo-image').src.startsWith('data:image/jpeg;base64,');const selected=$('profile-photo-image').src;$('profile-photo').click();await pause();$('avatar-options').firstElementChild.click();$('avatar-cancel').click();await pause(200);result.preserved=selected===$('profile-photo-image').src;`,{withProfiles:true,configured:false,live:true});
 assert.equal(r.crop,true);assert.equal(r.width,256);assert.equal(r.height,256);assert.equal(r.upload,true);assert.equal(r.preserved,true);
});
test('role labels offer specific help without selecting their dropdowns and selections center',()=>{
 const r=fullUI(`await GameShelfProfiles.open();$('role-add').click();await pause();const row=$('role-rules').querySelector('[data-action="downloads"]'),name=row.querySelector('span'),select=row.querySelector('select');name.click();result.hint=name.dataset.tooltip;result.unfocused=document.activeElement!==select;result.noMenu=!$('gs-select-menu').matches(':popover-open');result.align=getComputedStyle(select).textAlignLast;result.template=getComputedStyle($('role-template')).textAlignLast;`,{withProfiles:true,configured:false,live:true});
 assert.match(r.hint,/download|ZIP/i);assert.equal(r.unfocused,true);assert.equal(r.noMenu,true);assert.equal(r.align,'center');assert.equal(r.template,'center');
});
test('setup expansion stays within the viewport at desktop and mobile scales',()=>{
 for(const [width,height,screenSize]of [[1920,1080,[1920,1080]],[2560,1440,[2560,1440]],[390,844,[390,844]]]){
 const r=fullUI(`$('setup-next').click();await pause(280);document.querySelector('#setup-finish-panel details').open=true;await pause(380);for(let n=0;n<40&&$('setup-form').classList.contains('gs-resizing');n++)await pause(40);const stage=$('setup-page').getBoundingClientRect(),form=$('setup-form').getBoundingClientRect();result.viewport=innerHeight;result.bottom=stage.bottom;result.formBottom=form.bottom;result.outer=document.documentElement.scrollHeight<=innerHeight+2;result.inner=getComputedStyle($('setup-form')).overflowY;document.querySelector('#setup-finish-panel details').open=false;await pause(380);result.after=document.documentElement.scrollHeight<=innerHeight+2;`,{setup:true,configured:false,width,height,screenSize,motion:1.1,live:true});
 assert.equal(r.outer,true,JSON.stringify({width,r}));assert.equal(r.after,true,JSON.stringify({width,r}));assert.ok(r.bottom<=r.viewport+2,JSON.stringify({width,r}));assert.equal(r.inner,'auto');
 }
});
test('dropdown animation timing stays stable, ends in whole rows and hides smoothly after a choice',()=>{
 const r=fullUI(`$('setup-next').click();await pause(300);GameShelfSelect.open($('setup-theme'));await pause(40);const menu=$('gs-select-menu'),animation=menu.getAnimations().find(a=>a.id==='gs-dropdown');result.start=animation.effect.getTiming().duration;applyMotionSpeed();result.end=animation.effect.getTiming().duration;await pause(250);const row=menu.firstElementChild.getBoundingClientRect().height,rect=menu.getBoundingClientRect();result.rows=(rect.height-uiScale)/row;menu.children[2].click();await pause(50);result.closing=menu.matches(':popover-open');await pause(250);result.closed=!menu.matches(':popover-open');result.rounded=getComputedStyle($('setup-theme')).borderBottomLeftRadius;`,{setup:true,configured:false,motion:1.1,live:true});
 assert.equal(r.start,r.end);assert.ok(Math.abs(r.rows-Math.round(r.rows))<.02,JSON.stringify(r));assert.equal(r.closing,true);assert.equal(r.closed,true);assert.notEqual(r.rounded,'0px');
});
test('ordinary password placeholders retain normal spacing and error symbols are centered SVGs',()=>{
 const r=fullUI(`$('setup-add-network').click();await pause();result.spacing=getComputedStyle($('network-password'),'::placeholder').letterSpacing;showNotification('An error message spanning multiple lines to verify the marker remains centered with the message.','error');const box=document.querySelector('.gs-notification-check').getBoundingClientRect(),svg=document.querySelector('.gs-notification-check svg').getBoundingClientRect();result.x=Math.abs(box.left+box.width/2-svg.left-svg.width/2);result.y=Math.abs(box.top+box.height/2-svg.top-svg.height/2);`,{setup:true,configured:false});
 assert.equal(r.spacing,'normal');assert.ok(r.x<.1&&r.y<.1,JSON.stringify(r));
});
test('built-in profile artwork ships as exactly 25 compact square WebP assets',()=>{
 const dir=path.join(__dirname,'../web/profile-avatars'),files=fs.readdirSync(dir).filter(n=>n.endsWith('.webp'));assert.equal(files.length,25);assert.ok(files.reduce((sum,name)=>sum+fs.statSync(path.join(dir,name)).size,0)<1024*1024);
});

test('Require PIN expands its fields and administrative roles enforce it',()=>{
 const r=fullUI(`await GameShelfProfiles.open();$('profile-add').click();await pause(250);const checkbox=$('profile-require-pin');result.optional=!checkbox.disabled;checkbox.click();await pause(300);result.collapsed=$('profile-pin-fields').getBoundingClientRect().height<2;result.inert=$('profile-pin-fields').inert;$('profile-role-choices').querySelector('[value="adult"]').click();await pause(300);result.forced=checkbox.checked&&checkbox.disabled;$('profile-role-choices').querySelector('[value="child"]').click();await pause(300);result.expanded=$('profile-pin-fields').getBoundingClientRect().height>50;result.adultOnly=checkbox.checked&&checkbox.disabled;`,{withProfiles:true,configured:false,motion:1.1,live:true});
 assert.equal(r.optional,true);assert.equal(r.collapsed,true);assert.equal(r.inert,true);assert.equal(r.forced,false); // Child restrictions still win while both roles are assigned.
 assert.equal(r.adultOnly,true);assert.equal(r.expanded,true);
});
test('a non-administrative profile can be saved without creating a PIN',()=>{
 const r=fullUI(`await GameShelfProfiles.open();$('profile-add').click();await pause();$('profile-nickname').value='Open Shelf';$('profile-require-pin').click();$('profile-editor-save').click();await pause(180);result.profile=profileState.profiles[0];result.body=JSON.parse(requests.filter(r=>r.url==='/api/profiles'&&r.method==='POST').at(-1).body);`,{withProfiles:true,configured:false,live:true});
 assert.equal(r.profile.pinRequired,false);assert.equal(r.body.pin,'');assert.equal(r.body.confirmPIN,'');
});
test('an open profile starts its session directly without showing the PIN prompt',()=>{
 const r=fullUI(`profileState.enabled=true;profileState.profiles=[{id:'open',nickname:'Open Shelf',roles:['child'],pinRequired:false}];await GameShelfProfiles.initialize();const previous=window.fetch;window.fetch=(url,options)=>{if(url==='/api/profiles/login'){window.loginAttempt=JSON.parse(options.body);return new Promise(()=>{});}return previous(url,options);};$('profile-picker-list').querySelector('button').click();await pause();result.login=window.loginAttempt;result.prompt=$('pin-dialog').open;`,{withProfiles:true,configured:false,profileNeeded:true});
 assert.deepEqual(r.login,{id:'open',pin:''});assert.equal(r.prompt,false);
});
test('narrow profile tiles keep square photos and visible nicknames at every UI scale',()=>{
 const r=fullUI(`profileState.enabled=true;profileState.profiles=[{id:'a',nickname:'Jamie',roles:['child']},{id:'b',nickname:'Riley',roles:['adult']}];await GameShelfProfiles.initialize();result.sizes=[];for(const scale of [.75,1,1.5]){uiScale=scale;applyUIScale();await pause(280);const tile=$('profile-picker-list').querySelector('button'),box=tile.getBoundingClientRect(),photo=tile.querySelector('img').getBoundingClientRect(),name=tile.querySelector('span').getBoundingClientRect();result.sizes.push({scale,square:Math.abs(photo.width-photo.height)<1,visible:name.height>10&&name.top>=box.top&&name.bottom<=box.bottom,card:Math.abs(box.width-box.height)<1});}`,{withProfiles:true,configured:false,profileNeeded:true,width:390,live:true});
 assert.ok(r.sizes.every(s=>s.square&&s.visible&&s.card),JSON.stringify(r));
});
