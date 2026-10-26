const test=require('node:test'),assert=require('node:assert/strict');
const {fullUI}=require('./browser-fixture.cjs');

test('profile management creates personal shelves with role, library, and game choices',()=>{
 const r=fullUI(`
 await GameShelfProfiles.open();await pause();result.manager=$('profiles-dialog').open;
 $('profile-add').click();await pause();result.editor=$('profile-editor-dialog').open;
 $('profile-nickname').value='Jamie';$('profile-new-pin').value='2468';$('profile-confirm-pin').value='2468';
 $('profile-all-libraries').checked=false;$('profile-all-libraries').dispatchEvent(new Event('change'));
 const library=$('profile-library-choices').querySelector('input');library.checked=true;library.dispatchEvent(new Event('change'));
 $('profile-all-games').checked=false;$('profile-all-games').dispatchEvent(new Event('change'));
 const game=$('profile-game-choices').querySelector('input');game.checked=true;game.dispatchEvent(new Event('change'));
 $('profile-editor-save').click();await pause(150);result.saved=profileState.profiles[0];result.closed=!$('profile-editor-dialog').open;result.banner=$('notification-text').textContent;
 `,{withProfiles:true,configured:false});
 assert.equal(r.manager,true);assert.equal(r.editor,true);assert.equal(r.saved.nickname,'Jamie');assert.deepEqual(r.saved.roles,['child']);assert.deepEqual(r.saved.libraries,['library']);assert.deepEqual(r.saved.games,['game']);assert.equal(r.closed,true);assert.match(r.banner,/profile saved/i);
});
test('family roles can start with a template and customize individual permissions',()=>{
 const r=fullUI(`await GameShelfProfiles.open();$('role-add').click();result.open=$('role-editor-dialog').open;$('role-name').value='Guests';$('role-template').value='adult';$('role-template').dispatchEvent(new Event('change'));$('role-rules').querySelector('[data-action="downloads"] select').value='disable';$('role-editor-save').click();await pause();result.role=profileState.roles['new-role'];`,{withProfiles:true,configured:false});
 assert.equal(r.open,true);assert.equal(r.role.name,'Guests');assert.equal(r.role.rules.downloads.mode,'disable');
});
test('profile picker holds the library closed until a person signs in',()=>{
 const r=fullUI(`result.picker=$('profile-picker').open;result.blocked=document.body.classList.contains('gs-profile-required');result.closeHidden=$('profile-picker-close').hidden;result.catalog=requests.some(item=>item.url==='/api/games');const event=new Event('cancel',{cancelable:true});$('profile-picker').dispatchEvent(event);result.prevented=event.defaultPrevented;`,{withProfiles:true,profileNeeded:true,configured:false});
 assert.equal(r.picker,true);assert.equal(r.blocked,true);assert.equal(r.closeHidden,true);assert.equal(r.catalog,false);assert.equal(r.prevented,true);
});
test('dynamic resolution defaults and manual scale only commit after release',()=>{
 for(const [width,height,expected]of [[1920,1080,1],[2560,1440,1.25],[3840,2160,1.5],[0,0,1]]){
  const r=fullUI(`result.initial=uiScale;$('dynamic-scale').checked=false;$('dynamic-scale').dispatchEvent(new Event('change'));await pause();$('ui-scale').value='.9';$('ui-scale').dispatchEvent(new Event('input'));result.during=uiScale;$('ui-scale').dispatchEvent(new Event('change'));await pause();result.after=uiScale;`,{screenSize:[width,height]});
  assert.equal(r.initial,expected);assert.equal(r.during,expected);assert.equal(r.after,.9);
 }
});
test('compact settings retain helpful themed descriptions and align art tools to the image',()=>{
 const r=fullUI(`$('build-info').click();await pause();$('settings-advanced').click();await pause();result.descriptors=document.querySelectorAll('#settings-dialog .gs-settings-option small,#settings-dialog .gs-settings-backup small').length;result.themeHint=$('theme-select').closest('label').querySelector('strong').dataset.tooltip;document.querySelector('.gs-card-info').click();$('edit-game-cover').click();await pause();const image=$('cover-preview').getBoundingClientRect(),sliders=document.querySelector('.gs-cover-sliders').getBoundingClientRect();result.bounded=sliders.left>=image.left-1&&sliders.right<=image.right+1;result.title=$('cover-editor-title').textContent;result.ellipsis=getComputedStyle($('cover-editor-title')).textOverflow;result.fileTooltip=$('restore-browse').dataset.tooltip||'';result.fileCursor=getComputedStyle($('restore-file-name')).cursor;`);
 assert.equal(r.descriptors,0);assert.match(r.themeHint,/device/);assert.equal(r.bounded,true);assert.equal(r.title,'Family Game');assert.equal(r.ellipsis,'ellipsis');assert.equal(r.fileTooltip,'');assert.equal(r.fileCursor,'default');
});
test('Family Controls show a dedicated PIN submenu and prevent PIN policies without a PIN',()=>{
 const r=fullUI(`$('build-info').click();$('settings-advanced').click();$('open-family-controls').click();await pause();result.fieldsHidden=!$('family-dialog').contains($('family-new-pin'));result.admin=document.querySelector('[data-action="admin"] select').value;document.querySelector('[data-action="theme"] select').value='pin';$('family-save').click();await pause();result.banner=$('notification-text').textContent;result.inline=$('family-status').textContent;result.open=$('family-dialog').open;$('family-open-pin').click();await pause();result.submenu=$('family-pin-dialog').open;`,{configured:false});
 assert.equal(r.fieldsHidden,true);assert.equal(r.admin,'allow');assert.match(r.banner,/no PIN has been set/);assert.equal(r.inline,'');assert.equal(r.open,true);assert.equal(r.submenu,true);
});
test('required Settings and Advanced gates are authorized together for the open menu',()=>{
 const r=fullUI(`settingsLevel='advanced';$('build-info').click();await pause();result.title=$('pin-title').textContent;$('pin-entry').value='7392';$('pin-form').dispatchEvent(new Event('submit',{cancelable:true}));await pause(150);result.settings=$('settings-dialog').open;result.prompt=!$('pin-dialog').open;const inputs=requests.filter(x=>x.url==='/api/access/unlock').map(x=>JSON.parse(x.body));result.actions=inputs[0].actions;$('show-game-titles').click();await pause();result.noPrompt=!$('pin-dialog').open;result.unlocks=requests.filter(x=>x.url==='/api/access/unlock').length;`,{rules:{settings:{mode:'pin'},advanced:{mode:'pin'}}});
 assert.equal(r.title,'PIN Required');assert.equal(r.settings,true);assert.equal(r.prompt,true);assert.ok(r.actions.includes('settings')&&r.actions.includes('advanced'));assert.equal(r.noPrompt,true);assert.equal(r.unlocks,1);
});
