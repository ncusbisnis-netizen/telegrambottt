const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const moment = require('moment-timezone');
const cron = require('node-cron');
const QRCode = require('qrcode');

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

// ============ ⚠️ YANG WAJIB DIGANTI! =============
// Daftar ID admin (pisah dengan koma)
// Contoh: [7268861803, 123456789]
const ADMIN_IDS = [7268861803];  // <--- GANTI DENGAN ID TELEGRAM ANDA!
// ==================================================

// Validasi
if (!BOT_TOKEN || !API_URL || !CHANNEL || !GROUP) {
    console.error('❌ Missing required environment variables!');
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

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
        } else {
            fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
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
                timeout: 30000
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
        console.error('Check transaction error:', error.message);
        return 'pending';
    }
}

// ================== AUTO CHECK PAYMENT ==================
cron.schedule('*/30 * * * * *', async () => {
    for (const [orderId, data] of Object.entries(db.pending_payments || {})) {
        if (data.status === 'pending') {
            const now = moment().tz('Asia/Jakarta').unix();
            
            if (data.expired_at < now) {
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
    
    if (isAdmin(userId)) {
        await bot.sendMessage(chatId,
            `👑 *ADMIN MODE*\n\n` +
            `Perintah:\n` +
            `/info USER SERVER\n` +
            `/offinfo\n` +
            `/oninfo\n` +
            `/ranking\n` +
            `/status\n` +
            `/listpremium\n` +
            `/addpremium USERID DURASI`,
            { parse_mode: 'Markdown' }
        );
    } else {
        await bot.sendMessage(chatId,
            `👋 *Welcome to MLBB Info Bot!*\n\n` +
            `Gunakan:\n` +
            `/info USER_ID SERVER_ID\n` +
            `/status\n` +
            `/langganan`,
            { parse_mode: 'Markdown' }
        );
    }
});

// ================== COMMAND /status ==================
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const status = getUserStatus(userId);
    const remaining = getRemainingLimit(userId);
    
    let message = `📊 *STATUS AKUN*\n\n`;
    message += `User ID: \`${userId}\`\n`;
    message += `Tipe: *${status.type}*\n`;
    
    if (status.type === '🆓 FREE') {
        message += `Limit: ${status.used}/${status.limit}\n`;
        message += `Sisa: ${remaining}\n`;
        
        if (status.used >= status.limit) {
            message += `\n⚠️ *Limit habis!*\nGunakan /langganan`;
        }
    } else {
        message += `Limit: *Unlimited*\n`;
        
        if (status.type === '💎 PREMIUM') {
            const premium = db.premium[userId];
            const expired = moment.unix(premium.expired_at).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');
            message += `Berlaku sampai: ${expired} WIB\n`;
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
            `Berlaku sampai: ${expired} WIB`,
            { parse_mode: 'Markdown' }
        );
        return;
    }
    
    await bot.sendMessage(chatId,
        `💎 *PAKET PREMIUM*\n\n` +
        `/bayar 1 - 1 Hari (Rp 10.000)\n` +
        `/bayar 3 - 3 Hari (Rp 25.000)\n` +
        `/bayar 7 - 7 Hari (Rp 45.000)\n` +
        `/bayar 30 - 30 Hari (Rp 100.000)`,
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
    
    try {
        const qrBuffer = await QRCode.toBuffer(payment.qrString);
        
        await bot.sendPhoto(chatId, qrBuffer, {
            caption: 
                `💳 *PEMBAYARAN QRIS*\n\n` +
                `Paket: *${selected.name}*\n` +
                `Harga: *${formatRupiah(selected.price)}*\n\n` +
                `*Order ID:* \`${payment.orderId}\`\n` +
                `⏳ *Berlaku sampai:* ${payment.expiredAt} WIB\n\n` +
                `Gunakan /cek ${payment.orderId} untuk cek status`,
            parse_mode: 'Markdown'
        });
    } catch (qrError) {
        await bot.sendMessage(chatId,
            `💳 *PEMBAYARAN QRIS*\n\n` +
            `Paket: *${selected.name}*\n` +
            `Harga: *${formatRupiah(selected.price)}*\n\n` +
            `Scan: \`${payment.qrString}\`\n\n` +
            `*Order ID:* \`${payment.orderId}\``,
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
        `Order ID: \`${orderId}\`\n` +
        `Paket: ${payment.duration}\n` +
        `Status: ${status}\n` +
        `Dibuat: ${created} WIB`,
        { parse_mode: 'Markdown' }
    );
});

// ================== COMMAND /info ==================
bot.onText(/\/info (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const args = match[1].split(' ');
    
    if (args.length < 2) {
        await bot.sendMessage(chatId, '❌ Format: /info ID SERVER');
        return;
    }
    
    const targetId = args[0];
    const serverId = args[1];
    
    if (!/^\d+$/.test(targetId) || !/^\d+$/.test(serverId)) {
        await bot.sendMessage(chatId, '❌ ID dan Server harus angka!');
        return;
    }
    
    if (!isAdmin(userId) && !isPremium(userId)) {
        const remaining = getRemainingLimit(userId);
        if (remaining <= 0) {
            await bot.sendMessage(chatId, '⚠️ Limit habis! /langganan');
            return;
        }
    }
    
    const loadingMsg = await bot.sendMessage(chatId, '⏳ Mengambil data...');
    
    try {
        const response = await axios.get(`${API_URL}?userId=${targetId}&serverId=${serverId}`);
        const data = response.data;
        
        const nickname = data.match(/\[username\] => (.*?)\s/)?.[1]?.replace(/\+/g, ' ') || '-';
        
        let output = `✧ ID: ${targetId}\n`;
        output += `✧ Server: ${serverId}\n`;
        output += `✧ Nickname: ${nickname}\n`;
        
        await bot.deleteMessage(chatId, loadingMsg.message_id);
        await bot.sendMessage(chatId, output);
        
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
        await bot.sendMessage(chatId, '❌ Gagal mengambil data');
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
    
    let message = '🏆 *RANKING*\n\n';
    users.forEach(([id, data], i) => {
        message += `${i+1}. @${data.username || 'unknown'} - ${data.success}x\n`;
    });
    
    await bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/listpremium/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    
    const premium = Object.entries(db.premium || {}).map(([id, data]) => ({ id, ...data }));
    let message = '👑 *PREMIUM USERS*\n\n';
    
    premium.forEach((user, i) => {
        const expired = moment.unix(user.expired_at).tz('Asia/Jakarta').format('DD/MM/YYYY');
        message += `${i+1}. \`${user.id}\` - ${user.duration}\n   Exp: ${expired}\n\n`;
    });
    
    await bot.sendMessage(msg.chat.id, message || 'Belum ada user premium', { parse_mode: 'Markdown' });
});

bot.onText(/\/addpremium (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    
    const args = match[1].split(' ');
    if (args.length < 2) return;
    
    const targetId = parseInt(args[0]);
    const days = parseInt(args[1]);
    
    const now = moment().tz('Asia/Jakarta').unix();
    const expiredAt = now + (days * 24 * 60 * 60);
    
    db.premium[targetId] = {
        activated_at: now,
        expired_at: expiredAt,
        duration: `${days} Hari`
    };
    saveDB();
    
    await bot.sendMessage(msg.chat.id, `✅ Premium added for ${targetId}`);
    
    try {
        await bot.sendMessage(targetId, `🎉 Anda sekarang PREMIUM selama ${days} hari!`);
    } catch (error) {}
});

console.log('✅ Bot started!');
console.log(`👑 Admin IDs: ${ADMIN_IDS.join(', ')}`);
