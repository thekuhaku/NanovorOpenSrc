/**
 * SFS messaging utilities.
 * Wraps JSON payloads in the SmartFox extension message envelope.
 */

const state = require('../state');
const { socketMap } = state;

/**
 * Build an SFS extension response string from a JSON payload.
 */
function buildExtResponse(payload) {
    const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return `<msg t="xt"><body action="xtRes" r="-1"><![CDATA[${json}]]></body></msg>\x00`;
}

/**
 * Send a JSON extension message to a socket.
 */
function sendJson(socket, payload) {
    if (!socket || socket.destroyed) return false;
    socket.write(buildExtResponse(payload));
    return true;
}

/**
 * Send a JSON extension message to a user by accountId (via socketMap).
 */
function sendJsonToUser(userId, payload) {
    const socket = socketMap[userId];
    return sendJson(socket, payload);
}

/**
 * Find a connected socket by username (case-insensitive).
 */
function findSocketByUsername(username) {
    if (!username) return null;
    const lower = username.trim().toLowerCase();
    for (const uid of Object.keys(socketMap)) {
        const s = socketMap[uid];
        if (s && !s.destroyed && (s.userName || '').trim().toLowerCase() === lower) {
            return s;
        }
    }
    return null;
}

/**
 * Get all connected sockets as an array.
 */
function getAllSockets() {
    const sockets = [];
    for (const uid of Object.keys(socketMap)) {
        const s = socketMap[uid];
        if (s && !s.destroyed) sockets.push(s);
    }
    return sockets;
}

module.exports = {
    buildExtResponse,
    sendJson,
    sendJsonToUser,
    findSocketByUsername,
    getAllSockets
};
