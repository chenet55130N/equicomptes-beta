/**
 * ÉquiComptes V7 BÊTA — synchronisation de TEST en documents indépendants.
 * Aucun compte bancaire, nom, salaire, mot de passe ou clé privée dans ce fichier.
 * La config Web Firebase est publique; seules les règles Firestore autorisent les deux UID.
 */
// Le module doit démarrer même si les CDN Firebase sont inaccessibles.
// Les bibliothèques externes sont chargées seulement au moment de la connexion.
window.EQUI_SYNC_MODULE_LOADED = true;
let initializeApp, getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, setPersistence, browserLocalPersistence;
let getFirestore, collection, doc, getDocsFromServer, onSnapshot, setDoc, deleteDoc;
let sdkPromise = null;
async function loadFirebaseLibraries() {
 if (!sdkPromise) {
  sdkPromise=Promise.all([
   import('https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js'),
   import('https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js'),
   import('https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js')
  ]).then(([appLib, authLib, firestoreLib]) => {
    ({initializeApp}=appLib);
    ({getAuth,onAuthStateChanged,signInWithEmailAndPassword,signOut,setPersistence,browserLocalPersistence}=authLib);
    ({getFirestore,collection,doc,getDocsFromServer,onSnapshot,setDoc,deleteDoc}=firestoreLib);
  }).catch(e=>{sdkPromise=null;throw Error('Bibliothèques Firebase non chargées : vérifie ta connexion Internet, puis réessaie. Détail : '+String(e?.message||e).slice(0,160))});
 }
 return sdkPromise;
}


const B=window.EquiBetaBridge;
const el=id=>document.getElementById(id);
const CFGKEY='equicomptes-beta-v7-firebase-configuration';
const GROUPS=['settings','months','charges','incomes','expenses','settlements','history'];
const FOYERKEY='equicomptes-v7-beta-foyer-local';
const PATH=['foyers',localStorage.getItem(FOYERKEY)||''];
const json=x=>JSON.stringify(x);
let auth=null,db=null,ready=false,user=null,allUnsubs=[];
let shadow=new Map(),pending=new Set(),flushTimer=null,saving=0,queued=false;
const gate=el('beta-gate'),status=el('beta-sync-indicator'),message=el('beta-gate-message');
function note(text){if(message)message.textContent=text;else console.warn("ÉquiComptes : zone de message absente",text);}
function statusText(text){if(status)status.textContent='● '+text;else console.warn('ÉquiComptes : indicateur absent',text);}
function locked(){gate.hidden=false;ready=false;}
function unlocked(){gate.hidden=true;ready=true;}
function errText(e){const code=String(e?.code||'');
 if(code.includes('permission-denied'))return 'Accès refusé : vérifie les deux identifiants UID dans les règles Firestore publiées.';
 if(code.includes('wrong-password')||code.includes('invalid-credential')||code.includes('user-not-found'))return 'Identifiants incorrects. Vérifie l’adresse e-mail et le mot de passe Firebase.';
 if(code.includes('network')||!navigator.onLine)return 'Connexion indisponible. La bêta nécessite Internet pour la première connexion.';
 if(code.includes('operation-not-allowed'))return 'Active « E-mail / Mot de passe » dans Firebase Authentication.';
 return String(e?.message||'Erreur de connexion').slice(0,240);
}
function parseConfig(raw){
 let val={};const s=String(raw||'').trim();
 try{val=JSON.parse(s)}catch{}
 if(!val.apiKey){for(const key of ['apiKey','authDomain','projectId','appId']){
  const r=new RegExp('(?:["\\\']?'+key+'["\\\']?)\\s*:\\s*["\\\']([^"\\\']+)["\\\']');
  const m=s.match(r);if(m)val[key]=m[1];
 }}
 for(const key of ['apiKey','authDomain','projectId','appId'])if(!val[key]||typeof val[key]!=='string')throw Error('La configuration doit contenir '+key+'.');
 return Object.fromEntries(['apiKey','authDomain','projectId','appId'].map(k=>[k,val[k].trim()]));
}
function showConfig(){el('beta-config-panel').hidden=false;el('beta-login-form').hidden=true;el('beta-change-config').hidden=true;if(!el('beta-config-text').value.trim()){el('beta-config-text').value=localStorage.getItem(CFGKEY)||'';}note('Configuration Firebase : colle les paramètres Web. Aucune information bancaire ne doit être collée ici.');}
function showLogin(){el('beta-config-panel').hidden=true;el('beta-login-form').hidden=false;el('beta-change-config').hidden=false;el('beta-foyer').value=PATH[1];note('Connecte-toi avec ton compte Firebase et saisis le même identifiant privé du foyer sur vos deux téléphones.');}
function documentKey(group,id){return `${group}/${id}`;}
function snapValue(d){return d.data();}
function flatten(s){
 const result=new Map();
 result.set('settings/main',{settings:s.settings,incomeTemplates:s.incomeTemplates});
 for(const [id,x] of Object.entries(s.monthlySalaries||{}))result.set(documentKey('months',id),x);
 for(const [group,field,key] of [['charges','charges','id'],['incomes','additionalIncome','id'],['expenses','expenses','id'],['settlements','settlements','id'],['history','history','month']]){
  for(const x of s[field]||[])if(x&&x[key])result.set(documentKey(group,x[key]),x);
 }
 return result;
}
function serverBaseline(raw){const r=new Map();for(const [group,docs] of Object.entries(raw))for(const [id,value] of Object.entries(docs))r.set(documentKey(group,id),value);return r;}
function patchFromRemote(group,id,value){
 const key=documentKey(group,id);
 if(pending.has(key))return; // Une sauvegarde locale de cet élément est encore en cours.
 const was=shadow.get(key);
 if(value===null){if(!shadow.has(key))return;shadow.delete(key)}
 else{if(json(was)===json(value))return;shadow.set(key,value)}
 // Ne pas écraser une saisie locale en attente sur le même élément.
 const local=flatten(B.state()).get(key);
 if(local!==undefined && json(local)!==json(was) && was!==undefined){
  statusText('Attention : modification simultanée à vérifier');return;
 }
 B.patch(group,id,value);
 statusText(`Synchronisé : ${user?.email||'foyer de test'}`);
}
function clearSubscriptions(){for(const off of allUnsubs)try{off()}catch{}allUnsubs=[];clearTimeout(flushTimer);pending.clear();shadow.clear();ready=false;}
async function startCloud(currentUser){
 clearSubscriptions();locked();user=currentUser;el('beta-signout').hidden=false;
 if(!PATH[1]){showLogin();note('Renseigne d’abord le code privé du foyer, puis connecte-toi.');return;}
 note('Lecture de la base de TEST : aucune donnée de ta V6.4 n’est importée.');
 statusText('Connexion au foyer de test…');
 const server={};
 try{
  await Promise.all(GROUPS.map(async group=>{
   const docs=await getDocsFromServer(collection(db,...PATH,group));
   server[group]={};docs.forEach(d=>{server[group][d.id]=snapValue(d)});
  }));
 }catch(e){note(errText(e));statusText('Synchronisation inaccessible');return;}
 B.replaceAll(server);
 shadow=serverBaseline(server);
 // Observateurs en temps réel, chacun sur une petite catégorie et un document par entrée.
 for(const group of GROUPS){
  const unsub=onSnapshot(collection(db,...PATH,group),{includeMetadataChanges:true},snapshot=>{
   if(snapshot.metadata.fromCache)return; // L'initialisation vient d'exiger une lecture serveur.
   for(const ch of snapshot.docChanges()){
    if(ch.doc.metadata.hasPendingWrites)continue;
    patchFromRemote(group,ch.doc.id,ch.type==='removed'?null:ch.doc.data());
   }
  },e=>{statusText('Erreur de synchronisation');note(errText(e));locked()});
  allUnsubs.push(unsub);
 }
 unlocked();statusText(`Synchronisé : ${currentUser.email||'compte de test'}`);
}
async function flush(){
 if(!ready||!user||!db)return;
 if(!navigator.onLine){queued=true;statusText('Hors connexion — changements en attente');return;}
 const fresh=flatten(B.state());const ops=[];
 for(const [key,val] of fresh)if(json(shadow.get(key))!==json(val))ops.push({key,val,remove:false});
 for(const key of shadow.keys())if(!fresh.has(key))ops.push({key,remove:true});
 if(!ops.length){if(!saving)statusText(`Synchronisé : ${user.email}`);return;}
 // Écriture indépendante par facture/achat/revenu/mois pour limiter les écrasements croisés.
 saving+=ops.length;statusText(`${ops.length} modification(s) en cours d’enregistrement…`);
 for(const op of ops){
  const [group,id]=op.key.split('/');if(!GROUPS.includes(group)||!id)continue;
  const old=shadow.get(op.key),had=shadow.has(op.key);
  if(op.remove)shadow.delete(op.key);else shadow.set(op.key,op.val);
  pending.add(op.key);
  (op.remove?deleteDoc(doc(db,...PATH,group,id)):setDoc(doc(db,...PATH,group,id),op.val))
   .catch(e=>{
    if(had)shadow.set(op.key,old);else shadow.delete(op.key);
    statusText('Échec de synchronisation — réessaie');note(errText(e));
   }).finally(()=>{
    pending.delete(op.key);saving=Math.max(0,saving-1);
    if(ready&&saving===0&&navigator.onLine)statusText(`En ligne : ${user.email}`);
    if(ready&&queued){queued=false;scheduleFlush()}
   });
 }
}
function scheduleFlush(){if(!ready)return;clearTimeout(flushTimer);flushTimer=setTimeout(flush,850);}
window.EQUI_BETA_SYNC_HOOK=()=>scheduleFlush();
window.addEventListener('online',()=>{if(ready){statusText('Connexion rétablie — vérification…');scheduleFlush()}});
window.addEventListener('offline',()=>{if(ready)statusText('Hors ligne — synchronisation suspendue')});

async function startFirebase(config){
 locked();statusText('Chargement de Firebase…');note('Configuration reçue. Chargement sécurisé des bibliothèques Firebase…');
 try{
  await loadFirebaseLibraries();
  const app=initializeApp(config,'equicomptes-beta-foyer-test');
  auth=getAuth(app);db=getFirestore(app);
  await setPersistence(auth,browserLocalPersistence);
  showLogin();
  onAuthStateChanged(auth,async u=>{
   if(!u){clearSubscriptions();locked();user=null;el('beta-signout').hidden=true;showLogin();statusText('Non connecté');return;}
   await startCloud(u);
  },e=>{locked();note(errText(e));});
 }catch(e){showConfig();note('Connexion impossible : '+errText(e));statusText('Connexion Firebase indisponible');}
}
el('beta-save-config').addEventListener('click',async()=>{
 const button=el('beta-save-config');
 button.disabled=true;
 try{
  const cfg=parseConfig(el('beta-config-text').value);
  localStorage.setItem(CFGKEY,json(cfg));
  note('Configuration reconnue. Connexion à Firebase…');
  await startFirebase(cfg);
 }catch(e){note('Configuration incorrecte : '+errText(e));statusText('Vérifier la configuration Firebase')}
 finally{button.disabled=false}
});
el('beta-change-config').addEventListener('click',()=>{if(user){note('Déconnecte-toi avant de modifier le projet Firebase.');return;}showConfig();});
el('beta-login-form').addEventListener('submit',async e=>{
 e.preventDefault();if(!auth){note('Configure Firebase avant la connexion.');return;}
 const foyer=el('beta-foyer').value.trim();if(!/^[a-z0-9-]{3,80}$/.test(foyer)){note('Identifiant du foyer invalide.');return;}PATH[1]=foyer;localStorage.setItem(FOYERKEY,foyer);
 const button=e.target.querySelector('button[type=submit]');button.disabled=true;
 try{note('Connexion du compte de test…');await signInWithEmailAndPassword(auth,el('beta-email').value.trim(),el('beta-password').value);el('beta-password').value='';}
 catch(err){note(errText(err));}
 finally{button.disabled=false;}
});
el('beta-signout').addEventListener('click',async()=>{if(!auth)return;clearSubscriptions();await signOut(auth);B.resetLocal();location.reload()});
el('beta-account-button').addEventListener('click',()=>{
 if(user){if(confirm(`Compte connecté : ${user.email}\n\nSe déconnecter de la bêta sur ce téléphone ?`)){el('beta-signout').click()}}
 else {locked();showLogin()}
});

// Toujours permettre le paramétrage local si le fichier public n'a pas encore sa configuration.
let cfg=null;
try{const remote=await fetch('./firebase-config.json',{cache:'no-store'});if(remote.ok){const text=await remote.text();try{cfg=parseConfig(text)}catch{}}}catch{}
if(!cfg){try{cfg=parseConfig(localStorage.getItem(CFGKEY))}catch{}}
if(cfg){showLogin();await startFirebase(cfg)}
else{showConfig();statusText('Configuration Firebase nécessaire');}
