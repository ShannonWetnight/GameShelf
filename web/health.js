/* Library Health is read-only; configuration uses the existing server-settings save. */
(() => {
 const $=id=>document.getElementById(id),dialog=$('health-dialog');let timer=null,version=0,dirty=false;
 const names={healthy:'Healthy',degraded:'Degraded',critical:'Critical',unknown:'Not checked'};
 const date=value=>!value||value.startsWith('0001-')?'Not checked':new Date(value).toLocaleString();
 function text(tag,value,className){const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node;}
 async function read(options=false){
  const request=++version;try{const response=await fetch('/api/health',{cache:'no-store'});if(!response.ok)throw new Error('Could not read library health.');const result=await response.json();if(!dialog.open||request!==version)return;
   $('health-summary').textContent=result.checking?'Checking connections…':result.sources.length?names[result.state]+' · '+result.sources.length+' location'+(result.sources.length===1?'':'s'):'Add a location in Library Sources to start checking its health.';
   const list=$('health-sources');list.replaceChildren();for(const source of result.sources){const card=document.createElement('article');card.className='gs-health-source';const heading=document.createElement('div');heading.className='gs-health-source-heading';const badge=text('span',names[source.state]||'Not checked','gs-health-badge');badge.dataset.state=source.state;heading.append(text('strong',source.name),badge);card.append(heading,text('p',source.location,'gs-health-location'),text('p',source.message||'Run a connection check.','gs-settings-help'),text('small','Last check: '+date(source.lastChecked)),text('small','Last healthy: '+date(source.lastSuccess)),text('small',source.games+' game folder'+(source.games===1?'':'s')));list.appendChild(card);}
   const history=$('health-history');history.replaceChildren();for(const event of [...(result.events||[])].reverse().slice(0,25)){history.appendChild(text('li',date(event.at)+' · '+event.name+' · '+(names[event.state]||event.state)+' — '+event.message));}
   if(options||!dirty){$('health-enabled').checked=result.options.enabled;$('health-interval').value=result.options.intervalSeconds;}
   clearTimeout(timer);timer=setTimeout(()=>read(),result.checking?1000:10000);
  }catch(error){if(dialog.open&&request===version)$('health-status').textContent=error.message;}
 }
 $('open-library-health').addEventListener('click',()=>{dirty=false;$('health-status').textContent='';$('health-summary').textContent='Reading library health…';openModal(dialog);read(true);});
 $('health-close').addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>{version++;clearTimeout(timer);});
 $('health-check').addEventListener('click',async()=>{const button=$('health-check');button.disabled=true;$('health-status').textContent='';try{const response=await fetch('/api/health/check',{method:'POST'});if(!response.ok)throw new Error('Could not start a connection check.');$('health-summary').textContent='Checking connections…';clearTimeout(timer);timer=setTimeout(()=>read(),250);}catch(error){$('health-status').textContent=error.message;}finally{button.disabled=false;}});
 for(const id of ['health-enabled','health-interval'])$(id).addEventListener('input',()=>dirty=true);
 $('health-save').addEventListener('click',async()=>{const interval=Number($('health-interval').value);if(!Number.isInteger(interval)||interval<30||interval>86400){$('health-status').textContent='Choose 30–86400 whole seconds.';return;}const button=$('health-save');button.disabled=true;try{await saveServerSettings({...serverSettings,health:{enabled:$('health-enabled').checked,intervalSeconds:interval}});dirty=false;showSaveFeedback(button);showNotification('Library health monitoring saved.');}catch(error){$('health-status').textContent=error.message;}finally{button.disabled=false;}});
 addEventListener('DOMContentLoaded',()=>{closeOnBackdropClick(dialog);document.querySelector('.gs-health-config').dataset.accessAction='health';});
})();
