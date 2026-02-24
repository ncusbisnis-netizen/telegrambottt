const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const moment = require('moment-timezone');
const cron = require('node-cron');
const QRCode = require('qrcode');
const { Pool } = require('pg');

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

const ADMIN_IDS = process.env.ADMIN_IDS 
    ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) 
    : [];

// ================== REGION MAPPING ==================
const countryMapping = {
    'AF': 'Afghanistan',
    'AX': 'Aland Islands',
    'AL': 'Albania',
    'DZ': 'Algeria',
    'AS': 'American Samoa',
    'AD': 'Andorra',
    'AO': 'Angola',
    'AI': 'Anguilla',
    'AQ': 'Antarctica',
    'AG': 'Antigua and Barbuda',
    'AR': 'Argentina',
    'AM': 'Armenia',
    'AW': 'Aruba',
    'AU': 'Australia',
    'AT': 'Austria',
    'AZ': 'Azerbaijan',
    'BS': 'Bahamas',
    'BH': 'Bahrain',
    'BD': 'Bangladesh',
    'BB': 'Barbados',
    'BY': 'Belarus',
    'BE': 'Belgium',
    'BZ': 'Belize',
    'BJ': 'Benin',
    'BM': 'Bermuda',
    'BT': 'Bhutan',
    'BO': 'Bolivia',
    'BA': 'Bosnia and Herzegovina',
    'BW': 'Botswana',
    'BV': 'Bouvet Island',
    'BR': 'Brazil',
    'IO': 'British Indian Ocean Territory',
    'BN': 'Brunei Darussalam',
    'BG': 'Bulgaria',
    'BF': 'Burkina Faso',
    'BI': 'Burundi',
    'KH': 'Cambodia',
    'CM': 'Cameroon',
    'CA': 'Canada',
    'CV': 'Cape Verde',
    'KY': 'Cayman Islands',
    'CF': 'Central African Republic',
    'TD': 'Chad',
    'CL': 'Chile',
    'CN': 'China',
    'CX': 'Christmas Island',
    'CC': 'Cocos (Keeling) Islands',
    'CO': 'Colombia',
    'KM': 'Comoros',
    'CG': 'Congo',
    'CD': 'Congo, Democratic Republic',
    'CK': 'Cook Islands',
    'CR': 'Costa Rica',
    'CI': "Cote d'Ivoire",
    'HR': 'Croatia',
    'CU': 'Cuba',
    'CY': 'Cyprus',
    'CZ': 'Czech Republic',
    'DK': 'Denmark',
    'DJ': 'Djibouti',
    'DM': 'Dominica',
    'DO': 'Dominican Republic',
    'EC': 'Ecuador',
    'EG': 'Egypt',
    'SV': 'El Salvador',
    'GQ': 'Equatorial Guinea',
    'ER': 'Eritrea',
    'EE': 'Estonia',
    'ET': 'Ethiopia',
    'FK': 'Falkland Islands',
    'FO': 'Faroe Islands',
    'FJ': 'Fiji',
    'FI': 'Finland',
    'FR': 'France',
    'GF': 'French Guiana',
    'PF': 'French Polynesia',
    'TF': 'French Southern Territories',
    'GA': 'Gabon',
    'GM': 'Gambia',
    'GE': 'Georgia',
    'DE': 'Germany',
    'GH': 'Ghana',
    'GI': 'Gibraltar',
    'GR': 'Greece',
    'GL': 'Greenland',
    'GD': 'Grenada',
    'GP': 'Guadeloupe',
    'GU': 'Guam',
    'GT': 'Guatemala',
    'GG': 'Guernsey',
    'GN': 'Guinea',
    'GW': 'Guinea-Bissau',
    'GY': 'Guyana',
    'HT': 'Haiti',
    'HM': 'Heard Island',
    'VA': 'Vatican City',
    'HN': 'Honduras',
    'HK': 'Hong Kong',
    'HU': 'Hungary',
    'IS': 'Iceland',
    'IN': 'India',
    'ID': 'Indonesia',
    'IR': 'Iran',
    'IQ': 'Iraq',
    'IE': 'Ireland',
    'IM': 'Isle of Man',
    'IL': 'Israel',
    'IT': 'Italy',
    'JM': 'Jamaica',
    'JP': 'Japan',
    'JE': 'Jersey',
    'JO': 'Jordan',
    'KZ': 'Kazakhstan',
    'KE': 'Kenya',
    'KI': 'Kiribati',
    'KP': 'North Korea',
    'KR': 'South Korea',
    'XK': 'Kosovo',
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
    'MO': 'Macao',
    'MK': 'Macedonia',
    'MG': 'Madagascar',
    'MW': 'Malawi',
    'MY': 'Malaysia',
    'MV': 'Maldives',
    'ML': 'Mali',
    'MT': 'Malta',
    'MH': 'Marshall Islands',
    'MQ': 'Martinique',
    'MR': 'Mauritania',
    'MU': 'Mauritius',
    'YT': 'Mayotte',
    'MX': 'Mexico',
    'FM': 'Micronesia',
    'MD': 'Moldova',
    'MC': 'Monaco',
    'MN': 'Mongolia',
    'ME': 'Montenegro',
    'MS': 'Montserrat',
    'MA': 'Morocco',
    'MZ': 'Mozambique',
    'MM': 'Myanmar',
    'NA': 'Namibia',
    'NR': 'Nauru',
    'NP': 'Nepal',
    'NL': 'Netherlands',
    'NC': 'New Caledonia',
    'NZ': 'New Zealand',
    'NI': 'Nicaragua',
    'NE': 'Niger',
    'NG': 'Nigeria',
    'NU': 'Niue',
    'NF': 'Norfolk Island',
    'MP': 'Northern Mariana Islands',
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
    'PN': 'Pitcairn',
    'PL': 'Poland',
    'PT': 'Portugal',
    'PR': 'Puerto Rico',
    'QA': 'Qatar',
    'RO': 'Romania',
    'RU': 'Russia',
    'RW': 'Rwanda',
    'RE': 'Reunion',
    'BL': 'Saint Barthelemy',
    'SH': 'Saint Helena',
    'KN': 'Saint Kitts and Nevis',
    'LC': 'Saint Lucia',
    'MF': 'Saint Martin',
    'PM': 'Saint Pierre and Miquelon',
    'VC': 'Saint Vincent',
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
    'SS': 'South Sudan',
    'GS': 'South Georgia',
    'ES': 'Spain',
    'LK': 'Sri Lanka',
    'SD': 'Sudan',
    'SR': 'Suriname',
    'SJ': 'Svalbard and Jan Mayen',
    'SZ': 'Eswatini',
    'SE': 'Sweden',
    'CH': 'Switzerland',
    'SY': 'Syria',
    'TW': 'Taiwan',
    'TJ': 'Tajikistan',
    'TZ': 'Tanzania',
    'TH': 'Thailand',
    'TL': 'Timor-Leste',
    'TG': 'Togo',
    'TK': 'Tokelau',
    'TO': 'Tonga',
    'TT': 'Trinidad and Tobago',
    'TN': 'Tunisia',
    'TR': 'Turkey',
    'TM': 'Turkmenistan',
    'TC': 'Turks and Caicos Islands',
    'TV': 'Tuvalu',
    'UG': 'Uganda',
    'UA': 'Ukraine',
    'AE': 'United Arab Emirates',
    'GB': 'United Kingdom',
    'US': 'United States',
    'UY': 'Uruguay',
    'UZ': 'Uzbekistan',
    'VU': 'Vanuatu',
    'VE': 'Venezuela',
    'VN': 'Vietnam',
    'VG': 'British Virgin Islands',
    'VI': 'U.S. Virgin Islands',
    'WF': 'Wallis and Futuna',
    'YE': 'Yemen',
    'ZM': 'Zambia',
    'ZW': 'Zimbabwe'
};

function getCountryName(countryCode) {
    const code = (countryCode || 'ID').toUpperCase();
    return countryMapping[code] || code;
}

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
            db.users[userId] = { username: '', success: 0, credits: 0, topup_history: [] };
        }
        return db.users[userId].credits || 0;
    } catch (error) {
        return 0;
    }
}

async function addCredits(userId, amount, orderId = null) {
    try {
        if (!db.users[userId]) {
            db.users[userId] = { username: '', success: 0, credits: 0, topup_history: [] };
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

async function activatePremium(userId, days, duration, paymentMethod = 'saldo') {
    try {
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
            duration: duration,
            payment_method: paymentMethod
        };
        await saveDB();
        
        return expiredAt;
    } catch (error) {
        console.log('Error activatePremium:', error.message);
        return null;
    }
}

// ================== DATABASE POSTGRES ==================
let db = { 
    users: {}, 
    total_success: 0, 
    feature: { info: true }, 
    premium: {},
    pending_payments: {},
    pending_topups: {} 
};
let spamData = {};

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

async function isPremium(userId) {
    try {
        const premium = db.premium[userId];
        if (!premium) return false;
        const now = moment().tz('Asia/Jakarta').unix();
        if (premium.expired_at < now) {
            delete db.premium[userId]; 
            await saveDB(); 
            return false;
        }
        return true;
    } catch (error) {
        return false;
    }
}

function getUserStatus(userId) {
    try {
        if (isAdmin(userId)) return { type: 'ADMIN', limit: 'Unlimited' };
        if (db.premium[userId]) return { type: 'PREMIUM', limit: 'Unlimited' };
        return { type: 'FREE', limit: 10, used: db.users[userId]?.success || 0 };
    } catch (error) {
        return { type: 'FREE', limit: 10, used: 0 };
    }
}

function getRemainingLimit(userId) {
    try {
        const status = getUserStatus(userId);
        if (status.type !== 'FREE') return 'Unlimited';
        return Math.max(0, status.limit - status.used);
    } catch (error) {
        return 0;
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

// ================== FUNGSI GET DATA MLBB (OPTIMIZED) ==================
async function getMLBBData(userId, serverId, type = 'bind') {
    const result = { 
        username: null, 
        region: 'Indonesia', 
        bindAccounts: [], 
        devices: { android: 0, ios: 0 }, 
        ttl: null,
        detailed: null 
    };
    
    try {
        console.log(`Mencoba ambil data ${type} untuk ${userId} server ${serverId}`);
        
        // PRIORITAS 1: AMBIL DATA DARI GOPAY (CEPAT)
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
                timeout: 8000
            });
            
            if (goPayResponse.data?.data) {
                const g = goPayResponse.data.data;
                result.username = g.username ? g.username.replace(/\+/g, ' ') : "Tidak ditemukan";
                result.region = getCountryName(g.countryOrigin);
                console.log(`GoPay sukses: ${result.username}, region: ${result.region}`);
            }
        } catch (goPayError) {
            console.log(`GoPay error:`, goPayError.message);
        }
        
        // Untuk /info, cukup data GoPay dulu, Checkton jalan di background
        if (type === 'bind' && result.username) {
            console.log(`Menggunakan data GoPay untuk /info`);
            // Jalankan Checkton di background
            getChecktonData(userId, serverId, type, result).catch(e => {});
            return result;
        }
        
        // PRIORITAS 2: AMBIL DATA DARI CHECKTON (UNTUK DETAIL)
        try {
            const checktonResponse = await axios.post("https://checkton.online/backend/info", {
                role_id: String(userId),
                zone_id: String(serverId),
                type: type
            }, {
                headers: { 
                    "Content-Type": "application/json", 
                    "x-api-key": API_KEY_CHECKTON 
                },
                timeout: 20000
            });
            
            if (checktonResponse.data?.data) {
                const c = checktonResponse.data.data;
                
                if (!result.username) {
                    result.username = c.nickname || "Tidak ditemukan";
                    result.region = getCountryName(c.country);
                }
                
                result.ttl = c.ttl || null;
                
                if (type === 'bind') {
                    if (c.devices) {
                        result.devices.android = c.devices.android?.total || 0;
                        result.devices.ios = c.devices.ios?.total || 0;
                    }
                    if (c.bind_accounts && Array.isArray(c.bind_accounts)) {
                        result.bindAccounts = c.bind_accounts;
                    }
                }
                
                if (type === 'lookup') {
                    result.detailed = c;
                }
                
                console.log(`Checkton data berhasil diambil`);
            }
        } catch (checktonError) {
            console.log(`Checkton error:`, checktonError.message);
        }
        
        // Jika tidak ada data sama sekali
        if (!result.username) {
            result.username = "Tidak ditemukan";
        }
        
        return result;
        
    } catch (error) {
        console.log(`Error getMLBBData:`, error.message);
        return result.username ? result : null;
    }
}

// Fungsi untuk ambil data Checkton di background
async function getChecktonData(userId, serverId, type, result) {
    try {
        console.log(`Background: Ambil data Checkton untuk ${userId}`);
        
        const checktonResponse = await axios.post("https://checkton.online/backend/info", {
            role_id: String(userId),
            zone_id: String(serverId),
            type: type
        }, {
            headers: { 
                "Content-Type": "application/json", 
                "x-api-key": API_KEY_CHECKTON 
            },
            timeout: 20000
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
            result.ttl = c.ttl || null;
            
            console.log(`Background: Data Checkton untuk ${userId} berhasil`);
            
            await saveDB();
        }
    } catch (error) {
        console.log(`Background: Checkton error untuk ${userId}:`, error.message);
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
            timeout: 15000
        });
        
        console.log(`Response status: ${response.status}`);
        
        if (response.data && response.data.status === 0) {
            console.log(`Ditemukan ${response.data.data?.length || 0} hasil`);
            return response.data.data;
        } else {
            console.log(`Response:`, response.data);
            return null;
        }
    } catch (error) {
        console.log(`Error findPlayerByName:`, error.message);
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
            
            delete db.pending_payments[orderId];
            
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

// ================== PAKASIR API UNTUK PREMIUM ==================
async function createPakasirPremium(amount, duration, userId) {
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
            
            delete db.pending_topups[orderId];
            
            db.pending_payments[orderId] = {
                userId, duration, amount, status: 'pending',
                created_at: moment().tz('Asia/Jakarta').unix(),
                expired_at: expiredAt.unix(),
                payment_number: payment.payment_number,
                notified: false,
                processed: false
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
                    } else {
                        const premiumData = db.pending_payments?.[order_id];
                        if (premiumData && !premiumData.processed) {
                            await processPremiumSuccess(order_id, amount);
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
                `Saldo bertambah: ${amount} credits\n` +
                `Saldo sekarang: ${getUserCredits(userId)} credits`
            );
        } catch (e) {}
    }

    async function processPremiumSuccess(orderId, amount) {
        const data = db.pending_payments?.[orderId];
        if (!data) return;
        
        const userId = data.userId;
        const days = { '1 Hari':1, '3 Hari':3, '7 Hari':7, '30 Hari':30 }[data.duration] || 1;
        
        const expiredAt = await activatePremium(userId, days, data.duration, 'qris');
        if (!expiredAt) return;
        
        db.pending_payments[orderId].status = 'paid';
        db.pending_payments[orderId].notified = true;
        db.pending_payments[orderId].processed = true;
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
                `PEMBAYARAN BERHASIL\n\n` +
                `Premium ${data.duration} telah diaktifkan.\n` +
                `Berlaku sampai: ${moment.unix(expiredAt).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')} WIB`
            );
        } catch (e) {}
    }

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
                
                const publicCommands = ['/start', '/langganan', '/topup', '/status', '/offinfo', '/oninfo', '/ranking', '/listpremium', '/listbanned', '/listtopup', '/addban', '/unban', '/addpremium', '/deletepremium', '/addtopup'];
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
                const status = getUserStatus(userId);
                const credits = getUserCredits(userId);
                
                let message = `SELAMAT DATANG DI BOT\n\n`;
                message += `Status Akun: ${status.type}\n`;
                message += `Saldo: ${credits} credits\n\n`;
                
                if (status.type === 'FREE') {
                    message += `Sisa Limit: ${status.used}/${status.limit}\n\n`;
                }
                
                message += `DAFTAR PERINTAH:\n`;
                message += `/info ID SERVER - Info dasar\n`;
                message += `/cek ID SERVER - Info detail\n`;
                message += `/find NICKNAME - Cari akun (5000 credits)\n`;
                message += `/status - Cek status & saldo\n`;
                message += `/topup - Isi saldo\n`;
                message += `/langganan - Beli premium\n\n`;
                
                if (isAdmin(userId)) {
                    message += `ADMIN:\n`;
                    message += `/offinfo - Nonaktifkan fitur\n`;
                    message += `/oninfo - Aktifkan fitur\n`;
                    message += `/ranking - Peringkat user\n`;
                    message += `/listpremium - Daftar premium\n`;
                    message += `/listbanned - Daftar banned\n`;
                    message += `/listtopup - Riwayat topup\n`;
                    message += `/addban ID - Blokir user\n`;
                    message += `/unban ID - Buka blokir\n`;
                    message += `/addpremium ID DURASI - Tambah premium\n`;
                    message += `/deletepremium ID - Hapus premium\n`;
                    message += `/addtopup ID JUMLAH - Tambah saldo user\n`;
                }
                
                await bot.sendMessage(msg.chat.id, message);
            } catch (error) {
                console.log('Error /start:', error.message);
            }
        });

        // ================== COMMAND /status ==================
        bot.onText(/\/status/, async (msg) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                const userId = msg.from.id;
                const credits = getUserCredits(userId);
                const status = getUserStatus(userId);
                
                if (isBanned(userId) && !isAdmin(userId)) {
                    await bot.sendMessage(msg.chat.id,
                        `STATUS AKUN\n\n` +
                        `Status: BLOKIR\n\n` +
                        `Alasan: ${spamData[userId]?.banReason || 'Tidak diketahui'}`
                    );
                    return;
                }
                
                let message = `STATUS AKUN\n\n`;
                message += `User ID: ${userId}\n`;
                message += `Tipe: ${status.type}\n`;
                message += `Saldo: ${credits} credits\n\n`;
                
                if (status.type === 'FREE') {
                    message += `Sisa Limit: ${status.used}/${status.limit}\n`;
                }
                
                if (status.type === 'PREMIUM') {
                    const premium = db.premium[userId];
                    const expired = moment.unix(premium.expired_at).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');
                    message += `Premium sampai: ${expired} WIB\n`;
                }
                
                message += `\nBiaya:\n`;
                message += `/info /cek: 1 limit (10x gratis)\n`;
                message += `/find: 5000 credits\n`;
                
                await bot.sendMessage(msg.chat.id, message);
            } catch (error) {
                console.log('Error /status:', error.message);
            }
        });

        // ================== COMMAND /topup ==================
        bot.onText(/\/topup/, async (msg) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                const userId = msg.from.id;
                const credits = getUserCredits(userId);
                
                await bot.sendMessage(msg.chat.id,
                    `TOP UP SALDO\n\n` +
                    `Saldo Anda: ${credits} credits\n\n` +
                    `Pilih nominal:`,
                    {
                        reply_markup: {
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
                                    { text: 'BATAL', callback_data: 'topup_batal' }
                                ]
                            ]
                        }
                    }
                );
            } catch (error) {
                console.log('Error /topup:', error.message);
            }
        });

        // ================== COMMAND /langganan ==================
        bot.onText(/\/langganan/, async (msg) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                const userId = msg.from.id;
                const credits = getUserCredits(userId);
                
                if (await isPremium(userId)) {
                    const expired = moment.unix(db.premium[userId].expired_at).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss');
                    await bot.sendMessage(msg.chat.id, 
                        `ANDA SUDAH PREMIUM\n\nBerlaku sampai: ${expired} WIB`
                    );
                    return;
                }
                
                await bot.sendMessage(msg.chat.id,
                    `PAKET PREMIUM\n\n` +
                    `Saldo Anda: ${credits} credits\n\n` +
                    `Pilih paket (bayar dengan saldo):`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '1 HARI - 10.000 credits', callback_data: 'langganan_1' }],
                                [{ text: '3 HARI - 25.000 credits', callback_data: 'langganan_3' }],
                                [{ text: '7 HARI - 45.000 credits', callback_data: 'langganan_7' }],
                                [{ text: '30 HARI - 100.000 credits', callback_data: 'langganan_30' }],
                                [{ text: 'BATAL', callback_data: 'batal_bayar' }]
                            ]
                        }
                    }
                );
            } catch (error) {
                console.log('Error /langganan:', error.message);
            }
        });

        // ================== COMMAND /info (OPTIMIZED) ==================
        bot.onText(/\/info(?:\s+(.+))?/i, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                if (!match || !match[1]) {
                    await bot.sendMessage(msg.chat.id,
                        `INFORMASI PENGGUNAAN\n\n` +
                        `Format: /info ID_USER ID_SERVER\n` +
                        `Contoh: /info 1848626191 1752`
                    );
                    return;
                }
                
                const chatId = msg.chat.id, userId = msg.from.id, username = msg.from.username;
                
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
                    
                    await bot.sendMessage(chatId,
                        `AKSES TERBATAS\n\n` +
                        `Anda perlu bergabung dengan:\n` +
                        missing.map(ch => `• ${ch}`).join('\n'),
                        { reply_markup: { inline_keyboard: buttons } }
                    );
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
                
                if (targetId.length < 6) {
                    await bot.sendMessage(chatId, 'ID User MLBB minimal 6 digit. Pastikan ID benar.');
                    return;
                }
                
                const banned = await recordInfoActivity(userId);
                if (banned) return;
                
                const isFreeUser = !isAdmin(userId) && !(await isPremium(userId));
                const remaining = isFreeUser ? getRemainingLimit(userId) : 'Unlimited';
                
                if (isFreeUser && remaining <= 0) {
                    await bot.sendMessage(chatId, 
                        `BATAS PENGGUNAAN HABIS\n\n` +
                        `Gunakan /langganan untuk premium`
                    );
                    return;
                }
                
                const loadingMsg = await bot.sendMessage(chatId, 'Mengambil data...');
                const data = await getMLBBData(targetId, serverId, 'bind');
                
                await bot.deleteMessage(chatId, loadingMsg.message_id);
                
                if (!data || !data.username) {
                    await bot.sendMessage(chatId, 
                        `GAGAL MENGAMBIL DATA\n\n` +
                        `ID: ${targetId}\n` +
                        `Server: ${serverId}\n\n` +
                        `Kemungkinan penyebab:\n` +
                        `• ID/Server salah\n` +
                        `• Akun tidak ditemukan\n` +
                        `• Server API sibuk\n\n` +
                        `Coba periksa kembali ID dan Server Anda.`
                    );
                    return;
                }
                
                if (data.username === "Tidak ditemukan") {
                    await bot.sendMessage(chatId, 
                        `AKUN TIDAK DITEMUKAN\n\n` +
                        `ID: ${targetId}\n` +
                        `Server: ${serverId}\n\n` +
                        `Pastikan ID dan Server benar.`
                    );
                    return;
                }

                let output = `INFORMASI AKUN\n\n`;
                output += `ID: ${targetId}\n`;
                output += `Server: ${serverId}\n`;
                output += `Nickname: ${data.username}\n`;
                if (data.ttl) output += `Tanggal Pembuatan: ${data.ttl}\n`;
                output += `Region: ${data.region}\n\n`;
                
                if (data.bindAccounts && data.bindAccounts.length > 0) {
                    output += `BIND INFO:\n`;
                    data.bindAccounts.forEach(b => output += `- ${b.platform}: ${b.details || 'empty'}\n`);
                    output += `\n`;
                }
                
                output += `Device Login:\n`;
                output += `- Android: ${data.devices.android} perangkat\n`;
                output += `- iOS: ${data.devices.ios} perangkat`;

                const sentMsg = await bot.sendMessage(chatId, output, {
                    reply_markup: { 
                        inline_keyboard: [[{ text: 'Stok Admin', url: STOK_ADMIN }]] 
                    }
                });

                // Cek apakah data dari Checkton sudah masuk (tunggu 3 detik)
                setTimeout(async () => {
                    try {
                        if (data.bindAccounts && data.bindAccounts.length > 0 && data.bindAccounts.length > 0) {
                            let updatedOutput = `INFORMASI AKUN (LENGKAP)\n\n`;
                            updatedOutput += `ID: ${targetId}\n`;
                            updatedOutput += `Server: ${serverId}\n`;
                            updatedOutput += `Nickname: ${data.username}\n`;
                            if (data.ttl) updatedOutput += `Tanggal Pembuatan: ${data.ttl}\n`;
                            updatedOutput += `Region: ${data.region}\n\n`;
                            
                            if (data.bindAccounts && data.bindAccounts.length > 0) {
                                updatedOutput += `BIND INFO:\n`;
                                data.bindAccounts.forEach(b => updatedOutput += `- ${b.platform}: ${b.details || 'empty'}\n`);
                                updatedOutput += `\n`;
                            }
                            
                            updatedOutput += `Device Login:\n`;
                            updatedOutput += `- Android: ${data.devices.android} perangkat\n`;
                            updatedOutput += `- iOS: ${data.devices.ios} perangkat`;
                            
                            await bot.editMessageText(updatedOutput, {
                                chat_id: chatId,
                                message_id: sentMsg.message_id,
                                reply_markup: { 
                                    inline_keyboard: [[{ text: 'Stok Admin', url: STOK_ADMIN }]] 
                                }
                            });
                        }
                    } catch (e) {}
                }, 3000);

                if (isFreeUser) {
                    db.users[userId] = db.users[userId] || { username, success: 0, credits: getUserCredits(userId) };
                    db.users[userId].username = username;
                    db.users[userId].success += 1;
                    db.total_success += 1;
                    await saveDB();
                }
            } catch (error) {
                console.log('Error /info:', error.message);
                try {
                    await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan. Silakan coba lagi nanti.');
                } catch {}
            }
        });

        // ================== COMMAND /cek (OPTIMIZED) ==================
        bot.onText(/\/cek(?:\s+(.+))?/i, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                if (!match || !match[1]) {
                    await bot.sendMessage(msg.chat.id, `Format: /cek ID_USER ID_SERVER\nContoh: /cek 643461181 8554`);
                    return;
                }
                
                const chatId = msg.chat.id, userId = msg.from.id, username = msg.from.username;
                
                if (isBanned(userId) && !isAdmin(userId)) return;
                
                if (!username && !isAdmin(userId)) {
                    await bot.sendMessage(chatId, `USERNAME DIPERLUKAN\n\nCara membuat username...`);
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
                    await bot.sendMessage(chatId, `AKSES TERBATAS...`, { reply_markup: { inline_keyboard: buttons } });
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
                
                if (targetId.length < 6) {
                    await bot.sendMessage(chatId, 'ID User MLBB minimal 6 digit. Pastikan ID benar.');
                    return;
                }
                
                const banned = await recordInfoActivity(userId);
                if (banned) return;
                
                const isFreeUser = !isAdmin(userId) && !(await isPremium(userId));
                const remaining = isFreeUser ? getRemainingLimit(userId) : 'Unlimited';
                
                if (isFreeUser && remaining <= 0) {
                    await bot.sendMessage(chatId, `BATAS PENGGUNAAN HABIS\n\nGunakan /langganan.`);
                    return;
                }
                
                const loadingMsg = await bot.sendMessage(chatId, 'Mengambil data detail...');
                const data = await getMLBBData(targetId, serverId, 'lookup');
                
                await bot.deleteMessage(chatId, loadingMsg.message_id);
                
                if (!data || !data.detailed) {
                    await bot.sendMessage(chatId, 
                        `GAGAL MENGAMBIL DATA DETAIL\n\n` +
                        `ID: ${targetId}\n` +
                        `Server: ${serverId}\n\n` +
                        `Kemungkinan penyebab:\n` +
                        `• ID/Server salah\n` +
                        `• Akun tidak ditemukan\n` +
                        `• Server API sedang sibuk\n\n` +
                        `Coba gunakan /info untuk data dasar.`
                    );
                    return;
                }

                const d = data.detailed;
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

                await bot.sendMessage(chatId, output, {
                    reply_markup: { 
                        inline_keyboard: [[{ text: 'Stok Admin', url: STOK_ADMIN }]] 
                    }
                });

                if (isFreeUser) {
                    db.users[userId] = db.users[userId] || { username, success: 0, credits: getUserCredits(userId) };
                    db.users[userId].username = username;
                    db.users[userId].success += 1;
                    await saveDB();
                }
            } catch (error) {
                console.log('Error /cek:', error.message);
                try {
                    await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan. Silakan coba lagi nanti.');
                } catch {}
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
                        `Biaya: 5000 credits`
                    );
                    return;
                }
                
                const chatId = msg.chat.id, userId = msg.from.id, username = msg.from.username;
                const searchName = match[1].trim();
                
                if (isBanned(userId) && !isAdmin(userId)) return;
                
                if (!username && !isAdmin(userId)) {
                    await bot.sendMessage(chatId, `USERNAME DIPERLUKAN\n\nCara membuat username...`);
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
                    await bot.sendMessage(chatId, `AKSES TERBATAS...`, { reply_markup: { inline_keyboard: buttons } });
                    return;
                }
                
                const credits = getUserCredits(userId);
                if (credits < 5000 && !isAdmin(userId)) {
                    await bot.sendMessage(chatId,
                        `SALDO TIDAK CUKUP\n\n` +
                        `Saldo Anda: ${credits} credits\n` +
                        `Biaya: 5000 credits\n\n` +
                        `Silakan /topup terlebih dahulu.`
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
                
                output += `\nSisa saldo: ${getUserCredits(userId)} credits`;
                
                await bot.sendMessage(chatId, output);
                
            } catch (error) {
                console.log('Error /find:', error.message);
                try {
                    await bot.deleteMessage(msg.chat.id, loadingMsg?.message_id);
                } catch {}
                await bot.sendMessage(msg.chat.id, `Gagal mengambil data.`);
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
                
                try {
                    await bot.deleteMessage(chatId, msg.message_id);
                } catch (e) {}

                if (data === 'batal_bayar' || data === 'topup_batal') {
                    await bot.answerCallbackQuery(cb.id, { text: 'Dibatalkan' });
                    await bot.sendMessage(chatId, 'Dibatalkan.');
                    return;
                }

                if (data.startsWith('topup_')) {
                    await bot.answerCallbackQuery(cb.id, { text: 'Memproses topup...' });
                    
                    const amount = parseInt(data.replace('topup_', ''));
                    
                    const validAmounts = [5000, 10000, 25000, 50000, 100000, 200000, 500000, 1000000];
                    if (!validAmounts.includes(amount)) {
                        await bot.sendMessage(chatId, 'Nominal tidak valid.');
                        return;
                    }
                    
                    const loading = await bot.sendMessage(chatId, 'Membuat pembayaran...');
                    
                    const payment = await createPakasirTopup(amount, userId);
                    
                    try {
                        await bot.deleteMessage(chatId, loading.message_id);
                    } catch (e) {}
                    
                    if (!payment.success) {
                        await bot.sendMessage(chatId, `Gagal: ${payment.error}`);
                        return;
                    }
                    
                    try {
                        const qrBuffer = await QRCode.toBuffer(payment.qrString, { 
                            errorCorrectionLevel: 'L', 
                            margin: 1, 
                            width: 256 
                        });
                        
                        const sentMessage = await bot.sendPhoto(chatId, qrBuffer, {
                            caption: 
                                `TOP UP SALDO\n\n` +
                                `Nominal: Rp ${amount.toLocaleString()}\n` +
                                `Saldo: ${amount} credits\n\n` +
                                `Order ID: ${payment.orderId}\n` +
                                `Berlaku sampai: ${payment.expiredAt} WIB\n\n` +
                                `Scan QR code di atas untuk membayar.`
                        });
                        
                        if (db.pending_topups && db.pending_topups[payment.orderId]) {
                            db.pending_topups[payment.orderId].messageId = sentMessage.message_id;
                            db.pending_topups[payment.orderId].chatId = chatId;
                            await saveDB();
                            console.log(`Message ID tersimpan untuk ${payment.orderId}`);
                        }
                        
                    } catch (qrError) {
                        console.log('Error kirim QR:', qrError.message);
                        await bot.sendMessage(chatId,
                            `TOP UP SALDO\n\n` +
                            `Nominal: Rp ${amount.toLocaleString()}\n` +
                            `Saldo: ${amount} credits\n\n` +
                            `QR Code:\n${payment.qrString}\n\n` +
                            `Order ID: ${payment.orderId}`
                        );
                    }
                    
                    return;
                }

                if (data.startsWith('langganan_')) {
                    await bot.answerCallbackQuery(cb.id, { text: 'Memproses langganan...' });
                    
                    const pilihan = data.replace('langganan_', '');
                    const paket = {
                        '1': { days: 1, price: 10000, name: '1 Hari' },
                        '3': { days: 3, price: 25000, name: '3 Hari' },
                        '7': { days: 7, price: 45000, name: '7 Hari' },
                        '30': { days: 30, price: 100000, name: '30 Hari' }
                    };
                    
                    const selected = paket[pilihan];
                    if (!selected) {
                        await bot.sendMessage(chatId, 'Pilihan tidak valid.');
                        return;
                    }
                    
                    const credits = getUserCredits(userId);
                    
                    if (credits < selected.price && !isAdmin(userId)) {
                        await bot.sendMessage(chatId,
                            `SALDO TIDAK CUKUP\n\n` +
                            `Saldo Anda: ${credits} credits\n` +
                            `Harga paket: ${selected.price} credits\n\n` +
                            `Silakan /topup terlebih dahulu.`
                        );
                        return;
                    }
                    
                    if (!isAdmin(userId)) {
                        db.users[userId].credits -= selected.price;
                        await saveDB();
                    }
                    
                    const expiredAt = await activatePremium(userId, selected.days, selected.name, 'saldo');
                    
                    if (!expiredAt) {
                        await bot.sendMessage(chatId, 'Gagal mengaktifkan premium.');
                        return;
                    }
                    
                    await bot.sendMessage(chatId,
                        `LANGGANAN BERHASIL\n\n` +
                        `Paket: ${selected.name}\n` +
                        `Harga: ${selected.price} credits\n` +
                        `Sisa saldo: ${getUserCredits(userId)} credits\n\n` +
                        `Premium sampai: ${moment.unix(expiredAt).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')} WIB`
                    );
                    
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
                
                for (const [orderId, data] of Object.entries(db.pending_payments || {})) {
                    if (orderId.startsWith('TOPUP-')) {
                        if (!db.pending_topups) db.pending_topups = {};
                        db.pending_topups[orderId] = { ...data, status: data.status };
                        delete db.pending_payments[orderId];
                        await saveDB();
                        continue;
                    }
                    
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
                            console.log(`Cron job: Premium sukses ${orderId}`);
                            
                            if (data.processed) {
                                console.log(`Order ${orderId} sudah diproses, lewati`);
                                continue;
                            }
                            
                            const userId = data.userId;
                            const days = { '1 Hari':1, '3 Hari':3, '7 Hari':7, '30 Hari':30 }[data.duration] || 1;
                            
                            const expiredAt = await activatePremium(userId, days, data.duration, 'qris');
                            
                            if (!expiredAt) continue;
                            
                            db.pending_payments[orderId].status = 'paid';
                            db.pending_payments[orderId].processed = true;
                            db.pending_payments[orderId].notified = true;
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
                    .sort((a,b) => b[1].success - a[1].success)
                    .slice(0,10);
                let message = 'PERINGKAT PENGGUNA\n\n';
                users.forEach(([id,data],i) => message += `${i+1}. ${data.username || 'unknown'} - ${data.success}x\n`);
                await bot.sendMessage(msg.chat.id, message || 'Belum ada data');
            } catch (error) {}
        });

        bot.onText(/\/listpremium/, async (msg) => {
            try {
                if (msg.chat.type !== 'private') return;
                if (!isAdmin(msg.from.id)) return;
                
                let message = 'DAFTAR USER PREMIUM\n\n';
                const premiumList = Object.entries(db.premium || {});
                
                if (premiumList.length === 0) {
                    message += 'Belum ada user premium.';
                } else {
                    premiumList.forEach(([id, data], i) => {
                        const expired = moment.unix(data.expired_at).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm');
                        message += `${i+1}. ${id} - ${data.duration}\n`;
                        message += `   Exp: ${expired} WIB\n\n`;
                    });
                }
                
                await bot.sendMessage(msg.chat.id, message);
            } catch (error) {
                console.log('Error /listpremium:', error.message);
            }
        });

        bot.onText(/\/deletepremium (\d+)/, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                if (!isAdmin(msg.from.id)) return;
                
                const targetId = parseInt(match[1]);
                
                if (db.premium[targetId]) {
                    delete db.premium[targetId];
                    await saveDB();
                    
                    await bot.sendMessage(msg.chat.id, `Premium user ${targetId} telah dihapus.`);
                    
                    try {
                        await bot.sendMessage(targetId, 
                            `STATUS PREMIUM ANDA TELAH DIHAPUS\n\n` +
                            `Hubungi admin jika ada kesalahan.`
                        );
                    } catch (e) {}
                } else {
                    await bot.sendMessage(msg.chat.id, `User ${targetId} tidak ditemukan dalam daftar premium.`);
                }
            } catch (error) {
                console.log('Error /deletepremium:', error.message);
            }
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
                    message += `Saldo saat ini: ${user.credits || 0} credits\n\n`;
                    
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
                            message += `   Saldo: ${u.credits || 0} credits\n\n`;
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

        bot.onText(/\/addpremium (\d+) (\d+)/, async (msg, match) => {
            try {
                if (msg.chat.type !== 'private') return;
                if (!isAdmin(msg.from.id)) return;
                
                const targetId = parseInt(match[1]);
                const days = parseInt(match[2]);
                
                if (days < 1 || days > 365) {
                    await bot.sendMessage(msg.chat.id, 'Durasi harus 1-365 hari.');
                    return;
                }
                
                const expiredAt = await activatePremium(targetId, days, `${days} Hari (Manual)`, 'manual');
                
                if (!expiredAt) {
                    await bot.sendMessage(msg.chat.id, 'Gagal menambahkan premium.');
                    return;
                }
                
                await bot.sendMessage(msg.chat.id, 
                    `Premium ${days} hari untuk ${targetId}.\n` +
                    `Berlaku sampai: ${moment.unix(expiredAt).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')} WIB`
                );
                
                try {
                    await bot.sendMessage(targetId, 
                        `AKUN ANDA DIUPGRADE\n\n` +
                        `Sekarang Anda adalah user PREMIUM selama ${days} hari.\n` +
                        `Berlaku sampai: ${moment.unix(expiredAt).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')} WIB`
                    );
                } catch (e) {}
                
            } catch (error) {
                console.log('Error /addpremium:', error.message);
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
                    `Jumlah: ${amount} credits\n` +
                    `Saldo sekarang: ${newBalance} credits`
                );
                
                try {
                    await bot.sendMessage(targetId, 
                        `SALDO DITAMBAH ADMIN\n\n` +
                        `Saldo Anda bertambah ${amount} credits.\n` +
                        `Saldo sekarang: ${newBalance} credits`
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
