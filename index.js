const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const moment = require('moment-timezone');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const cron = require('node-cron');

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
const API_KEY_CHECKTON = process.env.API_KEY_CHECKTON;

const ADMIN_IDS = process.env.ADMIN_IDS 
    ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) 
    : [];

// ================== DATABASE POSTGRES ==================
let db = { 
    users: {}, 
    total_success: 0, 
    feature: { info: true }, 
    pending_topups: {},
    pending_requests: {} 
};
let spamData = {};

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

// ================== FUNGSI UTILITY ==================
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
            saveDB().catch(err => {});
        } else if (username && db.users[userId].username !== username) {
            db.users[userId].username = username;
            saveDB().catch(err => {});
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
            db.users[userId] = { username: '', success: 0, credits: 0, topup_history: [] };
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

async function checkJoin(bot, userId) {
    try {
        let isChannelMember = false, isGroupMember = false;
        if (CHANNEL) {
            try {
                const channelCheck = await bot.getChatMember(CHANNEL, userId);
                isChannelMember = ['member', 'administrator', 'creator'].includes(channelCheck.status);
            } catch (e) { isChannelMember = false; }
        } else { isChannelMember = true; }
        
        if (GROUP) {
            try {
                const groupCheck = await bot.getChatMember(GROUP, userId);
                isGroupMember = ['member', 'administrator', 'creator'].includes(groupCheck.status);
            } catch (e) { isGroupMember = false; }
        } else { isGroupMember = true; }
        
        return { channel: isChannelMember, group: isGroupMember };
    } catch (error) {
        return { channel: false, group: false };
    }
}

// ================== FUNGSI GET DATA MLBB ==================
async function getMLBBData(userId, serverId, type = 'lookup') {
    try {
        const payload = {
            role_id: String(userId).trim(),
            zone_id: String(serverId).trim(),
            type: type
        };
        const response = await axios.post("https://checkton.online/backend/info", payload, {
            headers: { "Content-Type": "application/json", "x-api-key": API_KEY_CHECKTON },
            timeout: 45000
        });
        if (response.data) {
            if (response.data.data && response.data.data.role_id) return response.data.data;
            if (response.data.role_id) return response.data;
        }
        return null;
    } catch (error) {
        console.log('Error getMLBBData:', error.message);
        return null;
    }
}

async function findPlayerByName(name) {
    try {
        const payload = { name: String(name).trim(), type: "find" };
        const response = await axios.post("https://checkton.online/backend/info", payload, {
            headers: { "Content-Type": "application/json", "x-api-key": API_KEY_CHECKTON },
            timeout: 45000
        });
        if (response.data) {
            if (response.data.status === 0 && response.data.data) return response.data.data;
            if (Array.isArray(response.data)) return response.data;
            if (response.data.role_id) return [response.data];
        }
        return null;
    } catch (error) {
        console.log('Error findPlayerByName:', error.message);
        return null;
    }
}

async function getPlayerByRoleId(roleId) {
    try {
        const payload = { role_id: String(roleId).trim(), type: "find" };
        const response = await axios.post("https://checkton.online/backend/info", payload, {
            headers: { "Content-Type": "application/json", "x-api-key": API_KEY_CHECKTON },
            timeout: 45000
        });
        if (response.data) {
            if (response.data.status === 0 && response.data.data) return response.data.data;
            if (Array.isArray(response.data)) return response.data;
            if (response.data.role_id) return [response.data];
        }
        return null;
    } catch (error) {
        console.log('Error getPlayerByRoleId:', error.message);
        return null;
    }
}

function formatLocations(locations, maxItems = 5) {
    try {
        if (!locations || !Array.isArray(locations) || locations.length === 0) return '';
        const limited = locations.slice(0, maxItems);
        let result = limited.join(', ');
        if (locations.length > maxItems) result += ', +' + (locations.length - maxItems) + ' lagi';
        return result;
    } catch (error) {
        return '';
    }
}

// ================== PAKASIR API ==================
async function createPakasirTopup(amount, userId, username = '') {
    try {
        const orderId = 'TOPUP-' + userId + '-' + Date.now();
        console.log('Membuat topup:', orderId, 'amount:', amount, 'user:', userId);
        
        if (!db.users[userId]) {
            db.users[userId] = { username: username, success: 0, credits: 0, topup_history: [] };
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
                amount: amount, 
                api_key: process.env.PAKASIR_API_KEY 
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        
        if (response.data && response.data.payment) {
            const payment = response.data.payment;
            const expiredAt = moment(payment.expired_at).tz('Asia/Jakarta');
            
            if (!db.pending_topups) db.pending_topups = {};
            
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
            (process.env.PAKASIR_BASE_URL || 'https://app.pakasir.com/api') + '/transactiondetail',
            { params: { project: process.env.PAKASIR_SLUG || 'ncusspayment', order_id: orderId, amount: amount, api_key: process.env.PAKASIR_API_KEY }, timeout: 10000 }
        );
        return response.data?.transaction?.status || 'pending';
    } catch {
        return 'pending';
    }
}

// ================== EXPRESS SERVER ==================
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

app.get('/', (req, res) => res.send('Bot is running'));

// Webhook Pakasir dengan auto delete realtime
app.post('/webhook/pakasir', async (req, res) => {
    try {
        console.log('WEBHOOK PAKASIR DITERIMA:', JSON.stringify(req.body));
        const { order_id, status, amount } = req.body;
        
        if ((status === 'paid' || status === 'success' || status === 'completed' || status === 'settlement') && order_id) {
            // Cari data pending
            const pending = db.pending_topups?.[order_id];
            if (pending) {
                // Hapus QRIS jika ada chatId dan messageId
                if (pending.chatId && pending.messageId && !pending.deleted) {
                    try {
                        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
                            chat_id: pending.chatId,
                            message_id: pending.messageId
                        });
                        console.log('QRIS dihapus via webhook untuk order', order_id);
                        pending.deleted = true;
                    } catch (deleteError) {
                        console.log('Gagal hapus QRIS via webhook:', deleteError.message);
                    }
                }
                
                // Update status
                pending.status = 'paid';
                pending.processed = true;
                pending.paid_at = Date.now();
                
                // Tambah saldo user
                const userId = pending.userId;
                if (userId && amount) {
                    await addCredits(userId, amount, order_id);
                    console.log('Saldo user', userId, 'bertambah', amount);
                    
                    // Kirim notifikasi ke user
                    try {
                        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                            chat_id: userId,
                            text: 'PEMBAYARAN BERHASIL\n\n' +
                                  'Terima kasih! Pembayaran Anda telah kami terima.\n\n' +
                                  'Detail Transaksi:\n' +
                                  'Order ID: ' + order_id + '\n' +
                                  'Jumlah: Rp ' + amount.toLocaleString() + '\n' +
                                  'Status: BERHASIL\n\n' +
                                  'Saldo Anda sekarang: Rp ' + (db.users[userId]?.credits || 0).toLocaleString()
                        });
                    } catch (notifError) {}
                }
                
                await saveDB();
            }
        }
        
        res.status(200).json({ status: 'ok' });
    } catch (error) {
        console.log('WEBHOOK PAKASIR ERROR:', error.message);
        res.status(200).json({ status: 'ok' });
    }
});

// ================== CRON JOB AUTO DELETE QRIS (FALLBACK) ==================
cron.schedule('* * * * *', async () => {
    try {
        console.log('Cron: Auto-delete QRIS berjalan...');
        await loadDB(); // ambil data terbaru
        const now = Date.now();
        const expiredTime = 15 * 60 * 1000; // 15 menit
        
        for (const [orderId, data] of Object.entries(db.pending_topups || {})) {
            // Hapus jika status paid dan belum dihapus
            if (data.status === 'paid' && data.chatId && data.messageId && !data.deleted) {
                try {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
                        chat_id: data.chatId,
                        message_id: data.messageId
                    });
                    console.log('Cron: QRIS dihapus (paid) untuk order', orderId);
                    data.deleted = true;
                } catch (e) {
                    console.log('Cron: Gagal hapus QRIS paid', orderId, e.message);
                }
            }
            
            // Hapus jika pending tapi sudah expired
            if (data.status === 'pending' && (now - data.created_at) > expiredTime) {
                if (data.chatId && data.messageId && !data.deleted) {
                    try {
                        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
                            chat_id: data.chatId,
                            message_id: data.messageId
                        });
                        console.log('Cron: QRIS expired dihapus untuk order', orderId);
                    } catch (e) {}
                }
                delete db.pending_topups[orderId];
                console.log('Cron: Data expired dihapus', orderId);
            }
        }
        await saveDB();
    } catch (error) {
        console.log('Cron auto-delete error:', error.message);
    }
});

// ================== BOT TELEGRAM (WORKER) ==================
if (IS_WORKER) {
    console.log('Bot worker started');
    try {
        const bot = new TelegramBot(BOT_TOKEN, { 
            polling: { interval: 300, autoStart: true, params: { timeout: 10 } } 
        });

        bot.on('polling_error', (error) => console.log('Polling error:', error.message));

        // Middleware
        bot.on('message', async (msg) => {
            try {
                if (msg.chat.type !== 'private') return;
                if (!msg.from.username && !isAdmin(msg.from.id)) {
                    await bot.sendMessage(msg.chat.id, 
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
            } catch (e) {}
        });

        // Command /start
        bot.onText(/\/start/, async (msg) => {
            try {
                if (msg.chat.type !== 'private') return;
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                const username = msg.from.username;
                
                if (!username && !isAdmin(userId)) {
                    await bot.sendMessage(chatId, 'Username diperlukan. Silakan set username di Telegram.');
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
                message += '/find NICKNAME/ID - Cari akun (Rp 5.000)\n\n';
                
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
                console.log('Error /start:', error.message);
            }
        });

        // Command /info (gratis)
        bot.onText(/\/info(?:\s+(.+))?/i, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                
                if (!match || !match[1]) {
                    await bot.sendMessage(chatId, 'Format: /info ID_USER ID_SERVER\nContoh: /info 643461181 8554');
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
                    if (!joined.channel) message += '- ' + CHANNEL + '\n';
                    if (!joined.group) message += '- ' + GROUP + '\n\n';
                    
                    const buttons = [];
                    if (!joined.channel) buttons.push([{ text: 'Bergabung ke Channel', url: 'https://t.me/' + CHANNEL.replace('@', '') }]);
                    if (!joined.group) buttons.push([{ text: 'Bergabung ke Group', url: 'https://t.me/' + GROUP.replace('@', '') }]);
                    
                    await bot.sendMessage(chatId, message, { reply_markup: { inline_keyboard: buttons } });
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
                
                const loadingMsg = await bot.sendMessage(chatId, 'Mengambil data...');
                const data = await getMLBBData(targetId, serverId, 'info'); // gunakan type info
                
                if (!data) {
                    await bot.editMessageText('Gagal mengambil data.', { chat_id: chatId, message_id: loadingMsg.message_id });
                    return;
                }
                
                let output = 'INFORMASI AKUN\n\n';
                output += 'ID: ' + (data.role_id || targetId) + '\n';
                output += 'Server: ' + (data.zone_id || serverId) + '\n';
                output += 'Nickname: ' + (data.name || '-') + '\n';
                output += 'Level: ' + (data.level || '-') + '\n';
                if (data.current_tier) output += 'Tier: ' + data.current_tier + '\n';
                if (data.skin_count) output += 'Total Skin: ' + data.skin_count + '\n';
                
                await bot.editMessageText(output, {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id,
                    reply_markup: { inline_keyboard: [[{ text: 'Stok Admin', url: STOK_ADMIN }]] }
                });
                
                // Update statistik user
                getUserCredits(userId, msg.from.username || '');
                db.users[userId].success += 1;
                db.total_success += 1;
                await saveDB();
                
            } catch (error) {
                console.log('Error /info:', error.message);
            }
        });

        // Command /cek (berbayar)
        bot.onText(/\/cek(?:\s+(.+))?/i, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                
                if (!match || !match[1]) {
                    await bot.sendMessage(chatId, 'Format: /cek ID_USER ID_SERVER\nContoh: /cek 643461181 8554\n\nBiaya: Rp 5.000');
                    return;
                }
                
                if (isBanned(userId) && !isAdmin(userId)) {
                    await bot.sendMessage(chatId, 'Anda telah diblokir. Hubungi admin.');
                    return;
                }
                
                const joined = await checkJoin(bot, userId);
                if ((!joined.channel || !joined.group) && !isAdmin(userId)) {
                    let message = 'AKSES DITOLAK\n\nAnda WAJIB bergabung dengan:\n';
                    if (!joined.channel) message += '- ' + CHANNEL + '\n';
                    if (!joined.group) message += '- ' + GROUP + '\n\n';
                    
                    const buttons = [];
                    if (!joined.channel) buttons.push([{ text: 'Bergabung ke Channel', url: 'https://t.me/' + CHANNEL.replace('@', '') }]);
                    if (!joined.group) buttons.push([{ text: 'Bergabung ke Group', url: 'https://t.me/' + GROUP.replace('@', '') }]);
                    
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
                
                const credits = getUserCredits(userId, msg.from.username || '');
                if (credits < 5000 && !isAdmin(userId)) {
                    await bot.sendMessage(chatId,
                        'SALDO TIDAK CUKUP\n\n' +
                        'Saldo Anda: Rp ' + credits.toLocaleString() + '\n' +
                        'Biaya /cek: Rp 5.000\n' +
                        'Kekurangan: Rp ' + (5000 - credits).toLocaleString() + '\n\n' +
                        'Silakan isi saldo terlebih dahulu:',
                        { reply_markup: { inline_keyboard: [[{ text: 'TOP UP', callback_data: 'topup_menu' }]] } }
                    );
                    return;
                }
                
                const loadingMsg = await bot.sendMessage(chatId, 'Mengambil data detail...');
                const data = await getMLBBData(targetId, serverId, 'lookup');
                
                if (!data) {
                    await bot.editMessageText('Gagal mengambil data. Saldo Anda tidak terpotong.', {
                        chat_id: chatId, message_id: loadingMsg.message_id
                    });
                    return;
                }
                
                // Potong saldo jika bukan admin
                if (!isAdmin(userId)) {
                    db.users[userId].credits -= 5000;
                    await saveDB();
                }
                
                let output = 'DETAIL AKUN\n\n';
                output += 'ID: ' + (data.role_id || targetId) + '\n';
                output += 'Server: ' + (data.zone_id || serverId) + '\n';
                output += 'Nickname: ' + (data.name || '-') + '\n';
                output += 'Level: ' + (data.level || '-') + '\n';
                output += 'TTL: ' + (data.ttl || '-') + '\n\n';
                
                output += 'RANK & TIER\n';
                output += 'Current: ' + (data.current_tier || '-') + '\n';
                output += 'Max: ' + (data.max_tier || '-') + '\n';
                output += 'Achievement Points: ' + (data.achievement_points?.toLocaleString() || '-') + '\n\n';
                
                output += 'KOLEKSI SKIN\n';
                output += 'Total: ' + (data.skin_count || 0) + '\n';
                output += 'Supreme: ' + (data.supreme_skins || 0) + ' | Grand: ' + (data.grand_skins || 0) + '\n';
                output += 'Exquisite: ' + (data.exquisite_skins || 0) + ' | Deluxe: ' + (data.deluxe_skins || 0) + '\n';
                output += 'Exceptional: ' + (data.exceptional_skins || 0) + ' | Common: ' + (data.common_skins || 0) + '\n\n';
                
                if (data.top_3_hero_details && data.top_3_hero_details.length > 0) {
                    output += 'TOP 3 HERO\n';
                    data.top_3_hero_details.forEach((h, i) => {
                        output += (i+1) + '. ' + (h.hero || '-') + '\n';
                        output += '   Matches: ' + (h.matches || 0) + ' | WR: ' + (h.win_rate || '0%') + '\n';
                        output += '   Power: ' + (h.power || 0) + '\n';
                    });
                    output += '\n';
                }
                
                output += 'STATISTIK\n';
                output += 'Total Match: ' + (data.total_match_played?.toLocaleString() || 0) + '\n';
                output += 'Win Rate: ' + (data.overall_win_rate || '0%') + '\n';
                output += 'KDA: ' + (data.kda || '-') + '\n';
                output += 'MVP: ' + (data.total_mvp || 0) + '\n';
                output += 'Savage: ' + (data.savage_kill || 0) + ' | Maniac: ' + (data.maniac_kill || 0) + '\n';
                output += 'Legendary: ' + (data.legendary_kill || 0) + '\n\n';
                
                if (data.squad_name) {
                    output += 'SQUAD\n';
                    output += 'Name: ' + data.squad_name + '\n';
                    output += 'Prefix: ' + (data.squad_prefix || '-') + '\n';
                    output += 'ID: ' + (data.squad_id || '-') + '\n\n';
                }
                
                if (data.last_match_data) {
                    output += 'LAST MATCH\n';
                    output += 'Hero: ' + (data.last_match_data.hero_name || '-') + '\n';
                    output += 'K/D/A: ' + (data.last_match_data.kills || 0) + '/' + (data.last_match_data.deaths || 0) + '/' + (data.last_match_data.assists || 0) + '\n';
                    output += 'Gold: ' + (data.last_match_data.gold?.toLocaleString() || 0) + '\n';
                    output += 'Damage: ' + (data.last_match_data.hero_damage?.toLocaleString() || 0) + '\n';
                    output += 'Duration: ' + (data.last_match_duration || '-') + '\n';
                    output += 'Date: ' + (data.last_match_date || '-') + '\n';
                }
                
                output += '\nSisa saldo: Rp ' + getUserCredits(userId).toLocaleString();
                
                await bot.editMessageText(output, {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id,
                    reply_markup: { inline_keyboard: [[{ text: 'Stok Admin', url: STOK_ADMIN }]] }
                });
                
            } catch (error) {
                console.log('Error /cek:', error.message);
            }
        });

        // Command /find
        bot.onText(/\/find(?:\s+(.+))?/i, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                
                if (!match || !match[1]) {
                    await bot.sendMessage(chatId,
                        'PENCARIAN AKUN\n\n' +
                        'Format:\n' +
                        '- Via Nickname: /find NICKNAME\n' +
                        '  Contoh: /find RRQ Jule\n\n' +
                        '- Via Role ID: /find ID\n' +
                        '  Contoh: /find 643461181\n\n' +
                        'Biaya: Rp 5.000'
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
                    let message = 'AKSES DITOLAK\n\nAnda WAJIB bergabung dengan:\n';
                    if (!joined.channel) message += '- ' + CHANNEL + '\n';
                    if (!joined.group) message += '- ' + GROUP + '\n\n';
                    
                    const buttons = [];
                    if (!joined.channel) buttons.push([{ text: 'Bergabung ke Channel', url: 'https://t.me/' + CHANNEL.replace('@', '') }]);
                    if (!joined.group) buttons.push([{ text: 'Bergabung ke Group', url: 'https://t.me/' + GROUP.replace('@', '') }]);
                    
                    await bot.sendMessage(chatId, message, { reply_markup: { inline_keyboard: buttons } });
                    return;
                }
                
                const credits = getUserCredits(userId, msg.from.username || '');
                if (credits < 5000 && !isAdmin(userId)) {
                    await bot.sendMessage(chatId,
                        'SALDO TIDAK CUKUP\n\n' +
                        'Saldo Anda: Rp ' + credits.toLocaleString() + '\n' +
                        'Biaya /find: Rp 5.000\n' +
                        'Kekurangan: Rp ' + (5000 - credits).toLocaleString() + '\n\n' +
                        'Silakan isi saldo terlebih dahulu:',
                        { reply_markup: { inline_keyboard: [[{ text: 'TOP UP', callback_data: 'topup_menu' }]] } }
                    );
                    return;
                }
                
                const banned = await recordInfoActivity(userId);
                if (banned) {
                    await bot.sendMessage(chatId, 'Anda telah dibanned karena spam.');
                    return;
                }
                
                const loadingMsg = await bot.sendMessage(chatId, 'Mencari data...');
                
                let results = null;
                let isRoleIdSearch = false;
                
                if (/^\d+$/.test(input)) {
                    isRoleIdSearch = true;
                    results = await getPlayerByRoleId(input);
                } else {
                    results = await findPlayerByName(input);
                }
                
                if (!results || results.length === 0) {
                    await bot.editMessageText('Gagal mengambil data. Saldo Anda tidak terpotong.', {
                        chat_id: chatId, message_id: loadingMsg.message_id
                    });
                    return;
                }
                
                if (!isAdmin(userId)) {
                    db.users[userId].credits -= 5000;
                    await saveDB();
                }
                
                let output = (isRoleIdSearch ? 'HASIL PENCARIAN ROLE ID: ' : 'HASIL PENCARIAN NICKNAME: ') + input + '\n\n';
                output += 'Ditemukan ' + results.length + ' akun:\n\n';
                
                results.forEach((item, index) => {
                    output += '[' + (index+1) + '] ' + (item.name || item.nickname || 'Unknown') + '\n';
                    output += 'ID: ' + (item.role_id || '-') + ' | Server: ' + (item.zone_id || '-') + '\n';
                    output += 'Level: ' + (item.level || '-') + '\n';
                    if (item.last_login) output += 'Last Login: ' + item.last_login + '\n';
                    if (item.locations_logged && Array.isArray(item.locations_logged)) {
                        const locs = formatLocations(item.locations_logged, 5);
                        if (locs) output += 'Lokasi: ' + locs + '\n';
                    }
                    output += '--------------------\n';
                });
                
                output += '\nSisa saldo: Rp ' + getUserCredits(userId).toLocaleString();
                
                await bot.editMessageText(output, {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id
                });
                
            } catch (error) {
                console.log('Error /find:', error.message);
            }
        });

        // ================== ADMIN COMMANDS ==================
        bot.onText(/\/offinfo/, async (msg) => {
            if (msg.chat.type !== 'private') return;
            if (!isAdmin(msg.from.id)) return;
            db.feature.info = false;
            await saveDB();
            bot.sendMessage(msg.chat.id, 'Fitur info dinonaktifkan.');
        });

        bot.onText(/\/oninfo/, async (msg) => {
            if (msg.chat.type !== 'private') return;
            if (!isAdmin(msg.from.id)) return;
            db.feature.info = true;
            await saveDB();
            bot.sendMessage(msg.chat.id, 'Fitur info diaktifkan.');
        });

        bot.onText(/\/listbanned/, async (msg) => {
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
        });

        bot.onText(/\/listtopup(?:\s+(\d+))?/, async (msg, match) => {
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
                message += 'Saldo saat ini: Rp ' + (user.credits || 0).toLocaleString() + '\n\n';
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
                        message += '   Saldo: Rp ' + (u.credits || 0).toLocaleString() + '\n';
                        message += '   Total Topup: Rp ' + totalTopup.toLocaleString() + ' (' + (u.topup_history || []).length + 'x)\n\n';
                    });
                }
                await bot.sendMessage(msg.chat.id, message);
            }
        });

        bot.onText(/\/addban(?:\s+(\d+)(?:\s+(.+))?)?/, async (msg, match) => {
            if (msg.chat.type !== 'private') return;
            if (!isAdmin(msg.from.id)) return;
            if (!match[1]) {
                await bot.sendMessage(msg.chat.id, 'Format: /addban ID [alasan]');
                return;
            }
            const targetId = parseInt(match[1]);
            const reason = match[2] || 'Ban manual oleh admin';
            const now = Date.now();
            spamData[targetId] = { banned: true, bannedAt: now, banReason: reason, infoCount: [] };
            await saveSpamData();
            await bot.sendMessage(msg.chat.id, 'User ' + targetId + ' telah diblokir.\nAlasan: ' + reason);
            try {
                await bot.sendMessage(targetId, 'AKUN ANDA DIBLOKIR\n\nAlasan: ' + reason + '\nHubungi admin jika ada kesalahan.');
            } catch (e) {}
        });

        bot.onText(/\/unban (\d+)/, async (msg, match) => {
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
        });

        bot.onText(/\/addtopup (\d+) (\d+)/, async (msg, match) => {
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
        });

        // ================== CALLBACK QUERY ==================
        bot.on('callback_query', async (cb) => {
            try {
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
                        await bot.editMessageText('Nominal tidak valid.', { chat_id: chatId, message_id: messageId });
                        return;
                    }
                    
                    await bot.editMessageText('Membuat pembayaran...', { chat_id: chatId, message_id: messageId });
                    
                    const username = cb.from.username || '';
                    const payment = await createPakasirTopup(amount, userId, username);
                    
                    if (!payment.success) {
                        await bot.editMessageText('Gagal: ' + payment.error, {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: { inline_keyboard: [[{ text: 'KEMBALI', callback_data: 'topup_menu' }]] }
                        });
                        return;
                    }
                    
                    try {
                        const qrBuffer = await QRCode.toBuffer(payment.qrString, { errorCorrectionLevel: 'L', margin: 1, width: 256 });
                        await bot.deleteMessage(chatId, messageId);
                        
                        const sentMessage = await bot.sendPhoto(chatId, qrBuffer, {
                            caption: 
                                'TOP UP SALDO\n\n' +
                                'Nominal: Rp ' + amount.toLocaleString() + '\n' +
                                'Saldo didapat: Rp ' + amount.toLocaleString() + '\n\n' +
                                'Order ID: ' + payment.orderId + '\n' +
                                'Berlaku sampai: ' + payment.expiredAt + ' WIB\n\n' +
                                'Scan QR code di atas untuk membayar.\n\n' +
                                'Saldo akan masuk otomatis begitu pembayaran berhasil',
                            reply_markup: { inline_keyboard: [[{ text: 'BATALKAN', callback_data: 'cancel_topup_' + payment.orderId }]] }
                        });
                        
                        // Simpan chatId dan messageId untuk auto delete
                        if (db.pending_topups && db.pending_topups[payment.orderId]) {
                            db.pending_topups[payment.orderId].messageId = sentMessage.message_id;
                            db.pending_topups[payment.orderId].chatId = chatId;
                            await saveDB();
                            console.log('QR DISIMPAN - Order:', payment.orderId, 'Chat:', chatId, 'Message:', sentMessage.message_id);
                        }
                        
                    } catch (qrError) {
                        console.log('Error kirim QR:', qrError.message);
                        await bot.editMessageText(
                            'TOP UP SALDO\n\n' +
                            'Nominal: Rp ' + amount.toLocaleString() + '\n\n' +
                            'QR Code:\n' + payment.qrString + '\n\n' +
                            'Order ID: ' + payment.orderId + '\n\n' +
                            'Saldo akan masuk otomatis begitu pembayaran berhasil',
                            {
                                chat_id: chatId,
                                message_id: messageId,
                                reply_markup: { inline_keyboard: [[{ text: 'BATALKAN', callback_data: 'cancel_topup_' + payment.orderId }]] }
                            }
                        );
                    }
                    return;
                }
                
                await bot.answerCallbackQuery(cb.id, { text: 'Perintah tidak dikenal' });
                
            } catch (error) {
                console.log('Error callback:', error.message);
                try { await bot.answerCallbackQuery(cb.id, { text: 'Terjadi kesalahan' }); } catch (e) {}
            }
        });

        // Fungsi helper untuk edit menu
        async function editToMainMenu(bot, chatId, messageId, userId) {
            await loadDB();
            const credits = getUserCredits(userId);
            let message = 'MENU UTAMA\n\n';
            message += 'User ID: ' + userId + '\n';
            message += 'Saldo: Rp ' + credits.toLocaleString() + '\n\n';
            message += 'DAFTAR PERINTAH:\n';
            message += '/info ID SERVER - Info akun\n';
            message += '/cek ID SERVER - Detail akun (Rp 5.000)\n';
            message += '/find NICKNAME/ID - Cari akun (Rp 5.000)\n';
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
            const replyMarkup = { inline_keyboard: [[{ text: 'TOP UP', callback_data: 'topup_menu' }]] };
            await bot.editMessageText(message, { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
        }

        async function editToTopupMenu(bot, chatId, messageId, userId) {
            const credits = getUserCredits(userId);
            const message = 
                'TOP UP SALDO\n\n' +
                'Saldo Anda: Rp ' + credits.toLocaleString() + '\n\n' +
                'Pilih nominal top up:\n\n' +
                'Saldo akan masuk otomatis begitu pembayaran berhasil';
            const replyMarkup = {
                inline_keyboard: [
                    [ { text: 'Rp 5.000', callback_data: 'topup_5000' }, { text: 'Rp 10.000', callback_data: 'topup_10000' } ],
                    [ { text: 'Rp 25.000', callback_data: 'topup_25000' }, { text: 'Rp 50.000', callback_data: 'topup_50000' } ],
                    [ { text: 'Rp 100.000', callback_data: 'topup_100000' }, { text: 'Rp 200.000', callback_data: 'topup_200000' } ],
                    [ { text: 'Rp 500.000', callback_data: 'topup_500000' }, { text: 'Rp 1.000.000', callback_data: 'topup_1000000' } ],
                    [ { text: 'KEMBALI KE MENU', callback_data: 'kembali_ke_menu' } ]
                ]
            };
            await bot.editMessageText(message, { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
        }

        console.log('Bot started, Admin IDs:', ADMIN_IDS);
        
    } catch (error) {
        console.log('FATAL ERROR:', error.message);
    }
}

// Start server
app.listen(PORT, () => {
    console.log('Server running on port ' + PORT);
});
