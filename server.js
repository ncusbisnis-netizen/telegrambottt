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

// Webhook endpoint untuk Pakasir
app.post('/webhook/pakasir', (req, res) => {
    try {
        const webhookData = req.body;
        console.log('📩 Webhook received:', JSON.stringify(webhookData, null, 2));

        const { order_id, status, amount } = webhookData;

        // Baca database
        let db = { pending_payments: {}, pending_topups: {}, premium: {}, users: {} };
        if (fs.existsSync('database.json')) {
            db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
        }

        // CEK APAKAH TOPUP ATAU PREMIUM
        if (order_id && order_id.startsWith('TOPUP-')) {
            // ===== PROSES TOPUP =====
            if (db.pending_topups && db.pending_topups[order_id]) {
                const topup = db.pending_topups[order_id];
                
                if (status === 'completed' || status === 'paid' || status === 'success') {
                    console.log(`✅ TOPUP SUCCESS: ${order_id} untuk user ${topup.userId}`);
                    
                    // Update status
                    db.pending_topups[order_id].status = 'paid';
                    db.pending_topups[order_id].processed = true;
                    
                    // Tambah saldo user
                    if (!db.users[topup.userId]) {
                        db.users[topup.userId] = { credits: 0, topup_history: [] };
                    }
                    
                    if (!db.users[topup.userId].topup_history) {
                        db.users[topup.userId].topup_history = [];
                    }
                    
                    // Tambah saldo
                    db.users[topup.userId].credits = (db.users[topup.userId].credits || 0) + (amount || topup.amount);
                    
                    // Catat history
                    db.users[topup.userId].topup_history.push({
                        amount: amount || topup.amount,
                        order_id: order_id,
                        date: new Date().toISOString(),
                        method: 'qris'
                    });
                    
                    console.log(`💰 Saldo user ${topup.userId}: Rp ${db.users[topup.userId].credits}`);
                    
                    // Simpan database
                    fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
                    console.log(`✅ Database updated for user ${topup.userId}`);
                }
            } else {
                console.log(`⚠️ Order ${order_id} tidak ditemukan di pending_topups`);
            }
        } else if (db.pending_payments && db.pending_payments[order_id]) {
            // ===== PROSES PREMIUM =====
            const payment = db.pending_payments[order_id];

            if (status === 'completed' || status === 'paid' || status === 'success') {
                db.pending_payments[order_id].status = 'paid';
                
                const days = {
                    '1 Hari': 1,
                    '3 Hari': 3,
                    '7 Hari': 7,
                    '30 Hari': 30
                }[payment.duration] || 1;
                
                const now = moment().tz('Asia/Jakarta').unix();
                const expiredAt = now + (days * 24 * 60 * 60);
                
                if (!db.premium) db.premium = {};
                db.premium[payment.userId] = {
                    activated_at: now,
                    expired_at: expiredAt,
                    duration: payment.duration,
                    order_id: order_id
                };
                
                console.log(`✅ PREMIUM activated for user ${payment.userId} (${payment.duration})`);
                
                // Simpan database
                fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
            }
        } else {
            console.log(`⚠️ Order ${order_id} tidak ditemukan di database`);
        }

        res.status(200).json({ status: 'ok' });
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🌐 Webhook server running on port ${PORT}`);
});
