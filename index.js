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

// ADMIN IDS
const ADMIN_IDS = process.env.ADMIN_IDS 
    ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) 
    : [];

// ================== COUNTRY MAPPING ==================
const countryMapping = {
  'AF': 'Afghanistan',
  'AL': 'Albania',
  'DZ': 'Algeria',
  'AD': 'Andorra',
  'AO': 'Angola',
  'AR': 'Argentina',
  'AM': 'Armenia',
  'AU': 'Australia',
  'AT': 'Austria',
  'AZ': 'Azerbaijan',
  'BH': 'Bahrain',
  'BD': 'Bangladesh',
  'BY': 'Belarus',
  'BE': 'Belgium',
  'BZ': 'Belize',
  'BJ': 'Benin',
  'BT': 'Bhutan',
  'BO': 'Bolivia',
  'BA': 'Bosnia and Herzegovina',
  'BW': 'Botswana',
  'BR': 'Brazil',
  'BN': 'Brunei',
  'BG': 'Bulgaria',
  'BF': 'Burkina Faso',
  'BI': 'Burundi',
  'KH': 'Cambodia',
  'CM': 'Cameroon',
  'CA': 'Canada',
  'CV': 'Cape Verde',
  'CF': 'Central African Republic',
  'TD': 'Chad',
  'CL': 'Chile',
  'CN': 'China',
  'CO': 'Colombia',
  'KM': 'Comoros',
  'CG': 'Congo',
  'CR': 'Costa Rica',
  'HR': 'Croatia',
  'CU': 'Cuba',
  'CY': 'Cyprus',
  'CZ': 'Czech Republic',
  'DK': 'Denmark',
  'DJ': 'Djibouti',
  'DO': 'Dominican Republic',
  'EC': 'Ecuador',
  'EG': 'Egypt',
  'SV': 'El Salvador',
  'GQ': 'Equatorial Guinea',
  'ER': 'Eritrea',
  'EE': 'Estonia',
  'SZ': 'Eswatini',
  'ET': 'Ethiopia',
  'FJ': 'Fiji',
  'FI': 'Finland',
  'FR': 'France',
  'GA': 'Gabon',
  'GM': 'Gambia',
  'GE': 'Georgia',
  'DE': 'Germany',
  'GH': 'Ghana',
  'GR': 'Greece',
  'GL': 'Greenland',
  'GT': 'Guatemala',
  'GN': 'Guinea',
  'GW': 'Guinea-Bissau',
  'GY': 'Guyana',
  'HT': 'Haiti',
  'HN': 'Honduras',
  'HK': 'Hong Kong',
  'HU': 'Hungary',
  'IS': 'Iceland',
  'IN': 'India',
  'ID': 'Indonesia',
  'IR': 'Iran',
  'IQ': 'Iraq',
  'IE': 'Ireland',
  'IL': 'Israel',
  'IT': 'Italy',
  'JM': 'Jamaica',
  'JP': 'Japan',
  'JO': 'Jordan',
  'KZ': 'Kazakhstan',
  'KE': 'Kenya',
  'KI': 'Kiribati',
  'KW': 'Kuwait',
  'KG': 'Kyrgyzstan',
  'LA': 'Laos',
  'LV': 'Latvia',
  'LB': 'Lebanon',
  'LS': 'Lesotho',
  'LR': 'Liberia',
  'LY': 'Libya',
  'LI': 'Liechtenstein',
  'LT': 'Lithuania',
  'LU': 'Luxembourg',
  'MG': 'Madagascar',
  'MW': 'Malawi',
  'MY': 'Malaysia',
  'MV': 'Maldives',
  'ML': 'Mali',
  'MT': 'Malta',
  'MH': 'Marshall Islands',
  'MR': 'Mauritania',
  'MU': 'Mauritius',
  'MX': 'Mexico',
  'FM': 'Micronesia',
  'MD': 'Moldova',
  'MC': 'Monaco',
  'MN': 'Mongolia',
  'ME': 'Montenegro',
  'MA': 'Morocco',
  'MZ': 'Mozambique',
  'MM': 'Myanmar',
  'NA': 'Namibia',
  'NR': 'Nauru',
  'NP': 'Nepal',
  'NL': 'Netherlands',
  'NZ': 'New Zealand',
  'NI': 'Nicaragua',
  'NE': 'Niger',
  'NG': 'Nigeria',
  'KP': 'North Korea',
  'MK': 'North Macedonia',
  'NO': 'Norway',
  'OM': 'Oman',
  'PK': 'Pakistan',
  'PW': 'Palau',
  'PS': 'Palestine',
  'PA': 'Panama',
  'PG': 'Papua New Guinea',
  'PY': 'Paraguay',
  'PE': 'Peru',
  'PH': 'Philippines',
  'PL': 'Poland',
  'PT': 'Portugal',
  'QA': 'Qatar',
  'RO': 'Romania',
  'RU': 'Russia',
  'RW': 'Rwanda',
  'WS': 'Samoa',
  'SM': 'San Marino',
  'ST': 'Sao Tome and Principe',
  'SA': 'Saudi Arabia',
  'SN': 'Senegal',
  'RS': 'Serbia',
  'SC': 'Seychelles',
  'SL': 'Sierra Leone',
  'SG': 'Singapore',
  'SK': 'Slovakia',
  'SI': 'Slovenia',
  'SB': 'Solomon Islands',
  'SO': 'Somalia',
  'ZA': 'South Africa',
  'KR': 'South Korea',
  'SS': 'South Sudan',
  'ES': 'Spain',
  'LK': 'Sri Lanka',
  'SD': 'Sudan',
  'SR': 'Suriname',
  'SE': 'Sweden',
  'CH': 'Switzerland',
  'SY': 'Syria',
  'TW': 'Taiwan',
  'TJ': 'Tajikistan',
  'TZ': 'Tanzania',
  'TH': 'Thailand',
  'TL': 'Timor-Leste',
  'TG': 'Togo',
  'TO': 'Tonga',
  'TN': 'Tunisia',
  'TR': 'Turkey',
  'TM': 'Turkmenistan',
  'TV': 'Tuvalu',
  'UG': 'Uganda',
  'UA': 'Ukraine',
  'AE': 'United Arab Emirates',
  'GB': 'United Kingdom',
  'US': 'United States',
  'UY': 'Uruguay',
  'UZ': 'Uzbekistan',
  'VU': 'Vanuatu',
  'VA': 'Vatican City',
  'VE': 'Venezuela',
  'VN': 'Vietnam',
  'YE': 'Yemen',
  'ZM': 'Zambia',
  'ZW': 'Zimbabwe'
};

// ================== FUNCTION GET MLBB DATA (GOPAY + CHECKTON) ==================
async function getMLBBData(userId, serverId) {
    const result = {
        username: null,
        region: null,
        bindAccounts: [],
        devices: { android: 0, ios: 0 },
        ttl: null,
        fromCache: false
    };
    
    try {
        // 1. AMBIL DATA DASAR DARI GOPAY (PASTI DAPAT)
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
            
            // Convert country code ke region name
            const countryCode = g.countryOrigin || "ID";
            result.region = countryMapping[countryCode] || countryCode;
            
            // 2. COBA AMBIL DATA TAMBAHAN DARI CHECKTON
            if (API_KEY_CHECKTON) {
                try {
                    const checktonResponse = await axios.post("https://checkton.online/backend/info", {
                        role_id: String(userId),
                        zone_id: String(serverId),
                        type: "bind"
                    }, {
                        headers: {
                            "Content-Type": "application/json",
                            "x-api-key": API_KEY_CHECKTON
                        },
                        timeout: 5000
                    });
                    
                    if (checktonResponse.data?.data) {
                        const c = checktonResponse.data.data;
                        
                        // Ambil device info
                        if (c.devices) {
                            result.devices.android = c.devices.android?.total || 0;
                            result.devices.ios = c.devices.ios?.total || 0;
                        }
                        
                        // Ambil bind accounts
                        if (c.bind_accounts && Array.isArray(c.bind_accounts)) {
                            result.bindAccounts = c.bind_accounts.map(b => ({
                                platform: b.platform,
                                details: b.details || 'empty.'
                            }));
                        }
                        
                        // Ambil TTL
                        result.ttl = c.ttl || null;
                    }
                } catch (checktonError) {
                    console.log("Checkton error, pakai data GoPay saja");
                }
            }
        }
        
        return result;
        
    } catch (error) {
        console.error("GoPay error:", error.message);
        
        // FALLBACK: coba Checkton langsung
        if (API_KEY_CHECKTON) {
            try {
                const checktonResponse = await axios.post("https://checkton.online/backend/info", {
                    role_id: String(userId),
                    zone_id: String(serverId),
                    type: "bind"
                }, {
                    headers: { "x-api-key": API_KEY_CHECKTON },
                    timeout: 10000
                });
                
                if (checktonResponse.data?.data) {
                    const c = checktonResponse.data.data;
                    result.username = c.nickname || "Tidak ditemukan";
                    result.region = c.region || "ID";
                    result.devices.android = c.devices?.android?.total || 0;
                    result.devices.ios = c.devices?.ios?.total || 0;
                    
                    if (c.bind_accounts && Array.isArray(c.bind_accounts)) {
                        result.bindAccounts = c.bind_accounts.map(b => ({
                            platform: b.platform,
                            details: b.details || 'empty.'
                        }));
                    }
                    
                    result.ttl = c.ttl || null;
                }
            } catch (finalError) {
                console.error("Checkton fallback error:", finalError.message);
                return null;
            }
        } else {
            return null;
        }
    }
    
    return result;
}

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

// ================== ANTI-SPAM & BAN PERMANEN ==================
let spamData = {};

function loadSpamData() {
    try {
        if (fs.existsSync('spam.json')) {
            const data = fs.readFileSync('spam.json', 'utf8');
            spamData = JSON.parse(data);
            console.log(`Loaded ${Object.keys(spamData).length} banned users`);
        } else {
            spamData = {};
            fs.writeFileSync('spam.json', JSON.stringify(spamData, null, 2));
        }
    } catch (error) {
        console.error('Error loading spam data:', error);
        spamData = {};
    }
}

function saveSpamData() {
    try {
        fs.writeFileSync('spam.json', JSON.stringify(spamData, null, 2));
    } catch (error) {
        console.error('Error saving spam data:', error);
    }
}

loadSpamData();

function isBanned(userId) {
    return spamData[userId]?.banned === true;
}

function recordInfoActivity(userId) {
    const now = Date.now();
    
    if (!spamData[userId]) {
        spamData[userId] = {
            banned: false,
            infoCount: [],
            banReason: null,
            bannedAt: null
        };
    }
    
    if (spamData[userId].banned) {
        return false;
    }
    
    spamData[userId].infoCount.push(now);
    spamData[userId].infoCount = spamData[userId].infoCount.filter(
        time => now - time < 60000
    );
    
    const infoCount = spamData[userId].infoCount.length;
    
    if (infoCount > 10) {
        spamData[userId].banned = true;
        spamData[userId].bannedAt = now;
        spamData[userId].banReason = `Spam /info: ${infoCount} kali dalam 1 menit`;
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
        spamData[userId].banReason = null;
        spamData[userId].bannedAt = null;
        saveSpamData();
        return true;
    }
    return false;
}

function addBan(userId, reason = 'Ban manual oleh admin') {
    const now = Date.now();
    if (!spamData[userId]) {
        spamData[userId] = {
            banned: false,
            infoCount: [],
            banReason: null,
            bannedAt: null
        };
    }
    spamData[userId].banned = true;
    spamData[userId].bannedAt = now;
    spamData[userId].banReason = reason;
    spamData[userId].infoCount = [];
    saveSpamData();
    return true;
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

// ================== FUNGSI CEK JOIN DENGAN DEBUG ==================
async function checkJoin(userId) {
    try {
        let isChannelMember = false;
        let isGroupMember = false;

        // Cek channel
        try {
            const channelCheck = await bot.getChatMember(CHANNEL, userId);
            console.log(`✅ Channel ${CHANNEL}: status = ${channelCheck.status}`);
            isChannelMember = ['member', 'administrator', 'creator'].includes(channelCheck.status);
        } catch (channelError) {
            console.error(`❌ Channel ${CHANNEL} error:`, channelError.message);
            if (channelError.response) {
                console.error('   Detail:', channelError.response.body);
            }
        }

        // Cek group
        try {
            const groupCheck = await bot.getChatMember(GROUP, userId);
            console.log(`✅ Group ${GROUP}: status = ${groupCheck.status}`);
            isGroupMember = ['member', 'administrator', 'creator'].includes(groupCheck.status);
        } catch (groupError) {
            console.error(`❌ Group ${GROUP} error:`, groupError.message);
            if (groupError.response) {
                console.error('   Detail:', groupError.response.body);
            }
        }

        return { channel: isChannelMember, group: isGroupMember };
    } catch (error) {
        console.error('❌ checkJoin fatal error:', error);
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
        const orderId = `${process.env.PAKASIR_SLUG || 'ncusspayment'}-${userId}-${Date.now()}`;
        
        const requestBody = {
            project: process.env.PAKASIR_SLUG || 'ncusspayment',
            order_id: orderId,
            amount: amount,
            api_key: process.env.PAKASIR_API_KEY
        };

        console.log('Creating transaction:', orderId);

        const response = await axios.post(
            `${process.env.PAKASIR_BASE_URL || 'https://app.pakasir.com/api'}/transactioncreate/qris`,
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
        const url = `${process.env.PAKASIR_BASE_URL || 'https://app.pakasir.com/api'}/transactiondetail`;
        const params = {
            project: process.env.PAKASIR_SLUG || 'ncusspayment',
            order_id: orderId,
            amount: amount,
            api_key: process.env.PAKASIR_API_KEY
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
                        `PEMBAYARAN BERHASIL\n\n` +
                        `Premium ${data.duration} telah diaktifkan.\n` +
                        `Berlaku sampai: ${moment.unix(expiredAt).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')} WIB\n\n` +
                        `Sekarang Anda bisa menggunakan /info unlimited.`
                    );
                } catch (error) {}
            }
        }
    }
});

// ================== EXPRESS SERVER (UNTUK ENDPOINT API) ==================
if (!IS_WORKER) {
    const app = express();
    const PORT = process.env.PORT || 3000;

    app.use(express.json());

    // Endpoint /tes.php untuk kompatibilitas
    app.get('/tes.php', async (req, res) => {
        const { userId, serverId, role_id, zone_id } = req.query;

        if (!userId || !serverId || !role_id || !zone_id) {
            return res.status(400).send('❌ Parameter tidak lengkap');
        }

        try {
            const data = await getMLBBData(userId, serverId);
            
            if (!data || !data.username) {
                return res.status(500).send('❌ Gagal mengambil data');
            }

            // Format output seperti tes.php sebelumnya
            let output = "";
            output += `[userId] => ${userId}\n`;
            output += `[serverId] => ${serverId}\n`;
            output += `[username] => ${data.username}\n`;
            output += `[region] => ${data.region}\n\n`;

            output += `Android: ${data.devices.android} | iOS: ${data.devices.ios}\n\n`;

            if (data.ttl) {
                output += `<table>\n`;
                output += `<tr><td>${data.ttl}</td></tr>\n`;
                output += `</table>\n\n`;
            }

            if (data.bindAccounts && data.bindAccounts.length > 0) {
                output += `<ul>\n`;
                data.bindAccounts.forEach(b => {
                    output += `<li>${b.platform} : ${b.details}</li>\n`;
                });
                output += `</ul>\n`;
            }

            res.set('Content-Type', 'text/plain');
            res.send(output);

        } catch (error) {
            console.error('Error:', error.message);
            res.status(500).send('❌ Internal Server Error');
        }
    });

    // Endpoint health check
    app.get('/', (req, res) => {
        res.send('✅ MLBB API Server is running');
    });

    app.listen(PORT, () => {
        console.log(`🌐 Web server running on port ${PORT}`);
    });

} else {
    // ================== BOT TELEGRAM ==================
    console.log('🤖 Bot worker started');

    const bot = new TelegramBot(BOT_TOKEN, { 
        polling: {
            interval: 300,
            autoStart: true,
            params: { timeout: 10 }
        }
    });

    // ================== MIDDLEWARE ==================
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const username = msg.from.username;
        const text = msg.text;
        const chatType = msg.chat.type;
        
        if (!text) return;
        
        if (chatType !== 'private') {
            return;
        }
        
        if (isAdmin(userId)) {
            return;
        }
        
        // Cek fitur info aktif
        if (text.startsWith('/info') && !db.feature.info) {
            await bot.sendMessage(chatId,
                `FITUR SEDANG NONAKTIF\n\n` +
                `Fitur /info sedang dinonaktifkan oleh administrator.\n\n` +
                `Silakan coba lagi nanti atau hubungi admin untuk informasi lebih lanjut.`,
                {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: 'Hubungi Admin', url: STOK_ADMIN || 'https://t.me/stokadmin' }
                        ]]
                    }
                }
            );
            return;
        }
        
        // Command publik tanpa cek username
        const publicCommands = ['/start', '/langganan', '/status'];
        if (publicCommands.includes(text.split(' ')[0])) {
            return;
        }
        
        // Cek username untuk command lain
        if (!username) {
            await bot.sendMessage(chatId,
                `USERNAME DIPERLUKAN\n\n` +
                `Untuk menggunakan perintah ini, Anda harus memiliki username Telegram.\n\n` +
                `Cara membuat username:\n` +
                `1. Buka menu Settings (Pengaturan)\n` +
                `2. Pilih Username\n` +
                `3. Buat username baru (minimal 5 karakter)\n` +
                `4. Simpan perubahan\n\n` +
                `Setelah memiliki username, silakan coba lagi.`
            );
            return;
        }
        
        // Cek join
        const joined = await checkJoin(userId);
        const missing = [];

        if (!joined.channel) missing.push({
            name: CHANNEL,
            text: `Bergabung ke Channel`,
            url: `https://t.me/${CHANNEL.replace('@', '')}`
        });

        if (!joined.group) missing.push({
            name: GROUP,
            text: `Bergabung ke Group`,
            url: `https://t.me/${GROUP.replace('@', '')}`
        });

        if (missing.length > 0) {
            const buttons = missing.map(item => [{
                text: item.text,
                url: item.url
            }]);
            
            let message = `AKSES TERBATAS\n\n`;
            message += `Untuk menggunakan bot ini, Anda perlu bergabung dengan:\n\n`;
            message += missing.map(item => `• ${item.name}`).join('\n');
            message += `\n\nSilakan klik tombol di bawah untuk bergabung, kemudian coba lagi.\n\n`;
            message += `Setelah bergabung, kirim ulang perintah Anda.`;
            
            await bot.sendMessage(chatId, message, {
                reply_markup: { inline_keyboard: buttons }
            });
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
        
        message += `DAFTAR PERINTAH UNTUK MEMBER:\n`;
        message += `/info ID SERVER - Cek akun Mobile Legends\n`;
        message += `Contoh: /info 123456 1234\n\n`;
        message += `/status - Cek status dan sisa limit\n`;
        message += `/langganan - Lihat paket premium\n\n`;
        
        if (isAdmin(userId)) {
            message += `PERINTAH ADMIN:\n`;
            message += `/offinfo - Nonaktifkan fitur info\n`;
            message += `/oninfo - Aktifkan fitur info\n`;
            message += `/ranking - Lihat peringkat pengguna\n`;
            message += `/listpremium - Lihat user premium\n`;
            message += `/listbanned - Lihat user yang diblokir\n`;
            message += `/addban ID [alasan] - Blokir user manual\n`;
            message += `/unban ID - Hapus blokir user\n`;
            message += `/addpremium ID DURASI - Tambah premium manual\n`;
        }
        
        await bot.sendMessage(chatId, message);
    });

    // ================== COMMAND /status ==================
    bot.onText(/\/status/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        if (isBanned(userId) && !isAdmin(userId)) {
            await bot.sendMessage(chatId,
                `STATUS AKUN\n\n` +
                `Status: BLOKIR\n\n` +
                `Detail:\n` +
                `• Alasan: ${spamData[userId]?.banReason || 'Tidak diketahui'}\n` +
                `• Tanggal blokir: ${moment(spamData[userId]?.bannedAt).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')} WIB\n\n` +
                `Anda tidak dapat menggunakan fitur /info.\n` +
                `Hubungi admin jika ada kesalahan.`
            );
            return;
        }
        
        const status = getUserStatus(userId);
        const remaining = getRemainingLimit(userId);
        
        let message = `STATUS AKUN\n\n`;
        message += `User ID: ${userId}\n`;
        message += `Tipe Akun: ${status.type}\n`;
        
        if (status.type === 'FREE') {
            message += `Limit: ${status.used}/${status.limit}\n`;
            message += `Sisa: ${remaining}\n\n`;
            
            if (status.used >= status.limit) {
                message += `Limit Anda sudah habis.\n`;
                message += `Gunakan /langganan untuk upgrade ke premium.\n`;
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

    // ================== COMMAND /langganan ==================
    bot.onText(/\/langganan/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        if (isPremium(userId)) {
            const premium = db.premium[userId];
            const expired = moment.unix(premium.expired_at).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');
            
            await bot.sendMessage(chatId,
                `ANDA SUDAH PREMIUM\n\n` +
                `Berlaku sampai: ${expired} WIB\n\n` +
                `Gunakan /status untuk detail.`
            );
            return;
        }
        
        await bot.sendMessage(chatId,
            `PAKET PREMIUM\n\n` +
            `Pilih masa aktif di bawah ini:`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '1 HARI - Rp 10.000', callback_data: 'bayar_1' }
                        ],
                        [
                            { text: '3 HARI - Rp 25.000', callback_data: 'bayar_3' }
                        ],
                        [
                            { text: '7 HARI - Rp 45.000', callback_data: 'bayar_7' }
                        ],
                        [
                            { text: '30 HARI - Rp 100.000', callback_data: 'bayar_30' }
                        ],
                        [
                            { text: 'BATAL', callback_data: 'batal_bayar' }
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
            await bot.sendMessage(chatId, 'Pembayaran dibatalkan.');
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
                await bot.sendMessage(chatId, 'Pilihan tidak valid.');
                return;
            }
            
            if (isPremium(userId)) {
                await bot.sendMessage(chatId, 'Anda sudah premium!');
                return;
            }
            
            const loading = await bot.sendMessage(chatId, 'Membuat pembayaran...');
            
            const payment = await createPakasirTransaction(selected.price, selected.name, userId);
            
            if (!payment.success) {
                await bot.deleteMessage(chatId, loading.message_id);
                await bot.sendMessage(chatId, 'Gagal membuat pembayaran. Error: ' + payment.error);
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
                        `PEMBAYARAN QRIS\n\n` +
                        `Paket: ${selected.name}\n` +
                        `Harga: ${formatRupiah(selected.price)}\n\n` +
                        `Order ID: ${payment.orderId}\n` +
                        `Berlaku sampai: ${payment.expiredAt} WIB\n\n` +
                        `Scan QR code di atas untuk membayar.\n` +
                        `Pembayaran akan diproses otomatis.`
                });
                
                if (!db.pending_payments[payment.orderId]) {
                    db.pending_payments[payment.orderId] = {};
                }
                db.pending_payments[payment.orderId].messageId = sentMessage.message_id;
                db.pending_payments[payment.orderId].chatId = chatId;
                saveDB();
                
            } catch (qrError) {
                await bot.sendMessage(chatId,
                    `PEMBAYARAN QRIS\n\n` +
                    `Paket: ${selected.name}\n` +
                    `Harga: ${formatRupiah(selected.price)}\n\n` +
                    `QR Code:\n${payment.qrString}\n\n` +
                    `Order ID: ${payment.orderId}\n` +
                    `Berlaku sampai: ${payment.expiredAt} WIB`
                );
            }
        }
    });

    // ================== COMMAND /info ==================
    bot.onText(/\/info(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const username = msg.from.username;
        
        // Cek fitur info
        if (!db.feature.info && !isAdmin(userId)) {
            console.log(`User ${userId} mencoba /info saat fitur nonaktif - diabaikan`);
            return;
        }
        
        // Cek username
        if (!username && !isAdmin(userId)) {
            console.log(`User ${userId} tanpa username mencoba /info - diabaikan`);
            return;
        }
        
        // Cek ban
        if (isBanned(userId) && !isAdmin(userId)) {
            console.log(`User ${userId} (banned) mencoba /info - diabaikan`);
            return;
        }
        
        // Cek join (pengaman, meskipun middleware sudah cek)
        const joined = await checkJoin(userId);
        const missing = [];
        if (!joined.channel) missing.push(CHANNEL);
        if (!joined.group) missing.push(GROUP);
        if (missing.length > 0 && !isAdmin(userId)) {
            console.log(`User ${userId} belum join channel/group - /info diabaikan`);
            return;
        }
        
        // Cek format
        if (!match[1]) {
            await bot.sendMessage(chatId,
                `INFORMASI PENGGUNAAN\n\n` +
                `Untuk mengecek akun Mobile Legends, gunakan format:\n` +
                `/info ID_USER ID_SERVER\n\n` +
                `Contoh:\n` +
                `/info 643461181 8554\n\n` +
                `ID_USER : ID akun Mobile Legends Anda\n` +
                `ID_SERVER : ID server Anda (4 digit)`
            );
            return;
        }
        
        const args = match[1].split(' ');
        
        if (args.length < 2) {
            await bot.sendMessage(chatId,
                `FORMAT TIDAK LENGKAP\n\n` +
                `Gunakan format:\n` +
                `/info ID_USER ID_SERVER\n\n` +
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
        
        // Cek spam
        const banned = recordInfoActivity(userId);
        if (banned) {
            console.log(`User ${userId} kena ban karena spam /info`);
            return;
        }
        
        // Cek limit
        const isFreeUser = !isAdmin(userId) && !isPremium(userId);
        const remaining = isFreeUser ? getRemainingLimit(userId) : 'Unlimited';
        
        if (isFreeUser && remaining <= 0) {
            await bot.sendMessage(chatId, 
                `BATAS PENGGUNAAN HABIS\n\n` +
                `Anda telah mencapai batas penggunaan gratis (10x).\n` +
                `Gunakan /langganan untuk upgrade ke premium.`
            );
            return;
        }
        
        // Proses ambil data
        const loadingMsg = await bot.sendMessage(chatId, 'Mengambil data, mohon tunggu...');
        
        try {
            const data = await getMLBBData(targetId, serverId);
            
            if (!data || !data.username) {
                await bot.deleteMessage(chatId, loadingMsg.message_id);
                await bot.sendMessage(chatId, 
                    `GAGAL MENGAMBIL DATA\n\n` +
                    `Tidak dapat mengambil data akun.\n` +
                    `Kemungkinan penyebab:\n` +
                    `• ID atau Server salah\n` +
                    `• Server sedang sibuk\n\n` +
                    `Silakan coba lagi nanti.`
                );
                return;
            }
            
            let output = `INFORMASI AKUN MLBB\n\n`;
            output += `ID: ${targetId}\n`;
            output += `Server: ${serverId}\n`;
            output += `Nickname: ${data.username}\n`;
            
            if (data.ttl) {
                output += `Tanggal Pembuatan: ${data.ttl}\n`;
            }
            
            output += `Region: ${data.region}\n\n`;
            
            if (data.bindAccounts && data.bindAccounts.length > 0) {
                output += `AKUN TERKAIT:\n`;
                data.bindAccounts.forEach(b => {
                    output += `• ${b.platform}: ${b.details}\n`;
                });
                output += `\n`;
            }
            
            output += `Device Login:\n`;
            output += `• Android: ${data.devices.android} perangkat\n`;
            output += `• iOS: ${data.devices.ios} perangkat`;
            
            await bot.deleteMessage(chatId, loadingMsg.message_id);
            await bot.sendMessage(chatId, output, { 
                reply_markup: {
                    inline_keyboard: [[
                        { text: 'Stok Admin', url: STOK_ADMIN || 'https://t.me/stokadmin' }
                    ]]
                }
            });
            
            // Update limit
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
                `Silakan coba lagi nanti.`
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
        
        let message = 'PERINGKAT PENGGUNA AKTIF\n\n';
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
                message += `   Berlaku hingga: ${expired}\n\n`;
            });
        }
        
        await bot.sendMessage(msg.chat.id, message);
    });

    bot.onText(/\/listbanned/, async (msg) => {
        if (!isAdmin(msg.from.id)) return;
        
        const bannedUsers = Object.entries(spamData)
            .filter(([_, data]) => data.banned)
            .map(([id, data]) => {
                const date = moment(data.bannedAt).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');
                return `• ${id} - ${data.banReason || 'Tidak ada alasan'} (${date})`;
            });
        
        let message = `DAFTAR USER BLOKIR\n\n`;
        if (bannedUsers.length === 0) {
            message += 'Tidak ada user yang diblokir.';
        } else {
            message += bannedUsers.join('\n');
        }
        
        await bot.sendMessage(msg.chat.id, message);
    });

    bot.onText(/\/addban(?:\s+(\d+)(?:\s+(.+))?)?/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return;
        
        if (!match[1]) {
            await bot.sendMessage(msg.chat.id, 'Format: /addban ID_USER [alasan]');
            return;
        }
        
        const targetId = parseInt(match[1]);
        const reason = match[2] || 'Ban manual oleh admin';
        
        if (addBan(targetId, reason)) {
            await bot.sendMessage(msg.chat.id, `User ${targetId} telah diblokir.\nAlasan: ${reason}`);
        } else {
            await bot.sendMessage(msg.chat.id, `Gagal memblokir user ${targetId}.`);
        }
    });

    bot.onText(/\/unban (.+)/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return;
        
        const targetId = parseInt(match[1].trim());
        if (isNaN(targetId)) {
            await bot.sendMessage(msg.chat.id, 'Format: /unban ID_USER');
            return;
        }
        
        if (unbanUser(targetId)) {
            await bot.sendMessage(msg.chat.id, `User ${targetId} telah dibuka blokirnya.`);
        } else {
            await bot.sendMessage(msg.chat.id, `User ${targetId} tidak ditemukan.`);
        }
    });

    bot.onText(/\/addpremium (.+)/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return;
        
        const args = match[1].split(' ');
        if (args.length < 2) {
            await bot.sendMessage(msg.chat.id, 'Format: /addpremium ID_USER DURASI\nContoh: /addpremium 123456789 30');
            return;
        }
        
        const targetId = parseInt(args[0]);
        const days = parseInt(args[1]);
        
        if (isNaN(targetId) || isNaN(days)) {
            await bot.sendMessage(msg.chat.id, 'ID User dan durasi harus angka.');
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

    console.log('🤖 Bot started successfully!');
    console.log(`Admin IDs: ${ADMIN_IDS.join(', ') || 'None'}`);
}
