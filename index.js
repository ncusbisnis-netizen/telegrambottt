const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const moment = require('moment-timezone');
const cron = require('node-cron');
const QRCode = require('qrcode');
const svgCaptcha = require('svg-captcha');
const sharp = require('sharp');

// ============ OPTIMASI MEMORY ============
process.env.NODE_OPTIONS = '--max-old-space-size=256';
axios.defaults.timeout = 15000;
axios.defaults.maxContentLength = 1024 * 512;

// Cache
const cache = { info: {}, qr: {} };
setInterval(() => {
    cache.info = {};
    cache.qr = {};
}, 60 * 60 * 1000);
// =========================================

// ================== CONFIG ==================
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_URL = process.env.API_URL;
const CHANNEL = process.env.CHANNEL;
const GROUP = process.env.GROUP;
const STOK_ADMIN = process.env.STOK_ADMIN;

// PAKASIR CONFIG
const PAKASIR_SLUG = process.env.PAKASIR_SLUG;
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY;
const PAKASIR_BASE_URL = process.env.PAKASIR_BASE_URL || 'https://app.pakasir.com/api';

// ADMIN IDS
const ADMIN_IDS = process.env.ADMIN_IDS 
    ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) 
    : [];

console.log('Admin IDs:', ADMIN_IDS);
console.log('Bot starting...');

// Validasi
if (!BOT_TOKEN) {
    console.error('BOT_TOKEN tidak ditemukan!');
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { 
    polling: {
        interval: 300,
        autoStart: true,
        params: { timeout: 10 }
    }
});

// ================== DATABASE ==================
let db = { 
    users: {}, 
    total_success: 0, 
    feature: { info: true }, 
    premium: {},
    pending_payments: {} 
};

function loadDB() {
    try {
        if (fs.existsSync('database.json')) {
            const data = fs.readFileSync('database.json', 'utf8');
            db = JSON.parse(data);
            console.log(`Database loaded: ${Object.keys(db.users).length} users, ${Object.keys(db.premium).length} premium`);
        } else {
            fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
            console.log('New database created');
        }
    } catch (error) {
        console.error('Error loading database:', error);
    }
}

function saveDB() {
    try {
        fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
    } catch (error) {
        console.error('Error saving database:', error);
    }
}

loadDB();

// ================== CAPTCHA FOTO RANDOM ==================
let captchaData = {};

function loadCaptcha() {
    try {
        if (fs.existsSync('captcha.json')) {
            const data = fs.readFileSync('captcha.json', 'utf8');
            captchaData = JSON.parse(data);
        }
    } catch (error) {
        console.error('Error loading captcha:', error);
    }
}

function saveCaptcha() {
    try {
        fs.writeFileSync('captcha.json', JSON.stringify(captchaData, null, 2));
    } catch (error) {
        console.error('Error saving captcha:', error);
    }
}

loadCaptcha();

function needCaptcha(userId) {
    if (!captchaData[userId]) {
        captchaData[userId] = { 
            count: 0,
            pending: false,
            code: null,
            attempts: 0,
            messageId: null,
            chatId: null
        };
        saveCaptcha();
    }
    
    const userCaptcha = captchaData[userId];
    
    if (userCaptcha.pending) {
        return true;
    }
    
    userCaptcha.count++;
    saveCaptcha();
    
    return (userCaptcha.count % 3 === 0);
}

async function generateCaptchaImage() {
    // Buat captcha SVG
    const captcha = svgCaptcha.create({
        size: 6,
        noise: 2,
        color: true,
        background: '#f0f0f0',
        width: 300,
        height: 100
    });
    
    // Convert SVG ke PNG
    const pngBuffer = await sharp(Buffer.from(captcha.data))
        .png()
        .toBuffer();
    
    return {
        text: captcha.text,
        image: pngBuffer
    };
}

async function sendCaptcha(chatId, userId) {
    try {
        // Hapus captcha lama jika ada
        if (captchaData[userId]?.messageId) {
            try {
                await bot.deleteMessage(chatId, captchaData[userId].messageId);
            } catch (e) {}
        }
        
        // Generate captcha baru
        const captcha = await generateCaptchaImage();
        const code = captcha.text;
        
        if (!captchaData[userId]) {
            captchaData[userId] = { count: 0, pending: false, attempts: 0 };
        }
        
        captchaData[userId].pending = true;
        captchaData[userId].code = code;
        captchaData[userId].attempts = 0;
        captchaData[userId].chatId = chatId;
        saveCaptcha();
        
        // Kirim FOTO captcha
        const sentMessage = await bot.sendPhoto(chatId, captcha.image, {
            caption: `🔐 VERIFIKASI CAPTCHA\n\nKetik /verify diikuti 6 digit angka di atas.\nContoh: /verify ${code}`
        });
        
        captchaData[userId].messageId = sentMessage.message_id;
        saveCaptcha();
        
        return true;
        
    } catch (error) {
        console.error('Error creating captcha:', error);
        
        // Fallback: kirim teks biasa
        const fallbackCode = Math.floor(100000 + Math.random() * 900000).toString();
        
        captchaData[userId].pending = true;
        captchaData[userId].code = fallbackCode;
        captchaData[userId].attempts = 0;
        captchaData[userId].chatId = chatId;
        
        const sentMessage = await bot.sendMessage(chatId,
            `🔐 VERIFIKASI CAPTCHA (FALLBACK)\n\n` +
            `${fallbackCode}\n\n` +
            `Ketik: /verify ${fallbackCode}`
        );
        
        captchaData[userId].messageId = sentMessage.message_id;
        saveCaptcha();
        
        return true;
    }
}

async function deleteCaptchaMessage(userId) {
    try {
        if (captchaData[userId] && captchaData[userId].messageId && captchaData[userId].chatId) {
            await bot.deleteMessage(captchaData[userId].chatId, captchaData[userId].messageId);
            captchaData[userId].messageId = null;
        }
    } catch (error) {}
}

function verifyCaptcha(userId, userCode) {
    if (!captchaData[userId] || !captchaData[userId].pending) {
        return { success: false, message: 'Tidak ada captcha yang perlu diverifikasi.' };
    }
    
    const expectedCode = captchaData[userId].code;
    
    captchaData[userId].attempts++;
    
    if (userCode === expectedCode) {
        // Hapus foto captcha
        deleteCaptchaMessage(userId);
        
        captchaData[userId].pending = false;
        captchaData[userId].code = null;
        captchaData[userId].attempts = 0;
        saveCaptcha();
        
        return { success: true, message: '✅ Verifikasi berhasil! Silakan kirim ulang /info Anda.' };
    } else {
        if (captchaData[userId].attempts >= 3) {
            // Hapus foto captcha
            deleteCaptchaMessage(userId);
            
            captchaData[userId].pending = false;
            captchaData[userId].code = null;
            captchaData[userId].attempts = 0;
            saveCaptcha();
            
            return { success: false, message: '❌ Terlalu banyak percobaan. Silakan ketik /info untuk captcha baru.' };
        } else {
            saveCaptcha();
            return { success: false, message: `❌ Kode salah. Sisa percobaan: ${3 - captchaData[userId].attempts}` };
        }
    }
}

// ================== UTILITY FUNCTIONS ==================
function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
}

function isPremium(userId) {
    const premium = db.premium[userId];
    if (!premium) return false;
    
    const now = moment().tz('Asia/Jakarta').unix();
    if (premium.expired_at < now) {
        delete db.premium[userId];
        saveDB();
        return false;
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

async function checkJoin(userId) {
    try {
        const channelCheck = await bot.getChatMember(CHANNEL, userId);
        const groupCheck = await bot.getChatMember(GROUP, userId);
        
        const isChannelMember = ['member', 'administrator', 'creator'].includes(channelCheck.status);
        const isGroupMember = ['member', 'administrator', 'creator'].includes(groupCheck.status);
        
        return { channel: isChannelMember, group: isGroupMember };
    } catch (error) {
        console.error('Error checking membership:', error);
        return { channel: false, group: false };
    }
}

function formatRupiah(amount) {
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0
    }).format(amount);
}

// ================== PAKASIR API ==================
async function createPakasirTransaction(amount, duration, userId) {
    try {
        const orderId = `${PAKASIR_SLUG}-${userId}-${Date.now()}`;
        
        const requestBody = {
            project: PAKASIR_SLUG,
            order_id: orderId,
            amount: amount,
            api_key: PAKASIR_API_KEY
        };

        console.log('Creating transaction:', orderId);

        const response = await axios.post(
            `${PAKASIR_BASE_URL}/transactioncreate/qris`,
            requestBody,
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 15000
            }
        );

        if (response.data && response.data.payment) {
            const payment = response.data.payment;
            const expiredAt = moment(payment.expired_at).tz('Asia/Jakarta');

            db.pending_payments[orderId] = {
                userId,
                duration,
                amount,
                status: 'pending',
                created_at: moment().tz('Asia/Jakarta').unix(),
                expired_at: expiredAt.unix(),
                payment_number: payment.payment_number
            };
            saveDB();

            return {
                success: true,
                orderId: orderId,
                qrString: payment.payment_number,
                amount: amount,
                expiredAt: expiredAt.format('YYYY-MM-DD HH:mm:ss')
            };
        }

        throw new Error('Invalid response from Pakasir API');

    } catch (error) {
        console.error('Pakasir API error:', error.response?.data || error.message);
        return { success: false, error: error.message };
    }
}

async function checkPakasirTransaction(orderId, amount) {
    try {
        const url = `${PAKASIR_BASE_URL}/transactiondetail`;
        const params = {
            project: PAKASIR_SLUG,
            order_id: orderId,
            amount: amount,
            api_key: PAKASIR_API_KEY
        };

        const response = await axios.get(url, { params, timeout: 10000 });
        
        if (response.data && response.data.transaction) {
            return response.data.transaction.status;
        }
        
        return 'pending';
    } catch (error) {
        return 'pending';
    }
}

// ================== AUTO CHECK PAYMENT ==================
cron.schedule('* * * * *', async () => {
    for (const [orderId, data] of Object.entries(db.pending_payments || {})) {
        if (data.status === 'pending') {
            const now = moment().tz('Asia/Jakarta').unix();
            
            if (data.expired_at < now) {
                if (data.messageId && data.chatId) {
                    try {
                        await bot.deleteMessage(data.chatId, data.messageId);
                    } catch (error) {}
                }
                delete db.pending_payments[orderId];
                saveDB();
                continue;
            }

            const status = await checkPakasirTransaction(orderId, data.amount);
            
            if (status === 'completed' || status === 'paid') {
                const userId = data.userId;
                const days = {
                    '1 Hari': 1,
                    '3 Hari': 3,
                    '7 Hari': 7,
                    '30 Hari': 30
                }[data.duration] || 1;
                
                const expiredAt = now + (days * 24 * 60 * 60);
                
                db.premium[userId] = {
                    activated_at: now,
                    expired_at: expiredAt,
                    duration: data.duration,
                    order_id: orderId
                };
                
                db.pending_payments[orderId].status = 'paid';
                saveDB();
                
                if (data.messageId && data.chatId) {
                    try {
                        await bot.deleteMessage(data.chatId, data.messageId);
                    } catch (error) {}
                }
                
                try {
                    await bot.sendMessage(userId, 
                        `✅ PEMBAYARAN BERHASIL\n\n` +
                        `Premium ${data.duration} telah diaktifkan.\n` +
                        `Berlaku sampai: ${moment.unix(expiredAt).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')} WIB\n\n` +
                        `Sekarang Anda bisa menggunakan /info unlimited.`
                    );
                } catch (error) {}
            }
        }
    }
});

// ================== MIDDLEWARE ==================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username;
    const text = msg.text;
    
    if (!text) return;
    
    // Izinkan command tertentu tanpa cek join
    if (text.startsWith('/start') || text.startsWith('/verify') || isAdmin(userId)) {
        return;
    }
    
    // CEK JOIN DULU!
    const joined = await checkJoin(userId);
    const missing = [];
    
    if (!joined.channel) missing.push(CHANNEL);
    if (!joined.group) missing.push(GROUP);
    
    if (missing.length > 0) {
        const buttons = missing.map(ch => [{
            text: `JOIN ${ch.replace('@', '')}`,
            url: `https://t.me/${ch.replace('@', '')}`
        }]);
        
        await bot.sendMessage(chatId, 
            `AKSES DIBATASI\n\n` +
            `Untuk menggunakan bot ini, Anda wajib join ke:\n` +
            missing.map(ch => `• ${ch}`).join('\n') + 
            `\n\nSilakan join terlebih dahulu, lalu coba lagi.`,
            { reply_markup: { inline_keyboard: buttons } }
        );
        
        // PENTING! RETURN AGAR COMMAND TIDAK DIPROSES
        return;
    }
    
    // CEK USERNAME (setelah lolos join)
    if (!username && !isAdmin(userId)) {
        await bot.sendMessage(chatId,
            `USERNAME DIPERLUKAN\n\n` +
            `Anda wajib memiliki username Telegram.\n\n` +
            `Cara membuat:\n` +
            `1. Buka Settings\n` +
            `2. Pilih Username\n` +
            `3. Buat username baru\n` +
            `4. Simpan`
        );
        return;
    }
});

// ================== COMMAND /start ==================
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const status = getUserStatus(userId);
    
    let message = `SELAMAT DATANG DI BOT MLBB INFO\n\n`;
    message += `Status Akun: ${status.type}\n`;
    
    if (status.type === 'FREE') {
        message += `Sisa Limit: ${status.used}/${status.limit}\n\n`;
    } else {
        message += `Akses: Unlimited\n\n`;
    }
    
    message += `DAFTAR PERINTAH:\n`;
    message += `/info ID SERVER - Cek akun Mobile Legends\n`;
    message += `Contoh: /info 123456 1234\n\n`;
    message += `/status - Cek status dan sisa limit\n`;
    message += `/langganan - Lihat paket premium\n\n`;
    
    if (isAdmin(userId)) {
        message += `ADMIN COMMANDS:\n`;
        message += `/offinfo - Matikan fitur info\n`;
        message += `/oninfo - Hidupkan fitur info\n`;
        message += `/ranking - Lihat ranking user\n`;
        message += `/listpremium - Lihat user premium\n`;
        message += `/addpremium USERID DURASI - Tambah premium manual\n`;
    }
    
    await bot.sendMessage(chatId, message);
});

// ================== COMMAND /verify ==================
bot.onText(/\/verify(?:\s+)?(\d{6})?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!match[1]) {
        await bot.sendMessage(chatId, 
            `Format: /verify [kode 6 digit]\nContoh: /verify 842405`
        );
        return;
    }
    
    const userCode = match[1];
    
    if (!captchaData[userId] || !captchaData[userId].pending) {
        await bot.sendMessage(chatId, 'Tidak ada captcha yang perlu diverifikasi.');
        return;
    }
    
    const result = verifyCaptcha(userId, userCode);
    await bot.sendMessage(chatId, result.message);
});

// ================== COMMAND /status ==================
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const status = getUserStatus(userId);
    const remaining = getRemainingLimit(userId);
    
    let message = `STATUS AKUN\n\n`;
    message += `User ID: ${userId}\n`;
    message += `Tipe Akun: ${status.type}\n`;
    
    if (status.type === 'FREE') {
        message += `Limit: ${status.used}/${status.limit}\n`;
        message += `Sisa: ${remaining}\n\n`;
        
        if (status.used >= status.limit) {
            message += `Limit Anda sudah habis!\n`;
            message += `Gunakan /langganan untuk upgrade premium.\n`;
        }
    } else {
        message += `Akses: Unlimited\n`;
        
        if (status.type === 'PREMIUM') {
            const premium = db.premium[userId];
            const expired = moment.unix(premium.expired_at).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');
            message += `Berlaku sampai: ${expired} WIB\n`;
        }
    }
    
    await bot.sendMessage(chatId, message);
});

// ================== COMMAND /langganan DENGAN TOMBOL ==================
bot.onText(/\/langganan/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (isPremium(userId)) {
        const premium = db.premium[userId];
        const expired = moment.unix(premium.expired_at).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');
        
        await bot.sendMessage(chatId,
            `✅ ANDA SUDAH PREMIUM\n\n` +
            `Berlaku sampai: ${expired} WIB\n\n` +
            `Gunakan /status untuk detail.`
        );
        return;
    }
    
    await bot.sendMessage(chatId,
        `💎 PAKET PREMIUM\n\n` +
        `Pilih masa aktif di bawah ini:`,
        {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🗓️ 1 HARI - Rp 10.000', callback_data: 'bayar_1' }
                    ],
                    [
                        { text: '🗓️ 3 HARI - Rp 25.000', callback_data: 'bayar_3' }
                    ],
                    [
                        { text: '🗓️ 7 HARI - Rp 45.000', callback_data: 'bayar_7' }
                    ],
                    [
                        { text: '🗓️ 30 HARI - Rp 100.000', callback_data: 'bayar_30' }
                    ],
                    [
                        { text: '❌ BATAL', callback_data: 'batal_bayar' }
                    ]
                ]
            }
        }
    );
});

// ================== HANDLE CALLBACK QUERY ==================
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;
    const messageId = msg.message_id;
    
    try {
        await bot.deleteMessage(chatId, messageId);
    } catch (error) {}
    
    if (data === 'batal_bayar') {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Pembayaran dibatalkan' });
        await bot.sendMessage(chatId, '✅ Pembayaran dibatalkan.');
        return;
    }
    
    if (data.startsWith('bayar_')) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Memproses pembayaran...' });
        
        const pilihan = data.replace('bayar_', '');
        
        const paket = {
            '1': { name: '1 Hari', price: 10000 },
            '3': { name: '3 Hari', price: 25000 },
            '7': { name: '7 Hari', price: 45000 },
            '30': { name: '30 Hari', price: 100000 }
        };
        
        const selected = paket[pilihan];
        if (!selected) {
            await bot.sendMessage(chatId, '❌ Pilihan tidak valid.');
            return;
        }
        
        if (isPremium(userId)) {
            await bot.sendMessage(chatId, '✅ Anda sudah premium!');
            return;
        }
        
        const loading = await bot.sendMessage(chatId, '⏳ Membuat pembayaran...');
        
        const payment = await createPakasirTransaction(selected.price, selected.name, userId);
        
        if (!payment.success) {
            await bot.deleteMessage(chatId, loading.message_id);
            await bot.sendMessage(chatId, '❌ Gagal membuat pembayaran. Error: ' + payment.error);
            return;
        }
        
        await bot.deleteMessage(chatId, loading.message_id);
        
        try {
            const qrBuffer = await QRCode.toBuffer(payment.qrString, {
                errorCorrectionLevel: 'L',
                margin: 1,
                width: 256
            });
            
            const sentMessage = await bot.sendPhoto(chatId, qrBuffer, {
                caption: 
                    `💳 PEMBAYARAN QRIS\n\n` +
                    `Paket: ${selected.name}\n` +
                    `Harga: ${formatRupiah(selected.price)}\n\n` +
                    `Order ID: ${payment.orderId}\n` +
                    `Berlaku sampai: ${payment.expiredAt} WIB\n\n` +
                    `Scan QR code di atas untuk membayar.\n` +
                    `Setelah bayar, ketik /cek ${payment.orderId}`
            });
            
            if (!db.pending_payments[payment.orderId]) {
                db.pending_payments[payment.orderId] = {};
            }
            db.pending_payments[payment.orderId].messageId = sentMessage.message_id;
            db.pending_payments[payment.orderId].chatId = chatId;
            saveDB();
            
        } catch (qrError) {
            await bot.sendMessage(chatId,
                `💳 PEMBAYARAN QRIS\n\n` +
                `Paket: ${selected.name}\n` +
                `Harga: ${formatRupiah(selected.price)}\n\n` +
                `QR Code:\n${payment.qrString}\n\n` +
                `Order ID: ${payment.orderId}\n` +
                `Berlaku sampai: ${payment.expiredAt} WIB`
            );
        }
    }
});

// ================== COMMAND /cek ==================
bot.onText(/\/cek (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const orderId = match[1].trim();
    
    const payment = db.pending_payments[orderId];
    if (!payment) {
        await bot.sendMessage(chatId, '❌ Order ID tidak ditemukan.');
        return;
    }
    
    const status = payment.status === 'paid' ? '✅ LUNAS' : '⏳ PENDING';
    const created = moment.unix(payment.created_at).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');
    
    await bot.sendMessage(chatId,
        `📋 STATUS PEMBAYARAN\n\n` +
        `Order ID: ${orderId}\n` +
        `Paket: ${payment.duration}\n` +
        `Harga: ${formatRupiah(payment.amount)}\n` +
        `Status: ${status}\n` +
        `Dibuat: ${created} WIB`
    );
    
    if (payment.status === 'paid' && payment.messageId && payment.chatId) {
        try {
            await bot.deleteMessage(payment.chatId, payment.messageId);
            delete db.pending_payments[orderId].messageId;
            saveDB();
        } catch (error) {}
    }
});

// ================== COMMAND /info ==================
bot.onText(/\/info(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username;
    
    if (!match[1]) {
        await bot.sendMessage(chatId,
            `INFO - Cara Menggunakan\n\n` +
            `Untuk mengecek akun Mobile Legends:\n` +
            `/info ID_USER ID_SERVER\n\n` +
            `Contoh:\n` +
            `/info 643461181 8554\n\n` +
            `Keterangan:\n` +
            `• ID_USER : ID akun Mobile Legends Anda\n` +
            `• ID_SERVER : ID server Anda\n\n` +
            `Contoh lengkap: /info 643461181 8554`
        );
        return;
    }
    
    const args = match[1].split(' ');
    
    if (args.length < 2) {
        await bot.sendMessage(chatId,
            `Format salah.\n\n` +
            `Gunakan: /info ID_USER ID_SERVER\n` +
            `Contoh: /info 643461181 8554`
        );
        return;
    }
    
    const targetId = args[0];
    const serverId = args[1];
    
    if (!/^\d+$/.test(targetId) || !/^\d+$/.test(serverId)) {
        await bot.sendMessage(chatId, 'ID dan Server harus berupa angka.');
        return;
    }
    
    // CEK CAPTCHA
    if (!isAdmin(userId)) {
        if (needCaptcha(userId)) {
            await sendCaptcha(chatId, userId);
            return;
        }
    }
    
    // CEK LIMIT
    const isFreeUser = !isAdmin(userId) && !isPremium(userId);
    const remaining = isFreeUser ? getRemainingLimit(userId) : 'Unlimited';
    
    if (isFreeUser && remaining <= 0) {
        await bot.sendMessage(chatId, 
            `LIMIT HABIS\n\n` +
            `Anda telah mencapai batas penggunaan gratis (10x).\n` +
            `Gunakan /langganan untuk upgrade premium.`
        );
        return;
    }
    
    const loadingMsg = await bot.sendMessage(chatId, 'Mengambil data, mohon tunggu...');
    
    try {
        const response = await axios.get(`${API_URL}?userId=${targetId}&serverId=${serverId}&role_id=${targetId}&zone_id=${serverId}`, {
            timeout: 15000
        });
        
        const data = response.data;
        
        const nickname = data.match(/\[username\] => (.*?)\s/)?.[1]?.replace(/\+/g, ' ') || 'Tidak ditemukan';
        const region = data.match(/\[region\] => (.*?)\s/)?.[1] || 'Tidak diketahui';
        const creationDate = data.match(/<td>\d+<\/td>\s*<td>\d+<\/td>\s*<td>.*?<\/td>\s*<td>(.*?)<\/td>/s)?.[1] || 'Tidak diketahui';
        
        const binds = [];
        const bindMatches = data.matchAll(/<li>(.*?) : (.*?)\.?<\/li>/g);
        for (const match of bindMatches) {
            binds.push(`• ${match[1].trim()}: ${match[2].trim()}`);
        }
        
        const deviceMatch = data.match(/Android:\s*(\d+)\s*\|\s*iOS:\s*(\d+)/);
        const android = deviceMatch?.[1] || '0';
        const ios = deviceMatch?.[2] || '0';
        
        let output = `INFORMASI AKUN MLBB\n\n`;
        output += `ID: ${targetId}\n`;
        output += `Server: ${serverId}\n`;
        output += `Nickname: ${nickname}\n`;
        output += `Tanggal Pembuatan: ${creationDate}\n`;
        output += `Region: ${region}\n\n`;
        
        if (binds.length > 0) {
            output += `AKUN TERKAIT:\n${binds.join('\n')}\n\n`;
        }
        
        output += `Device Login:\n`;
        output += `• Android: ${android} perangkat\n`;
        output += `• iOS: ${ios} perangkat`;
        
        await bot.deleteMessage(chatId, loadingMsg.message_id);
        await bot.sendMessage(chatId, output, { 
            reply_markup: {
                inline_keyboard: [[
                    { text: 'Stok Admin', url: STOK_ADMIN || 'https://t.me/stokadmin' }
                ]]
            }
        });
        
        if (isFreeUser) {
            if (!db.users[userId]) {
                db.users[userId] = { username: username, success: 0 };
            }
            db.users[userId].username = username;
            db.users[userId].success += 1;
            db.total_success += 1;
            saveDB();
        }
        
    } catch (error) {
        await bot.deleteMessage(chatId, loadingMsg.message_id);
        
        await bot.sendMessage(chatId, 
            `GAGAL MENGAMBIL DATA\n\n` +
            `Tidak dapat mengambil data akun.\n` +
            `Kemungkinan penyebab:\n` +
            `• ID atau Server salah\n` +
            `• Server sedang sibuk\n` +
            `• Koneksi bermasalah\n\n` +
            `Silakan coba lagi nanti.`,
            {
                reply_markup: {
                    inline_keyboard: [[
                        { text: 'Stok Admin', url: STOK_ADMIN || 'https://t.me/stokadmin' }
                    ]]
                }
            }
        );
    }
});

// ================== ADMIN COMMANDS ==================
bot.onText(/\/offinfo/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    db.feature.info = false;
    saveDB();
    await bot.sendMessage(msg.chat.id, 'Fitur /info telah dinonaktifkan.');
});

bot.onText(/\/oninfo/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    db.feature.info = true;
    saveDB();
    await bot.sendMessage(msg.chat.id, 'Fitur /info telah diaktifkan.');
});

bot.onText(/\/ranking/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    
    const users = Object.entries(db.users || {})
        .sort((a, b) => (b[1].success || 0) - (a[1].success || 0))
        .slice(0, 10);
    
    let message = 'TOP 10 PENGGUNA AKTIF\n\n';
    if (users.length === 0) {
        message += 'Belum ada data.';
    } else {
        users.forEach(([id, data], i) => {
            message += `${i+1}. @${data.username || 'unknown'} - ${data.success}x\n`;
        });
    }
    
    await bot.sendMessage(msg.chat.id, message);
});

bot.onText(/\/listpremium/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    
    const premium = Object.entries(db.premium || {});
    let message = 'DAFTAR USER PREMIUM\n\n';
    
    if (premium.length === 0) {
        message += 'Belum ada user premium.';
    } else {
        premium.forEach(([id, data], i) => {
            const expired = moment.unix(data.expired_at).tz('Asia/Jakarta').format('DD/MM/YYYY');
            message += `${i+1}. ID: ${id}\n`;
            message += `   Paket: ${data.duration}\n`;
            message += `   Exp: ${expired}\n\n`;
        });
    }
    
    await bot.sendMessage(msg.chat.id, message);
});

bot.onText(/\/addpremium (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    
    const args = match[1].split(' ');
    if (args.length < 2) {
        await bot.sendMessage(msg.chat.id, 'Format: /addpremium USERID DURASI\nContoh: /addpremium 123456789 30');
        return;
    }
    
    const targetId = parseInt(args[0]);
    const days = parseInt(args[1]);
    
    if (isNaN(targetId) || isNaN(days)) {
        await bot.sendMessage(msg.chat.id, 'UserID dan durasi harus angka.');
        return;
    }
    
    const now = moment().tz('Asia/Jakarta').unix();
    const expiredAt = now + (days * 24 * 60 * 60);
    
    db.premium[targetId] = {
        activated_at: now,
        expired_at: expiredAt,
        duration: `${days} Hari (Manual)`
    };
    saveDB();
    
    await bot.sendMessage(msg.chat.id, `Premium ditambahkan untuk user ${targetId} selama ${days} hari.`);
    
    try {
        await bot.sendMessage(targetId, 
            `AKUN ANDA TELAH DIUPGRADE\n\n` +
            `Sekarang Anda adalah user PREMIUM selama ${days} hari.\n` +
            `Gunakan /status untuk cek masa aktif.`
        );
    } catch (error) {}
});

// ================== MEMORY MONITOR ==================
setInterval(() => {
    const used = process.memoryUsage();
    console.log(`Memory: ${Math.round(used.heapUsed / 1024 / 1024)}MB / ${Math.round(used.heapTotal / 1024 / 1024)}MB`);
}, 5 * 60 * 1000);

// ================== ERROR HANDLER ==================
bot.on('polling_error', (error) => {
    if (error.code === 'EFATAL') {
        console.error('Fatal error, restarting...');
        process.exit(1);
    }
});

console.log('Bot started successfully!');
console.log(`Admin IDs: ${ADMIN_IDS.join(', ') || 'None'}`);
