/**
 * In-memory virmon (nanovor) data loaded from virmon-master.json at startup.
 * Ported from Python: game/virmon_data.py
 *
 * Used by battle (attack formulas, hacks, overrides), evolution, booster packs,
 * and anywhere nanovor base stats / attack definitions are needed.
 */

const fs = require('fs');
const path = require('path');

const JSON_PATH = path.join(__dirname, '..', 'data', 'virmon-master.json');

// Loaded data
let _virmons = [];
let _virmonByAsset = {};      // asset_type_id -> virmon record
let _attackDb = {};            // "assetTypeId:attackId" -> attack dict
let _statementDb = {};         // "assetTypeId:attackId" -> [statement dicts]
let _loaded = false;

// Statement types (from client BattleLogicAttackStatement)
const STATEMENT_TYPE_ATTACK = 'Attack';
const STATEMENT_TYPE_OVERRIDE = 'Override';
const STATEMENT_TYPE_HACK = 'Hack';
const STATEMENT_TYPE_MOD = 'Mod';
const STATEMENT_TYPE_PASS = 'Pass';

// Duration strings to round counts (from client BattleLogicAttackStatement.setDurationFromString)
const DURATION_MAP = {
    'None': 0,
    'Until end of this round': 1,
    '1 active round': 2,
    '2 active rounds': 3,
    '3 active rounds': 4,
    '4 active rounds': 5,
    '5 active rounds': 6,
    '6 active rounds': 7,
    '7 active rounds': 8,
    '8 active rounds': 9,
    '9 active rounds': 10,
    '10 active rounds': 11,
    'Permanent': 10000,
};

function _key(assetTypeId, attackId) {
    return `${assetTypeId}:${attackId}`;
}

function load() {
    if (_loaded) return true;
    if (!fs.existsSync(JSON_PATH)) {
        console.log(`[VIRMON] virmon-master.json not found at ${JSON_PATH}`);
        return false;
    }
    try {
        const raw = fs.readFileSync(JSON_PATH, 'utf8');
        const data = JSON.parse(raw);
        _virmons = data.virmons || [];
        _virmonByAsset = {};
        _attackDb = {};
        _statementDb = {};
        let hackCount = 0;
        let overrideCount = 0;

        for (const v of _virmons) {
            const aid = v.asset_type_id;
            _virmonByAsset[aid] = v;
            for (const a of (v.attacks || [])) {
                const attackId = a.id;
                const k = _key(aid, attackId);
                _attackDb[k] = a;
                const statements = a.statements || [];
                if (statements.length > 0) {
                    _statementDb[k] = statements;
                    for (const st of statements) {
                        if (st.type === STATEMENT_TYPE_HACK) hackCount++;
                        else if (st.type === STATEMENT_TYPE_OVERRIDE) overrideCount++;
                    }
                }
            }
        }
        _loaded = true;
        console.log(`[VIRMON] Loaded: ${_virmons.length} virmons, ${Object.keys(_attackDb).length} attacks, ${hackCount} hacks, ${overrideCount} overrides`);
        return true;
    } catch (e) {
        console.error(`[VIRMON] Load error: ${e.message}`);
        return false;
    }
}

function isLoaded() {
    return _loaded;
}

function getVirmon(assetTypeId) {
    if (!_loaded) load();
    return _virmonByAsset[assetTypeId] || null;
}

function getAttack(assetTypeId, attackId) {
    if (!_loaded) load();
    return _attackDb[_key(assetTypeId, attackId)] || null;
}

function getAttackStatements(assetTypeId, attackId) {
    if (!_loaded) load();
    return _statementDb[_key(assetTypeId, attackId)] || [];
}

function listVirmons() {
    if (!_loaded) load();
    return [..._virmons];
}

function getAttackCost(assetTypeId, attackId) {
    if (!_loaded) load();
    if (attackId <= 0) return 0;
    const attack = _attackDb[_key(assetTypeId, attackId)];
    return attack ? parseInt(attack.cost || 0, 10) : 0;
}

function parseDuration(durationStr) {
    return DURATION_MAP[durationStr] || 0;
}

function getHackStatements(assetTypeId, attackId) {
    return getAttackStatements(assetTypeId, attackId).filter(st => st.type === STATEMENT_TYPE_HACK);
}

function getOverrideStatements(assetTypeId, attackId) {
    return getAttackStatements(assetTypeId, attackId).filter(st => st.type === STATEMENT_TYPE_OVERRIDE);
}

function getDamageStatements(assetTypeId, attackId) {
    return getAttackStatements(assetTypeId, attackId).filter(st => st.type === STATEMENT_TYPE_ATTACK);
}

function createActiveHack(statement, attackId) {
    const durationStr = statement.duration || 'None';
    const duration = parseDuration(durationStr);
    return {
        statement_id: statement.statement_id || 0,
        attack_id: attackId,
        name: statement.name || '',
        type: statement.type || '',
        target: statement.target || '',
        stat: statement.stat || '',
        verb: statement.verb || '',
        base_formula: statement.base_formula || '0',
        statement_formula: statement.statement_formula || '0',
        duration: duration,
        current_duration: duration,
    };
}

module.exports = {
    load,
    isLoaded,
    getVirmon,
    getAttack,
    getAttackStatements,
    listVirmons,
    getAttackCost,
    parseDuration,
    getHackStatements,
    getOverrideStatements,
    getDamageStatements,
    createActiveHack,
    STATEMENT_TYPE_ATTACK,
    STATEMENT_TYPE_OVERRIDE,
    STATEMENT_TYPE_HACK,
    STATEMENT_TYPE_MOD,
    STATEMENT_TYPE_PASS,
    DURATION_MAP,
};
