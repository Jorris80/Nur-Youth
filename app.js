/* =====================================================================
   WAJIB DIISI SEBELUM DIPAKAI
   ---------------------------------------------------------------------
   Tempelkan URL Web App Apps Script Anda di bawah ini.
   Cara mendapatkannya: buka Apps Script → Deploy → Kelola deployment →
   salin URL yang berakhiran /exec (atau lewat menu Spreadsheet
   "🕌 Nur Youth → Buka Aplikasi (URL Web App)").

   Contoh:
   var WEB_APP_URL_INJEKSI = "https://script.google.com/macros/s/AKfycb.../exec";
   ===================================================================== */
var WEB_APP_URL_INJEKSI = "https://script.google.com/macros/s/AKfycbxYerrbAVsQDEMjVudqiYN-Dn56nr5GVDS5J_ug0V-e9vX_GRQLMOuCYXe4bulOTyZN7g/exec";
var EMAIL_INJEKSI = "";

/* =====================================================================
   Nur Youth — mesin aplikasi
   Satu berkas ini dipakai dua kali:
     • disematkan di Index.html (Web App Apps Script)  -> transport google.script.run
     • dimuat oleh index.html di GitHub Pages (PWA)    -> transport fetch ke /exec
   Deteksi transport otomatis, jadi tidak ada kode bercabang di modul UI.
   ===================================================================== */
'use strict';

/* ===================== KONFIGURASI & KEADAAN ===================== */

var CFG = {
  /* Versi PWA GitHub: ganti nilai ini dengan URL Web App Apps Script Anda
     (Deploy → Kelola deployment → salin URL berakhiran /exec).
     Versi Web App: dibiarkan kosong, transport otomatis pakai google.script.run. */
  WEB_APP_URL: (typeof WEB_APP_URL_INJEKSI !== 'undefined' ? WEB_APP_URL_INJEKSI : ''),
  KUNCI_CACHE: 'nur_youth_cache_v1',
  KUNCI_OUTBOX: 'nur_youth_outbox_v1',
  KUNCI_TEMA: 'nur_youth_tema',
  KUNCI_EMAIL: 'nur_youth_email'
};

var S = {
  tab: 'quran',
  email: '',
  data: null,          // seluruh dataset dari muatDataAwal
  progres: null,
  pengingat: [],
  hafalan: {},         // "surahId:ayat" -> true
  dzikirHitung: {},
  surahAktif: 1,
  ayatSurah: [],
  kategoriMufrodat: 'Semua',
  kuis: null,
  tajwidAktif: null,
  kultumTab: 'kultum',
  kultumAktif: null,
  khutbahAktif: null,
  dzikirTab: 'pagi',
  sholatLangkah: 0,
  online: navigator.onLine,
  hasilAI: {},
  sibuk: {}
};

/* ===================== TRANSPORT (dua mode) ===================== */

var PakaiGoogleScriptRun = (typeof google !== 'undefined' && google.script && google.script.run);

/**
 * Panggil satu aksi backend.
 * @returns {Promise<Object>} { ok, data } atau { ok:false, error }
 */
function panggil(action, payload) {
  payload = payload || {};
  if (!payload.email && S.email) payload.email = S.email;

  if (PakaiGoogleScriptRun) {
    return new Promise(function (selesai, gagal) {
      google.script.run
        .withSuccessHandler(selesai)
        .withFailureHandler(function (e) { gagal(new Error(e && e.message ? e.message : String(e))); })
        .api(action, payload);
    });
  }

  if (!CFG.WEB_APP_URL) {
    return Promise.reject(new Error('WEB_APP_URL belum diisi di app.js. Tempelkan URL Web App Apps Script Anda.'));
  }

  // text/plain menghindari preflight CORS terhadap Apps Script
  return fetch(CFG.WEB_APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, payload: payload }),
    redirect: 'follow'
  }).then(function (r) {
    if (!r.ok) throw new Error('Server menjawab HTTP ' + r.status);
    return r.json();
  });
}

/** Panggilan tulis yang aman offline: masuk antrean bila jaringan mati */
function panggilTulis(action, payload) {
  if (!navigator.onLine) {
    tambahOutbox(action, payload);
    return Promise.resolve({ ok: true, tertunda: true, data: null });
  }
  return panggil(action, payload).catch(function (err) {
    tambahOutbox(action, payload);
    throw err;
  });
}

/* ===================== CACHE OFFLINE & OUTBOX ===================== */

function simpanCache(kunci, nilai) {
  try {
    var c = JSON.parse(localStorage.getItem(CFG.KUNCI_CACHE) || '{}');
    c[kunci] = { t: Date.now(), v: nilai };
    localStorage.setItem(CFG.KUNCI_CACHE, JSON.stringify(c));
  } catch (e) { /* kuota penuh — tidak fatal */ }
}

function ambilCache(kunci) {
  try {
    var c = JSON.parse(localStorage.getItem(CFG.KUNCI_CACHE) || '{}');
    return c[kunci] ? c[kunci].v : null;
  } catch (e) { return null; }
}

function tambahOutbox(action, payload) {
  try {
    var q = JSON.parse(localStorage.getItem(CFG.KUNCI_OUTBOX) || '[]');
    q.push({ action: action, payload: payload, waktu: Date.now() });
    localStorage.setItem(CFG.KUNCI_OUTBOX, JSON.stringify(q));
    perbaruiStatusJaringan();
  } catch (e) {}
}

function jumlahOutbox() {
  try { return JSON.parse(localStorage.getItem(CFG.KUNCI_OUTBOX) || '[]').length; }
  catch (e) { return 0; }
}

/** Kirim ulang semua perubahan yang tertunda saat koneksi kembali */
function kirimOutbox() {
  var q;
  try { q = JSON.parse(localStorage.getItem(CFG.KUNCI_OUTBOX) || '[]'); } catch (e) { return; }
  if (!q.length || !navigator.onLine) return;

  lonceng('Menyinkronkan ' + q.length + ' perubahan tertunda…');
  var berikut = q.shift();
  localStorage.setItem(CFG.KUNCI_OUTBOX, JSON.stringify(q));

  panggil(berikut.action, berikut.payload)
    .then(function () {
      if (q.length) return kirimOutbox();
      lonceng('Semua perubahan tersinkron.', 2600);
      return segarkanProgres();
    })
    .catch(function () {
      // gagal lagi: kembalikan ke depan antrean, coba nanti
      q.unshift(berikut);
      localStorage.setItem(CFG.KUNCI_OUTBOX, JSON.stringify(q));
      perbaruiStatusJaringan();
    });
}

/* ===================== PEMBANTU TAMPILAN ===================== */

function $(sel, akar) { return (akar || document).querySelector(sel); }
function el(id) { return document.getElementById(id); }

function esc(teks) {
  return String(teks === undefined || teks === null ? '' : teks)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Teks panjang -> HTML dengan paragraf, tetap aman dari injeksi */
function paragraf(teks) {
  return String(teks || '').split(/\n{2,}/)
    .map(function (p) { return '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>'; })
    .join('');
}

var _timerLonceng = null;
function lonceng(pesan, durasi) {
  var n = el('lonceng');
  if (!n) return;
  n.textContent = pesan;
  n.classList.remove('sembunyi');
  clearTimeout(_timerLonceng);
  if (durasi !== 0) {
    _timerLonceng = setTimeout(function () { n.classList.add('sembunyi'); }, durasi || 3200);
  }
}

function perbaruiStatusJaringan() {
  S.online = navigator.onLine;
  var pil = el('pil-jaringan');
  var tertunda = jumlahOutbox();
  if (!pil) return;
  if (!S.online) {
    pil.className = 'pil pil-api';
    pil.textContent = '⚡ Offline' + (tertunda ? ' · ' + tertunda + ' tertunda' : '');
  } else if (tertunda) {
    pil.className = 'pil pil-api';
    pil.textContent = '⏳ ' + tertunda + ' tertunda';
  } else {
    pil.className = 'pil';
    pil.textContent = '● Online';
  }
}

/* ===================== SUARA (pengganti audioUtils) ===================== */

var Suara = {
  teksKini: null,
  _daftar: [],
  _tahan: [],        // tahan referensi utterance agar tidak dibuang GC (bug Chrome)
  _pemompa: null,    // penjaga agar pembacaan panjang tidak berhenti sendiri
  _pernahIngat: {},

  /** Petunjuk pemasangan suara sesuai sistem operasi yang dipakai */
  _panduanPasangSuara: function () {
    var u = (navigator && navigator.userAgent) || '';
    if (/Android/i.test(u)) {
      return 'Pasang lewat Pengaturan → Bahasa & Masukan → Keluaran Teks-ke-Ucapan → Mesin Google → Pasang data suara → Arab.';
    }
    if (/iPhone|iPad|iPod/i.test(u)) {
      return 'Pasang lewat Pengaturan → Aksesibilitas → Konten yang Diucapkan → Suara → Arab.';
    }
    if (/Windows/i.test(u)) {
      return 'Pasang lewat Settings → Time & Language → Language & region → Add a language → العربية, centang Text-to-speech, lalu tutup dan buka ulang Chrome.';
    }
    if (/Mac OS X|Macintosh/i.test(u)) {
      return 'Pasang lewat System Settings → Accessibility → Spoken Content → System Voice → Manage Voices → Arabic.';
    }
    return 'Pasang paket suara Arab melalui pengaturan teks-ke-ucapan sistem Anda.';
  },

  siap: function () { return typeof speechSynthesis !== 'undefined'; },

  /**
   * Muat daftar suara perangkat.
   * Di Chrome/Android daftar ini KOSONG pada pemanggilan pertama dan baru
   * terisi setelah event 'voiceschanged', jadi harus dipasang pendengarnya.
   */
  muatSuara: function () {
    if (!Suara.siap()) return;
    var d = window.speechSynthesis.getVoices() || [];
    if (d.length) Suara._daftar = d;
  },

  pasangPendengarSuara: function () {
    if (!Suara.siap()) return;
    Suara.muatSuara();
    try { window.speechSynthesis.onvoiceschanged = Suara.muatSuara; } catch (e) {}
    // Sebagian peramban tidak pernah memicu onvoiceschanged — jajak beberapa kali.
    var n = 0;
    var jajak = setInterval(function () {
      Suara.muatSuara();
      if (Suara._daftar.length || ++n > 10) clearInterval(jajak);
    }, 300);
  },

  hentikan: function () {
    if (Suara.siap()) { try { window.speechSynthesis.cancel(); } catch (e) {} }
    if (Suara._pemompa) { clearInterval(Suara._pemompa); Suara._pemompa = null; }
    Suara._tahan = [];
    Suara.teksKini = null;
    Suara._tandaiTombol(false);
  },

  sedangBicara: function () {
    if (!Suara.siap()) return false;
    return window.speechSynthesis.speaking || window.speechSynthesis.pending;
  },

  /** Tandai tombol suara yang sedang aktif (bila ada) */
  _tandaiTombol: function (aktif) {
    try {
      var t = document.querySelectorAll('[data-ucap],[data-ucap-id]');
      for (var i = 0; i < t.length; i++) t[i].classList.toggle('sedang-bicara', !!aktif);
    } catch (e) {}
  },

  /** Pilih suara paling cocok untuk kode bahasa (mis. 'ar-SA' -> ar apa pun) */
  _pilih: function (bahasa) {
    var d = Suara._daftar;
    if (!d.length) return null;
    var kode = String(bahasa || 'ar-SA').toLowerCase().replace('_', '-');
    var pendek = kode.slice(0, 2);
    var persis = null, sebagian = null;
    for (var i = 0; i < d.length; i++) {
      var l = String(d[i].lang || '').toLowerCase().replace('_', '-');
      if (l === kode) { persis = d[i]; break; }
      if (!sebagian && l.slice(0, 2) === pendek) sebagian = d[i];
    }
    return persis || sebagian;
  },

  /** Apakah perangkat punya suara untuk bahasa ini? */
  adaSuara: function (bahasa) { Suara.muatSuara(); return !!Suara._pilih(bahasa); },

  /** Pecah teks panjang; mesin TTS sering memotong di sekitar 200-300 karakter */
  _potong: function (teks, maks) {
    maks = maks || 180;
    var sisa = String(teks).trim();
    var hasil = [];
    while (sisa.length > maks) {
      var potong = sisa.slice(0, maks);
      var batas = Math.max(
        potong.lastIndexOf('۔'), potong.lastIndexOf('.'),
        potong.lastIndexOf('،'), potong.lastIndexOf(','),
        potong.lastIndexOf(' ')
      );
      if (batas < maks * 0.5) batas = maks;
      hasil.push(sisa.slice(0, batas + 1).trim());
      sisa = sisa.slice(batas + 1).trim();
    }
    if (sisa) hasil.push(sisa);
    return hasil;
  },

  /**
   * Baca teks. Menekan tombol yang sama akan menghentikan pembacaan.
   * Menangani tiga jebakan umum Web Speech API:
   *  1. daftar suara yang belum termuat saat pemanggilan pertama
   *  2. cancel() lalu speak() beruntun yang membuat suara tidak keluar di Chrome
   *  3. pembacaan panjang yang berhenti sendiri setelah belasan detik
   */
  ucap: function (teks, bahasa, laju) {
    if (!Suara.siap()) {
      lonceng('Peramban ini belum mendukung pembacaan suara. Coba Chrome, Edge, atau Safari terbaru.');
      return;
    }
    teks = String(teks || '').trim();
    if (!teks) return;

    // Tekan lagi tombol yang sama = berhenti
    if (Suara.teksKini === teks && Suara.sedangBicara()) { Suara.hentikan(); return; }

    Suara.hentikan();
    if (typeof Murottal !== 'undefined') Murottal.hentikan();  // jangan tumpang tindih
    Suara.muatSuara();
    Suara.teksKini = teks;

    var bhs = bahasa || 'ar-SA';
    var suara = Suara._pilih(bhs);

    // Beri tahu sekali saja bila perangkat tidak punya suara untuk bahasa ini.
    // Suara non-Arab yang disodori huruf Arab menghasilkan DIAM, bukan error.
    // Lebih jujur berhenti di sini dan menjelaskan, daripada pura-pura membaca.
    if (!suara && Suara._daftar.length && bhs.slice(0, 2) === 'ar') {
      Suara.teksKini = null;
      lonceng('Perangkat ini belum punya suara Bahasa Arab, jadi teks Arab tidak bisa dibacakan. ' +
              Suara._panduanPasangSuara() +
              ' Khusus Al-Qur\'an tidak perlu itu — tombol 🔊 pada ayat akan memutar murottal qari asli.', 9000);
      return;
    }

    var bagian = Suara._potong(teks, 180);

    // Chrome menelan ucapan bila speak() dipanggil tepat setelah cancel().
    setTimeout(function () {
      for (var i = 0; i < bagian.length; i++) {
        var u = new SpeechSynthesisUtterance(bagian[i]);
        u.lang = bhs;
        u.rate = laju || (String(bhs).slice(0, 2) === 'id' ? 0.9 : 0.72);
        u.pitch = 1;
        u.volume = 1;
        if (suara) u.voice = suara;

        if (i === 0) u.onstart = function () { Suara._tandaiTombol(true); };
        if (i === bagian.length - 1) {
          u.onend = function () { Suara.hentikan(); };
        }
        u.onerror = function (ev) {
          var sebab = (ev && ev.error) || '';
          Suara.hentikan();
          if (sebab && sebab !== 'interrupted' && sebab !== 'canceled') {
            lonceng('Pembacaan suara gagal (' + sebab + '). Pastikan volume aktif dan halaman tidak dibisukan.');
          }
        };

        Suara._tahan.push(u);           // cegah utterance dibuang GC di tengah jalan
        window.speechSynthesis.speak(u);
      }

      // Chrome menjeda sendiri pembacaan yang lebih dari ~15 detik.
      Suara._pemompa = setInterval(function () {
        if (!window.speechSynthesis.speaking) { clearInterval(Suara._pemompa); Suara._pemompa = null; return; }
        try { window.speechSynthesis.pause(); window.speechSynthesis.resume(); } catch (e) {}
      }, 9000);
    }, 130);
  }
};

/* ===================== MUROTTAL (audio bacaan asli) ===================== */

var Murottal = {
  _el: null, _antre: [], _idx: 0, urlKini: null,

  _audio: function () {
    if (!Murottal._el) {
      Murottal._el = new Audio();
      Murottal._el.preload = 'none';
      Murottal._el.addEventListener('ended', function () { Murottal._lanjut(); });
      Murottal._el.addEventListener('error', function () {
        Murottal.hentikan();
        lonceng('Audio murottal gagal dimuat. Periksa koneksi internet lalu coba lagi.');
      });
    }
    return Murottal._el;
  },

  sedangMain: function () { return !!Murottal._el && !Murottal._el.paused && !Murottal._el.ended; },

  hentikan: function () {
    if (Murottal._el) { try { Murottal._el.pause(); } catch (e) {} }
    Murottal._antre = []; Murottal._idx = 0; Murottal.urlKini = null;
    Suara._tandaiTombol(false);
  },

  _lanjut: function () {
    Murottal._idx++;
    if (Murottal._idx >= Murottal._antre.length) { Murottal.hentikan(); return; }
    Murottal._mainkanIndeks();
  },

  _mainkanIndeks: function () {
    var a = Murottal._audio();
    a.src = Murottal._antre[Murottal._idx];
    var p = a.play();
    if (p && p.catch) p.catch(function () {
      Murottal.hentikan();
      lonceng('Peramban memblokir pemutaran otomatis. Ketuk tombolnya sekali lagi.');
    });
  },

  /** Mainkan satu/beberapa URL berurutan. Menekan tombol yang sama = berhenti. */
  mainkan: function (daftar) {
    daftar = [].concat(daftar).filter(Boolean);
    if (!daftar.length) return false;
    if (Murottal.urlKini === daftar[0] && Murottal.sedangMain()) { Murottal.hentikan(); return true; }
    Suara.hentikan();
    Murottal.hentikan();
    Murottal._antre = daftar; Murottal._idx = 0; Murottal.urlKini = daftar[0];
    Murottal._mainkanIndeks();
    Suara._tandaiTombol(true);
    return true;
  }
};

/* ===================== DASBOR GURU ===================== */

/**
 * Tab ini hanya muncul bagi pengguna yang mengampu minimal satu kelas.
 * Nilai jual utamanya bukan angka total, melainkan daftar "perlu perhatian":
 * siapa yang streak-nya putus, lama tidak aktif, atau di bawah target.
 */

function muatStatusGuru() {
  return panggil('apakahGuru', {})
    .then(function (r) {
      S.guru = !!(r.ok && r.data && r.data.guru);
      if (S.guru && TAB.every(function (t) { return t.id !== 'guru'; })) {
        TAB.push({ id: 'guru', ikon: '👨‍🏫', label: 'Dasbor Guru' });
        gambarNav();
      }
      return S.guru;
    })
    .catch(function () { S.guru = false; return false; });
}

function muatKelas(pilihId) {
  return panggil('daftarKelas', {}).then(function (r) {
    S.kelas = (r.ok && r.data) || [];
    if (pilihId) S.kelasAktif = pilihId;
    if (!S.kelasAktif && S.kelas.length) S.kelasAktif = S.kelas[0].kelasId;
    if (S.kelasAktif) return muatDasbor(S.kelasAktif);
    S.dasbor = null;
    gambarModul();
  });
}

function muatDasbor(kelasId) {
  S.dasborMemuat = true;
  gambarModul();
  return panggil('dasborGuru', { kelasId: kelasId })
    .then(function (r) {
      S.dasborMemuat = false;
      if (r.ok && r.data) { S.dasbor = r.data; S.kelasAktif = kelasId; }
      else lonceng(r.error || 'Dasbor gagal dimuat.');
      gambarModul();
    })
    .catch(function (e) {
      S.dasborMemuat = false;
      lonceng('Gagal memuat dasbor: ' + e.message);
      gambarModul();
    });
}

function modulGuru() {
  if (!S.kelas) { muatKelas(); return '<div class="kosong"><span class="memuat"></span>Memuat kelas…</div>'; }

  var h = '<div class="modul-judul"><h2>👨‍🏫 Dasbor Guru</h2>' +
          '<p class="modul-ket">Pantau hafalan seluruh santri dalam satu tabel. ' +
          'Santri yang perlu perhatian otomatis naik ke urutan atas.</p></div>';

  /* --- pemilih kelas --- */
  h += '<div class="kartu"><div class="kartu-judul">KELAS / HALAQAH</div>';
  if (!S.kelas.length) {
    h += '<div class="kosong" style="padding:18px 0">' +
         '<span class="kosong-ikon">🏫</span>Belum ada kelas.<br>' +
         'Buat kelas pertama untuk mulai memantau santri.</div>';
  } else {
    h += '<div class="baris-pil">' + S.kelas.map(function (k) {
      return '<button class="tbl ' + (k.kelasId === S.kelasAktif ? 'tbl-utama' : 'tbl-garis') +
             '" data-pilih-kelas="' + esc(k.kelasId) + '">' + esc(k.nama) +
             ' <span class="cacah">' + k.jumlahAnggota + '</span></button>';
    }).join('') + '</div>';
  }
  h += '<div class="baris-aksi" style="margin-top:12px">' +
       '<button class="tbl tbl-utama" data-aksi-guru="kelas-baru">+ Kelas Baru</button>' +
       (S.kelasAktif ? '<button class="tbl tbl-garis" data-aksi-guru="tambah-santri">+ Tambah Santri</button>' +
                       '<button class="tbl tbl-garis" data-aksi-guru="ekspor">⬇ Ekspor CSV</button>' +
                       '<button class="tbl tbl-garis" data-aksi-guru="segarkan">↻ Segarkan</button>' : '') +
       '</div></div>';

  if (S.dasborMemuat) return h + '<div class="kosong"><span class="memuat"></span>Memuat dasbor…</div>';
  if (!S.dasbor) return h;

  var d = S.dasbor, r = d.ringkas;

  /* --- ringkasan --- */
  h += '<div class="kartu"><div class="kartu-judul">RINGKASAN ' + esc(d.kelas.nama.toUpperCase()) + '</div>' +
       '<div class="grid-statistik">' +
       _kotakStat(r.jumlahSantri, 'Santri') +
       _kotakStat(r.sudahMulai, 'Sudah mulai') +
       _kotakStat(r.perluPerhatian, 'Perlu perhatian', r.perluPerhatian ? 'awas' : '') +
       _kotakStat(r.ayatPekanIni, 'Ayat pekan ini') +
       _kotakStat(r.totalAyatHafal, 'Total ayat hafal') +
       _kotakStat(r.rerataPoin, 'Rerata poin') +
       '</div>' +
       '<p class="modul-ket" style="margin-top:10px">Target kelas: ' +
       d.kelas.targetAyatHarian + ' ayat/hari per santri.</p></div>';

  /* --- yang perlu perhatian --- */
  var awas = d.santri.filter(function (s) { return s.perhatian.length; });
  if (awas.length) {
    h += '<div class="kartu kartu-awas"><div class="kartu-judul">⚠ PERLU PERHATIAN (' + awas.length + ')</div>' +
         awas.map(function (s) {
           return '<div class="baris-awas"><strong>' + esc(s.nama) + '</strong>' +
                  '<span>' + s.perhatian.map(esc).join(' · ') + '</span></div>';
         }).join('') + '</div>';
  }

  /* --- tabel santri --- */
  h += '<div class="kartu"><div class="kartu-judul">SEMUA SANTRI</div>' +
       '<div class="gulir-x"><table class="tabel-guru"><thead><tr>' +
       '<th>Santri</th><th>Poin</th><th>Lv</th><th>🔥</th>' +
       '<th>Ayat</th><th>Pekan</th><th>30 hr</th><th>Kuis</th>' +
       '<th>Mufrodat</th><th>Terakhir aktif</th><th></th></tr></thead><tbody>';

  h += d.santri.map(function (s) {
    var kelasBaris = s.perhatian.length ? ' class="baris-perhatian"' : '';
    return '<tr' + kelasBaris + '>' +
      '<td><strong>' + esc(s.nama) + '</strong><br><span class="samar">' + esc(s.email) + '</span></td>' +
      '<td>' + s.poin + '</td>' +
      '<td>' + (s.belumMulai ? '–' : s.level) + '</td>' +
      '<td>' + (s.belumMulai ? '–' : s.streak) + '</td>' +
      '<td>' + s.ayatHafal + '</td>' +
      '<td>' + s.ayat7Hari + '</td>' +
      '<td>' + s.ayat30Hari + '</td>' +
      '<td>' + s.kuis + '</td>' +
      '<td>' + s.mufrodat + '</td>' +
      '<td>' + esc(s.belumMulai ? 'Belum pernah' : s.terakhirAktif) + '</td>' +
      '<td><button class="tbl tbl-garis tbl-kecil" data-hapus-santri="' + esc(s.email) + '" title="Keluarkan dari kelas">✕</button></td>' +
      '</tr>';
  }).join('');

  h += '</tbody></table></div></div>';
  return h;
}

function _kotakStat(nilai, label, gaya) {
  return '<div class="kotak-stat' + (gaya ? ' ' + gaya : '') + '">' +
         '<div class="stat-angka">' + nilai + '</div>' +
         '<div class="stat-label">' + esc(label) + '</div></div>';
}

/* --- aksi --- */

function aksiGuru(nama) {
  if (nama === 'kelas-baru') {
    var n = prompt('Nama kelas / halaqah baru:\n(contoh: Tahfidz Kelas 7A)');
    if (!n || !n.trim()) return;
    var t = prompt('Target ayat per hari untuk kelas ini:', '10');
    lonceng('Membuat kelas…', 0);
    panggil('buatKelas', { nama: n.trim(), keterangan: '', target: Number(t) || 10 })
      .then(function (r) {
        if (!r.ok) return lonceng(r.error || 'Kelas gagal dibuat.');
        lonceng('Kelas "' + n.trim() + '" dibuat.', 2500);
        S.kelasAktif = r.data.kelasId;
        muatKelas(r.data.kelasId);
      })
      .catch(function (e) { lonceng('Gagal: ' + e.message); });
    return;
  }

  if (nama === 'tambah-santri') {
    var teks = prompt(
      'Masukkan email santri, satu per baris.\n' +
      'Boleh disertai nama, dipisah koma:\n\n' +
      'contoh:\nahmad@sekolah.sch.id, Ahmad Fauzi\nsiti@sekolah.sch.id, Siti Aminah');
    if (!teks || !teks.trim()) return;
    lonceng('Menambahkan santri…', 0);
    panggil('tambahAnggotaMassal', { kelasId: S.kelasAktif, teks: teks })
      .then(function (r) {
        if (!r.ok) return lonceng(r.error || 'Gagal menambahkan.');
        var p = r.data.berhasil + ' santri ditambahkan.';
        if (r.data.gagal.length) p += ' ' + r.data.gagal.length + ' gagal: ' + r.data.gagal.join(', ');
        lonceng(p, 5000);
        muatDasbor(S.kelasAktif);
      })
      .catch(function (e) { lonceng('Gagal: ' + e.message); });
    return;
  }

  if (nama === 'ekspor') {
    lonceng('Menyiapkan berkas…', 0);
    panggil('eksporCsvKelas', { kelasId: S.kelasAktif })
      .then(function (r) {
        if (!r.ok) return lonceng(r.error || 'Ekspor gagal.');
        // BOM agar Excel membaca UTF-8 dengan benar
        var blob = new Blob(['\ufeff' + r.data.isi], { type: 'text/csv;charset=utf-8;' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = r.data.namaBerkas;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        lonceng('Berkas CSV diunduh.', 2500);
      })
      .catch(function (e) { lonceng('Gagal: ' + e.message); });
    return;
  }

  if (nama === 'segarkan') muatDasbor(S.kelasAktif);
}

function keluarkanSantri(email) {
  if (!confirm('Keluarkan ' + email + ' dari kelas ini?\n\nProgres santri tidak dihapus, hanya keanggotaannya.')) return;
  panggil('hapusAnggota', { kelasId: S.kelasAktif, emailSiswa: email })
    .then(function (r) {
      if (!r.ok) return lonceng(r.error || 'Gagal mengeluarkan santri.');
      lonceng('Santri dikeluarkan dari kelas.', 2200);
      muatDasbor(S.kelasAktif);
    })
    .catch(function (e) { lonceng('Gagal: ' + e.message); });
}

/* ===================== TABEL NAVIGASI ===================== */

var TAB = [
  { id: 'quran',    ikon: '📖', label: "Hafalan Qur'an" },
  { id: 'arabic',   ikon: '🔤', label: 'Bahasa Arab & Kuis' },
  { id: 'tajweed',  ikon: '🎙️', label: 'Tajwid Interaktif' },
  { id: 'kultum',   ikon: '🕌', label: "Ceramah & Khutbah Jum'at" },
  { id: 'dhikr',    ikon: '🤲', label: 'Dzikir & Doa' },
  { id: 'sholat',   ikon: '🧭', label: 'Tuntunan Sholat' },
  { id: 'calendar', ikon: '📅', label: 'Kalender Belajar' },
  { id: 'progress', ikon: '🏆', label: 'Progres & Poin' }
];

function gantiTab(id) {
  S.tab = id;
  Suara.hentikan();
  gambarNav();
  gambarModul();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function gambarNav() {
  el('nav-isi').innerHTML = TAB.map(function (t) {
    return '<button class="nav-tab' + (S.tab === t.id ? ' aktif' : '') +
           '" data-tab="' + t.id + '"><span>' + t.ikon + '</span><span>' + esc(t.label) + '</span></button>';
  }).join('');
}

/* ===================== HEADER ===================== */

function gambarHeader() {
  var p = S.progres || {};
  el('pil-poin').textContent = '⭐ ' + (p.points || 0) + ' XP';
  el('pil-level').textContent = 'Lv ' + (p.level || 1);
  el('pil-streak').textContent = '🔥 ' + (p.streakDays || 0) + ' hari';
  perbaruiStatusJaringan();
}

function cariGlobal(kata) {
  var q = String(kata || '').trim().toLowerCase();
  var kotak = el('cari-hasil');
  if (q.length < 2) { kotak.classList.add('sembunyi'); kotak.innerHTML = ''; return; }
  if (!S.data) return;

  var hasil = [];
  (S.data.surah || []).forEach(function (s) {
    if ((s.nameLatin + ' ' + s.meaning + ' ' + s.nameArabic).toLowerCase().indexOf(q) > -1) {
      hasil.push({ jenis: 'surah', id: s.id, judul: s.nameLatin, ket: 'Surah ke-' + s.id + ' · ' + s.meaning + ' · ' + s.versesCount + ' ayat' });
    }
  });
  (S.data.mufrodat || []).forEach(function (v) {
    if ((v.arabic + ' ' + v.latin + ' ' + v.indonesian).toLowerCase().indexOf(q) > -1) {
      hasil.push({ jenis: 'mufrodat', id: v.id, judul: v.indonesian + ' — ' + v.arabic, ket: 'Mufrodat · ' + v.category });
    }
  });
  (S.data.tajwid || []).forEach(function (t) {
    if ((t.title + ' ' + t.category + ' ' + t.description).toLowerCase().indexOf(q) > -1) {
      hasil.push({ jenis: 'tajwid', id: t.id, judul: t.title, ket: 'Tajwid · ' + t.category });
    }
  });
  (S.data.dzikir || []).concat(S.data.doa || []).forEach(function (d) {
    if ((d.title + ' ' + d.translation).toLowerCase().indexOf(q) > -1) {
      hasil.push({ jenis: 'dzikir', id: d.id, judul: d.title, ket: (d.type === 'doa' ? 'Doa harian' : 'Dzikir ' + d.type) });
    }
  });
  (S.data.kultum || []).forEach(function (k) {
    if ((k.title + ' ' + k.summary + ' ' + k.category).toLowerCase().indexOf(q) > -1) {
      hasil.push({ jenis: 'kultum', id: k.id, judul: k.title, ket: 'Kultum · ' + k.speaker });
    }
  });

  hasil = hasil.slice(0, 12);
  kotak.classList.remove('sembunyi');
  kotak.innerHTML = hasil.length
    ? hasil.map(function (h) {
        return '<div class="cari-item" data-jenis="' + h.jenis + '" data-id="' + esc(h.id) + '">' +
               esc(h.judul) + '<small>' + esc(h.ket) + '</small></div>';
      }).join('')
    : '<div class="cari-kosong">Tidak ada hasil untuk "' + esc(kata) + '"</div>';
}

function bukaHasilCari(jenis, id) {
  el('cari-hasil').classList.add('sembunyi');
  el('cari-input').value = '';
  if (jenis === 'surah')    { S.surahAktif = Number(id); gantiTab('quran'); muatAyat(Number(id)); }
  if (jenis === 'mufrodat') { gantiTab('arabic'); }
  if (jenis === 'tajwid')   { S.tajwidAktif = id; gantiTab('tajweed'); }
  if (jenis === 'dzikir')   { gantiTab('dhikr'); }
  if (jenis === 'kultum')   { S.kultumAktif = id; S.kultumTab = 'kultum'; gantiTab('kultum'); }
}

/* ===================== TEMA ===================== */

function terapkanTema(tema) {
  document.documentElement.setAttribute('data-tema', tema);
  try { localStorage.setItem(CFG.KUNCI_TEMA, tema); } catch (e) {}
  el('tbl-tema').textContent = tema === 'gelap' ? '☀️' : '🌙';
}

function balikTema() {
  terapkanTema(document.documentElement.getAttribute('data-tema') === 'gelap' ? 'terang' : 'gelap');
}

/* =====================================================================
   MODUL 1 — HAFALAN QUR'AN
   ===================================================================== */

function modulQuran() {
  var daftar = S.data.surah || [];
  var surah = daftar.filter(function (s) { return s.id === S.surahAktif; })[0] || daftar[0];
  if (!surah) return '<div class="kosong">Data surah belum tersedia.</div>';

  var opsi = daftar.map(function (s) {
    return '<option value="' + s.id + '"' + (s.id === surah.id ? ' selected' : '') + '>' +
           s.id + '. ' + esc(s.nameLatin) + ' (' + s.versesCount + ' ayat)</option>';
  }).join('');

  var hafal = 0;
  Object.keys(S.hafalan).forEach(function (k) { if (k.indexOf(surah.id + ':') === 0) hafal++; });
  var persen = surah.versesCount ? Math.round(hafal / surah.versesCount * 100) : 0;
  var p = S.progres || {};
  var target = p.dailyVerseGoal || 10, hariIni = p.todayVersesCount || 0;

  var ayat = S.ayatSurah.length ? S.ayatSurah : (surah.verses || []);

  return '' +
    '<div class="judul-modul"><h2>📖 Hafalan Al-Qur\'an</h2>' +
      '<span>' + daftar.length + ' surah tersedia · ' + (p.memorizedVersesCount || 0) + ' ayat sudah dihafal</span></div>' +
    '<p class="sub-modul">Pilih surah, dengarkan bacaannya, lalu tandai ayat yang sudah hafal untuk mengumpulkan poin.</p>' +

    '<div class="kisi-2">' +
      '<div class="kartu">' +
        '<span class="label">Pilih surah</span>' +
        '<select id="pilih-surah" style="margin-top:8px">' + opsi + '</select>' +
        '<div style="margin-top:14px"><div class="arab-kecil" style="font-size:26px">' + esc(surah.nameArabic) + '</div>' +
        '<div style="font-weight:700;font-size:17px;margin-top:4px">' + esc(surah.nameLatin) + '</div>' +
        '<div class="terjemah">' + esc(surah.meaning) + ' · Juz ' + surah.juz + '</div></div>' +
        '<hr class="pemisah">' +
        '<div class="baris-tbl" style="justify-content:space-between">' +
          '<span class="label">Hafalan surah ini</span><b>' + hafal + '/' + surah.versesCount + '</b></div>' +
        '<div class="bar" style="margin-top:7px"><div class="bar-isi" style="width:' + persen + '%"></div></div>' +
      '</div>' +

      '<div class="kartu">' +
        '<span class="label">Target harian</span>' +
        '<div style="font-size:31px;font-weight:800;letter-spacing:-1px;margin:6px 0 2px">' +
          hariIni + ' <span style="font-size:15px;font-weight:600;color:var(--tinta-lembut)">/ ' + target + ' ayat</span></div>' +
        '<div class="bar"><div class="bar-isi" style="width:' + Math.min(100, Math.round(hariIni / target * 100)) + '%"></div></div>' +
        '<hr class="pemisah">' +
        '<div class="baris-tbl">' +
          '<button class="tbl tbl-kecil" id="tbl-muat-ayat">🔄 Muat ayat lengkap online</button>' +
          '<button class="tbl tbl-garis tbl-kecil" id="tbl-baca-surah">🔊 Bacakan 3 ayat pertama</button>' +
        '</div>' +
        '<p class="terjemah" style="margin:10px 0 0;font-size:12px">Ayat yang sudah dimuat tersimpan di perangkat, jadi bisa dibuka lagi tanpa internet.</p>' +
      '</div>' +
    '</div>' +

    '<div class="kartu">' +
      '<div class="judul-modul" style="margin-bottom:10px"><h2 style="font-size:16px">Daftar Ayat</h2>' +
        '<span>' + ayat.length + ' ayat dimuat' + (S.ayatSurah.length ? ' (lengkap)' : ' (cuplikan bawaan)') + '</span></div>' +
      (ayat.length ? ayat.map(function (a) { return barisAyat(surah.id, a); }).join('')
                   : '<div class="kosong"><span class="kosong-ikon">📥</span>Tekan "Muat ayat lengkap online" untuk mengunduh seluruh ayat surah ini.</div>') +
    '</div>';
}

function barisAyat(surahId, a) {
  var kunci = surahId + ':' + a.number;
  var sudah = !!S.hafalan[kunci];
  return '<div class="ayat' + (sudah ? ' hafal' : '') + '">' +
    '<div class="ayat-atas">' +
      '<span class="nomor-ayat">' + a.number + '</span>' +
      '<div class="baris-tbl">' +
        '<button class="tbl tbl-garis tbl-kecil" data-dengar="' + kunci + '" title="Dengarkan bacaan">🔊</button>' +
        '<button class="tbl' + (sudah ? '' : ' tbl-garis') + ' tbl-kecil" data-hafal="' + kunci + '">' +
          (sudah ? '✓ Hafal' : 'Tandai hafal') + '</button>' +
      '</div>' +
    '</div>' +
    '<div class="arab">' + esc(a.arabic) + '</div>' +
    (a.latin ? '<div class="latin" style="margin-top:6px">' + esc(a.latin) + '</div>' : '') +
    '<div class="terjemah" style="margin-top:5px">' + esc(a.translation) + '</div>' +
  '</div>';
}

function muatAyat(surahId, selesai) {
  var kunciCache = 'ayat_' + surahId;
  var lokal = ambilCache(kunciCache);
  if (lokal && lokal.length) { S.ayatSurah = lokal; gambarModul(); }

  if (!navigator.onLine) {
    if (!lokal) lonceng('Sedang offline. Ayat lengkap butuh koneksi, sementara ini memakai data bawaan.');
    return;
  }

  lonceng('Memuat ayat surah ' + surahId + '…', 0);
  panggil('ambilAyat', { surahId: surahId })
    .then(function (r) {
      if (r.ok && r.data && r.data.ayat) {
        S.ayatSurah = r.data.ayat;
        simpanCache(kunciCache, r.data.ayat);
        lonceng(r.data.ayat.length + ' ayat dimuat (' + r.data.sumber + ').', 2400);
      } else {
        lonceng(r.error || 'Ayat gagal dimuat.');
      }
      gambarModul();
      if (typeof selesai === 'function') selesai();
    })
    .catch(function (e) { lonceng('Gagal memuat ayat: ' + e.message); });
}

/**
 * Dengarkan satu ayat. Urutan: murottal qari -> ambil online dulu -> TTS.
 * Cuplikan bawaan tidak menyertakan audio, jadi ayat lengkap diambil otomatis.
 */
function dengarAyat(kunci) {
  var bagian = String(kunci).split(':');
  var surahId = Number(bagian[0]), nomor = Number(bagian[1]);

  function cari() {
    var sumber = S.ayatSurah.length ? S.ayatSurah
      : ((S.data.surah || []).filter(function (s) { return s.id === surahId; })[0] || {}).verses || [];
    return sumber.filter(function (a) { return Number(a.number) === nomor; })[0];
  }

  var a = cari();
  if (a && a.audioUrl) return void Murottal.mainkan(a.audioUrl);

  if (navigator.onLine && !S.ayatSurah.length) {
    lonceng('Mengambil murottal…', 0);
    return void muatAyat(surahId, function () {
      var b = cari();
      if (b && b.audioUrl) { lonceng('', 1); Murottal.mainkan(b.audioUrl); }
      else _ttsAyat(b || a);
    });
  }
  _ttsAyat(a);
}

function _ttsAyat(a) {
  if (!a) return lonceng('Ayat tidak ditemukan.');
  if (!Suara.adaSuara('ar')) {
    lonceng('Belum ada murottal tersimpan dan perangkat ini tidak punya suara Bahasa Arab. ' +
            'Sambungkan internet lalu tekan "Muat ayat lengkap online" untuk memutar bacaan qari asli.', 9000);
    return;
  }
  Suara.ucap(a.arabic, 'ar-SA');
}

function tandaiHafal(kunci) {
  var bagian = kunci.split(':');
  var aktif = !S.hafalan[kunci];
  if (aktif) S.hafalan[kunci] = true; else delete S.hafalan[kunci];
  simpanCache('hafalan', S.hafalan);
  gambarModul();

  panggilTulis('tandaiHafalan', { surahId: Number(bagian[0]), nomorAyat: Number(bagian[1]), status: aktif })
    .then(function (r) {
      if (r.tertunda) { lonceng('Disimpan di perangkat. Akan tersinkron saat online.', 2600); return; }
      if (r.ok && r.data && r.data.progres) { S.progres = r.data.progres; simpanCache('progres', S.progres); gambarHeader(); gambarModul(); }
      if (aktif) lonceng('+' + 10 + ' XP · ayat ditandai hafal', 2200);
    })
    .catch(function () { lonceng('Tersimpan lokal, sinkronisasi ditunda.', 2600); });
}

/* =====================================================================
   MODUL 2 — BAHASA ARAB & KUIS
   ===================================================================== */

function modulArab() {
  var kategori = S.data.kategoriMufrodat || ['Semua'];
  var semua = S.data.mufrodat || [];
  var dikuasai = (S.progres && S.progres.masteredVocabIds) || [];
  var tampil = S.kategoriMufrodat === 'Semua' ? semua
             : semua.filter(function (v) { return v.category === S.kategoriMufrodat; });

  var html = '' +
    '<div class="judul-modul"><h2>🔤 Bahasa Arab & Kuis</h2>' +
      '<span>' + semua.length + ' mufrodat · ' + dikuasai.length + ' dikuasai</span></div>' +
    '<p class="sub-modul">Hafalkan kosakata, uji dengan kuis, atau minta AI mengoreksi kalimat Arab buatan Anda.</p>' +

    '<div class="kartu">' +
      '<span class="label">Tutor kalimat Arab (AI)</span>' +
      '<textarea id="input-tutor" placeholder="Tulis kalimat Bahasa Arab, misalnya: انا اذهب الى المدرسة" style="margin-top:8px"></textarea>' +
      '<div class="baris-tbl" style="margin-top:9px">' +
        '<button class="tbl" id="tbl-tutor">' + (S.sibuk.tutor ? '<span class="memuat"></span>Memproses…' : '✨ Koreksi & jelaskan') + '</button>' +
      '</div>' +
      kartuHasilAI('tutor') +
    '</div>';

  html += '<div class="kartu"><div class="baris-tbl" style="justify-content:space-between">' +
    '<span class="label">Kamus mufrodat</span>' +
    '<button class="tbl tbl-clay tbl-kecil" id="tbl-mulai-kuis">🎯 Mulai kuis (' + (S.data.kuisArab || []).length + ' soal)</button>' +
    '</div><div class="baris-tbl" style="margin-top:10px">' +
    kategori.map(function (k) {
      return '<button class="tbl tbl-kecil' + (S.kategoriMufrodat === k ? '' : ' tbl-garis') +
             '" data-kategori="' + esc(k) + '">' + esc(k) + '</button>';
    }).join('') + '</div></div>';

  html += '<div class="kisi">' + tampil.map(function (v) {
    var sudah = dikuasai.indexOf(v.id) > -1;
    return '<div class="kartu" style="margin:0">' +
      '<div class="baris-tbl" style="justify-content:space-between;align-items:flex-start">' +
        '<span class="tag">' + esc(v.category) + '</span>' +
        '<button class="tbl tbl-garis tbl-kecil" data-ucap="' + esc(v.arabic) + '">🔊</button></div>' +
      '<div class="arab-kecil" style="margin:9px 0 3px;font-size:25px">' + esc(v.arabic) + '</div>' +
      '<div class="latin">' + esc(v.latin) + '</div>' +
      '<div style="font-weight:600;margin-top:3px">' + esc(v.indonesian) + '</div>' +
      (v.exampleSentence ? '<div class="terjemah" style="margin-top:7px;font-size:12.5px">Contoh: ' + esc(v.exampleSentence) + '</div>' : '') +
      '<button class="tbl' + (sudah ? '' : ' tbl-garis') + ' tbl-kecil" style="margin-top:11px;width:100%" data-mufrodat="' + esc(v.id) + '">' +
        (sudah ? '✓ Sudah dikuasai' : 'Tandai dikuasai (+5 XP)') + '</button>' +
    '</div>';
  }).join('') + '</div>';

  return html;
}

/* ---- kuis ---- */

function mulaiKuis() {
  var soal = (S.data.kuisArab || []).slice();
  for (var i = soal.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = soal[i]; soal[i] = soal[j]; soal[j] = t;
  }
  S.kuis = { soal: soal.slice(0, 10), ke: 0, benar: 0, jawab: null, selesai: false };
  gambarModul();
}

function modulKuis() {
  var k = S.kuis;
  if (k.selesai) {
    var nilai = Math.round(k.benar / k.soal.length * 100);
    return '<div class="kartu" style="text-align:center;padding:34px 18px">' +
      '<div style="font-size:46px">' + (nilai >= 80 ? '🎉' : nilai >= 50 ? '💪' : '📚') + '</div>' +
      '<h2 style="margin:8px 0 4px">Nilai Anda ' + nilai + '</h2>' +
      '<p class="terjemah">' + k.benar + ' benar dari ' + k.soal.length + ' soal' +
        (nilai === 100 ? ' · bonus sempurna +10 XP' : '') + '</p>' +
      '<div class="baris-tbl" style="justify-content:center;margin-top:16px">' +
        '<button class="tbl" id="tbl-mulai-kuis">Ulangi kuis</button>' +
        '<button class="tbl tbl-garis" id="tbl-tutup-kuis">Kembali ke kamus</button>' +
      '</div></div>';
  }

  var s = k.soal[k.ke];
  return '<div class="judul-modul"><h2>🎯 Kuis Mufrodat</h2><span>Soal ' + (k.ke + 1) + ' dari ' + k.soal.length + '</span></div>' +
    '<div class="bar" style="margin-bottom:14px"><div class="bar-isi" style="width:' + Math.round(k.ke / k.soal.length * 100) + '%"></div></div>' +
    '<div class="kartu">' +
      (s.arabicWord ? '<div class="arab-kecil" style="font-size:31px;text-align:center;margin-bottom:10px">' + esc(s.arabicWord) + '</div>' : '') +
      '<p style="font-weight:600;font-size:15.5px;margin:0 0 14px">' + esc(s.question) + '</p>' +
      s.options.map(function (o, i) {
        var kelas = 'opsi';
        if (k.jawab !== null) {
          if (i === s.correctAnswer) kelas += ' benar';
          else if (i === k.jawab) kelas += ' salah';
        }
        return '<button class="' + kelas + '" data-jawab="' + i + '"' + (k.jawab !== null ? ' disabled' : '') + '>' +
               String.fromCharCode(65 + i) + '. ' + esc(o) + '</button>';
      }).join('') +
      (k.jawab !== null
        ? '<div class="kabar ' + (k.jawab === s.correctAnswer ? 'kabar-sukses' : 'kabar-peringatan') + '" style="margin-top:12px">' +
          '<b>' + (k.jawab === s.correctAnswer ? 'Tepat!' : 'Belum tepat.') + '</b> ' + esc(s.explanation) + '</div>' +
          '<button class="tbl" id="tbl-kuis-lanjut" style="margin-top:6px">' +
          (k.ke + 1 >= k.soal.length ? 'Lihat hasil' : 'Soal berikutnya') + ' →</button>'
        : '') +
    '</div>';
}

function jawabKuis(idx) {
  var k = S.kuis;
  if (k.jawab !== null) return;
  k.jawab = idx;
  if (idx === k.soal[k.ke].correctAnswer) k.benar++;
  gambarModul();
}

function lanjutKuis() {
  var k = S.kuis;
  if (k.ke + 1 >= k.soal.length) {
    k.selesai = true;
    panggilTulis('catatKuis', { benar: k.benar, total: k.soal.length })
      .then(function (r) {
        if (r.ok && r.data && r.data.progres) { S.progres = r.data.progres; simpanCache('progres', S.progres); gambarHeader(); }
      }).catch(function () {});
  } else {
    k.ke++; k.jawab = null;
  }
  gambarModul();
}

/* =====================================================================
   MODUL 3 — TAJWID INTERAKTIF
   ===================================================================== */

function modulTajwid() {
  var aturan = S.data.tajwid || [];
  var makhraj = S.data.makhraj || [];
  var pilih = aturan.filter(function (r) { return r.id === S.tajwidAktif; })[0];

  var html = '<div class="judul-modul"><h2>🎙️ Tajwid Interaktif</h2>' +
    '<span>' + aturan.length + ' hukum tajwid · ' + makhraj.length + ' kelompok makhraj</span></div>' +
    '<p class="sub-modul">Pelajari hukum bacaan, dengarkan contohnya, lalu uji pelafalan Anda dengan mikrofon.</p>' +

    '<div class="kartu">' +
      '<span class="label">Tanya AI soal tajwid</span>' +
      '<textarea id="input-tajwid" placeholder="Contoh: jelaskan hukum tajwid pada kata مِنْ رَبِّهِمْ" style="margin-top:8px"></textarea>' +
      '<div class="baris-tbl" style="margin-top:9px">' +
        '<button class="tbl" id="tbl-tanya-tajwid">' + (S.sibuk.tajwid ? '<span class="memuat"></span>Menganalisis…' : '✨ Analisis bacaan') + '</button>' +
      '</div>' + kartuHasilAI('tajwid') +
    '</div>';

  if (pilih) {
    html += '<div class="kartu">' +
      '<div class="baris-tbl" style="justify-content:space-between"><span class="tag">' + esc(pilih.category) + '</span>' +
        '<button class="tbl tbl-garis tbl-kecil" id="tbl-tutup-tajwid">✕ Tutup</button></div>' +
      '<h3 style="margin:9px 0 5px">' + esc(pilih.title) + '</h3>' +
      '<p class="terjemah" style="margin:0 0 12px">' + esc(pilih.description) + '</p>' +
      (pilih.audioGuideNote ? '<div class="kabar">🎧 ' + esc(pilih.audioGuideNote) + '</div>' : '') +
      (pilih.examples || []).map(function (c) {
        return '<div class="ayat"><div class="ayat-atas">' +
          '<span class="tag tag-clay">' + esc(c.highlightWord || 'contoh') + '</span>' +
          '<div class="baris-tbl">' +
            '<button class="tbl tbl-garis tbl-kecil" data-ucap="' + esc(c.arabic) + '">🔊 Dengar</button>' +
            '<button class="tbl tbl-kecil" data-uji="' + esc(c.arabic) + '" data-aturan="' + esc(pilih.title) + '">🎤 Uji lafal</button>' +
          '</div></div>' +
          '<div class="arab">' + esc(c.arabic) + '</div>' +
          '<div class="latin" style="margin-top:5px">' + esc(c.latin) + '</div>' +
          '<div class="terjemah" style="margin-top:4px">' + esc(c.note) + '</div></div>';
      }).join('') +
      kartuHasilAI('lafal') +
    '</div>';
  }

  html += '<div class="kisi">' + aturan.map(function (r) {
    return '<div class="kartu kartu-klik" style="margin:0" data-tajwid="' + esc(r.id) + '">' +
      '<span class="tag">' + esc(r.category) + '</span>' +
      '<h3 style="margin:9px 0 5px;font-size:15.5px">' + esc(r.title) + '</h3>' +
      '<p class="terjemah" style="margin:0;font-size:12.5px">' + esc(String(r.description).slice(0, 120)) + '…</p>' +
      '<div class="terjemah" style="margin-top:8px;font-size:11.5px">' + (r.examples || []).length + ' contoh bacaan →</div>' +
    '</div>';
  }).join('') + '</div>';

  html += '<div class="judul-modul" style="margin-top:22px"><h2 style="font-size:17px">🗣️ Makharijul Huruf</h2>' +
    '<span>Tempat keluarnya huruf hijaiyah</span></div>' +
    '<div class="kisi">' + makhraj.map(function (m) {
      return '<div class="kartu" style="margin:0">' +
        '<span class="tag">' + esc(m.organGroup) + '</span>' +
        '<div class="arab-kecil" style="font-size:27px;margin:9px 0 3px">' + esc(m.lettersArabicFull) + '</div>' +
        '<div class="latin">' + esc(m.lettersLatin) + '</div>' +
        '<div style="font-weight:600;font-size:13px;margin-top:6px">' + esc(m.locationName) + '</div>' +
        '<p class="terjemah" style="margin:5px 0 0;font-size:12.5px">' + esc(m.description) + '</p>' +
        '<hr class="pemisah">' +
        '<div class="baris-tbl" style="justify-content:space-between">' +
          '<div><div class="arab-kecil" style="font-size:20px">' + esc(m.exampleWordArabic) + '</div>' +
          '<div class="latin" style="font-size:12px">' + esc(m.exampleWordLatin) + '</div></div>' +
          '<button class="tbl tbl-garis tbl-kecil" data-ucap="' + esc(m.exampleWordArabic) + '">🔊</button></div>' +
      '</div>';
    }).join('') + '</div>';

  return html;
}

/** Uji pelafalan dengan Web Speech API, penilaian dikirim ke backend */
function ujiLafal(target, namaAturan) {
  var Pengenal = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Pengenal) {
    lonceng('Peramban ini belum mendukung pengenalan suara. Coba Chrome di Android atau desktop.');
    return;
  }
  var r = new Pengenal();
  r.lang = 'ar-SA';
  r.interimResults = false;
  r.maxAlternatives = 1;

  lonceng('🎤 Silakan baca: ' + target, 0);
  r.onresult = function (ev) {
    var teks = ev.results[0][0].transcript;
    lonceng('Menilai pelafalan…', 0);
    S.sibuk.lafal = true; gambarModul();
    panggil('verifikasiLafal', { targetText: target, transcribedText: teks, ruleName: namaAturan })
      .then(function (res) {
        S.sibuk.lafal = false;
        S.hasilAI.lafal = res.ok ? res.data : { error: res.error };
        S.hasilAI.lafal.transkripsi = teks;
        lonceng('Penilaian selesai.', 2200);
        gambarModul();
      })
      .catch(function (e) {
        S.sibuk.lafal = false;
        S.hasilAI.lafal = { error: e.message };
        gambarModul();
      });
  };
  r.onerror = function (ev) { lonceng('Mikrofon gagal: ' + ev.error + '. Pastikan izin mikrofon diberikan.'); };
  r.onend = function () { if (!S.sibuk.lafal) setTimeout(function () { lonceng('', 1); }, 400); };
  try { r.start(); } catch (e) { lonceng('Tidak bisa memulai mikrofon: ' + e.message); }
}

/* =====================================================================
   MODUL 4 — CERAMAH & KHUTBAH JUM'AT
   ===================================================================== */

function modulKultum() {
  var html = '<div class="judul-modul"><h2>🕌 Ceramah & Khutbah Jum\'at</h2>' +
    '<span>' + (S.data.kultum || []).length + ' kultum · ' + (S.data.khutbah || []).length + ' khutbah</span></div>' +
    '<p class="sub-modul">Baca materi siap pakai, atau minta AI menyusun kultum 7 menit dan khutbah Jum\'at lengkap sesuai topik Anda.</p>' +
    '<div class="baris-tbl" style="margin-bottom:14px">' +
      '<button class="tbl' + (S.kultumTab === 'kultum' ? '' : ' tbl-garis') + '" data-ktab="kultum">Kultum 7 Menit</button>' +
      '<button class="tbl' + (S.kultumTab === 'khutbah' ? '' : ' tbl-garis') + '" data-ktab="khutbah">Khutbah Jum\'at</button>' +
    '</div>';

  if (S.kultumTab === 'kultum') {
    var k = S.kultumAktif ? (S.data.kultum || []).concat(S.hasilAI.kultumDaftar || [])
              .filter(function (x) { return x.id === S.kultumAktif; })[0] : null;

    html += '<div class="kartu">' +
      '<span class="label">Buat kultum baru dengan AI</span>' +
      '<input type="text" id="input-kultum" placeholder="Topik, contoh: menjaga sholat di tengah kesibukan sekolah" style="margin-top:8px">' +
      '<div class="baris-tbl" style="margin-top:9px">' +
        '<button class="tbl" id="tbl-buat-kultum">' + (S.sibuk.kultum ? '<span class="memuat"></span>Menyusun…' : '✨ Susun kultum 7 menit') + '</button>' +
      '</div>' + kartuHasilAI('kultum') + '</div>';

    if (k) html += tampilKultum(k);

    html += '<div class="kisi">' + (S.data.kultum || []).map(function (x) {
      var dibaca = ((S.progres && S.progres.readKultumIds) || []).indexOf(x.id) > -1;
      return '<div class="kartu kartu-klik" style="margin:0" data-kultum="' + esc(x.id) + '">' +
        '<div class="baris-tbl" style="justify-content:space-between"><span class="tag">' + esc(x.category) + '</span>' +
        (dibaca ? '<span class="tag tag-clay">✓ dibaca</span>' : '<span class="terjemah" style="font-size:11.5px">' + x.durationMinutes + ' menit</span>') + '</div>' +
        '<h3 style="margin:9px 0 5px;font-size:15.5px">' + esc(x.title) + '</h3>' +
        '<div class="terjemah" style="font-size:12px">' + esc(x.speaker) + '</div>' +
        '<p class="terjemah" style="margin:7px 0 0;font-size:12.5px">' + esc(String(x.summary).slice(0, 130)) + '…</p>' +
      '</div>';
    }).join('') + '</div>';

  } else {
    var kh = S.khutbahAktif ? (S.data.khutbah || []).filter(function (x) { return x.id === S.khutbahAktif; })[0] : null;
    if (!kh && S.hasilAI.khutbah && S.hasilAI.khutbah.khutbahPertama) kh = null;

    html += '<div class="kartu">' +
      '<span class="label">Buat khutbah Jum\'at dengan AI</span>' +
      '<input type="text" id="input-khutbah" placeholder="Topik, contoh: amanah dalam pekerjaan" style="margin-top:8px">' +
      '<input type="text" id="input-tema" placeholder="Tema khusus (opsional)" style="margin-top:8px">' +
      '<div class="baris-tbl" style="margin-top:9px">' +
        '<button class="tbl" id="tbl-buat-khutbah">' + (S.sibuk.khutbah ? '<span class="memuat"></span>Menyusun…' : '✨ Susun khutbah lengkap') + '</button>' +
      '</div>' +
      (S.hasilAI.khutbah && S.hasilAI.khutbah.khutbahPertama ? '' : kartuHasilAI('khutbah')) + '</div>';

    if (S.hasilAI.khutbah && S.hasilAI.khutbah.khutbahPertama) html += tampilKhutbah(S.hasilAI.khutbah);
    if (kh) html += tampilKhutbah(kh);

    html += '<div class="kisi">' + (S.data.khutbah || []).map(function (x) {
      return '<div class="kartu kartu-klik" style="margin:0" data-khutbah="' + esc(x.id) + '">' +
        '<span class="tag">' + esc(x.theme) + '</span>' +
        '<h3 style="margin:9px 0 5px;font-size:15.5px">' + esc(x.title) + '</h3>' +
        '<div class="terjemah" style="font-size:12px">' + esc(x.khotib) + ' · ' + x.durationMinutes + ' menit</div>' +
        '<p class="terjemah" style="margin:7px 0 0;font-size:12.5px">' + esc(String(x.summary).slice(0, 130)) + '…</p>' +
      '</div>';
    }).join('') + '</div>';
  }

  return html;
}

function tampilKultum(k) {
  return '<div class="kartu">' +
    '<div class="baris-tbl" style="justify-content:space-between">' +
      '<span class="tag">' + esc(k.category || 'Kultum') + '</span>' +
      '<div class="baris-tbl">' +
        '<button class="tbl tbl-garis tbl-kecil" data-ucap-id="' + esc(String(k.fullText).slice(0, 400)) + '">🔊 Bacakan</button>' +
        '<button class="tbl tbl-garis tbl-kecil" id="tbl-tutup-kultum">✕</button></div></div>' +
    '<h2 style="margin:10px 0 3px;font-size:19px">' + esc(k.title) + '</h2>' +
    '<div class="terjemah" style="font-size:12.5px">' + esc(k.speaker) + ' · ' + (k.durationMinutes || 7) + ' menit</div>' +
    '<div class="kabar" style="margin-top:12px">' + esc(k.summary) + '</div>' +
    '<div style="font-size:14.5px;line-height:1.85">' + paragraf(k.fullText) + '</div>' +
    (k.keyPoints && k.keyPoints.length
      ? '<hr class="pemisah"><span class="label">Poin penting</span><ul style="margin:8px 0 0;padding-left:20px">' +
        k.keyPoints.map(function (p) { return '<li style="margin-bottom:5px">' + esc(p) + '</li>'; }).join('') + '</ul>'
      : '') +
    (k.reflectionQuestion ? '<div class="kabar kabar-peringatan" style="margin-top:13px">💭 <b>Refleksi:</b> ' + esc(k.reflectionQuestion) + '</div>' : '') +
    '<button class="tbl" style="margin-top:6px" data-tandai-kultum="' + esc(k.id) + '">✓ Selesai dibaca (+25 XP)</button>' +
  '</div>';
}

function tampilKhutbah(k) {
  function bagian(judul, isi, arab1, latin1, arab2, latin2, terjemah) {
    return '<hr class="pemisah"><span class="label">' + judul + '</span>' +
      (arab1 ? '<div class="arab" style="margin:9px 0 4px">' + esc(arab1) + '</div>' : '') +
      (latin1 ? '<div class="latin" style="margin-bottom:9px">' + esc(latin1) + '</div>' : '') +
      (isi ? '<div style="font-size:14.5px;line-height:1.85">' + paragraf(isi) + '</div>' : '') +
      (arab2 ? '<div class="arab" style="margin:11px 0 4px">' + esc(arab2) + '</div>' : '') +
      (latin2 ? '<div class="latin">' + esc(latin2) + '</div>' : '') +
      (terjemah ? '<div class="terjemah" style="margin-top:6px">' + esc(terjemah) + '</div>' : '');
  }

  var p1 = k.khutbahPertama || {}, p2 = k.khutbahKedua || {};
  return '<div class="kartu">' +
    '<div class="baris-tbl" style="justify-content:space-between">' +
      '<span class="tag">' + esc(k.theme || 'Khutbah') + '</span>' +
      '<button class="tbl tbl-garis tbl-kecil" id="tbl-tutup-khutbah">✕</button></div>' +
    '<h2 style="margin:10px 0 3px;font-size:19px">' + esc(k.title) + '</h2>' +
    '<div class="terjemah" style="font-size:12.5px">' + esc(k.khotib || '-') + ' · ' + (k.durationMinutes || 15) + ' menit' +
      (k.sumber === 'MATERI_BAWAAN' ? ' · materi bawaan' : k.sumber === 'AI' ? ' · disusun AI' : '') + '</div>' +
    (k.catatan ? '<div class="kabar kabar-peringatan" style="margin-top:11px">' + esc(k.catatan) + '</div>' : '') +
    (k.summary ? '<div class="kabar" style="margin-top:11px">' + esc(k.summary) + '</div>' : '') +
    bagian('Khutbah Pertama', p1.content, p1.mukaddimahArabic, p1.mukaddimahLatin, p1.closingArabic, p1.closingLatin) +
    bagian('Khutbah Kedua', p2.content, p2.mukaddimahArabic, p2.mukaddimahLatin, p2.doaArabic, p2.doaLatin, p2.doaTranslation) +
    (k.keyMessages && k.keyMessages.length
      ? '<hr class="pemisah"><span class="label">Pesan kunci</span><ul style="margin:8px 0 0;padding-left:20px">' +
        k.keyMessages.map(function (m) { return '<li style="margin-bottom:5px">' + esc(m) + '</li>'; }).join('') + '</ul>'
      : '') +
  '</div>';
}

/* =====================================================================
   MODUL 5 — DZIKIR & DOA
   ===================================================================== */

function modulDzikir() {
  var pagiSore = S.data.dzikir || [];
  var doa = S.data.doa || [];
  var tampil = S.dzikirTab === 'doa' ? doa
    : pagiSore.filter(function (d) { return d.type === 'pagi_sore' || d.type === S.dzikirTab; });

  return '<div class="judul-modul"><h2>🤲 Dzikir & Doa Harian</h2>' +
      '<span>' + pagiSore.length + ' dzikir · ' + doa.length + ' doa</span></div>' +
    '<p class="sub-modul">Tasbih digital menghitung dzikir Anda dan menyimpannya per hari. Dzikir yang tuntas menambah 20 XP.</p>' +
    '<div class="baris-tbl" style="margin-bottom:14px">' +
      ['pagi', 'sore', 'doa'].map(function (t) {
        var nama = t === 'pagi' ? '🌅 Dzikir Pagi' : t === 'sore' ? '🌇 Dzikir Sore' : '📿 Doa Harian';
        return '<button class="tbl' + (S.dzikirTab === t ? '' : ' tbl-garis') + '" data-dtab="' + t + '">' + nama + '</button>';
      }).join('') +
    '</div>' +
    (tampil.length ? tampil.map(kartuDzikir).join('')
                   : '<div class="kosong"><span class="kosong-ikon">📿</span>Belum ada materi untuk kategori ini.</div>');
}

function kartuDzikir(d) {
  var st = S.dzikirHitung[d.id] || { hitungan: 0, target: d.targetCount };
  var target = d.targetCount || 1;
  var kini = Math.min(st.hitungan || 0, target);
  var tuntas = kini >= target;

  return '<div class="kartu">' +
    '<div class="baris-tbl" style="justify-content:space-between;align-items:flex-start">' +
      '<div><h3 style="margin:0 0 3px;font-size:15.5px">' + esc(d.title) + '</h3>' +
      '<span class="tag">' + (d.type === 'doa' ? 'Doa' : 'Dzikir ' + d.type.replace('_', ' & ')) + ' · ' + target + '×</span></div>' +
      '<button class="tbl tbl-garis tbl-kecil" data-ucap="' + esc(d.arabic) + '">🔊</button></div>' +
    '<div class="arab" style="margin:13px 0 7px">' + esc(d.arabic) + '</div>' +
    '<div class="latin">' + esc(d.latin) + '</div>' +
    '<div class="terjemah" style="margin-top:6px">' + esc(d.translation) + '</div>' +
    (d.notes ? '<div class="kabar" style="margin-top:11px;font-size:12.5px">💡 ' + esc(d.notes) + '</div>' : '') +
    '<hr class="pemisah">' +
    '<div class="tasbih">' +
      '<div class="tasbih-angka">' + kini + ' <span style="font-size:17px;color:var(--tinta-lembut)">/ ' + target + '</span></div>' +
      '<div class="bar" style="max-width:260px;margin:9px auto 0"><div class="bar-isi" style="width:' + Math.round(kini / target * 100) + '%"></div></div>' +
      (tuntas
        ? '<div class="kabar kabar-sukses" style="margin:13px auto 0;max-width:300px">✓ Alhamdulillah, dzikir ini tuntas hari ini.</div>'
        : '<button class="tasbih-tbl" data-tasbih="' + esc(d.id) + '" data-target="' + target + '">Tasbih<br>+1</button>') +
      '<div class="baris-tbl" style="justify-content:center;margin-top:7px">' +
        '<button class="tbl tbl-garis tbl-kecil" data-reset-tasbih="' + esc(d.id) + '">Ulang dari 0</button></div>' +
    '</div></div>';
}

function tambahTasbih(id, target) {
  var st = S.dzikirHitung[id] || { hitungan: 0, target: target };
  st.hitungan = (st.hitungan || 0) + 1;
  st.target = target;
  S.dzikirHitung[id] = st;
  simpanCache('dzikir', S.dzikirHitung);
  if (navigator.vibrate) navigator.vibrate(18);
  gambarModul();

  panggilTulis('simpanHitungan', { dzikirId: id, hitungan: st.hitungan, target: target })
    .then(function (r) {
      if (r.ok && r.data && r.data.progres) {
        S.progres = r.data.progres; simpanCache('progres', S.progres); gambarHeader();
        lonceng('Dzikir tuntas · +20 XP', 2400);
      }
    }).catch(function () {});
}

function resetTasbih(id) {
  S.dzikirHitung[id] = { hitungan: 0, target: (S.dzikirHitung[id] || {}).target || 0 };
  simpanCache('dzikir', S.dzikirHitung);
  gambarModul();
  panggilTulis('simpanHitungan', { dzikirId: id, hitungan: 0, target: 0 }).catch(function () {});
}

/* =====================================================================
   MODUL 6 — TUNTUNAN SHOLAT
   ===================================================================== */

function modulSholat() {
  var langkah = S.data.sholat || [];
  if (!langkah.length) return '<div class="kosong">Data tuntunan sholat belum tersedia.</div>';
  var i = Math.max(0, Math.min(S.sholatLangkah, langkah.length - 1));
  var L = langkah[i];
  var jadwal = S.hasilAI.jadwalSholat;

  var kartuJadwal = '<div class="kartu"><div class="baris-tbl" style="justify-content:space-between">' +
    '<span class="label">Jadwal sholat hari ini</span>' +
    '<button class="tbl tbl-garis tbl-kecil" id="tbl-jadwal">' + (S.sibuk.jadwal ? '<span class="memuat"></span>Memuat…' : '🔄 Muat jadwal') + '</button></div>';

  if (jadwal && jadwal.jadwal) {
    kartuJadwal += '<div class="terjemah" style="margin:8px 0 10px;font-size:12.5px">' +
      esc(jadwal.kota) + ' · ' + esc(jadwal.tanggal) + '</div><div class="kisi-4">' +
      Object.keys(jadwal.jadwal).map(function (n) {
        return '<div style="text-align:center;padding:10px 6px;border:1px solid var(--garis);border-radius:10px">' +
          '<div class="label" style="font-size:10px">' + esc(n) + '</div>' +
          '<div style="font-weight:700;font-size:16px;margin-top:2px">' + esc(jadwal.jadwal[n]) + '</div></div>';
      }).join('') + '</div>';
  } else if (jadwal && jadwal.catatan) {
    kartuJadwal += '<div class="kabar kabar-peringatan" style="margin-top:9px">' + esc(jadwal.catatan) + '</div>';
  } else {
    kartuJadwal += '<p class="terjemah" style="margin:8px 0 0;font-size:12.5px">Tekan "Muat jadwal" untuk mengambil waktu sholat kota Anda. Hasilnya disimpan agar bisa dilihat offline.</p>';
  }
  kartuJadwal += '</div>';

  return '<div class="judul-modul"><h2>🧭 Tuntunan Sholat</h2>' +
      '<span>' + langkah.length + ' langkah berurutan</span></div>' +
    '<p class="sub-modul">Ikuti langkah demi langkah, lengkap bacaan Arab, latin, dan terjemahannya.</p>' +
    kartuJadwal +
    '<div class="kartu">' +
      '<div class="baris-tbl" style="justify-content:space-between">' +
        '<span class="tag">Langkah ' + L.stepNumber + ' dari ' + langkah.length + '</span>' +
        '<button class="tbl tbl-garis tbl-kecil" data-ucap="' + esc(L.arabic) + '">🔊 Dengar</button></div>' +
      '<div class="bar" style="margin:11px 0 14px"><div class="bar-isi" style="width:' +
        Math.round((i + 1) / langkah.length * 100) + '%"></div></div>' +
      '<h3 style="margin:0 0 10px;font-size:17px">' + esc(L.title) + '</h3>' +
      '<div class="arab">' + esc(L.arabic) + '</div>' +
      '<div class="latin" style="margin-top:7px">' + esc(L.latin) + '</div>' +
      '<div class="terjemah" style="margin-top:6px">' + esc(L.translation) + '</div>' +
      '<div class="kabar" style="margin-top:13px">📌 ' + esc(L.description) + '</div>' +
      '<div class="baris-tbl" style="justify-content:space-between">' +
        '<button class="tbl tbl-garis" id="tbl-sholat-sebelum"' + (i === 0 ? ' disabled' : '') + '>← Sebelumnya</button>' +
        '<button class="tbl" id="tbl-sholat-berikut"' + (i >= langkah.length - 1 ? ' disabled' : '') + '>Berikutnya →</button>' +
      '</div>' +
    '</div>' +
    '<div class="kisi">' + langkah.map(function (x, idx) {
      return '<div class="kartu kartu-klik" style="margin:0;' + (idx === i ? 'border-color:var(--clay)' : '') +
        '" data-langkah="' + idx + '"><span class="nomor-ayat">' + x.stepNumber + '</span>' +
        '<div style="font-weight:600;font-size:13.5px;margin-top:7px">' + esc(x.title) + '</div></div>';
    }).join('') + '</div>';
}

/* =====================================================================
   MODUL 7 — KALENDER BELAJAR & PENGINGAT
   ===================================================================== */

function modulKalender() {
  var log = (S.progres && S.progres.studyLogDates) || {};
  var kini = new Date();
  var tahun = kini.getFullYear(), bulan = kini.getMonth();
  var pertama = new Date(tahun, bulan, 1).getDay();
  var jumlahHari = new Date(tahun, bulan + 1, 0).getDate();
  var namaBulan = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'][bulan];
  var hariIni = tglStr(kini);

  var sel = '';
  for (var k = 0; k < pertama; k++) sel += '<div class="kal-sel hampa"></div>';
  var totalMenit = 0, hariAktif = 0;
  for (var d = 1; d <= jumlahHari; d++) {
    var tgl = tahun + '-' + pad(bulan + 1) + '-' + pad(d);
    var menit = Number(log[tgl]) || 0;
    totalMenit += menit;
    if (menit > 0) hariAktif++;
    var tingkat = menit === 0 ? 0 : menit < 15 ? 1 : menit < 40 ? 2 : 3;
    sel += '<div class="kal-sel ada-' + tingkat + (tgl === hariIni ? ' kini' : '') +
           '" title="' + tgl + ' · ' + menit + ' menit">' + d + '</div>';
  }

  var html = '<div class="judul-modul"><h2>📅 Kalender Belajar</h2>' +
      '<span>' + hariAktif + ' hari aktif bulan ini · ' + totalMenit + ' menit</span></div>' +
    '<p class="sub-modul">Setiap aktivitas belajar menambah catatan waktu di kalender ini. Semakin gelap kotaknya, semakin lama Anda belajar hari itu.</p>' +

    '<div class="kartu">' +
      '<div class="baris-tbl" style="justify-content:space-between;margin-bottom:11px">' +
        '<b>' + namaBulan + ' ' + tahun + '</b>' +
        '<span class="terjemah" style="font-size:11.5px">🔥 Streak ' + ((S.progres && S.progres.streakDays) || 0) + ' hari</span></div>' +
      '<div class="kalender">' +
        ['Min','Sen','Sel','Rab','Kam','Jum','Sab'].map(function (h) { return '<div class="kal-hari">' + h + '</div>'; }).join('') +
        sel +
      '</div>' +
      '<div class="baris-tbl" style="margin-top:12px">' +
        '<input type="number" id="input-menit" placeholder="Menit belajar" min="1" max="600" style="max-width:150px">' +
        '<button class="tbl tbl-kecil" id="tbl-catat-menit">Catat waktu belajar</button></div>' +
    '</div>';

  html += '<div class="kartu">' +
    '<div class="baris-tbl" style="justify-content:space-between">' +
      '<span class="label">Pengingat harian</span>' +
      '<button class="tbl tbl-clay tbl-kecil" id="tbl-izin-notif">🔔 Aktifkan notifikasi</button></div>' +
    '<p class="terjemah" style="margin:8px 0 12px;font-size:12.5px">Pengingat berjalan selama aplikasi terbuka di peramban. Untuk pengingat yang berjalan sendiri, buat trigger harian di Apps Script.</p>' +
    (S.pengingat || []).map(function (r) {
      return '<div class="ayat"><div class="ayat-atas">' +
        '<div><b style="font-size:14px">' + esc(r.title) + '</b>' +
        '<div class="terjemah" style="font-size:12px">🕐 ' + esc(r.time) + ' · ' + (r.days || []).join(', ') + '</div></div>' +
        '<div class="baris-tbl">' +
          '<button class="tbl tbl-kecil' + (r.enabled ? '' : ' tbl-garis') + '" data-pengingat="' + esc(r.id) + '">' +
            (r.enabled ? 'Aktif' : 'Nonaktif') + '</button>' +
          '<button class="tbl tbl-garis tbl-kecil" data-hapus-pengingat="' + esc(r.id) + '">🗑</button>' +
        '</div></div></div>';
    }).join('') +
    '<hr class="pemisah"><span class="label">Tambah pengingat</span>' +
    '<div class="baris-tbl" style="margin-top:8px">' +
      '<input type="text" id="p-judul" placeholder="Judul pengingat" style="flex:2 1 200px">' +
      '<input type="time" id="p-waktu" value="05:15" style="flex:0 0 120px">' +
      '<select id="p-kategori" style="flex:0 0 130px">' +
        '<option value="hafalan">Hafalan</option><option value="quiz">Kuis</option>' +
        '<option value="dhikr">Dzikir</option><option value="kultum">Kultum</option></select>' +
      '<button class="tbl tbl-kecil" id="tbl-tambah-pengingat">+ Tambah</button>' +
    '</div></div>';

  return html;
}

/* =====================================================================
   MODUL 8 — PROGRES & POIN
   ===================================================================== */

function modulProgres() {
  var p = S.progres || {};
  var badge = S.data.badge || [];
  var terbuka = p.unlockedBadges || [];
  var poinLevelIni = (p.points || 0) % 100;

  var log = p.studyLogDates || {};
  var tanggal = Object.keys(log).sort().slice(-14);
  var maks = Math.max.apply(null, tanggal.map(function (t) { return Number(log[t]) || 0; }).concat([1]));

  return '<div class="judul-modul"><h2>🏆 Progres & Poin</h2>' +
      '<span>Level ' + (p.level || 1) + ' · ' + (p.points || 0) + ' XP</span></div>' +
    '<p class="sub-modul">Rekap perjalanan belajar Anda, lengkap dengan lencana yang sudah terbuka.</p>' +

    '<div class="kisi-4" style="margin-bottom:14px">' +
      kotakStat('⭐', p.points || 0, 'Total XP') +
      kotakStat('🔥', (p.streakDays || 0) + ' hari', 'Streak') +
      kotakStat('📖', p.memorizedVersesCount || 0, 'Ayat hafal') +
      kotakStat('🎯', p.completedQuizzesCount || 0, 'Kuis selesai') +
      kotakStat('🔤', (p.masteredVocabIds || []).length, 'Mufrodat') +
      kotakStat('🕌', (p.readKultumIds || []).length, 'Kultum dibaca') +
    '</div>' +

    '<div class="kartu">' +
      '<div class="baris-tbl" style="justify-content:space-between">' +
        '<span class="label">Menuju level ' + ((p.level || 1) + 1) + '</span>' +
        '<b>' + poinLevelIni + '/100 XP</b></div>' +
      '<div class="bar" style="margin-top:8px"><div class="bar-isi" style="width:' + poinLevelIni + '%"></div></div>' +
    '</div>' +

    '<div class="kartu">' +
      '<span class="label">Waktu belajar 14 hari terakhir</span>' +
      '<div style="display:flex;align-items:flex-end;gap:5px;height:110px;margin-top:14px">' +
        tanggal.map(function (t) {
          var m = Number(log[t]) || 0;
          return '<div style="flex:1;text-align:center" title="' + t + ' · ' + m + ' menit">' +
            '<div style="height:' + Math.max(3, Math.round(m / maks * 84)) + 'px;background:linear-gradient(180deg,#D4A373,#5A5A40);border-radius:5px 5px 0 0"></div>' +
            '<div style="font-size:9.5px;color:var(--tinta-lembut);margin-top:4px">' + t.slice(8) + '</div></div>';
        }).join('') +
      '</div>' +
    '</div>' +

    '<div class="kartu">' +
      '<div class="baris-tbl" style="justify-content:space-between">' +
        '<span class="label">Lencana</span><b>' + terbuka.length + '/' + badge.length + ' terbuka</b></div>' +
      '<div class="kisi-4" style="margin-top:12px">' +
        badge.map(function (b) {
          var buka = terbuka.indexOf(b.id) > -1;
          return '<div class="badge-kotak' + (buka ? '' : ' terkunci') + '" title="' + esc(b.description) + '">' +
            '<span class="badge-ikon">' + b.icon + '</span>' +
            '<div class="badge-judul">' + esc(b.title) + '</div>' +
            '<div class="badge-ket">' + b.requiredPoints + ' XP' +
              (b.requiredStreak ? ' · ' + b.requiredStreak + ' hari' : '') + '</div></div>';
        }).join('') +
      '</div>' +
    '</div>' +

    '<div class="kartu">' +
      '<span class="label">Cadangan data</span>' +
      '<p class="terjemah" style="margin:8px 0 11px;font-size:12.5px">Unduh progres sebagai berkas JSON, atau pulihkan dari berkas cadangan lama.</p>' +
      '<div class="baris-tbl">' +
        '<button class="tbl tbl-kecil" id="tbl-ekspor">⬇ Unduh cadangan</button>' +
        '<button class="tbl tbl-garis tbl-kecil" id="tbl-impor">⬆ Pulihkan cadangan</button>' +
        '<button class="tbl tbl-garis tbl-kecil" id="tbl-papan-skor">🏅 Papan skor</button>' +
        '<input type="file" id="berkas-impor" accept="application/json" class="sembunyi">' +
      '</div>' +
      (S.hasilAI.papanSkor ? tampilPapanSkor(S.hasilAI.papanSkor) : '') +
    '</div>';
}

function kotakStat(ikon, nilai, label) {
  return '<div class="kartu" style="margin:0;text-align:center;padding:14px 9px">' +
    '<div style="font-size:22px">' + ikon + '</div>' +
    '<div style="font-size:21px;font-weight:800;letter-spacing:-.6px;margin:3px 0 0">' + esc(nilai) + '</div>' +
    '<div class="label" style="font-size:10px">' + esc(label) + '</div></div>';
}

function tampilPapanSkor(daftar) {
  if (!daftar.length) return '<div class="kabar" style="margin-top:12px">Belum ada data papan skor.</div>';
  return '<hr class="pemisah"><span class="label">Papan skor</span>' +
    daftar.map(function (u, i) {
      return '<div class="baris-tbl" style="justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--garis)">' +
        '<span>' + (i < 3 ? ['🥇','🥈','🥉'][i] : (i + 1) + '.') + ' ' + esc(u.email) + '</span>' +
        '<b>' + u.poin + ' XP</b></div>';
    }).join('');
}

/* ===================== HASIL AI (bersama) ===================== */

function kartuHasilAI(kunci) {
  var h = S.hasilAI[kunci];
  if (!h) return '';
  if (h.error) return '<div class="kabar kabar-galat" style="margin-top:11px">⚠️ ' + esc(h.error) + '</div>';

  var html = '<div class="kabar' + (h.sumber && h.sumber !== 'AI' ? ' kabar-peringatan' : ' kabar-sukses') + '" style="margin-top:12px">';
  if (h.catatan) html += '<div style="margin-bottom:8px">ℹ️ ' + esc(h.catatan) + '</div>';

  if (kunci === 'tutor') {
    html += '<div class="arab-kecil" style="font-size:24px">' + esc(h.arabic) + '</div>' +
      '<div class="latin" style="margin-top:5px">' + esc(h.latin) + '</div>' +
      '<div style="font-weight:600;margin-top:4px">' + esc(h.translation) + '</div>' +
      '<hr class="pemisah"><b>Tata bahasa:</b> ' + esc(h.grammarNotes) +
      '<br><b>Catatan:</b> ' + esc(h.feedback);
  } else if (kunci === 'tajwid') {
    html += '<div style="white-space:pre-wrap;font-size:14px;line-height:1.75">' + esc(h.answer) + '</div>';
  } else if (kunci === 'lafal') {
    html += '<div style="font-size:33px;font-weight:800;letter-spacing:-1px">' + esc(h.score) + '<span style="font-size:15px">/100</span></div>' +
      '<b>' + esc(h.verdict) + '</b>' +
      (h.transkripsi ? '<div class="terjemah" style="margin-top:6px">Terdengar: "' + esc(h.transkripsi) + '"</div>' : '') +
      '<hr class="pemisah">' + esc(h.tajweedCompliance) +
      '<div style="margin-top:7px">💡 ' + esc(h.pronunciationTips) + '</div>';
  } else if (kunci === 'kultum' && h.title) {
    html += '<b>' + esc(h.title) + '</b> tersusun. Materi ditampilkan di bawah.';
  } else if (kunci === 'khutbah' && h.title) {
    html += '<b>' + esc(h.title) + '</b> tersusun.';
  }
  return html + '</div>';
}

/* ===================== AKSI AI ===================== */

function jalankanAI(kunci, action, payload, sesudah) {
  if (!navigator.onLine) {
    S.hasilAI[kunci] = { error: 'Fitur AI butuh koneksi internet. Materi bawaan tetap bisa dibaca di daftar bawah.' };
    gambarModul(); return;
  }
  S.sibuk[kunci] = true;
  S.hasilAI[kunci] = null;
  gambarModul();

  panggil(action, payload)
    .then(function (r) {
      S.sibuk[kunci] = false;
      S.hasilAI[kunci] = r.ok ? r.data : { error: r.error };
      if (r.ok && sesudah) sesudah(r.data);
      gambarModul();
    })
    .catch(function (e) {
      S.sibuk[kunci] = false;
      S.hasilAI[kunci] = { error: e.message };
      gambarModul();
    });
}

/* ===================== PENGGAMBAR UTAMA ===================== */

function gambarModul() {
  var wadah = el('modul');
  if (!S.data) { wadah.innerHTML = '<div class="kosong"><span class="memuat"></span>Memuat data…</div>'; return; }

  var html;
  if (S.tab === 'quran')        html = modulQuran();
  else if (S.tab === 'arabic')  html = S.kuis ? modulKuis() : modulArab();
  else if (S.tab === 'tajweed') html = modulTajwid();
  else if (S.tab === 'kultum')  html = modulKultum();
  else if (S.tab === 'dhikr')   html = modulDzikir();
  else if (S.tab === 'sholat')  html = modulSholat();
  else if (S.tab === 'calendar')html = modulKalender();
  else if (S.tab === 'progress')html = modulProgres();
  else if (S.tab === 'guru')    html = modulGuru();
  else html = '<div class="kosong">Modul tidak ditemukan.</div>';

  wadah.innerHTML = html;
}

/* ===================== PENANGANAN KLIK (delegasi) ===================== */

function pasangPendengar() {
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-tab],[data-hafal],[data-ucap],[data-ucap-id],[data-audio],[data-dengar],[data-kategori],[data-pilih-kelas],[data-aksi-guru],[data-hapus-santri],' +
      '[data-mufrodat],[data-jawab],[data-tajwid],[data-uji],[data-ktab],[data-kultum],[data-khutbah],' +
      '[data-tandai-kultum],[data-dtab],[data-tasbih],[data-reset-tasbih],[data-langkah],' +
      '[data-pengingat],[data-hapus-pengingat],[data-jenis],button');
    if (!t) return;

    var d = t.dataset || {};

    /* navigasi & pencarian */
    if (d.tab) return gantiTab(d.tab);
    if (d.jenis) return bukaHasilCari(d.jenis, d.id);

    /* suara */
    if (d.pilihKelas) return void muatDasbor(d.pilihKelas);
    if (d.aksiGuru) return void aksiGuru(d.aksiGuru);
    if (d.hapusSantri) return void keluarkanSantri(d.hapusSantri);
    if (d.dengar) return void dengarAyat(d.dengar);
    if (d.audio) return void Murottal.mainkan(d.audio);
    if (d.ucap) return Suara.ucap(d.ucap, 'ar-SA');
    if (d.ucapId) return Suara.ucap(d.ucapId, 'id-ID');

    /* hafalan */
    if (d.hafal) return tandaiHafal(d.hafal);

    /* mufrodat & kuis */
    if (d.kategori) { S.kategoriMufrodat = d.kategori; return gambarModul(); }
    if (d.mufrodat) return tandaiMufrodatUI(d.mufrodat);
    if (d.jawab !== undefined) return jawabKuis(Number(d.jawab));

    /* tajwid */
    if (d.tajwid) { S.tajwidAktif = d.tajwid; S.hasilAI.lafal = null; gambarModul(); return window.scrollTo({ top: 0, behavior: 'smooth' }); }
    if (d.uji) return ujiLafal(d.uji, d.aturan);

    /* kultum & khutbah */
    if (d.ktab) { S.kultumTab = d.ktab; return gambarModul(); }
    if (d.kultum) { S.kultumAktif = d.kultum; gambarModul(); return window.scrollTo({ top: 0, behavior: 'smooth' }); }
    if (d.khutbah) { S.khutbahAktif = d.khutbah; S.hasilAI.khutbah = null; gambarModul(); return window.scrollTo({ top: 0, behavior: 'smooth' }); }
    if (d.tandaiKultum) return tandaiKultum(d.tandaiKultum);

    /* dzikir */
    if (d.dtab) { S.dzikirTab = d.dtab; return gambarModul(); }
    if (d.tasbih) return tambahTasbih(d.tasbih, Number(d.target));
    if (d.resetTasbih) return resetTasbih(d.resetTasbih);

    /* sholat */
    if (d.langkah !== undefined) { S.sholatLangkah = Number(d.langkah); gambarModul(); return window.scrollTo({ top: 0, behavior: 'smooth' }); }

    /* pengingat */
    if (d.pengingat) return balikPengingat(d.pengingat);
    if (d.hapusPengingat) return hapusPengingatUI(d.hapusPengingat);

    /* tombol ber-id */
    var aksi = {
      'tbl-tema': balikTema,
      'tbl-muat-ayat': function () { muatAyat(S.surahAktif); },
      'tbl-baca-surah': bacaTigaAyat,
      'tbl-mulai-kuis': mulaiKuis,
      'tbl-tutup-kuis': function () { S.kuis = null; gambarModul(); },
      'tbl-kuis-lanjut': lanjutKuis,
      'tbl-tutor': function () {
        var v = (el('input-tutor') || {}).value;
        if (!v || !v.trim()) return lonceng('Tulis dulu kalimat Bahasa Arab yang mau dikoreksi.');
        jalankanAI('tutor', 'tutorArab', { sentence: v.trim() });
      },
      'tbl-tanya-tajwid': function () {
        var v = (el('input-tajwid') || {}).value;
        if (!v || !v.trim()) return lonceng('Tulis dulu pertanyaan atau ayat yang mau dianalisis.');
        jalankanAI('tajwid', 'tanyaTajwid', { query: v.trim() });
      },
      'tbl-buat-kultum': function () {
        var v = (el('input-kultum') || {}).value;
        if (!v || !v.trim()) return lonceng('Tulis dulu topik kultumnya.');
        jalankanAI('kultum', 'buatKultum', { topic: v.trim() }, function (data) {
          S.hasilAI.kultumDaftar = (S.hasilAI.kultumDaftar || []).concat([data]);
          S.kultumAktif = data.id;
        });
      },
      'tbl-buat-khutbah': function () {
        var v = (el('input-khutbah') || {}).value;
        var tema = (el('input-tema') || {}).value;
        if (!v || !v.trim()) return lonceng('Tulis dulu topik khutbahnya.');
        S.khutbahAktif = null;
        jalankanAI('khutbah', 'buatKhutbah', { topic: v.trim(), theme: (tema || '').trim() });
      },
      'tbl-tutup-kultum': function () { S.kultumAktif = null; S.hasilAI.kultum = null; gambarModul(); },
      'tbl-tutup-khutbah': function () { S.khutbahAktif = null; S.hasilAI.khutbah = null; gambarModul(); },
      'tbl-tutup-tajwid': function () { S.tajwidAktif = null; S.hasilAI.lafal = null; gambarModul(); },
      'tbl-sholat-sebelum': function () { S.sholatLangkah = Math.max(0, S.sholatLangkah - 1); gambarModul(); },
      'tbl-sholat-berikut': function () { S.sholatLangkah = S.sholatLangkah + 1; gambarModul(); },
      'tbl-jadwal': muatJadwalSholat,
      'tbl-catat-menit': catatMenit,
      'tbl-tambah-pengingat': tambahPengingat,
      'tbl-izin-notif': mintaIzinNotifikasi,
      'tbl-ekspor': eksporData,
      'tbl-impor': function () { el('berkas-impor').click(); },
      'tbl-papan-skor': muatPapanSkor
    };
    if (aksi[t.id]) { ev.preventDefault(); return aksi[t.id](); }
  });

  /* pencarian */
  el('cari-input').addEventListener('input', function (e) { cariGlobal(e.target.value); });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.cari-kotak')) el('cari-hasil').classList.add('sembunyi');
  });

  /* pilih surah */
  document.addEventListener('change', function (e) {
    if (e.target.id === 'pilih-surah') {
      S.surahAktif = Number(e.target.value);
      S.ayatSurah = ambilCache('ayat_' + S.surahAktif) || [];
      gambarModul();
      // Ambil versi lengkap otomatis supaya murottal langsung bisa diputar.
      if (!S.ayatSurah.length && navigator.onLine) muatAyat(S.surahAktif);
    }
    if (e.target.id === 'berkas-impor' && e.target.files && e.target.files[0]) {
      var fr = new FileReader();
      fr.onload = function () { imporData(fr.result); };
      fr.readAsText(e.target.files[0]);
    }
  });

  /* jaringan */
  window.addEventListener('online', function () {
    perbaruiStatusJaringan();
    lonceng('Koneksi kembali. Menyinkronkan…', 2400);
    kirimOutbox();
  });
  window.addEventListener('offline', function () {
    perbaruiStatusJaringan();
    lonceng('Mode offline aktif. Perubahan disimpan di perangkat.', 3200);
  });

  /* pintasan papan tombol */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { Suara.hentikan(); el('cari-hasil').classList.add('sembunyi'); }
  });
}

/* ===================== AKSI PENDUKUNG ===================== */

function bacaTigaAyat() {
  var ayat = S.ayatSurah.length ? S.ayatSurah
    : ((S.data.surah || []).filter(function (s) { return s.id === S.surahAktif; })[0] || {}).verses || [];
  if (!ayat.length) return lonceng('Muat ayat lebih dulu.');
  var tiga = ayat.slice(0, 3);
  var audio = tiga.map(function (a) { return a.audioUrl; }).filter(Boolean);
  // Murottal qari asli lebih tepat daripada teks-ke-ucapan untuk Al-Qur'an.
  if (audio.length === tiga.length && Murottal.mainkan(audio)) return;

  // Cuplikan bawaan belum punya audio -> ambil versi lengkap dulu.
  if (navigator.onLine && !S.ayatSurah.length) {
    lonceng('Mengambil murottal…', 0);
    return void muatAyat(S.surahAktif, function () {
      var t2 = S.ayatSurah.slice(0, 3);
      var a2 = t2.map(function (a) { return a.audioUrl; }).filter(Boolean);
      if (a2.length === t2.length) { lonceng('', 1); Murottal.mainkan(a2); }
      else _ttsAyat(t2[0]);
    });
  }
  _ttsAyat(tiga[0]);
}

function tandaiMufrodatUI(id) {
  var p = S.progres || {};
  p.masteredVocabIds = p.masteredVocabIds || [];
  var idx = p.masteredVocabIds.indexOf(id);
  var kuasai = idx === -1;
  if (kuasai) { p.masteredVocabIds.push(id); p.points = (p.points || 0) + 5; }
  else p.masteredVocabIds.splice(idx, 1);
  S.progres = p; simpanCache('progres', p);
  gambarHeader(); gambarModul();

  panggilTulis('tandaiMufrodat', { vocabId: id, dikuasai: kuasai })
    .then(function (r) { if (r.ok && r.data) { S.progres = r.data; simpanCache('progres', r.data); gambarHeader(); } })
    .catch(function () {});
}

function tandaiKultum(id) {
  var p = S.progres || {};
  p.readKultumIds = p.readKultumIds || [];
  if (p.readKultumIds.indexOf(id) > -1) return lonceng('Kultum ini sudah ditandai selesai.');
  p.readKultumIds.push(id);
  p.points = (p.points || 0) + 25;
  S.progres = p; simpanCache('progres', p);
  gambarHeader(); gambarModul();
  lonceng('+25 XP · kultum ditandai selesai', 2400);
  panggilTulis('simpanProgres', { progres: p })
    .then(function (r) { if (r.ok && r.data) { S.progres = r.data; simpanCache('progres', r.data); gambarHeader(); } })
    .catch(function () {});
}

function muatJadwalSholat() {
  var tersimpan = ambilCache('jadwalSholat');
  if (tersimpan && !navigator.onLine) {
    S.hasilAI.jadwalSholat = tersimpan;
    lonceng('Menampilkan jadwal tersimpan (offline).', 2600);
    return gambarModul();
  }
  S.sibuk.jadwal = true; gambarModul();
  panggil('ambilJadwalSholat', {})
    .then(function (r) {
      S.sibuk.jadwal = false;
      S.hasilAI.jadwalSholat = r.ok ? r.data : { catatan: r.error };
      if (r.ok && r.data && r.data.jadwal) simpanCache('jadwalSholat', r.data);
      gambarModul();
    })
    .catch(function (e) {
      S.sibuk.jadwal = false;
      S.hasilAI.jadwalSholat = tersimpan || { catatan: e.message };
      gambarModul();
    });
}

function catatMenit() {
  var v = Number((el('input-menit') || {}).value);
  if (!v || v < 1) return lonceng('Isi jumlah menit belajarnya dulu.');
  panggilTulis('catatBelajar', { menit: v })
    .then(function (r) {
      if (r.tertunda) return lonceng('Dicatat di perangkat, akan tersinkron saat online.', 2600);
      if (r.ok && r.data) { S.progres = r.data; simpanCache('progres', r.data); gambarHeader(); gambarModul(); }
      lonceng(v + ' menit tercatat di kalender.', 2400);
    })
    .catch(function () { lonceng('Gagal mencatat, coba lagi.'); });
}

function tambahPengingat() {
  var judul = (el('p-judul') || {}).value;
  if (!judul || !judul.trim()) return lonceng('Isi judul pengingatnya dulu.');
  var baru = {
    title: judul.trim(),
    time: (el('p-waktu') || {}).value || '05:15',
    days: ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu'],
    enabled: true,
    category: (el('p-kategori') || {}).value || 'hafalan'
  };
  S.pengingat.push(Object.assign({ id: 'lokal-' + Date.now() }, baru));
  simpanCache('pengingat', S.pengingat);
  gambarModul();
  panggilTulis('simpanPengingat', { pengingat: baru })
    .then(function (r) { if (r.ok && r.data) { S.pengingat = r.data; simpanCache('pengingat', r.data); gambarModul(); } })
    .catch(function () {});
}

function balikPengingat(id) {
  var r = S.pengingat.filter(function (x) { return x.id === id; })[0];
  if (!r) return;
  r.enabled = !r.enabled;
  simpanCache('pengingat', S.pengingat);
  gambarModul();
  panggilTulis('simpanPengingat', { pengingat: r }).catch(function () {});
}

function hapusPengingatUI(id) {
  S.pengingat = S.pengingat.filter(function (x) { return x.id !== id; });
  simpanCache('pengingat', S.pengingat);
  gambarModul();
  panggilTulis('hapusPengingat', { id: id }).catch(function () {});
}

function mintaIzinNotifikasi() {
  if (!('Notification' in window)) return lonceng('Peramban ini belum mendukung notifikasi.');
  Notification.requestPermission().then(function (izin) {
    if (izin === 'granted') {
      lonceng('Notifikasi aktif. Pengingat akan muncul selama aplikasi terbuka.', 3000);
      mulaiPengawasPengingat();
    } else {
      lonceng('Notifikasi belum diizinkan.');
    }
  });
}

var _pengawas = null;
function mulaiPengawasPengingat() {
  if (_pengawas) return;
  var sudah = {};
  _pengawas = setInterval(function () {
    if (Notification.permission !== 'granted') return;
    var kini = new Date();
    var jam = pad(kini.getHours()) + ':' + pad(kini.getMinutes());
    var hari = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'][kini.getDay()];
    (S.pengingat || []).forEach(function (r) {
      var tanda = r.id + jam + tglStr(kini);
      if (r.enabled && r.time === jam && (r.days || []).indexOf(hari) > -1 && !sudah[tanda]) {
        sudah[tanda] = true;
        new Notification('Nur Youth — ' + r.title, {
          body: 'Waktunya ' + r.category + '. Semangat, jaga istiqomahmu!',
          icon: 'icon.svg'
        });
      }
    });
  }, 30000);
}

function eksporData() {
  panggil('eksporCadangan', {})
    .then(function (r) {
      var isi = r.ok ? r.data : {
        app: 'NurYouth-AlQuran-Arab', exportedAt: new Date().toISOString(),
        progress: S.progres, reminders: S.pengingat, hafalan: Object.keys(S.hafalan)
      };
      unduhBerkas('nur-youth-cadangan-' + tglStr(new Date()) + '.json', JSON.stringify(isi, null, 2));
    })
    .catch(function () {
      unduhBerkas('nur-youth-cadangan-lokal-' + tglStr(new Date()) + '.json', JSON.stringify({
        app: 'NurYouth-AlQuran-Arab', exportedAt: new Date().toISOString(),
        progress: S.progres, reminders: S.pengingat, hafalan: Object.keys(S.hafalan)
      }, null, 2));
      lonceng('Cadangan diambil dari data lokal (offline).', 2800);
    });
}

function imporData(isi) {
  panggilTulis('imporCadangan', { isi: isi })
    .then(function (r) {
      if (r.tertunda) return lonceng('Cadangan tersimpan lokal, akan diunggah saat online.', 3000);
      if (r.ok) { lonceng('Cadangan berhasil dipulihkan.', 2600); return muatSemua(); }
      lonceng(r.error || 'Berkas cadangan tidak terbaca.');
    })
    .catch(function (e) { lonceng('Gagal memulihkan: ' + e.message); });
}

function muatPapanSkor() {
  panggil('ambilPapanSkor', { batas: 10 })
    .then(function (r) { S.hasilAI.papanSkor = r.ok ? r.data : []; gambarModul(); })
    .catch(function () { lonceng('Papan skor butuh koneksi internet.'); });
}

function unduhBerkas(nama, isi) {
  var b = new Blob([isi], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = nama;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
}

function pad(n) { return (n < 10 ? '0' : '') + n; }
function tglStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

/* ===================== PEMUATAN AWAL ===================== */

function segarkanProgres() {
  return panggil('ambilProgres', {})
    .then(function (r) {
      if (r.ok && r.data) { S.progres = r.data; simpanCache('progres', r.data); gambarHeader(); }
    })
    .catch(function () {});
}

function muatSemua() {
  // 1. tampilkan segera dari cache supaya aplikasi bisa dipakai offline
  var cData = ambilCache('dataAwal');
  if (cData) {
    S.data = cData;
    S.progres = ambilCache('progres') || cData.progres;
    S.pengingat = ambilCache('pengingat') || cData.pengingat || [];
    S.hafalan = ambilCache('hafalan') || {};
    S.dzikirHitung = ambilCache('dzikir') || {};
    S.ayatSurah = ambilCache('ayat_' + S.surahAktif) || [];
    gambarHeader(); gambarNav(); gambarModul();
    muatStatusGuru();   // tab Dasbor Guru hanya muncul bila mengampu kelas
    // Ambil murottal surah aktif di latar agar tombol 🔊 langsung berfungsi.
    if (!S.ayatSurah.length && navigator.onLine) setTimeout(function () { muatAyat(S.surahAktif); }, 900);
  }

  if (!navigator.onLine) {
    if (!cData) {
      el('modul').innerHTML = '<div class="kosong"><span class="kosong-ikon">📴</span>' +
        'Belum ada data tersimpan di perangkat ini. Sambungkan ke internet sekali untuk mengunduh materi, ' +
        'setelah itu aplikasi bisa dibuka offline.</div>';
    } else {
      lonceng('Mode offline. Materi dibuka dari penyimpanan perangkat.', 3400);
    }
    perbaruiStatusJaringan();
    return Promise.resolve();
  }

  // 2. segarkan dari server
  return panggil('muatAwal', {})
    .then(function (r) {
      if (!r.ok) throw new Error(r.error || 'Gagal memuat data.');
      S.data = r.data;
      S.email = r.data.email || S.email;
      S.progres = r.data.progres;
      S.pengingat = r.data.pengingat || [];
      try { localStorage.setItem(CFG.KUNCI_EMAIL, S.email); } catch (e) {}
      simpanCache('dataAwal', r.data);
      simpanCache('progres', r.data.progres);
      simpanCache('pengingat', S.pengingat);

      gambarHeader(); gambarNav(); gambarModul();
      return panggil('ambilHafalan', {});
    })
    .then(function (r) {
      if (r && r.ok && r.data) {
        var peta = {};
        r.data.forEach(function (h) { peta[h.surahId + ':' + h.nomorAyat] = true; });
        S.hafalan = peta;
        simpanCache('hafalan', peta);
      }
      return panggil('ambilDzikirHariIni', {});
    })
    .then(function (r) {
      if (r && r.ok && r.data) { S.dzikirHitung = r.data; simpanCache('dzikir', r.data); }
      gambarModul();
      kirimOutbox();
    })
    .catch(function (e) {
      if (!S.data) {
        el('modul').innerHTML = '<div class="kabar kabar-galat">⚠️ ' + esc(e.message) + '</div>' +
          '<div class="kartu"><span class="label">Langkah pemeriksaan</span><ul style="padding-left:20px;margin:9px 0 0">' +
          '<li>Pastikan menu <b>🕌 Nur Youth → Siapkan / Perbaiki Semua Sheet</b> sudah dijalankan.</li>' +
          '<li>Pada versi PWA, pastikan <code>WEB_APP_URL</code> di <code>app.js</code> sudah diisi URL /exec.</li>' +
          '<li>Deployment Web App harus berakses <b>Siapa saja</b> agar PWA bisa memanggilnya.</li>' +
          '</ul></div>';
      } else {
        lonceng('Data server gagal disegarkan, memakai salinan lokal.', 3000);
      }
    });
}

function mulai() {
  var tema = 'terang';
  try {
    tema = localStorage.getItem(CFG.KUNCI_TEMA) ||
           (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'gelap' : 'terang');
    S.email = localStorage.getItem(CFG.KUNCI_EMAIL) || '';
  } catch (e) {}
  terapkanTema(tema);

  if (typeof EMAIL_INJEKSI !== 'undefined' && EMAIL_INJEKSI) S.email = EMAIL_INJEKSI;

  gambarNav();
  pasangPendengar();
  perbaruiStatusJaringan();
  muatSemua();

  // Muat daftar suara sedini mungkin; di Chrome/Android daftarnya asinkron.
  Suara.pasangPendengarSuara();
  if ('Notification' in window && Notification.permission === 'granted') mulaiPengawasPengingat();
}

document.addEventListener('DOMContentLoaded', mulai);
