package main

import (
    "encoding/json"
    "log"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "reflect"
    "strings"
    "testing"
)

func setupFreshServer(t *testing.T) (string, string) {
    t.Helper()
    root := setupLibrary(t)
    data := dataDir
    oldHome, oldAllowed, oldMounts, oldSettings, oldRequired, oldOutput := settingsHome, allowedLibraryRoot, mountedLibraryRoots, configuredSettings, setupRequired.Load(), log.Writer()
    t.Cleanup(func(){settingsHome,allowedLibraryRoot,mountedLibraryRoots,configuredSettings=oldHome,oldAllowed,oldMounts,oldSettings;setupRequired.Store(oldRequired);verboseLogging.Store(oldSettings.Verbose);log.SetOutput(oldOutput);select{case <-refreshSchedule:default:}})
    t.Setenv("GAMESHELF_ROOT","");t.Setenv("GAMESHELF_DATA_DIR",data);t.Setenv("GAMESHELF_REFRESH_INTERVAL","")
    value:=initializeServerSettings();rootDir,rootDirs,dataDir=value.RootDir,libraryRoots(value),value.DataDir
    mountedLibraryRoots=[]string{root}
    return root,data
}

func TestFirstSetupHasNoAssumedLibraryAndGuardsScans(t *testing.T) {
    _,data:=setupFreshServer(t)
    if configuredSettings.RootDir!="" || len(libraryRoots(configuredSettings))!=0 || !setupRequired.Load(){t.Fatalf("fresh settings: %#v",configuredSettings)}
    if configuredSettings.DataDir!=data || configuredSettings.RefreshInterval!="168h"{t.Fatal(configuredSettings)}
    called:=false
    handler:=setupGate(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){called=true}))
    for i:=0;i<3;i++{w:=httptest.NewRecorder();handler.ServeHTTP(w,httptest.NewRequest(http.MethodGet,"/api/games?forceRefresh=1",nil));if w.Code!=200 || strings.TrimSpace(w.Body.String())!="[]" || called{t.Fatalf("setup tried a scan: %d %s",w.Code,w.Body.String())}}
    w:=httptest.NewRecorder();handler.ServeHTTP(w,httptest.NewRequest(http.MethodGet,"/api/library-backup",nil));if w.Code!=http.StatusConflict || called{t.Fatal("library access was not gated")}
}

func TestFirstSetupValidatesSavesAndIndexesWithoutRestart(t *testing.T) {
    root,data:=setupFreshServer(t)
    if err:=os.Mkdir(filepath.Join(root,"First Game"),0755);err!=nil{t.Fatal(err)}
    value:=serverSettings{RootDir:root,RootDirs:[]string{root},DataDir:data,RefreshInterval:"168h"}
    send:=func(value serverSettings)*httptest.ResponseRecorder{body,_:=json.Marshal(value);w:=httptest.NewRecorder();handleSetup(w,httptest.NewRequest(http.MethodPost,"/api/setup",strings.NewReader(string(body))));return w}
    bad:=value;bad.RootDir=filepath.Dir(root);bad.RootDirs=[]string{bad.RootDir}
    if w:=send(bad);w.Code!=http.StatusBadRequest{t.Fatalf("outside mount accepted: %d %s",w.Code,w.Body.String())}
    if _,err:=os.Stat(settingsFile());!os.IsNotExist(err){t.Fatal("invalid setup was persisted")}
    if w:=send(value);w.Code!=http.StatusOK{t.Fatalf("setup: %d %s",w.Code,w.Body.String())}
    if setupRequired.Load() || rootDir!=root || len(gamesMap)!=1 || lastIndexedAt.IsZero(){t.Fatal("setup did not activate/index library")}
    contents,err:=os.ReadFile(settingsFile());if err!=nil{t.Fatal(err)};var saved serverSettings;if err=json.Unmarshal(contents,&saved);err!=nil || saved.RootDir!=root{t.Fatal("setup did not persist")}
    if w:=send(value);w.Code!=http.StatusConflict{t.Fatal("setup overwrote a configured library")}
    value.RefreshInterval="24h";body,_:=json.Marshal(value);w:=httptest.NewRecorder();handleServerSettings(w,httptest.NewRequest(http.MethodPut,"/api/server-settings",strings.NewReader(string(body))));var result struct{RestartRequired bool `json:"restartRequired"`};if err:=json.Unmarshal(w.Body.Bytes(),&result);err!=nil||w.Code!=200||result.RestartRequired{t.Fatalf("interval should apply without restart: %s",w.Body.String())}
}

func TestLibraryFolderPickerStaysInsideMountedDirectories(t *testing.T) {
    root,_:=setupFreshServer(t)
    child:=filepath.Join(root,"Collection");if err:=os.Mkdir(child,0755);err!=nil{t.Fatal(err)}
    outside:=t.TempDir();if err:=os.Symlink(outside,filepath.Join(root,"Outside"));err!=nil{t.Fatal(err)}
    request:=func(path string)*httptest.ResponseRecorder{w:=httptest.NewRecorder();r:=httptest.NewRequest(http.MethodGet,"/api/library-folders",nil);q:=r.URL.Query();q.Set("path",path);r.URL.RawQuery=q.Encode();handleLibraryFolders(w,r);return w}
    for _,path:=range []string{filepath.Dir(root),filepath.Join(root,"Outside"),settingsHome}{if w:=request(path);w.Code!=400{t.Fatalf("outside picker path accepted: %s",path)}}
    w:=request(root);if w.Code!=200{t.Fatal(w.Body.String())};var list struct{Path,Parent string;Folders []string};if err:=json.Unmarshal(w.Body.Bytes(),&list);err!=nil{t.Fatal(err)}
    if list.Parent!="" || !reflect.DeepEqual(list.Folders,[]string{child}){t.Fatalf("folder listing: %#v",list)}
    w=request(child);if !strings.Contains(w.Body.String(),root){t.Fatal("picker lost parent navigation")}
}

func TestMountDiscoveryExcludesContainerSystemAndDataPaths(t *testing.T) {
    contents:="1 0 0:1 / / rw - overlay overlay rw\n2 1 0:2 / /proc rw - proc proc rw\n3 1 0:3 / /etc/hosts rw - ext4 disk rw\n4 1 0:4 / /data rw - ext4 disk rw\n5 1 0:5 / /libraries/Shared\\040Games ro - ext4 disk rw\n6 1 0:6 / /collection ro - ext4 disk rw\n7 1 0:7 / /saved-data rw - ext4 disk rw"
    got:=parseLibraryMounts(contents,"/saved-data");want:=[]string{"/collection","/libraries/Shared Games"};if !reflect.DeepEqual(got,want){t.Fatalf("mounts = %#v",got)}
}

func TestExplicitComposeRootSkipsFirstSetup(t *testing.T) {
    root,data:=setupFreshServer(t)
    t.Setenv("GAMESHELF_ROOT",root);t.Setenv("GAMESHELF_DATA_DIR",data)
    value:=initializeServerSettings();if setupRequired.Load() || value.RootDir!=root{t.Fatal("explicit library was ignored")}
}

func TestResetWithoutComposeRootReturnsToSetup(t *testing.T) {
    root,data:=setupFreshServer(t)
    value:=serverSettings{RootDir:root,DataDir:data,RefreshInterval:"0"};body,_:=json.Marshal(value)
    w:=httptest.NewRecorder();handleSetup(w,httptest.NewRequest(http.MethodPost,"/api/setup",strings.NewReader(string(body))));if w.Code!=200{t.Fatal(w.Body.String())}
    w=httptest.NewRecorder();handleResetServerSettings(w,httptest.NewRequest(http.MethodPost,"/api/server-settings/reset",nil))
    if w.Code!=200 || !setupRequired.Load() || configuredSettings.RootDir!=""{t.Fatalf("reset did not reopen setup: %d %#v",w.Code,configuredSettings)}
}
