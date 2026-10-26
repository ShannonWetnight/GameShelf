/* Compact settings retain their help in one themed hint. */
(()=>{
 for(const row of document.querySelectorAll('#settings-dialog .gs-theme-option,#settings-dialog .gs-settings-option,#settings-dialog .gs-settings-backup,#library-manager-dialog .gs-settings-backup')){
  const small=row.querySelector('small'),name=row.querySelector('strong');if(!small||!name)continue;
  name.dataset.tooltip=small.textContent.trim();name.tabIndex=0;small.remove();
 }
})();
