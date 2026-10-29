const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {fullUI}=require('./browser-fixture.cjs');
function screenshot(name){if(!process.env.CI&&!process.env.GAMESHELF_SCREENSHOTS)return null;const directory=path.resolve(__dirname,'../reports/screenshots');fs.mkdirSync(directory,{recursive:true});return path.join(directory,name+'.png');}
const icon=pathToFileURL(path.resolve(__dirname,'../web/gameshelf_icon.png')).href,placeholder=pathToFileURL(path.resolve(__dirname,'../web/placeholder.png')).href;
const visualSetup=`$('gs-logo-icon').src=${JSON.stringify(icon)};showGameTitles=true;localStorage.setItem('gameshelf:show-game-titles','true');$('show-game-titles').checked=true;document.body.classList.add('gs-show-game-titles');for(const card of document.querySelectorAll('.gs-card')){const image=card.querySelector('.gs-cover-image');setCoverImage(image,card.querySelector('.gs-card-cover'),${JSON.stringify(placeholder)},card.dataset.name);await image.decode();}await $('gs-logo-icon').decode();`;
const sample=`
 window.libraryViewSources=[{id:'family',name:'Family Games',state:'healthy',games:2},{id:'archive',name:'Archive Games',state:'critical',games:1}];
 window.libraryViewGames=[{id:'orbital',name:'Orbital Runner',libraryID:'family',hasCover:false,favorite:false,fileCount:3,sizeBytes:2048000},{id:'castle',name:'Castle Quest',libraryID:'family',hasCover:false,favorite:true,fileCount:8,sizeBytes:10485760},{id:'archive-game',name:'Deep Archive',libraryID:'archive',hasCover:false,favorite:false,unavailable:true,fileCount:4,sizeBytes:4194304}];
 await loadGames();await GameShelfLibraryView.refresh();
 const choose=id=>{const select=$('library-view-select');select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}));};
 const visible=()=>[...document.querySelectorAll('.gs-card')].filter(card=>card.style.display!=='none').map(card=>card.dataset.id).sort();
`;

test('named library browsing composes with search, favorites, grid/list and random suggestions',()=>{
 const r=fullUI(sample+`
 result.shown=!$('library-view').hidden;choose('family');result.family=visible();result.health=$('library-view-health').textContent;
 currentSort='favorites';applySearchFilter();result.favorites=visible();currentSort='all';currentSearch='orbital';applySearchFilter();result.search=visible();currentSearch='';
 currentView='list';applyViewMode();choose('archive');result.archive=visible();result.offline=$('library-view-health').textContent;result.count=$('library-view-count').textContent;
 suggestRandomGame();await pause(300);result.random=gamesCache.find(game=>game.id===suggestedGameId)?.libraryID;
 $('gs-home-trigger').click();await pause(100);result.reset=$('library-view-select').value;result.all=visible();
 `,{live:true});
 assert.equal(r.shown,true);assert.deepEqual(r.family,['castle','orbital']);assert.equal(r.health,'Online');assert.deepEqual(r.favorites,['castle']);assert.deepEqual(r.search,['orbital']);assert.deepEqual(r.archive,['archive-game']);assert.equal(r.offline,'Offline');assert.equal(r.count,'1 game');assert.equal(r.random,'archive');assert.equal(r.reset,'');assert.equal(r.all.length,3);
});

test('removing sources and failed refreshes leave predictable filters',()=>{
 const r=fullUI(sample+`
 choose('archive');window.libraryViewStatus=503;await GameShelfLibraryView.refresh();result.failureSelection=$('library-view-select').value;result.failureStatus=$('library-view-health').textContent;
 window.libraryViewStatus=200;window.libraryViewSources=[window.libraryViewSources[0]];await GameShelfLibraryView.refresh();result.removed=$('library-view-select').value;result.singleHidden=$('library-view').hidden;
 window.libraryViewSources.push({id:'new',name:'New Shelf',state:'unknown',games:0});await GameShelfLibraryView.refresh();choose('new');result.empty=$('empty-state').classList.contains('hidden');result.randomDisabled=$('random-game').disabled;
 window.libraryViewStatus=401;await GameShelfLibraryView.refresh();result.deniedHidden=$('library-view').hidden;result.names=$('library-view-select').textContent;
 `,{live:true});
 assert.equal(r.failureSelection,'archive');assert.equal(r.failureStatus,'Status unavailable');assert.equal(r.removed,'');assert.equal(r.singleHidden,true);assert.equal(r.empty,false);assert.equal(r.randomDisabled,true);assert.equal(r.deniedHidden,true);assert.equal(r.names,'All libraries');
});

test('identity clearing rejects an in-flight library list',()=>{
 const r=fullUI(sample+`window.libraryViewDelay=150;const pending=GameShelfLibraryView.refresh();GameShelfLibraryView.clear();await pending;result.hidden=$('library-view').hidden;result.names=$('library-view-select').textContent;`,{live:true});
 assert.equal(r.hidden,true);assert.equal(r.names,'All libraries');
});

test('library picker fits mobile and provides a desktop visual record',()=>{
 for(const width of [390,1280]){
  const r=fullUI(sample+visualSetup+`choose('family');await pause(100);const bar=$('library-view').getBoundingClientRect(),select=$('library-view-select').getBoundingClientRect();result.bounds=bar.left>=0&&bar.right<=innerWidth+1&&select.right<=innerWidth+1;result.label=$('library-view-select').getAttribute('aria-label');result.selectWidth=select.width;`,{live:true,width,height:1000,screenshot:screenshot('library-view-'+width)});
  assert.equal(r.bounds,true);assert.equal(r.label,'Browse library');assert.ok(r.selectWidth>140,'library name has insufficient room');
 }
});

test('shared group assignments and individual inheritance have visual records',()=>{
 const setup=`profileState.libraries.push({id:'archive',name:'Archive Games',location:'/archive'});profileState.profileGroups['g-children'].libraryPolicy='selected';profileState.profileGroups['g-children'].libraries=['library'];profileState.profiles=[{id:'jamie',nickname:'Jamie',avatar:'builtin:kid-cosmic-cat',roles:[],effectiveRoles:['child'],groups:['g-children'],pinRequired:true,allLibraries:true,allGames:true,inheritLibraries:true},{id:'alex',nickname:'Alex',avatar:'builtin:kid-dragon-friend',roles:['child'],groups:[],pinRequired:false,allLibraries:true,allGames:true}];await GameShelfProfiles.open();`;
 const group=fullUI(setup+`$('groups-list').querySelectorAll('button')[2].click();await pause(100);result.open=$('group-editor-dialog').open;`,{withProfiles:true,configured:false,live:true,screenshot:screenshot('shared-group-libraries')});
 assert.equal(group.open,true);
 const profile=fullUI(setup+`$('profiles-list').querySelector('[aria-label="Edit Jamie"]').click();await pause(150);$('profile-inherit-libraries').closest('fieldset').scrollIntoView({block:'center'});await pause(50);result.summary=$('profile-library-summary').textContent;`,{withProfiles:true,configured:false,live:true,screenshot:screenshot('profile-library-inheritance')});
 assert.match(profile.summary,/Home Games/);assert.doesNotMatch(profile.summary,/Archive Games/);
});
