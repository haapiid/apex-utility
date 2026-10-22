# Konten X (Twitter) — ApeX Utility

| File | Untuk | Ukuran |
|---|---|---|
| `logo-x-400.png` | Foto profil X | 400×400 (X memotongnya bulat) |
| `banner-x-1500x500.png` | Header / banner profil X | 1500×500 (sepertiga kiri bawah tertutup foto profil, sengaja dikosongkan) |
| `post-x.gif` | GIF postingan: paste token → Buy → Bought, looping | 648×648, 10 fps |
| `demo-x-1080p.mp4` | Video demo ±37 detik, tanpa audio | 1920×1080, H.264 |

Semua dibuat dari maskot yang sudah disetujui (`assets/mascot/apex-mascot-master.png`, lewat potongan
`website/img/mascot-hero.png`) dan palet brand. Tidak ada gambar maskot baru.
Layar ApeX Pro di video adalah screenshot asli dari pro.apexutility.fun (halaman token BONK dan bubble
map). Halaman Discover dan pump.fun sengaja tidak dipakai: isinya token live dengan nama yang tidak bisa
dikontrol.

## Render ulang

Sumbernya ada di `remotion/` (proyek terpisah, tidak memengaruhi aplikasi ApeX).

```
cd konten-x/remotion
npm install
node render.mjs              # semuanya
node render.mjs banner gif   # sebagian: logo | banner | gif | demo
npm run studio               # pratinjau dan edit di browser
```

Teks ada di `src/stills.jsx` (logo, banner), `src/PostGif.jsx` (GIF) dan `src/Demo.jsx` (video).
Screenshot ApeX Pro ada di `remotion/public/shots/`.
