/* Named library browsing uses server-filtered labels and cached health only. */
(() => {
 const bar=document.getElementById('library-view'),select=document.getElementById('library-view-select'),status=document.getElementById('library-view-health');
 const labels={healthy:'Online',degraded:'Connection issue',critical:'Offline',unknown:'Not checked',disabled:'Not monitored',restricted:'Health hidden'};
 let libraries=[],selected='',generation=0;
 const allows=game=>!selected||game?.libraryID===selected;
 function render(){
  if(select.classList.contains('gs-select-open'))window.GameShelfSelect?.close(true,true);
  select.replaceChildren();const all=document.createElement('option');all.value='';all.textContent='All libraries';select.append(all);
  for(const library of libraries){const option=document.createElement('option');option.value=library.id;option.textContent=library.name;select.append(option);}
  select.value=selected;bar.hidden=libraries.length<2;
  const library=libraries.find(item=>item.id===selected);
  status.dataset.state=library?.state||'';status.textContent=library?labels[library.state]:libraries.length+' libraries';
  status.title=library?.state==='restricted'?'Your current profile or shared permissions hide library health.':'Last recorded connection check. Use Library Manager to check again.';
  status.setAttribute('aria-label',library?library.name+': '+labels[library.state]:status.textContent);
  document.getElementById('library-view-count').textContent=library?library.games+' '+(library.games===1?'game':'games'):'';
 }
 async function refresh(){
  const request=++generation;
  try{
   const response=await fetch('/api/libraries',{cache:'no-store'});if([401,403,428].includes(response.status)){clear();return;}if(!response.ok)throw Error('Library list unavailable');
   const data=await response.json();if(request!==generation)return;
   if(!Array.isArray(data)||data.some(item=>!item||typeof item.id!=='string'||!item.id||typeof item.name!=='string'||!Object.hasOwn(labels,item.state)||!Number.isInteger(item.games)||item.games<0))throw Error('Invalid library list');
   libraries=data;if(selected&&!libraries.some(item=>item.id===selected))selected='';render();applySearchFilter();
  }catch{if(request===generation){status.textContent='Status unavailable';status.dataset.state='unknown';}}
 }
 function clear(){generation++;libraries=[];selected='';render();}
 function reset(){selected='';render();}
 select.addEventListener('change',()=>{selected=select.value;clearSuggestion();render();applySearchFilter();});
 setInterval(()=>{if(hasLoadedGames&&!document.hidden&&!document.body.classList.contains('gs-profile-required')&&!document.body.classList.contains('gs-needs-setup'))refresh();},30000);
 window.GameShelfLibraryView={allows,clear,reset,refresh,selected:()=>selected};
})();
