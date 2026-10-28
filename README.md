# BOTLAUNCH AI

Dashboard + API untuk meng-upload template bot (ZIP), menganalisisnya, menyiapkan workspace, memasang dependensi, mengisi environment variable, lalu **menjalankan dan memantau bot** (Node.js / TypeScript dengan script `start`).

## Cara kerja (alur)
1. **Upload ZIP** → server memeriksa isi arsip (path traversal, symlink, jumlah/ukuran file) dan mendeteksi bahasa, entry point, dependensi, env var, fitur.
2. **Prepare workspace** → ZIP diekstrak aman ke `storage/workspaces/<id>` (ukuran nyata dihitung saat ekstraksi).
3. **Install dependencies** → `npm install --ignore-scripts` dijalankan di workspace (script lifecycle dimatikan).
4. **Environment variables** → isi token/API key per bot. Nilai disimpan di server dan tidak pernah dikirim balik ke browser.
5. **Start / Stop / Restart** → bot berjalan sebagai child process (`npm start`, atau `node <entry>` bila tidak ada script start). Stdout/stderr tampil di panel **Bot console** (cocok untuk QR WhatsApp).
6. **Backup** → ZIP workspace (tanpa `node_modules`) dapat diunduh.

Install/Start/Stop hanya aktif bila `ENABLE_RUNNER=true` **dan** `ADMIN_TOKEN` (min. 12 karakter) diatur. Tanpa itu dashboard tetap bisa analisis/setup/backup, tetapi tidak menjalankan kode apa pun.

## Jalankan lokal
Butuh Node.js 20+ (22 disarankan).

```bash
npm install
cp .env.example .env            # opsional; atau export variabel di bawah
export ADMIN_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
echo $ADMIN_TOKEN               # simpan, dipakai untuk login dashboard
export ENABLE_RUNNER=true
npm run dev
```
Buka `http://localhost:5173` (API di port 4000), masukkan token saat diminta.

> Windows (PowerShell): `$env:ADMIN_TOKEN="isi-token-minimal-12-karakter"; $env:ENABLE_RUNNER="true"; npm run dev`

## Build produksi
```bash
npm install --include=dev
npm run build
NODE_ENV=production ADMIN_TOKEN=... ENABLE_RUNNER=true npm start
```
Buka `http://localhost:4000`.

## Docker
```bash
printf "ADMIN_TOKEN=%s\nENABLE_RUNNER=true\n" "$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")" > .env
docker compose up --build -d
```
Data tersimpan di volume `botlaunch-data`.

## Deploy ke Render via GitHub
1. Push semua file ke repository GitHub.
2. Render → **New → Blueprint** → pilih repo (memakai `render.yaml`).
3. `ADMIN_TOKEN` dibuat otomatis: lihat di Render → service → **Environment**, lalu pakai untuk login.
4. Biarkan persistent disk terpasang di `/var/data/botlaunch`. Cek `/api/health`.

GitHub Pages **tidak** bisa dipakai (hanya hosting statis; butuh server Node untuk API dan bot).

## APK Android lewat GitHub (tanpa Android Studio)
Workflow `.github/workflows/build-apk.yml` membangun APK otomatis di server GitHub (Capacitor + Gradle).

**Cara paling ringkas (cukup upload ZIP):**
1. Buat repository GitHub baru.
2. **Add file → Upload files** → upload `BOTLAUNCH-AI.zip` apa adanya (jangan di-extract), lalu *Commit*.
3. **Add file → Create new file** → nama file: `.github/workflows/build-apk.yml` → tempel isi file `build-apk.yml` → *Commit*.
4. Buka tab **Actions** dan tunggu ±10–15 menit sampai hijau. ZIP otomatis diekstrak ke repo.
5. Buka **Releases** → unduh `BOTLAUNCH-AI.apk` → pasang di Android (izinkan install dari sumber ini).
6. Buka aplikasi, isi alamat server (`https://...`) dan `ADMIN_TOKEN`.

Setiap kali Anda upload ZIP baru atau mengubah file, APK baru dibuat otomatis dan bisa dipasang menimpa versi lama (kunci tanda tangan `ci/debug.keystore` dipakai tetap).

Catatan:
- APK hanyalah "remote control". **Server (Render/Docker) tetap harus online** karena bot berjalan di server. GitHub tidak bisa menjalankan bot 24 jam.
- Alamat server harus **https**.
- `ci/debug.keystore` adalah kunci debug publik: cukup untuk install pribadi, **bukan** untuk Google Play. Untuk rilis resmi buat keystore sendiri dan simpan sebagai GitHub Secret.

## Pasang sebagai aplikasi (PWA)
Setelah di-deploy lewat HTTPS (Render otomatis HTTPS), buka URL-nya di HP:
- **Android (Chrome)**: menu ⋮ → *Install app* / *Add to Home screen*.
- **iPhone (Safari)**: tombol Share → *Add to Home Screen*.
- **Desktop (Chrome/Edge)**: ikon install di address bar.

Aplikasi terbuka layar penuh dengan ikon sendiri. Server tetap harus online karena bot berjalan di server, bukan di HP.

## Environment variable server
| Nama | Fungsi | Default |
|---|---|---|
| `ADMIN_TOKEN` | Token login dashboard/API (min. 12 karakter) | kosong (tanpa login, runner mati) |
| `ENABLE_RUNNER` | Izinkan install/start bot | `false` |
| `MAX_RUNNING_BOTS` | Batas bot aktif bersamaan | `3` |
| `BOT_MEMORY_MB` | Batas heap Node per bot (`--max-old-space-size`) | `384` |
| `MAX_UPLOAD_MB` | Batas ukuran ZIP | `50` |
| `BOTLAUNCH_STORAGE` | Folder data persisten | `./storage` |
| `CORS_ORIGIN` | Hanya jika frontend beda origin | – |

## Perintah
```bash
npm test            # vitest (analyzer, validasi path, validasi env)
npm run typecheck   # tsc server + frontend
npm run build
```

## Keamanan — baca sebelum dipakai publik
- Bot berjalan sebagai **child process biasa, bukan sandbox**. Kode di dalam ZIP bisa membaca file yang dapat diakses user proses server. Hanya jalankan template yang Anda percaya, dan sebaiknya di container/VM khusus.
- Environment child process dibersihkan (rahasia server seperti `ADMIN_TOKEN` tidak diteruskan); nama variabel sensitif (`PATH`, `NODE_OPTIONS`, `LD_*`, dll.) ditolak.
- Satu token admin, tanpa multi-user. Pasang HTTPS (Render/reverse proxy) agar token tidak lewat HTTP polos.
- Jangan jalankan lebih dari satu replika yang berbagi file JSON yang sama.
- Log bot hanya di memori dan hilang saat server restart; bot tidak otomatis hidup lagi setelah restart server (tekan Start).
- Python runner, sesi/pairing WhatsApp bawaan, dan integrasi AI belum ada; pairing dilakukan oleh template bot itu sendiri.
