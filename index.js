const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const moment = require('moment-timezone');
const cron = require('node-cron');
const QRCode = require('qrcode');
const { Pool } = require('pg'); // <-- TAMBAHKAN INI

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

// ================== REGION ONLY INDONESIA ==================
const countryMapping = {
    'AF': '🇦🇫 Afghanistan',
  'AX': '🇦🇽 Åland Islands',
  'AL': '🇦🇱 Albania',
  'DZ': '🇩🇿 Algeria',
  'AS': '🇦🇸 American Samoa',
  'AD': '🇦🇩 Andorra',
  'AO': '🇦🇴 Angola',
  'AI': '🇦🇮 Anguilla',
  'AQ': '🇦🇶 Antarctica',
  'AG': '🇦🇬 Antigua and Barbuda',
  'AR': '🇦🇷 Argentina',
  'AM': '🇦🇲 Armenia',
  'AW': '🇦🇼 Aruba',
  'AU': '🇦🇺 Australia',
  'AT': '🇦🇹 Austria',
  'AZ': '🇦🇿 Azerbaijan',
  'BS': '🇧🇸 Bahamas',
  'BH': '🇧🇭 Bahrain',
  'BD': '🇧🇩 Bangladesh',
  'BB': '🇧🇧 Barbados',
  'BY': '🇧🇾 Belarus',
  'BE': '🇧🇪 Belgium',
  'BZ': '🇧🇿 Belize',
  'BJ': '🇧🇯 Benin',
  'BM': '🇧🇲 Bermuda',
  'BT': '🇧🇹 Bhutan',
  'BO': '🇧🇴 Bolivia, Plurinational State of bolivia',
  'BA': '🇧🇦 Bosnia and Herzegovina',
  'BW': '🇧🇼 Botswana',
  'BV': '🇧🇻 Bouvet Island',
  'BR': '🇧🇷 Brazil',
  'IO': '🇮🇴 British Indian Ocean Territory',
  'BN': '🇧🇳 Brunei Darussalam',
  'BG': '🇧🇬 Bulgaria',
  'BF': '🇧🇫 Burkina Faso',
  'BI': '🇧🇮 Burundi',
  'KH': '🇰🇭 Cambodia',
  'CM': '🇨🇲 Cameroon',
  'CA': '🇨🇦 Canada',
  'CV': '🇨🇻 Cape Verde',
  'KY': '🇰🇾 Cayman Islands',
  'CF': '🇨🇫 Central African Republic',
  'TD': '🇹🇩 Chad',
  'CL': '🇨🇱 Chile',
  'CN': '🇨🇳 China',
  'CX': '🇨🇽 Christmas Island',
  'CC': '🇨🇨 Cocos (Keeling) Islands',
  'CO': '🇨🇴 Colombia',
  'KM': '🇰🇲 Comoros',
  'CG': '🇨🇬 Congo',
  'CD': '🇨🇩 Congo, The Democratic Republic of the Congo',
  'CK': '🇨🇰 Cook Islands',
  'CR': '🇨🇷 Costa Rica',
  'CI': "🇨🇮 Cote d'Ivoire",
  'HR': '🇭🇷 Croatia',
  'CU': '🇨🇺 Cuba',
  'CY': '🇨🇾 Cyprus',
  'CZ': '🇨🇿 Czech Republic',
  'DK': '🇩🇰 Denmark',
  'DJ': '🇩🇯 Djibouti',
  'DM': '🇩🇲 Dominica',
  'DO': '🇩🇴 Dominican Republic',
  'EC': '🇪🇨 Ecuador',
  'EG': '🇪🇬 Egypt',
  'SV': '🇸🇻 El Salvador',
  'GQ': '🇬🇶 Equatorial Guinea',
  'ER': '🇪🇷 Eritrea',
  'EE': '🇪🇪 Estonia',
  'ET': '🇪🇹 Ethiopia',
  'FK': '🇫🇰 Falkland Islands (Malvinas)',
  'FO': '🇫🇴 Faroe Islands',
  'FJ': '🇫🇯 Fiji',
  'FI': '🇫🇮 Finland',
  'FR': '🇫🇷 France',
  'GF': '🇬🇫 French Guiana',
  'PF': '🇵🇫 French Polynesia',
  'TF': '🇹🇫 French Southern Territories',
  'GA': '🇬🇦 Gabon',
  'GM': '🇬🇲 Gambia',
  'GE': '🇬🇪 Georgia',
  'DE': '🇩🇪 Germany',
  'GH': '🇬🇭 Ghana',
  'GI': '🇬🇮 Gibraltar',
  'GR': '🇬🇷 Greece',
  'GL': '🇬🇱 Greenland',
  'GD': '🇬🇩 Grenada',
  'GP': '🇬🇵 Guadeloupe',
  'GU': '🇬🇺 Guam',
  'GT': '🇬🇹 Guatemala',
  'GG': '🇬🇬 Guernsey',
  'GN': '🇬🇳 Guinea',
  'GW': '🇬🇼 Guinea-Bissau',
  'GY': '🇬🇾 Guyana',
  'HT': '🇭🇹 Haiti',
  'HM': '🇭🇲 Heard Island and Mcdonald Islands',
  'VA': '🇻🇦 Holy See (Vatican City State)',
  'HN': '🇭🇳 Honduras',
  'HK': '🇭🇰 Hong Kong',
  'HU': '🇭🇺 Hungary',
  'IS': '🇮🇸 Iceland',
  'IN': '🇮🇳 India',
  'ID': '🇮🇩 Indonesia',
  'IR': '🇮🇷 Iran, Islamic Republic of Persian Gulf',
  'IQ': '🇮🇶 Iraq',
  'IE': '🇮🇪 Ireland',
  'IM': '🇮🇲 Isle of Man',
  'IL': '🇮🇱 Israel',
  'IT': '🇮🇹 Italy',
  'JM': '🇯🇲 Jamaica',
  'JP': '🇯🇵 Japan',
  'JE': '🇯🇪 Jersey',
  'JO': '🇯🇴 Jordan',
  'KZ': '🇰🇿 Kazakhstan',
  'KE': '🇰🇪 Kenya',
  'KI': '🇰🇮 Kiribati',
  'KP': "🇰🇵 Korea, Democratic People's Republic of Korea",
  'KR': '🇰🇷 Korea, Republic of South Korea',
  'XK': '🇽🇰 Kosovo',
  'KW': '🇰🇼 Kuwait',
  'KG': '🇰🇬 Kyrgyzstan',
  'LA': '🇱🇦 Laos',
  'LV': '🇱🇻 Latvia',
  'LB': '🇱🇧 Lebanon',
  'LS': '🇱🇸 Lesotho',
  'LR': '🇱🇷 Liberia',
  'LY': '🇱🇾 Libyan Arab Jamahiriya',
  'LI': '🇱🇮 Liechtenstein',
  'LT': '🇱🇹 Lithuania',
  'LU': '🇱🇺 Luxembourg',
  'MO': '🇲🇴 Macao',
  'MK': '🇲🇰 Macedonia',
  'MG': '🇲🇬 Madagascar',
  'MW': '🇲🇼 Malawi',
  'MY': '🇲🇾 Malaysia',
  'MV': '🇲🇻 Maldives',
  'ML': '🇲🇱 Mali',
  'MT': '🇲🇹 Malta',
  'MH': '🇲🇭 Marshall Islands',
  'MQ': '🇲🇶 Martinique',
  'MR': '🇲🇷 Mauritania',
  'MU': '🇲🇺 Mauritius',
  'YT': '🇾🇹 Mayotte',
  'MX': '🇲🇽 Mexico',
  'FM': '🇫🇲 Micronesia, Federated States of Micronesia',
  'MD': '🇲🇩 Moldova',
  'MC': '🇲🇨 Monaco',
  'MN': '🇲🇳 Mongolia',
  'ME': '🇲🇪 Montenegro',
  'MS': '🇲🇸 Montserrat',
  'MA': '🇲🇦 Morocco',
  'MZ': '🇲🇿 Mozambique',
  'MM': '🇲🇲 Myanmar',
  'NA': '🇳🇦 Namibia',
  'NR': '🇳🇷 Nauru',
  'NP': '🇳🇵 Nepal',
  'NL': '🇳🇱 Netherlands',
  'AN': 'Netherlands Antilles',
  'NC': '🇳🇨 New Caledonia',
  'NZ': '🇳🇿 New Zealand',
  'NI': '🇳🇮 Nicaragua',
  'NE': '🇳🇪 Niger',
  'NG': '🇳🇬 Nigeria',
  'NU': '🇳🇺 Niue',
  'NF': '🇳🇫 Norfolk Island',
  'MP': '🇲🇵 Northern Mariana Islands',
  'NO': '🇳🇴 Norway',
  'OM': '🇴🇲 Oman',
  'PK': '🇵🇰 Pakistan',
  'PW': '🇵🇼 Palau',
  'PS': '🇵🇸 Palestinian Territory, Occupied',
  'PA': '🇵🇦 Panama',
  'PG': '🇵🇬 Papua New Guinea',
  'PY': '🇵🇾 Paraguay',
  'PE': '🇵🇪 Peru',
  'PH': '🇵🇭 Philippines',
  'PN': '🇵🇳 Pitcairn',
  'PL': '🇵🇱 Poland',
  'PT': '🇵🇹 Portugal',
  'PR': '🇵🇷 Puerto Rico',
  'QA': '🇶🇦 Qatar',
  'RO': '🇷🇴 Romania',
  'RU': '🇷🇺 Russia',
  'RW': '🇷🇼 Rwanda',
  'RE': '🇷🇪 Reunion',
  'BL': '🇧🇱 Saint Barthelemy',
  'SH': '🇸🇭 Saint Helena, Ascension and Tristan Da Cunha',
  'KN': '🇰🇳 Saint Kitts and Nevis',
  'LC': '🇱🇨 Saint Lucia',
  'MF': '🇲🇫 Saint Martin',
  'PM': '🇵🇲 Saint Pierre and Miquelon',
  'VC': '🇻🇨 Saint Vincent and the Grenadines',
  'WS': '🇼🇸 Samoa',
  'SM': '🇸🇲 San Marino',
  'ST': '🇸🇹 Sao Tome and Principe',
  'SA': '🇸🇦 Saudi Arabia',
  'SN': '🇸🇳 Senegal',
  'RS': '🇷🇸 Serbia',
  'SC': '🇸🇨 Seychelles',
  'SL': '🇸🇱 Sierra Leone',
  'SG': '🇸🇬 Singapore',
  'SK': '🇸🇰 Slovakia',
  'SI': '🇸🇮 Slovenia',
  'SB': '🇸🇧 Solomon Islands',
  'SO': '🇸🇴 Somalia',
  'ZA': '🇿🇦 South Africa',
  'SS': '🇸🇸 South Sudan',
  'GS': '🇬🇸 South Georgia and the South Sandwich Islands',
  'ES': '🇪🇸 Spain',
  'LK': '🇱🇰 Sri Lanka',
  'SD': '🇸🇩 Sudan',
  'SR': '🇸🇷 Suriname',
  'SJ': '🇸🇯 Svalbard and Jan Mayen',
  'SZ': '🇸🇿 Eswatini',
  'SE': '🇸🇪 Sweden',
  'CH': '🇨🇭 Switzerland',
  'SY': '🇸🇾 Syrian Arab Republic',
  'TW': '🇹🇼 Taiwan',
  'TJ': '🇹🇯 Tajikistan',
  'TZ': '🇹🇿 Tanzania, United Republic of Tanzania',
  'TH': '🇹🇭 Thailand',
  'TL': '🇹🇱 Timor-Leste',
  'TG': '🇹🇬 Togo',
  'TK': '🇹🇰 Tokelau',
  'TO': '🇹🇴 Tonga',
  'TT': '🇹🇹 Trinidad and Tobago',
  'TN': '🇹🇳 Tunisia',
  'TR': '🇹🇷 Turkey',
  'TM': '🇹🇲 Turkmenistan',
  'TC': '🇹🇨 Turks and Caicos Islands',
  'TV': '🇹🇻 Tuvalu',
  'UG': '🇺🇬 Uganda',
  'UA': '🇺🇦 Ukraine',
  'AE': '🇦🇪 United Arab Emirates',
  'GB': '🇬🇧 United Kingdom',
  'US': '🇺🇸 United States',
  'UY': '🇺🇾 Uruguay',
  'UZ': '🇺🇿 Uzbekistan',
  'VU': '🇻🇺 Vanuatu',
  'VE': '🇻🇪 Venezuela, Bolivarian Republic of Venezuela',
  'VN': '🇻🇳 Vietnam',
  'VG': '🇻🇬 Virgin Islands, British',
  'VI': '🇻🇮 Virgin Islands, U.S.',
  'WF': '🇼🇫 Wallis and Futuna',
  'YE': '🇾🇪 Yemen',
  'ZM': '🇿🇲 Zambia',
  'ZW': '🇿🇼 Zimbabwe'
};

function getCountryName(countryCode) {
    const code = (countryCode || 'ID').toUpperCase();
    return countryMapping[code] || `🌍 ${code}`;
}

// ================== DATABASE POSTGRES ==================
let db = { users: {}, total_success: 0, feature: { info: true }, premium: {}, pending_payments: {} };
let spamData = {};

// Koneksi ke Postgres (DATABASE_URL otomatis dari Heroku)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Inisialisasi tabel
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bot_data (
                key VARCHAR(50) PRIMARY KEY,
                value JSONB NOT NULL,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('✅ Tabel bot_data siap');
    } catch (error) {
        console.error('❌ Gagal init database:', error.message);
    }
}

// Load data dari Postgres
async function loadDB() {
    try {
        const res = await pool.query('SELECT value FROM bot_data WHERE key = $1', ['database']);
        if (res.rows.length > 0) {
            db = res.rows[0].value;
            console.log('✅ Load database dari Postgres');
        } else {
            console.log('📁 Database kosong, pakai default');
        }
    } catch (error) {
        console.error('❌ Gagal load database:', error.message);
    }
}

// Save data ke Postgres
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
        console.error('❌ Gagal save database:', error.message);
        // Fallback: simpan ke file
        fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
    }
}

// Load spam data dari Postgres
async function loadSpamData() {
    try {
        const res = await pool.query('SELECT value FROM bot_data WHERE key = $1', ['spam']);
        if (res.rows.length > 0) {
            spamData = res.rows[0].value;
            console.log('✅ Load spam data dari Postgres');
        }
    } catch (error) {
        console.error('❌ Gagal load spam:', error.message);
    }
}

// Save spam data ke Postgres
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
        console.error('❌ Gagal save spam:', error.message);
        fs.writeFileSync('spam.json', JSON.stringify(spamData, null, 2));
    }
}

// Inisialisasi dan load data
initDB().then(async () => {
    await loadDB();
    await loadSpamData();
});

// ================== FUNGSI UTILITY ==================
function isAdmin(userId) { return ADMIN_IDS.includes(userId); }

async function isPremium(userId) {
    const premium = db.premium[userId];
    if (!premium) return false;
    const now = moment().tz('Asia/Jakarta').unix();
    if (premium.expired_at < now) {
        delete db.premium[userId]; 
        await saveDB(); 
        return false;
    }
    return true;
}

function getUserStatus(userId) {
    if (isAdmin(userId)) return { type: 'ADMIN', limit: 'Unlimited' };
    if (db.premium[userId]) return { type: 'PREMIUM', limit: 'Unlimited' };
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

async function recordInfoActivity(userId) {
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
        await saveSpamData();
        return true;
    }
    await saveSpamData();
    return false;
}

async function unbanUser(userId) {
    if (spamData[userId]) {
        spamData[userId].banned = false;
        spamData[userId].infoCount = [];
        await saveSpamData();
        return true;
    }
    return false;
}

async function addBan(userId, reason = 'Ban manual oleh admin') {
    const now = Date.now();
    spamData[userId] = { banned: true, bannedAt: now, banReason: reason, infoCount: [] };
    await saveSpamData();
    return true;
}

// ================== FUNGSI GET DATA MLBB ==================
async function getMLBBData(userId, serverId) {
    const result = { username: null, region: '🇮🇩 Indonesia', bindAccounts: [], devices: { android: 0, ios: 0 }, ttl: null };
    
    try {
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
            result.region = '🇮🇩 Indonesia'; // Tetap Indonesia
            
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
                        if (c.ttl) result.ttl = c.ttl;
                    }
                } catch (error) {
                    console.log("Checkton error:", error.message);
                }
            }
        } else {
            return null;
        }
    } catch (error) {
        console.log("GoPay error:", error.message);
        return null;
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
            await saveDB();
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
        if (!userId || !serverId || !role_id || !zone_id) return res.status(400).send('❌ Parameter tidak lengkap');
        const data = await getMLBBData(userId, serverId);
        if (!data?.username) return res.status(500).send('❌ Gagal mengambil data');
        
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

    // ================== FUNGSI CEK JOIN ==================
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

    // ================== MIDDLEWARE ==================
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id, userId = msg.from.id, text = msg.text, chatType = msg.chat.type;
        
        if (!text) return;
        
        // ===== HANYA RESPON DI PRIVATE CHAT - FILTER UTAMA =====
        if (chatType !== 'private') {
            console.log(`⚠️ Pesan dari grup diabaikan: ${chatId}`);
            return; // IGNORE SEMUA PESAN DI GRUP/CHANNEL
        }
        
        if (isAdmin(userId)) return;
        
        // COMMAND PUBLIK TANPA CEK
        const publicCommands = ['/start', '/langganan', '/status', '/offinfo', '/oninfo', '/ranking', '/listpremium', '/listbanned', '/addban', '/unban', '/addpremium'];
        if (publicCommands.includes(text.split(' ')[0])) return;
        
        // UNTUK COMMAND LAIN, TIDAK ADA TINDAKAN DI MIDDLEWARE
    });

    // ================== COMMAND /start ==================
    bot.onText(/\/start/, async (msg) => {
        // FILTER GRUP
        if (msg.chat.type !== 'private') return;
        
        const userId = msg.from.id;
        const status = getUserStatus(userId);
        
        let message = `SELAMAT DATANG DI BOT\n\n`;
        message += `Status Akun: ${status.type}\n`;
        if (status.type === 'FREE') message += `Sisa Limit: ${status.used}/${status.limit}\n\n`;
        else message += `Akses: Unlimited\n\n`;
        
        message += `DAFTAR PERINTAH:\n`;
        message += `/info ID SERVER - Cek akun MLBB\n`;
        message += `/status - Cek status akun\n`;
        message += `/langganan - Lihat paket premium\n`;
        
        if (isAdmin(userId)) {
            message += `\nPERINTAH ADMIN:\n`;
            message += `/offinfo - Nonaktifkan fitur info\n`;
            message += `/oninfo - Aktifkan fitur info\n`;
            message += `/ranking - Lihat peringkat user\n`;
            message += `/listpremium - Lihat user premium\n`;
            message += `/listbanned - Lihat user diblokir\n`;
            message += `/addban ID [alasan] - Blokir user\n`;
            message += `/unban ID - Buka blokir user\n`;
            message += `/addpremium ID DURASI - Tambah premium\n`;
        }
        
        await bot.sendMessage(msg.chat.id, message);
    });

    // ================== COMMAND /status ==================
    bot.onText(/\/status/, async (msg) => {
        // FILTER GRUP
        if (msg.chat.type !== 'private') return;
        
        const userId = msg.from.id;
        
        if (isBanned(userId) && !isAdmin(userId)) {
            await bot.sendMessage(msg.chat.id,
                `STATUS AKUN\n\n` +
                `Status: BLOKIR\n\n` +
                `Detail:\n` +
                `• Alasan: ${spamData[userId]?.banReason || 'Tidak diketahui'}\n` +
                `• Tanggal: ${moment(spamData[userId]?.bannedAt).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')} WIB\n\n` +
                `Anda tidak dapat menggunakan fitur /info.\n` +
                `Hubungi admin jika ada kesalahan.`
            );
            return;
        }
        
        const status = getUserStatus(userId);
        let message = `STATUS AKUN\n\nUser ID: ${userId}\nTipe: ${status.type}\n`;
        
        if (status.type === 'FREE') {
            message += `Limit: ${status.used}/${status.limit}\nSisa: ${getRemainingLimit(userId)}`;
            if (status.used >= status.limit) message += `\n\nLimit habis! Gunakan /langganan.`;
        } else {
            message += `Akses: Unlimited`;
            if (status.type === 'PREMIUM') {
                message += `\nBerlaku sampai: ${moment.unix(db.premium[userId].expired_at).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')} WIB`;
            }
        }
        
        await bot.sendMessage(msg.chat.id, message);
    });

    // ================== COMMAND /langganan ==================
    bot.onText(/\/langganan/, async (msg) => {
        // FILTER GRUP
        if (msg.chat.type !== 'private') return;
        
        const userId = msg.from.id;
        
        if (await isPremium(userId)) {
            const expired = moment.unix(db.premium[userId].expired_at).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');
            await bot.sendMessage(msg.chat.id, `ANDA SUDAH PREMIUM\n\nBerlaku sampai: ${expired} WIB`);
            return;
        }
        
        await bot.sendMessage(msg.chat.id, `Paket Unlimited Akses tanpa limit\n\nPilih masa aktif:`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '1 HARI - Rp 15.000', callback_data: 'bayar_1' }],
                    [{ text: '3 HARI - Rp 25.000', callback_data: 'bayar_3' }],
                    [{ text: '7 HARI - Rp 45.000', callback_data: 'bayar_7' }],
                    [{ text: '30 HARI - Rp 100.000', callback_data: 'bayar_30' }],
                    [{ text: 'BATAL', callback_data: 'batal_bayar' }]
                ]
            }
        });
    });

    // ================== CALLBACK QUERY ==================
    bot.on('callback_query', async (cb) => {
        const msg = cb.message;
        
        // FILTER GRUP - JIKA CALLBACK DARI GRUP, IGNORE
        if (msg.chat.type !== 'private') {
            await bot.answerCallbackQuery(cb.id, { text: 'Bot hanya berfungsi di chat pribadi' });
            return;
        }
        
        const chatId = msg.chat.id, userId = cb.from.id, data = cb.data;
        await bot.deleteMessage(chatId, msg.message_id).catch(() => {});

        if (data === 'batal_bayar') {
            await bot.answerCallbackQuery(cb.id, { text: 'Pembayaran dibatalkan' });
            await bot.sendMessage(chatId, 'Pembayaran dibatalkan.');
            return;
        }

        if (data.startsWith('bayar_')) {
            await bot.answerCallbackQuery(cb.id, { text: 'Memproses pembayaran...' });
            const pilihan = data.replace('bayar_', '');
            const paket = { 
                '1': { name: '1 Hari', price: 15000 }, 
                '3': { name: '3 Hari', price: 25000 }, 
                '7': { name: '7 Hari', price: 45000 }, 
                '30': { name: '30 Hari', price: 100000 } 
            };
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
                await saveDB();
            } catch {
                await bot.sendMessage(chatId, `PEMBAYARAN QRIS\n\nPaket: ${selected.name}\nHarga: ${formatRupiah(selected.price)}\n\nQR Code:\n${payment.qrString}\n\nOrder ID: ${payment.orderId}\nBerlaku sampai: ${payment.expiredAt} WIB`);
            }
        }
    });

    // ================== AUTO CHECK PAYMENT ==================
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
                    await saveDB();
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

                    db.premium[userId] = { 
                        activated_at: now, 
                        expired_at: expiredAt, 
                        duration: data.duration, 
                        order_id: orderId 
                    };
                    db.pending_payments[orderId].status = 'paid';
                    await saveDB();

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

    // ================== COMMAND /info ==================
    bot.onText(/^\s*\/\s*info(?:\s+(.+))?$/i, async (msg, match) => {
        // FILTER GRUP
        if (msg.chat.type !== 'private') return;
        
        const chatId = msg.chat.id, userId = msg.from.id, username = msg.from.username;
        
        // ===== 1. CEK BAN =====
        if (isBanned(userId) && !isAdmin(userId)) {
            return; // DIAM SAJA
        }
        
        // ===== 2. CEK USERNAME =====
        if (!username && !isAdmin(userId)) {
            await bot.sendMessage(chatId,
                `USERNAME DIPERLUKAN\n\n` +
                `Untuk menggunakan perintah ini, Anda harus memiliki username Telegram.\n\n` +
                `Cara membuat username:\n` +
                `1. Buka Settings\n` +
                `2. Pilih Username\n` +
                `3. Buat username baru\n` +
                `4. Simpan`
            );
            return;
        }
        
        // ===== 3. CEK FITUR INFO =====
        if (!db.feature.info && !isAdmin(userId)) {
            await bot.sendMessage(chatId,
                `FITUR SEDANG NONAKTIF\n\n` +
                `Fitur /info sedang dinonaktifkan oleh administrator.`
            );
            return;
        }
        
        // ===== 4. CEK JOIN =====
        const joined = await checkJoin(userId);
        const missing = [];
        if (!joined.channel) missing.push(CHANNEL);
        if (!joined.group) missing.push(GROUP);

        if (missing.length > 0 && !isAdmin(userId)) {
            const buttons = missing.map(ch => [{
                text: `Bergabung ke ${ch.replace('@', '')}`,
                url: `https://t.me/${ch.replace('@', '')}`
            }]);
            
            await bot.sendMessage(chatId,
                `AKSES TERBATAS\n\n` +
                `Untuk menggunakan bot ini, Anda perlu bergabung dengan:\n` +
                missing.map(ch => `• ${ch}`).join('\n') + 
                `\n\nSilakan klik tombol di bawah untuk bergabung, lalu coba lagi.`,
                { reply_markup: { inline_keyboard: buttons } }
            );
            return;
        }
        
        // ===== 5. CEK FORMAT =====
        if (!match || !match[1]) {
            await bot.sendMessage(chatId,
                `INFORMASI PENGGUNAAN\n\n` +
                `Format: /info ID_USER ID_SERVER\n` +
                `Contoh: /info 643461181 8554\n\n` +
                `ID_USER : ID akun Mobile Legends Anda\n` +
                `ID_SERVER : ID server Anda`
            );
            return;
        }
        
        const args = match[1].trim().split(/\s+/);
        if (args.length < 2) {
            await bot.sendMessage(chatId,
                `FORMAT TIDAK LENGKAP\n\n` +
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
        
        // ===== 6. CEK SPAM =====
        const banned = await recordInfoActivity(userId);
        if (banned) {
            console.log(`User ${userId} kena ban karena spam /info`);
            return; // DIAM SAJA
        }
        
        // ===== 7. CEK LIMIT =====
        const isFreeUser = !isAdmin(userId) && !(await isPremium(userId));
        const remaining = isFreeUser ? getRemainingLimit(userId) : 'Unlimited';
        
        if (isFreeUser && remaining <= 0) {
            await bot.sendMessage(chatId, 
                `BATAS PENGGUNAAN HABIS\n\n` +
                `Anda telah mencapai batas penggunaan gratis (10x).\n` +
                `Gunakan /langganan untuk upgrade ke premium.`
            );
            return;
        }
        
        // ===== 8. PROSES AMBIL DATA =====
        const loadingMsg = await bot.sendMessage(chatId, 'Mengambil data, mohon tunggu...');
        const data = await getMLBBData(targetId, serverId);
        
        await bot.deleteMessage(chatId, loadingMsg.message_id);
        
        if (!data?.username) {
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

        // ===== 9. TAMPILKAN HASIL =====
        let output = `INFORMASI AKUN\n\n`;
        output += `ID: ${targetId}\n`;
        output += `Server: ${serverId}\n`;
        output += `Nickname: ${data.username}\n`;
        if (data.ttl) output += `Tanggal Pembuatan: ${data.ttl}\n`;
        output += `Region: ${data.region}\n\n`;
        
        if (data.bindAccounts?.length > 0) {
            output += `BIND INFO:\n`;
            data.bindAccounts.forEach(b => output += `• ${b.platform}: ${b.details || 'empty.'}\n`);
            output += `\n`;
        }
        
        output += `Device Login:\n`;
        output += `• Android: ${data.devices.android} perangkat\n`;
        output += `• iOS: ${data.devices.ios} perangkat`;

        await bot.sendMessage(chatId, output, {
            reply_markup: { 
                inline_keyboard: [[{ text: 'Stok Admin', url: STOK_ADMIN }]] 
            }
        });

        // ===== 10. UPDATE LIMIT JIKA FREE USER =====
        if (isFreeUser) {
            db.users[userId] = db.users[userId] || { username, success: 0 };
            db.users[userId].username = username;
            db.users[userId].success += 1;
            db.total_success += 1;
            await saveDB();
        }
    });

    // ================== ADMIN COMMANDS ==================
    bot.onText(/\/offinfo/, async (msg) => { 
        if (msg.chat.type !== 'private') return;
        if (isAdmin(msg.from.id)) { 
            db.feature.info = false; 
            await saveDB(); 
            bot.sendMessage(msg.chat.id, 'Fitur /info dinonaktifkan.'); 
        } 
    });

    bot.onText(/\/oninfo/, async (msg) => { 
        if (msg.chat.type !== 'private') return;
        if (isAdmin(msg.from.id)) { 
            db.feature.info = true; 
            await saveDB(); 
            bot.sendMessage(msg.chat.id, 'Fitur /info diaktifkan.'); 
        } 
    });

    bot.onText(/\/ranking/, async (msg) => {
        if (msg.chat.type !== 'private') return;
        if (!isAdmin(msg.from.id)) return;
        const users = Object.entries(db.users || {})
            .sort((a,b) => b[1].success - a[1].success)
            .slice(0,10);
        let message = 'PERINGKAT PENGGUNA\n\n';
        users.forEach(([id,data],i) => message += `${i+1}. @${data.username || 'unknown'} - ${data.success}x\n`);
        await bot.sendMessage(msg.chat.id, message || 'Belum ada data');
    });

    bot.onText(/\/listpremium/, async (msg) => {
        if (msg.chat.type !== 'private') return;
        if (!isAdmin(msg.from.id)) return;
        let message = 'DAFTAR PREMIUM\n\n';
        Object.entries(db.premium || {}).forEach(([id,data],i) => {
            message += `${i+1}. ID: ${id} - ${data.duration}\n`;
            message += `   Exp: ${moment.unix(data.expired_at).tz('Asia/Jakarta').format('DD/MM/YYYY')}\n\n`;
        });
        bot.sendMessage(msg.chat.id, message || 'Belum ada');
    });

    bot.onText(/\/listbanned/, async (msg) => {
        if (msg.chat.type !== 'private') return;
        if (!isAdmin(msg.from.id)) return;
        let message = 'DAFTAR BANNED\n\n';
        Object.entries(spamData)
            .filter(([_,d]) => d.banned)
            .forEach(([id,d],i) => {
                message += `${i+1}. ${id} - ${d.banReason} (${moment(d.bannedAt).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm')})\n`;
            });
        bot.sendMessage(msg.chat.id, message || 'Tidak ada');
    });

    bot.onText(/\/addban(?:\s+(\d+)(?:\s+(.+))?)?/, async (msg, match) => {
        if (msg.chat.type !== 'private') return;
        if (!isAdmin(msg.from.id)) return;
        if (!match[1]) return bot.sendMessage(msg.chat.id, 'Format: /addban ID [alasan]');
        await addBan(parseInt(match[1]), match[2] || 'Ban manual');
        bot.sendMessage(msg.chat.id, `User ${match[1]} diblokir.`);
    });

    bot.onText(/\/unban (.+)/, async (msg, match) => {
        if (msg.chat.type !== 'private') return;
        if (!isAdmin(msg.from.id)) return;
        const id = parseInt(match[1]);
        if (await unbanUser(id)) bot.sendMessage(msg.chat.id, `User ${id} di-unban.`);
        else bot.sendMessage(msg.chat.id, `User ${id} tidak ditemukan.`);
    });

    bot.onText(/\/addpremium (.+)/, async (msg, match) => {
        if (msg.chat.type !== 'private') return;
        if (!isAdmin(msg.from.id)) return;
        const args = match[1].split(' ');
        if (args.length < 2) return bot.sendMessage(msg.chat.id, 'Format: /addpremium ID DURASI');
        const targetId = parseInt(args[0]), days = parseInt(args[1]);
        const now = moment().tz('Asia/Jakarta').unix();
        db.premium[targetId] = { 
            activated_at: now, 
            expired_at: now + (days * 86400), 
            duration: `${days} Hari (Manual)` 
        };
        await saveDB();
        bot.sendMessage(msg.chat.id, `Premium ${days} hari untuk ${targetId}.`);
        try { 
            await bot.sendMessage(targetId, `Akun Anda diupgrade PREMIUM ${days} hari.`); 
        } catch {}
    });

    console.log('🤖 Bot started, Admin IDs:', ADMIN_IDS);
    }
