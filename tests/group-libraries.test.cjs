const {test}=require('node:test'),assert=require('node:assert/strict');
const {fullUI}=require('./browser-fixture.cjs');

test('group library selection saves, reopens, and resets without changing membership',()=>{
 const r=fullUI(`
 await GameShelfProfiles.open();$('groups-list').querySelectorAll('button')[2].click();
 $('group-library-policy').value='selected';$('group-library-policy').dispatchEvent(new Event('change'));
 const library=$('group-library-choices').querySelector('input');library.checked=true;library.dispatchEvent(new Event('change'));
 result.resetAvailable=!$('group-reset').inert;$('group-editor-save').click();await pause(180);
 result.saved=profileState.profileGroups['g-children'];$('groups-list').querySelectorAll('button')[2].click();
 result.reopened=$('group-library-choices').querySelector('input').checked;result.policy=$('group-library-policy').value;
 $('group-reset').click();$('profile-remove-confirm').click();await pause(180);
 result.reset=profileState.profileGroups['g-children'];result.resetPolicy=$('group-library-policy').value;
 `,{withProfiles:true,configured:false,live:true});
 assert.equal(r.resetAvailable,true);assert.equal(r.reopened,true);assert.equal(r.policy,'selected');
 assert.equal(r.saved.libraryPolicy,'selected');assert.deepEqual(r.saved.libraries,['library']);
 assert.equal(r.reset.libraryPolicy,undefined);assert.equal(r.resetPolicy,'');
});

test('inherited library previews combine groups and keep individual and game exceptions',()=>{
 const r=fullUI(`
 profileState.libraries.push({id:'secret',name:'Private Games',location:'/private'});
 profileState.profileGroups['g-children'].libraryPolicy='selected';profileState.profileGroups['g-children'].libraries=['library'];
 profileState.profileGroups['g-adults'].libraryPolicy='selected';profileState.profileGroups['g-adults'].libraries=['secret'];
 profileState.profiles=[{id:'p',nickname:'Jamie',roles:null,groups:['g-children','g-adults'],allowMultipleRoles:true,pinRequired:true,allLibraries:false,libraries:['library'],allGames:false,games:['game'],inheritLibraries:true}];
 await GameShelfProfiles.open();$('profiles-list').querySelector('[aria-label="Edit Jamie"]').click();await pause();
 result.summary=$('profile-library-summary').textContent;result.checked=$('profile-inherit-libraries').checked;
 result.game=$('profile-game-choices').querySelector('input').checked;
 const group=$('profile-group-choices').querySelector('input[value="g-children"]');group.checked=false;group.dispatchEvent(new Event('change',{bubbles:true}));
 result.empty=$('profile-library-summary').textContent;result.noGames=!$('profile-game-choices').querySelector('input');
 group.checked=true;group.dispatchEvent(new Event('change',{bubbles:true}));$('profile-editor-save').click();await pause(180);
 result.saved=profileState.profiles[0];
 `,{withProfiles:true,configured:false,live:true});
 assert.equal(r.checked,true);assert.match(r.summary,/Home Games/);assert.doesNotMatch(r.summary,/Private Games/);
 assert.equal(r.game,true);assert.match(r.empty,/No libraries/);assert.equal(r.noGames,true);
 assert.equal(r.saved.inheritLibraries,true);assert.equal(r.saved.allLibraries,false);assert.deepEqual(r.saved.libraries,['library']);assert.deepEqual(r.saved.games,['game']);
});

test('existing individual assignments and Guardian access stay explicit',()=>{
 const r=fullUI(`
 profileState.profiles=[{id:'p',nickname:'Jamie',roles:['child'],groups:['g-children'],pinRequired:true,allLibraries:false,libraries:['library'],allGames:true},{id:'g',nickname:'Pat',roles:['administrator'],groups:['g-guardians'],usesGuardianPIN:true,guardianID:'guardian-1',pinRequired:true,allLibraries:true,allGames:true}];
 await GameShelfProfiles.open();$('profiles-list').querySelector('[aria-label="Edit Jamie"]').click();await pause();result.legacy=$('profile-inherit-libraries').checked;$('profile-editor-save').click();await pause(180);result.saved=profileState.profiles.find(p=>p.id==='p');
 $('profiles-list').querySelector('[aria-label="Edit Pat"]').click();await pause();result.guardianDisabled=$('profile-inherit-libraries').disabled;result.guardianInherit=$('profile-inherit-libraries').checked;result.guardianAll=$('profile-all-libraries').checked;
 $('profile-editor-cancel').click();await pause(150);$('groups-list').querySelector('button').click();result.guardianGroupHidden=$('group-library-section').hidden;
 `,{withProfiles:true,configured:false,live:true});
 assert.equal(r.legacy,false);assert.equal(r.saved.inheritLibraries,false);assert.deepEqual(r.saved.libraries,['library']);
 assert.equal(r.guardianDisabled,true);assert.equal(r.guardianInherit,false);assert.equal(r.guardianAll,true);assert.equal(r.guardianGroupHidden,true);
});

test('group library editor remains inside a narrow viewport',()=>{
 const r=fullUI(`await GameShelfProfiles.open();$('groups-list').querySelectorAll('button')[2].click();$('group-library-policy').value='selected';$('group-library-policy').dispatchEvent(new Event('change'));await pause(160);const rect=$('group-editor-dialog').getBoundingClientRect();result.bounds=rect.left>=0&&rect.right<=innerWidth+1&&rect.top>=0&&rect.bottom<=innerHeight+1;result.selection=!$('group-library-choices').hidden;`,{withProfiles:true,configured:false,live:true,width:390,height:844});
 assert.equal(r.bounds,true);assert.equal(r.selection,true);
});
