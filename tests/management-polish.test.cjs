const {test}=require('node:test'),assert=require('node:assert/strict');
const {fullUI}=require('./browser-fixture.cjs');
const wait=`const until=async(check,label)=>{const end=performance.now()+2500;while(!check()){if(performance.now()>end)throw Error('Timed out: '+label);await pause(20);}};`;

test('Family Controls routes to profiles when enabled and retains legacy controls when disabled',()=>{
 for(const enabled of [true,false]){
  const r=fullUI(`${wait}await GameShelfAccess.openFamily();await until(()=>$('${enabled?'profiles':'family'}-dialog').open,'management window');result.profiles=$('profiles-dialog').open;result.legacy=$('family-dialog').open;`,{configured:false,withProfiles:true,profilesEnabled:enabled,live:true});
  assert.equal(r.profiles,enabled);assert.equal(r.legacy,!enabled);
 }
});

test('Guardian management shortcuts appear together in Basic settings and Game Over content is centered',()=>{
 const r=fullUI(`${wait}accessState.guardianProfile=true;accessState.policy.rules.admin={mode:'guardian',level:'advanced'};accessState.policy.rules.libraryManager={mode:'allow',level:'advanced'};await GameShelfAccess.refresh();$('build-info').click();await until(()=>$('settings-dialog').open,'Settings');$('settings-basic').click();const a=$('open-family-controls').closest('.gs-settings-backup'),b=$('open-library-manager').closest('.gs-settings-backup');result.dependencies=GameShelfAccess.actionsFor('libraryManager');result.basic=[a,b].every(row=>getComputedStyle(row).display!=='none');result.same=a.parentElement===b.parentElement&&a.parentElement.id==='settings-management';$('settings-advanced').click();await until(()=>$('settings-dialog').dataset.settingsLevel==='advanced','Advanced settings');const field=document.querySelector('.gs-game-over'),row=field.querySelector('.gs-settings-backup'),name=row.querySelector('strong').getBoundingClientRect(),button=$('open-reset-settings').getBoundingClientRect();const box=field.getBoundingClientRect(),legend=field.querySelector('legend').getBoundingClientRect();result.visible=box.height>0;result.boxCenter=Math.abs((button.top+button.bottom)/2-((legend.top+legend.bottom)/2+box.bottom)/2);result.center=Math.abs((name.top+name.bottom)/2-(button.top+button.bottom)/2);`,{configured:false,live:true});
 assert.equal(r.basic,true);assert.equal(r.dependencies.includes('advanced'),false);assert.equal(r.dependencies.includes('settings'),true);assert.equal(r.same,true);assert.equal(r.visible,true);assert.ok(r.boxCenter<2,JSON.stringify(r));assert.ok(r.center<2,JSON.stringify(r));
});

test('role editor persists Access, Category, Show, and color with consistent card icons',()=>{
 const r=fullUI(`${wait}await GameShelfProfiles.open();$('roles-list').querySelectorAll('button')[1].click();const row=$('role-rules').querySelector('[data-action="theme"]');row.querySelector('.gs-role-mode').value='pin';row.querySelector('.gs-role-level').value='advanced';row.querySelector('.gs-role-visible').checked=false;$('role-color').value='#c052bb';$('role-color').dispatchEvent(new Event('input'));$('role-editor-save').click();await until(()=>!$('role-editor-dialog').open,'role saved');result.saved=profileState.roles.adult;const card=$('roles-list').querySelector('[data-role-id="adult"]').closest('article');result.color=getComputedStyle(card.querySelector('[data-role-id]')).color;result.edit=!!card.querySelector('[aria-label="Edit Adult"] svg');$('roles-list').querySelectorAll('button')[1].click();const reopened=$('role-rules').querySelector('[data-action="theme"]');result.reopened=[reopened.querySelector('.gs-role-level').value,reopened.querySelector('.gs-role-visible').checked];`,{withProfiles:true,configured:false,live:true});
 assert.deepEqual(r.saved.rules.theme,{mode:'pin',hidden:true,level:'advanced'});assert.equal(r.saved.color,'#c052bb');assert.equal(r.color,'rgb(192, 82, 187)');assert.equal(r.edit,true);assert.deepEqual(r.reopened,['advanced',false]);
});

test('group selection stays in place and uses its saved color, with fixed Guardian branding',()=>{
 const r=fullUI(`${wait}profileState.profiles=[{id:'one',nickname:'One',groups:['g-children'],roles:[],avatar:'builtin:cosmic-fox'},{id:'two',nickname:'Two',groups:[],roles:['child'],avatar:'builtin:moonlit-knight'}];await GameShelfProfiles.open();$('groups-list').querySelectorAll('button')[2].click();const rows=[...$('group-member-choices').children],tile=rows[1];result.before=[tile.getBoundingClientRect().top,tile.getBoundingClientRect().left];tile.querySelector('input').click();result.after=[tile.getBoundingClientRect().top,tile.getBoundingClientRect().left];$('group-color').value='#bb66dd';$('group-color').dispatchEvent(new Event('input'));result.border=getComputedStyle(tile).borderTopColor;result.summary=$('group-members-summary').textContent;$('group-editor-save').click();await until(()=>!$('group-editor-dialog').open,'group saved');result.saved=profileState.profileGroups['g-children'];result.members=profileState.profiles.map(p=>p.groups);$('groups-list').querySelector('button').click();result.fixed=$('group-color').disabled;`,{withProfiles:true,configured:false,live:true});
 assert.deepEqual(r.before,r.after);assert.equal(r.border,'rgb(187, 102, 221)');assert.equal(r.summary,'2 of 2 profiles selected');assert.equal(r.saved.color,'#bb66dd');assert.deepEqual(r.members,[['g-children'],['g-children']]);assert.equal(r.fixed,true);
});

test('health uses leading status explanations and a header refresh icon, and Sources sizes to content',()=>{
 const r=fullUI(`${wait}$('build-info').click();$('open-library-health').click();await until(()=>$('health-sources').children.length>0,'health sources');const heading=$('health-sources').querySelector('.gs-health-source-heading'),indicator=heading.firstElementChild;result.leading=indicator.classList.contains('gs-health-indicator');result.help=indicator.dataset.tooltip;result.legend=!!document.querySelector('.gs-health-legend');result.header=$('health-check').closest('.gs-settings-header')===$('health-close').closest('.gs-settings-header');result.icon=!!$('health-check').querySelector('svg');$('health-check').click();await until(()=>checks===1,'refresh');result.checks=checks;$('health-close').click();await until(()=>!$('health-dialog').open,'close health');$('open-server-settings').click();await until(()=>$('server-settings-dialog').open,'sources');await pause(350);result.height=$('server-settings-dialog').getBoundingClientRect().height;`,{configured:false,live:true,height:1800});
 assert.equal(r.leading,true);assert.match(r.help,/Healthy, no issues/);assert.equal(r.legend,false);assert.equal(r.header,true);assert.equal(r.icon,true);assert.equal(r.checks,1);assert.ok(r.height<700,JSON.stringify(r));
});

test('checkout preserves addition order and opens at the newest item',()=>{
 const r=fullUI(`${wait}gamesCache=Array.from({length:30},(_,i)=>({id:'g'+i,name:'Game '+i,sizeBytes:100,hasCover:false}));cartGameIds.clear();for(const game of [...gamesCache].reverse())cartGameIds.add(game.id);$('open-cart').click();const list=$('cart-items');result.last=list.lastElementChild.querySelector('.gs-playlist-game-name').textContent;result.bottom=list.scrollHeight-list.clientHeight-list.scrollTop;list.scrollTop=0;$('cart-close').click();await until(()=>!$('cart-dialog').open,'checkout close');$('open-cart').click();result.reopened=list.scrollHeight-list.clientHeight-list.scrollTop;`,{configured:false,live:true});
 assert.match(r.last,/Game 0 /);assert.ok(r.bottom<=1,JSON.stringify(r));assert.ok(r.reopened<=1,JSON.stringify(r));
});

test('health header refresh retains Guardian approval before starting a check',()=>{
 const r=fullUI(`${wait}openModal($('health-dialog'));$('health-check').click();await until(()=>$('pin-dialog').open,'refresh approval');result.prompt=$('pin-dialog').open;result.before=checks;$('pin-cancel').click();await until(()=>!$('pin-dialog').open,'cancelled refresh');result.after=checks;`,{configured:true,live:true,rules:{healthView:{mode:'guardian'}}});
 assert.equal(r.prompt,true);assert.equal(r.before,0);assert.equal(r.after,0);
});

test('banner remains at the top of a long library on desktop and mobile at different scales',()=>{
 for(const [width,scale] of [[1280,1],[390,1.25]]){
  const r=fullUI(`${wait}uiScale=${scale};applyUIScale();const spacer=document.createElement('div');spacer.style.height='4000px';document.querySelector('.gs-main').append(spacer);window.scrollTo(0,1000);await pause(100);const header=document.querySelector('.gs-header').getBoundingClientRect();result.scrolled=window.scrollY;result.top=header.top;result.bottom=header.bottom;result.search=$('search-input').getBoundingClientRect().top;`,{configured:false,live:true,width,height:900});
  assert.ok(r.scrolled>500,JSON.stringify(r));assert.ok(Math.abs(r.top)<1,JSON.stringify(r));assert.ok(r.bottom<450,JSON.stringify(r));assert.ok(r.search>=0,JSON.stringify(r));
 }
});
