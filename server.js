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

        const { order_id, status } = webhookData;

        // Baca database
        let db = { pending_payments: {}, premium: {} };
        if (fs.existsSync('database.json')) {
            db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
        }

        // Cek apakah order_id ada
        if (db.pending_payments && db.pending_payments[order_id]) {
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
                
                db.premium[payment.userId] = {
                    activated_at: now,
                    expired_at: expiredAt,
                    duration: payment.duration,
                    order_id: order_id
                };
                
                fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
                console.log(`✅ Premium activated for user ${payment.userId}`);
            }
        }

        res.status(200).json({ status: 'ok' });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🌐 Webhook server running on port ${PORT}`);
});
