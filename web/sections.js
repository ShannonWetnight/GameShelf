/* Shared subsection legends preserve existing controls and their event handlers. */
(() => {
 const selector='section.gs-settings-section,section.gs-family-group,section.gs-export-section,div.gs-log-config-group,div.gs-export-section';
 function enhance(root){if(root.nodeType!==1)return;for(const section of [root,...root.querySelectorAll(selector)]){if(!section.matches(selector))continue;const title=[...section.children].find(node=>node.tagName==='H3');if(!title)continue;const fieldset=document.createElement('fieldset');for(const attribute of section.attributes)fieldset.setAttribute(attribute.name,attribute.value);const legend=document.createElement('legend');legend.className=title.className;while(title.firstChild)legend.append(title.firstChild);title.replaceWith(legend);while(section.firstChild)fieldset.append(section.firstChild);section.replaceWith(fieldset);}}
 enhance(document.body);new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)enhance(node);}).observe(document.body,{childList:true,subtree:true});
})();
