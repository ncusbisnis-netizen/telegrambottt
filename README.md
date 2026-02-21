# MLBB Telegram Bot

Bot Telegram untuk cek informasi akun Mobile Legends dengan sistem premium via Pakasir.

## Fitur
- ✅ Cek ID Mobile Legends (/info ID SERVER)
- ✅ Sistem premium dengan QRIS (Pakasir)
- ✅ Auto activate via webhook
- ✅ Ranking pengguna
- ✅ Broadcast message

## Command untuk User
- `/start` - Mulai bot
- `/info 123456 1234` - Cek akun MLBB
- `/status` - Cek status akun
- `/langganan` - Lihat paket premium
- `/bayar 1/3/7/30` - Beli premium
- `/cek ORDERID` - Cek status pembayaran

## Command untuk Admin
- `/offinfo` - Matikan fitur info
- `/oninfo` - Hidupkan fitur info
- `/ranking` - Lihat ranking user
- `/listpremium` - Lihat user premium
- `/addpremium USERID DURASI` - Tambah premium manual
- `/broadcast PESAN` - Kirim broadcast

## Deploy ke Heroku

### 1. Clone repository
```bash
git clone https://github.com/username/bot-mlbb-telegram.git
cd bot-mlbb-telegram
