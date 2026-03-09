/**
 * Shared in-memory state for the Nanovor server.
 * All modules that need users, sessions, rooms, or socket maps use this single instance.
 */

let users = {};
let sessions = {};
let gameRooms = {};
let gameStates = {};
let socketMap = {};
let battleRooms = {};
let battleIdCounter = 1000;

// Buddy system
let buddies = {};              // accountId -> Set of buddy accountIds

// Chat system
let pendingPrivateInvites = {}; // inviteeUsernameLower -> inviterUsername
let privateChatPeers = {};      // usernameLower -> peerUsernameLower

// Trade system
let pendingTradeInvites = {};   // tradeName -> inviterSocket
let activeTrades = {};          // tradeName -> { inviter: socket, invitee: socket }
let tradeStartedIds = {};       // tradeName -> Set of accountIds
let tradeCurrentOfferer = {};   // tradeName -> accountId
let tradeCurrentResponder = {}; // tradeName -> accountId
let tradeResponderAccepted = {};// tradeName -> bool
let tradeResponderModifiedCart = {}; // tradeName -> bool
let tradeConfirmedIds = {};     // tradeName -> Set of accountIds
let tradeCarts = {};            // tradeName -> { accountId: Set of assetIds }

// Buddy invites
let pendingBuddyInvites = {};  // inviteeUsernameLower -> inviterUsername

/** Integer account IDs. New accounts get next id; loaded accounts advance nextId. */
let nextAccountId = 1;

function getNextAccountId() {
    return nextAccountId++;
}

function setNextAccountIdIfHigher(id) {
    const n = Number(id);
    if (!Number.isNaN(n) && n >= nextAccountId) nextAccountId = n + 1;
}

/** Integer EM (Evolution Module) asset IDs. New EMs get next id; loaded EMs advance nextId. */
let nextEmAssetId = 1;

function getNextEmAssetId() {
    return nextEmAssetId++;
}

function setNextEmAssetIdIfHigher(id) {
    const n = Number(id);
    if (!Number.isNaN(n) && n >= nextEmAssetId) nextEmAssetId = n + 1;
}

module.exports = {
    users,
    sessions,
    gameRooms,
    gameStates,
    socketMap,
    battleRooms,
    battleIdCounter,
    getNextAccountId,
    setNextAccountIdIfHigher,
    getNextEmAssetId,
    setNextEmAssetIdIfHigher,
    buddies,
    pendingPrivateInvites,
    privateChatPeers,
    pendingTradeInvites,
    activeTrades,
    tradeStartedIds,
    tradeCurrentOfferer,
    tradeCurrentResponder,
    tradeResponderAccepted,
    tradeResponderModifiedCart,
    tradeConfirmedIds,
    tradeCarts,
    pendingBuddyInvites
};
