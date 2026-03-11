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
    pending_topups: {} 
};

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
        
        // Kirim notifikasi ke semua listener bahwa database telah berubah
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
            timeout: 60000
        });
        
        console.log(`Checkton response status: ${response.status}`);
        
        if (response.data?.data) {
            return response.data.data;
        }
        
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
            timeout: 60000
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
            timeout: 60000
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
            } else {
                console.log(`TIDAK BISA HAPUS QR - chatId: ${chatId}, messageId: ${messageId}`);
            }
            
            try {
                const newBalance = db.users[userId]?.credits || 0;
                const notifResult = await sendMessage(userId, 
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
                
                if (notifResult && notifResult.ok) {
                    console.log(`NOTIFIKASI TERKIRIM KE USER: ${userId}`);
                } else {
                    console.log(`GAGAL KIRIM NOTIFIKASI: ${notifResult?.description || 'unknown error'}`);
                }
            } catch (notifError) {
                console.log('GAGAL KIRIM NOTIFIKASI:', notifError.message);
            }
            
            console.log(`SALDO USER ${userId}: Rp ${db.users[userId]?.credits || 0} (selesai dalam ${Date.now() - startTime}ms)`);
            
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

        // ========== MIDDLEWARE MESSAGE ==========
        bot.on('message', async (msg) => {
            try {
                const chatId = msg.chat.id, userId = msg.from.id, text = msg.text, chatType = msg.chat.type;
                
                if (!text) return;
                if (chatType !== 'private') return;
                if (isAdmin(userId)) return;
                
                const publicCommands = ['/start', '/info', '/cek', '/find', '/offinfo', '/oninfo', '/listtopup', '/addtopup'];
                if (publicCommands.includes(text.split(' ')[0])) return;
            } catch (error) {
                console.log('Middleware error:', error.message);
            }
        });

        // ========== /START ==========
        bot.onText(/\/start/, async (msg) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                const username = msg.from.username;
                
                await loadDB();
                
                const credits = getUserCredits(userId, username || '');
                
                let message = `SELAMAT DATANG DI BOT NCUS\n\n`;
                message += `User ID: ${userId}\n`;
                message += `Saldo: Rp ${credits.toLocaleString()}\n\n`;
                message += `DAFTAR PERINTAH:\n`;
                message += `/info - Info akun terhubung ( GRATIS )\n`;
                message += `/cek - Detail lengkap akun (Rp 5.000)\n`;
                message += `/find - Cari ID via nickname(Rp 5.000)\n\n`;
                
                if (isAdmin(userId)) {
                    message += `ADMIN:\n`;
                    message += `/offinfo - Nonaktifkan fitur\n`;
                    message += `/oninfo - Aktifkan fitur\n`;
                    message += `/listtopup - Daftar topup\n`;
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

        // ========== /INFO ==========
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
                
                // Tidak ada pengecekan userProcessing
                
                const sent = await sendRequestToRelay(chatId, targetId, serverId);
                
                if (!sent) {
                    await bot.sendMessage(chatId, 'Gagal terhubung ke relay. Coba lagi nanti.');
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

        // ========== /CEK ==========
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
        
        // Cek join channel/group
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
        
        const loadingMsg = await bot.sendMessage(chatId, 'Mengambil data detail...');
        
        try {
            const data = await getMLBBData(targetId, serverId, 'lookup');
            
            if (!data) {
                await bot.editMessageText('Gagal mengambil data.', {
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
            
            // Format tanggal created (TTL)
            let createdDate = '-';
            if (d.ttl) {
                const parts = d.ttl.split('-');
                if (parts.length === 3) {
                    createdDate = `${parts[2]}-${parts[1]}-${parts[0]}`; // Ubah ke DD-MM-YYYY
                }
            }
            
            // OUTPUT LENGKAP DENGAN SEMUA FIELD
            let output = `PLAYER PROFILE\n\n`;
            
            output += `• ID Server: ${d.role_id || targetId} (${d.zone_id || serverId})\n`;
            output += `• Name: ${d.name || '-'}\n`;
            output += `• Level: ${d.level || '-'}\n`;
            output += `• Created: ${createdDate}\n`;
            output += `• Last Login: ${d.last_login || '-'}\n`;
            output += `• Achievement Points: ${d.achievement_points?.toLocaleString() || 0}\n`;
            
            // LAST COUNTRY & CREATED COUNTRY
            if (d.last_country_logged || d.created_country) {
                if (d.last_country_logged) {
                    output += `• Last Country: ${d.last_country_logged}\n`;
                }
                if (d.created_country) {
                    output += `• Created Country: ${d.created_country}\n`;
                }
            }
            output += `\n`;
            
            output += `RANK INFO\n`;
            output += `• Current Tier: ${d.current_tier || '-'}\n`;
            output += `• Highest Tier: ${d.max_tier || '-'}\n`;
            output += `• Overall WR: ${d.overall_win_rate || '0%'}\n`;
            output += `• KDA: ${d.kda || '-'}\n`;
            output += `• Team Participation: ${d.team_participation || '-'}\n`;
            output += `• Flags Percentage: ${d.flags_percentage || '-'}\n\n`;
            
            if (d.collector_level || d.collector_title) {
                output += `COLLECTOR\n`;
                output += `• Level: ${d.collector_level || 0}\n`;
                output += `• Title: ${d.collector_title || '-'}\n\n`;
            }
            
            output += `HERO & SKIN\n`;
            output += `• Heroes: ${d.hero_count || 0}\n`;
            output += `• Skins: ${d.skin_count || 0}\n`;
            output += `• Supreme: ${d.supreme_skins || 0}\n`;
            output += `• Grand: ${d.grand_skins || 0}\n`;
            output += `• Exquisite: ${d.exquisite_skins || 0}\n`;
            output += `• Deluxe: ${d.deluxe_skins || 0}\n`;
            output += `• Exceptional: ${d.exceptional_skins || 0}\n`;
            output += `• Common: ${d.common_skins || 0}\n`;
            if (d.latest_skin_purchase_date) {
                output += `• Latest Skin Purchase: ${d.latest_skin_purchase_date}\n`;
            }
            output += `• Last Hero Purchase: ${d.last_hero_purchase || '-'}\n`;
            output += `• Top 3 Most Used: ${d.top3_most_used_heroes || '-'}\n\n`;
            
            if (d.affinity_list && d.affinity_list.length > 0) {
                output += `AFFINITY\n`;
                output += `• ${d.affinity_list.join('\n• ')}\n\n`;
            }
            
            // LOCATIONS
            if (d.locations_logged && d.locations_logged.length > 0) {
                output += `LOCATIONS\n`;
                output += `• ${d.locations_logged.join('\n• ')}\n\n`;
            }
            
            if (d.top_3_hero_details && d.top_3_hero_details.length > 0) {
                output += `TOP 3 HERO\n`;
                d.top_3_hero_details.forEach((h) => {
                    output += `• ${h.hero || '-'}\n`;
                    output += `  Matches: ${h.matches || 0} | WR: ${h.win_rate || '0%'}\n`;
                    output += `  Power: ${h.power || 0}\n`;
                });
                output += `\n`;
            }
            
            output += `MATCH STATS\n`;
            output += `• Total Match: ${d.total_match_played?.toLocaleString() || 0}\n`;
            output += `• Total Win: ${d.total_wins || 0}\n`;
            output += `• MVP: ${d.total_mvp || 0} (Lose ${d.mvp_loss || 0})\n`;
            output += `• Savage: ${d.savage_kill || 0}\n`;
            output += `• Maniac: ${d.maniac_kill || 0}\n`;
            output += `• Legendary: ${d.legendary_kill || 0}\n`;
            output += `• Double Kill: ${d.double_kill || 0}\n`;
            output += `• Triple Kill: ${d.triple_kill || 0}\n`;
            output += `• Longest Win Streak: ${d.longest_win_streak || 0}\n`;
            output += `• Most Kills: ${d.most_kills || 0}\n`;
            output += `• Most Assists: ${d.most_assists || 0}\n`;
            output += `• Highest Damage: ${d.highest_dmg?.toLocaleString() || 0}\n`;
            output += `• Highest Damage Taken: ${d.highest_dmg_taken?.toLocaleString() || 0}\n`;
            output += `• Highest Gold: ${d.highest_gold?.toLocaleString() || 0}\n`;
            output += `• Min Gold: ${d.min_gold || 0}\n`;
            output += `• Min Hero Damage: ${d.min_hero_damage || 0}\n`;
            output += `• Turret Damage/Match: ${d.turret_dmg_match || 0}\n\n`;
            
            if (d.last_match_data) {
                output += `LAST MATCH\n`;
                output += `• Hero: ${d.last_match_data.hero_name || '-'}\n`;
                output += `• KDA: ${d.last_match_data.kills || 0}/${d.last_match_data.deaths || 0}/${d.last_match_data.assists || 0}\n`;
                output += `• Gold: ${d.last_match_data.gold?.toLocaleString() || 0}\n`;
                output += `• Hero Damage: ${d.last_match_data.hero_damage?.toLocaleString() || 0}\n`;
                output += `• Damage Taken: ${d.last_match_data.damage_taken?.toLocaleString() || 0}\n`;
                output += `• Turret Damage: ${d.last_match_data.turret_damage?.toLocaleString() || 0}\n`;
                output += `• Duration: ${d.last_match_duration || '-'}\n`;
                output += `• Date: ${d.last_match_date || '-'}\n`;
                if (d.last_match_heroes) {
                    output += `• All Heroes: ${d.last_match_heroes}\n`;
                }
                output += `\n`;
            }
            
            // SQUAD SECTION
            if (d.squad_name || d.squad_id) {
                output += `SQUAD\n`;
                if (d.squad_name) {
                    output += `• Name: ${d.squad_name}\n`;
                }
                if (d.squad_prefix) {
                    output += `• Prefix: ${d.squad_prefix}\n`;
                }
                if (d.squad_id) {
                    output += `• Squad ID: ${d.squad_id}\n`;
                }
                output += `\n`;
            }
            
            output += `SOCIAL\n`;
            output += `• Followers: ${d.followers || 0}\n`;
            output += `• Likes: ${d.total_likes || 0}\n`;
            output += `• Popularity: ${d.popularity || 0}\n`;
            output += `• Credit Score: ${d.credits_score || 0}\n\n`;
            
            output += `Sisa saldo: Rp ${getUserCredits(userId).toLocaleString()}`;

            // Cek panjang pesan, jika terlalu panjang bagi menjadi 2
            if (output.length > 4000) {
                // Kirim pesan pertama (sampai sebelum SOCIAL)
                let part1 = output.substring(0, output.indexOf('SOCIAL'));
                part1 += `\n\n[Lanjutan di pesan berikutnya...]`;
                
                await bot.editMessageText(part1, {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id,
                    reply_markup: { 
                        inline_keyboard: [[{ text: 'Stok Admin', url: STOK_ADMIN }]] 
                    }
                });
                
                // Kirim pesan kedua (SOCIAL dan sisanya)
                let part2 = output.substring(output.indexOf('SOCIAL'));
                await bot.sendMessage(chatId, part2);
                
            } else {
                // Jika tidak terlalu panjang, kirim satu pesan
                await bot.editMessageText(output, {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id,
                    reply_markup: { 
                        inline_keyboard: [[{ text: 'Stok Admin', url: STOK_ADMIN }]] 
                    }
                });
            }
            
        } catch (error) {
            console.log('Error saat mengambil data:', error.message);
            await bot.editMessageText('Terjadi kesalahan saat mengambil data.', {
                chat_id: chatId,
                message_id: loadingMsg.message_id
            });
        }

    } catch (error) {
        console.log('Error /cek:', error.message);
        try {
            await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan. Silakan coba lagi.');
        } catch (e) {}
    }
});

        // ========== /FIND ==========
bot.onText(/\/find(?:\s+(.+))?/i, async (msg, match) => {
    try {
        if (msg.chat.type !== 'private') return;
        
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        if (!match || !match[1]) {
            await bot.sendMessage(chatId,
                `PENCARIAN AKUN\n\n` +
                `Format yang tersedia:\n` +
                `1. Cari via Nickname + Server:\n` +
                `   /find NICKNAME SERVER\n` +
                `   Contoh: /find Nama Pemain 1234\n\n` +
                `2. Cari via Role ID:\n` +
                `   /find ID\n` +
                `   Contoh: /find 643461181\n\n` +
                `Biaya: Rp 5.000`
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
                    `Format salah.\n\n` +
                    `Jika ingin mencari berdasarkan nickname, Anda WAJIB menyertakan server.\n` +
                    `Contoh: /find Nama Pemain 1234\n\n` +
                    `Atau cari langsung via Role ID: /find 643461181`
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
                    `Format salah.\n\n` +
                    `Server harus berupa angka.\n` +
                    `Contoh: /find Nama Pemain 1234`
                );
                return;
            }
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
                    failMsg = `Gagal mengambil data.`;
                } else {
                    failMsg = `Gagal mengambil data.`;
                }
                await bot.editMessageText(failMsg, {
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
            
            let output = '';
            if (isRoleIdSearch) {
                output = `HASIL PENCARIAN ROLE ID: ${nickname}\n\n`;
            } else {
                output = `HASIL PENCARIAN: ${nickname} (Server: ${serverFilter})\n\n`;
            }
            
            results.forEach((item, index) => {
                if (!isRoleIdSearch && results.length > 1) {
                    output += `[${index + 1}] `;
                }
                output += `${item.name || item.nickname || 'Unknown'}\n`;
                output += `ID: ${item.role_id || '-'} | Server: ${item.zone_id || '-'}\n`;
                output += `Level: ${item.level || '-'}\n`;
                
                if (item.last_login) {
                    output += `Last Login: ${item.last_login}\n`;
                }
                
                // TAMBAHKAN COUNTRY DAN LAST COUNTRY (langsung dari API)
                if (item.country) {
                    output += `Region: ${item.country}\n`;
                }
                
                if (item.last_country) {
                    output += `Last login region: ${item.last_country}\n`;
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
                message_id: loadingMsg.message_id,
                reply_markup: { 
                    inline_keyboard: [[{ text: 'Stok Admin', url: STOK_ADMIN }]] 
                }
            });
            
        } catch (error) {
            console.log('Error saat mencari data:', error.message);
            await bot.editMessageText('Terjadi kesalahan saat mencari data.', {
                chat_id: chatId,
                message_id: loadingMsg.message_id
            });
        }
        
    } catch (error) {
        console.log('Error /find:', error.message);
        try {
            await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan. Silakan coba lagi.');
        } catch (e) {}
    }
});

        // ========== /LISTTOPUP ==========
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

        // ========== /OFFINFO ==========
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

        // ========== /ONINFO ==========
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

        // ========== /ADDTOPUP ==========
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

        // ========== CALLBACK QUERY ==========
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

        async function editToMainMenu(bot, chatId, messageId, userId) {
            try {
                await loadDB();
                
                const credits = getUserCredits(userId);
                
                let message = `SELAMAT DATANG DI BOT NCUS\n\n`;
                message += `User ID: ${userId}\n`;
                message += `Saldo: Rp ${credits.toLocaleString()}\n\n`;
                message += `DAFTAR PERINTAH:\n`;
                message += `/info - Info akun terhubung ( GRATIS )\n`;
                message += `/cek  - Detail lengkap akun (Rp 5.000)\n`;
                message += `/find - Cari ID via nickname (Rp 5.000)\n`;
                
                if (isAdmin(userId)) {
                    message += `\nADMIN MENU\n`;
                    message += `/offinfo - Nonaktifkan fitur\n`;
                    message += `/oninfo - Aktifkan fitur\n`;
                    message += `/listtopup - Daftar saldo > 0\n`;
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

        // ========== LISTENER NOTIFY DARI POSTGRES ==========
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
