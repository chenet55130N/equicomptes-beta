// ÉquiComptes V7.1 BÊTA : cache dédié, indépendant de la V6.4.
const CACHE='beta-equi-v7-20261106-offline-1';
const FILES=['./','./index.html','./manifest.webmanifest','./service-worker.js','./sync-beta.js','./firebase-config.json','./icon-192.png','./icon-512.png'];
const FIREBASE_SDK='https://www.gstatic.com/firebasejs/13.2.0/';
self.addEventListener('install',event=>{
 event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
 event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('beta-equi-v7-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});
async function fromCacheOrNetwork(request){
 const cache=await caches.open(CACHE);
 const hit=await cache.match(request);
 if(hit)return hit;
 const resp=await fetch(request);
 if(resp.ok){try{await cache.put(request,resp.clone())}catch{}}
 return resp;
}
async function navigation(request){
 try{const response=await fetch(request);if(response.ok){const cache=await caches.open(CACHE);cache.put('./index.html',response.clone()).catch(()=>{});}return response;}
 catch{const cached=await caches.match('./index.html');return cached||Response.error();}
}
self.addEventListener('fetch',event=>{
 const req=event.request;
 if(req.method!=='GET')return;
 const url=new URL(req.url);
 if(url.href.startsWith(FIREBASE_SDK)&&url.pathname.endsWith('.js')){
  // Garde chaque dépendance JS Firebase au premier chargement en ligne.
  event.respondWith(fromCacheOrNetwork(req));return;
 }
 if(url.origin!==self.location.origin)return;
 if(req.mode==='navigate'){
  event.respondWith(navigation(req));return;
 }
 if(url.pathname.endsWith('/sync-beta.js')||url.pathname.endsWith('/firebase-config.json')){
  event.respondWith(fromCacheOrNetwork(req));return;
 }
 event.respondWith(fromCacheOrNetwork(req));
});
