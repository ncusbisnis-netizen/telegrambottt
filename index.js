const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const moment = require('moment-timezone');
const cron = require('node-cron');
const QRCode = require('qrcode');

// ============ OPTIMASI MEMORY UNTUK HEROKU ============
// Batasi memory usage
process.env.NODE_OPTIONS = '--max-old-space-size=256';

// Optimasi axios - kurangi memory
axios.defaults.timeout = 15000; // 15 detik timeout
axios.defaults.maxContentLength = 1024 * 512; // 512KB max response
axios.defaults.maxRedirects = 3;

// Cache untuk menyimpan hasil sementara
const cache = {
    info: {},
    qr: {}
};

// Bersihkan cache setiap 1 jam
setInterval(() => {
    cache.info = {};
    cache.qr = {};
}, 60 * 60 * 1000);
// =======================================================

// ================== CONFIG DARI ENV ==================
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_URL = process.env.API_URL;
const CHANNEL = process.env.CHANNEL;
const GROUP = process.env.GROUP;
const STOK_ADMIN = process.env.STOK_ADMIN;

// PAKASIR CONFIG
const PAKASIR_SLUG = process.env.PAKASIR_SLUG;
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY;
const PAKASIR_BASE_URL = process.env.PAKASIR_BASE_URL || 'https://app.pakasir.com/api';

// ================== ADMIN IDS DARI ENV ==================
const ADMIN_IDS = process.env.ADMIN_IDS 
    ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) 
    : [];

console.log('👑 Admin IDs:', ADMIN_IDS);
console.log('🚀 Starting bot with memory limit: 256MB');

// Validasi config minimal
if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN tidak ditemukan!');
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { 
    polling: true,
    // Optimasi polling
    polling: {
        interval: 300, // 300ms interval
        autoStart: true,
        params: {
            timeout: 10
        }
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
            console.log(`📊 Database loaded: ${Object.keys(db.users).length} users, ${Object.keys(db.premium).length} premium`);
        } else {
            fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
            console.log('📁 Database baru dibuat');
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
    if (isAdmin(userId)) return { type: '👑 ADMIN', limit: 'Unlimited' };
    if (isPremium(userId)) return { type: '💎 PREMIUM', limit: 'Unlimited' };
    return { type: '🆓 FREE', limit: 10, used: db.users[userId]?.success || 0 };
}

function getRemainingLimit(userId) {
    const status = getUserStatus(userId);
    if (status.type !== '🆓 FREE') return 'Unlimited';
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

        console.log('📤 Creating transaction:', orderId);

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
// Cron job setiap 1 menit (lebih hemat memory)
cron.schedule('* * * * *', async () => {
    for (const [orderId, data] of Object.entries(db.pending_payments || {})) {
        if (data.status === 'pending') {
            const now = moment().tz('Asia/Jakarta').unix();
            
            // Hapus jika expired
            if (data.expired_at < now) {
                delete db.pending_payments[orderId];
                saveDB();
                continue;
            }

            // Cek status
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
                
                try {
                    await bot.sendMessage(userId, 
                        `✅ *Pembayaran Berhasil!*\n\n` +
                        `Premium *${data.duration}* telah diaktifkan.\n` +
                        `Berlaku sampai: ${moment.unix(expiredAt).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')} WIB`,
                        { parse_mode: 'Markdown' }
                    );
                } catch (error) {}
            }
        }
    }
});

// ================== COMMAND /start ==================
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const status = getUserStatus(userId);
    
    let message = `👋 *Welcome to MLBB Info Bot!*\n\n`;
    message += `📊 *Status:* ${status.type}\n`;
    
    if (status.type === '🆓 FREE') {
        message += `📈 *Sisa limit:* ${status.used}/${status.limit}\n\n`;
    } else {
        message += `✨ *Akses:* Unlimited\n\n`;
    }
    
    message += `*Perintah:*\n`;
    message += `/info ID SERVER - Cek akun MLBB\n`;
    message += `/status - Cek status akun\n`;
    message += `/langganan - Lihat paket premium\n`;
    
    if (isAdmin(userId)) {
        message += `\n👑 *Admin:*\n/ranking\n/listpremium\n/addpremium`;
    }
    
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// ================== COMMAND /status ==================
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const status = getUserStatus(userId);
    const remaining = getRemainingLimit(userId);
    
    let message = `📊 *STATUS AKUN*\n\n`;
    message += `🆔 ID: \`${userId}\`\n`;
    message += `📌 Tipe: *${status.type}*\n`;
    
    if (status.type === '🆓 FREE') {
        message += `📊 Limit: ${status.used}/${status.limit}\n`;
        message += `✨ Sisa: ${remaining}\n`;
        
        if (status.used >= status.limit) {
            message += `\n⚠️ *Limit habis!*\nGunakan /langganan untuk upgrade`;
        }
    } else {
        message += `✨ Akses: *Unlimited*\n`;
        
        if (status.type === '💎 PREMIUM') {
            const premium = db.premium[userId];
            const expired = moment.unix(premium.expired_at).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');
            message += `⏳ Berlaku sampai: ${expired} WIB\n`;
        }
    }
    
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// ================== COMMAND /langganan ==================
bot.onText(/\/langganan/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (isPremium(userId)) {
        const premium = db.premium[userId];
        const expired = moment.unix(premium.expired_at).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');
        
        await bot.sendMessage(chatId,
            `✅ *Anda sudah premium!*\n\n` +
            `⏳ Berlaku sampai: ${expired} WIB`,
            { parse_mode: 'Markdown' }
        );
        return;
    }
    
    await bot.sendMessage(chatId,
        `💎 *PAKET PREMIUM*\n\n` +
        `📦 /bayar 1 - 1 Hari (Rp 10.000)\n` +
        `📦 /bayar 3 - 3 Hari (Rp 25.000)\n` +
        `📦 /bayar 7 - 7 Hari (Rp 45.000)\n` +
        `📦 /bayar 30 - 30 Hari (Rp 100.000)\n\n` +
        `✅ Unlimited akses /info\n` +
        `✅ Prioritas response`,
        { parse_mode: 'Markdown' }
    );
});

// ================== COMMAND /bayar ==================
bot.onText(/\/bayar (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const pilihan = match[1].trim();
    
    if (isPremium(userId)) {
        await bot.sendMessage(chatId, '✅ Anda sudah premium!');
        return;
    }
    
    const paket = {
        '1': { name: '1 Hari', price: 10000 },
        '3': { name: '3 Hari', price: 25000 },
        '7': { name: '7 Hari', price: 45000 },
        '30': { name: '30 Hari', price: 100000 }
    };
    
    const selected = paket[pilihan];
    if (!selected) {
        await bot.sendMessage(chatId, '❌ Pilihan tidak valid. Gunakan: 1, 3, 7, atau 30');
        return;
    }
    
    const loading = await bot.sendMessage(chatId, '⏳ Membuat pembayaran...');
    
    const payment = await createPakasirTransaction(selected.price, selected.name, userId);
    
    if (!payment.success) {
        await bot.deleteMessage(chatId, loading.message_id);
        await bot.sendMessage(chatId, '❌ Gagal: ' + payment.error);
        return;
    }
    
    await bot.deleteMessage(chatId, loading.message_id);
    
    // Simpan QR di cache
    cache.qr[payment.orderId] = payment.qrString;
    
    try {
        // Generate QR dengan kualitas rendah untuk hemat memory
        const qrBuffer = await QRCode.toBuffer(payment.qrString, {
            errorCorrectionLevel: 'L',
            margin: 1,
            width: 256
        });
        
        await bot.sendPhoto(chatId, qrBuffer, {
            caption: 
                `💳 *PEMBAYARAN QRIS*\n\n` +
                `📦 Paket: *${selected.name}*\n` +
                `💰 Harga: *${formatRupiah(selected.price)}*\n\n` +
                `🆔 Order: \`${payment.orderId}\`\n` +
                `⏳ Berlaku: ${payment.expiredAt} WIB\n\n` +
                `✅ Scan QR di atas untuk bayar\n` +
                `🔄 Ketik /cek ${payment.orderId} untuk cek status`,
            parse_mode: 'Markdown'
        });
    } catch (qrError) {
        await bot.sendMessage(chatId,
            `💳 *PEMBAYARAN QRIS*\n\n` +
            `📦 Paket: *${selected.name}*\n` +
            `💰 Harga: *${formatRupiah(selected.price)}*\n\n` +
            `🔍 QR Code:\n\`${payment.qrString}\`\n\n` +
            `🆔 Order: \`${payment.orderId}\`\n` +
            `⏳ Berlaku: ${payment.expiredAt} WIB`,
            { parse_mode: 'Markdown' }
        );
    }
});

// ================== COMMAND /cek ==================
bot.onText(/\/cek (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const orderId = match[1].trim();
    
    const payment = db.pending_payments[orderId];
    if (!payment) {
        await bot.sendMessage(chatId, '❌ Order ID tidak ditemukan');
        return;
    }
    
    const status = payment.status === 'paid' ? '✅ LUNAS' : '⏳ PENDING';
    const created = moment.unix(payment.created_at).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');
    
    await bot.sendMessage(chatId,
        `📋 *STATUS PEMBAYARAN*\n\n` +
        `🆔 Order: \`${orderId}\`\n` +
        `📦 Paket: ${payment.duration}\n` +
        `💰 Harga: ${formatRupiah(payment.amount)}\n` +
        `📌 Status: ${status}\n` +
        `📅 Dibuat: ${created} WIB`,
        { parse_mode: 'Markdown' }
    );
});

// ================== COMMAND /info ==================
bot.onText(/\/info (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const args = match[1].split(' ');
    
    if (args.length < 2) {
        await bot.sendMessage(chatId, '❌ Format: /info ID SERVER\nContoh: /info 123456 1234');
        return;
    }
    
    const targetId = args[0];
    const serverId = args[1];
    
    if (!/^\d+$/.test(targetId) || !/^\d+$/.test(serverId)) {
        await bot.sendMessage(chatId, '❌ ID dan Server harus angka!');
        return;
    }
    
    // Cek limit
    if (!isAdmin(userId) && !isPremium(userId)) {
        const remaining = getRemainingLimit(userId);
        if (remaining <= 0) {
            await bot.sendMessage(chatId, 
                '⚠️ *Limit habis!*\nGunakan /langganan untuk upgrade premium.',
                { parse_mode: 'Markdown' }
            );
            return;
        }
    }
    
    // Cek cache
    const cacheKey = `${targetId}:${serverId}`;
    if (cache.info[cacheKey]) {
        await bot.sendMessage(chatId, cache.info[cacheKey]);
        return;
    }
    
    const loadingMsg = await bot.sendMessage(chatId, '⏳ Mengambil data...');
    
    try {
        const response = await axios.get(`${API_URL}?userId=${targetId}&serverId=${serverId}`, {
            timeout: 10000
        });
        
        const data = response.data;
        
        // Parse sederhana
        const nickname = data.match(/\[username\] => (.*?)\s/)?.[1]?.replace(/\+/g, ' ') || '-';
        const region = data.match(/\[region\] => (.*?)\s/)?.[1] || '-';
        
        let output = `📱 *INFO AKUN MLBB*\n\n`;
        output += `🆔 ID: ${targetId}\n`;
        output += `🌍 Server: ${serverId}\n`;
        output += `👤 Nickname: ${nickname}\n`;
        output += `📍 Region: ${region}\n`;
        
        // Simpan di cache
        cache.info[cacheKey] = output;
        
        await bot.deleteMessage(chatId, loadingMsg.message_id);
        await bot.sendMessage(chatId, output, { 
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '🛒 Stok Admin', url: STOK_ADMIN || 'https://t.me/stokadmin' }
                ]]
            }
        });
        
        // Update statistik
        if (!isAdmin(userId) && !isPremium(userId)) {
            if (!db.users[userId]) {
                db.users[userId] = { username: msg.from.username, success: 0 };
            }
            db.users[userId].success += 1;
            db.total_success += 1;
            saveDB();
        }
        
    } catch (error) {
        await bot.deleteMessage(chatId, loadingMsg.message_id);
        await bot.sendMessage(chatId, '❌ Gagal mengambil data. Coba lagi nanti.');
    }
});

// ================== ADMIN COMMANDS ==================
bot.onText(/\/offinfo/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    db.feature.info = false;
    saveDB();
    await bot.sendMessage(msg.chat.id, '🚫 Fitur info dinonaktifkan');
});

bot.onText(/\/oninfo/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    db.feature.info = true;
    saveDB();
    await bot.sendMessage(msg.chat.id, '✅ Fitur info diaktifkan');
});

bot.onText(/\/ranking/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    
    const users = Object.entries(db.users || {})
        .sort((a, b) => (b[1].success || 0) - (a[1].success || 0))
        .slice(0, 10);
    
    let message = '🏆 *TOP 10 RANKING*\n\n';
    if (users.length === 0) {
        message += 'Belum ada data';
    } else {
        users.forEach(([id, data], i) => {
            message += `${i+1}. @${data.username || 'unknown'} - ${data.success}x\n`;
        });
    }
    
    await bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/listpremium/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    
    const premium = Object.entries(db.premium || {});
    let message = '👑 *PREMIUM USERS*\n\n';
    
    if (premium.length === 0) {
        message += 'Belum ada user premium';
    } else {
        premium.forEach(([id, data], i) => {
            const expired = moment.unix(data.expired_at).tz('Asia/Jakarta').format('DD/MM/YYYY');
            message += `${i+1}. \`${id}\` - ${data.duration}\n   ⏳ Exp: ${expired}\n\n`;
        });
    }
    
    await bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/addpremium (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    
    const args = match[1].split(' ');
    if (args.length < 2) {
        await bot.sendMessage(msg.chat.id, '❌ Format: /addpremium USERID DURASI');
        return;
    }
    
    const targetId = parseInt(args[0]);
    const days = parseInt(args[1]);
    
    if (isNaN(targetId) || isNaN(days)) {
        await bot.sendMessage(msg.chat.id, '❌ UserID dan durasi harus angka');
        return;
    }
    
    const now = moment().tz('Asia/Jakarta').unix();
    const expiredAt = now + (days * 24 * 60 * 60);
    
    db.premium[targetId] = {
        activated_at: now,
        expired_at: expiredAt,
        duration: `${days} Hari`
    };
    saveDB();
    
    await bot.sendMessage(msg.chat.id, `✅ Premium added for user \`${targetId}\` (${days} hari)`);
    
    try {
        await bot.sendMessage(targetId, 
            `🎉 *Selamat!*\n\n` +
            `Akun Anda telah di-upgrade ke *PREMIUM* selama ${days} hari oleh admin.\n` +
            `Gunakan /status untuk cek masa aktif.`,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {}
});

// ================== ERROR HANDLER ==================
bot.on('polling_error', (error) => {
    if (error.code === 'EFATAL') {
        console.error('Fatal error, restarting...');
        process.exit(1);
    }
});

// Memory usage monitor
setInterval(() => {
    const used = process.memoryUsage();
    console.log(`📊 Memory: ${Math.round(used.heapUsed / 1024 / 1024)}MB / ${Math.round(used.heapTotal / 1024 / 1024)}MB`);
}, 5 * 60 * 1000); // Setiap 5 menit

console.log('✅ Bot started with optimasi memory!');
console.log(`👑 Admin IDs: ${ADMIN_IDS.join(', ') || 'Tidak ada'}`);
