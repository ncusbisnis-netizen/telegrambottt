const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const moment = require('moment-timezone');
const { exec } = require('child_process');

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
        time: moment().tz('Asia/Jakarta').format('YYYY-MM-DD HH:mm:ss'),
        webhook: process.env.WEBHOOK_URL || 'not set'
    });
});

// Webhook endpoint untuk Pakasir
app.post('/webhook/pakasir', (req, res) => {
    try {
        const webhookData = req.body;
        console.log('📩 Webhook received:', JSON.stringify(webhookData, null, 2));

        // Format webhook dari Pakasir
        const { order_id, status, amount } = webhookData;

        // Baca database
        let db = { pending_payments: {}, premium: {} };
        if (fs.existsSync('database.json')) {
            db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
        }

        // Cek apakah order_id ada di pending_payments
        if (db.pending_payments && db.pending_payments[order_id]) {
            const payment = db.pending_payments[order_id];

            if (status === 'completed' || status === 'paid' || status === 'success') {
                // Update status di database
                db.pending_payments[order_id].status = 'paid';
                
                // Hitung expired date
                const days = {
                    '1 Hari': 1,
                    '3 Hari': 3,
                    '7 Hari': 7,
                    '30 Hari': 30
                }[payment.duration] || 1;
                
                const now = moment().tz('Asia/Jakarta').unix();
                const expiredAt = now + (days * 24 * 60 * 60);
                
                // Aktivasi premium
                db.premium[payment.userId] = {
                    activated_at: now,
                    expired_at: expiredAt,
                    duration: payment.duration,
                    order_id: order_id
                };
                
                // Simpan database
                fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
                console.log(`✅ Premium activated for user ${payment.userId} via webhook`);
            }
        }

        // Selalu respond dengan 200 OK
        res.status(200).json({ status: 'ok', received: true });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: error.message });
    }
});

// API untuk cek status transaksi (admin)
app.get('/api/check-payment/:orderId', (req, res) => {
    const { orderId } = req.params;
    
    let db = { pending_payments: {} };
    if (fs.existsSync('database.json')) {
        db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
    }
    
    const payment = db.pending_payments?.[orderId];
    if (payment) {
        res.json({
            order_id: orderId,
            status: payment.status,
            userId: payment.userId,
            duration: payment.duration,
            amount: payment.amount,
            created_at: payment.created_at
        });
    } else {
        res.status(404).json({ error: 'Order not found' });
    }
});

// Admin endpoint untuk lihat stats
app.get('/admin/stats', (req, res) => {
    const apiKey = req.query.key;
    if (apiKey !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    
    let db = { users: {}, premium: {}, pending_payments: {} };
    if (fs.existsSync('database.json')) {
        db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
    }
    
    res.json({
        total_users: Object.keys(db.users || {}).length,
        total_premium: Object.keys(db.premium || {}).length,
        total_pending: Object.keys(db.pending_payments || {}).length,
        total_success: db.total_success || 0
    });
});

app.listen(PORT, () => {
    console.log(`🌐 Webhook server running on port ${PORT}`);
    console.log(`🔗 Webhook URL: ${process.env.WEBHOOK_URL || 'not set'}`);
});
