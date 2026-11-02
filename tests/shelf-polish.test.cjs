const {test}=require('node:test'),assert=require('node:assert/strict');
const {fullUI}=require('./browser-fixture.cjs');

test('group role tiles switch back to Child after Adult approval and show only assigned members',()=>{
 const r=fullUI(`
 profileState.profiles=[{id:'kid',nickname:'Jamie',roles:[],groups:['g-children'],pinRequired:true}];
 await GameShelfProfiles.open();$('groups-list').querySelectorAll('button')[2].click();await pause(250);
 const clickTile=value=>{const row=$('group-role-choices').querySelector('input[value="'+value+'"]').closest('label'),box=row.getBoundingClientRect();row.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1,clientX:box.left+8,clientY:box.top+8}));};
 clickTile('adult');result.prompt=$('group-admin-dialog').open;$('group-admin-confirm').click();await pause(200);clickTile('child');
 result.role=$('group-role-choices').querySelector('input:checked')?.value;result.ack=$('group-admin-ack').checked;result.members=[...$('group-member-choices').querySelectorAll('input')].map(n=>n.value);
 $('group-editor-cancel').click();await pause(200);$('groups-list').querySelectorAll('button')[1].click();
 result.adults=$('group-member-choices').children.length;result.available=$('group-available-choices').querySelector('input').value;
 $('group-available-choices').querySelector('input').click();result.added=$('group-member-choices').querySelector('input')?.checked;
 $('group-member-choices').querySelector('input').click();result.removed=$('group-member-choices').children.length;result.original=profileState.profiles[0].groups;
 `,{withProfiles:true,configured:false,live:true});
 assert.equal(r.prompt,true);assert.equal(r.role,'child');assert.equal(r.ack,false);assert.deepEqual(r.members,['kid']);
 assert.equal(r.adults,0);assert.equal(r.available,'kid');assert.equal(r.added,true);assert.equal(r.removed,0);assert.deepEqual(r.original,['g-children']);
});

test('first favorite offers ordering once, keeps the initial order, and remembers accepting or declining',()=>{
 for(const accept of [false,true]){
 const r=fullUI(`
 const game=gamesCache[0];result.default=favoritesFirst;const prior=window.fetch;window.fetch=(url,options)=>url.startsWith('/api/favorite/')?Promise.resolve(new Response('{}')):prior(url,options);
 openFavoriteConfirm(game);await pause(100);result.offer=$('favorite-order-dialog').open;result.saved=game.favorite;
 $('favorite-order-${accept?'pin':'keep'}').click();await pause(200);result.order=favoritesFirst;result.checked=$('favorites-first').checked;result.remembered=localStorage.getItem('gameshelf:favorites-order-decided');
 game.favorite=false;openFavoriteConfirm(game);await pause(100);result.repeated=$('favorite-order-dialog').open;
 `,{configured:false,live:true});
 assert.equal(r.default,false);assert.equal(r.offer,true);assert.equal(r.saved,true);assert.equal(r.order,accept);assert.equal(r.checked,accept);assert.equal(r.remembered,'true');assert.equal(r.repeated,false);
 }
});

test('favorite ordering offer respects disabled preferences',()=>{
 const r=fullUI(`const game=gamesCache[0],prior=window.fetch;window.fetch=(url,options)=>url.startsWith('/api/favorite/')?Promise.resolve(new Response('{}')):prior(url,options);openFavoriteConfirm(game);await pause(120);result.offer=$('favorite-order-dialog').open;result.order=favoritesFirst;result.saved=game.favorite;`,{configured:false,live:true,rules:{favoritesFirst:{mode:'disable'}}});
 assert.equal(r.offer,false);assert.equal(r.order,false);assert.equal(r.saved,true);
});

test('accepting first-favorite ordering still requires the configured Guardian approval',()=>{
 const r=fullUI(`const game=gamesCache[0],prior=window.fetch;window.fetch=(url,options)=>url.startsWith('/api/favorite/')?Promise.resolve(new Response('{}')):prior(url,options);openFavoriteConfirm(game);await pause(120);result.offer=$('favorite-order-dialog').open;result.before=$('pin-dialog').open;$('favorite-order-pin').click();await pause(120);result.approval=$('pin-dialog').open;result.order=favoritesFirst;`,{configured:true,live:true,rules:{favoritesFirst:{mode:'guardian'}}});
 assert.equal(r.offer,true);assert.equal(r.before,false);assert.equal(r.approval,true);assert.equal(r.order,false);
});

test('playlist checkout renders covers, placeholders, and text in separate columns',()=>{
 const r=fullUI(`cartGameIds.add(gamesCache[0].id);renderCart();const row=$('cart-items').firstElementChild;result.image=row.firstElementChild.querySelector('img').getAttribute('src');result.name=row.querySelector('.gs-playlist-game-name').textContent;result.remove=row.lastElementChild.textContent;result.coverBeforeText=row.firstElementChild.getBoundingClientRect().right<=row.querySelector('.gs-playlist-game-name').getBoundingClientRect().left;gamesCache[0].hasCover=true;renderCart();result.real=$('cart-items').querySelector('img').getAttribute('src');`,{configured:false,live:true});
 assert.equal(r.image,'/placeholder.png');assert.match(r.name,/Family Game/);assert.equal(r.remove,'Remove');assert.equal(r.coverBeforeText,true);assert.equal(r.real,'/covers/game');
});

test('nested menus stay centered after content changes, submenu closure, and reopening at different scales',()=>{
 for(const [width,scale] of [[1280,.75],[1280,1.5],[390,1.25]]){
 const r=fullUI(`uiScale=${scale};applyUIScale();await GameShelfProfiles.open();$('groups-list').querySelectorAll('button')[2].click();await pause(320);
 const centered=()=>{const box=$('group-editor-dialog').getBoundingClientRect();return {offset:Math.abs((box.top+box.bottom)/2-innerHeight/2),top:box.top,bottom:box.bottom};};
 result.before=centered();$('group-library-policy').value='selected';$('group-library-policy').dispatchEvent(new Event('change'));await pause(400);result.resized=centered();
 $('group-role-choices').querySelector('input[value="adult"]').click();await pause(250);const sub=$('group-admin-dialog').getBoundingClientRect();result.sub=Math.abs((sub.top+sub.bottom)/2-innerHeight/2);$('group-admin-confirm').click();await pause(300);result.after=centered();
 $('group-editor-cancel').click();await pause(200);$('groups-list').querySelectorAll('button')[1].click();await pause(320);result.reopened=centered();
 `,{withProfiles:true,configured:false,live:true,width,height:900,motion:1.1});
 for(const value of [r.before,r.resized,r.after,r.reopened]){assert.ok(value.offset<3,JSON.stringify({width,scale,r}));assert.ok(value.top>=0&&value.bottom<=900,JSON.stringify(r));}assert.ok(r.sub<3,JSON.stringify(r));
 }
});

test('photo swaps fade without a blank preview and Guardian cards keep their portrait and caption inside the border',()=>{
 const r=fullUI(`await GameShelfProfiles.open();$('profile-add').click();await pause();$('profile-photo').click();await pause();$('avatar-options').querySelector('[data-avatar="builtin:moonlit-knight"]').click();for(let n=0;n<80&&$('avatar-select').disabled;n++)await pause(20);
 $('avatar-options').querySelector('[data-avatar="builtin:neon-racer"]').click();result.blank=$('avatar-canvas').hidden;let faded=false;for(let n=0;n<80;n++){if(document.querySelector('.gs-avatar-crossfade'))faded=true;if(!$('avatar-select').disabled)break;await pause(10);}result.fade=faded;await Promise.race([Promise.all([...document.querySelectorAll('.gs-avatar-crossfade')].flatMap(node=>node.getAnimations()).map(animation=>animation.finished)),pause(2000)]);await pause(20);result.cleaned=!document.querySelector('.gs-avatar-crossfade');
 $('avatar-cancel').click();await pause(200);$('profile-editor-cancel').click();await pause(200);
 profileState.guardians=[{id:'guardian-1',name:'Pat'}];profileState.profiles=[{id:'g',nickname:'Pat',avatar:'builtin:ember-knight',roles:['administrator'],groups:['g-guardians'],usesGuardianPIN:true,guardianID:'guardian-1'}];$('profiles-pin').click();await pause(300);
 const card=$('guardians-profiles').querySelector('button'),box=card.getBoundingClientRect(),image=card.querySelector('img').getBoundingClientRect(),caption=card.querySelector('.gs-profile-caption').getBoundingClientRect();result.contained=image.left>=box.left&&image.right<=box.right&&caption.bottom<=box.bottom;result.shield=!!$('profiles-pin').querySelector('svg');
 `,{withProfiles:true,configured:false,live:true,motion:1.1});
 assert.equal(r.blank,false);assert.equal(r.fade,true,'photo should fade');assert.equal(r.cleaned,true,'finished overlay should be removed');assert.equal(r.contained,true,'portrait must stay in the card');assert.equal(r.shield,true);
});
