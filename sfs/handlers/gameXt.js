/**
 * gameXt extension handler ? lobby management + full combat resolution.
 * Ported from Python: smartfox/handlers/ext_handler.py (game section).
 *
 * Lobby commands (createQuickBattle, inviteUser, replyInvitation, setReady, etc.) are
 * kept from the original NodeJS implementation. Combat resolution (setAttackInfo, endRound)
 * is a faithful port of the Python battle engine.
 */

const state = require('../../state');
const { sendMessageToUser, broadcastToBattle } = require('../../battle');
const user = require('../../user');
const virmonData = require('../../game/virmonData');
const battleLogic = require('../../game/battle');
const { users, battleRooms } = state;
const { saveUserData } = user;

// ============================================================================
// Constants
// ============================================================================

const SENSEI_IDS = new Set(['-5', '-4', '-3', '-2', '-1', -5, -4, -3, -2, -1]);

const SENSEI_DEFAULT_SWARMS = {
    '-5': [24],
    '-4': [3, 35, 50, 39],
    '-3': [11, 24, 6],
    '-2': [30, 44],
    '-1': [19, 39],
};

// Attack action types (client BattleController.handlePerformAttack)
const ATTACK_TYPE_NONE = 0;
const ATTACK_TYPE_PASS = 1;
const ATTACK_TYPE_FIZZLE = 4;
const ATTACK_TYPE_TARGET_DEAD = 5;
const ATTACK_TYPE_DODGED = 8;

// Swap action types
const SWAP_TYPE_SWAP = 0;
const SWAP_TYPE_BLOCK_SWAP = 1;
const SWAP_TYPE_NO_SWAP = 2;

// Energy
const STARTING_ENERGY = 2;
const ENERGY_GENERATOR = 2;

// Timing
const SET_ROUND_INFO_DELAY_MS = 700;
const PERFORM_ATTACK_DELAY_MS = 500;
const REPLACEMENT_DELAY_MS = 400;

// Matchmaking queue: `${totalPlayers}:${gameSwarmValue}` -> battleName
const _quickBattleQueue = {};

// ============================================================================
// Helpers
// ============================================================================

function isSenseiBattle(b) {
    return b && b.players && b.players.some(p => SENSEI_IDS.has(p.id));
}

function clientUserRefId(b, p) {
    if (!p) return '';
    if (isSenseiBattle(b) && !SENSEI_IDS.has(p.id)) return '0';
    return String(p.id);
}

function playersForClient(b) {
    if (!b || !b.players) return [];
    const hasSensei = b.players.some(p => SENSEI_IDS.has(p.id));
    const list = b.players.map(p => ({
        username: p.name,
        userRefId: clientUserRefId(b, p),
        selectedSwarmIds: Array.isArray(p.nanovorSwarm) ? p.nanovorSwarm : [],
    }));
    if (hasSensei && list.length === 2) list.sort((a, b2) => Number(b2.userRefId) - Number(a.userRefId));
    return list;
}

function ensureDefaultSwarmForPlayer(b, playerIndex) {
    if (!b || !b.players || playerIndex < 0 || playerIndex >= b.players.length) return;
    const p = b.players[playerIndex];
    if (p.nanovorSwarm && p.nanovorSwarm.length > 0) return;
    const senseiId = String(p.id);
    if (SENSEI_DEFAULT_SWARMS[senseiId]) {
        p.nanovorSwarm = SENSEI_DEFAULT_SWARMS[senseiId].slice();
        return;
    }
    const u = users[p.id];
    if (!u || !u.nanovorInventory || !u.nanovorInventory.length) return;
    const limit = Math.min(2, u.nanovorInventory.length);
    p.nanovorSwarm = u.nanovorInventory.slice(0, limit).map(n => Number(n.id)).filter(n => !isNaN(n));
}

/** Build SFS extension message string. */
function _xt(json) {
    return `<msg t="xt"><body action="xtRes" r="-1"><![CDATA[${JSON.stringify(json)}]]></body></msg>\x00`;
}

/** Send JSON extension message to a specific socket. */
function _sendTo(socket, json) {
    try { socket.write(_xt(json)); } catch (e) { /* ignore dead socket */ }
}

/** Find all sockets in a battle by battleName. */
function _battleSockets(battleName) {
    const allSockets = [];
    const sockets = state.socketMap || {};
    for (const id in sockets) {
        if (sockets[id] && sockets[id].activeBattle === battleName) allSockets.push(sockets[id]);
    }
    return allSockets;
}

/** Username -> userRefId in battle. */
function _usernameToUserRef(b, username) {
    if (!b || !b.players || !username) return null;
    for (const p of b.players) {
        if (p.name === username) return String(p.id);
    }
    return null;
}

/** Look up nanovor from user's inventory by instance id. */
function _getNanovorFromInventory(accountId, nanovorId) {
    const nid = String(nanovorId);
    const u = users[accountId];
    if (!u || !u.nanovorInventory) return null;
    const nano = u.nanovorInventory.find(n => String(n.id) === nid);
    if (!nano) return null;
    const v = virmonData.getVirmon ? virmonData.getVirmon(nano.asset_type_id || nano.assetTypeId) : null;
    return {
        instanceId: String(nano.id),
        assetTypeId: parseInt(nano.asset_type_id || nano.assetTypeId || 1, 10),
        nickname: String(nano.nickname || ''),
        speed: parseInt(v ? v.speed : (nano.speed || 10), 10),
        strength: parseInt(v ? v.strength : (nano.strength || 100), 10),
        armor: parseInt(v ? v.armor : (nano.armor || 0), 10),
        health: parseInt(v ? v.health : (nano.health || 100), 10),
    };
}

/** Get nanovor state from roundState, bench, or teamState. */
function _getNanovorStateForPlayer(b, refStr, nid) {
    nid = String(nid).trim();
    if (!nid) return {};
    const roundState = b.roundState || {};
    const current = roundState[refStr] || {};
    if (String(current.instanceId || '').trim() === nid) return current;
    const bench = (b.nanovorBench || {})[refStr] || {};
    if (bench[nid]) return bench[nid];
    const teamState = (b.teamState || {})[refStr] || {};
    return teamState[nid] || {};
}

// ============================================================================
// Round Info Helpers
// ============================================================================

function _minimalSetRoundInfoPlayers(players) {
    return players.map(p => {
        const nano = p.selectedNanovor || {};
        return {
            userRefId: parseInt(p.userRefId || 0, 10),
            selectedNanovor: {
                instanceId: String(nano.instanceId || ''),
                assetTypeId: parseInt(nano.assetTypeId || 0, 10),
                nickname: String(nano.nickname || ''),
                speed: parseInt(nano.speed || 0, 10),
                strength: parseInt(nano.strength || 0, 10),
                armor: parseInt(nano.armor || 0, 10),
                health: parseInt(nano.health || 0, 10),
            },
        };
    });
}

function _computeTurnOrderUids(players) {
    const arr = players.map(p => ({
        uid: parseInt(p.userRefId || 0, 10),
        speed: parseInt((p.selectedNanovor || {}).speed || 0, 10),
    }));
    arr.sort((a, b) => b.speed - a.speed || (Math.random() - 0.5));
    return arr.map(x => x.uid);
}

function _orderPlayersByTurnOrder(players, orderedUids) {
    const idx = {};
    orderedUids.forEach((uid, i) => { idx[uid] = i; });
    return players.slice().sort((a, b) => (idx[parseInt(a.userRefId || 0, 10)] || 999) - (idx[parseInt(b.userRefId || 0, 10)] || 999));
}

// ============================================================================
// Build Round Info from Attack Choices (round 1)
// ============================================================================

function _buildRoundInfoFromAttackChoices(b) {
    const attackChoices = b.attackChoices || {};
    const players = b.players || [];
    if (Object.keys(attackChoices).length < players.length || players.length < 2) return false;

    const roundPlayers = [];
    for (const p of players) {
        const pUid = String(p.id || p.userRefId || '');
        const choice = attackChoices[pUid];
        if (!choice) return false;
        const nanovorId = parseInt(choice.nanovorId || 0, 10);
        if (nanovorId <= 0) return false;

        let selectedNanovor = _getNanovorFromInventory(pUid, nanovorId);
        if (!selectedNanovor) {
            const team = (b.teamState || {})[pUid] || {};
            const teamNano = team[String(nanovorId)];
            if (teamNano) {
                selectedNanovor = Object.assign({}, teamNano);
            } else {
                selectedNanovor = {
                    instanceId: String(nanovorId),
                    assetTypeId: 1,
                    nickname: '',
                    speed: 10,
                    strength: 100,
                    armor: 0,
                    health: 100,
                };
            }
        }
        roundPlayers.push({
            userRefId: parseInt(pUid, 10) || 0,
            selectedNanovor,
            energyLevel: STARTING_ENERGY,
            energyGenerator: ENERGY_GENERATOR,
            moddedEnergyGenerator: ENERGY_GENERATOR,
            overrideIds: '',
        });
    }
    if (roundPlayers.length < 2) return false;

    b.roundInfoPayload = { _cmd: 'setRoundInfo', players: roundPlayers };
    b.roundState = {};
    b.playerEnergy = {};
    b.nanovorHacks = {};
    b.playerOverrides = {};
    b.nanovorBench = {};
    for (const pp of roundPlayers) {
        const ref = String(pp.userRefId);
        const nano = pp.selectedNanovor;
        b.roundState[ref] = Object.assign({}, nano);
        b.playerEnergy[ref] = {
            energyLevel: STARTING_ENERGY,
            energyGenerator: ENERGY_GENERATOR,
            moddedEnergyGenerator: ENERGY_GENERATOR,
        };
        b.nanovorBench[ref] = {};
        const instanceId = String(nano.instanceId || ref);
        b.nanovorHacks[instanceId] = [];
        b.playerOverrides[ref] = [];
    }
    b.roundInfoSentTo = new Set();
    return true;
}

// ============================================================================
// Core Combat Resolution
// ============================================================================

function _resolveRoundAttacks(battleName) {
    const b = battleRooms[battleName];
    if (!b || !b.roundInfoPayload) return;
    const playersPayload = b.roundInfoPayload.players || [];
    if (playersPayload.length < 2) return;

    // Ensure state structures exist
    let roundState = b.roundState;
    if (!roundState) {
        roundState = {};
        for (const pp of playersPayload) {
            const ref = String(parseInt(pp.userRefId || 0, 10));
            roundState[ref] = Object.assign({}, pp.selectedNanovor || {});
        }
        b.roundState = roundState;
    }
    for (const pp of playersPayload) {
        const ref = String(parseInt(pp.userRefId || 0, 10));
        if (!b.nanovorBench) b.nanovorBench = {};
        if (!b.nanovorBench[ref]) b.nanovorBench[ref] = {};
    }
    let playerEnergy = b.playerEnergy;
    if (!playerEnergy || !Object.keys(playerEnergy).length) {
        playerEnergy = {};
        for (const pp of playersPayload) {
            const ref = String(parseInt(pp.userRefId || 0, 10));
            playerEnergy[ref] = { energyLevel: STARTING_ENERGY, energyGenerator: ENERGY_GENERATOR, moddedEnergyGenerator: ENERGY_GENERATOR };
        }
        b.playerEnergy = playerEnergy;
    }
    let nanovorHacks = b.nanovorHacks || {};
    b.nanovorHacks = nanovorHacks;
    let playerOverrides = b.playerOverrides || {};
    b.playerOverrides = playerOverrides;

    const attackChoices = b.attackChoices || {};
    if (Object.keys(attackChoices).length < 2) return;

    // Build turn order by modded speed
    const turnOrder = [];
    for (const [uidStr, choice] of Object.entries(attackChoices)) {
        const uidInt = parseInt(uidStr, 10);
        const st = roundState[uidStr] || {};
        const instanceId = String(st.instanceId || '');
        const hacks = nanovorHacks[instanceId] || [];
        const overrides = playerOverrides[uidStr] || [];
        const moddedSpeed = battleLogic.getModdedSpeed(st, hacks, overrides);
        turnOrder.push({ uid: uidInt, speed: moddedSpeed, choice });
    }

    // Use precomputed order if available (from endRound path)
    let orderedUids;
    const turnOrderUidSet = new Set(turnOrder.map(t => t.uid));
    if (b.turn_order_uids && new Set(b.turn_order_uids).size === turnOrderUidSet.size) {
        let match = true;
        for (const uid of b.turn_order_uids) if (!turnOrderUidSet.has(uid)) { match = false; break; }
        orderedUids = match ? b.turn_order_uids : null;
    }
    if (!orderedUids) {
        turnOrder.sort((a, b2) => b2.speed - a.speed || (Math.random() - 0.5));
        orderedUids = turnOrder.map(t => t.uid);
        b.turn_order_uids = orderedUids;
    }
    const uidToTriple = {};
    for (const t of turnOrder) uidToTriple[t.uid] = t;
    const sortedTurnOrder = orderedUids.map(uid => uidToTriple[uid]).filter(Boolean);

    const attackResults = [];
    const swapRequests = {};
    const replacementOnlyUids = new Set();
    let hadDeathThisRound = false;

    // Replacement-after-death: swap dead nanovor BEFORE processing attacks
    for (const [uidStr, choice] of Object.entries(attackChoices)) {
        const ref = parseInt(uidStr, 10);
        const attState = roundState[uidStr] || {};
        const attInstanceId = String(attState.instanceId || '');
        const attHealth = parseInt(attState.health || 0, 10);
        if (attHealth > 0) continue;

        const attackerNanovorId = String(choice.nanovorId || '');
        const swapNanovorIdChoice = String(choice.swapNanovorId || '0');
        let replacementId = null;
        if (attackerNanovorId && attackerNanovorId !== attInstanceId) replacementId = attackerNanovorId;
        else if (swapNanovorIdChoice && swapNanovorIdChoice !== '0') replacementId = swapNanovorIdChoice;
        if (!replacementId) continue;

        replacementOnlyUids.add(ref);
        swapRequests[ref] = replacementId;
        if (!b.nanovorBench) b.nanovorBench = {};
        if (!b.nanovorBench[uidStr]) b.nanovorBench[uidStr] = {};
        b.nanovorBench[uidStr][attInstanceId] = Object.assign({}, attState);

        const benched = (b.nanovorBench[uidStr] || {})[replacementId];
        if (benched) {
            roundState[uidStr] = Object.assign({}, benched);
            if (!nanovorHacks[replacementId]) nanovorHacks[replacementId] = [];
        } else {
            const newNano = _getNanovorFromInventory(uidStr, parseInt(replacementId, 10));
            if (newNano) {
                roundState[uidStr] = newNano;
                nanovorHacks[String(parseInt(replacementId, 10))] = [];
            } else {
                const teamNano = ((b.teamState || {})[uidStr] || {})[replacementId];
                if (teamNano) {
                    roundState[uidStr] = Object.assign({}, teamNano);
                    nanovorHacks[replacementId] = [];
                } else {
                    delete swapRequests[ref];
                }
            }
        }
    }

    // Snapshot for setRoundInfo before damage (replacement entrance)
    const roundStateBeforeAttacks = replacementOnlyUids.size > 0
        ? Object.fromEntries(Object.entries(roundState).map(([k, v]) => [k, Object.assign({}, v)]))
        : null;

    // -------------------------------------------------------------------------
    // Process attacks in turn order
    // -------------------------------------------------------------------------
    for (const { uid: attackerUid, choice } of sortedTurnOrder) {
        const attackId = parseInt(choice.attackId || 0, 10);
        const attackerNanovorId = String(choice.nanovorId || '');
        const enemyUsername = (choice.enemyUsername || '').trim();
        const targetUidStr = _usernameToUserRef(b, enemyUsername);
        const targetUid = targetUidStr ? parseInt(targetUidStr, 10) : null;
        const swapNanovorId = String(choice.swapNanovorId || '0');

        if (swapNanovorId && swapNanovorId !== '0') swapRequests[attackerUid] = swapNanovorId;

        const attState = roundState[String(attackerUid)] || {};
        const attAssetType = parseInt(attState.assetTypeId || 1, 10);
        const attInstanceId = String(attState.instanceId || attackerNanovorId);
        const attEnergy = playerEnergy[String(attackerUid)] || {};
        const currentEnergy = attEnergy.energyLevel != null ? attEnergy.energyLevel : STARTING_ENERGY;
        const attHacks = nanovorHacks[attInstanceId] || [];
        const attackActions = [];
        const attOverridesList = playerOverrides[String(attackerUid)] || [];
        const attackerSelfUpdates = battleLogic.buildTargetUpdatesForClient(
            attState, attEnergy, attOverridesList, attHacks, [], battleLogic.isSwapBlocked
        );

        const attHealth = parseInt(attState.health || 0, 10);
        if (attHealth <= 0) {
            let replacementIdDead = null;
            if (attackerNanovorId && attackerNanovorId !== attInstanceId) replacementIdDead = attackerNanovorId;
            else if (swapNanovorId && swapNanovorId !== '0') replacementIdDead = swapNanovorId;
            if (replacementIdDead) swapRequests[attackerUid] = replacementIdDead;
            hadDeathThisRound = true;
            continue;
        }

        const attackerStunned = battleLogic.isStunned(attHacks);
        if (attackerStunned && attackId !== 0) {
            attackActions.push({
                targetUserRefId: attackerUid,
                targetNanovorId: attInstanceId,
                targetNanovorAssetTypeId: attAssetType,
                attackStatementId: 0,
                type: ATTACK_TYPE_PASS,
                statementClientDescription: 'Stunned!',
                totalDamage: 0,
                targetUpdates: attackerSelfUpdates,
            });
        } else if (attackId === 0 || targetUid == null) {
            attackActions.push({
                targetUserRefId: attackerUid,
                targetNanovorId: attInstanceId,
                targetNanovorAssetTypeId: attAssetType,
                attackStatementId: 0,
                type: ATTACK_TYPE_PASS,
                statementClientDescription: 'Pass',
                totalDamage: 0,
                targetUpdates: attackerSelfUpdates,
            });
        } else {
            // Real attack
            const attackCost = virmonData.getAttackCost(attAssetType, attackId);
            if (currentEnergy < attackCost) {
                attackActions.push({
                    targetUserRefId: attackerUid,
                    targetNanovorId: attInstanceId,
                    targetNanovorAssetTypeId: attAssetType,
                    attackStatementId: 0,
                    type: ATTACK_TYPE_FIZZLE,
                    statementClientDescription: 'Not enough energy!',
                    totalDamage: 0,
                    targetUpdates: attackerSelfUpdates,
                });
            } else {
                attEnergy.energyLevel = currentEnergy - attackCost;

                const tgtState = roundState[String(targetUid)] || {};
                const tgtNanovorId = String(tgtState.instanceId || '');
                const tgtAssetType = parseInt(tgtState.assetTypeId || 1, 10);
                const tgtHacks = nanovorHacks[tgtNanovorId] || [];
                const attOverrides = playerOverrides[String(attackerUid)] || [];
                const tgtOverrides = playerOverrides[String(targetUid)] || [];

                const { statementId, totalDamage, clientDesc, wasDodged, isHealthDamage } = battleLogic.resolveAttackDamage(
                    Object.assign({}, attState), tgtState, attAssetType, attackId,
                    attHacks, attOverrides, tgtHacks, tgtOverrides
                );

                battleLogic.applySelfDamageFromAttack(attState, attAssetType, attackId, attHacks, attOverrides);

                if (wasDodged) {
                    const tgtEnergy = playerEnergy[String(targetUid)] || {};
                    const targetUpdates = battleLogic.buildTargetUpdatesForClient(
                        tgtState, tgtEnergy, tgtOverrides, tgtHacks, attOverrides, battleLogic.isSwapBlocked
                    );
                    attackActions.push({
                        targetUserRefId: targetUid,
                        targetNanovorId: tgtNanovorId,
                        targetNanovorAssetTypeId: tgtAssetType,
                        attackStatementId: 0,
                        type: ATTACK_TYPE_DODGED,
                        statementClientDescription: 'Dodged!',
                        totalDamage: 0,
                        targetUpdates,
                    });
                } else {
                    if (isHealthDamage) {
                        const newHealth = parseInt(tgtState.health || 0, 10);
                        if (newHealth <= 0) hadDeathThisRound = true;
                        attackActions.push({
                            targetUserRefId: targetUid,
                            targetNanovorId: tgtNanovorId,
                            targetNanovorAssetTypeId: tgtAssetType,
                            attackStatementId: statementId,
                            type: ATTACK_TYPE_NONE,
                            statementClientDescription: clientDesc,
                            totalDamage,
                            value: newHealth,
                            targetUpdates: null,
                        });
                    }
                }

                // Apply hacks
                const { newAttackerHacks, newTargetHacks } = battleLogic.applyHacksFromAttack(
                    attState, tgtState, attHacks, tgtHacks, attAssetType, attackId, attOverrides
                );
                if (newAttackerHacks.length) {
                    if (!nanovorHacks[attInstanceId]) nanovorHacks[attInstanceId] = [];
                    nanovorHacks[attInstanceId].push(...newAttackerHacks);
                }
                if (newTargetHacks.length) {
                    if (!nanovorHacks[tgtNanovorId]) nanovorHacks[tgtNanovorId] = [];
                    nanovorHacks[tgtNanovorId].push(...newTargetHacks);
                }

                // Delete Override Mod
                const { removesOwn, removesEnemy, clearStatementId } = battleLogic.checkDeleteOverrideMod(attAssetType, attackId, attOverrides);
                if (removesOwn) playerOverrides[String(attackerUid)] = [];
                if (removesEnemy) playerOverrides[String(targetUid)] = [];

                // Apply overrides
                const curAttOverrides = playerOverrides[String(attackerUid)] || [];
                const curTgtOverrides = playerOverrides[String(targetUid)] || [];
                const { newAttackerOverrides, newTargetOverrides, clearAttacker, clearTarget } = battleLogic.applyOverridesFromAttack(
                    String(attackerUid), String(targetUid), curAttOverrides, curTgtOverrides, attAssetType, attackId
                );
                if (clearAttacker && newAttackerOverrides.length) playerOverrides[String(attackerUid)] = newAttackerOverrides;
                else if (newAttackerOverrides.length) {
                    if (!playerOverrides[String(attackerUid)]) playerOverrides[String(attackerUid)] = [];
                    playerOverrides[String(attackerUid)].push(...newAttackerOverrides);
                }
                if (clearTarget && newTargetOverrides.length) playerOverrides[String(targetUid)] = newTargetOverrides;
                else if (newTargetOverrides.length) {
                    if (!playerOverrides[String(targetUid)]) playerOverrides[String(targetUid)] = [];
                    playerOverrides[String(targetUid)].push(...newTargetOverrides);
                }

                // Mod-only attacks: targetUpdates for enemy override removal
                if (!wasDodged && !isHealthDamage && removesEnemy) {
                    const tgtEnergyAfter = playerEnergy[String(targetUid)] || {};
                    const tgtOverridesAfter = playerOverrides[String(targetUid)] || [];
                    const tgtHacksAfter = nanovorHacks[tgtNanovorId] || [];
                    const targetUpdates = battleLogic.buildTargetUpdatesForClient(
                        tgtState, tgtEnergyAfter, tgtOverridesAfter, tgtHacksAfter, attOverrides, battleLogic.isSwapBlocked
                    );
                    attackActions.push({
                        targetUserRefId: targetUid,
                        targetNanovorId: tgtNanovorId,
                        targetNanovorAssetTypeId: tgtAssetType,
                        attackStatementId: clearStatementId || 0,
                        type: ATTACK_TYPE_NONE,
                        statementClientDescription: 'Override removed',
                        totalDamage: 0,
                        targetUpdates,
                    });
                }

                const attackerGainedOverrides = !!newAttackerOverrides.length;

                // Energy mods
                const { attackerChange: attEnergyChange, targetChange: tgtEnergyChange } = battleLogic.getEnergyModsFromAttack(attAssetType, attackId, attOverrides);
                if (attEnergyChange !== 0) attEnergy.energyLevel = Math.max(0, (attEnergy.energyLevel || 0) + attEnergyChange);
                if (tgtEnergyChange !== 0) {
                    const tgtEnergyDict = playerEnergy[String(targetUid)] || {};
                    tgtEnergyDict.energyLevel = Math.max(0, (tgtEnergyDict.energyLevel || 0) + tgtEnergyChange);
                }

                // Stat mods
                const statMods = battleLogic.getStatModsFromAttack(attAssetType, attackId, attOverrides);
                for (const mod of statMods) {
                    const targetType = mod.target;
                    if (targetType === 'Enemy active Virmon' || targetType === 'Enemy team')
                        battleLogic.applyStatModToState(tgtState, mod.stat, mod.verb, mod.value);
                    else if (targetType === 'My active Virmon' || targetType === 'My team')
                        battleLogic.applyStatModToState(attState, mod.stat, mod.verb, mod.value);
                    else if (targetType === 'All active Virmon' || targetType === 'All teams') {
                        battleLogic.applyStatModToState(attState, mod.stat, mod.verb, mod.value);
                        battleLogic.applyStatModToState(tgtState, mod.stat, mod.verb, mod.value);
                    }
                }

                if (statMods.length && attackActions.length) {
                    const modDesc = battleLogic.formatStatModsForClientDescription(statMods, true) + battleLogic.formatStatModsForClientDescription(statMods, false);
                    if (modDesc) {
                        attackActions[attackActions.length - 1].statementClientDescription = (attackActions[attackActions.length - 1].statementClientDescription || '') + modDesc;
                    }
                }

                // Per-stat-mod actions for enemy
                for (const mod of statMods) {
                    if (mod.stat === 'Health') continue;
                    if (mod.target !== 'Enemy active Virmon' && mod.target !== 'Enemy team') continue;
                    const stId = mod.statement_id || 0;
                    if (!stId) continue;
                    const statKey = battleLogic.STAT_MAP[mod.stat] || mod.stat.toLowerCase();
                    const newStatValue = parseInt(tgtState[statKey] || 0, 10);
                    const magnitude = Math.abs(Math.round(mod.value || 0));
                    if (!magnitude) continue;
                    attackActions.push({
                        targetUserRefId: targetUid,
                        targetNanovorId: tgtNanovorId,
                        targetNanovorAssetTypeId: tgtAssetType,
                        attackStatementId: stId,
                        type: ATTACK_TYPE_NONE,
                        statementClientDescription: '',
                        totalDamage: magnitude,
                        value: newStatValue,
                        targetUpdates: null,
                    });
                }

                // Final targetUpdates for target
                const tgtEnergyFinal = playerEnergy[String(targetUid)] || {};
                const tgtOverridesFinal = playerOverrides[String(targetUid)] || [];
                const tgtHacksFinal = nanovorHacks[tgtNanovorId] || [];
                const attOverridesFinal = playerOverrides[String(attackerUid)] || [];
                const targetUpdates = battleLogic.buildTargetUpdatesForClient(
                    tgtState, tgtEnergyFinal, tgtOverridesFinal, tgtHacksFinal, attOverridesFinal, battleLogic.isSwapBlocked
                );
                if (attackActions.length) {
                    attackActions[attackActions.length - 1].targetUpdates = targetUpdates;
                    for (const act of attackActions) {
                        if (act.targetUpdates == null && act.targetUserRefId === targetUid) act.targetUpdates = targetUpdates;
                    }
                }

                // Self-update for attacker override state change
                if (removesOwn || attackerGainedOverrides) {
                    const attEnergyAfter = playerEnergy[String(attackerUid)] || {};
                    const attHacksAfter = nanovorHacks[attInstanceId] || [];
                    const attOverridesAfterSelf = playerOverrides[String(attackerUid)] || [];
                    const attackerUpdates = battleLogic.buildTargetUpdatesForClient(
                        attState, attEnergyAfter, attOverridesAfterSelf, attHacksAfter, [], battleLogic.isSwapBlocked
                    );
                    let stIdSelf = 0;
                    if (removesOwn) {
                        stIdSelf = clearStatementId;
                        if (!stIdSelf) {
                            const sts = virmonData.getAttackStatements(attAssetType, attackId);
                            stIdSelf = sts.length ? parseInt(sts[0].statement_id || 0, 10) : 0;
                        }
                    } else {
                        stIdSelf = newAttackerOverrides.length ? parseInt(newAttackerOverrides[0].statement_id || 0, 10) : 0;
                        if (!stIdSelf) {
                            const sts = virmonData.getAttackStatements(attAssetType, attackId);
                            stIdSelf = sts.length ? parseInt(sts[0].statement_id || 0, 10) : 0;
                        }
                    }
                    attackActions.push({
                        targetUserRefId: attackerUid,
                        targetNanovorId: attInstanceId,
                        targetNanovorAssetTypeId: attAssetType,
                        attackStatementId: stIdSelf,
                        type: ATTACK_TYPE_NONE,
                        statementClientDescription: '',
                        totalDamage: 0,
                        value: parseInt(attState.health || 0, 10),
                        targetUpdates: attackerUpdates,
                    });
                } else if (battleLogic.attackHasSelfDamage(attAssetType, attackId)) {
                    const attEnergyAfter = playerEnergy[String(attackerUid)] || {};
                    const attHacksAfter = nanovorHacks[attInstanceId] || [];
                    const attOverridesAfterSelf = playerOverrides[String(attackerUid)] || [];
                    const attackerUpdates = battleLogic.buildTargetUpdatesForClient(
                        attState, attEnergyAfter, attOverridesAfterSelf, attHacksAfter, [], battleLogic.isSwapBlocked
                    );
                    attackActions.push({
                        targetUserRefId: attackerUid,
                        targetNanovorId: attInstanceId,
                        targetNanovorAssetTypeId: attAssetType,
                        attackStatementId: 0,
                        type: ATTACK_TYPE_NONE,
                        statementClientDescription: '',
                        totalDamage: 0,
                        value: parseInt(attState.health || 0, 10),
                        targetUpdates: attackerUpdates,
                    });
                }
            }
        }

        attackResults.push({
            attackerId: attackerUid,
            attackerNanovorId: attInstanceId,
            attackerNanovorAssetId: attAssetType,
            attackId,
            attackActions,
        });
    }

    // -------------------------------------------------------------------------
    // Process swaps
    // -------------------------------------------------------------------------
    const swapActions = [];
    for (const pp of playersPayload) {
        const ref = parseInt(pp.userRefId || 0, 10);
        const currentState = roundState[String(ref)] || {};
        const currentInstanceId = String(currentState.instanceId || '');
        const currentHacks = nanovorHacks[currentInstanceId] || [];
        const swapNanovorId = swapRequests[ref];

        if (swapNanovorId) {
            if (replacementOnlyUids.has(ref)) {
                swapActions.push({ userRefId: ref, type: SWAP_TYPE_NO_SWAP });
            } else if (String(swapNanovorId) === currentInstanceId) {
                swapActions.push({ userRefId: ref, type: SWAP_TYPE_NO_SWAP });
            } else if (battleLogic.isSwapBlocked(currentHacks)) {
                swapActions.push({ userRefId: ref, type: SWAP_TYPE_BLOCK_SWAP });
            } else {
                swapActions.push({ userRefId: ref, type: SWAP_TYPE_SWAP, instanceId: swapNanovorId, assetTypeId: 0 });
                if (!b.nanovorBench) b.nanovorBench = {};
                if (!b.nanovorBench[String(ref)]) b.nanovorBench[String(ref)] = {};
                b.nanovorBench[String(ref)][currentInstanceId] = Object.assign({}, currentState);

                const benched = (b.nanovorBench[String(ref)] || {})[swapNanovorId];
                if (benched) {
                    const newNano = Object.assign({}, benched);
                    swapActions[swapActions.length - 1].assetTypeId = parseInt(newNano.assetTypeId || 0, 10);
                    roundState[String(ref)] = newNano;
                    if (!nanovorHacks[swapNanovorId]) nanovorHacks[swapNanovorId] = [];
                } else {
                    const newNanoFromInv = _getNanovorFromInventory(String(ref), parseInt(swapNanovorId, 10));
                    if (newNanoFromInv) {
                        roundState[String(ref)] = newNanoFromInv;
                        swapActions[swapActions.length - 1].assetTypeId = newNanoFromInv.assetTypeId;
                        nanovorHacks[String(parseInt(swapNanovorId, 10))] = [];
                    } else {
                        const teamNano = ((b.teamState || {})[String(ref)] || {})[swapNanovorId];
                        if (teamNano) {
                            roundState[String(ref)] = Object.assign({}, teamNano);
                            swapActions[swapActions.length - 1].assetTypeId = parseInt(teamNano.assetTypeId || 0, 10);
                            nanovorHacks[swapNanovorId] = [];
                        }
                    }
                }
            }
        } else {
            swapActions.push({ userRefId: ref, type: SWAP_TYPE_NO_SWAP });
        }
    }

    // -------------------------------------------------------------------------
    // Hack/override duration decrement
    // -------------------------------------------------------------------------
    for (const instanceId of Object.keys(nanovorHacks)) {
        nanovorHacks[instanceId] = battleLogic.decrementHackDurations(nanovorHacks[instanceId]);
    }
    for (const uidStr of Object.keys(playerOverrides)) {
        playerOverrides[uidStr] = battleLogic.decrementOverrideDurations(playerOverrides[uidStr]);
    }

    // -------------------------------------------------------------------------
    // Energy regeneration
    // -------------------------------------------------------------------------
    for (const pp of playersPayload) {
        const ref = String(parseInt(pp.userRefId || 0, 10));
        const energy = playerEnergy[ref] || {};
        const generator = energy.moddedEnergyGenerator != null ? energy.moddedEnergyGenerator : ENERGY_GENERATOR;
        energy.energyLevel = (energy.energyLevel || 0) + generator;
    }

    // -------------------------------------------------------------------------
    // Build round results players
    // -------------------------------------------------------------------------
    const roundInfoPlayers = (b.roundInfoPayload || {}).players || [];
    const roundResultsPlayers = [];
    for (const pp of playersPayload) {
        const ref = parseInt(pp.userRefId || 0, 10);
        let st = roundState[String(ref)] || {};
        if (!st || !String(st.instanceId || '').trim()) {
            for (const rp of roundInfoPlayers) {
                if (parseInt(rp.userRefId || -1, 10) === ref) {
                    st = Object.assign({}, rp.selectedNanovor || {});
                    break;
                }
            }
        }
        if (!String(st.instanceId || '').trim()) {
            st = { instanceId: '0', assetTypeId: 0, nickname: '', speed: 0, strength: 0, armor: 0, health: 0 };
        }
        const energy = playerEnergy[String(ref)] || {};
        const instanceId = String(st.instanceId || '');
        const hacks = nanovorHacks[instanceId] || [];
        const overrides = playerOverrides[String(ref)] || [];

        const selectedNano = Object.assign({}, st);
        selectedNano.hacks = battleLogic.formatHacksForClient(hacks);

        const overrideIdsStr = battleLogic.formatOverridesForClient(overrides);
        roundResultsPlayers.push({
            userRefId: ref,
            energyLevel: energy.energyLevel || 0,
            energyGenerator: energy.energyGenerator || ENERGY_GENERATOR,
            moddedEnergyGenerator: energy.moddedEnergyGenerator || ENERGY_GENERATOR,
            swapPercentage: battleLogic.isSwapBlocked(hacks) ? 0 : 100,
            moddedSwapPercentage: battleLogic.isSwapBlocked(hacks) ? 0 : 100,
            overrideIds: overrideIdsStr || null,
            selectedNanovor: selectedNano,
        });
    }

    // -------------------------------------------------------------------------
    // Ensure no null targetUpdates (client crashes)
    // -------------------------------------------------------------------------
    for (const ar of attackResults) {
        const actions = ar.attackActions || [];
        let fallbackTu = null;
        for (const act of actions) { if (act.targetUpdates != null) { fallbackTu = act.targetUpdates; break; } }
        for (const act of actions) { if (act.targetUpdates == null && fallbackTu != null) act.targetUpdates = fallbackTu; }
    }

    const performPayload = { _cmd: 'performAttack', attackResults };
    const battleSockets = _battleSockets(battleName);

    // -------------------------------------------------------------------------
    // Send messages with delays via setTimeout chain
    // -------------------------------------------------------------------------
    let delay = 0;

    if (replacementOnlyUids.size > 0 && roundStateBeforeAttacks) {
        const roundNum = b.round || 1;
        const minimalRoundPlayers = [];
        for (const pp of roundInfoPlayers) {
            const ref = parseInt(pp.userRefId || 0, 10);
            const st = roundStateBeforeAttacks[String(ref)] || roundState[String(ref)] || {};
            minimalRoundPlayers.push({ userRefId: ref, selectedNanovor: Object.assign({}, st) });
        }
        const minimal = _minimalSetRoundInfoPlayers(minimalRoundPlayers);
        const ordered = _orderPlayersByTurnOrder(minimal, orderedUids);
        const setRoundMsg = { _cmd: 'setRoundInfo', players: ordered, round: roundNum };
        for (const s of battleSockets) _sendTo(s, setRoundMsg);
        delay += REPLACEMENT_DELAY_MS;
    }

    setTimeout(() => {
        for (const s of battleSockets) _sendTo(s, performPayload);
        setTimeout(() => {
            for (const s of battleSockets) {
                const cUid = parseInt(s.userId || s.playerId || 0, 10);
                const orderedPlayers = roundResultsPlayers.slice().sort((a, b2) => a.userRefId === cUid ? -1 : b2.userRefId === cUid ? 1 : 0);
                _sendTo(s, {
                    _cmd: 'roundCompleted',
                    swapActions,
                    players: orderedPlayers,
                    attackResults,
                });
            }
        }, PERFORM_ATTACK_DELAY_MS);
    }, delay);

    // -------------------------------------------------------------------------
    // Update state for next round
    // -------------------------------------------------------------------------
    b.attackChoices = {};
    for (const pp of (b.roundInfoPayload || {}).players || []) {
        const ref = String(pp.userRefId || 0);
        if (roundState[ref]) pp.selectedNanovor = Object.assign({}, roundState[ref]);
    }
    b.roundState = roundState;
    b.sendSetRoundInfoBeforeNextResolve = !!(replacementOnlyUids.size || hadDeathThisRound);

    // -------------------------------------------------------------------------
    // Game over detection
    // -------------------------------------------------------------------------
    let loserRef = null;
    const swarmIds = b.swarmIds || {};
    for (const pp of playersPayload) {
        const ref = parseInt(pp.userRefId || 0, 10);
        if (swapRequests[ref]) continue;
        const team = (swarmIds[String(ref)] || swarmIds[ref] || []).map(String);
        if (!team.length) continue;
        let allDead = true;
        for (const nid of team) {
            const s = _getNanovorStateForPlayer(b, String(ref), nid);
            if (parseInt(s.health || 0, 10) > 0) { allDead = false; break; }
        }
        if (allDead) { loserRef = ref; break; }
    }

    if (loserRef != null) {
        const winnerRef = playersPayload.map(pp => parseInt(pp.userRefId || 0, 10)).find(r => r !== loserRef);
        if (winnerRef != null) {
            const results = playersPayload.map(pp => {
                const ref = parseInt(pp.userRefId || 0, 10);
                return {
                    userRefId: ref,
                    position: ref === winnerRef ? 1 : 2,
                    totalDamage: 0,
                    totalNanovorKilled: 0,
                    nmpDiff: 0,
                };
            });
            b.gameOver = { winnerId: winnerRef, results };

            if (users[winnerRef]) {
                users[winnerRef].nanocash = (users[winnerRef].nanocash || 0) + 50;
                saveUserData(winnerRef);
            }
            if (users[loserRef]) {
                users[loserRef].nanocash = (users[loserRef].nanocash || 0) + 25;
                saveUserData(loserRef);
            }

            const totalDelay = delay + PERFORM_ATTACK_DELAY_MS + 100;
            setTimeout(() => {
                const goMsg = { _cmd: 'gameOver', winnerId: winnerRef, results };
                for (const s of battleSockets) _sendTo(s, goMsg);
                for (const s of battleSockets) s.activeBattle = null;
                delete battleRooms[battleName];
                for (const [key, val] of Object.entries(_quickBattleQueue)) {
                    if (val === battleName) { delete _quickBattleQueue[key]; break; }
                }
            }, totalDelay);
        }
    }
}

// ============================================================================
// Main Handler
// ============================================================================

function handleGameXtCommand(socket, command, params) {
    if (socket.playerId == null && socket.userId != null) socket.playerId = socket.userId;

    let response = '';

    switch (command) {
        case 'createQuickBattle': {
            const gameSwarmValue = params.gameSwarmValue || 1000;
            const totalPlayers = params.totalPlayers || 2;
            const queueKey = `${totalPlayers}:${gameSwarmValue}`;

            const existingBattleName = _quickBattleQueue[queueKey];
            if (existingBattleName && battleRooms[existingBattleName]) {
                const existingBattle = battleRooms[existingBattleName];
                if (existingBattle.creator !== socket.playerId && existingBattle.players.length < existingBattle.maxPlayers) {
                    delete _quickBattleQueue[queueKey];
                    existingBattle.players.push({
                        id: socket.playerId,
                        name: socket.userName,
                        ready: false,
                        nanovorSwarm: [],
                        selectedNanovor: null,
                        enemyTarget: null,
                    });
                    socket.activeBattle = existingBattleName;

                    sendMessageToUser(existingBattle.creator, _xt({
                        _cmd: 'invitationResponse',
                        battleName: existingBattleName,
                        player: { username: socket.userName, userRefId: parseInt(socket.playerId, 10), acceptedInvitation: true },
                        inviterName: existingBattle.creatorName,
                        inviterId: String(existingBattle.creator),
                    }));
                    sendMessageToUser(existingBattle.creator, _xt({
                        _cmd: 'playerJoinGame',
                        battleName: existingBattleName,
                        username: socket.userName,
                        userRefId: parseInt(socket.playerId, 10),
                        creator: false,
                    }));

                    _sendTo(socket, {
                        _cmd: 'playerJoinAutoBattle',
                        battleName: existingBattleName,
                        gameCreator: existingBattle.creatorName,
                        gameCreatorId: String(existingBattle.creator),
                        username: socket.userName,
                        userRefId: parseInt(socket.playerId, 10),
                    });
                    _sendTo(socket, {
                        _cmd: 'invitationResponse',
                        battleName: existingBattleName,
                        otherPlayers: [{
                            battleName: existingBattleName,
                            username: existingBattle.creatorName,
                            userRefId: parseInt(existingBattle.creator, 10),
                        }],
                    });

                    const ps = existingBattle.players.map(p => ({ username: p.name, userRefId: parseInt(p.id, 10) }));
                    const gsPayload = { _cmd: 'gameStarted', battleName: existingBattleName, players: ps, gameCreator: existingBattle.creatorName };
                    broadcastToBattle(existingBattleName, _xt(gsPayload));
                    return;
                }
            }

            const newBattleName = `quick_battle_${Date.now()}_${socket.userId}`;
            battleRooms[newBattleName] = {
                id: state.battleIdCounter++,
                name: newBattleName,
                gameSwarmValue,
                maxPlayers: totalPlayers,
                players: [{
                    id: socket.playerId,
                    name: socket.userName,
                    ready: false,
                    nanovorSwarm: [],
                    selectedNanovor: null,
                    enemyTarget: null,
                }],
                creator: socket.playerId,
                creatorName: socket.userName,
                gameState: 'waiting_for_players',
                turnOrder: [],
                currentTurn: 0,
                round: 1,
                battleHistory: [],
            };
            socket.activeBattle = newBattleName;
            _quickBattleQueue[queueKey] = newBattleName;
            response = _xt({ _cmd: 'gameCreated', battleName: newBattleName, gameCreator: socket.userName, convertedChatRoom: false });
            break;
        }

        case 'createGame': {
            const customSwarmValue = params.gameSwarmValue || 1000;
            const convertedChatRoom = params.convertedChatRoom || false;
            const customBattleName = `custom_battle_${Date.now()}_${socket.userId}`;
            battleRooms[customBattleName] = {
                id: state.battleIdCounter++,
                name: customBattleName,
                gameSwarmValue: customSwarmValue,
                maxPlayers: 2,
                players: [{ id: socket.playerId, name: socket.userName, ready: false, nanovorSwarm: [], selectedNanovor: null, enemyTarget: null }],
                creator: socket.playerId,
                creatorName: socket.userName,
                gameState: 'waiting_for_players',
                turnOrder: [],
                currentTurn: 0,
                round: 1,
                battleHistory: [],
            };
            socket.activeBattle = customBattleName;
            response = _xt({ _cmd: 'gameCreated', battleName: customBattleName, gameCreator: socket.userName, convertedChatRoom });
            break;
        }

        case 'inviteUser': {
            const invitee = params.buddy;
            const battleToInvite = params.battleName;
            const convertedRoom = params.convertedChatRoom || false;
            let inviteeId = null;
            for (const userId in users) {
                if (users[userId].username === invitee) { inviteeId = userId; break; }
            }
            if (inviteeId) {
                const invMsg = _xt({
                    _cmd: 'invitationRequest',
                    battleName: battleToInvite,
                    inviter: { username: socket.userName, userRefId: socket.playerId },
                    gameSwarmValue: (battleRooms[battleToInvite] || {}).gameSwarmValue || 1000,
                    convertedChatRoom: convertedRoom,
                });
                if (sendMessageToUser(inviteeId, invMsg)) {
                    response = _xt({ _cmd: 'invitationSent', battleName: battleToInvite, invitedUser: invitee });
                } else {
                    response = _xt({ _cmd: 'gameInvitationError', errorMessage: 'Player offline' });
                }
            } else {
                response = _xt({ _cmd: 'gameInvitationError', errorMessage: 'Player not found' });
            }
            break;
        }

        case 'replyInvitation': {
            const battleName = params.battleName;
            const accept = params.accept;
            const replyReason = params.replyReason || 'ACCEPTED';
            if (accept) {
                const br = battleRooms[battleName];
                if (br && br.players.length < br.maxPlayers) {
                    br.players.push({ id: socket.playerId, name: socket.userName, ready: false, nanovorSwarm: [], selectedNanovor: null, enemyTarget: null });
                    socket.activeBattle = battleName;
                    sendMessageToUser(br.creator, _xt({
                        _cmd: 'invitationResponse', battleName, player: socket.userName,
                        inviterName: br.creatorName, inviterId: br.creator,
                        otherPlayers: br.players.filter(p => p.id !== socket.playerId && p.id !== br.creator).map(p => ({ username: p.name, userRefId: p.id })),
                    }));
                    if (br.players.length === br.maxPlayers) {
                        br.gameState = 'in_progress';
                        br.turnOrder = [...br.players];
                        br.players.forEach((p, idx) => ensureDefaultSwarmForPlayer(br, idx));
                        broadcastToBattle(battleName, _xt({ _cmd: 'gameStarted', battleName, players: playersForClient(br), gameCreator: br.creatorName }));
                    }
                    response = _xt({ _cmd: 'invitationResponse', battleName, accepted: true });
                } else {
                    response = _xt({ _cmd: 'gameError' });
                }
            } else {
                const br = battleRooms[battleName];
                if (br) sendMessageToUser(br.creator, _xt({ _cmd: 'invitationResponse', battleName, accepted: false, player: socket.userName, reason: replyReason }));
                response = _xt({ _cmd: 'invitationResponse', battleName, accepted: false, reason: replyReason });
            }
            break;
        }

        case 'setSwarm': {
            const rawIds = params.nanovorIds ?? params.selectedSwarmIds ?? params.swarmIds;
            let nanovorIds = [];
            if (rawIds != null) {
                if (Array.isArray(rawIds)) {
                    nanovorIds = rawIds.map(item => (item && typeof item === 'object' && 'id' in item ? Number(item.id) : Number(item))).filter(n => !isNaN(n));
                } else {
                    nanovorIds = String(rawIds).split(',').map(id => parseInt(id.trim(), 10)).filter(n => !isNaN(n));
                }
            }
            const ab = socket.activeBattle ? battleRooms[socket.activeBattle] : null;
            if (!ab) { response = _xt({ _cmd: 'gameError' }); break; }
            const pIdx = ab.players.findIndex(p => p.id === socket.playerId);
            if (pIdx === -1) { response = _xt({ _cmd: 'gameError' }); break; }

            ab.players[pIdx].nanovorSwarm = nanovorIds;
            const refStr = String(socket.playerId);
            if (!ab.swarmIds) ab.swarmIds = {};
            ab.swarmIds[refStr] = nanovorIds.map(String);

            if (!ab.teamState) ab.teamState = {};
            ab.teamState[refStr] = {};
            const u = users[socket.userId];
            for (const aid of nanovorIds) {
                const nid = String(aid);
                if (u && u.nanovorInventory) {
                    const inv = u.nanovorInventory.find(n => String(n.id) === nid);
                    if (inv) {
                        const v = virmonData.getVirmon ? virmonData.getVirmon(inv.asset_type_id || inv.assetTypeId) : null;
                        ab.teamState[refStr][nid] = {
                            instanceId: nid,
                            assetTypeId: parseInt(inv.asset_type_id || inv.assetTypeId || 1, 10),
                            nickname: String(inv.nickname || ''),
                            speed: parseInt(v ? v.speed : (inv.speed || 10), 10),
                            strength: parseInt(v ? v.strength : (inv.strength || 100), 10),
                            armor: parseInt(v ? v.armor : (inv.armor || 0), 10),
                            health: parseInt(v ? v.health : (inv.health || 100), 10),
                        };
                    }
                }
            }

            const uriId = clientUserRefId(ab, ab.players[pIdx]);
            const swarmPayload = {
                _cmd: 'swarmSelected',
                battleName: ab.name,
                swarmCount: nanovorIds.length,
                swarmValue: params.swarmValue || 0,
                username: socket.userName,
                userRefId: uriId,
                selectedSwarmIds: nanovorIds,
            };
            broadcastToBattle(ab.name, _xt(swarmPayload), socket.playerId);
            response = _xt(swarmPayload);

            if (!ab.swarmSelected) ab.swarmSelected = new Set();
            ab.swarmSelected.add(socket.playerId);
            const allSelected = ab.swarmSelected.size >= ab.players.length;
            if (allSelected && !ab.readyForTurnSent) {
                ab.readyForTurnSent = true;
                ab.gameState = 'in_combat';
                ab.attackChoices = {};
                const readyPayload = { _cmd: 'readyForTurn', nanovorId: 0, isDead: false };
                const sockets = _battleSockets(ab.name);
                for (const s of sockets) _sendTo(s, readyPayload);
                if (!sockets.some(s => s === socket)) _sendTo(socket, readyPayload);
            }
            break;
        }

        case 'setAttackInfo': {
            const attackId = params.attackId || 0;
            _sendTo(socket, { _cmd: 'attackInfoSet', attackId });

            const battleName = socket.activeBattle;
            if (!battleName || !battleRooms[battleName]) break;
            const b = battleRooms[battleName];
            if (b.gameState !== 'in_combat') break;

            if (!b.attackChoices) b.attackChoices = {};
            const uid = String(socket.playerId);
            b.attackChoices[uid] = {
                attackId,
                nanovorId: params.nanovorId || '0',
                enemyUsername: params.enemyUsername || '',
                swapNanovorId: params.swapNanovorId || '0',
            };

            const numPlayers = (b.players || []).length;
            if (Object.keys(b.attackChoices).length >= numPlayers) {
                if (!b.roundInfoPayload) {
                    if (_buildRoundInfoFromAttackChoices(b)) {
                        setTimeout(() => {
                            const payload = b.roundInfoPayload;
                            const players = (payload || {}).players || [];
                            const minimal = _minimalSetRoundInfoPlayers(players);
                            const orderedUids = _computeTurnOrderUids(minimal);
                            b.turn_order_uids = orderedUids;
                            const ordered = _orderPlayersByTurnOrder(minimal, orderedUids);
                            const roundNum = b.round || 1;
                            const sockets = _battleSockets(battleName);
                            for (const s of sockets) _sendTo(s, { _cmd: 'setRoundInfo', players: ordered, round: roundNum });
                            _resolveRoundAttacks(battleName);
                        }, SET_ROUND_INFO_DELAY_MS);
                    }
                } else {
                    _resolveRoundAttacks(battleName);
                }
            }
            break;
        }

        case 'endRound': {
            const battleName = socket.activeBattle;
            if (!battleName || !battleRooms[battleName]) {
                response = _xt({ _cmd: 'gameError' });
                break;
            }
            const b = battleRooms[battleName];
            b.round = (b.round || 1) + 1;

            if (!b.endRoundReceived) b.endRoundReceived = new Set();
            b.endRoundReceived.add(String(socket.playerId));
            _sendTo(socket, { _cmd: 'roundEnded', round: b.round });

            const numPlayers = (b.players || []).length;
            if (b.endRoundReceived.size >= numPlayers) {
                b.endRoundReceived = new Set();
                const sockets = _battleSockets(battleName);

                const gameOverPayload = b.gameOver;
                if (gameOverPayload) {
                    delete b.gameOver;
                    const goMsg = { _cmd: 'gameOver', winnerId: gameOverPayload.winnerId, results: gameOverPayload.results };
                    for (const s of sockets) _sendTo(s, goMsg);
                    for (const s of sockets) s.activeBattle = null;
                    delete battleRooms[battleName];
                    for (const [key, val] of Object.entries(_quickBattleQueue)) {
                        if (val === battleName) { delete _quickBattleQueue[key]; break; }
                    }
                } else {
                    if (b.sendSetRoundInfoBeforeNextResolve) {
                        b.sendSetRoundInfoBeforeNextResolve = false;
                        const readyPayload = { _cmd: 'readyForTurn', nanovorId: 0, isDead: false };
                        for (const s of sockets) _sendTo(s, readyPayload);
                    } else {
                        const roundState = b.roundState || {};
                        const minimalRoundPlayers = [];
                        for (const pp of (b.roundInfoPayload || {}).players || []) {
                            const ref = parseInt(pp.userRefId || 0, 10);
                            const st = roundState[String(ref)] || {};
                            minimalRoundPlayers.push({ userRefId: ref, selectedNanovor: Object.assign({}, st) });
                        }
                        const minimal = _minimalSetRoundInfoPlayers(minimalRoundPlayers);
                        const orderedUids = _computeTurnOrderUids(minimal);
                        b.turn_order_uids = orderedUids;
                        const ordered = _orderPlayersByTurnOrder(minimal, orderedUids);
                        const roundNum = b.round || 1;
                        for (const s of sockets) _sendTo(s, { _cmd: 'setRoundInfo', players: ordered, round: roundNum });
                        const readyPayload = { _cmd: 'readyForTurn', nanovorId: 0, isDead: false };
                        for (const s of sockets) _sendTo(s, readyPayload);
                    }
                }
            }
            break;
        }

        case 'quitGame': {
            const quittingUserId = params.userRefId || socket.playerId;
            const quitBattle = socket.activeBattle ? battleRooms[socket.activeBattle] : null;
            if (quitBattle) {
                const quitterName = socket.userName || 'Unknown';
                quitBattle.players = quitBattle.players.filter(p => p.id !== quittingUserId);
                if (quitBattle.players.length <= 1) {
                    quitBattle.gameState = 'finished';
                    broadcastToBattle(quitBattle.name, _xt({ _cmd: 'gameOver', winnerId: quitBattle.players[0]?.id || '', results: 'Game ended due to player quit' }));
                    if (quitBattle.players[0] && users[quitBattle.players[0].id]) {
                        users[quitBattle.players[0].id].nanocash = (users[quitBattle.players[0].id].nanocash || 0) + 50;
                        saveUserData(quitBattle.players[0].id);
                    }
                    delete battleRooms[quitBattle.name];
                } else {
                    broadcastToBattle(quitBattle.name, _xt({ _cmd: 'playerQuitGame', userRefId: quittingUserId, username: quitterName }));
                }
                socket.activeBattle = null;
                response = _xt({ _cmd: 'quitGameConfirmed', userRefId: quittingUserId });
            } else {
                response = _xt({ _cmd: 'gameError' });
            }
            break;
        }

        case 'gameQuit': {
            const quitBattle = socket.activeBattle ? battleRooms[socket.activeBattle] : null;
            if (quitBattle) {
                quitBattle.players = quitBattle.players.filter(p => p.id !== socket.playerId);
                if (quitBattle.players.length <= 1) {
                    quitBattle.gameState = 'finished';
                    broadcastToBattle(quitBattle.name, _xt({ _cmd: 'gameOver', winnerId: quitBattle.players[0]?.id || '', results: 'Game ended due to player quit' }));
                    if (quitBattle.players[0] && users[quitBattle.players[0].id]) {
                        users[quitBattle.players[0].id].nanocash = (users[quitBattle.players[0].id].nanocash || 0) + 50;
                        saveUserData(quitBattle.players[0].id);
                    }
                    delete battleRooms[quitBattle.name];
                } else {
                    broadcastToBattle(quitBattle.name, _xt({ _cmd: 'playerQuitGame', userRefId: socket.playerId, username: socket.userName || 'Unknown' }));
                }
                socket.activeBattle = null;
                response = _xt({ _cmd: 'gameQuitConfirmed', userRefId: socket.playerId });
            } else {
                response = _xt({ _cmd: 'gameError' });
            }
            break;
        }

        case 'cancelQuickBattle': {
            const cancelUserId = params.userRefId || socket.playerId;
            const cancelBattleName = Object.keys(battleRooms).find(bn => {
                return battleRooms[bn].creator === cancelUserId && battleRooms[bn].gameState === 'waiting_for_players';
            });
            if (cancelBattleName) {
                broadcastToBattle(cancelBattleName, _xt({ _cmd: 'gameOver', results: 'Game was cancelled' }));
                delete battleRooms[cancelBattleName];
                for (const [key, val] of Object.entries(_quickBattleQueue)) {
                    if (val === cancelBattleName) { delete _quickBattleQueue[key]; break; }
                }
                socket.activeBattle = null;
                response = _xt({ _cmd: 'quickBattleCancelled' });
            } else {
                response = _xt({ _cmd: 'gameError' });
            }
            break;
        }

        case 'getBadgeList': {
            response = _xt({ _cmd: 'badgeList', ownerId: params.ownerId || '', nanovorId: params.nanovorId || '', badges: [] });
            break;
        }

        case 'setReady': {
            const readyBattle = socket.activeBattle ? battleRooms[socket.activeBattle] : null;
            if (readyBattle) {
                const pIdx = readyBattle.players.findIndex(p => p.id === socket.playerId);
                if (pIdx !== -1) {
                    readyBattle.players[pIdx].ready = true;
                    const allReady = readyBattle.players.every(p => p.ready);
                    if (allReady && readyBattle.players.length >= 2) {
                        readyBattle.gameState = 'in_progress';
                        readyBattle.turnOrder = [...readyBattle.players];
                        readyBattle.players.forEach((p, idx) => ensureDefaultSwarmForPlayer(readyBattle, idx));
                        const senseiPayload = isSenseiBattle(readyBattle) ? { isSenseiBattle: true } : {};
                        broadcastToBattle(readyBattle.name, _xt(Object.assign({
                            _cmd: 'gameStarted', battleName: readyBattle.name,
                            players: playersForClient(readyBattle), gameCreator: readyBattle.creatorName,
                        }, senseiPayload)));
                    }
                    response = _xt({ _cmd: 'playerReady', userRefId: socket.playerId, ready: true });
                } else {
                    response = _xt({ _cmd: 'gameError' });
                }
            } else {
                response = _xt({ _cmd: 'gameError' });
            }
            break;
        }

        case 'startGame': {
            const startBattleName = params.battleName;
            const startBattle = battleRooms[startBattleName];
            if (startBattle) {
                startBattle.gameState = 'in_progress';
                startBattle.turnOrder = [...startBattle.players];
                startBattle.players.forEach((p, idx) => ensureDefaultSwarmForPlayer(startBattle, idx));
                broadcastToBattle(startBattleName, _xt({
                    _cmd: 'gameStarted', battleName: startBattleName,
                    players: playersForClient(startBattle), gameCreator: startBattle.creatorName,
                }));
                response = _xt({ _cmd: 'gameStarted', battleName: startBattleName });
            } else {
                response = _xt({ _cmd: 'gameError' });
            }
            break;
        }

        case 'playerJoinAutoBattle': {
            const autoBattleName = params.battleName;
            const gameCreator = params.gameCreator;
            let gameCreatorId = params.gameCreatorId;
            if (gameCreatorId == null) {
                if (autoBattleName === 'Training') gameCreatorId = '-5';
                else if (autoBattleName === 'Medium') gameCreatorId = '-4';
                else if (autoBattleName === 'Easy') gameCreatorId = '-3';
                else gameCreatorId = '-5';
            }
            gameCreatorId = String(gameCreatorId);

            if (!battleRooms[autoBattleName]) {
                battleRooms[autoBattleName] = {
                    id: state.battleIdCounter++,
                    name: autoBattleName,
                    gameSwarmValue: 1000,
                    maxPlayers: 2,
                    players: [
                        { id: gameCreatorId, name: gameCreator || autoBattleName, ready: true, nanovorSwarm: [], selectedNanovor: null, enemyTarget: null },
                        { id: socket.playerId, name: socket.userName, ready: true, nanovorSwarm: [], selectedNanovor: null, enemyTarget: null },
                    ],
                    creator: gameCreatorId,
                    creatorName: gameCreator || autoBattleName,
                    gameState: 'in_progress',
                    turnOrder: [],
                    currentTurn: 0,
                    round: 1,
                    battleHistory: [],
                };
            } else {
                const existing = battleRooms[autoBattleName];
                if (existing.players.length < existing.maxPlayers) {
                    existing.players.push({ id: socket.playerId, name: socket.userName, ready: true, nanovorSwarm: [], selectedNanovor: null, enemyTarget: null });
                }
            }
            socket.activeBattle = autoBattleName;

            const fab = battleRooms[autoBattleName];
            fab.turnOrder = [...fab.players];
            fab.gameState = 'in_progress';
            fab.players.forEach((p, idx) => ensureDefaultSwarmForPlayer(fab, idx));

            const isSensei = isSenseiBattle(fab);
            const senseiP = isSensei ? { isSenseiBattle: true } : {};
            const pJson = playersForClient(fab);

            const hp = fab.players.find(p => p.id === socket.playerId);
            const joinRefId = hp ? clientUserRefId(fab, hp) : String(socket.playerId);

            broadcastToBattle(autoBattleName, _xt(Object.assign({
                _cmd: 'playerJoinAutoBattle', battleName: autoBattleName, username: socket.userName,
                userRefId: joinRefId, gameCreator: gameCreator, gameCreatorId: gameCreatorId,
            }, senseiP)));

            broadcastToBattle(autoBattleName, _xt(Object.assign({
                _cmd: 'gameStarted', battleName: autoBattleName, players: pJson, gameCreator: fab.creatorName,
            }, senseiP)));

            response = _xt(Object.assign({
                _cmd: 'joinedAutoBattle', battleName: autoBattleName, gameCreator: gameCreator, gameCreatorId: gameCreatorId,
            }, senseiP));
            break;
        }

        case 'setGameSwarmValue': {
            const newSwarmValue = params.gameSwarmValue || 1000;
            const currentBattle = socket.activeBattle ? battleRooms[socket.activeBattle] : null;
            if (currentBattle && currentBattle.creator === socket.playerId) {
                currentBattle.gameSwarmValue = newSwarmValue;
                broadcastToBattle(currentBattle.name, _xt({ _cmd: 'gameSwarmValueSet', battleName: currentBattle.name, gameSwarmValue: newSwarmValue }), socket.playerId);
                response = _xt({ _cmd: 'gameSwarmValueSet', battleName: currentBattle.name, gameSwarmValue: newSwarmValue });
            } else {
                response = _xt({ _cmd: 'gameError' });
            }
            break;
        }

        case 'setAttack':
            response = _xt({ _cmd: 'attackSet', attackId: params.attackId || 0 });
            break;
        case 'setSelectedNanovor':
        case 'selectNanovor':
            response = _xt({ _cmd: 'nanovorSelected', nanovorId: params.nanovorId || 0 });
            break;
        case 'setEnemy':
            response = _xt({ _cmd: 'enemyTargetSet' });
            break;
        case 'declinedToWatch':
            response = _xt({ _cmd: 'declinedToWatchConfirmed', userRefId: params.userRefId || '' });
            break;
        case 'performAttack':
            response = _xt({ _cmd: 'attackPerformed', attackId: params.attackId || 0 });
            break;

        case 'kickPlayerOut': {
            const usernameToKick = params.username;
            const kickBattle = socket.activeBattle ? battleRooms[socket.activeBattle] : null;
            if (kickBattle && kickBattle.creator === socket.playerId) {
                const pIdx = kickBattle.players.findIndex(p => p.name === usernameToKick);
                if (pIdx !== -1) {
                    const kicked = kickBattle.players[pIdx];
                    sendMessageToUser(kicked.id, _xt({ _cmd: 'playerKickedOut', userRefId: kicked.id }));
                    kickBattle.players.splice(pIdx, 1);
                    if (kickBattle.players.length <= 1) {
                        kickBattle.gameState = 'finished';
                        broadcastToBattle(kickBattle.name, _xt({ _cmd: 'gameOver', winnerId: kickBattle.players[0]?.id || '' }));
                    } else {
                        broadcastToBattle(kickBattle.name, _xt({ _cmd: 'playerQuitGame', userRefId: kicked.id, username: kicked.name }));
                    }
                    response = _xt({ _cmd: 'playerKickedOut', userRefId: kicked.id });
                } else {
                    response = _xt({ _cmd: 'gameError' });
                }
            } else {
                response = _xt({ _cmd: 'gameError' });
            }
            break;
        }

        default:
            response = _xt({ _cmd: 'unknownCommand' });
    }

    if (response) socket.write(response);
}

module.exports = handleGameXtCommand;
