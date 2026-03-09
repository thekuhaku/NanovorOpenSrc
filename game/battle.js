/**
 * Battle logic: formula evaluation, damage resolution, hack/override system.
 * Ported from Python: game/battle.py
 */

const virmonData = require('./virmonData');

// ============================================================================
// Formula Variables
// ============================================================================

function _randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function _getVar(name, myNano, enemyNano, statementBaseDamage) {
    switch (name) {
        case '$MyStrength':    return Number(myNano.modded_strength ?? myNano.strength ?? 100);
        case '$MyArmor':       return Number(myNano.modded_armor ?? myNano.armor ?? 0);
        case '$MyHealth':      return Number(myNano.health ?? 100);
        case '$MySpeed':       return Number(myNano.modded_speed ?? myNano.speed ?? 10);
        case '$MyEnergy':      return Number(myNano.energyLevel ?? 0);
        case '$StatementBaseDamage': return statementBaseDamage != null ? statementBaseDamage : 0;
        case '$EnemyStrength':  return enemyNano ? Number(enemyNano.modded_strength ?? enemyNano.strength ?? 100) : 0;
        case '$EnemyArmor':     return enemyNano ? Number(enemyNano.modded_armor ?? enemyNano.armor ?? 0) : 0;
        case '$EnemyHealth':    return enemyNano ? Number(enemyNano.health ?? 100) : 0;
        case '$EnemySpeed':     return enemyNano ? Number(enemyNano.modded_speed ?? enemyNano.speed ?? 10) : 0;
        case '$EnemyEnergy':    return enemyNano ? Number(enemyNano.energyLevel ?? 0) : 0;
        case '$D4':   return _randInt(1, 4);
        case '$D6':   return _randInt(1, 6);
        case '$D10':  return _randInt(1, 10);
        case '$D20':  return _randInt(1, 20);
        case '$D30':  return _randInt(1, 30);
        case '$D100': return _randInt(1, 100);
        case '$5D20': {
            let s = 0; for (let i = 0; i < 5; i++) s += _randInt(1, 20); return s;
        }
        case '$10D20': {
            let s = 0; for (let i = 0; i < 10; i++) s += _randInt(1, 20); return s;
        }
        default: return 0;
    }
}

function _substituteVars(formula, myNano, enemyNano, statementBaseDamage) {
    return formula.replace(/\$\w+/g, (match) => {
        return String(_getVar(match, myNano, enemyNano, statementBaseDamage));
    });
}

// ============================================================================
// Safe Math Evaluator
// ============================================================================

function _safeEval(expr) {
    expr = expr.replace(/\s/g, '');
    // Resolve parentheses innermost first
    while (expr.includes('(')) {
        let depth = 0, start = null;
        for (let i = 0; i < expr.length; i++) {
            if (expr[i] === '(') {
                if (depth === 0) start = i;
                depth++;
            } else if (expr[i] === ')') {
                depth--;
                if (depth === 0 && start != null) {
                    const inner = expr.substring(start + 1, i);
                    const val = _safeEval(inner);
                    expr = expr.substring(0, start) + String(val) + expr.substring(i + 1);
                    break;
                }
            }
        }
    }
    // Tokenize
    const tokens = expr.match(/[\d.]+|[+\-*/]/g);
    if (!tokens) return 0;
    const stack = tokens.map(t => '+-*/'.includes(t) ? t : (parseFloat(t) || 0));
    // * and / first
    let i = 0;
    while (i < stack.length) {
        if (stack[i] === '*' && i > 0 && i + 1 < stack.length) {
            const a = stack[i - 1], b = stack[i + 1];
            if (typeof a === 'number' && typeof b === 'number') {
                stack.splice(i - 1, 3, a * b);
                i--;
            }
        } else if (stack[i] === '/' && i > 0 && i + 1 < stack.length) {
            const a = stack[i - 1], b = stack[i + 1];
            if (typeof a === 'number' && typeof b === 'number') {
                stack.splice(i - 1, 3, b !== 0 ? a / b : 0);
                i--;
            }
        }
        i++;
    }
    // + and -
    i = 0;
    while (i < stack.length) {
        if (stack[i] === '+' && i > 0 && i + 1 < stack.length) {
            const a = stack[i - 1], b = stack[i + 1];
            if (typeof a === 'number' && typeof b === 'number') {
                stack.splice(i - 1, 3, a + b);
                i--;
            }
        } else if (stack[i] === '-' && i > 0 && i + 1 < stack.length) {
            const a = stack[i - 1], b = stack[i + 1];
            if (typeof a === 'number' && typeof b === 'number') {
                stack.splice(i - 1, 3, a - b);
                i--;
            }
        }
        i++;
    }
    return typeof stack[0] === 'number' ? stack[0] : 0;
}

function evalFormula(formula, myNano, enemyNano, statementBaseDamage) {
    if (!formula || !formula.trim()) return 0;
    const substituted = _substituteVars(formula, myNano, enemyNano, statementBaseDamage);
    try {
        return _safeEval(substituted);
    } catch (e) {
        return 0;
    }
}

function performOperation(current, verb, value) {
    if (verb === '+') return current + value;
    if (verb === '-') return current - value;
    if (verb === '*') return current * value;
    if (verb === '/') return value !== 0 ? current / value : 0;
    if (verb === '=') return value;
    return current;
}

// ============================================================================
// Hack / Override System
// ============================================================================

const STAT_MAP = {
    'Health': 'health',
    'Armor': 'armor',
    'Strength': 'strength',
    'Speed': 'speed',
    'Swap %': 'swap_percent',
    'Stun Fail %': 'stun_fail_percent',
    'Dodge Fail %': 'dodge_fail_percent',
    'Energy': 'energyLevel',
    'Energy Generator': 'energyGenerator',
    'RedSpike': 'red_spike',
    'BlueSpike': 'blue_spike',
    'YellowSpike': 'yellow_spike',
};

const MAX_HACKS_PER_NANOVOR = 5;

// ============================================================================
// Spike System
// ============================================================================

function hasSpike(activeOverrides, spikeType) {
    if (!activeOverrides) return false;
    for (const ov of activeOverrides) {
        if ((ov.stat || '') === spikeType) {
            try {
                if (parseFloat(ov.statement_formula || '0') > 0) return true;
            } catch (e) { /* ignore */ }
        }
    }
    return false;
}

function hasRedSpike(overrides)    { return hasSpike(overrides, 'RedSpike'); }
function hasBlueSpike(overrides)   { return hasSpike(overrides, 'BlueSpike'); }
function hasYellowSpike(overrides) { return hasSpike(overrides, 'YellowSpike'); }

function _statementHasSpikeConditional(st) {
    let cond = st.conditional_name || '';
    if (!cond && st.conditionals && st.conditionals[0]) cond = st.conditionals[0].name || '';
    const c = (cond || '').toLowerCase();
    return c.includes('redspike') || c.includes('bluespike') || c.includes('yellowspike');
}

function _statementHasAttackFailedConditional(st) {
    let cond = st.conditional_name || '';
    if (!cond && st.conditionals && st.conditionals[0]) cond = st.conditionals[0].name || '';
    return (cond || '').toLowerCase().includes('attack failed');
}

function checkStatementConditional(statement, attackerOverrides) {
    let conditional = statement.conditional_name || '';
    if (!conditional) {
        const cond1 = statement.conditional_1;
        if (cond1 && typeof cond1 === 'object') conditional = cond1.conditional_name || '';
    }
    if (!conditional) {
        const condList = statement.conditionals || [];
        if (condList[0] && typeof condList[0] === 'object') conditional = condList[0].name || '';
    }
    if (!conditional) return true;
    const cl = conditional.toLowerCase();
    if (cl.includes('redspike'))    return hasRedSpike(attackerOverrides);
    if (cl.includes('bluespike'))   return hasBlueSpike(attackerOverrides);
    if (cl.includes('yellowspike')) return hasYellowSpike(attackerOverrides);
    return true;
}

// ============================================================================
// Modded Stats
// ============================================================================

function getModdedStat(nanovorState, statName, activeHacks, activeOverrides) {
    let baseValue = Number(nanovorState[statName] || 0);
    const allMods = [];
    if (activeHacks) allMods.push(...activeHacks);
    if (activeOverrides) allMods.push(...activeOverrides);
    if (!allMods.length) return baseValue;

    for (const mod of allMods) {
        const modStat = STAT_MAP[mod.stat || ''] || (mod.stat || '').toLowerCase();
        if (modStat !== statName) continue;
        const verb = mod.verb || '';
        const formula = mod.statement_formula || '0';
        const isOverride = (mod.type || '').trim() === 'Override';
        let value;
        if (typeof formula === 'number') {
            value = formula;
        } else {
            const fs = String(formula).trim();
            if (/^-?\d+\.?\d*$/.test(fs)) {
                value = parseFloat(fs);
            } else if (isOverride) {
                value = 0;
            } else {
                value = evalFormula(fs, nanovorState, null);
            }
        }
        baseValue = performOperation(baseValue, verb, value);
    }
    if (['speed', 'strength', 'armor', 'health'].includes(statName)) {
        baseValue = Math.max(0, baseValue);
    }
    return baseValue;
}

function applyModdedStatsToState(nanovorState, activeHacks, activeOverrides) {
    const result = Object.assign({}, nanovorState);
    result.modded_strength = getModdedStat(nanovorState, 'strength', activeHacks, activeOverrides);
    result.modded_armor    = getModdedStat(nanovorState, 'armor', activeHacks, activeOverrides);
    result.modded_speed    = getModdedStat(nanovorState, 'speed', activeHacks, activeOverrides);
    return result;
}

function getModdedSpeed(nanovorState, activeHacks, activeOverrides) {
    return Math.floor(getModdedStat(nanovorState, 'speed', activeHacks, activeOverrides));
}

// ============================================================================
// Dodge
// ============================================================================

function getDodgeChance(activeHacks, activeOverrides) {
    const allMods = [];
    if (activeHacks) allMods.push(...activeHacks);
    if (activeOverrides) allMods.push(...activeOverrides);
    let dodgeFailPercent = 100;
    for (const mod of allMods) {
        if ((mod.stat || '') !== 'Dodge Fail %') continue;
        const verb = mod.verb || '';
        let value;
        try { value = parseFloat(mod.statement_formula || '100'); } catch (e) { value = 100; }
        if (verb === '=') dodgeFailPercent = value;
        else if (verb === '+') dodgeFailPercent += value;
        else if (verb === '-') dodgeFailPercent -= value;
    }
    dodgeFailPercent = Math.max(0, Math.min(100, dodgeFailPercent));
    return Math.floor(100 - dodgeFailPercent);
}

function checkDodge(activeHacks, activeOverrides) {
    const chance = getDodgeChance(activeHacks, activeOverrides);
    if (chance <= 0) return false;
    return _randInt(1, 100) <= chance;
}

// ============================================================================
// Stun / Swap Block
// ============================================================================

function isSwapBlocked(activeHacks) {
    for (const hack of (activeHacks || [])) {
        if (hack.stat === 'Swap %' && hack.verb === '=') {
            try {
                if (parseFloat(hack.statement_formula || '1') === 0) return true;
            } catch (e) { /* ignore */ }
        }
    }
    return false;
}

function isStunned(activeHacks) {
    for (const hack of (activeHacks || [])) {
        if (hack.stat === 'Stun Fail %' && hack.verb === '=') {
            try {
                if (parseFloat(hack.statement_formula || '1') === 0) return true;
            } catch (e) { /* ignore */ }
        }
    }
    return false;
}

// ============================================================================
// Damage Statement Selection (spike-aware)
// ============================================================================

function pickDamageStatement(statements, attackerOverrides, assetTypeId, attackId) {
    const damageCandidates = statements.filter(s =>
        (s.target || '').trim() === 'Enemy active Virmon' &&
        (s.stat || '').trim() === 'Health' &&
        (s.type || '').trim() === 'Attack'
    );
    if (!damageCandidates.length) return statements[0] || null;

    if (assetTypeId != null && attackId != null && attackerOverrides) {
        const attack = virmonData.getAttack(assetTypeId, attackId);
        if (attack) {
            const attackCond = ((attack.conditional || {}).name || '').toLowerCase();
            const pickBySpike = (hasFn, failedFirstFn) => {
                if (hasFn(attackerOverrides)) {
                    for (const s of damageCandidates) if (!_statementHasAttackFailedConditional(s)) return s;
                } else {
                    for (const s of damageCandidates) if (_statementHasAttackFailedConditional(s)) return s;
                }
                return null;
            };
            if (attackCond.includes('redspike'))    { const r = pickBySpike(hasRedSpike); if (r) return r; }
            else if (attackCond.includes('bluespike'))   { const r = pickBySpike(hasBlueSpike); if (r) return r; }
            else if (attackCond.includes('yellowspike')) { const r = pickBySpike(hasYellowSpike); if (r) return r; }
        }
    }
    if (attackerOverrides) {
        for (const s of damageCandidates) {
            if (_statementHasSpikeConditional(s) && checkStatementConditional(s, attackerOverrides)) return s;
        }
    }
    return damageCandidates[0];
}

// ============================================================================
// Resolve Attack Damage
// ============================================================================

function resolveAttackDamage(
    attackerState, targetState, assetTypeId, attackId,
    attackerHacks, attackerOverrides, targetHacks, targetOverrides
) {
    if (attackId <= 0) return { statementId: 0, totalDamage: 0, clientDesc: 'Pass', wasDodged: false, isHealthDamage: false };

    attackerHacks = attackerHacks || [];
    attackerOverrides = attackerOverrides || [];
    targetHacks = targetHacks || [];
    targetOverrides = targetOverrides || [];

    const moddedAttacker = applyModdedStatsToState(attackerState, attackerHacks, attackerOverrides);
    const moddedTarget   = applyModdedStatsToState(targetState, targetHacks, targetOverrides);

    if (checkDodge(targetHacks, targetOverrides)) {
        return { statementId: 0, totalDamage: 0, clientDesc: 'Dodged!', wasDodged: true, isHealthDamage: false };
    }

    const statements = virmonData.getAttackStatements(assetTypeId, attackId);
    const st = pickDamageStatement(statements, attackerOverrides, assetTypeId, attackId);
    if (!st) {
        const armor = parseInt(targetState.armor || 0, 10);
        const fallback = Math.max(0, 25 - armor);
        targetState.health = Math.max(0, parseInt(targetState.health || 0, 10) - fallback);
        return { statementId: 11, totalDamage: fallback, clientDesc: '70 DAM', wasDodged: false, isHealthDamage: true };
    }

    const baseFormula      = st.base_formula || '0';
    const statementFormula = st.statement_formula || '0';
    const stat    = (st.stat || '').trim();
    const verb    = (st.verb || '-').trim();
    const name    = (st.name || 'Attack').trim();

    const baseDamage = evalFormula(baseFormula, moddedAttacker, null);
    let finalValue   = evalFormula(statementFormula, moddedAttacker, moddedTarget, baseDamage);
    finalValue = Math.max(0, Math.round(finalValue));
    const statementId = parseInt(st.statement_id || 0, 10);

    // Spike damage modifiers
    const attack = virmonData.getAttack(assetTypeId, attackId);
    const attackCond = ((attack && (attack.conditional || {}).name) || '').toLowerCase();
    const useAttackFailedLogic = attackCond.includes('redspike') || attackCond.includes('bluespike') || attackCond.includes('yellowspike');
    const chosenHasSpikeCond = _statementHasSpikeConditional(st);
    if (attackerOverrides.length && !chosenHasSpikeCond && !useAttackFailedLogic && attack) {
        const desc = (attack.short_description || '').toLowerCase();
        if (hasRedSpike(attackerOverrides) && (desc.includes('red spike') || desc.includes('redspike'))) {
            if (desc.includes('double damage') || desc.includes('double dmg')) finalValue = Math.min(999, finalValue * 2);
            else if (desc.includes('more damage') || desc.includes('damage is increased')) finalValue = Math.min(999, Math.floor(finalValue * 1.5));
        } else if (hasBlueSpike(attackerOverrides) && (desc.includes('blue spike') || desc.includes('bluespike'))) {
            if (desc.includes('more damage') || desc.includes('more ap') || desc.includes('more ap damage')) finalValue = Math.min(999, Math.floor(finalValue * 1.5));
        } else if (hasYellowSpike(attackerOverrides) && (desc.includes('yellow spike') || desc.includes('yellowspike'))) {
            if (desc.includes('more damage')) finalValue = Math.min(999, Math.floor(finalValue * 1.5));
        }
        finalValue = Math.max(0, Math.floor(finalValue));
    }

    const stType = (st.type || '').trim();
    const isHealthDamage = (stat === 'Health' && verb === '-' && stType === 'Attack');
    if (stat === 'Health' && verb === '-') {
        const currentHp = parseInt(targetState.health || 0, 10);
        const newHp = Math.max(0, Math.floor(performOperation(currentHp, verb, finalValue)));
        targetState.health = newHp;
    }

    return { statementId, totalDamage: finalValue, clientDesc: name, wasDodged: false, isHealthDamage };
}

// ============================================================================
// Self-Damage
// ============================================================================

function attackHasSelfDamage(assetTypeId, attackId) {
    const statements = virmonData.getAttackStatements(assetTypeId, attackId);
    for (const st of statements) {
        const target = (st.target || '').trim();
        if (target !== 'My active Virmon' && target !== 'My team') continue;
        if ((st.type || '').trim() === 'Attack' && (st.stat || '').trim() === 'Health') return true;
    }
    return false;
}

function applySelfDamageFromAttack(attackerState, assetTypeId, attackId, attackerHacks, attackerOverrides) {
    const statements = virmonData.getAttackStatements(assetTypeId, attackId);
    attackerHacks = attackerHacks || [];
    attackerOverrides = attackerOverrides || [];
    const moddedAttacker = applyModdedStatsToState(attackerState, attackerHacks, attackerOverrides);
    for (const st of statements) {
        const target = (st.target || '').trim();
        if (target !== 'My active Virmon' && target !== 'My team') continue;
        if ((st.type || '').trim() !== 'Attack' || (st.stat || '').trim() !== 'Health') continue;
        const verb = (st.verb || '-').trim();
        const formula = (st.statement_formula || '0').trim();
        let value;
        if (/^-?\d+\.?\d*$/.test(formula)) value = parseFloat(formula);
        else value = evalFormula(formula, moddedAttacker, null);
        value = Math.max(0, Math.round(value));
        if (value <= 0) continue;
        const currentHp = parseInt(attackerState.health || 0, 10);
        attackerState.health = Math.max(0, currentHp - value);
    }
}

// ============================================================================
// Hack Application
// ============================================================================

function applyHacksFromAttack(attackerState, targetState, attackerHacks, targetHacks, assetTypeId, attackId, attackerOverrides) {
    const newAttackerHacks = [];
    const newTargetHacks = [];
    attackerOverrides = attackerOverrides || [];

    const hackStatements = virmonData.getHackStatements(assetTypeId, attackId);
    for (const st of hackStatements) {
        if (!checkStatementConditional(st, attackerOverrides)) continue;
        const targetType = st.target || '';
        const hack = virmonData.createActiveHack(st, attackId);

        if (targetType === 'Enemy active Virmon' || targetType === 'Enemy team') {
            if (targetHacks.length + newTargetHacks.length < MAX_HACKS_PER_NANOVOR) newTargetHacks.push(hack);
        } else if (targetType === 'My active Virmon' || targetType === 'My team') {
            if (attackerHacks.length + newAttackerHacks.length < MAX_HACKS_PER_NANOVOR) newAttackerHacks.push(hack);
        } else if (targetType === 'All active Virmon' || targetType === 'All teams') {
            if (attackerHacks.length + newAttackerHacks.length < MAX_HACKS_PER_NANOVOR) newAttackerHacks.push(Object.assign({}, hack));
            if (targetHacks.length + newTargetHacks.length < MAX_HACKS_PER_NANOVOR) newTargetHacks.push(Object.assign({}, hack));
        }
    }
    return { newAttackerHacks, newTargetHacks };
}

// ============================================================================
// Override Application
// ============================================================================

function applyOverridesFromAttack(attackerUid, targetUid, attackerOverrides, targetOverrides, assetTypeId, attackId) {
    const newAttackerOverrides = [];
    const newTargetOverrides = [];
    let clearAttacker = false;
    let clearTarget = false;

    const overrideStatements = virmonData.getOverrideStatements(assetTypeId, attackId);
    for (const st of overrideStatements) {
        if (!checkStatementConditional(st, attackerOverrides)) continue;
        const targetType = st.target || '';
        const override = virmonData.createActiveHack(st, attackId);

        if (targetType === 'Enemy active Virmon' || targetType === 'Enemy team') {
            clearTarget = true;
            newTargetOverrides.push(override);
        } else if (targetType === 'My active Virmon' || targetType === 'My team') {
            clearAttacker = true;
            newAttackerOverrides.push(override);
        } else if (targetType === 'All active Virmon' || targetType === 'All teams') {
            clearAttacker = true;
            clearTarget = true;
            newAttackerOverrides.push(Object.assign({}, override));
            newTargetOverrides.push(Object.assign({}, override));
        }
    }
    return { newAttackerOverrides, newTargetOverrides, clearAttacker, clearTarget };
}

// ============================================================================
// Delete Override Mod Check
// ============================================================================

function checkDeleteOverrideMod(assetTypeId, attackId, attackerOverrides) {
    const statements = virmonData.getAttackStatements(assetTypeId, attackId);
    let removesOwn = false, removesEnemy = false, clearStatementId = 0;
    attackerOverrides = attackerOverrides || [];

    for (const st of statements) {
        if (st.type !== 'Mod') continue;
        if (st.stat !== 'Override' || st.verb !== 'Remove') continue;
        if (!checkStatementConditional(st, attackerOverrides)) continue;
        const target = st.target || '';
        if (target === 'My active Virmon' || target === 'My team') {
            if (!removesOwn) clearStatementId = parseInt(st.statement_id || 0, 10);
            removesOwn = true;
        } else if (target === 'Enemy active Virmon' || target === 'Enemy team') {
            removesEnemy = true;
        } else if (target === 'All active Virmon' || target === 'All teams') {
            if (!removesOwn) clearStatementId = parseInt(st.statement_id || 0, 10);
            removesOwn = true;
            removesEnemy = true;
        }
    }
    return { removesOwn, removesEnemy, clearStatementId };
}

// ============================================================================
// Energy Mods
// ============================================================================

function getEnergyModsFromAttack(assetTypeId, attackId, attackerOverrides) {
    let attackerChange = 0, targetChange = 0;
    const statements = virmonData.getAttackStatements(assetTypeId, attackId);
    for (const st of statements) {
        if (st.type !== 'Mod' || st.stat !== 'Energy') continue;
        if (!checkStatementConditional(st, attackerOverrides)) continue;
        const targetType = st.target || '';
        const verb = st.verb || '';
        let value;
        try { value = parseFloat(st.statement_formula || '0'); } catch (e) { value = 0; }
        let change;
        if (verb === '-') change = -Math.floor(value);
        else if (verb === '+') change = Math.floor(value);
        else if (verb === '=') change = Math.floor(value);
        else change = 0;

        if (targetType === 'Enemy active Virmon' || targetType === 'Enemy team') targetChange += change;
        else if (targetType === 'My active Virmon' || targetType === 'My team') attackerChange += change;
        else if (targetType === 'All active Virmon' || targetType === 'All teams') { attackerChange += change; targetChange += change; }
    }
    return { attackerChange, targetChange };
}

// ============================================================================
// Stat Mods
// ============================================================================

function getStatModsFromAttack(assetTypeId, attackId, attackerOverrides) {
    const mods = [];
    const statements = virmonData.getAttackStatements(assetTypeId, attackId);
    for (const st of statements) {
        if (st.type !== 'Mod') continue;
        const stat = st.stat || '';
        if (stat === 'Energy' || stat === 'Override' || stat === 'Health') continue;
        if (!checkStatementConditional(st, attackerOverrides)) continue;
        let value;
        try { value = parseFloat(st.statement_formula || '0'); } catch (e) { value = 0; }
        mods.push({
            statement_id: parseInt(st.statement_id || 0, 10),
            target: st.target || '',
            stat,
            verb: st.verb || '',
            value
        });
    }
    return mods;
}

const _STAT_MOD_DISPLAY_ABBREV = { 'Speed': 'SPD', 'Strength': 'STR', 'Armor': 'ARM', 'Health': 'HLTH' };

function formatStatModsForClientDescription(statMods, targetEnemy) {
    const parts = [];
    for (const mod of statMods) {
        const targetType = mod.target || '';
        const isEnemy = (targetType === 'Enemy active Virmon' || targetType === 'Enemy team');
        if (isEnemy !== targetEnemy) continue;
        const stat = mod.stat || '';
        const verb = mod.verb || '';
        const value = mod.value || 0;
        const abbrev = _STAT_MOD_DISPLAY_ABBREV[stat] || (stat ? stat.substring(0, 3).toUpperCase() : '');
        if (!abbrev) continue;
        if (verb === '-') parts.push(` -${Math.floor(Math.abs(value))} ${abbrev}`);
        else if (verb === '+') parts.push(` +${Math.floor(value)} ${abbrev}`);
    }
    return parts.join('');
}

function applyStatModToState(nanovorState, stat, verb, value) {
    const statKey = STAT_MAP[stat] || stat.toLowerCase();
    const current = Number(nanovorState[statKey] || 0);
    if (verb === '-') value = Math.abs(value);
    let newValue = performOperation(current, verb, value);
    if (['speed', 'strength', 'armor', 'health'].includes(statKey)) newValue = Math.max(0, newValue);
    nanovorState[statKey] = newValue;
}

// ============================================================================
// Duration Management
// ============================================================================

function decrementHackDurations(activeHacks) {
    return activeHacks.filter(hack => {
        const current = hack.current_duration || 0;
        if (current > 1) {
            hack.current_duration = current - 1;
            return true;
        }
        return false;
    });
}

function decrementOverrideDurations(activeOverrides) {
    // Overrides don't auto-expire
    return activeOverrides;
}

// ============================================================================
// Client Formatting
// ============================================================================

function formatHacksForClient(activeHacks) {
    return (activeHacks || []).map(hack => ({
        statementId: String(hack.statement_id || 0),
        currentDuration: hack.current_duration || 0,
    }));
}

function formatOverridesForClient(activeOverrides) {
    if (!activeOverrides || !activeOverrides.length) return '';
    return activeOverrides.map(ov => String(ov.statement_id || 0)).join(',');
}

function buildTargetUpdatesForClient(targetState, targetEnergy, targetOverrides, targetHacks, attackerOverrides, isSwapBlockedFn) {
    targetOverrides = targetOverrides || [];
    targetHacks = targetHacks || [];

    let blueSpike = 0;
    if (targetOverrides.length) blueSpike = parseInt(targetOverrides[0].statement_id || 0, 10);
    let redSpike = 0;
    if (attackerOverrides && attackerOverrides.length) redSpike = parseInt(attackerOverrides[0].statement_id || 0, 10);

    const overrideIdsStr = formatOverridesForClient(targetOverrides);
    const overrideIdsValue = overrideIdsStr || null;

    const clamp = v => Math.max(0, Math.floor(v || 0));
    const selectedNanovor = {
        instanceId: String(targetState.instanceId || ''),
        assetTypeId: parseInt(targetState.assetTypeId || 0, 10),
        nickname: String(targetState.nickname || ''),
        health: clamp(targetState.health),
        armor: clamp(targetState.armor),
        speed: clamp(targetState.speed),
        strength: clamp(targetState.strength),
        stunFailChance: 0,
        dodgeChance: 0,
        moddedStunFailChance: 0,
        moddedDodgeFailChance: 0,
        yellowSpike: 0,
        blueSpike,
        redSpike,
        moddedYellowSpike: 0,
        moddedBlueSpike: blueSpike,
        moddedRedSpike: redSpike,
        hacks: formatHacksForClient(targetHacks),
    };
    const swapPct = isSwapBlockedFn(targetHacks) ? 0 : 100;
    return {
        energyLevel: parseInt(targetEnergy.energyLevel || 0, 10),
        energyGenerator: parseInt(targetEnergy.energyGenerator || 0, 10),
        moddedEnergyGenerator: parseInt(targetEnergy.moddedEnergyGenerator || 0, 10),
        swapChance: swapPct,
        moddedSwapChance: swapPct,
        overrideIds: overrideIdsValue,
        selectedNanovor,
    };
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
    evalFormula,
    performOperation,
    STAT_MAP,
    MAX_HACKS_PER_NANOVOR,
    hasSpike,
    hasRedSpike,
    hasBlueSpike,
    hasYellowSpike,
    checkStatementConditional,
    getModdedStat,
    applyModdedStatsToState,
    getModdedSpeed,
    getDodgeChance,
    checkDodge,
    isSwapBlocked,
    isStunned,
    pickDamageStatement,
    resolveAttackDamage,
    attackHasSelfDamage,
    applySelfDamageFromAttack,
    applyHacksFromAttack,
    applyOverridesFromAttack,
    checkDeleteOverrideMod,
    getEnergyModsFromAttack,
    getStatModsFromAttack,
    formatStatModsForClientDescription,
    applyStatModToState,
    decrementHackDurations,
    decrementOverrideDurations,
    formatHacksForClient,
    formatOverridesForClient,
    buildTargetUpdatesForClient,
};
