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

// ==================== GARBAGE COLLECTION ====================
if (global.gc) {
    setInterval(() => {
        try {
            global.gc();
        } catch (e) {}
    }, 60000);
}

// ==================== ERROR HANDLING GLOBAL ====================
process.on('uncaughtException', (error) => {
    console.log('ERROR GLOBAL:', error.message);
});

process.on('unhandledRejection', (reason) => {
    console.log('UNHANDLED REJECTION:', reason);
});

// ==================== KONFIGURASI ====================
const IS_WORKER = process.env.DYNO && process.env.DYNO.includes('worker');
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL = process.env.CHANNEL;
const GROUP = process.env.GROUP;
const STOK_ADMIN = process.env.STOK_ADMIN;
const REDIS_URL = process.env.REDIS_URL || process.env.REDISCLOUD_URL;
const API_KEY_CHECKTON = process.env.API_KEY_CHECKTON;

const ADMIN_IDS = process.env.ADMIN_IDS 
    ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) 
    : [];

// ==================== DATABASE IN-MEMORY ====================
let db = { 
    users: {}, 
    total_success: 0, 
    feature: { info: true },
    pending_topups: {},
    pending_deletes: {},
    pending_requests: {} 
};

let spamData = {};
let userProcessing = {};

// ==================== POSTGRESQL ====================
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
    } catch (error) {}
}

async function loadDB() {
    try {
        const res = await pool.query('SELECT value FROM bot_data WHERE key = $1', ['database']);
        if (res.rows.length > 0) {
            db = res.rows[0].value;
            if (!db.pending_deletes) db.pending_deletes = {};
            if (!db.pending_requests) db.pending_requests = {};
        }
    } catch (error) {
        try {
            if (fs.existsSync('database.json')) {
                const data = fs.readFileSync('database.json', 'utf8');
                db = JSON.parse(data);
                if (!db.pending_deletes) db.pending_deletes = {};
                if (!db.pending_requests) db.pending_requests = {};
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
        return true;
    } catch (error) {
        try {
            fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
        } catch (e) {}
        return false;
    }
}

async function loadSpamData() {
    try {
        const res = await pool.query('SELECT value FROM bot_data WHERE key = $1', ['spam']);
        if (res.rows.length > 0) {
            spamData = res.rows[0].value;
        }
    } catch (error) {}
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
        try {
            fs.writeFileSync('spam.json', JSON.stringify(spamData, null, 2));
        } catch (e) {}
    }
}

// ==================== REDIS ====================
let redisClient = null;
if (REDIS_URL) {
    try {
        redisClient = redis.createClient({ 
            url: REDIS_URL,
            socket: {
                reconnectStrategy: function(retries) {
                    if (retries > 10) {
                        return new Error('Max retries');
                    }
                    return Math.min(retries * 100, 3000);
                }
            }
        });
        
        redisClient.on('error', (err) => {});
        redisClient.on('connect', () => {});
        
        redisClient.connect().catch(err => {
            redisClient = null;
        });
    } catch (error) {
        redisClient = null;
    }
}

// ==================== FUNGSI BANTU ====================
function isAdmin(userId) { 
    return ADMIN_IDS.includes(userId); 
}

function isBanned(userId) { 
    return spamData[userId]?.banned === true; 
}

function formatRupiah(amount) {
    try {
        return 'Rp ' + amount.toLocaleString();
    } catch {
        return 'Rp ' + amount;
    }
}

// ==================== FUNGSI UTAMA USER ====================
function getUserCredits(userId, username = '') {
    try {
        if (!db.users[userId]) {
            db.users[userId] = { 
                username: username, 
                success: 0, 
                credits: 0, 
                topup_history: [] 
            };
            saveDB().catch(() => {});
        } else if (username && db.users[userId].username !== username) {
            db.users[userId].username = username;
            saveDB().catch(() => {});
        }
        return db.users[userId].credits || 0;
    } catch (error) {
        return 0;
    }
}

async function addCredits(userId, amount, orderId = null) {
    try {
        if (!db.users[userId]) {
            db.users[userId] = { 
                username: '', 
                success: 0, 
                credits: 0, 
                topup_history: [] 
            };
        }
        
        const oldBalance = db.users[userId].credits || 0;
        db.users[userId].credits = oldBalance + amount;
        
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
        return db.users[userId].credits;
    } catch (error) {
        return getUserCredits(userId);
    }
}

// ==================== FUNGSI SPAM ====================
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
        return false;
    }
}

async function addBan(userId, reason = 'Ban manual oleh admin') {
    try {
        spamData[userId] = { banned: true, bannedAt: Date.now(), banReason: reason, infoCount: [] };
        await saveSpamData();
        return true;
    } catch (error) {
        return false;
    }
}

// ==================== FUNGSI CHECK JOIN ====================
async function checkJoin(bot, userId) {
    try {
        if (!CHANNEL || !GROUP) {
            return { channel: true, group: true };
        }
        
        let isChannelMember = false, isGroupMember = false;
        
        if (CHANNEL) {
            try {
                const channelCheck = await bot.getChatMember(CHANNEL, userId);
                isChannelMember = ['member', 'administrator', 'creator'].includes(channelCheck.status);
            } catch (channelError) {
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
                isGroupMember = false;
            }
        } else {
            isGroupMember = true;
        }
        
        return { channel: isChannelMember, group: isGroupMember };
    } catch (error) {
        return { channel: false, group: false };
    }
}

// ==================== FUNGSI API CHECKTON ====================
async function getMLBBData(userId, serverId, type = 'lookup') {
    try {
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
        
        if (response.data) {
            if (response.data.data && response.data.data.role_id) {
                return response.data.data;
            }
            if (response.data.role_id) {
                return response.data;
            }
        }
        
        return null;
    } catch (error) {
        return null;
    }
}

async function findPlayerByName(name) {
    try {
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
        return null;
    }
}

async function getPlayerByRoleId(roleId) {
    try {
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
            result += ', +' + (locations.length - maxItems) + ' lagi';
        }
        return result;
    } catch (error) {
        return '';
    }
}

// ==================== FUNGSI TOPUP PAKASIR ====================
async function createPakasirTopup(amount, userId, username = '') {
    try {
        const orderId = 'TOPUP-' + userId + '-' + Date.now();
        
        if (!db.users[userId]) {
            db.users[userId] = { 
                username: username, 
                success: 0, 
                credits: 0, 
                topup_history: [] 
            };
            await saveDB();
        } else if (username && db.users[userId].username !== username) {
            db.users[userId].username = username;
            await saveDB();
        }
        
        const response = await axios.post(
            (process.env.PAKASIR_BASE_URL || 'https://app.pakasir.com/api') + '/transactioncreate/qris',
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
        return { success: false, error: error.message };
    }
}

// ==================== FUNGSI RELAY ====================
async function sendRequestToRelay(chatId, userId, serverId) {
    try {
        if (!redisClient || !redisClient.isReady) {
            return false;
        }
        
        const requestId = 'req:' + chatId + ':' + chatId + ':' + Date.now();
        const requestData = {
            user_id: chatId,
            chat_id: chatId,
            command: '/info',
            args: [String(userId), String(serverId)],
            time: Date.now() / 1000
        };
        
        await redisClient.setEx(requestId, 300, JSON.stringify(requestData));
        await redisClient.rPush('pending_requests', requestId);
        
        return true;
    } catch (error) {
        return false;
    }
}

// ==================== FUNGSI TELEGRAM API ====================
async function telegramRequest(method, params) {
    try {
        const url = 'https://api.telegram.org/bot' + BOT_TOKEN + '/' + method;
        const response = await axios.post(url, params, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 5000
        });
        return response.data;
    } catch (error) {
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

// ==================== EXPRESS APP ====================
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Bot is running');
});

// ==================== WEBHOOK RELAY ====================
app.post('/webhook/relay', async (req, res) => {
    try {
        const { chat_id, target_id, server_id, data, status, message } = req.body;
        
        if (!chat_id) {
            return res.status(200).json({ status: 'ok' });
        }
        
        if (!db.pending_requests || Object.keys(db.pending_requests).length === 0) {
            return res.status(200).json({ status: 'ok' });
        }
        
        let foundKey = null;
        let foundRequest = null;
        
        if (target_id && server_id) {
            const exactKey = chat_id + '_' + target_id + '_' + server_id;
            if (db.pending_requests[exactKey]) {
                foundKey = exactKey;
                foundRequest = db.pending_requests[exactKey];
            }
        }
        
        if (!foundRequest) {
            for (const [key, req] of Object.entries(db.pending_requests)) {
                if (req.chatId == chat_id) {
                    foundKey = key;
                    foundRequest = req;
                    break;
                }
            }
        }
        
        if (!foundRequest) {
            return res.status(200).json({ status: 'ok' });
        }
        
        const messageId = foundRequest.messageId;
        
        try {
            if (status === 'success' && data) {
                let output = 'INFORMASI AKUN\n\n';
                output += 'ID: ' + (data.role_id || target_id || '-') + '\n';
                output += 'Server: ' + (data.zone_id || server_id || '-') + '\n';
                output += 'Nickname: ' + (data.name || '-') + '\n';
                output += 'Level: ' + (data.level || '-') + '\n';
                
                if (data.current_tier) {
                    output += 'Tier: ' + data.current_tier + '\n';
                }
                if (data.skin_count) {
                    output += 'Total Skin: ' + data.skin_count + '\n';
                }
                if (data.overall_win_rate) {
                    output += 'Win Rate: ' + data.overall_win_rate + '\n';
                }
                if (data.achievement_points) {
                    output += 'Achievement Points: ' + data.achievement_points.toLocaleString() + '\n';
                }
                
                await bot.editMessageText(output, {
                    chat_id: chat_id,
                    message_id: messageId
                });
            } else {
                await bot.editMessageText('Gagal mengambil data: ' + (message || 'Unknown error'), {
                    chat_id: chat_id,
                    message_id: messageId
                });
            }
            
            delete db.pending_requests[foundKey];
            await saveDB();
            
        } catch (editError) {}
        
        res.status(200).json({ status: 'ok' });
        
    } catch (error) {
        res.status(200).json({ status: 'ok' });
    }
});

// ==================== WEBHOOK PAKASIR ====================
app.post('/webhook/pakasir', async (req, res) => {
    try {
        const { order_id, status, amount, transaction_id } = req.body;
        
        if (status === 'paid' || status === 'success' || status === 'completed' || status === 'settlement') {
            
            const parts = order_id.split('-');
            if (parts.length >= 2) {
                const userId = parseInt(parts[1]);
                const amountNum = parseInt(amount);
                
                if (userId && !isNaN(amountNum) && amountNum > 0) {
                    
                    // PRIORITAS 1: TAMBAH SALDO
                    if (!db.users[userId]) {
                        db.users[userId] = { 
                            username: '', 
                            success: 0, 
                            credits: 0, 
                            topup_history: [] 
                        };
                    }
                    
                    const oldBalance = db.users[userId].credits || 0;
                    db.users[userId].credits = oldBalance + amountNum;
                    
                    if (!db.users[userId].topup_history) {
                        db.users[userId].topup_history = [];
                    }
                    
                    db.users[userId].topup_history.push({
                        amount: amountNum,
                        order_id: order_id,
                        date: new Date().toISOString(),
                        method: 'qris',
                        transaction_id: transaction_id || null
                    });
                    
                    await saveDB();
                    
                    // PRIORITAS 2: HAPUS QRIS
                    let deleteSuccess = false;
                    
                    if (db.pending_topups && db.pending_topups[order_id]) {
                        const pendingData = db.pending_topups[order_id];
                        const chatId = pendingData.chatId;
                        const messageId = pendingData.messageId;
                        
                        db.pending_topups[order_id].status = 'paid';
                        db.pending_topups[order_id].paid_at = Date.now();
                        await saveDB();
                        
                        if (chatId && messageId) {
                            for (let i = 0; i < 3; i++) {
                                try {
                                    await axios.post('https://api.telegram.org/bot' + BOT_TOKEN + '/deleteMessage', {
                                        chat_id: chatId,
                                        message_id: messageId
                                    });
                                    deleteSuccess = true;
                                    delete db.pending_topups[order_id];
                                    await saveDB();
                                    break;
                                } catch (deleteError) {
                                    if (i < 2) {
                                        await new Promise(r => setTimeout(r, 1000));
                                    }
                                }
                            }
                        }
                    }
                    
                    // PRIORITAS 3: KIRIM NOTIFIKASI
                    try {
                        await axios.post('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
                            chat_id: userId,
                            text: 'PEMBAYARAN BERHASIL\n\n' +
                                  'Terima kasih! Pembayaran Anda telah kami terima.\n\n' +
                                  'Detail Transaksi:\n' +
                                  'Order ID: ' + order_id + '\n' +
                                  'Jumlah: Rp ' + amountNum.toLocaleString() + '\n' +
                                  'Status: BERHASIL\n\n' +
                                  'Saldo Anda sekarang: Rp ' + db.users[userId].credits.toLocaleString(),
                            parse_mode: 'HTML'
                        });
                    } catch (notifError) {}
                    
                    // JIKA GAGAL HAPUS, MASUKKAN KE ANTRIAAN
                    if (!deleteSuccess && db.pending_topups && db.pending_topups[order_id]) {
                        const pendingData = db.pending_topups[order_id];
                        if (pendingData.chatId && pendingData.messageId) {
                            if (!db.pending_deletes) {
                                db.pending_deletes = {};
                            }
                            const key = pendingData.chatId + '_' + pendingData.messageId;
                            db.pending_deletes[key] = {
                                chatId: pendingData.chatId,
                                messageId: pendingData.messageId,
                                orderId: order_id,
                                createdAt: Date.now(),
                                retryCount: 0
                            };
                            await saveDB();
                        }
                    }
                }
            }
        }
        
        res.status(200).json({ status: 'ok' });
        
    } catch (error) {
        res.status(200).json({ status: 'ok' });
    }
});

// ==================== CLEANUP SERVICE ====================
setInterval(async () => {
    try {
        const now = Date.now();
        let changed = false;
        
        // PROSES ANTRIAAN DELETE YANG GAGAL
        if (db.pending_deletes) {
            for (const [key, data] of Object.entries(db.pending_deletes)) {
                if (now - data.createdAt > 30000) {
                    try {
                        await axios.post('https://api.telegram.org/bot' + BOT_TOKEN + '/deleteMessage', {
                            chat_id: data.chatId,
                            message_id: data.messageId
                        });
                        delete db.pending_deletes[key];
                        changed = true;
                    } catch (deleteError) {
                        data.retryCount = (data.retryCount || 0) + 1;
                        data.lastAttempt = now;
                        
                        if (data.retryCount >= 5) {
                            delete db.pending_deletes[key];
                            changed = true;
                        }
                    }
                }
            }
        }
        
        // BERSIHKAN PENDING TOPUPS EXPIRED
        if (db.pending_topups) {
            for (const [orderId, data] of Object.entries(db.pending_topups)) {
                if (data.status === 'pending' && now - data.created_at > 2 * 60 * 60 * 1000) {
                    if (data.chatId && data.messageId) {
                        try {
                            await axios.post('https://api.telegram.org/bot' + BOT_TOKEN + '/deleteMessage', {
                                chat_id: data.chatId,
                                message_id: data.messageId
                            });
                        } catch (e) {}
                    }
                    delete db.pending_topups[orderId];
                    changed = true;
                }
            }
        }
        
        if (changed) {
            await saveDB();
        }
    } catch (error) {}
}, 3 * 60 * 1000);

// ==================== INISIALISASI BOT ====================
initDB().then(async () => {
    await loadDB();
    await loadSpamData();

    if (IS_WORKER) {
        
        if (!BOT_TOKEN) {
            return;
        }

        const bot = new TelegramBot(BOT_TOKEN, { 
            polling: { 
                interval: 300, 
                autoStart: true,
                params: { timeout: 10 }
            } 
        });

        bot.on('polling_error', (error) => {});

        bot.on('message', async (msg) => {
            try {
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                const text = msg.text;
                const chatType = msg.chat.type;
                
                if (!text) return;
                if (chatType !== 'private') return;
                if (isAdmin(userId)) return;
                
                if (!msg.from.username) {
                    await bot.sendMessage(chatId, 
                        'USERNAME DIPERLUKAN\n\n' +
                        'Anda harus memiliki username Telegram untuk menggunakan bot ini.\n\n' +
                        'Cara membuat username:\n' +
                        '1. Buka Settings\n' +
                        '2. Pilih Username\n' +
                        '3. Buat username baru\n' +
                        '4. Simpan'
                    );
                    return;
                }
                
                const publicCommands = ['/start', '/info', '/cek', '/find', '/offinfo', '/oninfo', '/listbanned', '/listtopup', '/addban', '/unban', '/addtopup'];
                if (publicCommands.includes(text.split(' ')[0])) return;
            } catch (error) {}
        });

        bot.onText(/\/start/, async (msg) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                const username = msg.from.username;
                
                if (!username && !isAdmin(userId)) {
                    await bot.sendMessage(chatId, 
                        'USERNAME DIPERLUKAN\n\n' +
                        'Anda harus memiliki username Telegram untuk menggunakan bot ini.\n\n' +
                        'Cara membuat username:\n' +
                        '1. Buka Settings\n' +
                        '2. Pilih Username\n' +
                        '3. Buat username baru\n' +
                        '4. Simpan'
                    );
                    return;
                }
                
                await loadDB();
                
                const credits = getUserCredits(userId, username || '');
                
                let message = 'SELAMAT DATANG DI BOT NCUS\n\n';
                message += 'User ID: ' + userId + '\n';
                message += 'Saldo: Rp ' + credits.toLocaleString() + '\n\n';
                message += 'DAFTAR PERINTAH:\n';
                message += '/info ID SERVER - Info akun ( GRATIS )\n';
                message += '/cek ID SERVER - Detail akun (Rp 5.000)\n';
                message += '/find NICKNAME SERVER (Rp 5.000)\n';
                
                if (isAdmin(userId)) {
                    message += 'ADMIN:\n';
                    message += '/offinfo - Nonaktifkan fitur\n';
                    message += '/oninfo - Aktifkan fitur\n';
                    message += '/listbanned - Daftar banned\n';
                    message += '/listtopup - Daftar topup\n';
                    message += '/addban ID - Blokir user\n';
                    message += '/unban ID - Buka blokir\n';
                    message += '/addtopup ID JUMLAH - Tambah saldo user\n';
                }
                
                const replyMarkup = {
                    inline_keyboard: [
                        [{ text: 'TOP UP', callback_data: 'topup_menu' }]
                    ]
                };
                
                await bot.sendMessage(chatId, message, { reply_markup: replyMarkup });
            } catch (error) {
                try {
                    await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan. Silakan coba lagi.');
                } catch (e) {}
            }
        });

        bot.onText(/\/info(?:\s+(.+))?/i, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                const username = msg.from.username || '';
                
                getUserCredits(userId, username);
                
                if (!match || !match[1]) {
                    await bot.sendMessage(chatId,
                        'INFORMASI AKUN\n\n' +
                        'Format: /info ID_USER ID_SERVER\n' +
                        'Contoh: /info 643461181 8554'
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
                    let message = 'AKSES DITOLAK\n\nAnda WAJIB bergabung dengan:\n';
                    if (!joined.channel) message += '• ' + CHANNEL + '\n';
                    if (!joined.group) message += '• ' + GROUP + '\n\n';
                    
                    const buttons = [];
                    if (!joined.channel) {
                        buttons.push([{ text: 'Bergabung ke Channel', url: 'https://t.me/' + CHANNEL.replace('@', '') }]);
                    }
                    if (!joined.group) {
                        buttons.push([{ text: 'Bergabung ke Group', url: 'https://t.me/' + GROUP.replace('@', '') }]);
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
                    await bot.sendMessage(chatId, 'Format: /info ID_USER ID_SERVER');
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
                    const loadingMsg = await bot.sendMessage(chatId, 'Proses request...');
                    
                    const requestKey = chatId + '_' + targetId + '_' + serverId;
                    if (!db.pending_requests) db.pending_requests = {};
                    db.pending_requests[requestKey] = {
                        chatId: chatId,
                        messageId: loadingMsg.message_id,
                        targetId: targetId,
                        serverId: serverId,
                        timestamp: Date.now()
                    };
                    await saveDB();
                    
                    const sent = await sendRequestToRelay(chatId, targetId, serverId);
                    
                    if (!sent) {
                        await bot.editMessageText('Gagal terhubung ke relay. Coba lagi nanti.', {
                            chat_id: chatId,
                            message_id: loadingMsg.message_id
                        });
                        return;
                    }
                    
                    db.users[userId].success += 1;
                    db.total_success += 1;
                    await saveDB();
                    
                } finally {
                    setTimeout(() => {
                        delete userProcessing[userId];
                    }, 30000);
                }
                
            } catch (error) {
                delete userProcessing[userId];
                try {
                    await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan. Silakan coba lagi.');
                } catch (e) {}
            }
        });

        bot.onText(/\/cek(?:\s+(.+))?/i, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                const username = msg.from.username || '';
                
                getUserCredits(userId, username);
                
                if (!match || !match[1]) {
                    await bot.sendMessage(chatId, 
                        'DETAIL AKUN\n\n' +
                        'Format: /cek ID_USER ID_SERVER\n' +
                        'Contoh: /cek 643461181 8554\n\n' +
                        'Biaya: Rp 5.000'
                    );
                    return;
                }
                
                if (isBanned(userId) && !isAdmin(userId)) {
                    await bot.sendMessage(chatId, 'Anda telah diblokir. Hubungi admin.');
                    return;
                }
                
                const joined = await checkJoin(bot, userId);
                
                if ((!joined.channel || !joined.group) && !isAdmin(userId)) {
                    let message = 'AKSES DITOLAK\n\nAnda WAJIB bergabung dengan:\n';
                    if (!joined.channel) message += '• ' + CHANNEL + '\n';
                    if (!joined.group) message += '• ' + GROUP + '\n\n';
                    
                    const buttons = [];
                    if (!joined.channel) {
                        buttons.push([{ text: 'Bergabung ke Channel', url: 'https://t.me/' + CHANNEL.replace('@', '') }]);
                    }
                    if (!joined.group) {
                        buttons.push([{ text: 'Bergabung ke Group', url: 'https://t.me/' + GROUP.replace('@', '') }]);
                    }
                    
                    await bot.sendMessage(chatId, message, { reply_markup: { inline_keyboard: buttons } });
                    return;
                }
                
                const args = match[1].trim().split(/\s+/);
                if (args.length < 2) {
                    await bot.sendMessage(chatId, 'Format: /cek ID_USER ID_SERVER');
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
                
                const credits = getUserCredits(userId, username);
                if (credits < 5000 && !isAdmin(userId)) {
                    await bot.sendMessage(chatId,
                        'SALDO TIDAK CUKUP\n\n' +
                        'Saldo Anda: Rp ' + credits.toLocaleString() + '\n' +
                        'Biaya /cek: Rp 5.000\n' +
                        'Kekurangan: Rp ' + (5000 - credits).toLocaleString() + '\n\n' +
                        'Silakan isi saldo terlebih dahulu:',
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
                        return;
                    }
                    
                    if (!isAdmin(userId)) {
                        db.users[userId].credits -= 5000;
                        await saveDB();
                    }

                    const d = data;
                    let output = 'DETAIL AKUN\n\n';
                    output += 'ID: ' + (d.role_id || targetId) + '\n';
                    output += 'Server: ' + (d.zone_id || serverId) + '\n';
                    output += 'Nickname: ' + (d.name || '-') + '\n';
                    output += 'Level: ' + (d.level || '-') + '\n';
                    output += 'TTL: ' + (d.ttl || '-') + '\n\n';
                    
                    output += 'RANK & TIER\n';
                    output += 'Current: ' + (d.current_tier || '-') + '\n';
                    output += 'Max: ' + (d.max_tier || '-') + '\n';
                    output += 'Achievement Points: ' + ((d.achievement_points || 0).toLocaleString()) + '\n\n';
                    
                    output += 'KOLEKSI SKIN\n';
                    output += 'Total: ' + (d.skin_count || 0) + '\n';
                    output += 'Supreme: ' + (d.supreme_skins || 0) + ' | Grand: ' + (d.grand_skins || 0) + '\n';
                    output += 'Exquisite: ' + (d.exquisite_skins || 0) + ' | Deluxe: ' + (d.deluxe_skins || 0) + '\n';
                    output += 'Exceptional: ' + (d.exceptional_skins || 0) + ' | Common: ' + (d.common_skins || 0) + '\n\n';
                    
                    if (d.top_3_hero_details && d.top_3_hero_details.length > 0) {
                        output += 'TOP 3 HERO\n';
                        d.top_3_hero_details.forEach((h, i) => {
                            output += (i+1) + '. ' + (h.hero || '-') + '\n';
                            output += '   Matches: ' + (h.matches || 0) + ' | WR: ' + (h.win_rate || '0%') + '\n';
                            output += '   Power: ' + (h.power || 0) + '\n';
                        });
                        output += '\n';
                    }
                    
                    output += 'STATISTIK\n';
                    output += 'Total Match: ' + ((d.total_match_played || 0).toLocaleString()) + '\n';
                    output += 'Win Rate: ' + (d.overall_win_rate || '0%') + '\n';
                    output += 'KDA: ' + (d.kda || '-') + '\n';
                    output += 'MVP: ' + (d.total_mvp || 0) + '\n';
                    output += 'Savage: ' + (d.savage_kill || 0) + ' | Maniac: ' + (d.maniac_kill || 0) + '\n';
                    output += 'Legendary: ' + (d.legendary_kill || 0) + '\n\n';
                    
                    if (d.squad_name) {
                        output += 'SQUAD\n';
                        output += 'Name: ' + d.squad_name + '\n';
                        output += 'Prefix: ' + (d.squad_prefix || '-') + '\n';
                        output += 'ID: ' + (d.squad_id || '-') + '\n\n';
                    }
                    
                    if (d.last_match_data) {
                        output += 'LAST MATCH\n';
                        output += 'Hero: ' + (d.last_match_data.hero_name || '-') + '\n';
                        output += 'K/D/A: ' + (d.last_match_data.kills || 0) + '/' + (d.last_match_data.deaths || 0) + '/' + (d.last_match_data.assists || 0) + '\n';
                        output += 'Gold: ' + ((d.last_match_data.gold || 0).toLocaleString()) + '\n';
                        output += 'Damage: ' + ((d.last_match_data.hero_damage || 0).toLocaleString()) + '\n';
                        output += 'Duration: ' + (d.last_match_duration || '-') + '\n';
                        output += 'Date: ' + (d.last_match_date || '-') + '\n';
                    }

                    output += '\nSisa saldo: Rp ' + getUserCredits(userId).toLocaleString();

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
                const username = msg.from.username || '';
                
                getUserCredits(userId, username);
                
                if (!match || !match[1]) {
                    await bot.sendMessage(chatId,
                        'PENCARIAN AKUN\n\n' +
                        'Format yang tersedia:\n' +
                        '1. Cari via Nickname + Server:\n' +
                        '   /find NICKNAME SERVER\n' +
                        '   Contoh: /find Nama Pemain 1234\n\n' +
                        '2. Cari via Role ID:\n' +
                        '   /find ID\n' +
                        '   Contoh: /find 643461181\n\n' +
                        'Biaya: Rp 5.000'
                    );
                    return;
                }
                
                const input = match[1].trim();
                const parts = input.split(/\s+/);
                
                let nickname, serverFilter = null;
                let isRoleIdSearch = false;
                
                if (parts.length === 1) {
                    const single = parts[0];
                    if (/^\d+$/.test(single)) {
                        isRoleIdSearch = true;
                        nickname = single;
                    } else {
                        await bot.sendMessage(chatId,
                            'Format salah.\n\n' +
                            'Jika ingin mencari berdasarkan nickname, Anda WAJIB menyertakan server.\n' +
                            'Contoh: /find Nama Pemain 1234\n\n' +
                            'Atau cari langsung via Role ID: /find 643461181'
                        );
                        return;
                    }
                } else {
                    const lastPart = parts[parts.length - 1];
                    if (/^\d+$/.test(lastPart)) {
                        serverFilter = lastPart;
                        nickname = parts.slice(0, -1).join(' ');
                    } else {
                        await bot.sendMessage(chatId,
                            'Format salah.\n\n' +
                            'Server harus berupa angka.\n' +
                            'Contoh: /find Nama Pemain 1234'
                        );
                        return;
                    }
                }
                
                if (isBanned(userId) && !isAdmin(userId)) {
                    await bot.sendMessage(chatId, 'Anda telah diblokir. Hubungi admin.');
                    return;
                }
                
                const joined = await checkJoin(bot, userId);
                if ((!joined.channel || !joined.group) && !isAdmin(userId)) {
                    let message = 'AKSES DITOLAK\n\nAnda WAJIB bergabung dengan:\n';
                    if (!joined.channel) message += '• ' + CHANNEL + '\n';
                    if (!joined.group) message += '• ' + GROUP + '\n\n';
                    
                    const buttons = [];
                    if (!joined.channel) {
                        buttons.push([{ text: 'Bergabung ke Channel', url: 'https://t.me/' + CHANNEL.replace('@', '') }]);
                    }
                    if (!joined.group) {
                        buttons.push([{ text: 'Bergabung ke Group', url: 'https://t.me/' + GROUP.replace('@', '') }]);
                    }
                    
                    await bot.sendMessage(chatId, message, { reply_markup: { inline_keyboard: buttons } });
                    return;
                }
                
                const credits = getUserCredits(userId, username);
                if (credits < 5000 && !isAdmin(userId)) {
                    await bot.sendMessage(chatId,
                        'SALDO TIDAK CUKUP\n\n' +
                        'Saldo Anda: Rp ' + credits.toLocaleString() + '\n' +
                        'Biaya /find: Rp 5.000\n' +
                        'Kekurangan: Rp ' + (5000 - credits).toLocaleString() + '\n\n' +
                        'Silakan isi saldo terlebih dahulu:',
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
                    
                    if (isRoleIdSearch) {
                        results = await getPlayerByRoleId(nickname);
                    } else {
                        results = await findPlayerByName(nickname);
                        if (results && results.length > 0) {
                            results = results.filter(r => r.zone_id == serverFilter);
                        }
                    }
                    
                    const searchSuccess = results && results.length > 0;
                    
                    if (!searchSuccess) {
                        let failMsg = 'Gagal mengambil data. Saldo Anda tidak terpotong.\n\nSilakan coba lagi nanti.';
                        if (!isRoleIdSearch) {
                            failMsg = 'Tidak ditemukan akun dengan nickname "' + nickname + '" dan server ' + serverFilter + '. Saldo tidak terpotong.';
                        } else {
                            failMsg = 'Tidak ditemukan akun dengan Role ID ' + nickname + '. Saldo tidak terpotong.';
                        }
                        await bot.editMessageText(failMsg, {
                            chat_id: chatId,
                            message_id: loadingMsg.message_id
                        });
                        return;
                    }
                    
                    if (!isAdmin(userId)) {
                        db.users[userId].credits -= 5000;
                        await saveDB();
                    }
                    
                    let output = '';
                    if (isRoleIdSearch) {
                        output = 'HASIL PENCARIAN ROLE ID: ' + nickname + '\n\n';
                    } else {
                        output = 'HASIL PENCARIAN: ' + nickname + ' (Server: ' + serverFilter + ')\n\n';
                    }
                    
                    results.forEach((item, index) => {
                        if (!isRoleIdSearch && results.length > 1) {
                            output += '[' + (index + 1) + '] ';
                        }
                        output += (item.name || item.nickname || 'Unknown') + '\n';
                        output += 'ID: ' + (item.role_id || '-') + ' | Server: ' + (item.zone_id || '-') + '\n';
                        output += 'Level: ' + (item.level || '-') + '\n';
                        
                        if (item.last_login) {
                            output += 'Last Login: ' + item.last_login + '\n';
                        }
                        
                        if (item.locations_logged && Array.isArray(item.locations_logged)) {
                            const locations = formatLocations(item.locations_logged, 5);
                            if (locations) {
                                output += 'Lokasi: ' + locations + '\n';
                            }
                        }
                        
                        output += '--------------------\n';
                    });
                    
                    output += '\nSisa saldo: Rp ' + getUserCredits(userId).toLocaleString();
                    
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
                        await bot.sendMessage(msg.chat.id, 'User ' + targetId + ' tidak memiliki riwayat topup.');
                        return;
                    }
                    
                    let message = 'RIWAYAT TOPUP USER ' + targetId + '\n\n';
                    message += 'Saldo saat ini: Rp ' + ((user.credits || 0).toLocaleString()) + '\n\n';
                    
                    user.topup_history.forEach((item, i) => {
                        const date = moment(item.date).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm');
                        message += (i+1) + '. Rp ' + item.amount.toLocaleString() + ' (' + (item.order_id || 'Manual') + ')\n';
                        message += '   Tanggal: ' + date + ' WIB\n\n';
                    });
                    
                    await bot.sendMessage(msg.chat.id, message);
                    
                } else {
                    let message = 'DAFTAR USER DENGAN SALDO > 0\n\n';
                    
                    const usersWithBalance = Object.entries(db.users || {})
                        .filter(([_, u]) => (u.credits || 0) > 0)
                        .sort((a, b) => (b[1].credits || 0) - (a[1].credits || 0));
                    
                    if (usersWithBalance.length === 0) {
                        message += 'Tidak ada user dengan saldo.';
                    } else {
                        const totalSaldo = usersWithBalance.reduce((sum, [_, u]) => sum + (u.credits || 0), 0);
                        message += 'Total ' + usersWithBalance.length + ' user | Total Saldo: Rp ' + totalSaldo.toLocaleString() + '\n\n';
                        
                        usersWithBalance.forEach(([id, u], i) => {
                            const totalTopup = (u.topup_history || []).reduce((sum, item) => sum + (item.amount || 0), 0);
                            message += (i+1) + '. ' + (u.username || 'tanpa username') + '\n';
                            message += '   ID: ' + id + '\n';
                            message += '   Saldo: Rp ' + ((u.credits || 0).toLocaleString()) + '\n';
                            message += '   Total Topup: Rp ' + totalTopup.toLocaleString() + ' (' + ((u.topup_history || []).length) + 'x)\n\n';
                        });
                    }
                    
                    await bot.sendMessage(msg.chat.id, message);
                }
            } catch (error) {}
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
                
            } catch (error) {
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
                
            } catch (error) {
                await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan.');
            }
        });

        bot.onText(/\/listbanned/, async (msg) => {
            try {
                if (msg.chat.type !== 'private') return;
                if (!isAdmin(msg.from.id)) return;
                
                let message = 'DAFTAR USER BANNED\n\n';
                const bannedList = Object.entries(spamData).filter(([_, d]) => d.banned);
                
                if (bannedList.length === 0) {
                    message += 'Tidak ada user yang diblokir.';
                } else {
                    bannedList.forEach(([id, d], i) => {
                        const date = moment(d.bannedAt).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm');
                        message += (i+1) + '. ID: ' + id + '\n';
                        message += '   Alasan: ' + (d.banReason || 'Tidak ada') + '\n';
                        message += '   Tanggal: ' + date + ' WIB\n\n';
                    });
                }
                
                await bot.sendMessage(msg.chat.id, message);
            } catch (error) {}
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
                
                await bot.sendMessage(msg.chat.id, 'User ' + targetId + ' telah diblokir.\nAlasan: ' + reason);
                
                try {
                    await bot.sendMessage(targetId, 
                        'AKUN ANDA DIBLOKIR\n\n' +
                        'Alasan: ' + reason + '\n' +
                        'Hubungi admin jika ada kesalahan.'
                    );
                } catch (e) {}
                
            } catch (error) {}
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
                    await bot.sendMessage(msg.chat.id, 'User ' + targetId + ' telah di-unban.');
                    
                    try {
                        await bot.sendMessage(targetId, 'Akun Anda telah di-unban. Silakan gunakan bot kembali.');
                    } catch (e) {}
                } else {
                    await bot.sendMessage(msg.chat.id, 'User ' + targetId + ' tidak ditemukan.');
                }
            } catch (error) {}
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
                    'TOPUP MANUAL BERHASIL\n\n' +
                    'User: ' + targetId + '\n' +
                    'Jumlah: Rp ' + amount.toLocaleString() + '\n' +
                    'Saldo sekarang: Rp ' + newBalance.toLocaleString()
                );
                
                try {
                    await bot.sendMessage(targetId, 
                        'SALDO DITAMBAH ADMIN\n\n' +
                        'Saldo Anda bertambah Rp ' + amount.toLocaleString() + '.\n' +
                        'Saldo sekarang: Rp ' + newBalance.toLocaleString()
                    );
                } catch (e) {}
                
            } catch (error) {}
        });

        bot.on('callback_query', async (cb) => {
            try {
                const msg = cb.message;
                if (!msg || msg.chat.type !== 'private') {
                    await bot.answerCallbackQuery(cb.id, { text: 'Bot hanya di private chat' });
                    return;
                }
                
                const chatId = msg.chat.id;
                const userId = cb.from.id;
                const username = cb.from.username || '';
                getUserCredits(userId, username);
                
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
                    
                    const payment = await createPakasirTopup(amount, userId, username);
                    
                    if (!payment.success) {
                        await bot.editMessageText('Gagal: ' + payment.error, {
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
                    
                    const loadingMsg = await bot.sendMessage(chatId, '⏳ Membuat QR Code...');
                    
                    if (db.pending_topups && db.pending_topups[payment.orderId]) {
                        db.pending_topups[payment.orderId].chatId = chatId;
                        db.pending_topups[payment.orderId].messageId = loadingMsg.message_id;
                        await saveDB();
                    }
                    
                    try {
                        const qrBuffer = await QRCode.toBuffer(payment.qrString, { 
                            errorCorrectionLevel: 'L', 
                            margin: 1, 
                            width: 300 
                        });
                        
                        await bot.deleteMessage(chatId, loadingMsg.message_id);
                        
                        const sentMessage = await bot.sendPhoto(chatId, qrBuffer, {
                            caption: 
                                'TOP UP SALDO\n\n' +
                                'Nominal: Rp ' + amount.toLocaleString() + '\n' +
                                'Saldo didapat: Rp ' + amount.toLocaleString() + '\n\n' +
                                'Order ID: ' + payment.orderId + '\n' +
                                'Berlaku sampai: ' + payment.expiredAt + ' WIB\n\n' +
                                'Scan QR code di atas untuk membayar.\n\n' +
                                'Saldo akan masuk otomatis begitu pembayaran berhasil',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'BATALKAN', callback_data: 'cancel_topup_' + payment.orderId }]
                                ]
                            }
                        });
                        
                        if (db.pending_topups && db.pending_topups[payment.orderId]) {
                            db.pending_topups[payment.orderId].messageId = sentMessage.message_id;
                            await saveDB();
                        }
                        
                    } catch (qrError) {
                        await bot.editMessageText(
                            'TOP UP SALDO\n\n' +
                            'Nominal: Rp ' + amount.toLocaleString() + '\n\n' +
                            'QR Code:\n' + payment.qrString + '\n\n' +
                            'Order ID: ' + payment.orderId + '\n\n' +
                            'Saldo akan masuk otomatis begitu pembayaran berhasil',
                            {
                                chat_id: chatId,
                                message_id: loadingMsg.message_id,
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: 'BATALKAN', callback_data: 'cancel_topup_' + payment.orderId }]
                                    ]
                                }
                            }
                        );
                    }
                    
                    return;
                }
                
                await bot.answerCallbackQuery(cb.id, { text: 'Perintah tidak dikenal' });
                
            } catch (error) {
                try {
                    await bot.answerCallbackQuery(cb.id, { text: 'Terjadi kesalahan' });
                } catch (e) {}
            }
        });

        async function editToMainMenu(bot, chatId, messageId, userId) {
            try {
                await loadDB();
                
                const credits = getUserCredits(userId);
                
                let message = 'MENU UTAMA\n\n';
                message += 'User ID: ' + userId + '\n';
                message += 'Saldo: Rp ' + credits.toLocaleString() + '\n\n';
                message += 'DAFTAR PERINTAH:\n';
                message += '/info ID SERVER - Info akun\n';
                message += '/cek ID SERVER - Detail akun (Rp 5.000)\n';
                message += '/find NICKNAME SERVER (Rp 5.000) \n';
                
                if (isAdmin(userId)) {
                    message += '\nADMIN MENU\n';
                    message += '/offinfo - Nonaktifkan fitur\n';
                    message += '/oninfo - Aktifkan fitur\n';
                    message += '/listbanned - Daftar banned\n';
                    message += '/listtopup - Daftar saldo > 0\n';
                    message += '/addban ID - Blokir user\n';
                    message += '/unban ID - Buka blokir\n';
                    message += '/addtopup ID JUMLAH - Tambah saldo\n';
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
            } catch (error) {}
        }

        async function editToTopupMenu(bot, chatId, messageId, userId) {
            try {
                const credits = getUserCredits(userId);
                
                const message = 
                    'TOP UP SALDO\n\n' +
                    'Saldo Anda: Rp ' + credits.toLocaleString() + '\n\n' +
                    'Pilih nominal top up:\n\n' +
                    'Saldo akan masuk otomatis begitu pembayaran berhasil';
                
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
            } catch (error) {}
        }

        // Pembersihan pending_requests kadaluarsa
        setInterval(() => {
            const now = Date.now();
            let changed = false;
            if (db.pending_requests) {
                for (const key in db.pending_requests) {
                    if (now - db.pending_requests[key].timestamp > 300000) {
                        delete db.pending_requests[key];
                        changed = true;
                    }
                }
            }
            if (changed) saveDB().catch(() => {});
        }, 60000);
        
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {});
