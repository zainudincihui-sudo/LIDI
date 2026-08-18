# LIDI — Skema Database & API
### Dokumen teknis, dijelaskan langkah demi langkah untuk pemula

---

## 0. Sebelum mulai — apa itu "skema database" dan "API"?

Bayangkan LIDI seperti **toko**:

- **Database** = gudang penyimpanan, isinya rak-rak (disebut *tabel*). Setiap rak menyimpan satu jenis barang. Misalnya rak "Wallet" isinya data semua wallet, rak "Token" isinya data semua token.
- **API** = pelayan toko. Frontend (halaman web yang sudah kita buat) tidak boleh masuk gudang sendiri — dia harus **minta ke pelayan** ("tolong ambilkan daftar token yang lagi trending"), lalu pelayan yang mengambilkan dari gudang.

Dokumen ini isinya dua hal:
1. **Rak apa saja yang perlu dibangun di gudang** (skema database)
2. **Permintaan apa saja yang bisa diajukan ke pelayan** (daftar API)

Ini murni dokumen rencana — belum ada kode. Tapi begitu ini selesai, developer (atau AI coding assistant) tinggal ikuti dokumen ini untuk membangun backend LIDI, tidak perlu menebak-nebak lagi.

---

## 1. Tabel-tabel yang dibutuhkan

Setiap tabel berikut aku jelaskan: **untuk apa**, **isinya kolom apa saja**, dan **kenapa dibutuhkan** (dikaitkan ke fitur yang sudah ada di frontend LIDI).

### 1.1 `users` — akun pengguna LIDI

Kenapa dibutuhkan: supaya orang yang follow wallet, dapat alert, atau naik ke leaderboard, datanya tersimpan permanen — bukan hilang begitu browser ditutup (seperti sekarang).

> Catatan: LIDI memutuskan **tidak mewajibkan koneksi wallet sama sekali** — ini murni platform analitik. Jadi akun user di sini pakai login biasa (email), bukan alamat wallet.

| Kolom | Tipe | Keterangan |
|---|---|---|
| `id` | UUID | ID unik user, dibuat otomatis oleh sistem |
| `email` | string | Email yang dipakai user untuk login |
| `username` | string (opsional) | Nama tampilan, bisa diisi belakangan |
| `created_at` | timestamp | Kapan user pertama kali daftar |

### 1.2 `wallets` — wallet yang dipantau LIDI (bukan cuma milik user, tapi semua wallet trader di chain)

Kenapa dibutuhkan: ini jantungnya fitur "Smart Wallets" dan "Leaderboard".

| Kolom | Tipe | Keterangan |
|---|---|---|
| `id` | UUID | ID unik di database LIDI |
| `address` | string | Alamat wallet di Robinhood Chain (unik) |
| `label` | string (opsional) | Nama panggilan seperti "AlphaWalker" |
| `win_rate` | decimal | Persentase transaksi yang untung |
| `pnl_30d` | decimal | Untung/rugi 30 hari terakhir |
| `total_trades` | integer | Jumlah transaksi yang tercatat |
| `last_active_at` | timestamp | Kapan terakhir wallet ini bertransaksi |

> Catatan: kolom seperti `win_rate` dan `pnl_30d` **tidak diisi manual** — nanti dihitung otomatis oleh sistem berdasarkan data di tabel `transactions` (dijelaskan di bawah).

### 1.3 `tokens` — daftar token/memecoin yang dipantau

Kenapa dibutuhkan: ini yang mengisi fitur "Trending Tokens".

| Kolom | Tipe | Keterangan |
|---|---|---|
| `id` | UUID | ID unik di database LIDI |
| `contract_address` | string | Alamat kontrak token di chain (unik) |
| `ticker` | string | Contoh: `$LIDI` |
| `name` | string | Contoh: "LIDI Network" |
| `price_usd` | decimal | Harga saat ini |
| `volume_24h` | decimal | Volume transaksi 24 jam |
| `holder_count` | integer | Jumlah pemegang token |
| `price_change_24h` | decimal | Persentase naik/turun harga |
| `icon_url` | string, nullable | URL logo/icon token |
| `decimals` | integer, nullable | Jumlah desimal token (mis. 18 untuk kebanyakan ERC-20) -- dipakai sync-transactions sebagai fallback saat payload transfer dari Blockscout tidak menyertakan `total.decimals` |
| `launchpad` | string, nullable | Launchpad/factory yang men-deploy token ini (`pons`, `virtuals`), diisi oleh sync-launchpad berdasarkan alamat deployer kontrak. `NULL` kalau deployer tidak cocok dengan launchpad manapun yang dikenal (lihat issue #17) |
| `launchpad_checked_at` | timestamp, nullable | Kolom internal untuk sync-launchpad: kapan terakhir kali `launchpad` token ini dicek/diklasifikasi. `NULL` = belum pernah dicek (diprioritaskan duluan). Bukan untuk ditampilkan di UI |

### 1.4 `transactions` — catatan setiap transaksi on-chain

Kenapa dibutuhkan: ini **sumber data mentah** — dari sinilah "Live Activity" ditampilkan, dan dari sinilah `win_rate`/`pnl_30d` di tabel wallets dihitung.

| Kolom | Tipe | Keterangan |
|---|---|---|
| `id` | UUID | ID unik transaksi |
| `wallet_id` | UUID (relasi ke `wallets`) | Wallet mana yang melakukan transaksi |
| `token_id` | UUID (relasi ke `tokens`) | Token apa yang ditransaksikan |
| `type` | enum (`buy` / `sell`) | Jenis transaksi |
| `amount` | decimal | Jumlah token |
| `value_usd` | decimal | Nilai transaksi dalam USD |
| `tx_hash` | string | Hash transaksi di blockchain (bukti asli) |
| `occurred_at` | timestamp | Kapan transaksi terjadi |

### 1.5 `follows` — siapa follow wallet siapa

Kenapa dibutuhkan: ini fitur "Follow" yang sudah ada tombolnya di frontend.

| Kolom | Tipe | Keterangan |
|---|---|---|
| `id` | UUID | ID unik |
| `user_id` | UUID (relasi ke `users`) | User yang melakukan follow |
| `wallet_id` | UUID (relasi ke `wallets`) | Wallet yang di-follow |
| `created_at` | timestamp | Kapan mulai follow |

### 1.6 `alerts` — notifikasi yang dikirim ke user

Kenapa dibutuhkan: ini fitur panel 🔔 yang sudah ada di frontend.

| Kolom | Tipe | Keterangan |
|---|---|---|
| `id` | UUID | ID unik |
| `user_id` | UUID (relasi ke `users`) | Alert ini untuk siapa |
| `transaction_id` | UUID (relasi ke `transactions`) | Transaksi apa yang memicu alert ini |
| `message` | string | Isi notifikasi, contoh: "AlphaWalker bought $CAT" |
| `is_read` | boolean | Sudah dibaca atau belum |
| `created_at` | timestamp | Kapan alert dibuat |

---

## 2. Bagaimana tabel-tabel ini saling terhubung

```
users ──< follows >── wallets ──< transactions >── tokens
  │                                    │
  └──────────< alerts >────────────────┘
```

Cara baca diagram ini: satu `user` bisa follow banyak `wallet` (lewat tabel `follows`), satu `wallet` bisa melakukan banyak `transaction`, dan satu `transaction` bisa memicu satu `alert` untuk user yang follow wallet tersebut.

---

## 3. Daftar API yang dibutuhkan frontend

Ini "menu permintaan" yang bisa diajukan frontend ke backend. Aku kelompokkan sesuai fitur yang sudah ada di halaman LIDI:

### Trending Tokens
- `GET /api/tokens/trending` → daftar token yang sedang naik, untuk grid di tab Trending
- `GET /api/tokens/:id` → detail satu token

### Smart Wallets
- `GET /api/wallets/top` → daftar wallet dengan performa terbaik, untuk tab Smart Wallets
- `GET /api/wallets/:address` → detail satu wallet (dipakai juga untuk halaman detail nanti)

### Live Activity
- `GET /api/activity/recent` → daftar transaksi terbaru, untuk tab Live Activity
- (nanti, versi lanjutan) `WebSocket /api/activity/stream` → supaya data masuk otomatis real-time, tidak perlu refresh

### Leaderboard
- `GET /api/leaderboard?period=30d` → ranking trader terbaik

### Follow & Alerts
- `POST /api/follows` → follow sebuah wallet (body: `wallet_id`)
- `DELETE /api/follows/:id` → unfollow
- `GET /api/alerts` → daftar alert milik user yang sedang login
- `PATCH /api/alerts/:id/read` → tandai alert sudah dibaca

### Search
- `GET /api/search?q=...` → cari token dan wallet sekaligus (menggantikan search JS statis yang sekarang)

### Auth (login via email — bukan wallet)
- `POST /api/auth/signup` → daftar akun baru pakai email
- `POST /api/auth/login` → login dengan email

---

## 4. Langkah selanjutnya — apa yang harus kamu lakukan dengan dokumen ini

Karena kamu masih awam soal teknis, ini urutan yang aku sarankan:

1. **Simpan dokumen ini** — ini jadi "peta" resmi buat siapapun yang mengerjakan backend LIDI nanti, termasuk kalau kamu pakai AI coding assistant seperti Claude Code.
2. **Putuskan siapa yang akan membangun backend-nya** — ada dua opsi:
   - Kamu belajar sedikit dan pakai AI coding tool (Claude Code) untuk dibimbing membangunnya bertahap
   - Kamu cari developer/tim untuk mengerjakan berdasarkan dokumen ini
3. **Baru setelah itu**, backend sungguhan mulai dikerjakan: pilih bahasa pemrograman, hosting, dan provider database — ini topik terpisah yang bisa kita bahas kalau kamu sudah siap ke tahap itu.

Untuk sekarang, kamu tidak perlu paham detail teknis di atas — cukup tahu bahwa dokumen ini adalah **cetak biru** yang membuat langkah selanjutnya jauh lebih jelas dan tidak asal tebak.
