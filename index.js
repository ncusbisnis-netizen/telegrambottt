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
    pending_requests: {} 
};
let spamData = {};
let userProcessing = {};

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

async function loadSpamData() {
    try {
        const res = await pool.query('SELECT value FROM bot_data WHERE key = $1', ['spam']);
        if (res.rows.length > 0) {
            spamData = res.rows[0].value;
            console.log('Load spam data dari Postgres');
        }
    } catch (error) {
        console.log('Gagal load spam:', error.message);
    }
}

async function saveSpamData() {
    try {
        await pool.query(
            `INSERT INTO bot_data (key, value, updated_at) 
             VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO UPDATE 
             SET value = $2, updated_at = NOW()`,
            ['spam', spamData]
        );
    } catch (error) {
        console.log('Gagal save spam:', error.message);
        try {
            fs.writeFileSync('spam.json', JSON.stringify(spamData, null, 2));
        } catch (e) {}
    }
}

initDB().then(async () => {
    await loadDB();
    await loadSpamData();
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
        redisClient.on('connect', () => console.log('Redis connected for relay communication'));
        
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

function formatRupiah(amount) {
    try {
        return 'Rp ' + amount.toLocaleString();
    } catch {
        return 'Rp ' + amount;
    }
}

function isBanned(userId) { 
    return spamData[userId]?.banned === true; 
}

async function recordInfoActivity(userId) {
    try {
        const now = Date.now();
        if (!spamData[userId]) spamData[userId] = { banned: false, infoCount: [] };
        if (spamData[userId].banned) return false;
        spamData[userId].infoCount.push(now);
        spamData[userId].infoCount = spamData[userId].infoCount.filter(t => now - t < 60000);
        if (spamData[userId].infoCount.length > 10) {
            spamData[userId].banned = true;
            spamData[userId].bannedAt = now;
            spamData[userId].banReason = 'Spam 10x dalam 1 menit';
            spamData[userId].infoCount = [];
            await saveSpamData();
            return true;
        }
        await saveSpamData();
        return false;
    } catch (error) {
        console.log('Error recordInfoActivity:', error.message);
        return false;
    }
}

async function unbanUser(userId) {
    try {
        if (spamData[userId]) {
            spamData[userId].banned = false;
            spamData[userId].infoCount = [];
            await saveSpamData();
            return true;
        }
        return false;
    } catch (error) {
        console.log('Error unbanUser:', error.message);
        return false;
    }
}

async function addBan(userId, reason = 'Ban manual oleh admin') {
    try {
        spamData[userId] = { banned: true, bannedAt: Date.now(), banReason: reason, infoCount: [] };
        await saveSpamData();
        return true;
    } catch (error) {
        console.log('Error addBan:', error.message);
        return false;
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
            timeout: 45000
        });
        
        console.log(`Checkton response status: ${response.status}`);
        
        if (response.data) {
            if (response.data.data && response.data.data.role_id) {
                return response.data.data;
            }
            if (response.data.role_id) {
                return response.data;
            }
        }
        
        console.log('Response tidak valid:', JSON.stringify(response.data));
        return null;
        
    } catch (error) {
        console.log(`Error getMLBBData:`, error.message);
        if (error.code === 'ECONNABORTED') {
            console.log('Timeout - koneksi terlalu lama');
        }
        if (error.response) {
            console.log('Response status:', error.response.status);
            console.log('Response data:', JSON.stringify(error.response.data));
        }
        return null;
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
            timeout: 45000
        });
        
        if (response.data) {
            if (response.data.status === 0 && response.data.data) {
                return response.data.data;
            }
            if (Array.isArray(response.data)) {
                return response.data;
            }
            if (response.data.role_id) {
                return [response.data];
            }
        }
        
        return null;
        
    } catch (error) {
        console.log(`Error findPlayerByName:`, error.message);
        if (error.code === 'ECONNABORTED') {
            console.log('Timeout - koneksi terlalu lama');
        }
        if (error.response) {
            console.log('Response status:', error.response.status);
            console.log('Response data:', JSON.stringify(error.response.data));
        }
        return null;
    }
}

async function getPlayerByRoleId(roleId) {
    try {
        console.log(`Mencari player dengan role_id: ${roleId}`);
        
        const payload = {
            role_id: String(roleId).trim(),
            type: "find"
        };
        
        const response = await axios.post("https://checkton.online/backend/info", payload, {
            headers: { 
                "Content-Type": "application/json",
                "x-api-key": API_KEY_CHECKTON
            },
            timeout: 45000
        });
        
        if (response.data) {
            if (response.data.status === 0 && response.data.data) {
                return response.data.data;
            }
            if (Array.isArray(response.data)) {
                return response.data;
            }
            if (response.data.role_id) {
                return [response.data];
            }
        }
        
        return null;
        
    } catch (error) {
        console.log(`Error getPlayerByRoleId:`, error.message);
        if (error.code === 'ECONNABORTED') {
            console.log('Timeout - koneksi terlalu lama');
        }
        if (error.response) {
            console.log('Response status:', error.response.status);
            console.log('Response data:', JSON.stringify(error.response.data));
        }
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

async function sendRequestToRelay(chatId, userId, serverId) {
    try {
        if (!redisClient || !redisClient.isReady) {
            console.log('Redis not connected');
            return false;
        }
        
        const requestId = `req:${chatId}:${chatId}:${Date.now()}`;
        const requestData = {
            user_id: chatId,
            chat_id: chatId,
            command: '/info',
            args: [String(userId), String(serverId)],
            time: Date.now() / 1000
        };
        
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

// ==================== WEBHOOK RELAY - MENERIMA HASIL DARI RELAY ====================
app.post('/webhook/relay', async (req, res) => {
    try {
        console.log('WEBHOOK RELAY DITERIMA:', JSON.stringify(req.body));
        
        const { 
            chat_id, 
            target_id, 
            server_id, 
            data, 
            status,
            message 
        } = req.body;
        
        if (!chat_id) {
            return res.status(200).json({ status: 'ok', message: 'no chat_id' });
        }
        
        // CEK PENDING REQUESTS
        if (!db.pending_requests || Object.keys(db.pending_requests).length === 0) {
            console.log('Tidak ada pending requests');
            return res.status(200).json({ status: 'ok', message: 'no pending requests' });
        }
        
        // CARI REQUEST YANG COCOK
        let foundKey = null;
        let foundRequest = null;
        
        // COCOKKAN BERDASARKAN CHAT_ID, TARGET_ID, SERVER_ID
        if (target_id && server_id) {
            const exactKey = `${chat_id}_${target_id}_${server_id}`;
            if (db.pending_requests[exactKey]) {
                foundKey = exactKey;
                foundRequest = db.pending_requests[exactKey];
                console.log(`Ditemukan exact match: ${exactKey}`);
            }
        }
        
        // KALAU TIDAK DITEMUKAN, CARI BERDASARKAN CHAT_ID SAJA
        if (!foundRequest) {
            for (const [key, req] of Object.entries(db.pending_requests)) {
                if (req.chatId == chat_id) {
                    foundKey = key;
                    foundRequest = req;
                    console.log(`Ditemukan berdasarkan chat_id: ${key}`);
                    break;
                }
            }
        }
        
        if (!foundRequest) {
            console.log(`Tidak ada pending request untuk chat ${chat_id}`);
            return res.status(200).json({ status: 'ok', message: 'no matching request' });
        }
        
        const messageId = foundRequest.messageId;
        
        // EDIT PESAN "Proses request..." DENGAN HASIL DARI RELAY
        try {
            if (status === 'success' && data) {
                // FORMAT OUTPUT INFO
                let output = `INFORMASI AKUN\n\n`;
                output += `ID: ${data.role_id || target_id || '-'}\n`;
                output += `Server: ${data.zone_id || server_id || '-'}\n`;
                output += `Nickname: ${data.name || '-'}\n`;
                output += `Level: ${data.level || '-'}\n`;
                
                if (data.current_tier) {
                    output += `Tier: ${data.current_tier}\n`;
                }
                if (data.skin_count) {
                    output += `Total Skin: ${data.skin_count}\n`;
                }
                if (data.overall_win_rate) {
                    output += `Win Rate: ${data.overall_win_rate}\n`;
                }
                if (data.achievement_points) {
                    output += `Achievement Points: ${data.achievement_points.toLocaleString()}\n`;
                }
                
                // EDIT PESAN LOADING MENJADI HASIL INFO
                await bot.editMessageText(output, {
                    chat_id: chat_id,
                    message_id: messageId
                });
                
                console.log(`✅ Pesan berhasil diedit untuk chat ${chat_id}`);
            } else {
                // KALAU GAGAL
                await bot.editMessageText(`Gagal mengambil data: ${message || 'Unknown error'}`, {
                    chat_id: chat_id,
                    message_id: messageId
                });
            }
            
            // HAPUS DARI PENDING REQUESTS
            delete db.pending_requests[foundKey];
            await saveDB();
            
        } catch (editError) {
            console.log('❌ Gagal edit pesan:', editError.message);
        }
        
        res.status(200).json({ status: 'ok', message: 'processed' });
        
    } catch (error) {
        console.log('❌ WEBHOOK RELAY ERROR:', error.message);
        res.status(200).json({ status: 'ok', message: 'error but accepted' });
    }
});

// ==================== WEBHOOK PAKASIR - REALTIME SALDO & AUTO DELETE QRIS ====================
app.post('/webhook/pakasir', async (req, res) => {
    try {
        console.log('WEBHOOK PAKASIR DITERIMA:', JSON.stringify(req.body));
        
        const { order_id, status, amount, transaction_id } = req.body;
        
        // CEK STATUS BAYAR BERHASIL
        if (status === 'paid' || status === 'success' || status === 'completed' || status === 'settlement') {
            
            // AMBIL USER ID DARI ORDER ID (format: TOPUP-USERID-TIMESTAMP)
            const parts = order_id.split('-');
            if (parts.length >= 2) {
                const userId = parseInt(parts[1]);
                
                if (userId && amount) {
                    console.log(`DETEKSI PEMBAYARAN: User ${userId}, Amount ${amount}`);
                    
                    // ========== AUTO DELETE QRIS PAKAI AXIOS ==========
if (db.pending_topups && db.pending_topups[order_id]) {
    const chatId = db.pending_topups[order_id].chatId;
    const messageId = db.pending_topups[order_id].messageId;
    
    if (chatId && messageId) {
        try {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
                chat_id: chatId,
                message_id: messageId
            });
            console.log(`QRIS BERHASIL DIHAPUS untuk chat ${chatId} (Order: ${order_id})`);
        } catch (deleteError) {
            console.log('GAGAL HAPUS QRIS:', deleteError.message);
        }
    }
    
    // Update status pending
    db.pending_topups[order_id].status = 'paid';
    db.pending_topups[order_id].processed = true;
    db.pending_topups[order_id].paid_at = Date.now();
    
    await saveDB();
}
// ========== SELESAI AUTO DELETE ==========
                    
                    // PASTIKAN USER ADA
                    if (!db.users[userId]) {
                        db.users[userId] = { 
                            username: '', 
                            success: 0, 
                            credits: 0, 
                            topup_history: [] 
                        };
                    }
                    
                    // TAMBAH SALDO
                    const oldBalance = db.users[userId].credits || 0;
                    db.users[userId].credits = oldBalance + amount;
                    
                    // CATAT HISTORY
                    if (!db.users[userId].topup_history) {
                        db.users[userId].topup_history = [];
                    }
                    
                    db.users[userId].topup_history.push({
                        amount: amount,
                        order_id: order_id,
                        date: new Date().toISOString(),
                        method: 'qris',
                        transaction_id: transaction_id || null
                    });
                    
                    // SIMPAN KE DATABASE
                    await saveDB();
                    
                    console.log(`SALDO USER ${userId}: ${oldBalance} -> ${db.users[userId].credits}`);
                    
                    // ========== KIRIM NOTIFIKASI KE USER ==========
                    try {
                        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                            chat_id: userId,
                            text: `PEMBAYARAN BERHASIL\n\n` +
                                  `Terima kasih! Pembayaran Anda telah kami terima.\n\n` +
                                  `Detail Transaksi:\n` +
                                  `Order ID: ${order_id}\n` +
                                  `Jumlah: Rp ${amount.toLocaleString()}\n` +
                                  `Status: BERHASIL\n\n` +
                                  `Saldo Anda sekarang: Rp ${db.users[userId].credits.toLocaleString()}`,
                            parse_mode: 'HTML'
                        });
                        console.log(`NOTIFIKASI TERKIRIM KE USER ${userId}`);
                    } catch (notifError) {
                        console.log('GAGAL KIRIM NOTIFIKASI:', notifError.message);
                    }
                    // ========== SELESAI NOTIFIKASI ==========
                }
            }
        }
        
        // SELALU BALIKIN 200 KE PAKASIR
        res.status(200).json({ 
            status: 'ok', 
            message: 'saldo updated realtime' 
        });
        
    } catch (error) {
        console.log('WEBHOOK PAKASIR ERROR:', error.message);
        res.status(200).json({ 
            status: 'ok', 
            message: 'error but accepted' 
        });
    }
});

// Endpoint untuk test relay (debug)
app.post('/test-relay', async (req, res) => {
    const { chat_id, target_id, server_id } = req.body;
    
    if (!chat_id) {
        return res.status(400).json({ error: 'chat_id required' });
    }
    
    // DATA DUMMY UNTUK TEST
    const dummyData = {
        role_id: target_id || '123456',
        zone_id: server_id || '1234',
        name: 'TEST USER',
        level: '120',
        current_tier: 'Mythical Glory',
        skin_count: 350,
        overall_win_rate: '58.5%',
        achievement_points: 25000
    };
    
    // KIRIM KE WEBHOOK RELAY
    try {
        const response = await axios.post(`http://localhost:${PORT}/webhook/relay`, {
            chat_id: parseInt(chat_id),
            target_id: target_id || '123456',
            server_id: server_id || '1234',
            data: dummyData,
            status: 'success'
        });
        
        res.json({ 
            status: 'ok', 
            message: 'test relay sent',
            relay_response: response.data 
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'error', 
            message: error.message 
        });
    }
});

// Endpoint untuk cek saldo user (debug)
app.get('/cek-saldo/:user_id', async (req, res) => {
    const userId = parseInt(req.params.user_id);
    await loadDB();
    
    const user = db.users[userId];
    res.json({
        user_id: userId,
        username: user?.username || null,
        saldo: user?.credits || 0,
        history: user?.topup_history || []
    });
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
                const chatId = msg.chat.id, userId = msg.from.id, text = msg.text, chatType = msg.chat.type;
                
                if (!text) return;
                if (chatType !== 'private') return;
                if (isAdmin(userId)) return;
                
                if (!msg.from.username) {
                    await bot.sendMessage(chatId, 
                        `USERNAME DIPERLUKAN\n\n` +
                        `Anda harus memiliki username Telegram untuk menggunakan bot ini.\n\n` +
                        `Cara membuat username:\n` +
                        `1. Buka Settings\n` +
                        `2. Pilih Username\n` +
                        `3. Buat username baru\n` +
                        `4. Simpan`
                    );
                    return;
                }
                
                const publicCommands = ['/start', '/info', '/cek', '/find', '/offinfo', '/oninfo', '/listbanned', '/listtopup', '/addban', '/unban', '/addtopup'];
                if (publicCommands.includes(text.split(' ')[0])) return;
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
                
                if (!username && !isAdmin(userId)) {
                    await bot.sendMessage(chatId, 
                        `USERNAME DIPERLUKAN\n\n` +
                        `Anda harus memiliki username Telegram untuk menggunakan bot ini.\n\n` +
                        `Cara membuat username:\n` +
                        `1. Buka Settings\n` +
                        `2. Pilih Username\n` +
                        `3. Buat username baru\n` +
                        `4. Simpan`
                    );
                    return;
                }
                
                await loadDB();
                
                const credits = getUserCredits(userId, username || '');
                
                let message = `SELAMAT DATANG DI BOT NCUS\n\n`;
                message += `User ID: ${userId}\n`;
                message += `Saldo: Rp ${credits.toLocaleString()}\n\n`;
                message += `DAFTAR PERINTAH:\n`;
                message += `/info ID SERVER - Info akun ( GRATIS )\n`;
                message += `/cek ID SERVER - Detail akun (Rp 5.000)\n`;
                message += `/find NICKNAME/ID - Cari akun (Rp 5.000)\n\n`;
                
                if (isAdmin(userId)) {
                    message += `ADMIN:\n`;
                    message += `/offinfo - Nonaktifkan fitur\n`;
                    message += `/oninfo - Aktifkan fitur\n`;
                    message += `/listbanned - Daftar banned\n`;
                    message += `/listtopup - Daftar topup\n`;
                    message += `/addban ID - Blokir user\n`;
                    message += `/unban ID - Buka blokir\n`;
                    message += `/addtopup ID JUMLAH - Tambah saldo user\n`;
                }
                
                const replyMarkup = {
                    inline_keyboard: [
                        [{ text: 'TOP UP', callback_data: 'topup_menu' }]
                    ]
                };
                
                await bot.sendMessage(chatId, message, { reply_markup: replyMarkup });
            } catch (error) {
                console.log('Error /start:', error.message);
                try {
                    await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan. Silakan coba lagi.');
                } catch (e) {}
            }
        });

// ========== /INFO - KIRIM "Proses request..." SAJA ==========
bot.onText(/\/info(?:\s+(.+))?/i, async (msg, match) => {
    try {
        if (msg.chat.type !== 'private') return;
        
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        if (!match || !match[1]) {
            await bot.sendMessage(chatId,
                `INFORMASI AKUN\n\n` +
                `Format: /info ID_USER ID_SERVER\n` +
                `Contoh: /info 643461181 8554`
            );
            return;
        }
        
        if (isBanned(userId) && !isAdmin(userId)) {
            await bot.sendMessage(chatId, 'Anda telah diblokir. Hubungi admin.');
            return;
        }
        
        if (!db.feature?.info && !isAdmin(userId)) {
            await bot.sendMessage(chatId, 'Fitur info sedang dinonaktifkan oleh admin.');
            return;
        }
        
        const joined = await checkJoin(bot, userId);
        
        if ((!joined.channel || !joined.group) && !isAdmin(userId)) {
            let message = `AKSES DITOLAK\n\nAnda WAJIB bergabung dengan:\n`;
            if (!joined.channel) message += `• ${CHANNEL}\n`;
            if (!joined.group) message += `• ${GROUP}\n\n`;
            
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
        
        const banned = await recordInfoActivity(userId);
        if (banned) {
            await bot.sendMessage(chatId, 'Anda telah dibanned karena spam.');
            return;
        }
        
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
        
        userProcessing[userId] = true;
        
        try {
            // KIRIM PESAN "Proses request..." SAJA
            await bot.sendMessage(chatId, `Proses request...`);
            
            // KIRIM KE RELAY
            const sent = await sendRequestToRelay(chatId, targetId, serverId);
            
            if (!sent) {
                await bot.sendMessage(chatId, 'Gagal terhubung ke relay. Coba lagi nanti.');
                return;
            }
            
            // UPDATE STATISTIK USER
            getUserCredits(userId, msg.from.username || '');
            db.users[userId].success += 1;
            db.total_success += 1;
            await saveDB();
            
        } finally {
            setTimeout(() => {
                delete userProcessing[userId];
            }, 30000);
        }
        
    } catch (error) {
        console.log('Error /info:', error.message);
        delete userProcessing[userId];
        try {
            await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan. Silakan coba lagi.');
        } catch (e) {}
    }
});
// ========== END /INFO ==========

        bot.onText(/\/cek(?:\s+(.+))?/i, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                
                if (!match || !match[1]) {
                    await bot.sendMessage(chatId, 
                        `DETAIL AKUN\n\n` +
                        `Format: /cek ID_USER ID_SERVER\n` +
                        `Contoh: /cek 643461181 8554\n\n` +
                        `Biaya: Rp 5.000`
                    );
                    return;
                }
                
                if (isBanned(userId) && !isAdmin(userId)) {
                    await bot.sendMessage(chatId, 'Anda telah diblokir. Hubungi admin.');
                    return;
                }
                
                const joined = await checkJoin(bot, userId);
                
                if ((!joined.channel || !joined.group) && !isAdmin(userId)) {
                    let message = `AKSES DITOLAK\n\nAnda WAJIB bergabung dengan:\n`;
                    if (!joined.channel) message += `• ${CHANNEL}\n`;
                    if (!joined.group) message += `• ${GROUP}\n\n`;
                    
                    const buttons = [];
                    if (!joined.channel) {
                        buttons.push([{ text: `Bergabung ke Channel`, url: `https://t.me/${CHANNEL.replace('@', '')}` }]);
                    }
                    if (!joined.group) {
                        buttons.push([{ text: `Bergabung ke Group`, url: `https://t.me/${GROUP.replace('@', '')}` }]);
                    }
                    
                    await bot.sendMessage(chatId, message, { reply_markup: { inline_keyboard: buttons } });
                    return;
                }
                
                const args = match[1].trim().split(/\s+/);
                if (args.length < 2) {
                    await bot.sendMessage(chatId, `Format: /cek ID_USER ID_SERVER`);
                    return;
                }
                
                const targetId = args[0];
                const serverId = args[1];
                
                if (!/^\d+$/.test(targetId) || !/^\d+$/.test(serverId)) {
                    await bot.sendMessage(chatId, 'ID dan Server harus angka.');
                    return;
                }
                
                const banned = await recordInfoActivity(userId);
                if (banned) {
                    await bot.sendMessage(chatId, 'Anda telah dibanned karena spam.');
                    return;
                }
                
                const credits = getUserCredits(userId, msg.from.username || '');
                if (credits < 5000 && !isAdmin(userId)) {
                    await bot.sendMessage(chatId,
                        `SALDO TIDAK CUKUP\n\n` +
                        `Saldo Anda: Rp ${credits.toLocaleString()}\n` +
                        `Biaya /cek: Rp 5.000\n` +
                        `Kekurangan: Rp ${(5000 - credits).toLocaleString()}\n\n` +
                        `Silakan isi saldo terlebih dahulu:`,
                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'TOP UP', callback_data: 'topup_menu' }]
                                ]
                            }
                        }
                    );
                    return;
                }
                
                userProcessing[userId] = true;
                
                const loadingMsg = await bot.sendMessage(chatId, 'Mengambil data detail...');
                
                try {
                    const data = await getMLBBData(targetId, serverId, 'lookup');
                    
                    if (!data) {
                        await bot.editMessageText(
                            'Gagal mengambil data. Saldo Anda tidak terpotong.\n\n' +
                            'Silakan coba lagi nanti.', {
                            chat_id: chatId,
                            message_id: loadingMsg.message_id
                        });
                        console.log(`SALDO TIDAK DIPOTONG: User ${userId} | Command: cek | Alasan: Data null`);
                        return;
                    }
                    
                    if (!isAdmin(userId)) {
                        const sebelum = db.users[userId].credits;
                        db.users[userId].credits -= 5000;
                        await saveDB();
                        console.log(`SALDO DIPOTONG: User ${userId} | Sebelum: ${sebelum} | Sesudah: ${db.users[userId].credits} | Command: cek | Status: SUKSES`);
                    }

                    const d = data;
                    let output = `DETAIL AKUN\n\n`;
                    output += `ID: ${d.role_id || targetId}\n`;
                    output += `Server: ${d.zone_id || serverId}\n`;
                    output += `Nickname: ${d.name || '-'}\n`;
                    output += `Level: ${d.level || '-'}\n`;
                    output += `TTL: ${d.ttl || '-'}\n\n`;
                    
                    output += `RANK & TIER\n`;
                    output += `Current: ${d.current_tier || '-'}\n`;
                    output += `Max: ${d.max_tier || '-'}\n`;
                    output += `Achievement Points: ${d.achievement_points?.toLocaleString() || '-'}\n\n`;
                    
                    output += `KOLEKSI SKIN\n`;
                    output += `Total: ${d.skin_count || 0}\n`;
                    output += `Supreme: ${d.supreme_skins || 0} | Grand: ${d.grand_skins || 0}\n`;
                    output += `Exquisite: ${d.exquisite_skins || 0} | Deluxe: ${d.deluxe_skins || 0}\n`;
                    output += `Exceptional: ${d.exceptional_skins || 0} | Common: ${d.common_skins || 0}\n\n`;
                    
                    if (d.top_3_hero_details && d.top_3_hero_details.length > 0) {
                        output += `TOP 3 HERO\n`;
                        d.top_3_hero_details.forEach((h, i) => {
                            output += `${i+1}. ${h.hero || '-'}\n`;
                            output += `   Matches: ${h.matches || 0} | WR: ${h.win_rate || '0%'}\n`;
                            output += `   Power: ${h.power || 0}\n`;
                        });
                        output += `\n`;
                    }
                    
                    output += `STATISTIK\n`;
                    output += `Total Match: ${d.total_match_played?.toLocaleString() || 0}\n`;
                    output += `Win Rate: ${d.overall_win_rate || '0%'}\n`;
                    output += `KDA: ${d.kda || '-'}\n`;
                    output += `MVP: ${d.total_mvp || 0}\n`;
                    output += `Savage: ${d.savage_kill || 0} | Maniac: ${d.maniac_kill || 0}\n`;
                    output += `Legendary: ${d.legendary_kill || 0}\n\n`;
                    
                    if (d.squad_name) {
                        output += `SQUAD\n`;
                        output += `Name: ${d.squad_name}\n`;
                        output += `Prefix: ${d.squad_prefix || '-'}\n`;
                        output += `ID: ${d.squad_id || '-'}\n\n`;
                    }
                    
                    if (d.last_match_data) {
                        output += `LAST MATCH\n`;
                        output += `Hero: ${d.last_match_data.hero_name || '-'}\n`;
                        output += `K/D/A: ${d.last_match_data.kills || 0}/${d.last_match_data.deaths || 0}/${d.last_match_data.assists || 0}\n`;
                        output += `Gold: ${d.last_match_data.gold?.toLocaleString() || 0}\n`;
                        output += `Damage: ${d.last_match_data.hero_damage?.toLocaleString() || 0}\n`;
                        output += `Duration: ${d.last_match_duration || '-'}\n`;
                        output += `Date: ${d.last_match_date || '-'}\n`;
                    }

                    output += `\nSisa saldo: Rp ${getUserCredits(userId).toLocaleString()}`;

                    await bot.editMessageText(output, {
                        chat_id: chatId,
                        message_id: loadingMsg.message_id,
                        reply_markup: { 
                            inline_keyboard: [[{ text: 'Stok Admin', url: STOK_ADMIN }]] 
                        }
                    });
                    
                } finally {
                    setTimeout(() => {
                        delete userProcessing[userId];
                    }, 30000);
                }

            } catch (error) {
                console.log('Error /cek:', error.message);
                delete userProcessing[userId];
                try {
                    await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan. Silakan coba lagi.');
                } catch (e) {}
            }
        });

        bot.onText(/\/find(?:\s+(.+))?/i, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                
                if (!match || !match[1]) {
                    await bot.sendMessage(msg.chat.id,
                        `PENCARIAN AKUN\n\n` +
                        `Format:\n` +
                        `• Via Nickname: /find NICKNAME\n` +
                        `  Contoh: /find RRQ Jule\n\n` +
                        `• Via Role ID: /find ID\n` +
                        `  Contoh: /find 643461181\n\n` +
                        `Biaya: Rp 5.000`
                    );
                    return;
                }
                
                const input = match[1].trim();
                
                if (isBanned(userId) && !isAdmin(userId)) {
                    await bot.sendMessage(chatId, 'Anda telah diblokir. Hubungi admin.');
                    return;
                }
                
                const joined = await checkJoin(bot, userId);
                
                if ((!joined.channel || !joined.group) && !isAdmin(userId)) {
                    let message = `AKSES DITOLAK\n\nAnda WAJIB bergabung dengan:\n`;
                    if (!joined.channel) message += `• ${CHANNEL}\n`;
                    if (!joined.group) message += `• ${GROUP}\n\n`;
                    
                    const buttons = [];
                    if (!joined.channel) {
                        buttons.push([{ text: `Bergabung ke Channel`, url: `https://t.me/${CHANNEL.replace('@', '')}` }]);
                    }
                    if (!joined.group) {
                        buttons.push([{ text: `Bergabung ke Group`, url: `https://t.me/${GROUP.replace('@', '')}` }]);
                    }
                    
                    await bot.sendMessage(chatId, message, { reply_markup: { inline_keyboard: buttons } });
                    return;
                }
                
                const credits = getUserCredits(userId, msg.from.username || '');
                if (credits < 5000 && !isAdmin(userId)) {
                    await bot.sendMessage(chatId,
                        `SALDO TIDAK CUKUP\n\n` +
                        `Saldo Anda: Rp ${credits.toLocaleString()}\n` +
                        `Biaya /find: Rp 5.000\n` +
                        `Kekurangan: Rp ${(5000 - credits).toLocaleString()}\n\n` +
                        `Silakan isi saldo terlebih dahulu:`,
                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'TOP UP', callback_data: 'topup_menu' }]
                                ]
                            }
                        }
                    );
                    return;
                }
                
                const banned = await recordInfoActivity(userId);
                if (banned) {
                    await bot.sendMessage(chatId, 'Anda telah dibanned karena spam.');
                    return;
                }
                
                userProcessing[userId] = true;
                
                const loadingMsg = await bot.sendMessage(chatId, 'Mencari data...');
                
                try {
                    let results = null;
                    let isRoleIdSearch = false;
                    
                    if (/^\d+$/.test(input)) {
                        isRoleIdSearch = true;
                        results = await getPlayerByRoleId(input);
                    } else {
                        results = await findPlayerByName(input);
                    }
                    
                    const searchSuccess = results && results.length > 0;
                    
                    if (!searchSuccess) {
                        await bot.editMessageText(
                            'Gagal mengambil data. Saldo Anda tidak terpotong.\n\n' +
                            'Silakan coba lagi nanti.', {
                            chat_id: chatId,
                            message_id: loadingMsg.message_id
                        });
                        console.log(`SALDO TIDAK DIPOTONG: User ${userId} | Command: find | Alasan: Data null`);
                        return;
                    }
                    
                    if (!isAdmin(userId)) {
                        const sebelum = db.users[userId].credits;
                        db.users[userId].credits -= 5000;
                        await saveDB();
                        console.log(`SALDO DIPOTONG: User ${userId} | Sebelum: ${sebelum} | Sesudah: ${db.users[userId].credits} | Command: find | Status: SUKSES`);
                    }
                    
                    let output = isRoleIdSearch 
                        ? `HASIL PENCARIAN ROLE ID: ${input}\n\n`
                        : `HASIL PENCARIAN NICKNAME: ${input}\n\n`;
                    
                    output += `Ditemukan ${results.length} akun:\n\n`;
                    
                    results.forEach((item, index) => {
                        output += `[${index + 1}] ${item.name || item.nickname || 'Unknown'}\n`;
                        output += `ID: ${item.role_id || '-'} | Server: ${item.zone_id || '-'}\n`;
                        output += `Level: ${item.level || '-'}\n`;
                        
                        if (item.last_login) {
                            output += `Last Login: ${item.last_login}\n`;
                        }
                        
                        if (item.locations_logged && Array.isArray(item.locations_logged)) {
                            const locations = formatLocations(item.locations_logged, 5);
                            if (locations) {
                                output += `Lokasi: ${locations}\n`;
                            }
                        }
                        
                        output += `--------------------\n`;
                    });
                    
                    output += `\nSisa saldo: Rp ${getUserCredits(userId).toLocaleString()}`;
                    
                    await bot.editMessageText(output, {
                        chat_id: chatId,
                        message_id: loadingMsg.message_id
                    });
                    
                } finally {
                    setTimeout(() => {
                        delete userProcessing[userId];
                    }, 30000);
                }
                
            } catch (error) {
                console.log('Error /find:', error.message);
                delete userProcessing[userId];
                try {
                    await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan. Silakan coba lagi.');
                } catch (e) {}
            }
        });

        bot.onText(/\/listtopup(?:\s+(\d+))?/, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                if (!isAdmin(msg.from.id)) return;
                
                const targetId = match[1] ? parseInt(match[1]) : null;
                
                if (targetId) {
                    const user = db.users[targetId];
                    if (!user || !user.topup_history || user.topup_history.length === 0) {
                        await bot.sendMessage(msg.chat.id, `User ${targetId} tidak memiliki riwayat topup.`);
                        return;
                    }
                    
                    let message = `RIWAYAT TOPUP USER ${targetId}\n\n`;
                    message += `Saldo saat ini: Rp ${(user.credits || 0).toLocaleString()}\n\n`;
                    
                    user.topup_history.forEach((item, i) => {
                        const date = moment(item.date).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm');
                        message += `${i+1}. Rp ${item.amount.toLocaleString()} (${item.order_id || 'Manual'})\n`;
                        message += `   Tanggal: ${date} WIB\n\n`;
                    });
                    
                    await bot.sendMessage(msg.chat.id, message);
                    
                } else {
                    let message = `DAFTAR USER DENGAN SALDO > 0\n\n`;
                    
                    const usersWithBalance = Object.entries(db.users || {})
                        .filter(([_, u]) => (u.credits || 0) > 0)
                        .sort((a, b) => (b[1].credits || 0) - (a[1].credits || 0));
                    
                    if (usersWithBalance.length === 0) {
                        message += 'Tidak ada user dengan saldo.';
                    } else {
                        const totalSaldo = usersWithBalance.reduce((sum, [_, u]) => sum + (u.credits || 0), 0);
                        message += `Total ${usersWithBalance.length} user | Total Saldo: Rp ${totalSaldo.toLocaleString()}\n\n`;
                        
                        usersWithBalance.forEach(([id, u], i) => {
                            const totalTopup = (u.topup_history || []).reduce((sum, item) => sum + (item.amount || 0), 0);
                            message += `${i+1}. ${u.username || 'tanpa username'}\n`;
                            message += `   ID: ${id}\n`;
                            message += `   Saldo: Rp ${(u.credits || 0).toLocaleString()}\n`;
                            message += `   Total Topup: Rp ${totalTopup.toLocaleString()} (${(u.topup_history || []).length}x)\n\n`;
                        });
                    }
                    
                    await bot.sendMessage(msg.chat.id, message);
                }
            } catch (error) {
                console.log('Error /listtopup:', error.message);
            }
        });

        bot.onText(/\/offinfo/, async (msg) => { 
            try {
                if (msg.chat.type !== 'private') return;
                const userId = msg.from.id;
                
                if (!isAdmin(userId)) {
                    await bot.sendMessage(msg.chat.id, 'Anda tidak memiliki akses.');
                    return;
                }
                
                if (!db.feature) db.feature = {};
                db.feature.info = false; 
                await saveDB(); 
                await bot.sendMessage(msg.chat.id, 'Fitur info dinonaktifkan.'); 
                console.log(`Fitur info dinonaktifkan oleh admin ${userId}`);
                
            } catch (error) {
                console.log('Error /offinfo:', error.message);
                await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan.');
            }
        });

        bot.onText(/\/oninfo/, async (msg) => { 
            try {
                if (msg.chat.type !== 'private') return;
                const userId = msg.from.id;
                
                if (!isAdmin(userId)) {
                    await bot.sendMessage(msg.chat.id, 'Anda tidak memiliki akses.');
                    return;
                }
                
                if (!db.feature) db.feature = {};
                db.feature.info = true; 
                await saveDB(); 
                await bot.sendMessage(msg.chat.id, 'Fitur info diaktifkan.'); 
                console.log(`Fitur info diaktifkan oleh admin ${userId}`);
                
            } catch (error) {
                console.log('Error /oninfo:', error.message);
                await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan.');
            }
        });

        bot.onText(/\/listbanned/, async (msg) => {
            try {
                if (msg.chat.type !== 'private') return;
                if (!isAdmin(msg.from.id)) return;
                
                let message = `DAFTAR USER BANNED\n\n`;
                const bannedList = Object.entries(spamData).filter(([_, d]) => d.banned);
                
                if (bannedList.length === 0) {
                    message += 'Tidak ada user yang diblokir.';
                } else {
                    bannedList.forEach(([id, d], i) => {
                        const date = moment(d.bannedAt).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm');
                        message += `${i+1}. ID: ${id}\n`;
                        message += `   Alasan: ${d.banReason || 'Tidak ada'}\n`;
                        message += `   Tanggal: ${date} WIB\n\n`;
                    });
                }
                
                await bot.sendMessage(msg.chat.id, message);
            } catch (error) {
                console.log('Error /listbanned:', error.message);
            }
        });

        bot.onText(/\/addban(?:\s+(\d+)(?:\s+(.+))?)?/, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                if (!isAdmin(msg.from.id)) return;
                
                if (!match[1]) {
                    await bot.sendMessage(msg.chat.id, 'Format: /addban ID [alasan]');
                    return;
                }
                
                const targetId = parseInt(match[1]);
                const reason = match[2] || 'Ban manual oleh admin';
                
                const now = Date.now();
                spamData[targetId] = { 
                    banned: true, 
                    bannedAt: now, 
                    banReason: reason, 
                    infoCount: [] 
                };
                await saveSpamData();
                
                await bot.sendMessage(msg.chat.id, `User ${targetId} telah diblokir.\nAlasan: ${reason}`);
                
                try {
                    await bot.sendMessage(targetId, 
                        `AKUN ANDA DIBLOKIR\n\n` +
                        `Alasan: ${reason}\n` +
                        `Hubungi admin jika ada kesalahan.`
                    );
                } catch (e) {}
                
            } catch (error) {
                console.log('Error /addban:', error.message);
            }
        });

        bot.onText(/\/unban (\d+)/, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                if (!isAdmin(msg.from.id)) return;
                
                const targetId = parseInt(match[1]);
                
                if (spamData[targetId]) {
                    spamData[targetId].banned = false;
                    spamData[targetId].infoCount = [];
                    await saveSpamData();
                    await bot.sendMessage(msg.chat.id, `User ${targetId} telah di-unban.`);
                    
                    try {
                        await bot.sendMessage(targetId, `Akun Anda telah di-unban. Silakan gunakan bot kembali.`);
                    } catch (e) {}
                } else {
                    await bot.sendMessage(msg.chat.id, `User ${targetId} tidak ditemukan.`);
                }
            } catch (error) {
                console.log('Error /unban:', error.message);
            }
        });

        bot.onText(/\/addtopup (\d+) (\d+)/, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                if (!isAdmin(msg.from.id)) return;
                
                const targetId = parseInt(match[1]);
                const amount = parseInt(match[2]);
                
                if (amount < 1 || amount > 1000000) {
                    await bot.sendMessage(msg.chat.id, 'Jumlah harus 1-1.000.000.');
                    return;
                }
                
                const newBalance = await addCredits(targetId, amount, null);
                
                await bot.sendMessage(msg.chat.id, 
                    `TOPUP MANUAL BERHASIL\n\n` +
                    `User: ${targetId}\n` +
                    `Jumlah: Rp ${amount.toLocaleString()}\n` +
                    `Saldo sekarang: Rp ${newBalance.toLocaleString()}`
                );
                
                try {
                    await bot.sendMessage(targetId, 
                        `SALDO DITAMBAH ADMIN\n\n` +
                        `Saldo Anda bertambah Rp ${amount.toLocaleString()}.\n` +
                        `Saldo sekarang: Rp ${newBalance.toLocaleString()}`
                    );
                } catch (e) {}
                
            } catch (error) {
                console.log('Error /addtopup:', error.message);
            }
        });

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

                if (data === 'topup_menu') {
                    await editToTopupMenu(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
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
                                `Scan QR code di atas untuk membayar.\n\n` +
                                `Saldo akan masuk otomatis begitu pembayaran berhasil`,
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
                            `Order ID: ${payment.orderId}\n\n` +
                            `Saldo akan masuk otomatis begitu pembayaran berhasil`,
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

        async function editToMainMenu(bot, chatId, messageId, userId) {
            try {
                await loadDB();
                
                const credits = getUserCredits(userId);
                
                let message = `MENU UTAMA\n\n`;
                message += `User ID: ${userId}\n`;
                message += `Saldo: Rp ${credits.toLocaleString()}\n\n`;
                message += `DAFTAR PERINTAH:\n`;
                message += `/info ID SERVER - Info akun\n`;
                message += `/cek ID SERVER - Detail akun (Rp 5.000)\n`;
                message += `/find NICKNAME/ID - Cari akun (Rp 5.000)\n`;
                
                if (isAdmin(userId)) {
                    message += `\nADMIN MENU\n`;
                    message += `/offinfo - Nonaktifkan fitur\n`;
                    message += `/oninfo - Aktifkan fitur\n`;
                    message += `/listbanned - Daftar banned\n`;
                    message += `/listtopup - Daftar saldo > 0\n`;
                    message += `/addban ID - Blokir user\n`;
                    message += `/unban ID - Buka blokir\n`;
                    message += `/addtopup ID JUMLAH - Tambah saldo\n`;
                }
                
                const replyMarkup = {
                    inline_keyboard: [
                        [{ text: 'TOP UP', callback_data: 'topup_menu' }]
                    ]
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
            try {
                const credits = getUserCredits(userId);
                
                const message = 
                    `TOP UP SALDO\n\n` +
                    `Saldo Anda: Rp ${credits.toLocaleString()}\n\n` +
                    `Pilih nominal top up:\n\n` +
                    `Saldo akan masuk otomatis begitu pembayaran berhasil`;
                
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
                        [
                            { text: 'KEMBALI KE MENU', callback_data: 'kembali_ke_menu' }
                        ]
                    ]
                };
                
                await bot.editMessageText(message, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: replyMarkup
                });
            } catch (error) {
                console.log('Error editToTopupMenu:', error.message);
            }
        }

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
