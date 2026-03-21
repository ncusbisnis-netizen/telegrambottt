const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const moment = require('moment-timezone');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const redis = require('redis');

const v8 = require('v8');
v8.setFlagsFromString('--max-old-space-size=256');

if (global.gc) {
    setInterval(() => {
        try {
            global.gc();
            console.log('Garbage collection done');
        } catch (e) {
            console.log('GC error:', e.message);
        }
    }, 60000);
}

process.on('uncaughtException', (error) => {
    console.log('ERROR GLOBAL:', error.message);
    console.log(error.stack);
});

process.on('unhandledRejection', (reason) => {
    console.log('UNHANDLED REJECTION:', reason);
});

const IS_WORKER = process.env.DYNO && process.env.DYNO.includes('worker');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL = process.env.CHANNEL;
const GROUP = process.env.GROUP;
const STOK_ADMIN = process.env.STOK_ADMIN;
const REDIS_URL = process.env.REDIS_URL || process.env.REDISCLOUD_URL;
const API_KEY_CHECKTON = process.env.API_KEY_CHECKTON || process.env.API_KEY_CHECKTON;

const ADMIN_IDS = process.env.ADMIN_IDS 
    ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) 
    : [];

let db = { 
    users: {}, 
    total_success: 0, 
    feature: { info: true },
    pending_topups: {},
    allowed_groups: [] 
};

let adminState = {};

function setAdminState(userId, action, step, data = {}) {
    adminState[userId] = { action, step, data, timestamp: Date.now() };
}

function getAdminState(userId) {
    return adminState[userId];
}

function clearAdminState(userId) {
    delete adminState[userId];
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bot_data (
                key VARCHAR(50) PRIMARY KEY,
                value JSONB NOT NULL,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('Tabel bot_data siap');
    } catch (error) {
        console.log('Gagal init database:', error.message);
    }
}

async function loadDB() {
    try {
        console.log('Loading database dari Postgres...');
        const start = Date.now();
        
        const res = await pool.query('SELECT value FROM bot_data WHERE key = $1', ['database']);
        if (res.rows.length > 0) {
            db = res.rows[0].value;
            if (!db.allowed_groups) db.allowed_groups = [];
            const duration = Date.now() - start;
            console.log(`Load database sukses. Total users: ${Object.keys(db.users || {}).length} (${duration}ms)`);
        } else {
            console.log('Database kosong, pakai default');
        }
    } catch (error) {
        console.log('Gagal load database:', error.message);
        try {
            if (fs.existsSync('database.json')) {
                const data = fs.readFileSync('database.json', 'utf8');
                db = JSON.parse(data);
                if (!db.allowed_groups) db.allowed_groups = [];
                console.log('Load dari file (fallback)');
            }
        } catch (e) {}
    }
}

async function saveDB() {
    try {
        await pool.query(
            `INSERT INTO bot_data (key, value, updated_at) 
             VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO UPDATE 
             SET value = $2, updated_at = NOW()`,
            ['database', db]
        );
        console.log('Database tersimpan di Postgres');
        
        pool.query("SELECT pg_notify('db_updated', 'reload')").catch(err => {
            console.log('Gagal mengirim NOTIFY:', err.message);
        });
        
        return true;
    } catch (error) {
        console.log('Gagal save database:', error.message);
        try {
            fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
            console.log('Database tersimpan di file (fallback)');
        } catch (e) {}
        return false;
    }
}

initDB().then(async () => {
    await loadDB();
});

let redisClient = null;
if (REDIS_URL) {
    try {
        redisClient = redis.createClient({ 
            url: REDIS_URL,
            socket: {
                reconnectStrategy: function(retries) {
                    if (retries > 10) {
                        console.log('Redis max retries reached');
                        return new Error('Max retries');
                    }
                    return Math.min(retries * 100, 3000);
                }
            }
        });
        
        redisClient.on('error', (err) => console.log('Redis Client Error', err));
        redisClient.on('connect', () => console.log('Redis connected for relay'));
        
        redisClient.connect().catch(err => {
            console.log('Redis connection failed:', err.message);
            redisClient = null;
        });
    } catch (error) {
        console.log('Redis init error:', error.message);
        redisClient = null;
    }
} else {
    console.log('REDIS_URL not set, running without Redis');
}

function isAdmin(userId) { 
    return ADMIN_IDS.includes(userId); 
}

function isGroupAllowed(groupId) {
    return db.allowed_groups && db.allowed_groups.includes(Number(groupId));
}

function getUserCredits(userId, username = '') {
    try {
        if (!db.users[userId]) {
            db.users[userId] = { 
                username: username, 
                success: 0, 
                credits: 0, 
                topup_history: [] 
            };
            console.log(`User baru dibuat: ${userId} dengan username ${username}`);
            
            saveDB().catch(err => {
                console.log('Error saving new user:', err.message);
            });
        } else if (username && db.users[userId].username !== username) {
            db.users[userId].username = username;
            saveDB().catch(err => {
                console.log('Error updating username:', err.message);
            });
        }
        
        return db.users[userId].credits || 0;
    } catch (error) {
        console.log('Error getUserCredits:', error.message);
        return 0;
    }
}

async function addCredits(userId, amount, orderId = null) {
    try {
        console.log(`ADD CREDITS: user ${userId}, amount ${amount}, order ${orderId}`);
        
        if (!db.users[userId]) {
            db.users[userId] = { 
                username: '', 
                success: 0, 
                credits: 0, 
                topup_history: [] 
            };
        }
        
        const oldBalance = db.users[userId].credits || 0;
        db.users[userId].credits += amount;
        
        if (!db.users[userId].topup_history) {
            db.users[userId].topup_history = [];
        }
        
        db.users[userId].topup_history.push({
            amount: amount,
            order_id: orderId,
            date: new Date().toISOString(),
            method: orderId ? 'qris' : 'admin'
        });
        
        await saveDB();
        
        console.log(`ADD CREDITS BERHASIL: ${oldBalance} -> ${db.users[userId].credits}`);
        return db.users[userId].credits;
    } catch (error) {
        console.log('Error addCredits:', error.message);
        return getUserCredits(userId);
    }
}

function hasActiveSubscription(userId) {
    const user = db.users[userId];
    if (!user || !user.subscription) return false;
    const now = new Date();
    const endDate = new Date(user.subscription.end_date);
    return user.subscription.active && endDate > now;
}

async function checkAndUpdateExpiredSubscription(userId) {
    const user = db.users[userId];
    if (!user || !user.subscription) return false;
    
    const now = new Date();
    const endDate = new Date(user.subscription.end_date);
    
    if (user.subscription.active && endDate <= now) {
        user.subscription.active = false;
        await saveDB();
        console.log(`Langganan user ${userId} expired pada ${endDate}, status dinonaktifkan`);
        
        try {
            await bot.sendMessage(userId,
                `NOTIFIKASI LANGGANAN\n\n` +
                `Langganan Anda telah berakhir.\n\n` +
                `Akses unlimited untuk fitur /cek dan /find telah dinonaktifkan.\n` +
                `Silakan perpanjang langganan untuk mendapatkan akses kembali.\n\n` +
                `Ketik /start atau tekan tombol LANGGANAN untuk memperpanjang.`
            );
        } catch (notifError) {
            console.log(`Gagal kirim notifikasi expired ke ${userId}:`, notifError.message);
        }
        
        return false;
    }
    
    return user.subscription.active && endDate > now;
}

async function activateSubscription(userId, type) {
    const now = new Date();
    let endDate;
    if (type === '7days') {
        endDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    } else if (type === '30days') {
        endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    } else {
        return false;
    }
    
    if (!db.users[userId]) {
        db.users[userId] = { username: '', success: 0, credits: 0, topup_history: [] };
    }
    db.users[userId].subscription = {
        active: true,
        type: type,
        start_date: now.toISOString(),
        end_date: endDate.toISOString()
    };
    await saveDB();
    return true;
}

async function buySubscriptionWithBalance(userId, subscriptionType) {
    const amount = subscriptionType === '7days' ? 50000 : 100000;
    const credits = getUserCredits(userId);
    
    if (credits < amount) {
        return { success: false, error: 'Saldo tidak cukup' };
    }
    
    db.users[userId].credits -= amount;
    
    if (!db.users[userId].topup_history) db.users[userId].topup_history = [];
    db.users[userId].topup_history.push({
        amount: -amount,
        order_id: `SUB-${subscriptionType}-${Date.now()}`,
        date: new Date().toISOString(),
        method: 'balance'
    });
    
    const now = new Date();
    const duration = subscriptionType === '7days' ? 7 : 30;
    
    const existingSub = db.users[userId].subscription;
    let newEndDate;
    let startDate;
    let wasActive = false;
    
    if (existingSub && existingSub.active && new Date(existingSub.end_date) > now) {
        const currentEndDate = new Date(existingSub.end_date);
        newEndDate = new Date(currentEndDate.getTime() + duration * 24 * 60 * 60 * 1000);
        startDate = existingSub.start_date;
        wasActive = true;
        console.log(`Perpanjang langganan: dari ${currentEndDate} menjadi ${newEndDate}`);
    } else {
        newEndDate = new Date(now.getTime() + duration * 24 * 60 * 60 * 1000);
        startDate = now.toISOString();
        console.log(`Langganan baru: mulai ${now} sampai ${newEndDate}`);
    }
    
    db.users[userId].subscription = {
        active: true,
        type: subscriptionType,
        start_date: startDate,
        end_date: newEndDate.toISOString()
    };
    
    await saveDB();
    
    try {
        const endDateFormatted = moment(newEndDate).tz('Asia/Jakarta').format('DD MMMM YYYY HH:mm');
        if (wasActive) {
            await bot.sendMessage(userId,
                `LANGGANAN DIPERPANJANG\n\n` +
                `Paket: ${subscriptionType === '7days' ? '7 Hari' : '30 Hari'}\n` +
                `Biaya: Rp ${amount.toLocaleString()}\n` +
                `Sisa saldo: Rp ${db.users[userId].credits.toLocaleString()}\n` +
                `Berlaku sampai: ${endDateFormatted} WIB\n\n` +
                `Terima kasih telah memperpanjang langganan!`
            );
        } else {
            await bot.sendMessage(userId,
                `LANGGANAN AKTIF\n\n` +
                `Selamat! Langganan Anda telah aktif.\n\n` +
                `Paket: ${subscriptionType === '7days' ? '7 Hari' : '30 Hari'}\n` +
                `Biaya: Rp ${amount.toLocaleString()}\n` +
                `Sisa saldo: Rp ${db.users[userId].credits.toLocaleString()}\n` +
                `Berlaku sampai: ${endDateFormatted} WIB\n\n` +
                `Anda sekarang memiliki akses unlimited ke fitur /cek dan /find.`
            );
        }
    } catch (notifError) {
        console.log('Gagal kirim notifikasi langganan:', notifError.message);
    }
    
    return { success: true, newBalance: db.users[userId].credits, endDate: newEndDate };
}

function formatRupiah(amount) {
    try {
        return 'Rp ' + amount.toLocaleString();
    } catch {
        return 'Rp ' + amount;
    }
}

async function checkJoin(bot, userId) {
    try {
        if (!CHANNEL || !GROUP) {
            console.log('Channel atau Group tidak dikonfigurasi, checkJoin dinonaktifkan');
            return { channel: true, group: true };
        }
        
        let isChannelMember = false, isGroupMember = false;
        
        if (CHANNEL) {
            try {
                const channelCheck = await bot.getChatMember(CHANNEL, userId);
                isChannelMember = ['member', 'administrator', 'creator'].includes(channelCheck.status);
            } catch (channelError) {
                console.log(`Channel ${CHANNEL} error:`, channelError.message);
                isChannelMember = false;
            }
        } else {
            isChannelMember = true;
        }
        
        if (GROUP) {
            try {
                const groupCheck = await bot.getChatMember(GROUP, userId);
                isGroupMember = ['member', 'administrator', 'creator'].includes(groupCheck.status);
            } catch (groupError) {
                console.log(`Group ${GROUP} error:`, groupError.message);
                isGroupMember = false;
            }
        } else {
            isGroupMember = true;
        }
        
        return { channel: isChannelMember, group: isGroupMember };
    } catch (error) {
        console.log('checkJoin error:', error.message);
        return { channel: false, group: false };
    }
}

async function getMLBBData(userId, serverId, type = 'lookup') {
    try {
        console.log(`Mengambil data ${type} untuk ${userId} server ${serverId} dari Checkton`);
        
        const payload = {
            role_id: String(userId).trim(),
            zone_id: String(serverId).trim(),
            type: type
        };
        
        const response = await axios.post("https://checkton.online/backend/info", payload, {
            headers: { 
                "Content-Type": "application/json",
                "x-api-key": API_KEY_CHECKTON
            },
            timeout: 30000
        });
        
        console.log(`Checkton response status: ${response.status}`);
        
        if (response.data) {
            if (response.data.status === -1) {
                console.log('Akun tidak ditemukan:', response.data.message);
                return { error: true, message: 'not_found' };
            }
            
            if (response.data.data && Object.keys(response.data.data).length > 0) {
                return response.data.data;
            }
            
            if (response.data.role_id || response.data.name || response.data.level) {
                return response.data;
            }
            
            if (response.data.status === 0 && response.data.data) {
                return response.data.data;
            }
        }
        
        console.log('Tidak ada data yang valid dalam response');
        return { error: true, message: 'no_data' };
        
    } catch (error) {
        console.log(`Error getMLBBData:`, error.message);
        return { error: true, message: error.message };
    }
}

async function findPlayerByName(name) {
    try {
        console.log(`Mencari player dengan nama: ${name}`);
        
        const payload = {
            name: String(name).trim(),
            type: "find"
        };
        
        const response = await axios.post("https://checkton.online/backend/info", payload, {
            headers: { 
                "Content-Type": "application/json",
                "x-api-key": API_KEY_CHECKTON
            },
            timeout: 60000
        });
        
        console.log(`Find response status: ${response.status}`);
        
        if (response.data) {
            if (response.data.status === 0 && response.data.data) {
                if (Array.isArray(response.data.data)) {
                    return response.data.data;
                }
                return [response.data.data];
            }
            
            if (Array.isArray(response.data)) {
                return response.data;
            }
            
            if (response.data.role_id) {
                return [response.data];
            }
            
            if (response.data.data && Array.isArray(response.data.data)) {
                return response.data.data;
            }
        }
        
        console.log('Tidak ada data yang valid dalam response find');
        return null;
        
    } catch (error) {
        console.log(`Error findPlayerByName:`, error.message);
        return null;
    }
}

function formatLocations(locations, maxItems = 5) {
    try {
        if (!locations || !Array.isArray(locations) || locations.length === 0) {
            return '';
        }
        const limitedLocations = locations.slice(0, maxItems);
        let result = limitedLocations.join(', ');
        if (locations.length > maxItems) {
            result += `, +${locations.length - maxItems} lagi`;
        }
        return result;
    } catch (error) {
        console.log('Error formatLocations:', error.message);
        return '';
    }
}

async function createPakasirTopup(amount, userId, username = '') {
    try {
        const orderId = `TOPUP-${userId}-${Date.now()}`;
        console.log(`Membuat topup: ${orderId}, amount: ${amount}, user: ${userId}`);
        
        if (!db.users[userId]) {
            db.users[userId] = { 
                username: username, 
                success: 0, 
                credits: 0, 
                topup_history: [] 
            };
            console.log(`USER BARU DIBUAT SAAT TOPUP: ${userId} (${username})`);
            await saveDB();
        } else if (username && db.users[userId].username !== username) {
            db.users[userId].username = username;
            await saveDB();
        }
        
        const response = await axios.post(
            `${process.env.PAKASIR_BASE_URL || 'https://app.pakasir.com/api'}/transactioncreate/qris`,
            { 
                project: process.env.PAKASIR_SLUG || 'ncusspayment', 
                order_id: orderId, 
                amount, 
                api_key: process.env.PAKASIR_API_KEY 
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        
        if (response.data?.payment) {
            const payment = response.data.payment;
            const expiredAt = moment(payment.expired_at).tz('Asia/Jakarta');
            
            if (!db.pending_topups) {
                db.pending_topups = {};
            }
            
            db.pending_topups[orderId] = {
                userId: userId,
                amount: amount,
                status: 'pending',
                created_at: Date.now(),
                order_id: orderId,
                notified: false,
                processed: false
            };
            
            await saveDB();
            
            return {
                success: true,
                orderId: orderId,
                qrString: payment.payment_number,
                amount: amount,
                expiredAt: expiredAt.format('YYYY-MM-DD HH:mm:ss')
            };
        }
        return { success: false, error: 'Invalid response' };
    } catch (error) {
        console.log('Error createPakasirTopup:', error.message);
        return { success: false, error: error.message };
    }
}

async function sendRequestToRelay(chatId, userId, serverId, command, replyToMessageId = null) {
    try {
        if (!redisClient || !redisClient.isReady) {
            console.log('Redis not connected');
            return false;
        }
        
        const timestamp = Date.now();
        const randomStr = Math.random().toString(36).substring(2, 8);
        const requestId = `req:${chatId}:${timestamp}:${randomStr}`;
        
        const requestData = {
            chat_id: chatId,
            user_id: userId,
            command: command,
            args: [String(userId), String(serverId)],
            time: Date.now() / 1000
        };
        
        if (replyToMessageId) {
            requestData.reply_to_message_id = replyToMessageId;
        }
        
        console.log(`Menyimpan request ke Redis:`, JSON.stringify(requestData));
        
        await redisClient.setEx(requestId, 300, JSON.stringify(requestData));
        await redisClient.rPush('pending_requests', requestId);
        
        console.log(`Request sent to relay: ${requestId}`);
        return true;
    } catch (error) {
        console.log('Error sending to relay:', error.message);
        return false;
    }
}

async function telegramRequest(method, params) {
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
        const response = await axios.post(url, params, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 5000
        });
        return response.data;
    } catch (error) {
        console.log(`Telegram API error (${method}):`, error.message);
        if (error.response) {
            console.log('Response:', error.response.data);
        }
        return null;
    }
}

async function deleteMessage(chatId, messageId) {
    return telegramRequest('deleteMessage', {
        chat_id: chatId,
        message_id: messageId
    });
}

async function sendMessage(chatId, text, parseMode = 'HTML') {
    return telegramRequest('sendMessage', {
        chat_id: chatId,
        text: text,
        parse_mode: parseMode
    });
}

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Bot is running');
});

app.post('/webhook/pakasir', async (req, res) => {
    const startTime = Date.now();
    
    try {
        console.log('WEBHOOK PAKASIR:', JSON.stringify(req.body));
        
        const { order_id, status, amount, transaction_id } = req.body;
        
        if (!order_id) {
            return res.status(200).json({ status: 'ok', message: 'no order_id' });
        }
        
        console.log(`PROSES WEBHOOK: ${order_id} | STATUS: ${status}`);
        
        if (!db.pending_topups || !db.pending_topups[order_id]) {
            console.log(`ORDER TIDAK DITEMUKAN DI CACHE: ${order_id}`);
            
            await loadDB();
            
            if (!db.pending_topups || !db.pending_topups[order_id]) {
                console.log(`ORDER TIDAK DITEMUKAN SETELAH LOAD DB: ${order_id}`);
                return res.status(200).json({ status: 'ok', message: 'order not found' });
            }
        }
        
        const pendingData = db.pending_topups[order_id];
        
        if (pendingData.processed) {
            console.log(`ORDER SUDAH DIPROSES: ${order_id}`);
            return res.status(200).json({ status: 'ok', message: 'already processed' });
        }
        
        if (status === 'completed' || status === 'paid' || status === 'success' || status === 'settlement') {
            console.log(`PAYMENT SUCCESS: ${order_id} | USER: ${pendingData.userId} | AMOUNT: ${pendingData.amount}`);
            
            const userId = pendingData.userId;
            const amount = pendingData.amount;
            const chatId = pendingData.chatId;
            const messageId = pendingData.messageId;
            
            await addCredits(userId, amount, order_id);
            
            db.pending_topups[order_id].status = 'paid';
            db.pending_topups[order_id].processed = true;
            db.pending_topups[order_id].paid_at = Date.now();
            db.pending_topups[order_id].transaction_id = transaction_id || null;
            
            await saveDB();
            
            if (chatId && messageId) {
                try {
                    const result = await deleteMessage(chatId, messageId);
                    if (result && result.ok) {
                        console.log(`QR DELETED: ${order_id} di chat ${chatId}`);
                    } else {
                        console.log(`GAGAL HAPUS QR: ${result?.description || 'unknown error'}`);
                    }
                } catch (deleteError) {
                    console.log('GAGAL HAPUS QR:', deleteError.message);
                }
            }
            
            try {
                const newBalance = db.users[userId]?.credits || 0;
                await sendMessage(userId, 
                    `PEMBAYARAN BERHASIL\n\n` +
                    `Terima kasih! Pembayaran Anda telah kami terima.\n\n` +
                    `Detail Transaksi:\n` +
                    `Order ID: ${order_id}\n` +
                    `Jumlah: Rp ${amount.toLocaleString()}\n` +
                    `Status: BERHASIL\n\n` +
                    `Saldo Anda sekarang: Rp ${newBalance.toLocaleString()}\n\n` +
                    `Silakan gunakan bot untuk melakukan pengecekan.`,
                    'Markdown'
                );
            } catch (notifError) {
                console.log('GAGAL KIRIM NOTIFIKASI:', notifError.message);
            }
            
        } else if (status === 'failed' || status === 'expired' || status === 'cancel') {
            console.log(`PAYMENT FAILED: ${order_id}`);
            
            db.pending_topups[order_id].status = 'failed';
            db.pending_topups[order_id].processed = true;
            db.pending_topups[order_id].failed_at = Date.now();
            
            await saveDB();
            
            try {
                await sendMessage(pendingData.userId, 
                    `PEMBAYARAN GAGAL\n\n` +
                    `Maaf, pembayaran Anda gagal atau kadaluarsa.\n\n` +
                    `Detail Transaksi:\n` +
                    `Order ID: ${order_id}\n` +
                    `Jumlah: Rp ${amount.toLocaleString()}\n` +
                    `Status: GAGAL\n\n` +
                    `Silakan lakukan top up ulang jika masih membutuhkan.`,
                    'Markdown'
                );
            } catch (notifError) {
                console.log('GAGAL KIRIM NOTIFIKASI GAGAL:', notifError.message);
            }
        }
        
        res.status(200).json({ status: 'ok', message: 'processed' });
        
    } catch (error) {
        console.log('WEBHOOK ERROR:', error.message);
        console.log(error.stack);
        res.status(200).json({ status: 'ok', message: 'error but accepted' });
    }
});

if (IS_WORKER) {
    console.log('Bot worker started');
    
    try {
        if (!BOT_TOKEN) {
            throw new Error('BOT_TOKEN tidak ditemukan!');
        }

        const bot = new TelegramBot(BOT_TOKEN, { 
            polling: { 
                interval: 300, 
                autoStart: true,
                params: { timeout: 10 }
            } 
        });

        bot.on('polling_error', (error) => {
            console.log('Polling error:', error.message);
        });

        bot.on('message', async (msg) => {
            try {
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                const text = msg.text;
                const chatType = msg.chat.type;
                
                if (!text) return;
                if (chatType !== 'private') return;
                
                // Cek apakah admin sedang dalam state input
                const state = getAdminState(userId);
                if (state && isAdmin(userId)) {
                    // Handle cancel via /batal
                    if (text === '/batal') {
                        clearAdminState(userId);
                        await bot.sendMessage(chatId, 'Dibatalkan.', {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Kembali ke Admin Menu', callback_data: 'admin_menu' }]
                                ]
                            }
                        });
                        return;
                    }
                    
                    // Proses berdasarkan action
                    if (state.action === 'addtopup' && state.step === 'waiting_userid') {
                        const targetId = parseInt(text);
                        if (isNaN(targetId)) {
                            await bot.sendMessage(chatId, 'User ID harus angka. Coba lagi:', {
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: 'Batal', callback_data: 'admin_menu' }]
                                    ]
                                }
                            });
                            return;
                        }
                        
                        await setAdminState(userId, 'addtopup', 'waiting_amount', { targetId });
                        await bot.sendMessage(chatId, `User ID: ${targetId}\n\nMasukkan nominal topup (Rp):\n\nContoh: 50000`);
                        return;
                    }
                    
                    if (state.action === 'addtopup' && state.step === 'waiting_amount') {
                        const amount = parseInt(text);
                        const targetId = state.data.targetId;
                        
                        if (isNaN(amount) || amount < 1 || amount > 1000000) {
                            await bot.sendMessage(chatId, 'Nominal harus angka 1-1.000.000. Coba lagi:');
                            return;
                        }
                        
                        const newBalance = await addCredits(targetId, amount, null);
                        
                        await bot.sendMessage(chatId, 
                            `TOPUP MANUAL BERHASIL\n\n` +
                            `User: ${targetId}\n` +
                            `Jumlah: Rp ${amount.toLocaleString()}\n` +
                            `Saldo sekarang: Rp ${newBalance.toLocaleString()}`,
                            {
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: 'Kembali ke Admin Menu', callback_data: 'admin_menu' }]
                                    ]
                                }
                            }
                        );
                        
                        try {
                            await bot.sendMessage(targetId, 
                                `SALDO DITAMBAH ADMIN\n\n` +
                                `Saldo Anda bertambah Rp ${amount.toLocaleString()}.\n` +
                                `Saldo sekarang: Rp ${newBalance.toLocaleString()}`
                            );
                        } catch (e) {}
                        
                        clearAdminState(userId);
                        return;
                    }
                    
                    if (state.action === 'addgroup' && state.step === 'waiting_groupid') {
                        const groupId = parseInt(text);
                        if (isNaN(groupId)) {
                            await bot.sendMessage(chatId, 'Group ID harus angka. Coba lagi:', {
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: 'Batal', callback_data: 'admin_menu' }]
                                    ]
                                }
                            });
                            return;
                        }
                        
                        if (!db.allowed_groups) db.allowed_groups = [];
                        
                        if (db.allowed_groups.includes(groupId)) {
                            await bot.sendMessage(chatId, `Grup ${groupId} sudah terdaftar.`, {
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: 'Kembali ke Admin Menu', callback_data: 'admin_menu' }]
                                    ]
                                }
                            });
                            clearAdminState(userId);
                            return;
                        }
                        
                        db.allowed_groups.push(groupId);
                        await saveDB();
                        
                        await bot.sendMessage(chatId, `Grup ${groupId} berhasil ditambahkan.`, {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Kembali ke Admin Menu', callback_data: 'admin_menu' }]
                                ]
                            }
                        });
                        clearAdminState(userId);
                        return;
                    }
                    
                    if (state.action === 'removegroup' && state.step === 'waiting_groupid') {
                        const groupId = parseInt(text);
                        if (isNaN(groupId)) {
                            await bot.sendMessage(chatId, 'Group ID harus angka. Coba lagi:', {
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: 'Batal', callback_data: 'admin_menu' }]
                                    ]
                                }
                            });
                            return;
                        }
                        
                        if (!db.allowed_groups) db.allowed_groups = [];
                        
                        const index = db.allowed_groups.indexOf(groupId);
                        if (index === -1) {
                            await bot.sendMessage(chatId, `Grup ${groupId} tidak ditemukan.`, {
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: 'Kembali ke Admin Menu', callback_data: 'admin_menu' }]
                                    ]
                                }
                            });
                            clearAdminState(userId);
                            return;
                        }
                        
                        db.allowed_groups.splice(index, 1);
                        await saveDB();
                        
                        await bot.sendMessage(chatId, `Grup ${groupId} berhasil dihapus.`, {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Kembali ke Admin Menu', callback_data: 'admin_menu' }]
                                ]
                            }
                        });
                        clearAdminState(userId);
                        return;
                    }
                    
                    if (state.action === 'broadcast' && state.step === 'waiting_message') {
                        const hasPhoto = msg.photo && msg.photo.length > 0;
                        const photoFileId = hasPhoto ? msg.photo[msg.photo.length - 1].file_id : null;
                        const caption = hasPhoto ? (msg.caption || text) : text;
                        
                        if (!hasPhoto && !text) {
                            await bot.sendMessage(chatId, 'Kirim pesan atau foto yang ingin di-broadcast:');
                            return;
                        }
                        
                        const users = Object.keys(db.users || {}).map(id => parseInt(id));
                        if (users.length === 0) {
                            await bot.sendMessage(chatId, 'Tidak ada pengguna terdaftar.', {
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: 'Kembali ke Admin Menu', callback_data: 'admin_menu' }]
                                    ]
                                }
                            });
                            clearAdminState(userId);
                            return;
                        }
                        
                        const statusMsg = await bot.sendMessage(chatId, `Memulai broadcast ke ${users.length} pengguna...`);
                        
                        let success = 0, failed = 0;
                        const concurrency = 5;
                        
                        for (let i = 0; i < users.length; i += concurrency) {
                            const batch = users.slice(i, i + concurrency);
                            
                            await Promise.all(batch.map(async (userId) => {
                                try {
                                    if (hasPhoto) {
                                        await bot.sendPhoto(userId, photoFileId, { 
                                            caption: caption, 
                                            parse_mode: 'HTML' 
                                        });
                                    } else {
                                        await bot.sendMessage(userId, text, { 
                                            parse_mode: 'HTML' 
                                        });
                                    }
                                    success++;
                                } catch (error) {
                                    if (error.response && error.response.statusCode === 429) {
                                        const retryAfter = error.response.body.parameters?.retry_after || 1;
                                        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                                        try {
                                            if (hasPhoto) {
                                                await bot.sendPhoto(userId, photoFileId, { 
                                                    caption: caption, 
                                                    parse_mode: 'HTML' 
                                                });
                                            } else {
                                                await bot.sendMessage(userId, text, { 
                                                    parse_mode: 'HTML' 
                                                });
                                            }
                                            success++;
                                        } catch (retryError) {
                                            failed++;
                                        }
                                    } else {
                                        failed++;
                                    }
                                }
                            }));
                            
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                        
                        await bot.editMessageText(
                            `Broadcast selesai\n\n` +
                            `Berhasil: ${success}\n` +
                            `Gagal: ${failed}`,
                            {
                                chat_id: chatId,
                                message_id: statusMsg.message_id,
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: 'Kembali ke Admin Menu', callback_data: 'admin_menu' }]
                                    ]
                                }
                            }
                        );
                        
                        clearAdminState(userId);
                        return;
                    }
                }
                
                // Middleware untuk user biasa
                if (isAdmin(userId)) return;
                
                const command = text.split(' ')[0];
                const allowedCommands = ['/start', '/info', '/cek', '/cekinfo', '/find'];
                if (allowedCommands.includes(command)) return;
                
            } catch (error) {
                console.log('Middleware error:', error.message);
            }
        });

        bot.onText(/\/start/, async (msg) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                const username = msg.from.username;
                
                await loadDB();
                
                getUserCredits(userId, username || '');
                
                let message = `SELAMAT DATANG DI BOT NCUS\n\n`;
                message += `Daftar layanan dan harga:\n`;
                message += `• Info akun terhubung - GRATIS\n`;
                message += `• Detail lengkap akun - Rp 5.000\n`;
                message += `• Cari ID via nickname - Rp 5.000\n`;
                message += `• Langganan akses /find dan /cek unlimited\n`;
                
                const baseKeyboard = [
                    [
                        { text: 'FULL INFO', callback_data: 'full_info' },
                        { text: 'CHECK INFO', callback_data: 'check_info' }
                    ],
                    [{ text: 'CARI ID VIA NICKNAME', callback_data: 'find_id' }],
                    [{ text: 'PROFILE', callback_data: 'profile_menu' }],
                    [
                        { text: 'TOP UP', callback_data: 'topup_menu' },
                        { text: 'LANGGANAN', callback_data: 'langganan_menu' }
                    ]
                ];
                
                if (isAdmin(userId)) {
                    baseKeyboard.push([{ text: 'ADMIN MENU', callback_data: 'admin_menu' }]);
                }
                
                const replyMarkup = {
                    inline_keyboard: baseKeyboard
                };
                
                await bot.sendMessage(chatId, message, { reply_markup: replyMarkup });
            } catch (error) {
                console.log('Error /start:', error.message);
                try {
                    await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan. Silakan coba lagi.');
                } catch (e) {}
            }
        });

        bot.onText(/\/idgrup/, async (msg) => {
            try {
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                const chatType = msg.chat.type;

                if (chatType !== 'group' && chatType !== 'supergroup') {
                    await bot.sendMessage(chatId, 'Perintah ini hanya dapat digunakan di dalam grup.');
                    return;
                }

                if (!isAdmin(userId)) {
                    await bot.sendMessage(chatId, 'Hanya admin bot yang dapat menggunakan perintah ini.');
                    return;
                }

                await bot.sendMessage(chatId, `ID Grup ini adalah: ${chatId}`);
            } catch (error) {
                console.log('Error /idgrup:', error.message);
            }
        });

        bot.onText(/\/cekinfo(?:\s+(.+))?/i, async (msg, match) => {
            try {
                if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
                    return;
                }
                
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                const messageId = msg.message_id;

                if (!isGroupAllowed(chatId)) {
                    await bot.sendMessage(chatId, 
                        'Grup ini belum terdaftar. Silakan minta izin ke @ncus999 untuk mendaftarkan grup ini.',
                        { reply_to_message_id: messageId }
                    );
                    return;
                }
                
                if (!match || !match[1]) {
                    await bot.sendMessage(chatId,
                        `INFORMASI AKUN GRATIS\n\n` +
                        `Format: /cekinfo ID_USER ID_SERVER\n` +
                        `Contoh: /cekinfo 123456789 1234`,
                        { reply_to_message_id: messageId }
                    );
                    return;
                }
                
                if (!db.feature?.info && !isAdmin(userId)) {
                    await bot.sendMessage(chatId, 'Fitur info sedang dinonaktifkan oleh admin.', 
                        { reply_to_message_id: messageId }
                    );
                    return;
                }
                
                const args = match[1].trim().split(/\s+/);
                if (args.length < 2) {
                    await bot.sendMessage(chatId, `Format: /cekinfo ID_USER ID_SERVER`,
                        { reply_to_message_id: messageId }
                    );
                    return;
                }
                
                const targetId = args[0];
                const serverId = args[1];
                
                if (!/^\d+$/.test(targetId) || !/^\d+$/.test(serverId)) {
                    await bot.sendMessage(chatId, 'ID dan Server harus angka.',
                        { reply_to_message_id: messageId }
                    );
                    return;
                }
                
                const sent = await sendRequestToRelay(chatId, targetId, serverId, '/info', messageId);
                
                if (!sent) {
                    await bot.sendMessage(chatId, 'Terjadi kesalahan. Silakan coba lagi.',
                        { reply_to_message_id: messageId }
                    );
                    return;
                }
                
                getUserCredits(userId, msg.from.username || '');
                db.users[userId].success += 1;
                db.total_success += 1;
                await saveDB();
                
            } catch (error) {
                console.log('Error /cekinfo:', error.message);
                try {
                    await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan. Silakan coba lagi.',
                        { reply_to_message_id: msg.message_id }
                    );
                } catch (e) {}
            }
        });

        bot.onText(/\/info(?:\s+(.+))?/i, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                if (!match || !match[1]) {
                    await bot.sendMessage(msg.chat.id,
                        `INFORMASI AKUN GRATIS\n\n` +
                        `Format: /info ID_USER ID_SERVER\n` +
                        `Contoh: /info 123456789 1234`
                    );
                    return;
                }
                
                await loadDB();
                
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                
                const args = match[1].trim().split(/\s+/);
                if (args.length < 2) {
                    await bot.sendMessage(chatId, `Format: /info ID_USER ID_SERVER`);
                    return;
                }
                
                const targetId = args[0];
                const serverId = args[1];
                
                if (!/^\d+$/.test(targetId) || !/^\d+$/.test(serverId)) {
                    await bot.sendMessage(chatId, 'ID dan Server harus angka.');
                    return;
                }
                
                if (!db.feature?.info && !isAdmin(userId)) {
                    await bot.sendMessage(chatId, 'Fitur info sedang dinonaktifkan oleh admin.');
                    return;
                }
                
                const joined = await checkJoin(bot, userId);
                
                if ((!joined.channel || !joined.group) && !isAdmin(userId)) {
                    let message = `AKSES DITOLAK\n\nAnda WAJIB bergabung jika menggunakan bot ini:\n\n`;
                    
                    const buttons = [];
                    if (!joined.channel) {
                        buttons.push([{ text: `Bergabung ke Channel`, url: `https://t.me/${CHANNEL.replace('@', '')}` }]);
                    }
                    if (!joined.group) {
                        buttons.push([{ text: `Bergabung ke Group`, url: `https://t.me/${GROUP.replace('@', '')}` }]);
                    }
                    
                    await bot.sendMessage(chatId, message, { 
                        reply_markup: { inline_keyboard: buttons }
                    });
                    return;
                }
                
                const sent = await sendRequestToRelay(chatId, targetId, serverId, '/info', null);
                
                if (!sent) {
                    await bot.sendMessage(chatId, 'Terjadi kesalahan. Silakan coba lagi.');
                    return;
                }
                
                getUserCredits(userId, msg.from.username || '');
                db.users[userId].success += 1;
                db.total_success += 1;
                await saveDB();
                
            } catch (error) {
                console.log('Error /info:', error.message);
                try {
                    await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan. Silakan coba lagi.');
                } catch (e) {}
            }
        });

        bot.onText(/\/cek(?:\s+(.+))?/i, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                if (!match || !match[1]) {
                    await bot.sendMessage(msg.chat.id,
                        `DETAIL ACCOUNT\n\n` +
                        `Format: /cek ID_USER ID_SERVER\n` +
                        `Contoh: /cek 123456789 1234`
                    );
                    return;
                }
                
                await loadDB();
                
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                
                await checkAndUpdateExpiredSubscription(userId);
                
                const input = match[1].trim();
                const parts = input.split(/\s+/).filter(p => p.length > 0);
                
                if (parts.length < 2) {
                    await bot.sendMessage(chatId,
                        `FORMAT SALAH\n\n` +
                        `Format yang benar:\n` +
                        `/cek ID_USER ID_SERVER\n\n` +
                        `Contoh: /cek 123456789 1234\n\n` +
                        `ID dan Server harus berupa angka.`
                    );
                    return;
                }
                
                const targetId = parts[0];
                const serverId = parts[1];
                
                if (!/^\d+$/.test(targetId) || !/^\d+$/.test(serverId)) {
                    await bot.sendMessage(chatId,
                        `FORMAT SALAH\n\n` +
                        `ID dan Server harus berupa angka.\n\n` +
                        `Contoh: /cek 123456789 1234`
                    );
                    return;
                }
                
                const joined = await checkJoin(bot, userId);
                if ((!joined.channel || !joined.group) && !isAdmin(userId)) {
                    let message = `AKSES DITOLAK\n\nAnda WAJIB bergabung jika menggunakan bot ini:\n\n`;
                    const buttons = [];
                    if (!joined.channel && CHANNEL) {
                        buttons.push([{ text: `Bergabung ke Channel`, url: `https://t.me/${CHANNEL.replace('@', '')}` }]);
                    }
                    if (!joined.group && GROUP) {
                        buttons.push([{ text: `Bergabung ke Group`, url: `https://t.me/${GROUP.replace('@', '')}` }]);
                    }
                    await bot.sendMessage(chatId, message, { reply_markup: { inline_keyboard: buttons } });
                    return;
                }
                
                const credits = getUserCredits(userId, msg.from.username || '');
                if (credits < 5000 && !isAdmin(userId) && !hasActiveSubscription(userId)) {
                    await bot.sendMessage(chatId,
                        `SALDO TIDAK CUKUP\n\n` +
                        `Saldo Anda: Rp ${credits.toLocaleString()}\n` +
                        `Biaya: Rp 5.000\n` +
                        `Kekurangan: Rp ${(5000 - credits).toLocaleString()}\n\n` +
                        `Silakan isi saldo atau berlangganan:`,
                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'TOP UP', callback_data: 'topup_menu' }],
                                    [{ text: 'LANGGANAN', callback_data: 'langganan_menu' }]
                                ]
                            }
                        }
                    );
                    return;
                }
                
                const loadingMsg = await bot.sendMessage(chatId, 'Mengambil data akun...');
                
                try {
                    let detailData = null;
                    let lookupSuccess = false;
                    let retryCount = 0;
                    const maxRetries = 5;
                    
                    while (!lookupSuccess && retryCount < maxRetries) {
                        retryCount++;
                        
                        if (retryCount > 1) {
                            await bot.editMessageText(`Mengambil data detail... (Percobaan ${retryCount}/${maxRetries})`, {
                                chat_id: chatId,
                                message_id: loadingMsg.message_id
                            });
                        }
                        
                        detailData = await getMLBBData(targetId, serverId, 'lookup');
                        
                        if (detailData && !detailData.error) {
                            lookupSuccess = true;
                            break;
                        }
                        
                        if (retryCount < maxRetries) {
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                    }
                    
                    if (!lookupSuccess) {
                        let errorMessage = 'REQUEST SEDANG ERROR\n\nSILAHKAN COBA LAGI NANTI';
                        
                        if (detailData && detailData.message === 'not_found') {
                            errorMessage = `AKUN TIDAK DITEMUKAN\n\nID: ${targetId}\nServer: ${serverId}\n\nPastikan ID dan Server yang dimasukkan benar.`;
                        }
                        
                        await bot.editMessageText(errorMessage, {
                            chat_id: chatId,
                            message_id: loadingMsg.message_id
                        });
                        return;
                    }
                    
                    if (!isAdmin(userId) && !hasActiveSubscription(userId)) {
                        db.users[userId].credits -= 5000;
                        await saveDB();
                        console.log(`SALDO DIPOTONG: User ${userId} | Command: cek`);
                    }
                    
                    await bot.deleteMessage(chatId, loadingMsg.message_id);
                    
                    await sendDetailAccountInfo(bot, chatId, userId, detailData, targetId, serverId);
                    
                    db.users[userId].success += 1;
                    db.total_success += 1;
                    await saveDB();
                    
                } catch (error) {
                    console.log('Error saat memproses:', error.message);
                    await bot.editMessageText(
                        'REQUEST SEDANG ERROR\n\nSILAHKAN COBA LAGI NANTI',
                        {
                            chat_id: chatId,
                            message_id: loadingMsg.message_id
                        }
                    );
                }
                
            } catch (error) {
                console.log('Error /cek:', error.message);
                try {
                    await bot.sendMessage(msg.chat.id, 'REQUEST SEDANG ERROR\n\nSILAHKAN COBA LAGI NANTI');
                } catch (e) {}
            }
        });

        bot.onText(/\/find(?:\s+(.+))?/i, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                if (!match || !match[1]) {
                    await bot.sendMessage(msg.chat.id,
                        `CARI ID VIA NICKNAME\n\n` +
                        `Gunakan format:\n` +
                        `/find NICKNAME SERVER\n\n` +
                        `Contoh:\n` +
                        `/find RRQ Jule 15707`
                    );
                    return;
                }
                
                await loadDB();
                
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                
                await checkAndUpdateExpiredSubscription(userId);
                
                const input = match[1].trim();
                const parts = input.split(/\s+/).filter(p => p.length > 0);
                
                if (parts.length < 2) {
                    await bot.sendMessage(chatId,
                        `FORMAT SALAH\n\n` +
                        `Format yang benar:\n` +
                        `/find NICKNAME SERVER\n\n` +
                        `Contoh: /find RRQ Jule 15707`
                    );
                    return;
                }
                
                const serverFilter = parts[parts.length - 1];
                if (!/^\d+$/.test(serverFilter)) {
                    await bot.sendMessage(chatId,
                        `FORMAT SALAH\n\n` +
                        `Server harus berupa angka.\n\n` +
                        `Contoh: /find RRQ Jule 15707`
                    );
                    return;
                }
                
                const searchQuery = parts.slice(0, -1).join(' ');
                
                const joined = await checkJoin(bot, userId);
                if ((!joined.channel || !joined.group) && !isAdmin(userId)) {
                    let message = `AKSES DITOLAK\n\nAnda WAJIB bergabung jika menggunakan bot ini:\n\n`;
                    const buttons = [];
                    if (!joined.channel && CHANNEL) {
                        buttons.push([{ text: `Bergabung ke Channel`, url: `https://t.me/${CHANNEL.replace('@', '')}` }]);
                    }
                    if (!joined.group && GROUP) {
                        buttons.push([{ text: `Bergabung ke Group`, url: `https://t.me/${GROUP.replace('@', '')}` }]);
                    }
                    await bot.sendMessage(chatId, message, { reply_markup: { inline_keyboard: buttons } });
                    return;
                }
                
                const credits = getUserCredits(userId, msg.from.username || '');
                if (credits < 5000 && !isAdmin(userId) && !hasActiveSubscription(userId)) {
                    await bot.sendMessage(chatId,
                        `SALDO TIDAK CUKUP\n\n` +
                        `Saldo Anda: Rp ${credits.toLocaleString()}\n` +
                        `Biaya: Rp 5.000\n` +
                        `Kekurangan: Rp ${(5000 - credits).toLocaleString()}\n\n` +
                        `Silakan isi saldo atau berlangganan:`,
                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'TOP UP', callback_data: 'topup_menu' }],
                                    [{ text: 'LANGGANAN', callback_data: 'langganan_menu' }]
                                ]
                            }
                        }
                    );
                    return;
                }
                
                const loadingMsg = await bot.sendMessage(chatId, 'Mencari akun...');
                
                try {
                    let foundAccounts = await findPlayerByName(searchQuery);
                    
                    if (!foundAccounts || foundAccounts.length === 0) {
                        await bot.editMessageText(
                            `AKUN TIDAK DITEMUKAN\n\n` +
                            `Tidak ada akun dengan nickname "${searchQuery}" ditemukan.`,
                            {
                                chat_id: chatId,
                                message_id: loadingMsg.message_id
                            }
                        );
                        return;
                    }
                    
                    foundAccounts = foundAccounts.filter(a => String(a.zone_id) === serverFilter);
                    
                    if (foundAccounts.length === 0) {
                        await bot.editMessageText(
                            `AKUN TIDAK DITEMUKAN\n\n` +
                            `Tidak ada akun dengan nickname "${searchQuery}" di server ${serverFilter}.`,
                            {
                                chat_id: chatId,
                                message_id: loadingMsg.message_id
                            }
                        );
                        return;
                    }
                    
                    if (!isAdmin(userId) && !hasActiveSubscription(userId)) {
                        db.users[userId].credits -= 5000;
                        await saveDB();
                    }
                    
                    await bot.deleteMessage(chatId, loadingMsg.message_id);
                    
                    for (let i = 0; i < foundAccounts.length; i++) {
                        const acc = foundAccounts[i];
                        
                        let output = `HASIL PENCARIAN\n\n`;
                        output += `ID: ${acc.role_id}\n`;
                        output += `Server: ${acc.zone_id}\n`;
                        output += `Name: ${acc.name || acc.nickname || '-'}\n`;
                        output += `Level: ${acc.level || 0}\n`;
                        output += `Last Login: ${acc.last_login || '-'}\n`;
                        output += `Country: ${acc.country || acc.created_country || '-'}\n`;
                        output += `Last Country: ${acc.last_country || '-'}\n`;
                        
                        if (acc.locations_logged && Array.isArray(acc.locations_logged) && acc.locations_logged.length > 0) {
                            output += `Locations: ${acc.locations_logged.join(' > ')}\n`;
                        } else {
                            output += `Locations: -\n`;
                        }
                        
                        if (foundAccounts.length > 1) {
                            output += `\n[${i+1}/${foundAccounts.length}]`;
                        }
                        
                        await bot.sendMessage(chatId, output, {
                            reply_markup: { 
                                inline_keyboard: [[{ text: 'Stok Admin', url: STOK_ADMIN }]] 
                            }
                        });
                    }
                    
                    getUserCredits(userId, msg.from.username || '');
                    db.users[userId].success += 1;
                    db.total_success += 1;
                    await saveDB();
                    
                } catch (error) {
                    console.log('Error /find:', error.message);
                    await bot.editMessageText(
                        `ERROR\n\n` +
                        `Terjadi kesalahan saat mencari data. Silakan coba lagi nanti.`,
                        {
                            chat_id: chatId,
                            message_id: loadingMsg.message_id
                        }
                    );
                }
                
            } catch (error) {
                console.log('Error /find:', error.message);
            }
        });

        async function editToMainMenu(bot, chatId, messageId, userId) {
            try {
                await loadDB();
                
                let message = `SELAMAT DATANG DI BOT NCUS\n\n`;
                message += `Daftar layanan dan harga:\n`;
                message += `• Info akun terhubung - GRATIS\n`;
                message += `• Detail lengkap akun - Rp 5.000\n`;
                message += `• Cari ID via nickname - Rp 5.000\n`;
                message += `• Langganan akses /find dan /cek unlimited\n`;
                
                const baseKeyboard = [
                    [
                        { text: 'FULL INFO', callback_data: 'full_info' },
                        { text: 'CHECK INFO', callback_data: 'check_info' }
                    ],
                    [{ text: 'CARI ID VIA NICKNAME', callback_data: 'find_id' }],
                    [{ text: 'PROFILE', callback_data: 'profile_menu' }],
                    [
                        { text: 'TOP UP', callback_data: 'topup_menu' },
                        { text: 'LANGGANAN', callback_data: 'langganan_menu' }
                    ]
                ];
                
                if (isAdmin(userId)) {
                    baseKeyboard.push([{ text: 'ADMIN MENU', callback_data: 'admin_menu' }]);
                }
                
                const replyMarkup = {
                    inline_keyboard: baseKeyboard
                };
                
                await bot.editMessageText(message, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: replyMarkup
                });
            } catch (error) {
                console.log('Error editToMainMenu:', error.message);
            }
        }

        async function editToTopupMenu(bot, chatId, messageId, userId) {
            await loadDB();
            
            const credits = getUserCredits(userId);
            
            const message = 
                `TOP UP SALDO\n\n` +
                `Saldo Anda: Rp ${credits.toLocaleString()}\n\n` +
                `Pilih nominal top up:`;
            
            const replyMarkup = {
                inline_keyboard: [
                    [
                        { text: 'Rp 5.000', callback_data: 'topup_5000' },
                        { text: 'Rp 10.000', callback_data: 'topup_10000' }
                    ],
                    [
                        { text: 'Rp 25.000', callback_data: 'topup_25000' },
                        { text: 'Rp 50.000', callback_data: 'topup_50000' }
                    ],
                    [
                        { text: 'Rp 100.000', callback_data: 'topup_100000' },
                        { text: 'Rp 200.000', callback_data: 'topup_200000' }
                    ],
                    [
                        { text: 'Rp 500.000', callback_data: 'topup_500000' },
                        { text: 'Rp 1.000.000', callback_data: 'topup_1000000' }
                    ],
                    [{ text: 'Kembali ke Menu', callback_data: 'kembali_ke_menu' }]
                ]
            };
            
            await bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: replyMarkup
            });
        }

        async function showSubscriptionMenu(bot, chatId, messageId, userId) {
            await loadDB();
            
            const message = `Akses unlimited untuk fitur /cek dan /find tanpa limit\nsilahkan pilih paket:`;
            
            const replyMarkup = {
                inline_keyboard: [
                    [
                        { text: '7 Hari (Rp 50.000)', callback_data: 'langganan_7days' },
                        { text: '30 Hari (Rp 100.000)', callback_data: 'langganan_30days' }
                    ],
                    [{ text: 'Kembali ke Menu', callback_data: 'kembali_ke_menu' }]
                ]
            };
            
            await bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: replyMarkup
            });
        }

        async function showProfileMenu(bot, chatId, messageId, userId) {
            await loadDB();
            
            await checkAndUpdateExpiredSubscription(userId);
            
            const credits = getUserCredits(userId);
            const hasSub = hasActiveSubscription(userId);
            const user = db.users[userId] || { username: '', success: 0 };
            const username = user.username || '-';
            const totalCheck = user.success || 0;
            
            let subscriptionText = 'Tidak aktif';
            let expiryText = '';
            
            if (hasSub) {
                const sub = db.users[userId].subscription;
                const endDate = moment(sub.end_date).tz('Asia/Jakarta');
                subscriptionText = `Aktif`;
                expiryText = `\nBerlaku sampai: ${endDate.format('DD/MM/YYYY HH:mm')} WIB`;
            }
            
            const message = `PROFILE USER\n\n` +
                `User ID: ${userId}\n` +
                `Username: @${username}\n` +
                `Saldo: Rp ${credits.toLocaleString()}\n` +
                `Status Langganan: ${subscriptionText}${expiryText}\n` +
                `Total Pengecekan: ${totalCheck} kali`;
            
            const replyMarkup = {
                inline_keyboard: [
                    [{ text: 'Kembali ke Menu', callback_data: 'kembali_ke_menu' }]
                ]
            };
            
            await bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: replyMarkup
            });
        }

        async function showAdminMenu(bot, chatId, messageId, userId) {
            try {
                await loadDB();
                
                if (!isAdmin(userId)) {
                    await bot.editMessageText(
                        `Akses ditolak. Anda bukan admin.`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Kembali ke Menu', callback_data: 'kembali_ke_menu' }]
                                ]
                            }
                        }
                    );
                    return;
                }
                
                const totalUsers = Object.keys(db.users || {}).length;
                const totalSuccess = db.total_success || 0;
                const totalSaldo = Object.values(db.users || {}).reduce((sum, u) => sum + (u.credits || 0), 0);
                
                const usersWithSubscription = Object.entries(db.users || {})
                    .filter(([_, u]) => u.subscription && u.subscription.active && new Date(u.subscription.end_date) > new Date())
                    .length;
                
                let message = `ADMIN MENU\n\n`;
                message += `STATISTIK\n`;
                message += `Total User: ${totalUsers}\n`;
                message += `Total Pengecekan: ${totalSuccess}\n`;
                message += `Total Saldo: Rp ${totalSaldo.toLocaleString()}\n`;
                message += `Total Langganan Aktif: ${usersWithSubscription}\n\n`;
                message += `Pilih menu di bawah:`;
                
                const replyMarkup = {
                    inline_keyboard: [
                        [{ text: 'List Topup', callback_data: 'admin_listtopup' }],
                        [{ text: 'List Langganan', callback_data: 'admin_listlangganan' }],
                        [{ text: 'List Group', callback_data: 'admin_listgroup' }],
                        [{ text: 'Tambah Saldo User', callback_data: 'admin_addtopup_start' }],
                        [{ text: 'Tambah Group', callback_data: 'admin_addgroup_start' }],
                        [{ text: 'Hapus Group', callback_data: 'admin_removegroup_start' }],
                        [{ text: 'Broadcast Pesan', callback_data: 'admin_broadcast_start' }],
                        [{ text: 'Nonaktifkan Info', callback_data: 'admin_offinfo' }],
                        [{ text: 'Aktifkan Info', callback_data: 'admin_oninfo' }],
                        [{ text: 'Kembali ke Menu', callback_data: 'kembali_ke_menu' }]
                    ]
                };
                
                await bot.editMessageText(message, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: replyMarkup
                });
            } catch (error) {
                console.log('Error showAdminMenu:', error.message);
            }
        }

        async function showAdminListTopup(bot, chatId, messageId, userId) {
            try {
                if (!isAdmin(userId)) {
                    await bot.editMessageText(
                        `Akses ditolak. Anda bukan admin.`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Kembali ke Admin Menu', callback_data: 'admin_menu' }]
                                ]
                            }
                        }
                    );
                    return;
                }
                
                const usersWithBalance = Object.entries(db.users || {})
                    .filter(([_, u]) => (u.credits || 0) > 0)
                    .sort((a, b) => (b[1].credits || 0) - (a[1].credits || 0));
                
                let message = `DAFTAR USER DENGAN SALDO > 0\n\n`;
                
                if (usersWithBalance.length === 0) {
                    message += 'Tidak ada user dengan saldo.';
                } else {
                    const totalSaldo = usersWithBalance.reduce((sum, [_, u]) => sum + (u.credits || 0), 0);
                    message += `Total ${usersWithBalance.length} user | Total Saldo: Rp ${totalSaldo.toLocaleString()}\n\n`;
                    
                    const displayCount = Math.min(usersWithBalance.length, 20);
                    for (let i = 0; i < displayCount; i++) {
                        const [id, u] = usersWithBalance[i];
                        message += `${i+1}. ${u.username || id}\n`;
                        message += `   Saldo: Rp ${(u.credits || 0).toLocaleString()}\n\n`;
                    }
                    
                    if (usersWithBalance.length > 20) {
                        message += `... dan ${usersWithBalance.length - 20} user lainnya.`;
                    }
                }
                
                const replyMarkup = {
                    inline_keyboard: [
                        [{ text: 'Kembali ke Admin Menu', callback_data: 'admin_menu' }]
                    ]
                };
                
                await bot.editMessageText(message, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: replyMarkup
                });
            } catch (error) {
                console.log('Error showAdminListTopup:', error.message);
            }
        }

        async function showAdminListLangganan(bot, chatId, messageId, userId) {
            try {
                if (!isAdmin(userId)) {
                    await bot.editMessageText(
                        `Akses ditolak. Anda bukan admin.`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Kembali ke Admin Menu', callback_data: 'admin_menu' }]
                                ]
                            }
                        }
                    );
                    return;
                }
                
                const usersWithSubscription = Object.entries(db.users || {})
                    .filter(([_, u]) => u.subscription && u.subscription.active && new Date(u.subscription.end_date) > new Date())
                    .map(([id, u]) => ({
                        id: id,
                        end_date: new Date(u.subscription.end_date)
                    }))
                    .sort((a, b) => a.end_date - b.end_date);
                
                let message = `LIST LANGGANAN\n\n`;
                
                if (usersWithSubscription.length === 0) {
                    message += 'Tidak ada user dengan langganan aktif.';
                } else {
                    for (let i = 0; i < usersWithSubscription.length; i++) {
                        const user = usersWithSubscription[i];
                        const endDate = moment(user.end_date).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm');
                        message += `${user.id} > Exp: ${endDate} WIB\n`;
                        
                        if (message.length > 3500 && i < usersWithSubscription.length - 1) {
                            message += `... dan ${usersWithSubscription.length - i - 1} user lainnya.`;
                            break;
                        }
                    }
                }
                
                const replyMarkup = {
                    inline_keyboard: [
                        [{ text: 'Kembali ke Admin Menu', callback_data: 'admin_menu' }]
                    ]
                };
                
                await bot.editMessageText(message, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: replyMarkup
                });
            } catch (error) {
                console.log('Error showAdminListLangganan:', error.message);
            }
        }

        async function showAdminListGroup(bot, chatId, messageId, userId) {
            try {
                if (!isAdmin(userId)) {
                    await bot.editMessageText(
                        `Akses ditolak. Anda bukan admin.`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Kembali ke Admin Menu', callback_data: 'admin_menu' }]
                                ]
                            }
                        }
                    );
                    return;
                }
                
                if (!db.allowed_groups || db.allowed_groups.length === 0) {
                    await bot.editMessageText(
                        `Belum ada grup terdaftar.`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Kembali ke Admin Menu', callback_data: 'admin_menu' }]
                                ]
                            }
                        }
                    );
                    return;
                }
                
                let message = `DAFTAR GRUP TERDAFTAR:\n\n`;
                db.allowed_groups.forEach((id, i) => {
                    message += `${i + 1}. ${id}\n`;
                });
                
                const replyMarkup = {
                    inline_keyboard: [
                        [{ text: 'Kembali ke Admin Menu', callback_data: 'admin_menu' }]
                    ]
                };
                
                await bot.editMessageText(message, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: replyMarkup
                });
            } catch (error) {
                console.log('Error showAdminListGroup:', error.message);
            }
        }

        async function sendDetailAccountInfo(bot, chatId, userId, detailData, targetId, serverId) {
            try {
                let output = '';
                
                const d = detailData;
                
                let createdDate = '-';
                if (d.ttl) {
                    const parts = d.ttl.split('-');
                    if (parts.length === 3) {
                        createdDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
                    }
                }
                
                output += `ID Server: ${d.role_id || targetId} (${d.zone_id || serverId})\n`;
                output += `Name: ${d.name || '-'}\n`;
                output += `Level: ${d.level || '-'}\n`;
                output += `Created: ${createdDate}\n`;
                output += `Last Login: ${d.last_login || '-'}\n`;
                output += `Achievement Points: ${(d.achievement_points || 0).toLocaleString()}\n`;
                
                if (d.last_country_logged) {
                    output += `Last Country: ${d.last_country_logged}\n`;
                }
                if (d.created_country) {
                    output += `Created Country: ${d.created_country}\n`;
                }
                
                output += `\nRANK INFO\n`;
                output += `Current Tier: ${d.current_tier || '-'}\n`;
                output += `Highest Tier: ${d.max_tier || '-'}\n`;
                output += `Overall WR: ${d.overall_win_rate || '0%'}\n`;
                output += `KDA: ${d.kda || '-'}\n`;
                output += `Team Participation: ${d.team_participation || '-'}\n`;
                output += `Flags Percentage: ${d.flags_percentage || '-'}\n\n`;
                
                if (d.collector_level || d.collector_title) {
                    output += `COLLECTOR\n`;
                    output += `Level: ${d.collector_level || 0}\n`;
                    output += `Title: ${d.collector_title || '-'}\n\n`;
                }
                
                output += `HERO & SKIN\n`;
                output += `Heroes: ${d.hero_count || 0}\n`;
                output += `Skins: ${d.skin_count || 0}\n`;
                output += `Supreme: ${d.supreme_skins || 0}\n`;
                output += `Grand: ${d.grand_skins || 0}\n`;
                output += `Exquisite: ${d.exquisite_skins || 0}\n`;
                output += `Deluxe: ${d.deluxe_skins || 0}\n`;
                output += `Exceptional: ${d.exceptional_skins || 0}\n`;
                output += `Common: ${d.common_skins || 0}\n`;
                if (d.latest_skin_purchase_date) {
                    output += `Latest Skin Purchase: ${d.latest_skin_purchase_date}\n`;
                }
                output += `Last Hero Purchase: ${d.last_hero_purchase || '-'}\n`;
                output += `Top 3 Most Used: ${d.top3_most_used_heroes || '-'}\n\n`;
                
                if (d.affinity_list && d.affinity_list.length > 0) {
                    output += `AFFINITY\n`;
                    output += `${d.affinity_list.join('\n')}\n\n`;
                }
                
                if (d.locations_logged && Array.isArray(d.locations_logged) && d.locations_logged.length > 0) {
                    output += `LOCATIONS\n`;
                    const locations = formatLocations(d.locations_logged, 15);
                    if (locations) {
                        output += `${locations}\n\n`;
                    }
                }
                
                if (d.top_3_hero_details && d.top_3_hero_details.length > 0) {
                    output += `TOP 3 HERO\n`;
                    d.top_3_hero_details.forEach((h) => {
                        output += `${h.hero || '-'}\n`;
                        output += `  Matches: ${h.matches || 0} | WR: ${h.win_rate || '0%'}\n`;
                        output += `  Power: ${h.power || 0}\n`;
                    });
                    output += `\n`;
                }
                
                output += `MATCH STATS\n`;
                output += `Total Match: ${(d.total_match_played || 0).toLocaleString()}\n`;
                output += `Total Win: ${d.total_wins || 0}\n`;
                output += `MVP: ${d.total_mvp || 0} (Lose ${d.mvp_loss || 0})\n`;
                output += `Savage: ${d.savage_kill || 0}\n`;
                output += `Maniac: ${d.maniac_kill || 0}\n`;
                output += `Legendary: ${d.legendary_kill || 0}\n`;
                output += `Double Kill: ${d.double_kill || 0}\n`;
                output += `Triple Kill: ${d.triple_kill || 0}\n`;
                output += `Longest Win Streak: ${d.longest_win_streak || 0}\n`;
                output += `Most Kills: ${d.most_kills || 0}\n`;
                output += `Most Assists: ${d.most_assists || 0}\n`;
                output += `Highest Damage: ${(d.highest_dmg || 0).toLocaleString()}\n`;
                output += `Highest Damage Taken: ${(d.highest_dmg_taken || 0).toLocaleString()}\n`;
                output += `Highest Gold: ${(d.highest_gold || 0).toLocaleString()}\n`;
                output += `Min Gold: ${d.min_gold || 0}\n`;
                output += `Min Hero Damage: ${d.min_hero_damage || 0}\n`;
                output += `Turret Damage/Match: ${d.turret_dmg_match || 0}\n\n`;
                
                if (d.last_match_data) {
                    output += `LAST MATCH\n`;
                    output += `Hero: ${d.last_match_data.hero_name || '-'}\n`;
                    output += `KDA: ${d.last_match_data.kills || 0}/${d.last_match_data.deaths || 0}/${d.last_match_data.assists || 0}\n`;
                    output += `Gold: ${(d.last_match_data.gold || 0).toLocaleString()}\n`;
                    output += `Hero Damage: ${(d.last_match_data.hero_damage || 0).toLocaleString()}\n`;
                    output += `Damage Taken: ${(d.last_match_data.damage_taken || 0).toLocaleString()}\n`;
                    output += `Turret Damage: ${(d.last_match_data.turret_damage || 0).toLocaleString()}\n`;
                    output += `Duration: ${d.last_match_duration || '-'}\n`;
                    output += `Date: ${d.last_match_date || '-'}\n`;
                    if (d.last_match_heroes) {
                        output += `All Heroes: ${d.last_match_heroes}\n`;
                    }
                    output += `\n`;
                }
                
                if (d.squad_name || d.squad_id) {
                    output += `SQUAD\n`;
                    if (d.squad_name) {
                        output += `Name: ${d.squad_name}\n`;
                    }
                    if (d.squad_prefix) {
                        output += `Prefix: ${d.squad_prefix}\n`;
                    }
                    if (d.squad_id) {
                        output += `Squad ID: ${d.squad_id}\n`;
                    }
                    output += `\n`;
                }
                
                output += `SOCIAL\n`;
                output += `Followers: ${d.followers || 0}\n`;
                output += `Likes: ${d.total_likes || 0}\n`;
                output += `Popularity: ${d.popularity || 0}\n`;
                output += `Credit Score: ${d.credits_score || 0}\n\n`;
                
                output += `Sisa saldo: Rp ${getUserCredits(userId).toLocaleString()}`;
                
                if (output.length > 4000) {
                    let splitPoint = output.indexOf('MATCH STATS');
                    if (splitPoint === -1) splitPoint = 3000;
                    
                    let part1 = output.substring(0, splitPoint);
                    part1 += `\n\n[Lanjutan di pesan berikutnya...]`;
                    
                    await bot.sendMessage(chatId, part1, {
                        reply_markup: { 
                            inline_keyboard: [[{ text: 'Stok Admin', url: STOK_ADMIN }]] 
                        }
                    });
                    
                    let part2 = output.substring(splitPoint);
                    await bot.sendMessage(chatId, part2);
                    
                } else {
                    await bot.sendMessage(chatId, output, {
                        reply_markup: { 
                            inline_keyboard: [[{ text: 'Stok Admin', url: STOK_ADMIN }]] 
                        }
                    });
                }
            } catch (error) {
                console.log('Error sendDetailAccountInfo:', error.message);
                await bot.sendMessage(chatId, 'Terjadi kesalahan saat menampilkan data.');
            }
        }

        bot.on('callback_query', async (cb) => {
            try {
                console.log('Callback diterima:', cb.data);
                
                const msg = cb.message;
                if (!msg || msg.chat.type !== 'private') {
                    await bot.answerCallbackQuery(cb.id, { text: 'Bot hanya di private chat' });
                    return;
                }
                
                const chatId = msg.chat.id;
                const userId = cb.from.id;
                const data = cb.data;
                const messageId = msg.message_id;

                if (data === 'kembali_ke_menu') {
                    await editToMainMenu(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'full_info') {
                    await bot.answerCallbackQuery(cb.id);
                    await bot.editMessageText(
                        `FULL INFO\n\n` +
                        `Perintah ini digunakan untuk melihat detail lengkap akun MLBB.\n\n` +
                        `Cara Penggunaan:\n` +
                        `Kirim perintah:\n` +
                        `/cek ID SERVER\n\n` +
                        `Contoh:\n` +
                        `/cek 123456789 1234\n\n` +
                        `Anda dapat menemukan Game ID dan Server ID di aplikasi MLBB pada bagian Profil.`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Kembali ke Menu', callback_data: 'kembali_ke_menu' }]
                                ]
                            }
                        }
                    );
                    return;
                }

                if (data === 'check_info') {
                    await bot.answerCallbackQuery(cb.id);
                    await bot.editMessageText(
                        `CHECK INFO\n\n` +
                        `Perintah ini digunakan untuk melihat informasi akun terhubung pada MLBB.\n\n` +
                        `Cara Penggunaan:\n` +
                        `Kirim perintah:\n` +
                        `/info ID SERVER\n\n` +
                        `Contoh:\n` +
                        `/info 123456789 1234`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Kembali ke Menu', callback_data: 'kembali_ke_menu' }]
                                ]
                            }
                        }
                    );
                    return;
                }

                if (data === 'find_id') {
                    await bot.answerCallbackQuery(cb.id);
                    await bot.editMessageText(
                        `CARI ID VIA NICKNAME\n\n` +
                        `Perintah ini digunakan untuk mencari ID akun MLBB berdasarkan nickname.\n\n` +
                        `Cara Penggunaan:\n` +
                        `Kirim perintah:\n` +
                        `/find NICKNAME SERVER\n\n` +
                        `Contoh:\n` +
                        `/find RRQ Jule 15707\n\n` +
                        `Bot akan menampilkan pemain yang cocok dengan Game ID dan Server ID mereka.`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Kembali ke Menu', callback_data: 'kembali_ke_menu' }]
                                ]
                            }
                        }
                    );
                    return;
                }

                if (data === 'profile_menu') {
                    await showProfileMenu(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'topup_menu') {
                    await editToTopupMenu(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'langganan_menu') {
                    await showSubscriptionMenu(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_menu') {
                    await showAdminMenu(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_listtopup') {
                    await showAdminListTopup(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_listlangganan') {
                    await showAdminListLangganan(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_listgroup') {
                    await showAdminListGroup(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_addtopup_start') {
                    await bot.editMessageText(
                        `TAMBAH SALDO USER\n\n` +
                        `Masukkan User ID:\n\n` +
                        `Contoh: 123456789`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Batal', callback_data: 'admin_menu' }]
                                ]
                            }
                        }
                    );
                    await setAdminState(userId, 'addtopup', 'waiting_userid');
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_addgroup_start') {
                    await bot.editMessageText(
                        `TAMBAH GROUP\n\n` +
                        `Masukkan Group ID:\n\n` +
                        `Contoh: -1001234567890\n\n` +
                        `(Gunakan /idgrup di grup untuk mengetahui ID grup)`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Batal', callback_data: 'admin_menu' }]
                                ]
                            }
                        }
                    );
                    await setAdminState(userId, 'addgroup', 'waiting_groupid');
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_removegroup_start') {
                    await bot.editMessageText(
                        `HAPUS GROUP\n\n` +
                        `Masukkan Group ID yang ingin dihapus:\n\n` +
                        `Contoh: -1001234567890`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Batal', callback_data: 'admin_menu' }]
                                ]
                            }
                        }
                    );
                    await setAdminState(userId, 'removegroup', 'waiting_groupid');
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_broadcast_start') {
                    await bot.editMessageText(
                        `BROADCAST PESAN\n\n` +
                        `Kirim pesan yang ingin disebarkan ke semua user.\n\n` +
                        `Anda bisa mengirim teks biasa atau foto dengan caption.\n\n` +
                        `Ketik /batal untuk membatalkan.`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Batal', callback_data: 'admin_menu' }]
                                ]
                            }
                        }
                    );
                    await setAdminState(userId, 'broadcast', 'waiting_message');
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_offinfo') {
                    if (!db.feature) db.feature = {};
                    db.feature.info = false;
                    await saveDB();
                    await bot.editMessageText(
                        `Fitur info telah dinonaktifkan.`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Kembali ke Admin Menu', callback_data: 'admin_menu' }]
                                ]
                            }
                        }
                    );
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_oninfo') {
                    if (!db.feature) db.feature = {};
                    db.feature.info = true;
                    await saveDB();
                    await bot.editMessageText(
                        `Fitur info telah diaktifkan.`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Kembali ke Admin Menu', callback_data: 'admin_menu' }]
                                ]
                            }
                        }
                    );
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'langganan_7days' || data === 'langganan_30days') {
                    await bot.answerCallbackQuery(cb.id);
                    const subscriptionType = data === 'langganan_7days' ? '7days' : '30days';
                    const amount = subscriptionType === '7days' ? 50000 : 100000;
                    
                    const credits = getUserCredits(userId);
                    if (credits < amount) {
                        await bot.editMessageText(
                            `Saldo tidak cukup\n\n` +
                            `Saldo Anda: Rp ${credits.toLocaleString()}\n` +
                            `Butuh: Rp ${amount.toLocaleString()}\n` +
                            `Kekurangan: Rp ${(amount - credits).toLocaleString()}\n\n` +
                            `Silakan top up terlebih dahulu.`,
                            {
                                chat_id: chatId,
                                message_id: messageId,
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: 'TOP UP', callback_data: 'topup_menu' }],
                                        [{ text: 'KEMBALI', callback_data: 'langganan_menu' }]
                                    ]
                                }
                            }
                        );
                        return;
                    }
                    
                    const result = await buySubscriptionWithBalance(userId, subscriptionType);
                    if (result.success) {
                        const endDate = moment(result.endDate).tz('Asia/Jakarta');
                        await bot.editMessageText(
                            `LANGGANAN AKTIF\n\n` +
                            `Paket: ${subscriptionType === '7days' ? '7 Hari' : '30 Hari'}\n` +
                            `Biaya: Rp ${amount.toLocaleString()}\n` +
                            `Sisa saldo: Rp ${result.newBalance.toLocaleString()}\n` +
                            `Berlaku sampai: ${endDate.format('DD MMMM YYYY HH:mm')} WIB\n\n` +
                            `Terima kasih telah berlangganan!`,
                            {
                                chat_id: chatId,
                                message_id: messageId,
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: 'Kembali ke Menu', callback_data: 'kembali_ke_menu' }]
                                    ]
                                }
                            }
                        );
                    } else {
                        await bot.editMessageText(
                            `Gagal: ${result.error}`,
                            {
                                chat_id: chatId,
                                message_id: messageId,
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: 'KEMBALI', callback_data: 'langganan_menu' }]
                                    ]
                                }
                            }
                        );
                    }
                    return;
                }

                if (data.startsWith('cancel_topup_')) {
                    const orderId = data.replace('cancel_topup_', '');
                    
                    if (db.pending_topups && db.pending_topups[orderId]) {
                        delete db.pending_topups[orderId];
                        await saveDB();
                    }
                    
                    try {
                        await bot.deleteMessage(chatId, messageId);
                    } catch (e) {}
                    
                    await bot.answerCallbackQuery(cb.id, { text: 'Pembayaran dibatalkan' });
                    return;
                }

                if (data.startsWith('topup_')) {
                    await bot.answerCallbackQuery(cb.id, { text: 'Memproses topup...' });
                    
                    const amount = parseInt(data.replace('topup_', ''));
                    
                    const validAmounts = [5000, 10000, 25000, 50000, 100000, 200000, 500000, 1000000];
                    if (!validAmounts.includes(amount)) {
                        await bot.editMessageText('Nominal tidak valid.', {
                            chat_id: chatId,
                            message_id: messageId
                        });
                        return;
                    }
                    
                    await bot.editMessageText('Membuat pembayaran...', {
                        chat_id: chatId,
                        message_id: messageId
                    });
                    
                    const username = cb.from.username || '';
                    const payment = await createPakasirTopup(amount, userId, username);
                    
                    if (!payment.success) {
                        await bot.editMessageText(`Gagal: ${payment.error}`, {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'KEMBALI', callback_data: 'topup_menu' }]
                                ]
                            }
                        });
                        return;
                    }
                    
                    try {
                        const qrBuffer = await QRCode.toBuffer(payment.qrString, { 
                            errorCorrectionLevel: 'L', 
                            margin: 1, 
                            width: 256 
                        });
                        
                        await bot.deleteMessage(chatId, messageId);
                        
                        const sentMessage = await bot.sendPhoto(chatId, qrBuffer, {
                            caption: 
                                `TOP UP SALDO\n\n` +
                                `Nominal: Rp ${amount.toLocaleString()}\n` +
                                `Saldo didapat: Rp ${amount.toLocaleString()}\n\n` +
                                `Order ID: ${payment.orderId}\n` +
                                `Berlaku sampai: ${payment.expiredAt} WIB\n\n` +
                                `Scan QR code di atas untuk membayar.`,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'BATALKAN', callback_data: `cancel_topup_${payment.orderId}` }]
                                ]
                            }
                        });
                        
                        if (db.pending_topups && db.pending_topups[payment.orderId]) {
                            db.pending_topups[payment.orderId].messageId = sentMessage.message_id;
                            db.pending_topups[payment.orderId].chatId = chatId;
                            await saveDB();
                            console.log(`QR terkirim ke chat ${chatId} dengan messageId ${sentMessage.message_id}`);
                        }
                        
                    } catch (qrError) {
                        console.log('Error kirim QR:', qrError.message);
                        await bot.editMessageText(
                            `TOP UP SALDO\n\n` +
                            `Nominal: Rp ${amount.toLocaleString()}\n\n` +
                            `QR Code:\n${payment.qrString}\n\n` +
                            `Order ID: ${payment.orderId}`,
                            {
                                chat_id: chatId,
                                message_id: messageId,
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: 'BATALKAN', callback_data: `cancel_topup_${payment.orderId}` }]
                                    ]
                                }
                            }
                        );
                    }
                    
                    return;
                }
                
                await bot.answerCallbackQuery(cb.id, { text: 'Perintah tidak dikenal' });
                
            } catch (error) {
                console.log('Error callback:', error.message);
                try {
                    await bot.answerCallbackQuery(cb.id, { text: 'Terjadi kesalahan' });
                } catch (e) {}
            }
        });

        const listenerPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
        
        listenerPool.connect((err, client, done) => {
            if (err) {
                console.log('Gagal konek listener:', err.message);
                return;
            }
            client.on('notification', (msg) => {
                console.log('NOTIFY diterima, reload database');
                loadDB().catch(e => console.log('Reload error:', e.message));
            });
            client.query('LISTEN db_updated');
            console.log('Listener PostgreSQL aktif untuk channel db_updated');
        });

        console.log('Bot started, Admin IDs:', ADMIN_IDS);
        
    } catch (error) {
        console.log('FATAL ERROR:', error.message);
        console.log('Bot failed to start. Check your configuration.');
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
