/* Guided tour keeps library state intact and asks before an early exit. */
(() => {
  const $ = id => document.getElementById(id);
  const dialog = $('tour-dialog'), tooltip = $('tour-tooltip'), cancelDialog=$('tour-cancel-dialog');
  const definitions = [
    ['.gs-card', 'Everything within reach', 'Hover a game for favorites, download, Playlist, and details. The details panel also lets you edit its title and cover.'],
    ['#gs-home-trigger', 'Always a way home', 'Click the GameShelf console logo to return to your full shelf in grid view at any time.'],
    ['#search-input', 'Find your next game', 'Search by title. Clear the search to bring your full shelf back.'],
    ['#sort-button', 'Your shelf, your order', 'Sort by title, size, favorites, or recently added games.'],
    ['#view-toggle', 'See it your way', 'Switch between cover cards and a compact list. Your preference is remembered.'],
    ['#random-game', 'Let the dice choose', 'Roll for a random game when you want a little inspiration. Roll again or return to your library.'],
    ['#open-cart', 'Build a Playlist', 'Use + on a game to collect it here, then download the selection together in one ZIP.'],
    ['#build-info', 'Make yourself at home', 'Change themes and library options, manage sources, or replay this tour from Settings.']
  ];
  let steps=[],index=0,highlighted=null,frame=null,revealTimer=null,stepVersion=0,popoverMotion=null;
  const reduced=()=>disableEffects||matchMedia('(prefers-reduced-motion: reduce)').matches;
  const visible=element=>element&&getComputedStyle(element).display!=='none'&&element.getBoundingClientRect().width>0;
  function place(){
    frame=null;if(!dialog.open||!highlighted)return;
    const rect=highlighted.getBoundingClientRect(),spotlight=$('tour-spotlight');
    spotlight.style.left=Math.max(2,Math.min(innerWidth-rect.width-14,rect.left-7))+'px';spotlight.style.top=Math.max(2,rect.top-6)+'px';
    spotlight.style.width=Math.min(innerWidth-4,rect.width+14)+'px';spotlight.style.height=Math.min(innerHeight-4,rect.height+12)+'px';
    const box=tooltip.getBoundingClientRect();let left,top;
    if(rect.height>120&&rect.right+box.width+24<innerWidth){left=rect.right+20;top=rect.top+(rect.height-box.height)/2;}
    else{left=rect.left+rect.width/2-box.width/2;top=rect.bottom+20;if(top+box.height>innerHeight-16)top=rect.top-box.height-20;}
    tooltip.style.left=Math.max(16,Math.min(innerWidth-box.width-16,left))+'px';tooltip.style.top=Math.max(16,Math.min(innerHeight-box.height-16,top))+'px';
  }
  function schedulePlace(){if(dialog.open&&!frame)frame=requestAnimationFrame(place);}
  function showStep(next){
    const version=++stepVersion;clearTimeout(revealTimer);popoverMotion?.cancel();tooltip.style.visibility='hidden';tooltip.inert=true;
    highlighted?.classList.remove('gs-tour-show-actions');index=next;
    const [selector,title,description]=steps[index];highlighted=document.querySelector(selector);if(!highlighted){finish();return;}
    if(highlighted.classList.contains('gs-card'))highlighted.classList.add('gs-tour-show-actions');
    highlighted.scrollIntoView({block:'nearest',inline:'nearest',behavior:reduced()?'instant':'smooth'});
    $('tour-count').textContent=`Step ${index+1} of ${steps.length}`;$('tour-title').textContent=title;$('tour-description').textContent=description;
    $('tour-back').disabled=index===0;$('tour-next').textContent=index===steps.length-1?'All set!':'Next';
    $('tour-readonly-info').hidden=selector!=='.gs-card';setReadOnlyNote(false);
    $('tour-progress').replaceChildren(...steps.map((_,position)=>{const dot=document.createElement('i');dot.classList.toggle('is-current',position<=index);return dot;}));
    $('tour-spotlight').style.transitionDuration=reduced()?'0s':motionDuration(220)+'ms';place();
    const reveal=()=>{if(version!==stepVersion||!dialog.open)return;place();tooltip.style.visibility='visible';tooltip.inert=false;
      if(!reduced())popoverMotion=tooltip.animate?.([{opacity:.3,transform:'translateY(4px)'},{opacity:1,transform:'none'}],{duration:motionDuration(160),easing:'ease-out'});
    };
    if(reduced())reveal();else revealTimer=setTimeout(reveal,motionDuration(260));
  }
  function start(){steps=definitions.filter(([selector])=>visible(document.querySelector(selector)));if(!steps.length)return;tooltip.style.visibility='hidden';openModal(dialog);showStep(0);}
  function finish(){clearTimeout(revealTimer);stepVersion++;dialog.close();}
  function requestCancel(){if(dialog.open&&!cancelDialog.open)openModal(cancelDialog);}
  dialog.addEventListener('cancel',event=>{event.preventDefault();event.stopImmediatePropagation();requestCancel();});
  dialog.addEventListener('close',()=>{highlighted?.classList.remove('gs-tour-show-actions');highlighted=null;cancelAnimationFrame(frame);clearTimeout(revealTimer);frame=null;localStorage.setItem('gameshelf:tour-seen','true');});
  $('tour-next').addEventListener('click',()=>{if(index===steps.length-1)finish();else showStep(index+1);});
  $('tour-back').addEventListener('click',()=>{if(index>0)showStep(index-1);});
  $('tour-close').addEventListener('click',requestCancel);dialog.addEventListener('click',event=>{if(event.target===dialog)requestCancel();});
  for(const id of ['tour-cancel-close','tour-cancel-keep'])$(id).addEventListener('click',()=>cancelDialog.close());
  $('tour-cancel-confirm').addEventListener('click',()=>{cancelDialog.close();finish();});closeOnBackdropClick(cancelDialog);
  addEventListener('resize',schedulePlace);addEventListener('scroll',schedulePlace,true);
  dialog.addEventListener('keydown',event=>{if(event.key==='ArrowRight'){event.preventDefault();$('tour-next').click();}if(event.key==='ArrowLeft'&&index>0){event.preventDefault();showStep(index-1);}});
  function setReadOnlyNote(show){$('tour-readonly-note').hidden=!show;$('tour-readonly-info').setAttribute('aria-expanded',String(show));}
  const info=$('tour-readonly-info');info.addEventListener('mouseenter',()=>setReadOnlyNote(true));info.addEventListener('mouseleave',()=>setReadOnlyNote(false));info.addEventListener('focus',()=>setReadOnlyNote(true));info.addEventListener('blur',()=>setReadOnlyNote(false));info.addEventListener('click',()=>setReadOnlyNote($('tour-readonly-note').hidden));
  const intro=$('tour-intro-dialog');
  $('tour-intro-start').addEventListener('click',()=>{intro.close();setTimeout(start,reduced()?0:motionDuration(175));});
  for(const id of ['tour-intro-close','tour-intro-skip'])$(id).addEventListener('click',()=>{localStorage.setItem('gameshelf:tour-seen','true');intro.close();});closeOnBackdropClick(intro);
  $('show-tour').addEventListener('click',()=>{$('settings-dialog').close();setTimeout(start,reduced()?0:motionDuration(175));});
  window.GameShelfTour={offer(){openModal(intro);},start};
})();
