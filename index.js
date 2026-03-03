const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const moment = require('moment-timezone');
const cron = require('node-cron');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const Redis = require('ioredis');

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
const API_KEY_CHECKTON = process.env.API_KEY_CHECKTON;
const CHANNEL = process.env.CHANNEL;
const GROUP = process.env.GROUP;
const STOK_ADMIN = process.env.STOK_ADMIN;
const REDIS_URL = process.env.REDIS_URL;

const ADMIN_IDS = process.env.ADMIN_IDS 
    ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) 
    : [];

// ================== FUNGSI FORMAT LOKASI ==================
function formatLocations(locations, maxItems = 5) {
    try {
        if (!locations || locations === 'N/A' || locations.length === 0) {
            return '';
        }
        
        if (!Array.isArray(locations)) {
            return '';
        }
        
        const limitedLocations = locations.slice(0, maxItems);
        let result = limitedLocations.join(', ');
        
        if (locations.length > maxItems) {
            result += `, +${locations.length - maxItems} lagi`;
        }
        
        return result;
    } catch (error) {
        return '';
    }
}

// ================== FUNGSI SALDO ==================
function getUserCredits(userId) {
    try {
        if (!db.users[userId]) {
            db.users[userId] = { username: '', find_count: 0, credits: 0, topup_history: [] };
        }
        return db.users[userId].credits || 0;
    } catch (error) {
        return 0;
    }
}

async function addCredits(userId, amount, orderId = null) {
    try {
        if (!db.users[userId]) {
            db.users[userId] = { username: '', find_count: 0, credits: 0, topup_history: [] };
        }
        db.users[userId].credits = (db.users[userId].credits || 0) + amount;
        
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

// ================== DATABASE POSTGRES ==================
let db = { 
    users: {}, 
    total_find: 0, 
    feature: { info: true }, 
    pending_topups: {} 
};
let spamData = {};

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ================== REDIS CLIENT ==================
let redis;
if (REDIS_URL) {
    try {
        redis = new Redis(REDIS_URL, {
            maxRetriesPerRequest: 3,
            retryStrategy: (times) => {
                if (times > 3) {
                    console.log('Redis connection failed after 3 retries');
                    return null;
                }
                return Math.min(times * 100, 3000);
            }
        });
        
        redis.on('connect', () => console.log('Redis connected'));
        redis.on('error', (err) => console.log('Redis error:', err.message));
    } catch (error) {
        console.log('Redis init error:', error.message);
        redis = null;
    }
} else {
    console.log('REDIS_URL not set, running without Redis');
    redis = null;
}

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
        const res = await pool.query('SELECT value FROM bot_data WHERE key = $1', ['database']);
        if (res.rows.length > 0) {
            db = res.rows[0].value;
            console.log('Load database dari Postgres');
        } else {
            console.log('Database kosong, pakai default');
        }
    } catch (error) {
        console.log('Gagal load database:', error.message);
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
    } catch (error) {
        console.log('Gagal save database:', error.message);
        try {
            fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
        } catch (e) {}
    }
}

async function loadSpamData() {
    try {
        const res = await pool.query('SELECT value FROM bot_data WHERE key = $1', ['spam']);
        if (res.rows.length > 0) {
            spamData = res.rows[0].value;
            console.log('Load spam data dari Postgres');
        } else {
            console.log('Database spam kosong, pakai default');
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

// ================== FUNGSI UTILITY ==================
function isAdmin(userId) { 
    try {
        return ADMIN_IDS.includes(userId); 
    } catch {
        return false;
    }
}

function formatRupiah(amount) {
    try {
        return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(amount);
    } catch {
        return 'Rp ' + amount;
    }
}

// ================== ANTI-SPAM ==================
function isBanned(userId) { 
    try {
        return spamData[userId]?.banned === true; 
    } catch {
        return false;
    }
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
    } catch {
        return false;
    }
}

async function addBan(userId, reason = 'Ban manual oleh admin') {
    try {
        const now = Date.now();
        spamData[userId] = { banned: true, bannedAt: now, banReason: reason, infoCount: [] };
        await saveSpamData();
        return true;
    } catch {
        return false;
    }
}

// ================== FUNGSI GET DATA MLBB UNTUK CEK ==================
async function getCekData(userId, serverId) {
    try {
        console.log(`Ambil data cek untuk ${userId} server ${serverId}`);
        
        const response = await axios.post("https://checkton.online/backend/info", {
            role_id: String(userId),
            zone_id: String(serverId),
            type: "lookup"
        }, {
            headers: { 
                "Content-Type": "application/json", 
                "x-api-key": API_KEY_CHECKTON 
            },
            timeout: 25000
        });
        
        console.log(`Cek response status: ${response.status}`);
        
        if (response.data?.data) {
            return response.data.data;
        }
        
        return null;
    } catch (error) {
        console.log('Error getCekData:', error.message);
        return null;
    }
}

// ================== FUNGSI UNTUK /find ==================
async function findPlayerByName(name) {
    try {
        console.log(`Mencari player dengan nama: ${name}`);
        
        const response = await axios.post("https://checkton.online/backend/info", {
            name: name,
            type: "find"
        }, {
            headers: { 
                "Content-Type": "application/json", 
                "x-api-key": API_KEY_CHECKTON 
            },
            timeout: 25000
        });
        
        console.log(`Find response status: ${response.status}`);
        
        if (response.data && response.data.status === 0) {
            console.log(`Ditemukan ${response.data.data?.length || 0} hasil`);
            return response.data.data;
        } else {
            console.log('Response:', response.data);
            return null;
        }
    } catch (error) {
        console.log('Error findPlayerByName:', error.message);
        if (error.response) {
            console.log('Detail error:', error.response.data);
        }
        return null;
    }
}

// ================== PAKASIR API UNTUK TOPUP ==================
async function createPakasirTopup(amount, userId) {
    try {
        const orderId = `TOPUP-${userId}-${Date.now()}`;
        console.log(`Membuat topup: ${orderId}, amount: ${amount}, user: ${userId}`);
        
        const response = await axios.post(
            `${process.env.PAKASIR_BASE_URL || 'https://app.pakasir.com/api'}/transactioncreate/qris`,
            { project: process.env.PAKASIR_SLUG || 'ncusspayment', order_id: orderId, amount, api_key: process.env.PAKASIR_API_KEY },
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
            
            console.log(`Topup pending saved: ${orderId} untuk user ${userId}`);
            
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
            { params: { project: process.env.PAKASIR_SLUG || 'ncusspayment', order_id: orderId, amount, api_key: process.env.PAKASIR_API_KEY }, timeout: 10000 }
        );
        return response.data?.transaction?.status || 'pending';
    } catch {
        return 'pending';
    }
}

// ================== EXPRESS SERVER (WEB) ==================
if (!IS_WORKER) {
    const app = express();
    const PORT = process.env.PORT || 3000;
    app.use(express.json());

    app.get('/', (req, res) => res.send('MLBB API Server is running'));

    app.post('/webhook/pakasir', (req, res) => {
        res.status(200).json({ status: 'ok' });
        
        setImmediate(async () => {
            try {
                const body = req.body;
                console.log('WEBHOOK PAKASIR:', JSON.stringify(body));
                
                const { order_id, status, amount } = body;
                
                if (!order_id || !status) return;
                
                await loadDB();
                await loadSpamData();
                
                if (status === 'completed' || status === 'paid') {
                    console.log(`Pembayaran sukses: ${order_id}`);
                    
                    if (order_id.startsWith('TOPUP-')) {
                        const topupData = db.pending_topups?.[order_id];
                        if (topupData && !topupData.processed) {
                            await processTopupSuccess(order_id, amount);
                        }
                    }
                }
            } catch (error) {
                console.log('Error proses webhook:', error.message);
            }
        });
    });

    async function processTopupSuccess(orderId, amount) {
        const data = db.pending_topups?.[orderId];
        if (!data) return;
        
        const userId = data.userId;
        await addCredits(userId, amount, orderId);
        
        db.pending_topups[orderId].status = 'paid';
        db.pending_topups[orderId].notified = true;
        db.pending_topups[orderId].processed = true;
        await saveDB();
        
        if (data.messageId && data.chatId) {
            try {
                const bot = new TelegramBot(BOT_TOKEN);
                await bot.deleteMessage(data.chatId, data.messageId);
            } catch (e) {}
        }
        
        try {
            const bot = new TelegramBot(BOT_TOKEN);
            await bot.sendMessage(userId,
                `TOP UP BERHASIL\n\n` +
                `Nominal: Rp ${amount.toLocaleString()}\n` +
                `Saldo bertambah: Rp ${amount.toLocaleString()}\n` +
                `Saldo sekarang: Rp ${getUserCredits(userId).toLocaleString()}`
            );
        } catch (e) {}
    }

    app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));
} 
// ================== BOT TELEGRAM (WORKER) ==================
else {
    console.log('Bot worker started');
    
    try {
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

        async function checkJoin(userId) {
            try {
                let isChannelMember = false, isGroupMember = false;
                try {
                    const channelCheck = await bot.getChatMember(CHANNEL, userId);
                    isChannelMember = ['member', 'administrator', 'creator'].includes(channelCheck.status);
                } catch (channelError) {
                    console.log(`Channel ${CHANNEL} error:`, channelError.message);
                }
                try {
                    const groupCheck = await bot.getChatMember(GROUP, userId);
                    isGroupMember = ['member', 'administrator', 'creator'].includes(groupCheck.status);
                } catch (groupError) {
                    console.log(`Group ${GROUP} error:`, groupError.message);
                }
                return { channel: isChannelMember, group: isGroupMember };
            } catch (error) {
                console.log('checkJoin error:', error.message);
                return { channel: false, group: false };
            }
        }

        // ================== MIDDLEWARE ==================
        bot.on('message', async (msg) => {
            try {
                const chatId = msg.chat.id, userId = msg.from.id, text = msg.text, chatType = msg.chat.type;
                
                if (!text) return;
                if (chatType !== 'private') return;
                if (isAdmin(userId)) return;
                
                const publicCommands = ['/start', '/offinfo', '/oninfo', '/ranking', '/listbanned', '/listtopup', '/addban', '/unban', '/addtopup', '/find', '/cek', '/info'];
                if (publicCommands.includes(text.split(' ')[0])) return;
            } catch (error) {
                console.log('Middleware error:', error.message);
            }
        });

        // ================== COMMAND /start ==================
        bot.onText(/\/start/, async (msg) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                const userId = msg.from.id;
                const credits = getUserCredits(userId);
                
                let message = `SELAMAT DATANG DI BOT NCUS\n\n`;
                message += `User ID: ${userId}\n`;
                message += `Saldo: Rp ${credits.toLocaleString()}\n\n`;
                message += `DAFTAR PERINTAH:\n`;
                message += `/info - Informasi cara penggunaan\n`;
                message += `/find NICKNAME - Cari akun via nickname Rp 5.000\n`;
                message += `/cek ID SERVER - Cek detail akun Rp 5.000\n\n`;
                
                if (isAdmin(userId)) {
                    message += `ADMIN:\n`;
                    message += `/offinfo - Nonaktifkan fitur\n`;
                    message += `/oninfo - Aktifkan fitur\n`;
                    message += `/ranking - Peringkat user\n`;
                    message += `/listbanned - Daftar banned\n`;
                    message += `/listtopup - Riwayat topup\n`;
                    message += `/addban ID - Blokir user\n`;
                    message += `/unban ID - Buka blokir\n`;
                    message += `/addtopup ID JUMLAH - Tambah saldo user\n`;
                }
                
                const replyMarkup = {
                    inline_keyboard: [
                        [
                            { text: 'TOP UP', callback_data: 'topup_menu' }
                        ]
                    ]
                };
                
                await bot.sendMessage(msg.chat.id, message, { reply_markup: replyMarkup });
            } catch (error) {
                console.log('Error /start:', error.message);
            }
        });

        // ================== COMMAND /info ==================
        bot.onText(/\/info/, async (msg) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                const message = 
                    `INFORMASI PENGGUNAAN\n\n` +
                    `Format: /info ID_USER ID_SERVER\n` +
                    `Contoh: /info 643461181 8554\n\n` +
                    `Fitur ini GRATIS dan hanya menampilkan panduan penggunaan.`;
                
                await bot.sendMessage(msg.chat.id, message);
                
            } catch (error) {
                console.log('Error /info:', error.message);
            }
        });

        // ================== COMMAND /find ==================
        bot.onText(/\/find(?:\s+(.+))?/i, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                if (!match || !match[1]) {
                    await bot.sendMessage(msg.chat.id,
                        `FIND PLAYER\n\n` +
                        `Format: /find NICKNAME\n` +
                        `Contoh: /find RRQ Jule\n\n` +
                        `Biaya: Rp 5.000`
                    );
                    return;
                }
                
                const chatId = msg.chat.id, userId = msg.from.id, username = msg.from.username;
                const searchName = match[1].trim();
                
                if (isBanned(userId) && !isAdmin(userId)) return;
                
                if (!username && !isAdmin(userId)) {
                    await bot.sendMessage(chatId, `USERNAME DIPERLUKAN\n\nCara membuat username:\n1. Buka Settings\n2. Pilih Username\n3. Buat username baru\n4. Simpan`);
                    return;
                }
                
                if (!db.feature.info && !isAdmin(userId)) {
                    await bot.sendMessage(chatId, `FITUR SEDANG NONAKTIF`);
                    return;
                }
                
                const joined = await checkJoin(userId);
                const missing = [];
                if (!joined.channel) missing.push(CHANNEL);
                if (!joined.group) missing.push(GROUP);

                if (missing.length > 0 && !isAdmin(userId)) {
                    const buttons = missing.map(ch => [{
                        text: `Bergabung ke ${ch.replace('@', '')}`,
                        url: `https://t.me/${ch.replace('@', '')}`
                    }]);
                    await bot.sendMessage(chatId, `AKSES TERBATAS\n\nAnda perlu bergabung dengan:\n` + missing.map(ch => `• ${ch}`).join('\n'), { reply_markup: { inline_keyboard: buttons } });
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
                if (banned) return;
                
                const loadingMsg = await bot.sendMessage(chatId, 'Mencari data...');
                
                const results = await findPlayerByName(searchName);
                
                await bot.deleteMessage(chatId, loadingMsg.message_id);
                
                if (!results || results.length === 0) {
                    await bot.sendMessage(chatId, `Tidak ada akun ditemukan dengan nama "${searchName}"`);
                    return;
                }
                
                if (!isAdmin(userId)) {
                    db.users[userId].credits -= 5000;
                    db.users[userId].find_count = (db.users[userId].find_count || 0) + 1;
                    db.total_find += 1;
                    await saveDB();
                }
                
                let output = `HASIL PENCARIAN: ${searchName}\n\n`;
                output += `Ditemukan ${results.length} akun:\n\n`;
                
                results.forEach((item, index) => {
                    output += `[${index + 1}] ${item.name}\n`;
                    output += `ID: ${item.role_id} | Server: ${item.zone_id}\n`;
                    output += `Level: ${item.level}\n`;
                    output += `Last Login: ${item.last_login}\n`;
                    
                    const locations = formatLocations(item.locations_logged, 5);
                    if (locations) {
                        output += `Lokasi: ${locations}\n`;
                    }
                    
                    output += `--------------------\n`;
                });
                
                output += `\nSisa saldo: Rp ${getUserCredits(userId).toLocaleString()}`;
                
                await bot.sendMessage(chatId, output);
                
            } catch (error) {
                console.log('Error /find:', error.message);
                try {
                    await bot.deleteMessage(msg.chat.id, loadingMsg?.message_id);
                } catch {}
                await bot.sendMessage(msg.chat.id, `Gagal mengambil data.`);
            }
        });

        // ================== COMMAND /cek ==================
        bot.onText(/\/cek(?:\s+(.+))?/i, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                if (!match || !match[1]) {
                    await bot.sendMessage(msg.chat.id,
                        `CEK DETAIL AKUN\n\n` +
                        `Format: /cek ID_USER ID_SERVER\n` +
                        `Contoh: /cek 12345678 1234\n\n` +
                        `Biaya: Rp 5.000`
                    );
                    return;
                }
                
                const chatId = msg.chat.id, userId = msg.from.id, username = msg.from.username;
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
                
                if (isBanned(userId) && !isAdmin(userId)) return;
                
                if (!username && !isAdmin(userId)) {
                    await bot.sendMessage(chatId, `USERNAME DIPERLUKAN\n\nCara membuat username:\n1. Buka Settings\n2. Pilih Username\n3. Buat username baru\n4. Simpan`);
                    return;
                }
                
                if (!db.feature.info && !isAdmin(userId)) {
                    await bot.sendMessage(chatId, `FITUR SEDANG NONAKTIF`);
                    return;
                }
                
                const joined = await checkJoin(userId);
                const missing = [];
                if (!joined.channel) missing.push(CHANNEL);
                if (!joined.group) missing.push(GROUP);

                if (missing.length > 0 && !isAdmin(userId)) {
                    const buttons = missing.map(ch => [{
                        text: `Bergabung ke ${ch.replace('@', '')}`,
                        url: `https://t.me/${ch.replace('@', '')}`
                    }]);
                    await bot.sendMessage(chatId, `AKSES TERBATAS\n\nAnda perlu bergabung dengan:\n` + missing.map(ch => `• ${ch}`).join('\n'), { reply_markup: { inline_keyboard: buttons } });
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
                
                const banned = await recordInfoActivity(userId);
                if (banned) return;
                
                const loadingMsg = await bot.sendMessage(chatId, 'Mengambil data...');
                
                const data = await getCekData(targetId, serverId);
                
                await bot.deleteMessage(chatId, loadingMsg.message_id);
                
                if (!data) {
                    await bot.sendMessage(chatId, `GAGAL MENGAMBIL DATA`);
                    return;
                }
                
                if (!isAdmin(userId)) {
                    db.users[userId].credits -= 5000;
                    db.users[userId].find_count = (db.users[userId].find_count || 0) + 1;
                    db.total_find += 1;
                    await saveDB();
                }

                const d = data;
                let output = `DETAIL AKUN\n\n`;
                output += `ID: ${d.role_id}\n`;
                output += `Server: ${d.zone_id}\n`;
                output += `Nickname: ${d.name}\n`;
                output += `Level: ${d.level}\n`;
                output += `TTL: ${d.ttl || '-'}\n\n`;
                
                output += `RANK & TIER\n`;
                output += `Current: ${d.current_tier}\n`;
                output += `Max: ${d.max_tier}\n`;
                output += `Achievement Points: ${d.achievement_points?.toLocaleString() || '-'}\n\n`;
                
                output += `KOLEKSI SKIN\n`;
                output += `Total: ${d.skin_count}\n`;
                output += `Supreme: ${d.supreme_skins || 0} | Grand: ${d.grand_skins || 0}\n`;
                output += `Exquisite: ${d.exquisite_skins || 0} | Deluxe: ${d.deluxe_skins || 0}\n`;
                output += `Exceptional: ${d.exceptional_skins || 0} | Common: ${d.common_skins || 0}\n\n`;
                
                if (d.top_3_hero_details && d.top_3_hero_details.length > 0) {
                    output += `TOP 3 HERO\n`;
                    d.top_3_hero_details.forEach((h, i) => {
                        output += `${i+1}. ${h.hero}\n`;
                        output += `   Matches: ${h.matches} | WR: ${h.win_rate}\n`;
                        output += `   Power: ${h.power}\n`;
                    });
                    output += `\n`;
                }
                
                output += `STATISTIK\n`;
                output += `Total Match: ${d.total_match_played?.toLocaleString()}\n`;
                output += `Win Rate: ${d.overall_win_rate}\n`;
                output += `KDA: ${d.kda}\n`;
                output += `MVP: ${d.total_mvp}\n`;
                output += `Savage: ${d.savage_kill} | Maniac: ${d.maniac_kill}\n`;
                output += `Legendary: ${d.legendary_kill}\n\n`;
                
                if (d.squad_name) {
                    output += `SQUAD\n`;
                    output += `Name: ${d.squad_name}\n`;
                    output += `Prefix: ${d.squad_prefix || '-'}\n`;
                    output += `ID: ${d.squad_id}\n\n`;
                }
                
                if (d.last_match_data) {
                    output += `LAST MATCH\n`;
                    output += `Hero: ${d.last_match_data.hero_name}\n`;
                    output += `K/D/A: ${d.last_match_data.kills}/${d.last_match_data.deaths}/${d.last_match_data.assists}\n`;
                    output += `Gold: ${d.last_match_data.gold?.toLocaleString()}\n`;
                    output += `Damage: ${d.last_match_data.hero_damage?.toLocaleString()}\n`;
                    output += `Duration: ${d.last_match_duration}\n`;
                    output += `Date: ${d.last_match_date}\n`;
                }

                output += `\nSisa saldo: Rp ${getUserCredits(userId).toLocaleString()}`;

                await bot.sendMessage(chatId, output, {
                    reply_markup: { 
                        inline_keyboard: [[{ text: 'Stok Admin', url: STOK_ADMIN }]] 
                    }
                });

            } catch (error) {
                console.log('Error /cek:', error.message);
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

                // ================== KEMBALI KE MENU ==================
                if (data === 'kembali_ke_menu') {
                    await editToMainMenu(chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                // ================== MENU TOPUP ==================
                if (data === 'topup_menu') {
                    await editToTopupMenu(chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                // ================== BATALKAN TOPUP ==================
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

                // ================== TOPUP ==================
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
                                `Saldo: Rp ${amount.toLocaleString()}\n\n` +
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
                            `Nominal: Rp ${amount.toLocaleString()}\n` +
                            `Saldo: Rp ${amount.toLocaleString()}\n\n` +
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

        // ================== FUNGSI EDIT MESSAGE ==================
        async function editToMainMenu(chatId, messageId, userId) {
            const credits = getUserCredits(userId);
            
            let message = `SELAMAT DATANG DI BOT NCUS\n\n`;
            message += `User ID: ${userId}\n`;
            message += `Saldo: Rp ${credits.toLocaleString()}\n\n`;
            message += `DAFTAR PERINTAH:\n`;
            message += `/info - Informasi cara penggunaan\n`;
            message += `/find NICKNAME - Cari akun via nickname Rp 5.000\n`;
            message += `/cek ID SERVER - Cek detail akun Rp 5.000\n\n`;
            
            if (isAdmin(userId)) {
                message += `ADMIN:\n`;
                message += `/offinfo - Nonaktifkan fitur\n`;
                message += `/oninfo - Aktifkan fitur\n`;
                message += `/ranking - Peringkat user\n`;
                message += `/listbanned - Daftar banned\n`;
                message += `/listtopup - Riwayat topup\n`;
                message += `/addban ID - Blokir user\n`;
                message += `/unban ID - Buka blokir\n`;
                message += `/addtopup ID JUMLAH - Tambah saldo user\n`;
            }
            
            const replyMarkup = {
                inline_keyboard: [
                    [
                        { text: 'TOP UP', callback_data: 'topup_menu' }
                    ]
                ]
            };
            
            await bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: replyMarkup
            });
        }

        async function editToTopupMenu(chatId, messageId, userId) {
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
        }

        // ================== AUTO CHECK PAYMENT (CRON JOB) ==================
        cron.schedule('* * * * *', async () => {
            try {
                console.log('Cron job berjalan (backup mode)');
                
                for (const [orderId, data] of Object.entries(db.pending_topups || {})) {
                    if (data.status === 'pending') {
                        const status = await checkPakasirTransaction(orderId, data.amount);
                        
                        if (status === 'completed' || status === 'paid') {
                            console.log(`Cron job: Topup sukses ${orderId}`);
                            
                            if (data.processed) {
                                console.log(`Order ${orderId} sudah diproses, lewati`);
                                continue;
                            }
                            
                            const userId = data.userId;
                            const amount = data.amount;
                            
                            await addCredits(userId, amount, orderId);
                            
                            db.pending_topups[orderId].status = 'paid';
                            db.pending_topups[orderId].processed = true;
                            db.pending_topups[orderId].notified = true;
                            await saveDB();
                            
                            if (data.messageId && data.chatId) {
                                try { await bot.deleteMessage(data.chatId, data.messageId); } catch {}
                            }
                            
                            console.log(`Lewati notifikasi (webhook lebih cepat)`);
                        }
                    }
                }
            } catch (error) {
                console.log('Error cron:', error.message);
            }
        });

        // ================== RELOAD DATABASE PERIODIK ==================
        setInterval(async () => {
            try {
                await loadDB();
                await loadSpamData();
                console.log('Database reloaded from Postgres');
            } catch (error) {
                console.log('Error reloading database:', error.message);
            }
        }, 5000);

        // ================== ADMIN COMMANDS ==================
        bot.onText(/\/offinfo/, async (msg) => { 
            try {
                if (msg.chat.type !== 'private') return;
                if (isAdmin(msg.from.id)) { 
                    db.feature.info = false; 
                    await saveDB(); 
                    bot.sendMessage(msg.chat.id, 'Fitur info dinonaktifkan.'); 
                } 
            } catch (error) {}
        });

        bot.onText(/\/oninfo/, async (msg) => { 
            try {
                if (msg.chat.type !== 'private') return;
                if (isAdmin(msg.from.id)) { 
                    db.feature.info = true; 
                    await saveDB(); 
                    bot.sendMessage(msg.chat.id, 'Fitur info diaktifkan.'); 
                } 
            } catch (error) {}
        });

        bot.onText(/\/ranking/, async (msg) => {
            try {
                if (msg.chat.type !== 'private') return;
                if (!isAdmin(msg.from.id)) return;
                const users = Object.entries(db.users || {})
                    .sort((a,b) => (b[1].find_count || 0) - (a[1].find_count || 0))
                    .slice(0,10);
                let message = 'PERINGKAT PENGGUNA\n\n';
                users.forEach(([id,data],i) => message += `${i+1}. ${data.username || 'unknown'} - ${data.find_count || 0}x\n`);
                await bot.sendMessage(msg.chat.id, message || 'Belum ada data');
            } catch (error) {}
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
                        message += `${i+1}. ${id}\n`;
                        message += `   Alasan: ${d.banReason || 'Tidak ada'}\n`;
                        message += `   Tanggal: ${date} WIB\n\n`;
                    });
                }
                
                await bot.sendMessage(msg.chat.id, message);
            } catch (error) {
                console.log('Error /listbanned:', error.message);
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
                    let message = 'DAFTAR USER YANG PERNAH TOPUP\n\n';
                    const usersWithTopup = Object.entries(db.users || {})
                        .filter(([_, u]) => u.topup_history && u.topup_history.length > 0)
                        .sort((a, b) => b[1].topup_history.length - a[1].topup_history.length);
                    
                    if (usersWithTopup.length === 0) {
                        message += 'Belum ada user yang topup.';
                    } else {
                        usersWithTopup.forEach(([id, u], i) => {
                            const totalTopup = u.topup_history.reduce((sum, item) => sum + item.amount, 0);
                            message += `${i+1}. ${id}\n`;
                            message += `   Total topup: Rp ${totalTopup.toLocaleString()} (${u.topup_history.length}x)\n`;
                            message += `   Saldo: Rp ${(u.credits || 0).toLocaleString()}\n\n`;
                        });
                    }
                    
                    await bot.sendMessage(msg.chat.id, message);
                }
            } catch (error) {
                console.log('Error /listtopup:', error.message);
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
                    await bot.sendMessage(msg.chat.id, 'Jumlah harus 1-1.000.000 credits.');
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

        console.log('Bot started, Admin IDs:', ADMIN_IDS);
        
    } catch (error) {
        console.log('FATAL ERROR:', error.message);
    }
}
