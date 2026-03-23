const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const moment = require('moment-timezone');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const redis = require('redis');

const v8 = require('v8');
v8.setFlagsFromString('--max-old-space-size=256');

if (global.gc) {
    setInterval(() => {
        try {
            global.gc();
            console.log('Garbage collection done');
        } catch (e) {
            console.log('GC error:', e.message);
        }
    }, 60000);
}

process.on('uncaughtException', (error) => {
    console.log('ERROR GLOBAL:', error.message);
    console.log(error.stack);
});

process.on('unhandledRejection', (reason) => {
    console.log('UNHANDLED REJECTION:', reason);
});

const IS_WORKER = process.env.DYNO && process.env.DYNO.includes('worker');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL = process.env.CHANNEL;
const GROUP = process.env.GROUP;
const STOK_ADMIN = process.env.STOK_ADMIN;
const REDIS_URL = process.env.REDIS_URL || process.env.REDISCLOUD_URL;
const API_KEY_CHECKTON = process.env.API_KEY_CHECKTON;

const ADMIN_IDS = process.env.ADMIN_IDS 
    ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) 
    : [];

const LANGUAGES = {
    id: 'id',
    en: 'en'
};

const DEFAULT_LANG = LANGUAGES.en;

const texts = {
    welcome: {
        id: `SELAMAT DATANG DI NCUS BOT\n\nDaftar layanan dan harga:\n- CHECK BIND - GRATIS\n- FULL INFO - Rp 5.000\n- CARI ID VIA NICKNAME - Rp 5.000\n- Langganan akses /find dan /cek unlimited`,
        en: `WELCOME TO NCUS BOT\n\nServices and prices:\n- CHECK BIND - FREE\n- FULL INFO - Rp 5,000\n- FIND ID BY NICKNAME - Rp 5,000\n- Subscription for unlimited /find and /cek access`
    },
    
    buttons: {
        full_info: { id: 'FULL INFO', en: 'FULL INFO' },
        check_info: { id: 'CHECK BIND', en: 'CHECK BIND' },
        find_id: { id: 'CARI ID VIA NICKNAME', en: 'FIND ID BY NICKNAME' },
        topup: { id: 'TOP UP', en: 'TOP UP' },
        subscription: { id: 'LANGGANAN', en: 'SUBSCRIPTION' },
        profile: { id: 'PROFILE', en: 'PROFILE' },
        admin_menu: { id: 'ADMIN MENU', en: 'ADMIN MENU' },
        back_to_menu: { id: 'Kembali ke Menu', en: 'Back to Menu' },
        cancel: { id: 'Batal', en: 'Cancel' },
        stock_admin: { id: 'Stok Admin', en: 'Admin Stock' },
        language: { id: 'LANGUAGE', en: 'LANGUAGE' }
    },
    
    full_info_menu: {
        id: `FULL INFO\n\nPerintah ini digunakan untuk melihat detail lengkap akun MLBB.\n\nCara Penggunaan:\nKirim perintah:\n/cek ID SERVER\n\nContoh:\n/cek 123456789 1234\n\nBot akan menampilkan informasi akun dengan detail seperti tanggal pembuatan akun dll.\n\nBiaya Rp 5.000`,
        en: `FULL INFO\n\nThis command is used to view complete MLBB account details.\n\nHow to use:\nSend command:\n/cek ID SERVER\n\nExample:\n/cek 123456789 1234\n\nThe bot will display account information with details like account creation date etc.\n\nCost Rp 5,000`
    },
    
    check_info_menu: {
        id: `CHECK BIND\n\nPerintah ini digunakan untuk melihat informasi akun terhubung pada MLBB.\n\nCara Penggunaan:\nKirim perintah:\n/info ID SERVER\n\nContoh:\n/info 123456789 1234\n\nBot akan menampilkan email, Facebook, dan akun sosial lainnya yang terhubung.\n\nCHECK BIND VIA GROUP\n\nTambahkan bot @mahsuselitzbot ke group dan jadikan admin group\nCara Penggunaan di dalam group:\nKirim perintah:\n/cekinfo ID SERVER\n\nContoh:\n/cekinfo 123456789 1234\n\nBiaya Rp 0`,
        en: `CHECK BIND\n\nThis command is used to view connected account information on MLBB.\n\nHow to use:\nSend command:\n/info ID SERVER\n\nExample:\n/info 123456789 1234\n\nThe bot will display email, Facebook, and other connected social accounts.\n\nCHECK BIND VIA GROUP\n\nAdd bot @mahsuselitzbot to group and make it admin\nHow to use in group:\nSend command:\n/cekinfo ID SERVER\n\nExample:\n/cekinfo 123456789 1234\n\nCost Rp 0`
    },
    
    find_id_menu: {
        id: `CARI ID VIA NICKNAME\n\nPerintah ini digunakan untuk mencari ID akun MLBB berdasarkan nickname.\n\nCara Penggunaan:\nKirim perintah:\n/find NICKNAME SERVER\n\nContoh:\n/find RRQ Jule 15707\n\nBot akan menampilkan pemain dengan format ID, lokasi dan negara terakhir login.\n\nBiaya Rp 5.000`,
        en: `FIND ID BY NICKNAME\n\nThis command is used to find MLBB account ID by nickname.\n\nHow to use:\nSend command:\n/find NICKNAME SERVER\n\nExample:\n/find RRQ Jule 15707\n\nThe bot will display players with ID, location and last login country.\n\nCost Rp 5,000`
    },
    
    profile: {
        title: { id: 'PROFILE USER', en: 'USER PROFILE' },
        user_id: { id: 'User ID', en: 'User ID' },
        username: { id: 'Username', en: 'Username' },
        balance: { id: 'Saldo', en: 'Balance' },
        subscription_status: { id: 'Status Langganan', en: 'Subscription Status' },
        active: { id: 'Aktif', en: 'Active' },
        inactive: { id: 'Tidak aktif', en: 'Inactive' },
        valid_until: { id: 'Berlaku sampai', en: 'Valid until' },
        total_checks: { id: 'Total Pengecekan', en: 'Total Checks' },
        times: { id: 'kali', en: 'times' }
    },
    
    topup: {
        title: { id: 'TOP UP SALDO', en: 'TOP UP BALANCE' },
        your_balance: { id: 'Saldo Anda', en: 'Your balance' },
        select_amount: { id: 'Pilih nominal top up:', en: 'Select top up amount:' }
    },
    
    subscription: {
        title: { id: 'Akses unlimited untuk fitur /cek dan /find tanpa limit\nsilahkan pilih paket:', en: 'Unlimited access to /cek and /find features\nplease select package:' },
        days7: { id: '7 Hari (Rp 50.000)', en: '7 Days (Rp 50,000)' },
        days30: { id: '30 Hari (Rp 100.000)', en: '30 Days (Rp 100,000)' }
    },
    
    subscription_messages: {
        extended: {
            id: (type, amount, balance, endDate) => `LANGGANAN DIPERPANJANG\n\nPaket: ${type === '7days' ? '7 Hari' : '30 Hari'}\nBiaya: Rp ${amount.toLocaleString()}\nSisa saldo: Rp ${balance.toLocaleString()}\nBerlaku sampai: ${endDate} WIB\n\nTerima kasih telah memperpanjang langganan!`,
            en: (type, amount, balance, endDate) => `SUBSCRIPTION EXTENDED\n\nPackage: ${type === '7days' ? '7 Days' : '30 Days'}\nCost: Rp ${amount.toLocaleString()}\nRemaining balance: Rp ${balance.toLocaleString()}\nValid until: ${endDate} WIB\n\nThank you for extending your subscription!`
        },
        new: {
            id: (type, amount, balance, endDate) => `LANGGANAN AKTIF\n\nSelamat! Langganan Anda telah aktif.\n\nPaket: ${type === '7days' ? '7 Hari' : '30 Hari'}\nBiaya: Rp ${amount.toLocaleString()}\nSisa saldo: Rp ${balance.toLocaleString()}\nBerlaku sampai: ${endDate} WIB\n\nAnda sekarang memiliki akses unlimited ke fitur /cek dan /find.`,
            en: (type, amount, balance, endDate) => `SUBSCRIPTION ACTIVE\n\nCongratulations! Your subscription is now active.\n\nPackage: ${type === '7days' ? '7 Days' : '30 Days'}\nCost: Rp ${amount.toLocaleString()}\nRemaining balance: Rp ${balance.toLocaleString()}\nValid until: ${endDate} WIB\n\nYou now have unlimited access to /cek and /find features.`
        },
        expired_notification: {
            id: `NOTIFIKASI LANGGANAN\n\nLangganan Anda telah berakhir.\n\nAkses unlimited untuk fitur /cek dan /find telah dinonaktifkan.\nSilakan perpanjang langganan untuk mendapatkan akses kembali.\n\nKetik /start atau tekan tombol LANGGANAN untuk memperpanjang.`,
            en: `SUBSCRIPTION NOTIFICATION\n\nYour subscription has expired.\n\nUnlimited access to /cek and /find features has been disabled.\nPlease renew your subscription to regain access.\n\nType /start or press the SUBSCRIPTION button to renew.`
        },
        not_enough_balance: {
            id: (credits, amount) => `Saldo tidak cukup\n\nSaldo Anda: Rp ${credits.toLocaleString()}\nButuh: Rp ${amount.toLocaleString()}\nKekurangan: Rp ${(amount - credits).toLocaleString()}\n\nSilakan top up terlebih dahulu.`,
            en: (credits, amount) => `Insufficient balance\n\nYour balance: Rp ${credits.toLocaleString()}\nRequired: Rp ${amount.toLocaleString()}\nShortage: Rp ${(amount - credits).toLocaleString()}\n\nPlease top up first.`
        }
    },
    
    language_menu: {
        title: `SELECT LANGUAGE / PILIH BAHASA:`,
        indonesian: `Indonesia`,
        english: `English`,
        changed_id: `Bahasa diubah ke Indonesia`,
        changed_en: `Language changed to English`
    },
    
    cancel_topup: { id: 'Pembayaran dibatalkan', en: 'Payment cancelled' },
    processing: { id: 'Memproses topup...', en: 'Processing topup...' },
    invalid_amount: { id: 'Nominal tidak valid.', en: 'Invalid amount.' },
    command_not_recognized: { id: 'Perintah tidak dikenal', en: 'Command not recognized' },
    error_occurred: { id: 'Terjadi kesalahan', en: 'An error occurred' },
    user_not_found: { id: 'User ID harus angka. Coba lagi:', en: 'User ID must be a number. Try again:' },
    amount_invalid: { id: 'Nominal harus angka 1-1.000.000. Coba lagi:', en: 'Amount must be a number 1-1,000,000. Try again:' },
    group_id_invalid: { id: 'Group ID harus angka. Coba lagi:', en: 'Group ID must be a number. Try again:' },
    group_id_instruction: { id: 'Perintah ini hanya dapat digunakan di dalam grup.', en: 'This command can only be used in a group.' },
    admin_only: { id: 'Hanya admin bot yang dapat menggunakan perintah ini.', en: 'Only bot admin can use this command.' },
    group_id_result: { id: (chatId) => `ID Grup ini adalah: ${chatId}`, en: (chatId) => `This Group ID is: ${chatId}` },
    
    loading: {
        fetching: { id: 'Mengambil data akun...', en: 'Fetching account data...' },
        searching: { id: 'Mencari akun...', en: 'Searching for accounts...' },
        creating_payment: { id: 'Membuat pembayaran...', en: 'Creating payment...' },
        retry: { id: (retry, max) => `Mengambil data detail... (Percobaan ${retry}/${max})`, en: (retry, max) => `Fetching details... (Attempt ${retry}/${max})` }
    },
    
    info_command: {
        title: { id: 'INFORMASI AKUN GRATIS', en: 'FREE ACCOUNT INFO' },
        format: { id: 'Format: /info ID_USER ID_SERVER\nContoh: /info 123456789 1234', en: 'Format: /info ID SERVER\nExample: /info 123456789 1234' }
    },
    
    cek_command: {
        title: { id: 'DETAIL ACCOUNT', en: 'ACCOUNT DETAILS' },
        format: { id: 'Format: /cek ID SERVER\nContoh: /cek 123456789 1234', en: 'Format: /cek ID SERVER\nExample: /cek 123456789 1234' },
        wrong_format: { id: 'FORMAT SALAH\n\nFormat yang benar:\n/cek ID SERVER\n\nID dan Server harus berupa angka.', en: 'WRONG FORMAT\n\nCorrect format:\n/cek ID SERVER\n\nID and Server must be numbers.' }
    },
    
    find_command: {
        title: { id: 'CARI ID VIA NICKNAME', en: 'FIND ID BY NICKNAME' },
        format: { id: 'Gunakan format:\n/find NICKNAME SERVER\n\nContoh:\n/find RRQ Jule 15707', en: 'Use format:\n/find NICKNAME SERVER\n\nExample:\n/find RRQ Jule 15707' },
        wrong_format: { id: 'FORMAT SALAH\n\nFormat yang benar:\n/find NICKNAME SERVER\n\nContoh: /find RRQ Jule 15707', en: 'WRONG FORMAT\n\nCorrect format:\n/find NICKNAME SERVER\n\nExample: /find RRQ Jule 15707' }
    },
    
    insufficient_balance: {
        id: (credits, required) => `SALDO TIDAK CUKUP\n\nSaldo Anda: Rp ${credits.toLocaleString()}\nBiaya: Rp ${required.toLocaleString()}\nKekurangan: Rp ${(required - credits).toLocaleString()}\n\nSilakan isi saldo atau berlangganan:`,
        en: (credits, required) => `INSUFFICIENT BALANCE\n\nYour balance: Rp ${credits.toLocaleString()}\nCost: Rp ${required.toLocaleString()}\nShortage: Rp ${(required - credits).toLocaleString()}\n\nPlease top up or subscribe:`
    },
    
    join_required: {
        id: `AKSES DITOLAK\n\nAnda WAJIB bergabung jika menggunakan bot ini:\n\n`,
        en: `ACCESS DENIED\n\nYou MUST join to use this bot:\n\n`
    },
    
    join_channel: { id: 'Bergabung ke Channel', en: 'Join Channel' },
    join_group: { id: 'Bergabung ke Group', en: 'Join Group' },
    
    not_found: {
        id: (type, id, server) => `AKUN TIDAK DITEMUKAN\n\n${type}: ${id}\nServer: ${server}\n\nPastikan ID dan Server yang dimasukkan benar.`,
        en: (type, id, server) => `ACCOUNT NOT FOUND\n\n${type}: ${id}\nServer: ${server}\n\nMake sure the ID and Server are correct.`
    },
    
    error: {
        id: 'REQUEST SEDANG ERROR\n\nSILAHKAN COBA LAGI NANTI',
        en: 'REQUEST ERROR\n\nPLEASE TRY AGAIN LATER'
    },
    
    payment: {
        success: { 
            id: (amount, orderId, balance) => `PEMBAYARAN BERHASIL\n\nTerima kasih! Pembayaran Anda telah kami terima.\n\nDetail Transaksi:\nOrder ID: ${orderId}\nJumlah: Rp ${amount.toLocaleString()}\nStatus: BERHASIL\n\nSaldo Anda sekarang: Rp ${balance.toLocaleString()}\n\nSilakan gunakan bot untuk melakukan pengecekan.`,
            en: (amount, orderId, balance) => `PAYMENT SUCCESSFUL\n\nThank you! Your payment has been received.\n\nTransaction Details:\nOrder ID: ${orderId}\nAmount: Rp ${amount.toLocaleString()}\nStatus: SUCCESS\n\nYour balance is now: Rp ${balance.toLocaleString()}\n\nPlease use the bot to check.`
        },
        failed: {
            id: (amount, orderId) => `PEMBAYARAN GAGAL\n\nMaaf, pembayaran Anda gagal atau kadaluarsa.\n\nDetail Transaksi:\nOrder ID: ${orderId}\nJumlah: Rp ${amount.toLocaleString()}\nStatus: GAGAL\n\nSilakan lakukan top up ulang jika masih membutuhkan.`,
            en: (amount, orderId) => `PAYMENT FAILED\n\nSorry, your payment failed or expired.\n\nTransaction Details:\nOrder ID: ${orderId}\nAmount: Rp ${amount.toLocaleString()}\nStatus: FAILED\n\nPlease top up again if you still need it.`
        },
        qr_caption: {
            id: (amount, orderId, expiredAt) => `TOP UP SALDO\n\nNominal: Rp ${amount.toLocaleString()}\nSaldo didapat: Rp ${amount.toLocaleString()}\n\nOrder ID: ${orderId}\nBerlaku sampai: ${expiredAt} WIB\n\nScan QR code di atas untuk membayar.`,
            en: (amount, orderId, expiredAt) => `TOP UP BALANCE\n\nAmount: Rp ${amount.toLocaleString()}\nBalance received: Rp ${amount.toLocaleString()}\n\nOrder ID: ${orderId}\nValid until: ${expiredAt} WIB\n\nScan the QR code above to pay.`
        }
    },
    
    admin: {
        access_denied: {
            id: `Akses ditolak. Anda bukan admin.`,
            en: `Access denied. You are not an admin.`
        },
        add_topup: {
            id: `TAMBAH SALDO USER\n\nMasukkan User ID:\n\nContoh: 123456789`,
            en: `ADD USER BALANCE\n\nEnter User ID:\n\nExample: 123456789`
        },
        add_topup_amount: {
            id: (targetId) => `User ID: ${targetId}\n\nMasukkan nominal topup (Rp):\n\nContoh: 50000`,
            en: (targetId) => `User ID: ${targetId}\n\nEnter topup amount (Rp):\n\nExample: 50000`
        },
        add_topup_success: {
            id: (targetId, amount, balance) => `TOPUP MANUAL BERHASIL\n\nUser: ${targetId}\nJumlah: Rp ${amount.toLocaleString()}\nSaldo sekarang: Rp ${balance.toLocaleString()}`,
            en: (targetId, amount, balance) => `MANUAL TOPUP SUCCESS\n\nUser: ${targetId}\nAmount: Rp ${amount.toLocaleString()}\nCurrent balance: Rp ${balance.toLocaleString()}`
        },
        add_group: {
            id: `TAMBAH GROUP\n\nMasukkan Group ID:\n\nContoh: -1001234567890\n\n(Gunakan /idgrup di grup untuk mengetahui ID grup)`,
            en: `ADD GROUP\n\nEnter Group ID:\n\nExample: -1001234567890\n\n(Use /idgrup in group to find group ID)`
        },
        remove_group: {
            id: `HAPUS GROUP\n\nMasukkan Group ID yang ingin dihapus:\n\nContoh: -1001234567890`,
            en: `REMOVE GROUP\n\nEnter Group ID to remove:\n\nExample: -1001234567890`
        },
        group_already_exists: {
            id: (groupId) => `Grup ${groupId} sudah terdaftar.`,
            en: (groupId) => `Group ${groupId} is already registered.`
        },
        group_added: {
            id: (groupId) => `Grup ${groupId} berhasil ditambahkan.`,
            en: (groupId) => `Group ${groupId} successfully added.`
        },
        group_not_found: {
            id: (groupId) => `Grup ${groupId} tidak ditemukan.`,
            en: (groupId) => `Group ${groupId} not found.`
        },
        group_removed: {
            id: (groupId) => `Grup ${groupId} berhasil dihapus.`,
            en: (groupId) => `Group ${groupId} successfully removed.`
        },
        broadcast_start: {
            id: `BROADCAST PESAN\n\nKirim pesan yang ingin disebarkan ke semua user.\n\nFormat yang didukung:\n- Teks biasa\n- Foto (bisa dengan caption)\n- Video (bisa dengan caption)\n- Dokumen (bisa dengan caption)\n- Audio (bisa dengan caption)\n- Voice Note\n- Sticker\n- GIF/Animation (bisa dengan caption)\n\nKetik pesan atau kirim media sekarang.`,
            en: `BROADCAST MESSAGE\n\nSend the message you want to broadcast to all users.\n\nSupported formats:\n- Plain text\n- Photo (with caption)\n- Video (with caption)\n- Document (with caption)\n- Audio (with caption)\n- Voice Note\n- Sticker\n- GIF/Animation (with caption)\n\nType message or send media now.`
        },
        broadcast_result: {
            id: (success, failed, mediaType, mediaInfo) => `BROADCAST SELESAI\n\nBerhasil: ${success}\nGagal: ${failed}\n\nMedia yang dikirim: ${mediaType}${mediaInfo}`,
            en: (success, failed, mediaType, mediaInfo) => `BROADCAST COMPLETED\n\nSuccess: ${success}\nFailed: ${failed}\n\nMedia sent: ${mediaType}${mediaInfo}`
        },
        feature_off: {
            id: `Fitur info telah dinonaktifkan.`,
            en: `Info feature has been disabled.`
        },
        feature_on: {
            id: `Fitur info telah diaktifkan.`,
            en: `Info feature has been enabled.`
        },
        no_users: {
            id: `Tidak ada pengguna terdaftar.`,
            en: `No registered users.`
        },
        no_groups: {
            id: `Belum ada grup terdaftar.`,
            en: `No groups registered yet.`
        }
    },
    
    group: {
        not_allowed: {
            id: `Grup ini belum terdaftar. Silakan minta izin ke @ncus999 untuk mendaftarkan grup ini.`,
            en: `This group is not registered. Please ask @ncus999 for permission to register this group.`
        },
        format: {
            id: `INFORMASI AKUN TERHUBUNG\n\nFormat: /cekinfo ID SERVER\nContoh: /cekinfo 123456789 1234`,
            en: `CHECK BIND PLATFORM\n\nFormat: /cekinfo ID SERVER\nExample: /cekinfo 123456789 1234`
        },
        feature_disabled: {
            id: `Fitur info sedang dinonaktifkan oleh admin.`,
            en: `Info feature is currently disabled by admin.`
        }
    },
    
    admin_menu: {
        title: { id: 'ADMIN MENU', en: 'ADMIN MENU' },
        stats: { id: 'STATISTIK', en: 'STATISTICS' },
        total_users: { id: 'Total User', en: 'Total Users' },
        total_checks: { id: 'Total Pengecekan', en: 'Total Checks' },
        total_balance: { id: 'Total Saldo', en: 'Total Balance' },
        total_subscriptions: { id: 'Total Langganan Aktif', en: 'Active Subscriptions' },
        select_menu: { id: 'Pilih menu di bawah:', en: 'Select menu below:' }
    },
    
    // [TAMBAHAN] all_command dengan bahasa Indonesia
    all_command: {
        admin_only: {
            id: `Hanya admin grup yang dapat menggunakan perintah ini!`,
            en: `Only group admins can use this command!`
        },
        fetching_members: {
            id: `Mengambil daftar anggota...`,
            en: `Fetching members...`
        },
        failed_fetch: {
            id: `Gagal mengambil daftar anggota.\n\nPastikan bot adalah admin grup dengan izin "Get member list"`,
            en: `Failed to fetch members.\n\nMake sure bot is group admin with "Get member list" permission`
        },
        no_members: {
            id: `Tidak ada anggota yang dapat di-mention.`,
            en: `No members to mention.`
        },
        error_permission: {
            id: `Gagal mengirim mention.\n\nBot tidak memiliki izin yang cukup.\n\nPastikan bot adalah admin grup dengan izin:\n- Get member list\n- Send messages\n- Mention users`,
            en: `Failed to send mention.\n\nBot does not have sufficient permissions.\n\nMake sure bot is group admin with permissions:\n- Get member list\n- Send messages\n- Mention users`
        },
        announcement_format: {
            id: (adminName, adminMessage, mentionText, time) => {
                if (adminMessage) {
                    return `*PENGUMUMAN DARI ${adminName}*\n\n${adminMessage}\n\n${mentionText}\n\n*Waktu:* ${time} WIB`;
                } else {
                    return `*PERHATIAN DARI ${adminName}*\n\n${mentionText}\n\n*Waktu:* ${time} WIB`;
                }
            },
            en: (adminName, adminMessage, mentionText, time) => {
                if (adminMessage) {
                    return `*ANNOUNCEMENT FROM ${adminName}*\n\n${adminMessage}\n\n${mentionText}\n\n*Time:* ${time} WIB`;
                } else {
                    return `*ATTENTION FROM ${adminName}*\n\n${mentionText}\n\n*Time:* ${time} WIB`;
                }
            }
        }
    }
};

function getText(key, lang, ...args) {
    const textObj = texts[key];
    if (!textObj) return key;
    
    if (typeof textObj === 'function') {
        return textObj[lang](...args);
    }
    
    if (typeof textObj === 'object' && !Array.isArray(textObj)) {
        return textObj[lang] || textObj[DEFAULT_LANG];
    }
    
    return textObj;
}

function getButtonText(key, lang) {
    const button = texts.buttons[key];
    return button ? button[lang] : key;
}

let db = { 
    users: {}, 
    total_success: 0, 
    feature: { info: true },
    pending_topups: {},
    allowed_groups: [] 
};

let adminState = {};

function setAdminState(userId, action, step, data = {}) {
    adminState[userId] = { action, step, data, timestamp: Date.now() };
}

function getAdminState(userId) {
    return adminState[userId];
}

function clearAdminState(userId) {
    delete adminState[userId];
}

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
        const start = Date.now();
        
        const res = await pool.query('SELECT value FROM bot_data WHERE key = $1', ['database']);
        if (res.rows.length > 0) {
            db = res.rows[0].value;
            if (!db.allowed_groups) db.allowed_groups = [];
            const duration = Date.now() - start;
            console.log(`Load database sukses. Total users: ${Object.keys(db.users || {}).length} (${duration}ms)`);
        } else {
            console.log('Database kosong, pakai default');
        }
    } catch (error) {
        console.log('Gagal load database:', error.message);
        try {
            if (fs.existsSync('database.json')) {
                const data = fs.readFileSync('database.json', 'utf8');
                db = JSON.parse(data);
                if (!db.allowed_groups) db.allowed_groups = [];
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
        
        pool.query("SELECT pg_notify('db_updated', 'reload')").catch(err => {
            console.log('Gagal mengirim NOTIFY:', err.message);
        });
        
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

initDB().then(async () => {
    await loadDB();
});

let redisClient = null;
if (REDIS_URL) {
    try {
        redisClient = redis.createClient({ 
            url: REDIS_URL,
            socket: {
                reconnectStrategy: function(retries) {
                    if (retries > 10) {
                        console.log('Redis max retries reached');
                        return new Error('Max retries');
                    }
                    return Math.min(retries * 100, 3000);
                }
            }
        });
        
        redisClient.on('error', (err) => console.log('Redis Client Error', err));
        redisClient.on('connect', () => console.log('Redis connected for relay'));
        
        redisClient.connect().catch(err => {
            console.log('Redis connection failed:', err.message);
            redisClient = null;
        });
    } catch (error) {
        console.log('Redis init error:', error.message);
        redisClient = null;
    }
} else {
    console.log('REDIS_URL not set, running without Redis');
}

function isAdmin(userId) { 
    return ADMIN_IDS.includes(userId); 
}

function isGroupAllowed(groupId) {
    return db.allowed_groups && db.allowed_groups.includes(Number(groupId));
}

function getUserCredits(userId, username = '') {
    try {
        if (!db.users[userId]) {
            db.users[userId] = { 
                username: username, 
                success: 0, 
                credits: 0, 
                topup_history: [],
                language: DEFAULT_LANG
            };
            console.log(`User baru dibuat: ${userId} dengan username ${username}`);
            
            saveDB().catch(err => {
                console.log('Error saving new user:', err.message);
            });
        } else if (username && db.users[userId].username !== username) {
            db.users[userId].username = username;
            saveDB().catch(err => {
                console.log('Error updating username:', err.message);
            });
        }
        
        if (!db.users[userId].language) {
            db.users[userId].language = DEFAULT_LANG;
            saveDB().catch(err => console.log('Error saving language:', err.message));
        }
        
        return db.users[userId].credits || 0;
    } catch (error) {
        console.log('Error getUserCredits:', error.message);
        return 0;
    }
}

function getUserLanguage(userId) {
    try {
        if (db.users[userId] && db.users[userId].language) {
            return db.users[userId].language;
        }
    } catch (error) {
        console.log('Error getUserLanguage:', error.message);
    }
    return DEFAULT_LANG;
}

async function setUserLanguage(userId, language) {
    try {
        if (!db.users[userId]) {
            db.users[userId] = { 
                username: '', 
                success: 0, 
                credits: 0, 
                topup_history: [],
                language: language
            };
        } else {
            db.users[userId].language = language;
        }
        await saveDB();
        return true;
    } catch (error) {
        console.log('Error setUserLanguage:', error.message);
        return false;
    }
}

async function addCredits(userId, amount, orderId = null) {
    try {
        console.log(`ADD CREDITS: user ${userId}, amount ${amount}, order ${orderId}`);
        
        if (!db.users[userId]) {
            db.users[userId] = { 
                username: '', 
                success: 0, 
                credits: 0, 
                topup_history: [],
                language: DEFAULT_LANG
            };
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
        
        console.log(`ADD CREDITS BERHASIL: ${oldBalance} -> ${db.users[userId].credits}`);
        return db.users[userId].credits;
    } catch (error) {
        console.log('Error addCredits:', error.message);
        return getUserCredits(userId);
    }
}

function hasActiveSubscription(userId) {
    const user = db.users[userId];
    if (!user || !user.subscription) return false;
    const now = new Date();
    const endDate = new Date(user.subscription.end_date);
    return user.subscription.active && endDate > now;
}

async function checkAndUpdateExpiredSubscription(userId) {
    const user = db.users[userId];
    if (!user || !user.subscription) return false;
    
    const now = new Date();
    const endDate = new Date(user.subscription.end_date);
    
    if (user.subscription.active && endDate <= now) {
        user.subscription.active = false;
        await saveDB();
        console.log(`Langganan user ${userId} expired pada ${endDate}, status dinonaktifkan`);
        
        const lang = getUserLanguage(userId);
        const expiredMsg = texts.subscription_messages.expired_notification[lang];
        
        try {
            await bot.sendMessage(userId, expiredMsg);
        } catch (notifError) {
            console.log(`Gagal kirim notifikasi expired ke ${userId}:`, notifError.message);
        }
        
        return false;
    }
    
    return user.subscription.active && endDate > now;
}

async function activateSubscription(userId, type) {
    const now = new Date();
    let endDate;
    if (type === '7days') {
        endDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    } else if (type === '30days') {
        endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    } else {
        return false;
    }
    
    if (!db.users[userId]) {
        db.users[userId] = { username: '', success: 0, credits: 0, topup_history: [], language: DEFAULT_LANG };
    }
    db.users[userId].subscription = {
        active: true,
        type: type,
        start_date: now.toISOString(),
        end_date: endDate.toISOString()
    };
    await saveDB();
    return true;
}

async function buySubscriptionWithBalance(userId, subscriptionType) {
    const amount = subscriptionType === '7days' ? 50000 : 100000;
    const credits = getUserCredits(userId);
    const lang = getUserLanguage(userId);
    
    if (credits < amount) {
        const errorMsg = texts.subscription_messages.not_enough_balance[lang](credits, amount);
        return { success: false, error: errorMsg };
    }
    
    db.users[userId].credits -= amount;
    
    if (!db.users[userId].topup_history) db.users[userId].topup_history = [];
    db.users[userId].topup_history.push({
        amount: -amount,
        order_id: `SUB-${subscriptionType}-${Date.now()}`,
        date: new Date().toISOString(),
        method: 'balance'
    });
    
    const now = new Date();
    const duration = subscriptionType === '7days' ? 7 : 30;
    
    const existingSub = db.users[userId].subscription;
    let newEndDate;
    let startDate;
    let wasActive = false;
    
    if (existingSub && existingSub.active && new Date(existingSub.end_date) > now) {
        const currentEndDate = new Date(existingSub.end_date);
        newEndDate = new Date(currentEndDate.getTime() + duration * 24 * 60 * 60 * 1000);
        startDate = existingSub.start_date;
        wasActive = true;
        console.log(`Perpanjang langganan: dari ${currentEndDate} menjadi ${newEndDate}`);
    } else {
        newEndDate = new Date(now.getTime() + duration * 24 * 60 * 60 * 1000);
        startDate = now.toISOString();
        console.log(`Langganan baru: mulai ${now} sampai ${newEndDate}`);
    }
    
    db.users[userId].subscription = {
        active: true,
        type: subscriptionType,
        start_date: startDate,
        end_date: newEndDate.toISOString()
    };
    
    await saveDB();
    
    try {
        const endDateFormatted = moment(newEndDate).tz('Asia/Jakarta').format('DD MMMM YYYY HH:mm');
        if (wasActive) {
            const msg = texts.subscription_messages.extended[lang](subscriptionType, amount, db.users[userId].credits, endDateFormatted);
            await bot.sendMessage(userId, msg);
        } else {
            const msg = texts.subscription_messages.new[lang](subscriptionType, amount, db.users[userId].credits, endDateFormatted);
            await bot.sendMessage(userId, msg);
        }
    } catch (notifError) {
        console.log('Gagal kirim notifikasi langganan:', notifError.message);
    }
    
    return { success: true, newBalance: db.users[userId].credits, endDate: newEndDate };
}

function formatRupiah(amount) {
    try {
        return 'Rp ' + amount.toLocaleString();
    } catch {
        return 'Rp ' + amount;
    }
}

async function checkJoin(bot, userId) {
    try {
        if (!CHANNEL || !GROUP) {
            console.log('Channel atau Group tidak dikonfigurasi, checkJoin dinonaktifkan');
            return { channel: true, group: true };
        }
        
        let isChannelMember = false, isGroupMember = false;
        
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
            timeout: 30000
        });
        
        console.log(`Checkton response status: ${response.status}`);
        
        if (response.data) {
            if (response.data.status === -1) {
                console.log('Akun tidak ditemukan:', response.data.message);
                return { error: true, message: 'not_found' };
            }
            
            if (response.data.data && Object.keys(response.data.data).length > 0) {
                return response.data.data;
            }
            
            if (response.data.role_id || response.data.name || response.data.level) {
                return response.data;
            }
            
            if (response.data.status === 0 && response.data.data) {
                return response.data.data;
            }
        }
        
        console.log('Tidak ada data yang valid dalam response');
        return { error: true, message: 'no_data' };
        
    } catch (error) {
        console.log(`Error getMLBBData:`, error.message);
        return { error: true, message: error.message };
    }
}

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
            timeout: 60000
        });
        
        console.log(`Find response status: ${response.status}`);
        
        if (response.data) {
            if (response.data.status === 0 && response.data.data) {
                if (Array.isArray(response.data.data)) {
                    return response.data.data;
                }
                return [response.data.data];
            }
            
            if (Array.isArray(response.data)) {
                return response.data;
            }
            
            if (response.data.role_id) {
                return [response.data];
            }
            
            if (response.data.data && Array.isArray(response.data.data)) {
                return response.data.data;
            }
        }
        
        console.log('Tidak ada data yang valid dalam response find');
        return null;
        
    } catch (error) {
        console.log(`Error findPlayerByName:`, error.message);
        return null;
    }
}

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

// [TAMBAHAN] Fungsi untuk mendapatkan semua anggota grup dari database
async function getAllGroupMembers(groupId) {
    try {
        const members = [];
        const users = db.users || {};
        
        for (const [userId, userData] of Object.entries(users)) {
            if (userData.groups && userData.groups.includes(groupId)) {
                members.push({
                    user_id: parseInt(userId),
                    username: userData.username,
                    first_name: userData.first_name,
                    last_name: userData.last_name,
                    joined_at: userData.joined_at,
                    last_active: userData.last_active
                });
            }
        }
        
        members.sort((a, b) => (b.joined_at || 0) - (a.joined_at || 0));
        
        console.log(`[MEMBERS] Found ${members.length} members for group ${groupId}`);
        
        return members;
    } catch (error) {
        console.log('Error getting group members:', error.message);
        return [];
    }
}

async function createPakasirTopup(amount, userId, username = '') {
    try {
        const orderId = `TOPUP-${userId}-${Date.now()}`;
        console.log(`Membuat topup: ${orderId}, amount: ${amount}, user: ${userId}`);
        
        if (!db.users[userId]) {
            db.users[userId] = { 
                username: username, 
                success: 0, 
                credits: 0, 
                topup_history: [],
                language: DEFAULT_LANG
            };
            console.log(`USER BARU DIBUAT SAAT TOPUP: ${userId} (${username})`);
            await saveDB();
        } else if (username && db.users[userId].username !== username) {
            db.users[userId].username = username;
            await saveDB();
        }
        
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

async function sendRequestToRelay(chatId, userId, serverId, command, replyToMessageId = null) {
    try {
        if (!redisClient || !redisClient.isReady) {
            console.log('Redis not connected');
            return false;
        }
        
        const timestamp = Date.now();
        const randomStr = Math.random().toString(36).substring(2, 8);
        const requestId = `req:${chatId}:${timestamp}:${randomStr}`;
        
        const requestData = {
            chat_id: chatId,
            user_id: userId,
            command: command,
            args: [String(userId), String(serverId)],
            time: Date.now() / 1000
        };
        
        if (replyToMessageId) {
            requestData.reply_to_message_id = replyToMessageId;
        }
        
        console.log(`Menyimpan request ke Redis:`, JSON.stringify(requestData));
        
        await redisClient.setEx(requestId, 300, JSON.stringify(requestData));
        await redisClient.rPush('pending_requests', requestId);
        
        console.log(`Request sent to relay: ${requestId}`);
        return true;
    } catch (error) {
        console.log('Error sending to relay:', error.message);
        return false;
    }
}

async function telegramRequest(method, params) {
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
        const response = await axios.post(url, params, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 5000
        });
        return response.data;
    } catch (error) {
        console.log(`Telegram API error (${method}):`, error.message);
        if (error.response) {
            console.log('Response:', error.response.data);
        }
        return null;
    }
}

async function deleteMessage(chatId, messageId) {
    return telegramRequest('deleteMessage', {
        chat_id: chatId,
        message_id: messageId
    });
}

async function sendMessage(chatId, text, parseMode = 'HTML') {
    return telegramRequest('sendMessage', {
        chat_id: chatId,
        text: text,
        parse_mode: parseMode
    });
}

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Bot is running');
});

app.post('/webhook/pakasir', async (req, res) => {
    const startTime = Date.now();
    
    try {
        console.log('WEBHOOK PAKASIR:', JSON.stringify(req.body));
        
        const { order_id, status, amount, transaction_id } = req.body;
        
        if (!order_id) {
            return res.status(200).json({ status: 'ok', message: 'no order_id' });
        }
        
        console.log(`PROSES WEBHOOK: ${order_id} | STATUS: ${status}`);
        
        if (!db.pending_topups || !db.pending_topups[order_id]) {
            console.log(`ORDER TIDAK DITEMUKAN DI CACHE: ${order_id}`);
            
            await loadDB();
            
            if (!db.pending_topups || !db.pending_topups[order_id]) {
                console.log(`ORDER TIDAK DITEMUKAN SETELAH LOAD DB: ${order_id}`);
                return res.status(200).json({ status: 'ok', message: 'order not found' });
            }
        }
        
        const pendingData = db.pending_topups[order_id];
        
        if (pendingData.processed) {
            console.log(`ORDER SUDAH DIPROSES: ${order_id}`);
            return res.status(200).json({ status: 'ok', message: 'already processed' });
        }
        
        if (status === 'completed' || status === 'paid' || status === 'success' || status === 'settlement') {
            console.log(`PAYMENT SUCCESS: ${order_id} | USER: ${pendingData.userId} | AMOUNT: ${pendingData.amount}`);
            
            const userId = pendingData.userId;
            const amount = pendingData.amount;
            const chatId = pendingData.chatId;
            const messageId = pendingData.messageId;
            const lang = getUserLanguage(userId);
            
            await addCredits(userId, amount, order_id);
            
            db.pending_topups[order_id].status = 'paid';
            db.pending_topups[order_id].processed = true;
            db.pending_topups[order_id].paid_at = Date.now();
            db.pending_topups[order_id].transaction_id = transaction_id || null;
            
            await saveDB();
            
            if (chatId && messageId) {
                try {
                    const result = await deleteMessage(chatId, messageId);
                    if (result && result.ok) {
                        console.log(`QR DELETED: ${order_id} di chat ${chatId}`);
                    } else {
                        console.log(`GAGAL HAPUS QR: ${result?.description || 'unknown error'}`);
                    }
                } catch (deleteError) {
                    console.log('GAGAL HAPUS QR:', deleteError.message);
                }
            }
            
            try {
                const newBalance = db.users[userId]?.credits || 0;
                const successMsg = texts.payment.success[lang](amount, order_id, newBalance);
                await sendMessage(userId, successMsg, 'Markdown');
            } catch (notifError) {
                console.log('GAGAL KIRIM NOTIFIKASI:', notifError.message);
            }
            
        } else if (status === 'failed' || status === 'expired' || status === 'cancel') {
            console.log(`PAYMENT FAILED: ${order_id}`);
            const lang = getUserLanguage(pendingData.userId);
            
            db.pending_topups[order_id].status = 'failed';
            db.pending_topups[order_id].processed = true;
            db.pending_topups[order_id].failed_at = Date.now();
            
            await saveDB();
            
            try {
                const failedMsg = texts.payment.failed[lang](pendingData.amount, order_id);
                await sendMessage(pendingData.userId, failedMsg, 'Markdown');
            } catch (notifError) {
                console.log('GAGAL KIRIM NOTIFIKASI GAGAL:', notifError.message);
            }
        }
        
        res.status(200).json({ status: 'ok', message: 'processed' });
        
    } catch (error) {
        console.log('WEBHOOK ERROR:', error.message);
        console.log(error.stack);
        res.status(200).json({ status: 'ok', message: 'error but accepted' });
    }
});

if (IS_WORKER) {
    console.log('Bot worker started');
    
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
            console.log('Polling error:', error.message);
        });

        // [UPDATE] bot.on('message') dengan tracking member join/leave
        bot.on('message', async (msg) => {
            try {
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                const username = msg.from.username;
                const firstName = msg.from.first_name;
                const chatType = msg.chat.type;
                
                // ========== [TAMBAHAN] CAPTURE NEW MEMBERS FROM SERVICE MESSAGE ==========
                if (msg.new_chat_members && msg.new_chat_members.length > 0) {
                    for (const newMember of msg.new_chat_members) {
                        const newUserId = newMember.id;
                        const newUsername = newMember.username || '';
                        const newFirstName = newMember.first_name || '';
                        const newLastName = newMember.last_name || '';
                        
                        console.log(`[JOIN DETECTED] User ${newUserId} (${newFirstName}) joined group ${chatId}`);
                        
                        if (!db.users[newUserId]) {
                            db.users[newUserId] = {
                                username: newUsername,
                                first_name: newFirstName,
                                last_name: newLastName,
                                success: 0,
                                credits: 0,
                                topup_history: [],
                                language: DEFAULT_LANG,
                                groups: [],
                                joined_at: Date.now(),
                                last_active: Date.now()
                            };
                            console.log(`[DATABASE] New user ${newUserId} added from join event`);
                        }
                        
                        if (!db.users[newUserId].groups) {
                            db.users[newUserId].groups = [];
                        }
                        
                        if (!db.users[newUserId].groups.includes(chatId)) {
                            db.users[newUserId].groups.push(chatId);
                            console.log(`[DATABASE] Group ${chatId} added to user ${newUserId}`);
                        }
                        
                        if (newUsername && db.users[newUserId].username !== newUsername) {
                            db.users[newUserId].username = newUsername;
                        }
                        if (newFirstName && db.users[newUserId].first_name !== newFirstName) {
                            db.users[newUserId].first_name = newFirstName;
                        }
                        if (newLastName && db.users[newUserId].last_name !== newLastName) {
                            db.users[newUserId].last_name = newLastName;
                        }
                        
                        db.users[newUserId].joined_at = Date.now();
                        db.users[newUserId].last_active = Date.now();
                        
                        await saveDB();
                    }
                }
                
                // ========== [TAMBAHAN] CAPTURE MEMBERS LEAVING ==========
                if (msg.left_chat_member) {
                    const leftUserId = msg.left_chat_member.id;
                    
                    console.log(`[LEAVE DETECTED] User ${leftUserId} left group ${chatId}`);
                    
                    if (db.users[leftUserId] && db.users[leftUserId].groups) {
                        const index = db.users[leftUserId].groups.indexOf(chatId);
                        if (index !== -1) {
                            db.users[leftUserId].groups.splice(index, 1);
                            await saveDB();
                            console.log(`[DATABASE] Group ${chatId} removed from user ${leftUserId}`);
                        }
                    }
                }
                
                // ========== [TAMBAHAN] TRACK ACTIVE USERS ==========
                if (chatType === 'group' || chatType === 'supergroup') {
                    if (!db.users[userId]) {
                        db.users[userId] = {
                            username: username || '',
                            first_name: firstName || '',
                            success: 0,
                            credits: 0,
                            topup_history: [],
                            language: DEFAULT_LANG,
                            groups: [],
                            last_active: Date.now()
                        };
                    }
                    
                    if (!db.users[userId].groups) {
                        db.users[userId].groups = [];
                    }
                    
                    if (!db.users[userId].groups.includes(chatId)) {
                        db.users[userId].groups.push(chatId);
                        await saveDB();
                    }
                    
                    db.users[userId].last_active = Date.now();
                    await saveDB();
                }
                // ========== AKHIR TAMBAHAN ==========
                
                const text = msg.text;
                if (!text) return;
                
                const state = getAdminState(userId);
                const lang = getUserLanguage(userId);
                
                if (state && isAdmin(userId)) {
                    if (state.action === 'addtopup' && state.step === 'waiting_userid') {
                        const targetId = parseInt(text);
                        if (isNaN(targetId)) {
                            await bot.sendMessage(chatId, texts.user_not_found[lang], {
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: texts.buttons.cancel[lang], callback_data: 'admin_batal' }]
                                    ]
                                }
                            });
                            return;
                        }
                        await setAdminState(userId, 'addtopup', 'waiting_amount', { targetId });
                        const msgText = texts.admin.add_topup_amount[lang](targetId);
                        await bot.sendMessage(chatId, msgText, {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: texts.buttons.cancel[lang], callback_data: 'admin_batal' }]
                                ]
                            }
                        });
                        return;
                    }
                    
                    if (state.action === 'addtopup' && state.step === 'waiting_amount') {
                        const amount = parseInt(text);
                        const targetId = state.data.targetId;
                        
                        if (isNaN(amount) || amount < 1 || amount > 1000000) {
                            await bot.sendMessage(chatId, texts.amount_invalid[lang], {
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: texts.buttons.cancel[lang], callback_data: 'admin_batal' }]
                                    ]
                                }
                            });
                            return;
                        }
                        
                        const newBalance = await addCredits(targetId, amount, null);
                        const successMsg = texts.admin.add_topup_success[lang](targetId, amount, newBalance);
                        
                        await bot.sendMessage(chatId, successMsg, {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: texts.buttons.admin_menu[lang], callback_data: 'admin_menu' }]
                                ]
                            }
                        });
                        
                        try {
                            const targetLang = getUserLanguage(targetId);
                            const userMsg = texts.admin.add_topup_success[targetLang](targetId, amount, newBalance);
                            await bot.sendMessage(targetId, userMsg);
                        } catch (e) {}
                        
                        clearAdminState(userId);
                        return;
                    }
                    
                    if (state.action === 'addgroup' && state.step === 'waiting_groupid') {
                        const groupId = parseInt(text);
                        if (isNaN(groupId)) {
                            await bot.sendMessage(chatId, texts.group_id_invalid[lang], {
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: texts.buttons.cancel[lang], callback_data: 'admin_batal' }]
                                    ]
                                }
                            });
                            return;
                        }
                        
                        if (!db.allowed_groups) db.allowed_groups = [];
                        
                        if (db.allowed_groups.includes(groupId)) {
                            const msgText = texts.admin.group_already_exists[lang](groupId);
                            await bot.sendMessage(chatId, msgText, {
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: texts.buttons.admin_menu[lang], callback_data: 'admin_menu' }]
                                    ]
                                }
                            });
                            clearAdminState(userId);
                            return;
                        }
                        
                        db.allowed_groups.push(groupId);
                        await saveDB();
                        
                        const msgText = texts.admin.group_added[lang](groupId);
                        await bot.sendMessage(chatId, msgText, {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: texts.buttons.admin_menu[lang], callback_data: 'admin_menu' }]
                                ]
                            }
                        });
                        clearAdminState(userId);
                        return;
                    }
                    
                    if (state.action === 'removegroup' && state.step === 'waiting_groupid') {
                        const groupId = parseInt(text);
                        if (isNaN(groupId)) {
                            await bot.sendMessage(chatId, texts.group_id_invalid[lang], {
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: texts.buttons.cancel[lang], callback_data: 'admin_batal' }]
                                    ]
                                }
                            });
                            return;
                        }
                        
                        if (!db.allowed_groups) db.allowed_groups = [];
                        
                        const index = db.allowed_groups.indexOf(groupId);
                        if (index === -1) {
                            const msgText = texts.admin.group_not_found[lang](groupId);
                            await bot.sendMessage(chatId, msgText, {
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: texts.buttons.admin_menu[lang], callback_data: 'admin_menu' }]
                                    ]
                                }
                            });
                            clearAdminState(userId);
                            return;
                        }
                        
                        db.allowed_groups.splice(index, 1);
                        await saveDB();
                        
                        const msgText = texts.admin.group_removed[lang](groupId);
                        await bot.sendMessage(chatId, msgText, {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: texts.buttons.admin_menu[lang], callback_data: 'admin_menu' }]
                                ]
                            }
                        });
                        clearAdminState(userId);
                        return;
                    }
                    
                    if (state.action === 'broadcast' && state.step === 'waiting_message') {
                        const hasPhoto = msg.photo && msg.photo.length > 0;
                        const hasVideo = msg.video;
                        const hasDocument = msg.document;
                        const hasAudio = msg.audio;
                        const hasVoice = msg.voice;
                        const hasSticker = msg.sticker;
                        const hasAnimation = msg.animation;
                        const hasText = msg.text && msg.text.length > 0;
                        
                        if (!hasPhoto && !hasVideo && !hasDocument && !hasAudio && !hasVoice && !hasSticker && !hasAnimation && !hasText) {
                            await bot.sendMessage(chatId, texts.admin.broadcast_start[lang].split('\n')[0], {
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: texts.buttons.cancel[lang], callback_data: 'admin_batal' }]
                                    ]
                                }
                            });
                            return;
                        }
                        
                        const users = Object.keys(db.users || {}).map(id => parseInt(id));
                        if (users.length === 0) {
                            await bot.sendMessage(chatId, texts.admin.no_users[lang], {
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: texts.buttons.admin_menu[lang], callback_data: 'admin_menu' }]
                                    ]
                                }
                            });
                            clearAdminState(userId);
                            return;
                        }
                        
                        const statusMsg = await bot.sendMessage(chatId, `Memulai broadcast ke ${users.length} pengguna...`);
                        
                        let success = 0, failed = 0;
                        const concurrency = 5;
                        let mediaType = '';
                        let mediaInfo = '';
                        
                        if (hasPhoto) {
                            mediaType = 'Foto';
                            if (msg.caption) mediaInfo = ` dengan caption: "${msg.caption.substring(0, 50)}${msg.caption.length > 50 ? '...' : ''}"`;
                        } else if (hasVideo) {
                            mediaType = 'Video';
                            if (msg.caption) mediaInfo = ` dengan caption: "${msg.caption.substring(0, 50)}${msg.caption.length > 50 ? '...' : ''}"`;
                        } else if (hasDocument) {
                            mediaType = 'Dokumen';
                            const fileName = msg.document.file_name || 'tanpa nama';
                            mediaInfo = ` (${fileName})`;
                            if (msg.caption) mediaInfo += ` dengan caption: "${msg.caption.substring(0, 50)}${msg.caption.length > 50 ? '...' : ''}"`;
                        } else if (hasAudio) {
                            mediaType = 'Audio';
                            const title = msg.audio.title || msg.audio.file_name || 'tanpa judul';
                            mediaInfo = ` (${title})`;
                            if (msg.caption) mediaInfo += ` dengan caption: "${msg.caption.substring(0, 50)}${msg.caption.length > 50 ? '...' : ''}"`;
                        } else if (hasVoice) {
                            mediaType = 'Voice Note';
                            mediaInfo = '';
                        } else if (hasSticker) {
                            mediaType = 'Sticker';
                            mediaInfo = '';
                        } else if (hasAnimation) {
                            mediaType = 'GIF/Animation';
                            if (msg.caption) mediaInfo = ` dengan caption: "${msg.caption.substring(0, 50)}${msg.caption.length > 50 ? '...' : ''}"`;
                        } else {
                            mediaType = 'Teks';
                            mediaInfo = ` "${msg.text.substring(0, 100)}${msg.text.length > 100 ? '...' : ''}"`;
                        }
                        
                        for (let i = 0; i < users.length; i += concurrency) {
                            const batch = users.slice(i, i + concurrency);
                            
                            await Promise.all(batch.map(async (targetUserId) => {
                                try {
                                    if (hasPhoto) {
                                        const photoFileId = msg.photo[msg.photo.length - 1].file_id;
                                        const caption = msg.caption || '';
                                        await bot.sendPhoto(targetUserId, photoFileId, { 
                                            caption: caption, 
                                            parse_mode: 'HTML' 
                                        });
                                    } else if (hasVideo) {
                                        const videoFileId = msg.video.file_id;
                                        const caption = msg.caption || '';
                                        await bot.sendVideo(targetUserId, videoFileId, { 
                                            caption: caption, 
                                            parse_mode: 'HTML' 
                                        });
                                    } else if (hasDocument) {
                                        const documentFileId = msg.document.file_id;
                                        const caption = msg.caption || '';
                                        await bot.sendDocument(targetUserId, documentFileId, { 
                                            caption: caption, 
                                            parse_mode: 'HTML' 
                                        });
                                    } else if (hasAudio) {
                                        const audioFileId = msg.audio.file_id;
                                        const caption = msg.caption || '';
                                        await bot.sendAudio(targetUserId, audioFileId, { 
                                            caption: caption, 
                                            parse_mode: 'HTML' 
                                        });
                                    } else if (hasVoice) {
                                        const voiceFileId = msg.voice.file_id;
                                        await bot.sendVoice(targetUserId, voiceFileId);
                                    } else if (hasSticker) {
                                        const stickerFileId = msg.sticker.file_id;
                                        await bot.sendSticker(targetUserId, stickerFileId);
                                    } else if (hasAnimation) {
                                        const animationFileId = msg.animation.file_id;
                                        const caption = msg.caption || '';
                                        await bot.sendAnimation(targetUserId, animationFileId, { 
                                            caption: caption, 
                                            parse_mode: 'HTML' 
                                        });
                                    } else {
                                        await bot.sendMessage(targetUserId, msg.text, { 
                                            parse_mode: 'HTML' 
                                        });
                                    }
                                    success++;
                                } catch (error) {
                                    if (error.response && error.response.statusCode === 429) {
                                        const retryAfter = error.response.body.parameters?.retry_after || 1;
                                        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                                        try {
                                            if (hasPhoto) {
                                                const photoFileId = msg.photo[msg.photo.length - 1].file_id;
                                                const caption = msg.caption || '';
                                                await bot.sendPhoto(targetUserId, photoFileId, { 
                                                    caption: caption, 
                                                    parse_mode: 'HTML' 
                                                });
                                            } else if (hasVideo) {
                                                const videoFileId = msg.video.file_id;
                                                const caption = msg.caption || '';
                                                await bot.sendVideo(targetUserId, videoFileId, { 
                                                    caption: caption, 
                                                    parse_mode: 'HTML' 
                                                });
                                            } else if (hasDocument) {
                                                const documentFileId = msg.document.file_id;
                                                const caption = msg.caption || '';
                                                await bot.sendDocument(targetUserId, documentFileId, { 
                                                    caption: caption, 
                                                    parse_mode: 'HTML' 
                                                });
                                            } else if (hasAudio) {
                                                const audioFileId = msg.audio.file_id;
                                                const caption = msg.caption || '';
                                                await bot.sendAudio(targetUserId, audioFileId, { 
                                                    caption: caption, 
                                                    parse_mode: 'HTML' 
                                                });
                                            } else if (hasVoice) {
                                                const voiceFileId = msg.voice.file_id;
                                                await bot.sendVoice(targetUserId, voiceFileId);
                                            } else if (hasSticker) {
                                                const stickerFileId = msg.sticker.file_id;
                                                await bot.sendSticker(targetUserId, stickerFileId);
                                            } else if (hasAnimation) {
                                                const animationFileId = msg.animation.file_id;
                                                const caption = msg.caption || '';
                                                await bot.sendAnimation(targetUserId, animationFileId, { 
                                                    caption: caption, 
                                                    parse_mode: 'HTML' 
                                                });
                                            } else {
                                                await bot.sendMessage(targetUserId, msg.text, { 
                                                    parse_mode: 'HTML' 
                                                });
                                            }
                                            success++;
                                        } catch (retryError) {
                                            failed++;
                                        }
                                    } else {
                                        failed++;
                                        console.log(`Gagal kirim ke ${targetUserId}:`, error.message);
                                    }
                                }
                            }));
                            
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                        
                        const resultMsg = texts.admin.broadcast_result[lang](success, failed, mediaType, mediaInfo);
                        
                        await bot.editMessageText(resultMsg, {
                            chat_id: chatId,
                            message_id: statusMsg.message_id,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: texts.buttons.admin_menu[lang], callback_data: 'admin_menu' }]
                                ]
                            }
                        });
                        
                        clearAdminState(userId);
                        return;
                    }
                }
                
                if (isAdmin(userId)) return;
                
                const command = text.split(' ')[0];
                const allowedCommands = ['/start', '/info', '/cek', '/cekinfo', '/find'];
                if (allowedCommands.includes(command)) return;
                
            } catch (error) {
                console.log('Middleware error:', error.message);
            }
        });

        bot.onText(/\/start/, async (msg) => {
            try {
                if (msg.chat.type !== 'private') return;
                
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                const username = msg.from.username;
                
                await loadDB();
                
                getUserCredits(userId, username || '');
                const lang = getUserLanguage(userId);
                
                const message = texts.welcome[lang];
                
                const baseKeyboard = [
                    [
                        { text: texts.buttons.full_info[lang], callback_data: 'full_info' },
                        { text: texts.buttons.check_info[lang], callback_data: 'check_info' }
                    ],
                    [{ text: texts.buttons.find_id[lang], callback_data: 'find_id' }],
                    [
                        { text: texts.buttons.topup[lang], callback_data: 'topup_menu' },
                        { text: texts.buttons.subscription[lang], callback_data: 'langganan_menu' }
                    ],
                    [
                        { text: texts.buttons.profile[lang], callback_data: 'profile_menu' },
                        { text: texts.buttons.language[lang], callback_data: 'language_menu' }
                    ]
                ];
                
                if (isAdmin(userId)) {
                    baseKeyboard.push([{ text: texts.buttons.admin_menu[lang], callback_data: 'admin_menu' }]);
                }
                
                const replyMarkup = {
                    inline_keyboard: baseKeyboard
                };
                
                await bot.sendMessage(chatId, message, { reply_markup: replyMarkup });
            } catch (error) {
                console.log('Error /start:', error.message);
                try {
                    await bot.sendMessage(msg.chat.id, 'Terjadi kesalahan. Silakan coba lagi.');
                } catch (e) {}
            }
        });

        bot.onText(/\/idgrup/, async (msg) => {
            try {
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                const chatType = msg.chat.type;
                const lang = getUserLanguage(userId);

                if (chatType !== 'group' && chatType !== 'supergroup') {
                    await bot.sendMessage(chatId, texts.group_id_instruction[lang]);
                    return;
                }

                if (!isAdmin(userId)) {
                    await bot.sendMessage(chatId, texts.admin_only[lang]);
                    return;
                }

                const msgText = texts.group_id_result[lang](chatId);
                await bot.sendMessage(chatId, msgText);
            } catch (error) {
                console.log('Error /idgrup:', error.message);
            }
        });

        // ========== HANDLER /cekinfo - PERBAIKAN ==========
// Gunakan pattern yang lebih ketat: harus diawali dengan /cekinfo dan diikuti spasi
bot.onText(/^\/cekinfo\s+(.+)$/, async (msg, match) => {
    try {
        // Cek apakah command tepat di awal pesan
        // Pattern ^\/cekinfo\s+(.+)$ sudah memastikan command di awal
        
        // Hanya di grup
        if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
            console.log(`[CEKINFO] Ignored: not a group chat`);
            return;
        }
        
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const messageId = msg.message_id;
        const lang = getUserLanguage(userId);

        // Cek grup terdaftar
        if (!isGroupAllowed(chatId)) {
            const msgText = texts.group.not_allowed[lang];
            await bot.sendMessage(chatId, msgText, { reply_to_message_id: messageId });
            return;
        }
        
        // Parse parameter (sudah pasti ada karena pattern \s+(.+))
        const args = match[1].trim().split(/\s+/);
        if (args.length < 2) {
            const msgText = texts.group.format[lang];
            await bot.sendMessage(chatId, msgText, { reply_to_message_id: messageId });
            return;
        }
        
        const targetId = args[0];
        const serverId = args[1];
        
        // Validasi ID dan Server harus angka
        if (!/^\d+$/.test(targetId) || !/^\d+$/.test(serverId)) {
            const msgText = texts.cek_command.wrong_format[lang];
            await bot.sendMessage(chatId, msgText, { reply_to_message_id: messageId });
            return;
        }
        
        // Cek fitur info
        if (!db.feature?.info && !isAdmin(userId)) {
            const msgText = texts.group.feature_disabled[lang];
            await bot.sendMessage(chatId, msgText, { reply_to_message_id: messageId });
            return;
        }
        
        console.log(`[CEKINFO] Processing: ${targetId} ${serverId} in group ${chatId}`);
        
        // Proses request
        const sent = await sendRequestToRelay(chatId, targetId, serverId, '/info', messageId);
        
        if (!sent) {
            const errorMsg = texts.error[lang];
            await bot.sendMessage(chatId, errorMsg, { reply_to_message_id: messageId });
            return;
        }
        
        // Update statistik
        getUserCredits(userId, msg.from.username || '');
        db.users[userId].success += 1;
        db.total_success += 1;
        await saveDB();
        
    } catch (error) {
        console.log('Error /cekinfo:', error.message);
        try {
            const lang = getUserLanguage(msg.from.id);
            const errorMsg = texts.error[lang];
            await bot.sendMessage(msg.chat.id, errorMsg, { reply_to_message_id: msg.message_id });
        } catch (e) {}
    }
});

        bot.onText(/^\/info\s+(.+)$/, async (msg, match) => {
    // Hanya di private chat
    if (msg.chat.type !== 'private') return;
                
                if (!match || !match[1]) {
                    const lang = getUserLanguage(msg.from.id);
                    const msgText = texts.info_command.format[lang];
                    await bot.sendMessage(msg.chat.id, msgText);
                    return;
                }
                
                await loadDB();
                
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                const lang = getUserLanguage(userId);
                
                const args = match[1].trim().split(/\s+/);
                if (args.length < 2) {
                    const msgText = texts.info_command.format[lang];
                    await bot.sendMessage(chatId, msgText);
                    return;
                }
                
                const targetId = args[0];
                const serverId = args[1];
                
                if (!/^\d+$/.test(targetId) || !/^\d+$/.test(serverId)) {
                    const msgText = texts.cek_command.wrong_format[lang];
                    await bot.sendMessage(chatId, msgText);
                    return;
                }
                
                if (!db.feature?.info && !isAdmin(userId)) {
                    const msgText = texts.group.feature_disabled[lang];
                    await bot.sendMessage(chatId, msgText);
                    return;
                }
                
                const joined = await checkJoin(bot, userId);
                
                if ((!joined.channel || !joined.group) && !isAdmin(userId)) {
                    let message = texts.join_required[lang];
                    
                    const buttons = [];
                    if (!joined.channel && CHANNEL) {
                        buttons.push([{ text: texts.join_channel[lang], url: `https://t.me/${CHANNEL.replace('@', '')}` }]);
                    }
                    if (!joined.group && GROUP) {
                        buttons.push([{ text: texts.join_group[lang], url: `https://t.me/${GROUP.replace('@', '')}` }]);
                    }
                    
                    await bot.sendMessage(chatId, message, { 
                        reply_markup: { inline_keyboard: buttons }
                    });
                    return;
                }
                
                const sent = await sendRequestToRelay(chatId, targetId, serverId, '/info', null);
                
                if (!sent) {
                    const errorMsg = texts.error[lang];
                    await bot.sendMessage(chatId, errorMsg);
                    return;
                }
                
                getUserCredits(userId, msg.from.username || '');
                db.users[userId].success += 1;
                db.total_success += 1;
                await saveDB();
                
            } catch (error) {
                console.log('Error /info:', error.message);
                try {
                    const lang = getUserLanguage(msg.from.id);
                    const errorMsg = texts.error[lang];
                    await bot.sendMessage(msg.chat.id, errorMsg);
                } catch (e) {}
            }
        });

        bot.onText(/^\/cek\s+(.+)$/, async (msg, match) => {
    // Hanya di private chat
    if (msg.chat.type !== 'private') return;
                
                if (!match || !match[1]) {
                    const lang = getUserLanguage(msg.from.id);
                    const msgText = texts.cek_command.format[lang];
                    await bot.sendMessage(msg.chat.id, msgText);
                    return;
                }
                
                await loadDB();
                
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                const lang = getUserLanguage(userId);
                
                await checkAndUpdateExpiredSubscription(userId);
                
                const input = match[1].trim();
                const parts = input.split(/\s+/).filter(p => p.length > 0);
                
                if (parts.length < 2) {
                    const msgText = texts.cek_command.wrong_format[lang];
                    await bot.sendMessage(chatId, msgText);
                    return;
                }
                
                const targetId = parts[0];
                const serverId = parts[1];
                
                if (!/^\d+$/.test(targetId) || !/^\d+$/.test(serverId)) {
                    const msgText = texts.cek_command.wrong_format[lang];
                    await bot.sendMessage(chatId, msgText);
                    return;
                }
                
                const joined = await checkJoin(bot, userId);
                if ((!joined.channel || !joined.group) && !isAdmin(userId)) {
                    let message = texts.join_required[lang];
                    const buttons = [];
                    if (!joined.channel && CHANNEL) {
                        buttons.push([{ text: texts.join_channel[lang], url: `https://t.me/${CHANNEL.replace('@', '')}` }]);
                    }
                    if (!joined.group && GROUP) {
                        buttons.push([{ text: texts.join_group[lang], url: `https://t.me/${GROUP.replace('@', '')}` }]);
                    }
                    await bot.sendMessage(chatId, message, { reply_markup: { inline_keyboard: buttons } });
                    return;
                }
                
                const credits = getUserCredits(userId, msg.from.username || '');
                if (credits < 5000 && !isAdmin(userId) && !hasActiveSubscription(userId)) {
                    const msgText = texts.insufficient_balance[lang](credits, 5000);
                    await bot.sendMessage(chatId, msgText, {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: texts.buttons.topup[lang], callback_data: 'topup_menu' }],
                                [{ text: texts.buttons.subscription[lang], callback_data: 'langganan_menu' }]
                            ]
                        }
                    });
                    return;
                }
                
                const loadingMsg = await bot.sendMessage(chatId, texts.loading.fetching[lang]);
                
                try {
                    let detailData = null;
                    let lookupSuccess = false;
                    let retryCount = 0;
                    const maxRetries = 5;
                    
                    while (!lookupSuccess && retryCount < maxRetries) {
                        retryCount++;
                        
                        if (retryCount > 1) {
                            const retryMsg = texts.loading.retry[lang](retryCount, maxRetries);
                            await bot.editMessageText(retryMsg, {
                                chat_id: chatId,
                                message_id: loadingMsg.message_id
                            });
                        }
                        
                        detailData = await getMLBBData(targetId, serverId, 'lookup');
                        
                        if (detailData && !detailData.error) {
                            lookupSuccess = true;
                            break;
                        }
                        
                        if (retryCount < maxRetries) {
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                    }
                    
                    if (!lookupSuccess) {
                        let errorMessage = texts.error[lang];
                        
                        if (detailData && detailData.message === 'not_found') {
                            errorMessage = texts.not_found[lang]('ID', targetId, serverId);
                        }
                        
                        await bot.editMessageText(errorMessage, {
                            chat_id: chatId,
                            message_id: loadingMsg.message_id
                        });
                        return;
                    }
                    
                    if (!isAdmin(userId) && !hasActiveSubscription(userId)) {
                        db.users[userId].credits -= 5000;
                        await saveDB();
                        console.log(`SALDO DIPOTONG: User ${userId} | Command: cek`);
                    }
                    
                    await bot.deleteMessage(chatId, loadingMsg.message_id);
                    
                    await sendDetailAccountInfo(bot, chatId, userId, detailData, targetId, serverId, lang);
                    
                    db.users[userId].success += 1;
                    db.total_success += 1;
                    await saveDB();
                    
                } catch (error) {
                    console.log('Error saat memproses:', error.message);
                    const errorMsg = texts.error[lang];
                    await bot.editMessageText(errorMsg, {
                        chat_id: chatId,
                        message_id: loadingMsg.message_id
                    });
                }
                
            } catch (error) {
                console.log('Error /cek:', error.message);
                try {
                    const lang = getUserLanguage(msg.from.id);
                    const errorMsg = texts.error[lang];
                    await bot.sendMessage(msg.chat.id, errorMsg);
                } catch (e) {}
            }
        });

        bot.onText(/^\/find\s+(.+)$/, async (msg, match) => {
    // Hanya di private chat
    if (msg.chat.type !== 'private') return;
                
                if (!match || !match[1]) {
                    const lang = getUserLanguage(msg.from.id);
                    const msgText = texts.find_command.format[lang];
                    await bot.sendMessage(msg.chat.id, msgText);
                    return;
                }
                
                await loadDB();
                
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                const lang = getUserLanguage(userId);
                
                await checkAndUpdateExpiredSubscription(userId);
                
                const input = match[1].trim();
                const parts = input.split(/\s+/).filter(p => p.length > 0);
                
                if (parts.length < 2) {
                    const msgText = texts.find_command.wrong_format[lang];
                    await bot.sendMessage(chatId, msgText);
                    return;
                }
                
                const serverFilter = parts[parts.length - 1];
                if (!/^\d+$/.test(serverFilter)) {
                    const msgText = texts.find_command.wrong_format[lang];
                    await bot.sendMessage(chatId, msgText);
                    return;
                }
                
                const searchQuery = parts.slice(0, -1).join(' ');
                
                const joined = await checkJoin(bot, userId);
                if ((!joined.channel || !joined.group) && !isAdmin(userId)) {
                    let message = texts.join_required[lang];
                    const buttons = [];
                    if (!joined.channel && CHANNEL) {
                        buttons.push([{ text: texts.join_channel[lang], url: `https://t.me/${CHANNEL.replace('@', '')}` }]);
                    }
                    if (!joined.group && GROUP) {
                        buttons.push([{ text: texts.join_group[lang], url: `https://t.me/${GROUP.replace('@', '')}` }]);
                    }
                    await bot.sendMessage(chatId, message, { reply_markup: { inline_keyboard: buttons } });
                    return;
                }
                
                const credits = getUserCredits(userId, msg.from.username || '');
                if (credits < 5000 && !isAdmin(userId) && !hasActiveSubscription(userId)) {
                    const msgText = texts.insufficient_balance[lang](credits, 5000);
                    await bot.sendMessage(chatId, msgText, {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: texts.buttons.topup[lang], callback_data: 'topup_menu' }],
                                [{ text: texts.buttons.subscription[lang], callback_data: 'langganan_menu' }]
                            ]
                        }
                    });
                    return;
                }
                
                const loadingMsg = await bot.sendMessage(chatId, texts.loading.searching[lang]);
                
                try {
                    let foundAccounts = await findPlayerByName(searchQuery);
                    
                    if (!foundAccounts || foundAccounts.length === 0) {
                        const notFoundMsg = `ACCOUNT NOT FOUND\n\nNo account with nickname "${searchQuery}" found.`;
                        await bot.editMessageText(notFoundMsg, {
                            chat_id: chatId,
                            message_id: loadingMsg.message_id
                        });
                        return;
                    }
                    
                    foundAccounts = foundAccounts.filter(a => String(a.zone_id) === serverFilter);
                    
                    if (foundAccounts.length === 0) {
                        const notFoundMsg = `ACCOUNT NOT FOUND\n\nNo account with nickname "${searchQuery}" on server ${serverFilter}.`;
                        await bot.editMessageText(notFoundMsg, {
                            chat_id: chatId,
                            message_id: loadingMsg.message_id
                        });
                        return;
                    }
                    
                    if (!isAdmin(userId) && !hasActiveSubscription(userId)) {
                        db.users[userId].credits -= 5000;
                        await saveDB();
                    }
                    
                    await bot.deleteMessage(chatId, loadingMsg.message_id);
                    
                    for (let i = 0; i < foundAccounts.length; i++) {
                        const acc = foundAccounts[i];
                        
                        let output = `SEARCH RESULT\n\n`;
                        output += `ID: ${acc.role_id}\n`;
                        output += `Server: ${acc.zone_id}\n`;
                        output += `Name: ${acc.name || acc.nickname || '-'}\n`;
                        output += `Level: ${acc.level || 0}\n`;
                        output += `Last Login: ${acc.last_login || '-'}\n`;
                        output += `Country: ${acc.country || acc.created_country || '-'}\n`;
                        output += `Last Country: ${acc.last_country || '-'}\n`;
                        
                        if (acc.locations_logged && Array.isArray(acc.locations_logged) && acc.locations_logged.length > 0) {
                            output += `Locations: ${acc.locations_logged.join(' > ')}\n`;
                        } else {
                            output += `Locations: -\n`;
                        }
                        
                        if (foundAccounts.length > 1) {
                            output += `\n[${i+1}/${foundAccounts.length}]`;
                        }
                        
                        const stockText = texts.buttons.stock_admin[lang];
                        await bot.sendMessage(chatId, output, {
                            reply_markup: { 
                                inline_keyboard: [[{ text: stockText, url: STOK_ADMIN }]] 
                            }
                        });
                    }
                    
                    getUserCredits(userId, msg.from.username || '');
                    db.users[userId].success += 1;
                    db.total_success += 1;
                    await saveDB();
                    
                } catch (error) {
                    console.log('Error /find:', error.message);
                    const errorMsg = texts.error[lang];
                    await bot.editMessageText(errorMsg, {
                        chat_id: chatId,
                        message_id: loadingMsg.message_id
                    });
                }
                
            } catch (error) {
                console.log('Error /find:', error.message);
            }
        });

        // ========== HANDLER /all - WAJIB DENGAN PESAN ==========
bot.onText(/^\/all\s+(.+)$/, async (msg, match) => {
    try {
        // Hanya di grup
        if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
            return;
        }
        
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const messageId = msg.message_id;
        const lang = getUserLanguage(userId);
        
        // Cek izin grup
        if (!isGroupAllowed(chatId) && !isAdmin(userId)) {
            const msgText = texts.group.not_allowed[lang];
            await bot.sendMessage(chatId, msgText, { reply_to_message_id: messageId });
            return;
        }
        
        // Cek admin grup
        let isGroupAdmin = false;
        try {
            const chatMember = await bot.getChatMember(chatId, userId);
            isGroupAdmin = ['administrator', 'creator'].includes(chatMember.status);
        } catch (e) {
            console.log('Failed to check admin status:', e.message);
        }
        
        if (!isGroupAdmin && !isAdmin(userId)) {
            const adminOnlyMsg = `*Only group admins can use this command!*`;
            await bot.sendMessage(chatId, adminOnlyMsg, { 
                parse_mode: 'Markdown',
                reply_to_message_id: messageId 
            });
            return;
        }
        
        // Ambil pesan admin (WAJIB ADA)
        let adminMessage = '';
        if (match && match[1]) {
            adminMessage = match[1].trim();
        }
        
        // Jika tidak ada pesan, kirim peringatan
        if (!adminMessage) {
            const warningMsg = `*⚠️ PERINGATAN*\n\nPenggunaan yang benar:\n/all [pesan]\n\nContoh:\n/all Selamat pagi semua, meeting dimulai jam 10\n\n*Pesan tidak boleh kosong!*`;
            await bot.sendMessage(chatId, warningMsg, { 
                parse_mode: 'Markdown',
                reply_to_message_id: messageId 
            });
            return;
        }
        
        console.log(`[ALL] Admin message: "${adminMessage}"`);
        
        const loadingMsg = await bot.sendMessage(chatId, `*Mengambil daftar anggota...*`, { 
            parse_mode: 'Markdown',
            reply_to_message_id: messageId 
        });
        
        try {
            // Ambil semua member dari database
            let allMembers = await getAllGroupMembers(chatId);
            
            // Jika tidak ada member, ambil dari admin grup
            if (!allMembers || allMembers.length === 0) {
                console.log(`[ALL] No members in database, trying to get admins`);
                const admins = await bot.getChatAdministrators(chatId);
                for (const admin of admins) {
                    const adminId = admin.user.id;
                    if (adminId !== (await bot.getMe()).id) {
                        allMembers.push({
                            user_id: adminId,
                            first_name: admin.user.first_name,
                            username: admin.user.username
                        });
                    }
                }
            }
            
            if (!allMembers || allMembers.length === 0) {
                await bot.editMessageText(`*Tidak ada anggota yang dapat di-mention.*`, {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id,
                    parse_mode: 'Markdown'
                });
                return;
            }
            
            // Filter bot dan user sendiri
            const botInfo = await bot.getMe();
            const botId = botInfo.id;
            
            const validMembers = allMembers.filter(m => {
                const memberId = m.user_id;
                return memberId !== botId && memberId !== userId;
            });
            
            if (validMembers.length === 0) {
                await bot.editMessageText(`*Tidak ada anggota yang dapat di-mention.*`, {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id,
                    parse_mode: 'Markdown'
                });
                return;
            }
            
            // Buat invisible mentions
            const invisibleMentions = [];
            for (const member of validMembers) {
                const memberId = member.user_id;
                invisibleMentions.push(`<a href="tg://user?id=${memberId}">\u200B</a>`);
            }
            
            const currentTime = moment().tz('Asia/Jakarta').format('HH:mm:ss');
            const adminName = msg.from.first_name || msg.from.username || 'Admin';
            
            await bot.deleteMessage(chatId, loadingMsg.message_id);
            
            // Format pesan
            const finalMessage = `<b>PENGUMUMAN DARI ${adminName}</b>\n\n${adminMessage}\n\n<i>Waktu: ${currentTime} WIB</i>`;
            
            // Gabungkan mentions
            const allMentions = invisibleMentions.join('');
            
            // Kirim pesan
            await bot.sendMessage(chatId, finalMessage + allMentions, {
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });
            
            console.log(`[ALL] Mentioned ${validMembers.length} members in group ${chatId} with message: "${adminMessage}"`);
            
        } catch (error) {
            console.log('Error /all:', error.message);
            
            let errorMessage = `*Gagal mengirim mention.*\n\nBot tidak memiliki izin yang cukup.\n\nPastikan bot adalah admin grup dengan izin:\n- Get member list\n- Send messages\n- Mention users`;
            
            await bot.sendMessage(chatId, errorMessage, {
                parse_mode: 'Markdown',
                reply_to_message_id: messageId
            });
        }
        
    } catch (error) {
        console.log('Error /all handler:', error.message);
        try {
            const lang = getUserLanguage(msg.from.id);
            const errorMsg = texts.error[lang];
            await bot.sendMessage(msg.chat.id, errorMsg);
        } catch (e) {}
    }
});

        async function editToMainMenu(bot, chatId, messageId, userId) {
            try {
                await loadDB();
                const lang = getUserLanguage(userId);
                
                const message = texts.welcome[lang];
                
                const baseKeyboard = [
                    [
                        { text: texts.buttons.full_info[lang], callback_data: 'full_info' },
                        { text: texts.buttons.check_info[lang], callback_data: 'check_info' }
                    ],
                    [{ text: texts.buttons.find_id[lang], callback_data: 'find_id' }],
                    [
                        { text: texts.buttons.topup[lang], callback_data: 'topup_menu' },
                        { text: texts.buttons.subscription[lang], callback_data: 'langganan_menu' }
                    ],
                    [
                        { text: texts.buttons.profile[lang], callback_data: 'profile_menu' },
                        { text: texts.buttons.language[lang], callback_data: 'language_menu' }
                    ]
                ];
                
                if (isAdmin(userId)) {
                    baseKeyboard.push([{ text: texts.buttons.admin_menu[lang], callback_data: 'admin_menu' }]);
                }
                
                const replyMarkup = {
                    inline_keyboard: baseKeyboard
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
            await loadDB();
            const lang = getUserLanguage(userId);
            
            const credits = getUserCredits(userId);
            
            const message = 
                `${texts.topup.title[lang]}\n\n` +
                `${texts.topup.your_balance[lang]}: Rp ${credits.toLocaleString()}\n\n` +
                `${texts.topup.select_amount[lang]}`;
            
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
                    [{ text: texts.buttons.back_to_menu[lang], callback_data: 'kembali_ke_menu' }]
                ]
            };
            
            await bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: replyMarkup
            });
        }

        async function showSubscriptionMenu(bot, chatId, messageId, userId) {
            await loadDB();
            const lang = getUserLanguage(userId);
            
            const message = texts.subscription.title[lang];
            
            const replyMarkup = {
                inline_keyboard: [
                    [{ text: texts.subscription.days7[lang], callback_data: 'langganan_7days' }],
                    [{ text: texts.subscription.days30[lang], callback_data: 'langganan_30days' }],
                    [{ text: texts.buttons.back_to_menu[lang], callback_data: 'kembali_ke_menu' }]
                ]
            };
            
            await bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: replyMarkup
            });
        }

        async function showProfileMenu(bot, chatId, messageId, userId) {
            await loadDB();
            const lang = getUserLanguage(userId);
            
            await checkAndUpdateExpiredSubscription(userId);
            
            const credits = getUserCredits(userId);
            const hasSub = hasActiveSubscription(userId);
            const user = db.users[userId] || { username: '', success: 0 };
            const username = user.username || '-';
            const totalCheck = user.success || 0;
            
            let subscriptionText = texts.profile.inactive[lang];
            let expiryText = '';
            
            if (hasSub) {
                const sub = db.users[userId].subscription;
                const endDate = moment(sub.end_date).tz('Asia/Jakarta');
                subscriptionText = texts.profile.active[lang];
                expiryText = `\n${texts.profile.valid_until[lang]}: ${endDate.format('DD/MM/YYYY HH:mm')} WIB`;
            }
            
            const message = `${texts.profile.title[lang]}\n\n` +
                `${texts.profile.user_id[lang]}: ${userId}\n` +
                `${texts.profile.username[lang]}: @${username}\n` +
                `${texts.profile.balance[lang]}: Rp ${credits.toLocaleString()}\n` +
                `${texts.profile.subscription_status[lang]}: ${subscriptionText}${expiryText}\n` +
                `${texts.profile.total_checks[lang]}: ${totalCheck} ${texts.profile.times[lang]}`;
            
            const replyMarkup = {
                inline_keyboard: [
                    [{ text: texts.buttons.back_to_menu[lang], callback_data: 'kembali_ke_menu' }]
                ]
            };
            
            await bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: replyMarkup
            });
        }

        async function showLanguageMenu(bot, chatId, messageId, userId) {
            const lang = getUserLanguage(userId);
            
            const message = texts.language_menu.title;
            
            const replyMarkup = {
                inline_keyboard: [
                    [
                        { text: texts.language_menu.indonesian, callback_data: 'lang_id' },
                        { text: texts.language_menu.english, callback_data: 'lang_en' }
                    ],
                    [{ text: texts.buttons.back_to_menu[lang], callback_data: 'kembali_ke_menu' }]
                ]
            };
            
            await bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: replyMarkup
            });
        }

        async function showAdminMenu(bot, chatId, messageId, userId) {
            try {
                await loadDB();
                const lang = getUserLanguage(userId);
                
                if (!isAdmin(userId)) {
                    const msgText = texts.admin.access_denied[lang];
                    await bot.editMessageText(msgText, {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: texts.buttons.back_to_menu[lang], callback_data: 'kembali_ke_menu' }]
                            ]
                        }
                    });
                    return;
                }
                
                const totalUsers = Object.keys(db.users || {}).length;
                const totalSuccess = db.total_success || 0;
                const totalSaldo = Object.values(db.users || {}).reduce((sum, u) => sum + (u.credits || 0), 0);
                
                const usersWithSubscription = Object.entries(db.users || {})
                    .filter(([_, u]) => u.subscription && u.subscription.active && new Date(u.subscription.end_date) > new Date())
                    .length;
                
                let message = `${texts.admin_menu.title[lang]}\n\n`;
                message += `${texts.admin_menu.stats[lang]}\n`;
                message += `${texts.admin_menu.total_users[lang]}: ${totalUsers}\n`;
                message += `${texts.admin_menu.total_checks[lang]}: ${totalSuccess}\n`;
                message += `${texts.admin_menu.total_balance[lang]}: Rp ${totalSaldo.toLocaleString()}\n`;
                message += `${texts.admin_menu.total_subscriptions[lang]}: ${usersWithSubscription}\n\n`;
                message += `${texts.admin_menu.select_menu[lang]}`;
                
                const replyMarkup = {
                    inline_keyboard: [
                        [
                            { text: 'List Topup', callback_data: 'admin_listtopup' },
                            { text: 'List Langganan', callback_data: 'admin_listlangganan' },
                            { text: 'List Group', callback_data: 'admin_listgroup' }
                        ],
                        [
                            { text: 'Tambah Saldo', callback_data: 'admin_addtopup_start' },
                            { text: 'Tambah Group', callback_data: 'admin_addgroup_start' },
                            { text: 'Hapus Group', callback_data: 'admin_removegroup_start' }
                        ],
                        [
                            { text: 'Broadcast', callback_data: 'admin_broadcast_start' },
                            { text: 'Nonaktifkan Info', callback_data: 'admin_offinfo' },
                            { text: 'Aktifkan Info', callback_data: 'admin_oninfo' }
                        ],
                        [{ text: texts.buttons.back_to_menu[lang], callback_data: 'kembali_ke_menu' }]
                    ]
                };
                
                await bot.editMessageText(message, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: replyMarkup
                });
            } catch (error) {
                console.log('Error showAdminMenu:', error.message);
            }
        }

        async function showAdminListTopup(bot, chatId, messageId, userId) {
            try {
                const lang = getUserLanguage(userId);
                
                if (!isAdmin(userId)) {
                    const msgText = texts.admin.access_denied[lang];
                    await bot.editMessageText(msgText, {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: texts.buttons.admin_menu[lang], callback_data: 'admin_menu' }]
                            ]
                        }
                    });
                    return;
                }
                
                const usersWithBalance = Object.entries(db.users || {})
                    .filter(([_, u]) => (u.credits || 0) > 0)
                    .sort((a, b) => (b[1].credits || 0) - (a[1].credits || 0));
                
                let message = `LIST OF USERS WITH BALANCE > 0\n\n`;
                
                if (usersWithBalance.length === 0) {
                    message += 'No users with balance.';
                } else {
                    const totalSaldo = usersWithBalance.reduce((sum, [_, u]) => sum + (u.credits || 0), 0);
                    message += `Total ${usersWithBalance.length} users | Total Balance: Rp ${totalSaldo.toLocaleString()}\n\n`;
                    
                    const displayCount = Math.min(usersWithBalance.length, 20);
                    for (let i = 0; i < displayCount; i++) {
                        const [id, u] = usersWithBalance[i];
                        message += `${i+1}. ${u.username || id}\n`;
                        message += `   Balance: Rp ${(u.credits || 0).toLocaleString()}\n\n`;
                    }
                    
                    if (usersWithBalance.length > 20) {
                        message += `... and ${usersWithBalance.length - 20} other users.`;
                    }
                }
                
                const replyMarkup = {
                    inline_keyboard: [
                        [{ text: texts.buttons.admin_menu[lang], callback_data: 'admin_menu' }]
                    ]
                };
                
                await bot.editMessageText(message, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: replyMarkup
                });
            } catch (error) {
                console.log('Error showAdminListTopup:', error.message);
            }
        }

        async function showAdminListLangganan(bot, chatId, messageId, userId) {
            try {
                const lang = getUserLanguage(userId);
                
                if (!isAdmin(userId)) {
                    const msgText = texts.admin.access_denied[lang];
                    await bot.editMessageText(msgText, {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: texts.buttons.admin_menu[lang], callback_data: 'admin_menu' }]
                            ]
                        }
                    });
                    return;
                }
                
                const usersWithSubscription = Object.entries(db.users || {})
                    .filter(([_, u]) => u.subscription && u.subscription.active && new Date(u.subscription.end_date) > new Date())
                    .map(([id, u]) => ({
                        id: id,
                        end_date: new Date(u.subscription.end_date)
                    }))
                    .sort((a, b) => a.end_date - b.end_date);
                
                let message = `SUBSCRIPTION LIST\n\n`;
                
                if (usersWithSubscription.length === 0) {
                    message += 'No users with active subscription.';
                } else {
                    for (let i = 0; i < usersWithSubscription.length; i++) {
                        const user = usersWithSubscription[i];
                        const endDate = moment(user.end_date).tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm');
                        message += `${user.id} > Exp: ${endDate} WIB\n`;
                        
                        if (message.length > 3500 && i < usersWithSubscription.length - 1) {
                            message += `... and ${usersWithSubscription.length - i - 1} other users.`;
                            break;
                        }
                    }
                }
                
                const replyMarkup = {
                    inline_keyboard: [
                        [{ text: texts.buttons.admin_menu[lang], callback_data: 'admin_menu' }]
                    ]
                };
                
                await bot.editMessageText(message, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: replyMarkup
                });
            } catch (error) {
                console.log('Error showAdminListLangganan:', error.message);
            }
        }

        async function showAdminListGroup(bot, chatId, messageId, userId) {
            try {
                const lang = getUserLanguage(userId);
                
                if (!isAdmin(userId)) {
                    const msgText = texts.admin.access_denied[lang];
                    await bot.editMessageText(msgText, {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: texts.buttons.admin_menu[lang], callback_data: 'admin_menu' }]
                            ]
                        }
                    });
                    return;
                }
                
                if (!db.allowed_groups || db.allowed_groups.length === 0) {
                    const msgText = texts.admin.no_groups[lang];
                    await bot.editMessageText(msgText, {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: texts.buttons.admin_menu[lang], callback_data: 'admin_menu' }]
                            ]
                        }
                    });
                    return;
                }
                
                let message = `REGISTERED GROUPS:\n\n`;
                db.allowed_groups.forEach((id, i) => {
                    message += `${i + 1}. ${id}\n`;
                });
                
                const replyMarkup = {
                    inline_keyboard: [
                        [{ text: texts.buttons.admin_menu[lang], callback_data: 'admin_menu' }]
                    ]
                };
                
                await bot.editMessageText(message, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: replyMarkup
                });
            } catch (error) {
                console.log('Error showAdminListGroup:', error.message);
            }
        }

        async function sendDetailAccountInfo(bot, chatId, userId, detailData, targetId, serverId, lang) {
            try {
                let output = '';
                
                const d = detailData;
                
                let createdDate = '-';
                if (d.ttl) {
                    const parts = d.ttl.split('-');
                    if (parts.length === 3) {
                        createdDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
                    }
                }
                
                output += `ID Server: ${d.role_id || targetId} (${d.zone_id || serverId})\n`;
                output += `Name: ${d.name || '-'}\n`;
                output += `Level: ${d.level || '-'}\n`;
                output += `Created: ${createdDate}\n`;
                output += `Last Login: ${d.last_login || '-'}\n`;
                output += `Achievement Points: ${(d.achievement_points || 0).toLocaleString()}\n`;
                
                if (d.last_country_logged) {
                    output += `Last Country: ${d.last_country_logged}\n`;
                }
                if (d.created_country) {
                    output += `Created Country: ${d.created_country}\n`;
                }
                
                output += `\nRANK INFO\n`;
                output += `Current Tier: ${d.current_tier || '-'}\n`;
                output += `Highest Tier: ${d.max_tier || '-'}\n`;
                output += `Overall WR: ${d.overall_win_rate || '0%'}\n`;
                output += `KDA: ${d.kda || '-'}\n`;
                output += `Team Participation: ${d.team_participation || '-'}\n`;
                output += `Flags Percentage: ${d.flags_percentage || '-'}\n\n`;
                
                if (d.collector_level || d.collector_title) {
                    output += `COLLECTOR\n`;
                    output += `Level: ${d.collector_level || 0}\n`;
                    output += `Title: ${d.collector_title || '-'}\n\n`;
                }
                
                output += `HERO & SKIN\n`;
                output += `Heroes: ${d.hero_count || 0}\n`;
                output += `Skins: ${d.skin_count || 0}\n`;
                output += `Supreme: ${d.supreme_skins || 0}\n`;
                output += `Grand: ${d.grand_skins || 0}\n`;
                output += `Exquisite: ${d.exquisite_skins || 0}\n`;
                output += `Deluxe: ${d.deluxe_skins || 0}\n`;
                output += `Exceptional: ${d.exceptional_skins || 0}\n`;
                output += `Common: ${d.common_skins || 0}\n`;
                if (d.latest_skin_purchase_date) {
                    output += `Latest Skin Purchase: ${d.latest_skin_purchase_date}\n`;
                }
                output += `Last Hero Purchase: ${d.last_hero_purchase || '-'}\n`;
                output += `Top 3 Most Used: ${d.top3_most_used_heroes || '-'}\n\n`;
                
                if (d.affinity_list && d.affinity_list.length > 0) {
                    output += `AFFINITY\n`;
                    output += `${d.affinity_list.join('\n')}\n\n`;
                }
                
                if (d.locations_logged && Array.isArray(d.locations_logged) && d.locations_logged.length > 0) {
                    output += `LOCATIONS\n`;
                    const locations = formatLocations(d.locations_logged, 15);
                    if (locations) {
                        output += `${locations}\n\n`;
                    }
                }
                
                if (d.top_3_hero_details && d.top_3_hero_details.length > 0) {
                    output += `TOP 3 HERO\n`;
                    d.top_3_hero_details.forEach((h) => {
                        output += `${h.hero || '-'}\n`;
                        output += `  Matches: ${h.matches || 0} | WR: ${h.win_rate || '0%'}\n`;
                        output += `  Power: ${h.power || 0}\n`;
                    });
                    output += `\n`;
                }
                
                output += `MATCH STATS\n`;
                output += `Total Match: ${(d.total_match_played || 0).toLocaleString()}\n`;
                output += `Total Win: ${d.total_wins || 0}\n`;
                output += `MVP: ${d.total_mvp || 0} (Lose ${d.mvp_loss || 0})\n`;
                output += `Savage: ${d.savage_kill || 0}\n`;
                output += `Maniac: ${d.maniac_kill || 0}\n`;
                output += `Legendary: ${d.legendary_kill || 0}\n`;
                output += `Double Kill: ${d.double_kill || 0}\n`;
                output += `Triple Kill: ${d.triple_kill || 0}\n`;
                output += `Longest Win Streak: ${d.longest_win_streak || 0}\n`;
                output += `Most Kills: ${d.most_kills || 0}\n`;
                output += `Most Assists: ${d.most_assists || 0}\n`;
                output += `Highest Damage: ${(d.highest_dmg || 0).toLocaleString()}\n`;
                output += `Highest Damage Taken: ${(d.highest_dmg_taken || 0).toLocaleString()}\n`;
                output += `Highest Gold: ${(d.highest_gold || 0).toLocaleString()}\n`;
                output += `Min Gold: ${d.min_gold || 0}\n`;
                output += `Min Hero Damage: ${d.min_hero_damage || 0}\n`;
                output += `Turret Damage/Match: ${d.turret_dmg_match || 0}\n\n`;
                
                if (d.last_match_data) {
                    output += `LAST MATCH\n`;
                    output += `Hero: ${d.last_match_data.hero_name || '-'}\n`;
                    output += `KDA: ${d.last_match_data.kills || 0}/${d.last_match_data.deaths || 0}/${d.last_match_data.assists || 0}\n`;
                    output += `Gold: ${(d.last_match_data.gold || 0).toLocaleString()}\n`;
                    output += `Hero Damage: ${(d.last_match_data.hero_damage || 0).toLocaleString()}\n`;
                    output += `Damage Taken: ${(d.last_match_data.damage_taken || 0).toLocaleString()}\n`;
                    output += `Turret Damage: ${(d.last_match_data.turret_damage || 0).toLocaleString()}\n`;
                    output += `Duration: ${d.last_match_duration || '-'}\n`;
                    output += `Date: ${d.last_match_date || '-'}\n`;
                    if (d.last_match_heroes) {
                        output += `All Heroes: ${d.last_match_heroes}\n`;
                    }
                    output += `\n`;
                }
                
                if (d.squad_name || d.squad_id) {
                    output += `SQUAD\n`;
                    if (d.squad_name) {
                        output += `Name: ${d.squad_name}\n`;
                    }
                    if (d.squad_prefix) {
                        output += `Prefix: ${d.squad_prefix}\n`;
                    }
                    if (d.squad_id) {
                        output += `Squad ID: ${d.squad_id}\n`;
                    }
                    output += `\n`;
                }
                
                output += `SOCIAL\n`;
                output += `Followers: ${d.followers || 0}\n`;
                output += `Likes: ${d.total_likes || 0}\n`;
                output += `Popularity: ${d.popularity || 0}\n`;
                output += `Credit Score: ${d.credits_score || 0}\n\n`;
                
                output += `Remaining balance: Rp ${getUserCredits(userId).toLocaleString()}`;
                
                const stockText = texts.buttons.stock_admin[lang];
                
                if (output.length > 4000) {
                    let splitPoint = output.indexOf('MATCH STATS');
                    if (splitPoint === -1) splitPoint = 3000;
                    
                    let part1 = output.substring(0, splitPoint);
                    part1 += `\n\n[Continued in next message...]`;
                    
                    await bot.sendMessage(chatId, part1, {
                        reply_markup: { 
                            inline_keyboard: [[{ text: stockText, url: STOK_ADMIN }]] 
                        }
                    });
                    
                    let part2 = output.substring(splitPoint);
                    await bot.sendMessage(chatId, part2);
                    
                } else {
                    await bot.sendMessage(chatId, output, {
                        reply_markup: { 
                            inline_keyboard: [[{ text: stockText, url: STOK_ADMIN }]] 
                        }
                    });
                }
            } catch (error) {
                console.log('Error sendDetailAccountInfo:', error.message);
                const errorMsg = texts.error[lang];
                await bot.sendMessage(chatId, errorMsg);
            }
        }

        bot.on('callback_query', async (cb) => {
            try {
                console.log('Callback diterima:', cb.data);
                
                const msg = cb.message;
                if (!msg || msg.chat.type !== 'private') {
                    await bot.answerCallbackQuery(cb.id, { text: 'Bot only in private chat' });
                    return;
                }
                
                const chatId = msg.chat.id;
                const userId = cb.from.id;
                const data = cb.data;
                const messageId = msg.message_id;
                const lang = getUserLanguage(userId);

                if (data === 'kembali_ke_menu') {
                    await editToMainMenu(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'full_info') {
                    await bot.answerCallbackQuery(cb.id);
                    await bot.editMessageText(texts.full_info_menu[lang], {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: texts.buttons.back_to_menu[lang], callback_data: 'kembali_ke_menu' }]
                            ]
                        }
                    });
                    return;
                }

                if (data === 'check_info') {
                    await bot.answerCallbackQuery(cb.id);
                    await bot.editMessageText(texts.check_info_menu[lang], {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: texts.buttons.back_to_menu[lang], callback_data: 'kembali_ke_menu' }]
                            ]
                        }
                    });
                    return;
                }

                if (data === 'find_id') {
                    await bot.answerCallbackQuery(cb.id);
                    await bot.editMessageText(texts.find_id_menu[lang], {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: texts.buttons.back_to_menu[lang], callback_data: 'kembali_ke_menu' }]
                            ]
                        }
                    });
                    return;
                }

                if (data === 'profile_menu') {
                    await showProfileMenu(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'language_menu') {
                    await showLanguageMenu(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'lang_id') {
                    await setUserLanguage(userId, LANGUAGES.id);
                    await editToMainMenu(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id, { text: texts.language_menu.changed_id });
                    return;
                }

                if (data === 'lang_en') {
                    await setUserLanguage(userId, LANGUAGES.en);
                    await editToMainMenu(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id, { text: texts.language_menu.changed_en });
                    return;
                }

                if (data === 'topup_menu') {
                    await editToTopupMenu(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'langganan_menu') {
                    await showSubscriptionMenu(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_menu') {
                    await showAdminMenu(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_listtopup') {
                    await showAdminListTopup(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_listlangganan') {
                    await showAdminListLangganan(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_listgroup') {
                    await showAdminListGroup(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_addtopup_start') {
                    await bot.editMessageText(texts.admin.add_topup[lang], {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: texts.buttons.cancel[lang], callback_data: 'admin_batal' }]
                            ]
                        }
                    });
                    await setAdminState(userId, 'addtopup', 'waiting_userid');
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_addgroup_start') {
                    await bot.editMessageText(texts.admin.add_group[lang], {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: texts.buttons.cancel[lang], callback_data: 'admin_batal' }]
                            ]
                        }
                    });
                    await setAdminState(userId, 'addgroup', 'waiting_groupid');
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_removegroup_start') {
                    await bot.editMessageText(texts.admin.remove_group[lang], {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: texts.buttons.cancel[lang], callback_data: 'admin_batal' }]
                            ]
                        }
                    });
                    await setAdminState(userId, 'removegroup', 'waiting_groupid');
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_broadcast_start') {
                    await bot.editMessageText(texts.admin.broadcast_start[lang], {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: texts.buttons.cancel[lang], callback_data: 'admin_batal' }]
                            ]
                        }
                    });
                    await setAdminState(userId, 'broadcast', 'waiting_message');
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_batal') {
                    clearAdminState(userId);
                    await showAdminMenu(bot, chatId, messageId, userId);
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_offinfo') {
                    if (!db.feature) db.feature = {};
                    db.feature.info = false;
                    await saveDB();
                    await bot.editMessageText(texts.admin.feature_off[lang], {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: texts.buttons.admin_menu[lang], callback_data: 'admin_menu' }]
                            ]
                        }
                    });
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'admin_oninfo') {
                    if (!db.feature) db.feature = {};
                    db.feature.info = true;
                    await saveDB();
                    await bot.editMessageText(texts.admin.feature_on[lang], {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: texts.buttons.admin_menu[lang], callback_data: 'admin_menu' }]
                            ]
                        }
                    });
                    await bot.answerCallbackQuery(cb.id);
                    return;
                }

                if (data === 'langganan_7days' || data === 'langganan_30days') {
                    await bot.answerCallbackQuery(cb.id);
                    const subscriptionType = data === 'langganan_7days' ? '7days' : '30days';
                    const amount = subscriptionType === '7days' ? 50000 : 100000;
                    
                    const credits = getUserCredits(userId);
                    if (credits < amount) {
                        const msgText = texts.subscription_messages.not_enough_balance[lang](credits, amount);
                        await bot.editMessageText(msgText, {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: texts.buttons.topup[lang], callback_data: 'topup_menu' }],
                                    [{ text: texts.buttons.back_to_menu[lang], callback_data: 'langganan_menu' }]
                                ]
                            }
                        });
                        return;
                    }
                    
                    const result = await buySubscriptionWithBalance(userId, subscriptionType);
                    if (result.success) {
                        const endDate = moment(result.endDate).tz('Asia/Jakarta');
                        const successMsg = texts.subscription_messages.new[lang](subscriptionType, amount, result.newBalance, endDate.format('DD MMMM YYYY HH:mm'));
                        await bot.editMessageText(successMsg, {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: texts.buttons.back_to_menu[lang], callback_data: 'kembali_ke_menu' }]
                                ]
                            }
                        });
                    } else {
                        await bot.editMessageText(`Failed: ${result.error}`, {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: texts.buttons.back_to_menu[lang], callback_data: 'langganan_menu' }]
                                ]
                            }
                        });
                    }
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
                    
                    await bot.answerCallbackQuery(cb.id, { text: texts.cancel_topup[lang] });
                    return;
                }

                if (data.startsWith('topup_')) {
                    await bot.answerCallbackQuery(cb.id, { text: texts.processing[lang] });
                    
                    const amount = parseInt(data.replace('topup_', ''));
                    
                    const validAmounts = [5000, 10000, 25000, 50000, 100000, 200000, 500000, 1000000];
                    if (!validAmounts.includes(amount)) {
                        await bot.editMessageText(texts.invalid_amount[lang], {
                            chat_id: chatId,
                            message_id: messageId
                        });
                        return;
                    }
                    
                    await bot.editMessageText(texts.loading.creating_payment[lang], {
                        chat_id: chatId,
                        message_id: messageId
                    });
                    
                    const username = cb.from.username || '';
                    const payment = await createPakasirTopup(amount, userId, username);
                    
                    if (!payment.success) {
                        await bot.editMessageText(`Failed: ${payment.error}`, {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: texts.buttons.back_to_menu[lang], callback_data: 'topup_menu' }]
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
                        
                        const caption = texts.payment.qr_caption[lang](amount, payment.orderId, payment.expiredAt);
                        const sentMessage = await bot.sendPhoto(chatId, qrBuffer, {
                            caption: caption,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: texts.buttons.cancel[lang], callback_data: `cancel_topup_${payment.orderId}` }]
                                ]
                            }
                        });
                        
                        if (db.pending_topups && db.pending_topups[payment.orderId]) {
                            db.pending_topups[payment.orderId].messageId = sentMessage.message_id;
                            db.pending_topups[payment.orderId].chatId = chatId;
                            await saveDB();
                            console.log(`QR sent to chat ${chatId} with messageId ${sentMessage.message_id}`);
                        }
                        
                    } catch (qrError) {
                        console.log('Error sending QR:', qrError.message);
                        const qrText = texts.payment.qr_caption[lang](amount, payment.orderId, payment.expiredAt);
                        await bot.editMessageText(
                            `${qrText}\n\nQR Code:\n${payment.qrString}`,
                            {
                                chat_id: chatId,
                                message_id: messageId,
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: texts.buttons.cancel[lang], callback_data: `cancel_topup_${payment.orderId}` }]
                                    ]
                                }
                            }
                        );
                    }
                    
                    return;
                }
                
                await bot.answerCallbackQuery(cb.id, { text: texts.command_not_recognized[lang] });
                
            } catch (error) {
                console.log('Error callback:', error.message);
                try {
                    const lang = getUserLanguage(cb.from.id);
                    await bot.answerCallbackQuery(cb.id, { text: texts.error_occurred[lang] });
                } catch (e) {}
            }
        });

        const listenerPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
        
        listenerPool.connect((err, client, done) => {
            if (err) {
                console.log('Failed to connect listener:', err.message);
                return;
            }
            client.on('notification', (msg) => {
                console.log('NOTIFY received, reload database');
                loadDB().catch(e => console.log('Reload error:', e.message));
            });
            client.query('LISTEN db_updated');
            console.log('PostgreSQL listener active for channel db_updated');
        });

        console.log('Bot started, Admin IDs:', ADMIN_IDS);
        
    } catch (error) {
        console.log('FATAL ERROR:', error.message);
        console.log('Bot failed to start. Check your configuration.');
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
