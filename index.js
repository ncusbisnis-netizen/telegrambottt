const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const moment = require('moment-timezone');
const cron = require('node-cron');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const redis = require('redis');

// ================== GLOBAL ERROR HANDLER ==================
process.on('uncaughtException', (error) => {
    console.log('ERROR GLOBAL:', error.message);
    console.log(error.stack);
});

process.on('unhandledRejection', (reason) => {
    console.log('UNHANDLED REJECTION:', reason);
});

// ================== CEK JENIS PROSES ==================
const IS_WORKER = process.env.DYNO && process.env.DYNO.includes('worker');

// ================== KONFIGURASI ==================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL = process.env.CHANNEL;
const GROUP = process.env.GROUP;
const STOK_ADMIN = process.env.STOK_ADMIN;
const REDIS_URL = process.env.REDIS_URL || process.env.REDISCLOUD_URL;
const API_KEY_CHECKTON = process.env.API_KEY_CHECKTON || process.env.API_KEY_CHECKTON;

const ADMIN_IDS = process.env.ADMIN_IDS 
    ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) 
    : [];

// ================== DATABASE POSTGRES ==================
let db = { 
    users: {}, 
    total_success: 0, 
    feature: { info: true },
    pending_topups: {} 
};
let spamData = {};
let tempAnnouncement = null;
let userProcessing = {}; // ANTI DOUBLE CHAT: untuk track user yang sedang diproses

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
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
        const res = await pool.query('SELECT value FROM bot_data WHERE key = $1', ['database']);
        if (res.rows.length > 0) {
            db = res.rows[0].value;
            console.log(`Load database sukses. Total users: ${Object.keys(db.users || {}).length}`);
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
        console.log('Menyimpan database ke Postgres...');
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

// ================== REDIS CLIENT (KONEKSI KE RELAY) ==================
let redisClient = null;
try {
    redisClient = redis.createClient({ url: REDIS_URL });
    redisClient.on('error', (err) => console.log('Redis Client Error', err));
    redisClient.connect().then(() => {
        console.log('Redis connected for relay communication');
    }).catch(err => {
        console.log('Redis connection failed:', err.message);
    });
} catch (error) {
    console.log('Redis init error:', error.message);
}

// ================== FUNGSI UTILITY ==================
function isAdmin(userId) { 
    return ADMIN_IDS.includes(userId); 
}

function getUserCredits(userId) {
    try {
        if (!db.users[userId]) {
            db.users[userId] = { 
                username: '', 
                success: 0, 
                credits: 0, 
                topup_history: [] 
            };
        }
        return db.users[userId].credits || 0;
    } catch (error) {
        console.log('Error getUserCredits:', error.message);
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

// ================== ANTI-SPAM ==================
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

// ================== CEK JOIN CHANNEL/GROUP ==================
async function checkJoin(bot, userId) {
    try {
        // Jika channel/group tidak dikonfigurasi, anggap sudah join
        if (!CHANNEL || !GROUP) {
            console.log('Channel atau Group tidak dikonfigurasi, checkJoin dinonaktifkan');
            return { channel: true, group: true };
        }
        
        let isChannelMember = false, isGroupMember = false;
        
        // Cek Channel
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
        
        // Cek Group
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

// ================== FUNGSI GET DATA DARI CHECKTON ==================
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

// ================== FUNGSI FIND PLAYER ==================
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

// ================== FUNGSI FORMAT OUTPUT ==================
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

// ================== PAKASIR API UNTUK TOPUP ==================
async function createPakasirTopup(amount, userId) {
    try {
        const orderId = `TOPUP-${userId}-${Date.now()}`;
        console.log(`Membuat topup: ${orderId}, amount: ${amount}, user: ${userId}`);
        
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

async function checkPakasirTransaction(orderId, amount) {
    try {
        const response = await axios.get(
            `${process.env.PAKASIR_BASE_URL || 'https://app.pakasir.com/api'}/transactiondetail`,
            { 
                params: { 
                    project: process.env.PAKASIR_SLUG || 'ncusspayment', 
                    order_id: orderId, 
                    amount, 
                    api_key: process.env.PAKASIR_API_KEY 
                }, 
                timeout: 10000 
            }
        );
        return response.data?.transaction?.status || 'pending';
    } catch (error) {
        console.log('Error checkPakasirTransaction:', error.message);
        return 'pending';
    }
}

// ================== FUNGSI UNTUK RELAY (REDIS) ==================
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

// ================== EXPRESS SERVER (WEB) ==================
if (!IS_WORKER) {
    const app = express();
    const PORT = process.env.PORT || 3000;
    app.use(express.json());

    app.get('/', (req, res) => res.send('MLBB API Server is running'));

    // ================== WEBHOOK PAKASIR (REALTIME) ==================
    app.post('/webhook/pakasir', (req, res) => {
        // LANGSUNG RESPON 200 KE PAKASIR
        res.status(200).json({ status: 'ok' });
        
        // PROSES DI BACKGROUND AGAR TIDAK MEMBLOKIR RESPON
        setImmediate(async () => {
            try {
                const body = req.body;
                console.log('📩 WEBHOOK PAKASIR:', JSON.stringify(body));
                
                const { order_id, status, amount } = body;
                
                if (!order_id || !status) {
                    console.log('❌ Data webhook tidak lengkap');
                    return;
                }
                
                // Load database terbaru
                await loadDB();
                
                if (status === 'completed' || status === 'paid') {
                    console.log(`✅ Pembayaran sukses: ${order_id}`);
                    
                    // CEK APAKAH TOPUP
                    if (order_id.startsWith('TOPUP-')) {
                        const topupData = db.pending_topups?.[order_id];
                        if (topupData && !topupData.processed) {
                            const userId = topupData.userId;
                            
                            // TAMBAH SALDO LANGSUNG
                            await addCredits(userId, amount, order_id);
                            
                            // Update status
                            db.pending_topups[order_id].status = 'paid';
                            db.pending_topups[order_id].processed = true;
                            db.pending_topups[order_id].notified = true;
                            await saveDB();
                            
                            // Hapus pesan QR jika ada
                            if (topupData.messageId && topupData.chatId) {
                                try {
                                    const bot = new TelegramBot(BOT_TOKEN);
                                    await bot.deleteMessage(topupData.chatId, topupData.messageId);
                                } catch (e) {}
                            }
                            
                            // KIRIM NOTIF LANGSUNG KE USER
                            try {
                                const bot = new TelegramBot(BOT_TOKEN);
                                await bot.sendMessage(userId,
                                    `✅ TOP UP BERHASIL\n\n` +
                                    `Nominal: Rp ${amount.toLocaleString()}\n` +
                                    `Saldo bertambah: Rp ${amount.toLocaleString()}\n` +
                                    `Saldo sekarang: Rp ${getUserCredits(userId).toLocaleString()}`
                                );
                                console.log(`📨 Notifikasi terkirim ke user ${userId}`);
                            } catch (e) {
                                console.log(`❌ Gagal kirim notif ke user ${userId}:`, e.message);
                            }
                        }
                    }
                }
            } catch (error) {
                console.log('❌ Error proses webhook:', error.message);
            }
        });
    });

    // Endpoint untuk tes
    app.get('/tes.php', async (req, res) => {
        try {
            const { userId, serverId, role_id, zone_id } = req.query;
            if (!userId || !serverId || !role_id || !zone_id) {
                return res.status(400).send('Parameter tidak lengkap');
            }
            const data = await getMLBBData(userId, serverId, 'bind');
            if (!data?.username) {
                return res.status(500).send('Gagal mengambil data');
            }
            
            let output = `[userId] => ${userId}\n[serverId] => ${serverId}\n[username] => ${data.username}\n[region] => ${data.region}\n\n`;
            output += `Android: ${data.devices.android} | iOS: ${data.devices.ios}\n\n`;
            if (data.ttl) output += `<table><tr><td>${data.ttl}</td></tr></table>\n\n`;
            if (data.bindAccounts?.length > 0) {
                output += `<ul>\n`;
                data.bindAccounts.forEach(b => output += `<li>${b.platform} : ${b.details || 'empty.'}</li>\n`);
                output += `</ul>\n`;
            }
            res.set('Content-Type', 'text/plain').send(output);
        } catch (error) {
            res.status(500).send('Internal Server Error');
        }
    });

    app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));
} 
// ================== BOT TELEGRAM (WORKER) ==================
else {
    console.log('🤖 Bot worker started');
    
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
            console.log('⚠️ Polling error:', error.message);
        });

        // ================== MIDDLEWARE ==================
        bot.on('message', async (msg) => {
            try {
                const chatId = msg.chat.id, userId = msg.from.id, text = msg.text, chatType = msg.chat.type;
                
                if (!text) return;
                if (chatType !== 'private') return;
                if (isAdmin(userId)) return;
                
                // CEK USERNAME - WAJIB!
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
                
                const publicCommands = ['/start', '/info', '/cek', '/find', '/offinfo', '/oninfo', '/ranking', '/listbanned', '/listtopup', '/addban', '/unban', '/addtopup', '/pesan'];
                if (publicCommands.includes(text.split(' ')[0])) return;
            } catch (error) {
                console.log('Middleware error:', error.message);
            }
        });

        // ================== COMMAND /start ==================
        bot.onText(/\/start/, async (msg) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                await loadDB();
                
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                const username = msg.from.username;
                
                // CEK USERNAME - WAJIB!
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
                
                const credits = getUserCredits(userId);
                
                let message = `SELAMAT DATANG DI BOT NCUS\n\n`;
                message += `User ID: ${userId}\n`;
                message += `Saldo: Rp ${credits.toLocaleString()}\n\n`;
                message += `DAFTAR PERINTAH:\n`;
                message += `/info ID SERVER - Info platform (GRATIS)\n`;
                message += `/cek ID SERVER - Full info (Rp 5.000)\n`;
                message += `/find NICKNAME - Cari via nickname (Rp 5.000)\n`;
                message += `/find ID - Cari via role ID (Rp 5.000)\n\n`;
                
                if (isAdmin(userId)) {
                    message += `ADMIN:\n`;
                    message += `/offinfo - Nonaktifkan fitur\n`;
                    message += `/oninfo - Aktifkan fitur\n`;
                    message += `/ranking - Peringkat user (top 10)\n`;
                    message += `/listbanned - Daftar banned\n`;
                    message += `/listtopup - Daftar topup (saldo > 0)\n`;
                    message += `/addban ID - Blokir user\n`;
                    message += `/unban ID - Buka blokir\n`;
                    message += `/addtopup ID JUMLAH - Tambah saldo user\n`;
                    message += `/pesan TEKS - Kirim pengumuman ke semua user\n`;
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

        // ================== COMMAND /info (TOLAK KERAS + ANTI DOUBLE CHAT) ==================
        bot.onText(/\/info(?:\s+(.+))?/i, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                
                // ANTI DOUBLE CHAT - CEK APAKAH USER SEDANG DIPROSES
                if (userProcessing[userId]) {
                    await bot.sendMessage(chatId, 'Permintaan Anda sedang diproses. Silakan tunggu.');
                    return;
                }
                
                if (!match || !match[1]) {
                    await bot.sendMessage(chatId,
                        `INFORMASI PENGGUNAAN\n\n` +
                        `Format: /info ID_USER ID_SERVER\n` +
                        `Contoh: /info 643461181 8554`
                    );
                    return;
                }
                
                // CEK BANNED
                if (isBanned(userId) && !isAdmin(userId)) {
                    await bot.sendMessage(chatId, 'Anda telah diblokir. Hubungi admin.');
                    return;
                }
                
                // CEK FITUR INFO
                if (!db.feature?.info && !isAdmin(userId)) {
                    await bot.sendMessage(chatId, 'Fitur info sedang dinonaktifkan oleh admin.');
                    return;
                }
                
                // CEK JOIN
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
                
                // CEK SPAM
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
                
                // SET PROCESSING = TRUE (ANTI DOUBLE CHAT)
                userProcessing[userId] = true;
                
                try {
                    // KIRIM KE RELAY
                    const sent = await sendRequestToRelay(chatId, targetId, serverId);
                    
                    if (!sent) {
                        await bot.sendMessage(chatId, 'Gagal terhubung ke relay. Coba lagi nanti.');
                        return;
                    }
                    
                    // Update statistik
                    if (!db.users[userId]) {
                        db.users[userId] = { username: msg.from.username || '', success: 0, credits: 0, topup_history: [] };
                    }
                    db.users[userId].username = msg.from.username || '';
                    db.users[userId].success += 1;
                    db.total_success += 1;
                    await saveDB();
                    
                } finally {
                    // HAPUS PROCESSING (ANTI DOUBLE CHAT)
                    setTimeout(() => {
                        delete userProcessing[userId];
                    }, 30000); // Reset setelah 30 detik
                }
                
            } catch (error) {
                console.log('Error /info:', error.message);
                delete userProcessing[userId]; // Reset jika error
                try {
                    await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan. Silakan coba lagi.');
                } catch (e) {}
            }
        });

        // ================== COMMAND /cek ==================
        bot.onText(/\/cek(?:\s+(.+))?/i, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                
                // ANTI DOUBLE CHAT
                if (userProcessing[userId]) {
                    await bot.sendMessage(chatId, 'Permintaan Anda sedang diproses. Silakan tunggu.');
                    return;
                }
                
                if (!match || !match[1]) {
                    await bot.sendMessage(chatId, 
                        `FORMAT /cek\n\n` +
                        `Gunakan: /cek ID_USER ID_SERVER\n` +
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
                
                const credits = getUserCredits(userId);
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
                
                // SET PROCESSING
                userProcessing[userId] = true;
                
                const loadingMsg = await bot.sendMessage(chatId, 'Mengambil data detail... (45 detik)');
                
                try {
                    const data = await getMLBBData(targetId, serverId, 'lookup');
                    
                    if (!data) {
                        await bot.editMessageText('GAGAL MENGAMBIL DATA', {
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
                    // HAPUS PROCESSING
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

        // ================== COMMAND /find ==================
        bot.onText(/\/find(?:\s+(.+))?/i, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                
                // ANTI DOUBLE CHAT
                if (userProcessing[userId]) {
                    await bot.sendMessage(chatId, 'Permintaan Anda sedang diproses. Silakan tunggu.');
                    return;
                }
                
                if (!match || !match[1]) {
                    await bot.sendMessage(msg.chat.id,
                        `FIND PLAYER\n\n` +
                        `Cari akun MLBB berdasarkan:\n` +
                        `1. NICKNAME - Cari via nickname\n` +
                        `2. ROLE ID - Cek detail via ID user\n\n` +
                        `Format:\n` +
                        `• Via Nickname: /find NICKNAME\n` +
                        `  Contoh: /find RRQ Jule\n\n` +
                        `• Via Role ID: /find ID\n` +
                        `  Contoh: /find 643461181\n\n` +
                        `Biaya: Rp 5.000\n` +
                        `Waktu pencarian: ±45 detik`
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
                
                const credits = getUserCredits(userId);
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
                
                // SET PROCESSING
                userProcessing[userId] = true;
                
                const loadingMsg = await bot.sendMessage(chatId, 'Mencari data... (maksimal 45 detik)');
                
                try {
                    let results = null;
                    let isRoleIdSearch = false;
                    let searchSuccess = false;
                    
                    if (/^\d+$/.test(input)) {
                        isRoleIdSearch = true;
                        results = await getPlayerByRoleId(input);
                    } else {
                        results = await findPlayerByName(input);
                    }
                    
                    if (results && results.length > 0) {
                        searchSuccess = true;
                    }
                    
                    if (!searchSuccess || !results) {
                        await bot.editMessageText('Gagal mengambil data. Saldo Anda tidak terpotong.', {
                            chat_id: chatId,
                            message_id: loadingMsg.message_id
                        });
                        return;
                    }
                    
                    if (!isAdmin(userId)) {
                        db.users[userId].credits -= 5000;
                        await saveDB();
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
                    // HAPUS PROCESSING
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

        // ================== COMMAND /ranking ==================
        bot.onText(/\/ranking/, async (msg) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                const sortedUsers = Object.entries(db.users || {})
                    .filter(([_, data]) => data.success > 0)
                    .sort((a, b) => b[1].success - a[1].success)
                    .slice(0, 10);
                
                let message = `PERINGKAT PENGGUNA (TOP 10)\n\n`;
                
                if (sortedUsers.length === 0) {
                    message += 'Belum ada data penggunaan.';
                } else {
                    sortedUsers.forEach(([id, data], i) => {
                        const rank = i + 1;
                        const username = data.username || 'tanpa username';
                        message += `${rank}. ${username}\n`;
                        message += `   ID: ${id} | ${data.success} x /info\n`;
                        message += `   Saldo: Rp ${(data.credits || 0).toLocaleString()}\n\n`;
                    });
                    
                    message += `\nTotal penggunaan: ${db.total_success || 0} kali`;
                }
                
                await bot.sendMessage(msg.chat.id, message);
            } catch (error) {
                console.log('Error /ranking:', error.message);
            }
        });

        // ================== COMMAND /listtopup ==================
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
                        message += `Total ${usersWithBalance.length} user\n\n`;
                        
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

        // ================== COMMAND ADMIN ==================
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

        // ================== COMMAND /pesan ==================
        bot.onText(/\/pesan (.+)/, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                const adminId = msg.from.id;
                
                if (!isAdmin(adminId)) {
                    await bot.sendMessage(msg.chat.id, 'Fitur ini hanya untuk admin.');
                    return;
                }
                
                const announcementText = match[1].trim();
                
                if (announcementText.length > 1000) {
                    await bot.sendMessage(msg.chat.id, 'Pesan terlalu panjang! Maksimal 1000 karakter.');
                    return;
                }
                
                const confirmMsg = await bot.sendMessage(msg.chat.id,
                    `KONFIRMASI PENGUMUMAN\n\n` +
                    `Isi pesan:\n` +
                    `"${announcementText}"\n\n` +
                    `Akan dikirim ke ${Object.keys(db.users || {}).length} user.\n\n` +
                    `Yakin ingin mengirim?`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: 'KIRIM', callback_data: `confirm_announce_${Date.now()}` },
                                    { text: 'BATAL', callback_data: 'cancel_announce' }
                                ]
                            ]
                        }
                    }
                );
                
                tempAnnouncement = {
                    adminId: adminId,
                    text: announcementText,
                    confirmMsgId: confirmMsg.message_id,
                    timestamp: Date.now()
                };
                
            } catch (error) {
                console.log('Error /pesan:', error.message);
            }
        });

        // ================== CALLBACK QUERY HANDLER ==================
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
                    
                    const payment = await createPakasirTopup(amount, userId);
                    
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

                if (data === 'cancel_announce') {
                    await bot.deleteMessage(chatId, messageId);
                    await bot.answerCallbackQuery(cb.id, { text: 'Pengumuman dibatalkan' });
                    tempAnnouncement = null;
                    return;
                }
                
                if (data.startsWith('confirm_announce_')) {
                    await bot.answerCallbackQuery(cb.id, { text: 'Mengirim pengumuman...' });
                    
                    if (!tempAnnouncement) {
                        await bot.editMessageText('Sesi pengumuman telah kedaluwarsa.', {
                            chat_id: chatId,
                            message_id: messageId
                        });
                        return;
                    }
                    
                    await bot.editMessageText('Mengirim pengumuman ke semua user...', {
                        chat_id: chatId,
                        message_id: messageId
                    });
                    
                    const userIds = Object.keys(db.users || {});
                    let sentCount = 0;
                    let failedCount = 0;
                    
                    for (const uid of userIds) {
                        try {
                            await bot.sendMessage(parseInt(uid),
                                `PENGUMUMAN PENTING\n\n` +
                                `${tempAnnouncement.text}\n\n` +
                                `Pesan ini dikirim otomatis oleh admin.`
                            );
                            sentCount++;
                            
                            await new Promise(resolve => setTimeout(resolve, 50));
                            
                        } catch (error) {
                            console.log(`Gagal kirim ke user ${uid}:`, error.message);
                            failedCount++;
                        }
                    }
                    
                    await bot.editMessageText(
                        `PENGUMUMAN TERKIRIM\n\n` +
                        `Isi pesan:\n` +
                        `"${tempAnnouncement.text}"\n\n` +
                        `Total user: ${userIds.length}\n` +
                        `Berhasil: ${sentCount}\n` +
                        `Gagal: ${failedCount}`,
                        {
                            chat_id: chatId,
                            message_id: messageId
                        }
                    );
                    
                    tempAnnouncement = null;
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

        // ================== FUNGSI EDIT MESSAGE ==================
        async function editToMainMenu(bot, chatId, messageId, userId) {
            try {
                await loadDB();
                
                const credits = getUserCredits(userId);
                
                let message = `MENU UTAMA\n\n`;
                message += `User ID: ${userId}\n`;
                message += `Saldo: Rp ${credits.toLocaleString()}\n\n`;
                message += `DAFTAR PERINTAH:\n`;
                message += `/info ID SERVER - Info platform (GRATIS)\n`;
                message += `/cek ID SERVER - Full info (Rp 5.000)\n`;
                message += `/find NICKNAME/ID - Cari akun (Rp 5.000)\n`;
                
                if (isAdmin(userId)) {
                    message += `\nADMIN MENU\n`;
                    message += `/ranking - Top 10 user\n`;
                    message += `/listtopup - Daftar saldo > 0\n`;
                    message += `/listbanned - Daftar banned\n`;
                    message += `/addban ID - Blokir user\n`;
                    message += `/unban ID - Buka blokir\n`;
                    message += `/addtopup ID JUMLAH - Tambah saldo\n`;
                    message += `/pesan TEKS - Kirim pengumuman\n`;
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
