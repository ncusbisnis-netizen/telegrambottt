const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const moment = require('moment-timezone');
const cron = require('node-cron');
const QRCode = require('qrcode');

// ================== CEK JENIS PROSES ==================
const IS_WORKER = process.env.DYNO && process.env.DYNO.includes('worker');

// ================== KONFIGURASI ==================
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_KEY_CHECKTON = process.env.API_KEY_CHECKTON;
const CHANNEL = process.env.CHANNEL;
const GROUP = process.env.GROUP;
const STOK_ADMIN = process.env.STOK_ADMIN;

const ADMIN_IDS = process.env.ADMIN_IDS 
    ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) 
    : [];

// ================== COUNTRY MAPPING WITH BENDERA ==================
const countryMapping = {
    'ID': '🇮🇩 Indonesia',
    'MY': '🇲🇾 Malaysia',
    'SG': '🇸🇬 Singapore',
    'PH': '🇵🇭 Philippines',
    'TH': '🇹🇭 Thailand',
    'VN': '🇻🇳 Vietnam',
    'MM': '🇲🇲 Myanmar',
    'KH': '🇰🇭 Cambodia',
    'LA': '🇱🇦 Laos',
    'BN': '🇧🇳 Brunei',
    'US': '🇺🇸 United States',
    'JP': '🇯🇵 Japan',
    'KR': '🇰🇷 South Korea',
    'CN': '🇨🇳 China',
    'IN': '🇮🇳 India',
    'GB': '🇬🇧 United Kingdom',
    'SA': '🇸🇦 Saudi Arabia',
    'AE': '🇦🇪 UAE',
    'EG': '🇪🇬 Egypt',
    'TR': '🇹🇷 Turkey',
    'RU': '🇷🇺 Russia',
    'BR': '🇧🇷 Brazil',
    'MX': '🇲🇽 Mexico',
    'AR': '🇦🇷 Argentina',
    'PK': '🇵🇰 Pakistan',
    'BD': '🇧🇩 Bangladesh',
    'AU': '🇦🇺 Australia',
    'FR': '🇫🇷 France',
    'DE': '🇩🇪 Germany',
    'IT': '🇮🇹 Italy',
    'ES': '🇪🇸 Spain',
    'NL': '🇳🇱 Netherlands',
    'CA': '🇨🇦 Canada'
};

function getCountryName(countryCode) {
    const code = (countryCode || 'ID').toUpperCase();
    return countryMapping[code] || `🌍 ${code}`;
}

// ================== DATABASE ==================
let db = { users: {}, total_success: 0, feature: { info: true }, premium: {}, pending_payments: {} };
let spamData = {};

function loadDB() {
    try {
        if (fs.existsSync('database.json')) {
            db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
        } else {
            fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
        }
    } catch (error) {}
}
function saveDB() { fs.writeFileSync('database.json', JSON.stringify(db, null, 2)); }

function loadSpamData() {
    try {
        if (fs.existsSync('spam.json')) {
            spamData = JSON.parse(fs.readFileSync('spam.json', 'utf8'));
        } else {
            spamData = {};
            fs.writeFileSync('spam.json', JSON.stringify(spamData, null, 2));
        }
    } catch (error) {}
}
function saveSpamData() { fs.writeFileSync('spam.json', JSON.stringify(spamData, null, 2)); }

loadDB(); loadSpamData();

// ================== FUNGSI UTILITY ==================
function isAdmin(userId) { return ADMIN_IDS.includes(userId); }
function isPremium(userId) {
    const premium = db.premium[userId];
    if (!premium) return false;
    const now = moment().tz('Asia/Jakarta').unix();
    if (premium.expired_at < now) {
        delete db.premium[userId]; saveDB(); return false;
    }
    return true;
}
function getUserStatus(userId) {
    if (isAdmin(userId)) return { type: 'ADMIN', limit: 'Unlimited' };
    if (isPremium(userId)) return { type: 'PREMIUM', limit: 'Unlimited' };
    return { type: 'FREE', limit: 10, used: db.users[userId]?.success || 0 };
}
function getRemainingLimit(userId) {
    const status = getUserStatus(userId);
    if (status.type !== 'FREE') return 'Unlimited';
    return Math.max(0, status.limit - status.used);
}
function formatRupiah(amount) {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(amount);
}

// ================== ANTI-SPAM ==================
function isBanned(userId) { return spamData[userId]?.banned === true; }
function recordInfoActivity(userId) {
    const now = Date.now();
    if (!spamData[userId]) spamData[userId] = { banned: false, infoCount: [] };
    if (spamData[userId].banned) return false;
    spamData[userId].infoCount.push(now);
    spamData[userId].infoCount = spamData[userId].infoCount.filter(t => now - t < 60000);
    if (spamData[userId].infoCount.length > 10) {
        spamData[userId].banned = true;
        spamData[userId].bannedAt = now;
        spamData[userId].banReason = 'Spam /info 10x dalam 1 menit';
        spamData[userId].infoCount = [];
        saveSpamData();
        return true;
    }
    saveSpamData();
    return false;
}
function unbanUser(userId) {
    if (spamData[userId]) {
        spamData[userId].banned = false;
        spamData[userId].infoCount = [];
        saveSpamData();
        return true;
    }
    return false;
}
function addBan(userId, reason = 'Ban manual oleh admin') {
    spamData[userId] = { banned: true, bannedAt: Date.now(), banReason: reason, infoCount: [] };
    saveSpamData();
    return true;
}

// ================== FUNGSI GET DATA MLBB ==================
async function getMLBBData(userId, serverId) {
    const result = { username: null, region: null, bindAccounts: [], devices: { android: 0, ios: 0 }, ttl: null };
    
    // 1. AMBIL USERNAME DARI GOPAY
    try {
        console.log(`Mencoba GoPay untuk ${userId} server ${serverId}...`);
        
        const goPayResponse = await axios.post("https://gopay.co.id/games/v1/order/user-account", {
            code: "MOBILE_LEGENDS",
            data: { 
                userId: String(userId), 
                zoneId: String(serverId) 
            }
        }, {
            headers: {
                "Content-Type": "application/json",
                "X-Client": "web-mobile",
                "X-Timestamp": Date.now(),
                "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36"
            },
            timeout: 10000
        });
        
        if (goPayResponse.data?.data) {
            const g = goPayResponse.data.data;
            result.username = g.username || "Tidak ditemukan";
            
            const countryCode = g.countryOrigin || "ID";
            result.region = getCountryName(countryCode);
            
            console.log(`Username dari GoPay: ${result.username}`);
        } else {
            console.log("GoPay response tidak memiliki data");
            return null;
        }
    } catch (error) {
        console.log("GoPay error:", error.message);
        return null;
    }

    // 2. AMBIL DATA DARI CHECKTON
    if (result.username && API_KEY_CHECKTON) {
        try {
            console.log("Mencoba Checkton...");
            
            const checktonResponse = await axios.post("https://checkton.online/backend/info", {
                role_id: String(userId),
                zone_id: String(serverId),
                type: "bind"
            }, {
                headers: { 
                    "Content-Type": "application/json", 
                    "x-api-key": API_KEY_CHECKTON 
                },
                timeout: 15000
            });
            
            if (checktonResponse.data?.data) {
                const c = checktonResponse.data.data;
                
                if (c.devices) {
                    result.devices.android = c.devices.android?.total || 0;
                    result.devices.ios = c.devices.ios?.total || 0;
                }
                
                if (c.bind_accounts && Array.isArray(c.bind_accounts)) {
                    result.bindAccounts = c.bind_accounts;
                }
                
                if (c.ttl) {
                    result.ttl = c.ttl;
                }
                
                console.log("Berhasil ambil data Checkton");
            }
        } catch (error) {
            console.log("Checkton error:", error.message);
        }
    }

    return result;
}

// ================== PAKASIR API ==================
async function createPakasirTransaction(amount, duration, userId) {
    try {
        const orderId = `${process.env.PAKASIR_SLUG || 'ncusspayment'}-${userId}-${Date.now()}`;
        const response = await axios.post(
            `${process.env.PAKASIR_BASE_URL || 'https://app.pakasir.com/api'}/transactioncreate/qris`,
            { project: process.env.PAKASIR_SLUG || 'ncusspayment', order_id: orderId, amount, api_key: process.env.PAKASIR_API_KEY },
            { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        if (response.data?.payment) {
            const payment = response.data.payment;
            const expiredAt = moment(payment.expired_at).tz('Asia/Jakarta');
            db.pending_payments[orderId] = {
                userId, duration, amount, status: 'pending',
                created_at: moment().tz('Asia/Jakarta').unix(),
                expired_at: expiredAt.unix(),
                payment_number: payment.payment_number
            };
            saveDB();
            return {
                success: true, orderId, qrString: payment.payment_number, amount,
                expiredAt: expiredAt.format('YYYY-MM-DD HH:mm:ss')
            };
        }
        return { success: false, error: 'Invalid response' };
    } catch (error) {
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

    app.get('/tes.php', async (req, res) => {
        const { userId, serverId, role_id, zone_id } = req.query;
        if (!userId || !serverId || !role_id || !zone_id) return res.status(400).send('Parameter tidak lengkap');
        const data = await getMLBBData(userId, serverId);
        if (!data?.username) return res.status(500).send('Gagal mengambil data');
        
        let output = `[userId] => ${userId}\n[serverId] => ${serverId}\n[username] => ${data.username}\n[region] => ${data.region}\n\n`;
        output += `Android: ${data.devices.android} | iOS: ${data.devices.ios}\n\n`;
        if (data.ttl) output += `<table><tr><td>${data.ttl}</td></tr></table>\n\n`;
        if (data.bindAccounts?.length > 0) {
            output += `<ul>\n`;
            data.bindAccounts.forEach(b => output += `<li>${b.platform} : ${b.details || 'empty.'}</li>\n`);
            output += `</ul>\n`;
        }
        res.set('Content-Type', 'text/plain').send(output);
    });

    app.get('/webhook/pakasir', (req, res) => res.json({ status: 'ok' }));
    app.post('/webhook/pakasir', (req, res) => {
        console.log('Webhook received:', req.body);
        res.json({ status: 'ok' });
    });
    app.get('/', (req, res) => res.send('✅ MLBB API Server is running'));

    app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));
} 
// ================== BOT TELEGRAM (WORKER) ==================
else {
    console.log('🤖 Bot worker started');
    const bot = new TelegramBot(BOT_TOKEN, { polling: { interval: 300, autoStart: true, params: { timeout: 10 } } });

    async function checkJoin(userId) {
        try {
            let isChannelMember = false, isGroupMember = false;
            try {
                const channelCheck = await bot.getChatMember(CHANNEL, userId);
                isChannelMember = ['member', 'administrator', 'creator'].includes(channelCheck.status);
            } catch (channelError) {
                console.error(`❌ Channel ${CHANNEL} error:`, channelError.message);
            }
            try {
                const groupCheck = await bot.getChatMember(GROUP, userId);
                isGroupMember = ['member', 'administrator', 'creator'].includes(groupCheck.status);
            } catch (groupError) {
                console.error(`❌ Group ${GROUP} error:`, groupError.message);
            }
            return { channel: isChannelMember, group: isGroupMember };
        } catch (error) {
            console.error('❌ checkJoin fatal error:', error);
            return { channel: false, group: false };
        }
    }

    bot.on('message', async (msg) => {
        const chatId = msg.chat.id, userId = msg.from.id, username = msg.from.username, text = msg.text, chatType = msg.chat.type;
        if (!text || chatType !== 'private' || isAdmin(userId)) return;

        if (text.startsWith('/info') && !db.feature.info) {
            await bot.sendMessage(chatId, `FITUR SEDANG NONAKTIF\n\nFitur /info sedang dinonaktifkan oleh administrator.`, {
                reply_markup: { inline_keyboard: [[{ text: 'Hubungi Admin', url: STOK_ADMIN }]] }
            });
            return;
        }

        if (['/start', '/langganan', '/status'].includes(text.split(' ')[0])) return;

        if (!username) {
            await bot.sendMessage(chatId, `USERNAME DIPERLUKAN\n\nUntuk menggunakan perintah ini, Anda harus memiliki username Telegram.\n\nCara membuat username:\n1. Buka Settings\n2. Pilih Username\n3. Buat username baru\n4. Simpan`);
            return;
        }

        const joined = await checkJoin(userId);
        const missing = [];
        if (!joined.channel) missing.push({ name: CHANNEL, text: 'Bergabung ke Channel', url: `https://t.me/${CHANNEL.replace('@', '')}` });
        if (!joined.group) missing.push({ name: GROUP, text: 'Bergabung ke Group', url: `https://t.me/${GROUP.replace('@', '')}` });

        if (missing.length > 0) {
            await bot.sendMessage(chatId, 
                `AKSES TERBATAS\n\nUntuk menggunakan bot ini, Anda perlu bergabung dengan:\n${missing.map(m => `• ${m.name}`).join('\n')}\n\nSilakan klik tombol di bawah untuk bergabung, lalu coba lagi.`,
                { reply_markup: { inline_keyboard: missing.map(m => [{ text: m.text, url: m.url }]) } }
            );
        }
    });

    bot.onText(/\/start/, async (msg) => {
        const status = getUserStatus(msg.from.id);
        let message = `SELAMAT DATANG DI BOT 1 For All\n\nStatus Akun: ${status.type}\n`;
        if (status.type === 'FREE') message += `Sisa Limit: ${status.used}/${status.limit}\n\n`;
        else message += `Akses: Unlimited\n\n`;
        message += `DAFTAR PERINTAH:\n/info ID SERVER - Cek akun\n/status - Cek status\n/langganan - Paket premium`;
        if (isAdmin(msg.from.id)) message += `\n\nADMIN:\n/offinfo, /oninfo, /ranking, /listpremium, /listbanned, /addban, /unban, /addpremium`;
        await bot.sendMessage(msg.chat.id, message);
    });

    bot.onText(/\/status/, async (msg) => {
        const userId = msg.from.id;
        if (isBanned(userId) && !isAdmin(userId)) {
            await bot.sendMessage(msg.chat.id, `STATUS AKUN\n\nStatus: BLOKIR\nAlasan: ${spamData[userId]?.banReason}\nTanggal: ${moment(spamData[userId]?.bannedAt).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')} WIB`);
            return;
        }
        const status = getUserStatus(userId);
        let message = `STATUS AKUN\n\nUser ID: ${userId}\nTipe: ${status.type}\n`;
        if (status.type === 'FREE') {
            message += `Limit: ${status.used}/${status.limit}\nSisa: ${getRemainingLimit(userId)}`;
            if (status.used >= status.limit) message += `\n\nLimit habis! Gunakan /langganan.`;
        } else {
            message += `Akses: Unlimited`;
            if (status.type === 'PREMIUM') message += `\nBerlaku sampai: ${moment.unix(db.premium[userId].expired_at).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')} WIB`;
        }
        await bot.sendMessage(msg.chat.id, message);
    });

    bot.onText(/\/langganan/, async (msg) => {
        const userId = msg.from.id;
        if (isPremium(userId)) {
            const expired = moment.unix(db.premium[userId].expired_at).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');
            await bot.sendMessage(msg.chat.id, `ANDA SUDAH PREMIUM\n\nBerlaku sampai: ${expired} WIB`);
            return;
        }
        await bot.sendMessage(msg.chat.id, `PAKET PREMIUM\n\nPilih masa aktif:`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '1 HARI - Rp 10.000', callback_data: 'bayar_1' }],
                    [{ text: '3 HARI - Rp 25.000', callback_data: 'bayar_3' }],
                    [{ text: '7 HARI - Rp 45.000', callback_data: 'bayar_7' }],
                    [{ text: '30 HARI - Rp 100.000', callback_data: 'bayar_30' }],
                    [{ text: 'BATAL', callback_data: 'batal_bayar' }]
                ]
            }
        });
    });

    bot.on('callback_query', async (cb) => {
        const msg = cb.message, chatId = msg.chat.id, userId = cb.from.id, data = cb.data;
        await bot.deleteMessage(chatId, msg.message_id).catch(() => {});

        if (data === 'batal_bayar') {
            await bot.answerCallbackQuery(cb.id, { text: 'Pembayaran dibatalkan' });
            await bot.sendMessage(chatId, 'Pembayaran dibatalkan.');
            return;
        }

        if (data.startsWith('bayar_')) {
            await bot.answerCallbackQuery(cb.id, { text: 'Memproses pembayaran...' });
            const pilihan = data.replace('bayar_', '');
            const paket = { '1': { name: '1 Hari', price: 10000 }, '3': { name: '3 Hari', price: 25000 }, '7': { name: '7 Hari', price: 45000 }, '30': { name: '30 Hari', price: 100000 } };
            const selected = paket[pilihan];
            if (!selected) return bot.sendMessage(chatId, 'Pilihan tidak valid.');

            const loading = await bot.sendMessage(chatId, 'Membuat pembayaran...');
            const payment = await createPakasirTransaction(selected.price, selected.name, userId);
            await bot.deleteMessage(chatId, loading.message_id).catch(() => {});

            if (!payment.success) return bot.sendMessage(chatId, `Gagal: ${payment.error}`);

            try {
                const qrBuffer = await QRCode.toBuffer(payment.qrString, { errorCorrectionLevel: 'L', margin: 1, width: 256 });
                const sentMessage = await bot.sendPhoto(chatId, qrBuffer, {
                    caption: `PEMBAYARAN QRIS\n\nPaket: ${selected.name}\nHarga: ${formatRupiah(selected.price)}\n\nOrder ID: ${payment.orderId}\nBerlaku sampai: ${payment.expiredAt} WIB\n\nScan QR code di atas untuk membayar.`
                });
                db.pending_payments[payment.orderId] = db.pending_payments[payment.orderId] || {};
                db.pending_payments[payment.orderId].messageId = sentMessage.message_id;
                db.pending_payments[payment.orderId].chatId = chatId;
                saveDB();
            } catch {
                await bot.sendMessage(chatId, `PEMBAYARAN QRIS\n\nPaket: ${selected.name}\nHarga: ${formatRupiah(selected.price)}\n\nQR Code:\n${payment.qrString}\n\nOrder ID: ${payment.orderId}\nBerlaku sampai: ${payment.expiredAt} WIB`);
            }
        }
    });

    cron.schedule('* * * * *', async () => {
        console.log('🔍 Cron job berjalan pada:', moment().tz('Asia/Jakarta').format('YYYY-MM-DD HH:mm:ss'));
        for (const [orderId, data] of Object.entries(db.pending_payments || {})) {
            if (data.status === 'pending') {
                const now = moment().tz('Asia/Jakarta').unix();
                if (data.expired_at < now) {
                    if (data.messageId && data.chatId) {
                        try { await bot.deleteMessage(data.chatId, data.messageId); } catch {}
                    }
                    delete db.pending_payments[orderId];
                    saveDB();
                    continue;
                }

                const status = await checkPakasirTransaction(orderId, data.amount);
                if (status === 'completed' || status === 'paid') {
                    const userId = data.userId;
                    const days = { '1 Hari':1, '3 Hari':3, '7 Hari':7, '30 Hari':30 }[data.duration] || 1;
                    const now = moment().tz('Asia/Jakarta').unix();

                    let expiredAt;
                    if (db.premium[userId]?.expired_at > now) {
                        expiredAt = db.premium[userId].expired_at + (days * 86400);
                    } else {
                        expiredAt = now + (days * 86400);
                    }

                    db.premium[userId] = { activated_at: now, expired_at: expiredAt, duration: data.duration, order_id: orderId };
                    db.pending_payments[orderId].status = 'paid';
                    saveDB();

                    if (data.messageId && data.chatId) {
                        try { await bot.deleteMessage(data.chatId, data.messageId); } catch {}
                    }

                    try {
                        await bot.sendMessage(userId,
                            `PEMBAYARAN BERHASIL\n\n` +
                            `Premium ${data.duration} telah diaktifkan.\n` +
                            `Berlaku sampai: ${moment.unix(expiredAt).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')} WIB\n\n` +
                            `Sekarang Anda bisa menggunakan /info unlimited.`
                        );
                    } catch (e) {}
                }
            }
        }
    });

    bot.onText(/\/info(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id, userId = msg.from.id, username = msg.from.username;
        if (isBanned(userId) && !isAdmin(userId)) return console.log(`User ${userId} banned`);

        if (!match[1]) {
            return bot.sendMessage(chatId, `INFORMASI PENGGUNAAN\n\nFormat: /info ID_USER ID_SERVER\nContoh: /info 643461181 8554`);
        }

        const args = match[1].split(' ');
        if (args.length < 2) return bot.sendMessage(chatId, `Format: /info ID_USER ID_SERVER`);

        const targetId = args[0], serverId = args[1];
        if (!/^\d+$/.test(targetId) || !/^\d+$/.test(serverId)) return bot.sendMessage(chatId, 'ID dan Server harus angka.');

        const banned = recordInfoActivity(userId);
        if (banned) return console.log(`User ${userId} kena ban spam`);

        const isFreeUser = !isAdmin(userId) && !isPremium(userId);
        if (isFreeUser && getRemainingLimit(userId) <= 0) {
            return bot.sendMessage(chatId, `BATAS HABIS\n\nAnda telah mencapai batas gratis (10x). Gunakan /langganan.`);
        }

        const loadingMsg = await bot.sendMessage(chatId, 'Mengambil data...');
        const data = await getMLBBData(targetId, serverId);
        
        await bot.deleteMessage(chatId, loadingMsg.message_id);
        
        if (!data?.username) {
            return bot.sendMessage(chatId, `GAGAL MENGAMBIL DATA\n\nID atau Server salah.`);
        }

        let output = `INFORMASI AKUN\n\nID: ${targetId}\nServer: ${serverId}\nNickname: ${data.username}\n`;
        if (data.ttl) output += `Tanggal Pembuatan: ${data.ttl}\n`;
        output += `Region: ${data.region}\n\n`;
        if (data.bindAccounts?.length > 0) {
            output += `BIND INFO:\n`;
            data.bindAccounts.forEach(b => output += `• ${b.platform}: ${b.details || 'empty.'}\n`);
            output += `\n`;
        }
        output += `Device Login:\n• Android: ${data.devices.android} perangkat\n• iOS: ${data.devices.ios} perangkat`;

        await bot.sendMessage(chatId, output, {
            reply_markup: { inline_keyboard: [[{ text: 'Stok Admin', url: STOK_ADMIN }]] }
        });

        if (isFreeUser) {
            db.users[userId] = db.users[userId] || { username, success: 0 };
            db.users[userId].success += 1;
            db.total_success += 1;
            saveDB();
        }
    });

    bot.onText(/\/offinfo/, (msg) => { if (isAdmin(msg.from.id)) { db.feature.info = false; saveDB(); bot.sendMessage(msg.chat.id, 'Fitur /info dinonaktifkan.'); } });
    bot.onText(/\/oninfo/, (msg) => { if (isAdmin(msg.from.id)) { db.feature.info = true; saveDB(); bot.sendMessage(msg.chat.id, 'Fitur /info diaktifkan.'); } });
    bot.onText(/\/ranking/, async (msg) => {
        if (!isAdmin(msg.from.id)) return;
        const users = Object.entries(db.users || {}).sort((a,b) => b[1].success - a[1].success).slice(0,10);
        let message = 'PERINGKAT PENGGUNA\n\n';
        users.forEach(([id,data],i) => message += `${i+1}. @${data.username || 'unknown'} - ${data.success}x\n`);
        await bot.sendMessage(msg.chat.id, message || 'Belum ada data');
    });
    bot.onText(/\/listpremium/, (msg) => {
        if (!isAdmin(msg.from.id)) return;
        let message = 'DAFTAR PREMIUM\n\n';
        Object.entries(db.premium || {}).forEach(([id,data],i) => {
            message += `${i+1}. ID: ${id} - ${data.duration}\n   Exp: ${moment.unix(data.expired_at).tz('Asia/Jakarta').format('DD/MM/YYYY')}\n\n`;
        });
        bot.sendMessage(msg.chat.id, message || 'Belum ada');
    });
    bot.onText(/\/listbanned/, (msg) => {
        if (!isAdmin(msg.from.id)) return;
        let message = 'DAFTAR BANNED\n\n';
        Object.entries(spamData).filter(([_,d]) => d.banned).forEach(([id,d],i) => {
            message += `${i+1}. ${id} - ${d.banReason} (${moment(d.bannedAt).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm')})\n`;
        });
        bot.sendMessage(msg.chat.id, message || 'Tidak ada');
    });
    bot.onText(/\/addban(?:\s+(\d+)(?:\s+(.+))?)?/, (msg, match) => {
        if (!isAdmin(msg.from.id)) return;
        if (!match[1]) return bot.sendMessage(msg.chat.id, 'Format: /addban ID [alasan]');
        addBan(parseInt(match[1]), match[2] || 'Ban manual');
        bot.sendMessage(msg.chat.id, `User ${match[1]} diblokir.`);
    });
    bot.onText(/\/unban (.+)/, (msg, match) => {
        if (!isAdmin(msg.from.id)) return;
        const id = parseInt(match[1]);
        if (unbanUser(id)) bot.sendMessage(msg.chat.id, `User ${id} di-unban.`);
        else bot.sendMessage(msg.chat.id, `User ${id} tidak ditemukan.`);
    });
    bot.onText(/\/addpremium (.+)/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return;
        const args = match[1].split(' ');
        if (args.length < 2) return bot.sendMessage(msg.chat.id, 'Format: /addpremium ID DURASI');
        const targetId = parseInt(args[0]), days = parseInt(args[1]);
        const now = moment().tz('Asia/Jakarta').unix();
        db.premium[targetId] = { activated_at: now, expired_at: now + (days * 86400), duration: `${days} Hari (Manual)` };
        saveDB();
        bot.sendMessage(msg.chat.id, `Premium ${days} hari untuk ${targetId}.`);
        try { await bot.sendMessage(targetId, `Akun Anda diupgrade PREMIUM ${days} hari.`); } catch {}
    });

    console.log('🤖 Bot started, Admin IDs:', ADMIN_IDS);
}
