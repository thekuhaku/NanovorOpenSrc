/**
 * User profile and session helpers.
 * Uses integer account IDs and integer EM asset IDs (no UUIDs).
 */

const path = require('path');
const fs = require('fs');
const state = require('./state');

const { users, sessions, getNextAccountId, setNextAccountIdIfHigher, getNextEmAssetId, setNextEmAssetIdIfHigher } = state;

const USER_DATA_DIR = path.join(__dirname, 'UserData');

function findSessionByToken(token) {
    if (!token) return null;
    for (const sid of Object.keys(sessions)) {
        const s = sessions[sid];
        if (s && s.loginToken === token) return s;
    }
    return null;
}

function createUserProfile(accountId, username) {
    const now = new Date().toISOString();
    return {
        id: accountId,
        username: username || 'n',
        screenname: username || 'n',
        email: (username || 'n') + '@nanovor.example.com',
        phoneNumber: '',
        nanocash: 1000,
        nmp: 0,
        nanovorCount: 0,
        nanovorCountUnique: 0,
        ems: 0,
        healthJolts: 0,
        armorJolts: 0,
        strengthJolts: 0,
        speedJolts: 0,
        avatarId: 1,
        breadcrumbCount: 0,
        gamesWon: 0,
        gamesPlayed: 0,
        totalKills: 0,
        hexiteKills: 0,
        magnamodKills: 0,
        velocitronKills: 0,
        twoPlayerGames: 0,
        threePlayerGames: 0,
        fourPlayerGames: 0,
        battleCount: 0,
        hasSeenNewUserExperience: false,
        created: now,
        lastLogin: now,
        nanovorInventory: [],
        emInventory: [],
        badges: []
    };
}

function migrateEmToIntegerIds(em) {
    const idNum = typeof em.id === 'number' ? Math.floor(em.id) : parseInt(em.id, 10);
    if (Number.isNaN(idNum) || idNum < 1) {
        em.id = getNextEmAssetId();
    } else {
        em.id = idNum;
        setNextEmAssetIdIfHigher(idNum);
    }
    em.assetTypeId = typeof em.assetTypeId === 'number' ? Math.floor(em.assetTypeId) : (parseInt(em.assetTypeId, 10) || 0);
    em.assetId = em.id;
}

function saveUserData(accountId) {
    const user = users[accountId];
    if (!user) return;
    const username = (user.username || 'n').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(USER_DATA_DIR, username + '.json');
    const toSave = { ...user };
    toSave.id = Number(toSave.id);
    if (Array.isArray(toSave.emInventory)) {
        toSave.emInventory = toSave.emInventory.map(em => {
            const e = { ...em };
            e.id = Number(e.id);
            e.assetTypeId = Number(e.assetTypeId) || 0;
            e.assetId = e.id;
            return e;
        });
    }
    if (Array.isArray(toSave.nanovorInventory)) {
        toSave.nanovorInventory = toSave.nanovorInventory.map(n => ({
            ...n,
            id: Number(n.id),
            assetTypeId: Number(n.assetTypeId) || 0,
            assetId: Number(n.assetId) != null && !Number.isNaN(Number(n.assetId)) ? Number(n.assetId) : Number(n.id)
        }));
    }
    try {
        fs.mkdirSync(USER_DATA_DIR, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2), 'utf8');
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Failed to save user ${accountId}:`, err.message);
    }
}

function loadUserDataByUsername(username) {
    const safeName = (username || 'n').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(USER_DATA_DIR, safeName + '.json');
    try {
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        const idNum = typeof data.id === 'number' ? Math.floor(data.id) : parseInt(data.id, 10);
        let accountId;
        if (Number.isNaN(idNum) || idNum < 1) {
            accountId = getNextAccountId();
            data.id = accountId;
        } else {
            accountId = idNum;
            setNextAccountIdIfHigher(idNum);
        }
        if (Array.isArray(data.emInventory)) {
            data.emInventory.forEach(migrateEmToIntegerIds);
        }
        if (Array.isArray(data.nanovorInventory)) {
            data.nanovorInventory.forEach(n => {
                n.id = Number(n.id);
                n.assetTypeId = Number(n.assetTypeId) || 0;
                const aid = Number(n.assetId);
                n.assetId = (!Number.isNaN(aid) && aid >= 1) ? aid : n.id;
            });
        }
        users[accountId] = data;
        if (data.id !== accountId) data.id = accountId;
        saveUserData(accountId);
        return data;
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Failed to load user by username ${username}:`, err.message);
        return null;
    }
}

function loadUserData(accountId) {
    const id = Number(accountId);
    if (Number.isNaN(id) || id < 1) return null;
    if (users[id]) return users[id];
    try {
        if (!fs.existsSync(USER_DATA_DIR)) return null;
        const files = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('.json'));
        for (const f of files) {
            const username = f.replace(/\.json$/, '');
            const raw = fs.readFileSync(path.join(USER_DATA_DIR, f), 'utf8');
            const data = JSON.parse(raw);
            const fileId = typeof data.id === 'number' ? data.id : parseInt(data.id, 10);
            if (fileId === id) {
                data.id = id;
                setNextAccountIdIfHigher(id);
                if (Array.isArray(data.emInventory)) data.emInventory.forEach(migrateEmToIntegerIds);
                if (Array.isArray(data.nanovorInventory)) {
                    data.nanovorInventory.forEach(n => {
                        n.id = Number(n.id);
                        n.assetTypeId = Number(n.assetTypeId) || 0;
                        const aid = Number(n.assetId);
                        n.assetId = (!Number.isNaN(aid) && aid >= 1) ? aid : n.id;
                    });
                }
                users[id] = data;
                saveUserData(id);
                return data;
            }
        }
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Failed to load user ${accountId}:`, err.message);
    }
    return null;
}

function loadAllUserData() {
    try {
        if (!fs.existsSync(USER_DATA_DIR)) return;
        const files = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('.json'));
        for (const f of files) {
            const username = f.replace(/\.json$/, '');
            loadUserDataByUsername(username);
        }
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Failed to load all user data:`, err.message);
    }
}

module.exports = {
    findSessionByToken,
    createUserProfile,
    saveUserData,
    loadUserDataByUsername,
    loadUserData,
    loadAllUserData
};
