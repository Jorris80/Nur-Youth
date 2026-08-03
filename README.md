# Nur Youth — PWA Al-Qur'an & Bahasa Arab

Aplikasi belajar Al-Qur'an dan Bahasa Arab untuk generasi muda. Bagian ini adalah
**frontend PWA** yang di-host di GitHub Pages. Datanya disimpan di Google Spreadsheet
dan diakses lewat Web App Google Apps Script.

```
Pengguna → GitHub Pages (PWA ini) → Web App Apps Script → Google Spreadsheet
                    ↓
            Cache + antrean lokal  →  tetap jalan tanpa internet
```

## Isi repositori

| Berkas | Peran |
|---|---|
| `index.html` | Kerangka aplikasi, seluruh CSS disematkan di dalamnya |
| `app.js` | Semua logika: 8 modul, cache offline, antrean sinkronisasi |
| `sw.js` | Service worker — sumber kemampuan offline |
| `manifest.json` | Metadata pemasangan (nama, ikon, warna, layar penuh) |
| `icon.svg` | Ikon aplikasi |

## Pemasangan

### 1. Siapkan sisi Apps Script lebih dulu

PWA ini tidak menyimpan data sendiri, jadi backend harus siap:

1. Buat Google Spreadsheet baru → **Ekstensi → Apps Script**.
2. Tempelkan berkas `Code.gs`, `Sheets.gs`, `Progress.gs`, `AI.gs`, `Quran.gs`,
   `DataSeed.gs`, dan `Index.html`.
3. Muat ulang Spreadsheet, jalankan menu **🕌 Nur Youth → 1. Siapkan / Perbaiki Semua Sheet**.
4. **Deploy → Deployment baru → Web app**:
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**
5. Salin URL yang berakhiran `/exec`.

### 2. Sambungkan PWA ke backend

Buka `app.js`, isi baris pertama:

```js
var WEB_APP_URL_INJEKSI = "https://script.google.com/macros/s/AKfycb.../exec";
```

Tanpa langkah ini aplikasi akan menampilkan pesan bahwa `WEB_APP_URL` belum diisi.

### 3. Aktifkan GitHub Pages

1. Unggah kelima berkas ke repositori (boleh di akar atau folder `docs/`).
2. **Settings → Pages → Source: Deploy from a branch**, pilih `main` dan foldernya.
3. Tunggu satu-dua menit, lalu buka `https://<akun>.github.io/<repo>/`.

Service worker hanya aktif di HTTPS atau `localhost` — GitHub Pages sudah HTTPS,
jadi tidak perlu penyetelan tambahan.

### 4. Pasang di ponsel

- **Android/Chrome**: menu ⋮ → *Tambahkan ke layar utama*
- **iOS/Safari**: tombol Bagikan → *Tambahkan ke Layar Utama*

## Cara mode offline bekerja

Saat pertama kali dibuka dengan internet, aplikasi mengunduh seluruh materi
(surah, mufrodat, tajwid, makhraj, dzikir, doa, kultum, khutbah, tuntunan sholat)
dan menyimpannya di perangkat.

Setelah itu:

- **Membaca materi** — berjalan penuh tanpa internet.
- **Menandai hafalan, tasbih, kuis, catatan waktu belajar** — tersimpan lokal dan
  masuk antrean. Begitu koneksi kembali, antrean dikirim otomatis dan progres
  di Spreadsheet ikut diperbarui.
- **Ayat lengkap satu surah** — perlu internet sekali. Sesudah diunduh, ayat itu
  tersimpan dan bisa dibuka lagi kapan saja.
- **Lima fitur AI** (kultum, khutbah, tanya tajwid, tutor Arab, verifikasi lafal) —
  butuh internet. Saat offline, aplikasi memakai materi bawaan dan, untuk
  verifikasi lafal, penilaian kemiripan lokal.

Indikator di kanan atas menunjukkan status: `● Online`, `⚡ Offline`, atau
`⏳ n tertunda` bila masih ada perubahan yang menunggu dikirim.

## Setelah memperbarui berkas

Naikkan `VERSI` di `sw.js`, misalnya dari `nur-youth-v1` ke `nur-youth-v2`.
Tanpa itu, perangkat yang sudah memasang aplikasi akan tetap memakai berkas lama
dari cache.

## Delapan modul

| Modul | Isi |
|---|---|
| 📖 Hafalan Qur'an | Pilih surah, dengarkan bacaan, tandai ayat hafal, target harian |
| 🔤 Bahasa Arab & Kuis | Kamus mufrodat berkategori, kuis pilihan ganda, tutor kalimat AI |
| 🎙️ Tajwid Interaktif | Hukum tajwid, contoh bacaan, makharijul huruf, uji lafal via mikrofon |
| 🕌 Ceramah & Khutbah | Kultum 7 menit dan khutbah Jum'at dua bagian, siap pakai atau dibuat AI |
| 🤲 Dzikir & Doa | Dzikir pagi/sore dan doa harian dengan tasbih digital |
| 🧭 Tuntunan Sholat | Langkah sholat berurutan plus jadwal sholat harian |
| 📅 Kalender Belajar | Peta kepadatan belajar bulanan dan pengingat harian |
| 🏆 Progres & Poin | XP, level, streak, lencana, grafik 14 hari, cadangan data |

## Catatan teknis

- Tidak ada dependensi eksternal dan tidak ada CDN — semua CSS dan JS ada di
  repositori ini, supaya mode offline benar-benar utuh.
- Permintaan tulis dikirim sebagai `Content-Type: text/plain` agar tidak memicu
  preflight CORS terhadap Apps Script.
- Pembacaan suara memakai Web Speech API bawaan peramban. Ketersediaan suara
  berbahasa Arab berbeda antar perangkat.
- Pengenalan suara untuk uji lafal butuh Chrome (Android atau desktop); Safari
  belum mendukungnya dengan baik.
- Pengingat berjalan selama aplikasi terbuka. Untuk pengingat yang jalan sendiri,
  buat trigger harian di Apps Script.
