const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const moment = require('moment-timezone');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'MLBB Bot is running',
        time: moment().tz('Asia/Jakarta').format('YYYY-MM-DD HH:mm:ss')
    });
});

// Webhook endpoint untuk Pakasir (HANYA TOPUP)
app.post('/webhook/pakasir', (req, res) => {
    try {
        const webhookData = req.body;
        console.log('📩 WEBHOOK RECEIVED:', JSON.stringify(webhookData, null, 2));

        const { order_id, status, amount } = webhookData;

        // CEK DATABASE
        console.log('📁 Membaca database.json...');
        let db = { pending_topups: {}, users: {} };
        
        if (fs.existsSync('database.json')) {
            const fileContent = fs.readFileSync('database.json', 'utf8');
            db = JSON.parse(fileContent);
            console.log(`✅ Database loaded. ${Object.keys(db.pending_topups || {}).length} pending topups`);
        } else {
            console.log('❌ database.json TIDAK DITEMUKAN!');
            return res.status(200).json({ status: 'ok' });
        }

        // CEK APAKAH INI TOPUP (HARUS DIAWALI TOPUP-)
        if (!order_id || !order_id.startsWith('TOPUP-')) {
            console.log(`⚠️ Bukan transaksi topup (order_id: ${order_id}) - IGNORED`);
            return res.status(200).json({ status: 'ok' });
        }

        console.log(`💰 Transaksi TOPUP: ${order_id}`);
        
        // CEK APAKAH ORDER ADA DI PENDING
        if (!db.pending_topups || !db.pending_topups[order_id]) {
            console.log(`❌ Order ${order_id} TIDAK DITEMUKAN di pending_topups!`);
            console.log('📋 Daftar pending_topups:', Object.keys(db.pending_topups || {}));
            return res.status(200).json({ status: 'ok' });
        }

        const topup = db.pending_topups[order_id];
        console.log(`✅ Order ditemukan! User: ${topup.userId}, Amount: ${topup.amount}`);
        
        // CEK APAKAH SUDAH DIPROSES
        if (topup.processed) {
            console.log(`⚠️ Order ${order_id} sudah diproses sebelumnya`);
            return res.status(200).json({ status: 'ok' });
        }
        
        // PROSES HANYA JIKA STATUS COMPLETED/PAID/SUCCESS
        if (status === 'completed' || status === 'paid' || status === 'success') {
            console.log(`🎉 PEMBAYARAN SUKSES!`);
            
            // Update status
            db.pending_topups[order_id].status = 'paid';
            db.pending_topups[order_id].processed = true;
            
            // PASTIKAN USER ADA
            const userId = topup.userId;
            if (!db.users[userId]) {
                db.users[userId] = { credits: 0, topup_history: [] };
                console.log(`👤 User ${userId} baru dibuat`);
            }
            
            if (!db.users[userId].topup_history) {
                db.users[userId].topup_history = [];
            }
            
            // SALDO SEBELUM
            const saldoSebelum = db.users[userId].credits || 0;
            console.log(`💰 Saldo sebelum: Rp ${saldoSebelum.toLocaleString()}`);
            
            // TAMBAH SALDO
            const jumlah = amount || topup.amount;
            db.users[userId].credits = saldoSebelum + jumlah;
            
            console.log(`➕ Menambah: Rp ${jumlah.toLocaleString()}`);
            console.log(`💰 Saldo setelah: Rp ${db.users[userId].credits.toLocaleString()}`);
            
            // CATAT HISTORY
            db.users[userId].topup_history.push({
                amount: jumlah,
                order_id: order_id,
                date: new Date().toISOString(),
                method: 'qris'
            });
            
            // HAPUS DARI PENDING (SUDAH DIPROSES)
            delete db.pending_topups[order_id];
            
            // SIMPAN DATABASE
            fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
            console.log(`✅ Database tersimpan!`);
            
            // OPSIONAL: KIRIM NOTIF KE USER (JIKA BOT TOKEN TERSEDIA)
            try {
                const TelegramBot = require('node-telegram-bot-api');
                if (process.env.BOT_TOKEN) {
                    const bot = new TelegramBot(process.env.BOT_TOKEN);
                    bot.sendMessage(userId,
                        `✅ TOP UP BERHASIL\n\n` +
                        `Nominal: Rp ${jumlah.toLocaleString()}\n` +
                        `Saldo sekarang: Rp ${db.users[userId].credits.toLocaleString()}`
                    ).catch(e => console.log('Gagal kirim notif:', e.message));
                }
            } catch (e) {
                console.log('Notifikasi tidak dikirim (bot token tidak tersedia)');
            }
            
        } else {
            console.log(`⏳ Status pembayaran: ${status} - BELUM COMPLETED`);
        }

        res.status(200).json({ status: 'ok' });
    } catch (error) {
        console.error('❌ WEBHOOK ERROR:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🌐 Webhook server running on port ${PORT}`);
    console.log(`📌 Hanya memproses transaksi TOPUP (order_id dimulai dengan TOPUP-)`);
});
