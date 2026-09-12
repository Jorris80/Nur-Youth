/* =====================================================================
   Nur Youth — Service Worker
   ---------------------------------------------------------------------
   PENTING: naikkan angka VERSI setiap kali Anda mengubah index.html
   atau app.js. Tanpa itu, pengguna lama tetap mendapat berkas dari
   cache versi sebelumnya.

   Strategi:
     • Kerangka aplikasi (HTML/JS/manifest/ikon) → cache-first, lalu
       disegarkan diam-diam. Aplikasi terbuka seketika dan tetap jalan
       tanpa internet.
     • Panggilan ke Apps Script (/exec) → jaringan dulu, cache sebagai
       cadangan saat offline.
     • API Qur'an & jadwal sholat → tampilkan cache dulu, perbarui di
       belakang layar.
   ===================================================================== */

var VERSI = 'nur-youth-v11';
var CACHE_KERANGKA = VERSI + '-kerangka';
var CACHE_DATA = VERSI + '-data';

var KERANGKA = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon.svg'
];

/* ============================ PEMASANGAN ============================ */

self.addEventListener('install', function (ev) {
  ev.waitUntil(
    caches.open(CACHE_KERANGKA).then(function (c) {
      // addAll gagal total bila satu berkas hilang, jadi tambahkan satu per satu
      return Promise.all(KERANGKA.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {
          console.warn('[SW] berkas dilewati karena belum ada:', u);
        });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

/* ============================= AKTIVASI ============================= */

self.addEventListener('activate', function (ev) {
  ev.waitUntil(
    caches.keys().then(function (kunci) {
      return Promise.all(kunci.map(function (k) {
        if (k !== CACHE_KERANGKA && k !== CACHE_DATA) {
          console.log('[SW] hapus cache lama:', k);
          return caches.delete(k);
        }
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* =========================== PENGAMBILAN =========================== */

self.addEventListener('fetch', function (ev) {
  var req = ev.request;

  // Hanya GET. POST ke Apps Script diurus antrean outbox di app.js.
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  var keAppsScript = url.hostname.indexOf('script.google') > -1 ||
                     url.hostname.indexOf('googleusercontent') > -1;
  var keApiLuar = /equran\.id|santrikoding|alquran\.cloud|myquran\.com/.test(url.hostname);

  if (keAppsScript) return ev.respondWith(jaringanDulu(req, CACHE_DATA));
  if (keApiLuar)    return ev.respondWith(cacheSambilSegarkan(req, CACHE_DATA));
  if (url.origin === self.location.origin) return ev.respondWith(cacheDulu(req, CACHE_KERANGKA));
});

/* ---------------------------- STRATEGI ---------------------------- */

/** Pakai cache bila ada; segarkan di belakang layar */
function cacheDulu(req, namaCache) {
  return caches.match(req).then(function (tersimpan) {
    if (tersimpan) {
      fetch(req).then(function (res) {
        if (res && res.ok) caches.open(namaCache).then(function (c) { c.put(req, res.clone()); });
      }).catch(function () {});
      return tersimpan;
    }
    return fetch(req).then(function (res) {
      if (res && res.ok) {
        var salinan = res.clone();
        caches.open(namaCache).then(function (c) { c.put(req, salinan); });
      }
      return res;
    }).catch(function () {
      if (req.mode === 'navigate') return caches.match('./index.html');
      return new Response('Sedang offline.', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    });
  });
}

/** Coba jaringan; jatuh ke cache saat offline */
function jaringanDulu(req, namaCache) {
  return fetch(req).then(function (res) {
    if (res && res.ok) {
      var salinan = res.clone();
      caches.open(namaCache).then(function (c) { c.put(req, salinan); });
    }
    return res;
  }).catch(function () {
    return caches.match(req).then(function (tersimpan) {
      return tersimpan || new Response(
        JSON.stringify({ ok: false, error: 'Sedang offline. Aplikasi memakai data yang tersimpan di perangkat.' }),
        { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    });
  });
}

/** Tampilkan cache seketika, lalu perbarui di belakang layar */
function cacheSambilSegarkan(req, namaCache) {
  return caches.open(namaCache).then(function (c) {
    return c.match(req).then(function (tersimpan) {
      var segar = fetch(req).then(function (res) {
        if (res && res.ok) c.put(req, res.clone());
        return res;
      }).catch(function () { return tersimpan; });
      return tersimpan || segar;
    });
  });
}

/* ======================= PESAN DARI HALAMAN ======================= */

self.addEventListener('message', function (ev) {
  var d = ev.data || {};

  if (d.tipe === 'LEWATI_TUNGGU') self.skipWaiting();

  if (d.tipe === 'BERSIHKAN_DATA') {
    caches.delete(CACHE_DATA).then(function () {
      if (ev.source) ev.source.postMessage({ tipe: 'DATA_DIBERSIHKAN' });
    });
  }
});

/* =================== SINKRONISASI LATAR BELAKANG =================== */

self.addEventListener('sync', function (ev) {
  if (ev.tag === 'sinkron-nur-youth') {
    ev.waitUntil(
      self.clients.matchAll().then(function (daftar) {
        daftar.forEach(function (k) { k.postMessage({ tipe: 'KIRIM_OUTBOX' }); });
      })
    );
  }
});

/* ====================== KLIK NOTIFIKASI ====================== */

self.addEventListener('notificationclick', function (ev) {
  ev.notification.close();
  ev.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (daftar) {
      for (var i = 0; i < daftar.length; i++) {
        if ('focus' in daftar[i]) return daftar[i].focus();
      }
      return self.clients.openWindow('./');
    })
  );
});
