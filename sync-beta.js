/**
 * ÉquiComptes V7.1 BÊTA — mode hors connexion + synchronisation par document.
 * Données de test : l'application V6.4 n'est jamais consultée ni modifiée.
 * Le serveur est la source commune ; les changements hors ligne sont conservés
 * dans un journal local et transmis au retour de la connexion.
 * Les modifications concurrentes d'un même document nécessitent un arbitrage.
 */
window.EQUI_SYNC_MODULE_LOADED = true;
const B = window.EquiBetaBridge;
const el = id => document.getElementById(id);
const CFGKEY = 'equicomptes-beta-v7-firebase-configuration';
const FOYERKEY = 'equicomptes-v7-beta-foyer-local';
const VERIFIED_KEY = 'equicomptes-v7-beta-verified-device';
const GROUPS = ['settings','months','charges','incomes','expenses','settlements','history'];
const fmt = x => JSON.stringify(x);
const gate = el('beta-gate');
const status = el('beta-sync-indicator');
const message = el('beta-gate-message');
const resolveButton = el('beta-resolve-conflicts');
let sdk = null, sdkPromise = null, app = null, auth = null, db = null;
let user = null, onlineReady = false, disconnected = !navigator.onLine;
let subscriptions = [], shadow = new Map(), observed = new Map();
let dirty = Object.create(null), conflicts = new Map(), inFlight = new Set();
let saveTimer = null, reconnectTimer = null, isConnecting = false;
let openingLocal = false, replacingRemote = false, lastServerContact = false;
let currentUserUID = '', currentEmail = '';
let startCloudToken = 0;
const PATH = ['foyers',localStorage.getItem(FOYERKEY) || ''];

function showStatus(t, kind='neutral'){
 if(status){status.textContent = '● ' + t;status.dataset.syncState=kind;}
 if(resolveButton)resolveButton.hidden = !conflicts.size;
}
function note(t){if(message)message.textContent=t;}
function errorText(e){
 const code=String(e?.code||''), desc=String(e?.message||'Erreur inconnue');
 if(code.includes('permission-denied'))return 'Accès Firestore refusé : vérifie les UID et les règles publiées.';
 if(code.includes('wrong-password')||code.includes('invalid-credential')||code.includes('user-not-found'))return 'Adresse e-mail ou mot de passe incorrect.';
 if(code.includes('auth/user-token-expired')||code.includes('user-disabled'))return 'Session expirée : reconnecte-toi avec ton mot de passe.';
 if(code.includes('network')||!navigator.onLine)return 'Connexion Internet indisponible : les changements restent sur ce téléphone.';
 return desc.slice(0,210);
}
function configFromText(raw){
 let v={},s=String(raw||'').trim();try{v=JSON.parse(s)}catch{}
 if(!v.apiKey)for(const k of ['apiKey','authDomain','projectId','appId']){
  const m=s.match(new RegExp('["\\\']?'+k+'["\\\']?\\s*:\\s*["\\\']([^"\\\']+)["\\\']'));
  if(m)v[k]=m[1];
 }
 for(const k of ['apiKey','authDomain','projectId','appId'])if(typeof v[k]!=='string'||!v[k].trim())throw Error('Configuration Firebase : champ '+k+' manquant.');
 return Object.fromEntries(['apiKey','authDomain','projectId','appId'].map(k=>[k,v[k].trim()]));
}
function locked(){gate.hidden=false;onlineReady=false;}
function unlocked(){gate.hidden=true;}
function showConfig(){el('beta-config-panel').hidden=false;el('beta-login-form').hidden=true;el('beta-change-config').hidden=true;el('beta-config-text').value=localStorage.getItem(CFGKEY)||'';note('Renseigne la configuration Firebase une première fois en ligne.');}
function showLogin(){el('beta-config-panel').hidden=true;el('beta-login-form').hidden=false;el('beta-change-config').hidden=false;el('beta-foyer').value=PATH[1];note('Identifie-toi avec le compte Firebase du foyer de test.');}
function documentKey(g,id){return g+'/'+id;}
function pathCollection(g){return sdk.collection(db,...PATH,g);}
function pathDoc(g,id){return sdk.doc(db,...PATH,g,id);}
function flatten(s){
 const m=new Map();
 m.set('settings/main',{settings:s.settings,incomeTemplates:s.incomeTemplates});
 for(const [id,v] of Object.entries(s.monthlySalaries||{}))m.set(documentKey('months',id),v);
 for(const [group,field,key] of [['charges','charges','id'],['incomes','additionalIncome','id'],['expenses','expenses','id'],['settlements','settlements','id'],['history','history','month']]){
  for(const v of s[field]||[])if(v&&v[key])m.set(documentKey(group,v[key]),v);
 }
 return m;
}
function scope(){return currentUserUID&&PATH[1]?`equicomptes-beta-offline-v71:${PATH[1]}:${currentUserUID}`:'';}
function verifiedDevice(){try{const v=JSON.parse(localStorage.getItem(VERIFIED_KEY)||'null');if(v&&v.uid&&v.email&&v.foyer&&v.foyer===PATH[1])return v;}catch{}return null;}
function rememberUser(u){
 currentUserUID=u.uid;currentEmail=u.email||'';
 localStorage.setItem(VERIFIED_KEY,fmt({uid:u.uid,email:currentEmail,foyer:PATH[1],verifiedAt:Date.now()}));
}
function queueKey(){return scope()+'::queue';}
function baselineKey(){return scope()+'::baseline';}
function readDiskQueue(){
 dirty=Object.create(null);
 if(!scope())return;
 try{const v=JSON.parse(localStorage.getItem(queueKey())||'{}');if(v&&typeof v==='object'&&!Array.isArray(v))for(const [k,op] of Object.entries(v))if(k.includes('/')&&op&&op.rev)dirty[k]=op;}catch(e){console.warn('Journal local non lisible',e);}
 try{const v=JSON.parse(localStorage.getItem(baselineKey())||'{}');shadow=new Map(Object.entries(v));}catch{shadow=new Map();}
}
function saveDiskQueue(){if(!scope())return;try{localStorage.setItem(queueKey(),fmt(dirty));}catch(e){showStatus('Stockage local saturé — exporter une sauvegarde','error');}}
function saveBaseline(){if(!scope())return;try{localStorage.setItem(baselineKey(),fmt(Object.fromEntries(shadow)));}catch{}}
function backlog(){return Object.keys(dirty).length;}
function refreshStatus(){
 if(conflicts.size){showStatus(`⚠ ${conflicts.size} conflit(s) à examiner — ${backlog()} en attente`,'warning');return;}
 if(!navigator.onLine||disconnected){showStatus(`Hors ligne • ${backlog()} changement(s) en attente`,'offline');return;}
 if(!onlineReady){showStatus(`Mode local • ${backlog()} changement(s) en attente`,'offline');return;}
 if(backlog()){showStatus(`${backlog()} modification(s) à synchroniser…`,'pending');return;}
 showStatus(`Synchronisé : ${currentEmail||'foyer de test'}`,'synced');
}
function openOffline(reason){
 const v=verifiedDevice();
 if(!v){locked();return false;}
 currentUserUID=v.uid;currentEmail=v.email;
 if(!openingLocal){readDiskQueue();observed=flatten(B.state());openingLocal=true;}
 onlineReady=false;disconnected=true;
 unlocked();refreshStatus();
 if(reason)note(reason);
 return true;
}
function bumpDirty(){
 if(!currentUserUID){const v=verifiedDevice();if(!v)return;currentUserUID=v.uid;currentEmail=v.email;readDiskQueue();}
 const latest=flatten(B.state());
 const keys=new Set([...observed.keys(),...latest.keys()]);let changed=false;
 for(const key of keys){
  const before=observed.get(key),after=latest.get(key);
  if(fmt(before)===fmt(after))continue;
  const prev=dirty[key];
  // Baseline de l'élément lors de la première saisie non synchronisée.
  const base=prev?prev.base:(shadow.has(key)?shadow.get(key):null);
  dirty[key]={value:after===undefined?null:after,deleted:after===undefined,rev:(prev?.rev||0)+1,base,at:Date.now()};
  changed=true;
 }
 observed=latest;
 if(changed){saveDiskQueue();refreshStatus();if(onlineReady)scheduleSync();}
}
window.EQUI_BETA_SYNC_HOOK=bumpDirty;

async function loadLibraries(){
 if(!sdkPromise){
  sdkPromise=Promise.all([
   import('https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js'),
   import('https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js'),
   import('https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js')
  ]).then(([a,b,c])=>{
   sdk={...a,...b,...c};return sdk;
  }).catch(e=>{sdkPromise=null;throw Error('Bibliothèques Firebase inaccessibles : '+String(e?.message||e).slice(0,130));});
 }
 return sdkPromise;
}
function resetListeners(){for(const off of subscriptions)try{off()}catch{}subscriptions=[];startCloudToken++;onlineReady=false;}
function updateObserved(){observed=flatten(B.state());}
function remoteDocsToMap(remote){const result=new Map();for(const [g,items]of Object.entries(remote))for(const [id,v]of Object.entries(items))result.set(documentKey(g,id),v);return result;}
function refreshRemoteBaseline(remote){shadow=remoteDocsToMap(remote);saveBaseline();}
function flagConflict(key,remote){
 const op=dirty[key];if(!op)return false;
 // Le document distant a changé pendant l'absence de connexion.
 if(fmt(op.base)!==fmt(remote===undefined?null:remote)){
  conflicts.set(key,{remote:remote===undefined?null:remote});return true;
 }
 return false;
}
function applyCloudSnapshot(group,id,v,metadata){
 const key=documentKey(group,id),value=v===undefined?null:v;
 if(metadata?.hasPendingWrites)return;
 if(dirty[key]){
  // Le changement local a priorité tant que le conflit n'est pas résolu.
  if(!conflicts.has(key))flagConflict(key,value);
  refreshStatus();return;
 }
 const old=shadow.has(key)?shadow.get(key):null;
 if(fmt(old)===fmt(value))return;
 if(value===null)shadow.delete(key);else shadow.set(key,value);
 saveBaseline();B.patch(group,id,value);updateObserved();refreshStatus();
}
async function readRemoteAndMerge(u){
 if(!navigator.onLine)throw Error('Hors connexion');
 const token=++startCloudToken;const remote={};
 await Promise.all(GROUPS.map(async group=>{
  const data=await sdk.getDocsFromServer(pathCollection(group));
  remote[group]={};data.forEach(d=>{remote[group][d.id]=d.data()});
 }));
 if(token!==startCloudToken||!user||user.uid!==u.uid)return;
 const savedLocal=flatten(B.state());
 // On conserve les saisies hors ligne avant la réinitialisation de l'état à partir du serveur.
 B.replaceAll(remote);
 const freshRemote=remoteDocsToMap(remote);
 for(const [key,op] of Object.entries(dirty)){
  const pos=key.indexOf('/'),group=key.slice(0,pos),id=key.slice(pos+1);
  if(!GROUPS.includes(group)||!id)continue;
  const remoteValue=freshRemote.has(key)?freshRemote.get(key):null;
  if(fmt(remoteValue)===fmt(op.deleted?null:op.value)){delete dirty[key];saveDiskQueue();continue;}
  B.patch(group,id,op.deleted?null:op.value);
  flagConflict(key,remoteValue);
 }
 updateObserved();shadow=freshRemote;saveBaseline();
 for(const group of GROUPS){
  const off=sdk.onSnapshot(pathCollection(group),{includeMetadataChanges:true},snapshot=>{
   if(snapshot.metadata.fromCache){if(!navigator.onLine)disconnected=true;refreshStatus();}
   else {disconnected=false;lastServerContact=true;}
   for(const ch of snapshot.docChanges())applyCloudSnapshot(group,ch.doc.id,ch.type==='removed'?null:ch.doc.data(),ch.doc.metadata);
   refreshStatus();
  },err=>{onlineReady=false;disconnected=true;note(errorText(err));refreshStatus();});
  subscriptions.push(off);
 }
 onlineReady=true;disconnected=false;lastServerContact=true;
 rememberUser(u);unlocked();refreshStatus();scheduleSync();
}
async function startCloud(u){
 if(isConnecting)return;
 if(!PATH[1]){locked();showLogin();note('Indique le code privé du foyer avant la connexion.');return;}
 isConnecting=true;user=u;currentUserUID=u.uid;currentEmail=u.email||'';
 resetListeners();readDiskQueue();
 const verified=verifiedDevice();
 if(verified&&verified.uid===u.uid)openOffline('Données locales accessibles en attendant le serveur.');
 else {locked();showLogin();}
 try{await readRemoteAndMerge(u)}
 catch(e){onlineReady=false;disconnected=true;
  if(verifiedDevice()?.uid===u.uid)openOffline('Serveur momentanément inaccessible. Tu peux saisir tes dépenses hors ligne.');
  else{locked();showLogin();note('La première connexion au foyer doit être confirmée en ligne : '+errorText(e));}
  refreshStatus();
 }
 finally{isConnecting=false;}
}
function scheduleSync(){if(!onlineReady||!navigator.onLine||!user)return;clearTimeout(saveTimer);saveTimer=setTimeout(syncPending,480);}
async function syncPending(){
 if(!onlineReady||!navigator.onLine||!user||!db)return;
 for(const [key,op]of Object.entries(dirty)){
  if(inFlight.has(key)||conflicts.has(key))continue;
  const p=key.indexOf('/'),group=key.slice(0,p),id=key.slice(p+1);
  if(!GROUPS.includes(group)||!id)continue;
  inFlight.add(key);
  const rev=op.rev;
  try{
   if(op.deleted)await sdk.deleteDoc(pathDoc(group,id));
   else await sdk.setDoc(pathDoc(group,id),op.value);
   // N'effacer le journal que si l'utilisateur n'a pas modifié l'entrée entre-temps.
   if(dirty[key]?.rev===rev){
    delete dirty[key];saveDiskQueue();
    if(op.deleted)shadow.delete(key);else shadow.set(key,op.value);
    saveBaseline();
   }
  }catch(e){disconnected=String(e?.code||'').includes('unavailable')||!navigator.onLine;note('Synchronisation suspendue : '+errorText(e));}
  finally{inFlight.delete(key);refreshStatus();if(dirty[key]&&dirty[key].rev!==rev)scheduleSync();}
 }
}
function reconnectSoon(){
 clearTimeout(reconnectTimer);reconnectTimer=setTimeout(async()=>{
  if(!navigator.onLine)return;
  disconnected=false;
  if(user&&auth&&db){
   if(!onlineReady)await startCloud(user);else scheduleSync();
  }else{
   const cfg=await loadConfig();if(cfg)await startFirebase(cfg);
  }
 },850);
}
function resolveConflicts(){
 if(!conflicts.size)return;
 for(const [key,c]of [...conflicts]){
  const op=dirty[key];if(!op){conflicts.delete(key);continue;}
  const [group,id]=key.split('/');
  const yes=confirm(`CONFLIT SUR ${group} / ${id}\n\nDeux téléphones ont changé cet élément.\n\nOK : conserver ta modification locale et l'envoyer.\nAnnuler : utiliser la version du serveur.\n\nPense à exporter ta sauvegarde avant de trancher.`);
  if(yes){op.base=c.remote;saveDiskQueue();}
  else{
   delete dirty[key];saveDiskQueue();
   B.patch(group,id,c.remote);updateObserved();
   if(c.remote===null)shadow.delete(key);else shadow.set(key,c.remote);saveBaseline();
  }
  conflicts.delete(key);
 }
 refreshStatus();scheduleSync();
}
if(resolveButton)resolveButton.addEventListener('click',resolveConflicts);
async function startFirebase(config){
 if(!navigator.onLine){openOffline('Pas de connexion. L’application reste utilisable avec les données de ce téléphone.');return;}
 try{
  await loadLibraries();
  if(!app)app=sdk.initializeApp(config,'equicomptes-beta-foyer-test');
  auth=sdk.getAuth(app);
  if(!db){
   try{
    db=sdk.initializeFirestore(app,{localCache:sdk.persistentLocalCache({tabManager:sdk.persistentMultipleTabManager()})});
   }catch(e){console.warn('Cache IndexedDB non disponible, journal local de secours utilisé :',e);db=sdk.getFirestore(app);}
  }
  await sdk.setPersistence(auth,sdk.browserLocalPersistence);
  showLogin();
  if(!window.EQUI_BETA_AUTH_LISTENER){
   window.EQUI_BETA_AUTH_LISTENER=true;
   sdk.onAuthStateChanged(auth,async u=>{
    if(u){user=u;el('beta-signout').hidden=false;await startCloud(u);}
    else{
     user=null;onlineReady=false;resetListeners();el('beta-signout').hidden=true;
     if(navigator.onLine){locked();showLogin();note('Session Firebase expirée ou déconnectée : saisis ton mot de passe pour reprendre la synchronisation. Tes données locales sont conservées.');}
     else openOffline('Session Firebase à renouveler au retour du réseau.');
    }
   },err=>{openOffline('Connexion indisponible : '+errorText(err));});
  }
 }catch(e){
  if(!openOffline('Firebase ne répond pas, les données du téléphone restent disponibles.')){
   locked();showConfig();note('Connexion impossible : '+errorText(e));
  }
  refreshStatus();
 }
}
async function loadConfig(){
 let cfg=null;
 try{const raw=localStorage.getItem(CFGKEY);if(raw)cfg=configFromText(raw);}catch{}
 if(!cfg&&navigator.onLine){
  try{const resp=await fetch('./firebase-config.json',{cache:'no-store'});if(resp.ok)cfg=configFromText(await resp.text());}catch{}
 }
 if(cfg)try{localStorage.setItem(CFGKEY,fmt(cfg));}catch{}
 return cfg;
}
el('beta-save-config').addEventListener('click',async()=>{
 const btn=el('beta-save-config');btn.disabled=true;
 try{const cfg=configFromText(el('beta-config-text').value);localStorage.setItem(CFGKEY,fmt(cfg));note('Configuration enregistrée sur ce téléphone.');await startFirebase(cfg);}
 catch(e){note('Configuration incorrecte : '+errorText(e));}
 finally{btn.disabled=false;}
});
el('beta-change-config').addEventListener('click',()=>{if(user){note('Déconnecte-toi avant de changer de projet Firebase.');return;}locked();showConfig()});
el('beta-login-form').addEventListener('submit',async e=>{
 e.preventDefault();if(!auth){note('Configure Firebase avant la connexion.');return;}
 const foyer=el('beta-foyer').value.trim();if(!/^[a-z0-9-]{3,80}$/.test(foyer)){note('Identifiant du foyer invalide.');return;}
 PATH[1]=foyer;localStorage.setItem(FOYERKEY,foyer);
 const btn=e.target.querySelector('button[type="submit"]');btn.disabled=true;
 try{
  note('Connexion au foyer de test…');await sdk.signInWithEmailAndPassword(auth,el('beta-email').value.trim(),el('beta-password').value);
  el('beta-password').value='';
 }catch(err){note(errorText(err));}finally{btn.disabled=false;}
});
el('beta-signout').addEventListener('click',async()=>{
 if(backlog()&&!confirm(`Tu as ${backlog()} modification(s) non synchronisée(s). Si tu te déconnectes, exporte une sauvegarde avant de continuer. Se déconnecter ?`))return;
 resetListeners();clearTimeout(saveTimer);clearTimeout(reconnectTimer);
 try{if(auth)await sdk.signOut(auth);}catch{}
 localStorage.removeItem(VERIFIED_KEY);
 // Garder la file locale pour éviter toute perte, mais retirer les données du compte affiché.
 user=null;currentEmail='';currentUserUID='';dirty=Object.create(null);conflicts.clear();
 B.resetLocal();location.reload();
});
el('beta-account-button').addEventListener('click',()=>{
 if(user){if(confirm(`Compte connecté : ${user.email}\n\nSe déconnecter de la bêta sur ce téléphone ?`))el('beta-signout').click();}
 else{locked();showLogin();if(!navigator.onLine)note('Connexion nécessaire pour renouveler ta session. Les données restent disponibles localement.');}
});
window.addEventListener('offline',()=>{disconnected=true;onlineReady=false;resetListeners();openOffline('Mode hors connexion : saisies conservées sur ce téléphone.');refreshStatus();});
window.addEventListener('online',()=>{disconnected=false;showStatus('Connexion rétablie — contrôle du foyer…','pending');reconnectSoon();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&navigator.onLine&&!onlineReady)reconnectSoon();});
window.addEventListener('focus',()=>{if(navigator.onLine&&!onlineReady)reconnectSoon();});

// Ne jamais bloquer le démarrage hors ligne si cet appareil a déjà été authentifié.
const previous=verifiedDevice();
if(previous){currentUserUID=previous.uid;currentEmail=previous.email;readDiskQueue();openingLocal=true;observed=flatten(B.state());
 unlocked();showStatus(`Données locales • ${backlog()} en attente`,'offline');
}else{locked();}
const cfg=await loadConfig();
if(cfg){
 if(navigator.onLine)await startFirebase(cfg);
 else openOffline('Hors connexion : la connexion Firebase se rétablira automatiquement.');
}else{
 if(!previous){showConfig();showStatus('Première connexion Firebase nécessaire','offline');}
 else{openOffline('Configuration Firebase indisponible : mode local accessible.');}
}
