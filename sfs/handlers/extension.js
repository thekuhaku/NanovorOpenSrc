const state = require('../../state');
const user = require('../../user');
const handleGameXtCommand = require('./gameXt');
const { sendJson, findSocketByUsername, getAllSockets } = require('../../lib/sfsUtil');
const { users, getNextEmAssetId, socketMap,
        pendingPrivateInvites, privateChatPeers,
        pendingTradeInvites, activeTrades, tradeStartedIds,
        tradeCurrentOfferer, tradeCurrentResponder,
        tradeResponderAccepted, tradeResponderModifiedCart,
        tradeConfirmedIds, tradeCarts,
        buddies, pendingBuddyInvites } = state;
const { saveUserData } = user;

function handleExtensionCommand(socket, extension, command, params) {
    console.log(`Handling extension command: ${extension}.${command}`);
    
    let response = '';
    
    switch (extension) {
        case 'loginXt':
            switch (command) {
                case 'updateUserToken':
                    // Update user token
                    response = `<msg t="xt"><body action="xtRes" r="-1"><![CDATA[{"_cmd":"userTokenUpdated"}]]></body></msg>\x00`;
                    break;
                case 'updateAvatar':
                    // Update avatar
                    const newAvatarId = params.avatarId || 1;
                    if (users[socket.userId]) {
                        users[socket.userId].avatarId = parseInt(newAvatarId);

                        // Save user data after updating avatar
                        saveUserData(socket.userId);
                    }
                    response = `<msg t="xt"><body action="xtRes" r="-1"><![CDATA[{"_cmd":"avatarUpdated"}]]></body></msg>\x00`;
                    break;
                case 'getBuddyAvatar':
                    // Client asks by buddy name (e.g. "Training"); response userRefId must match that player so loadEnemyAvatarPictureById(userRefId,...) updates the correct slot.
                    const buddyName = (params.name || '').toString().trim();
                    const senseiRefIds = { 'training': -5, 'medium': -4, 'easy': -3 };
                    const senseiKey = buddyName.toLowerCase();
                    let refId = socket.userId;
                    let bid = 1;
                    let bnmp = 0;
                    if (senseiRefIds[senseiKey] !== undefined) {
                        refId = senseiRefIds[senseiKey];
                    } else {
                        const buddyUser = users[socket.userId] || {};
                        bid = typeof buddyUser.avatarId === 'number' ? buddyUser.avatarId : 1;
                        bnmp = typeof buddyUser.nmp === 'number' ? buddyUser.nmp : 0;
                    }
                    response = `<msg t="xt"><body action="xtRes" r="-1"><![CDATA[{"_cmd":"responseBuddyAvatar","userRefId":${refId},"avatarId":${bid},"nmp":${bnmp}}]]></body></msg>\x00`;
                    break;
                case 'getUserData':
                case 'syncUserData':
                    // Return comprehensive user data (includes nanocash for sync). No id so client keeps SFS login id.
                    const userData = users[socket.userId] || {};
                    response = `<msg t="xt"><body action="xtRes" r="-1"><![CDATA[{"_cmd":"userDataSynced","username":"${socket.userName || 'n'}","avatarId":${userData.avatarId || 1},"nmp":${userData.nmp || 0},"nanocash":${userData.nanocash || 0},"gamesPlayed":${userData.gamesPlayed || 0},"hasSeenNewUserExperience":${userData.hasSeenNewUserExperience || false}}]]></body></msg>\x00`;
                    break;
                case 'updateNanovorCount':
                    // Update nanovor count
                    if (params.nanovorCount !== undefined && users[socket.userId]) {
                        users[socket.userId].nanovorCount = parseInt(params.nanovorCount) || 0;

                        // Save user data after updating nanovor count
                        saveUserData(socket.userId);
                    }
                    response = `<msg t="xt"><body action="xtRes" r="-1"><![CDATA[{"_cmd":"nanovorCountUpdated"}]]></body></msg>\x00`;
                    break;

                case 'addNanovor':
                    // Add a nanovor to the user's inventory
                    if (params.nanovorData && users[socket.userId]) {
                        const nanovorData = params.nanovorData;

                        // Ensure nanovorInventory exists
                        if (!users[socket.userId].nanovorInventory) {
                            users[socket.userId].nanovorInventory = [];
                        }

                        // Add the new nanovor to inventory
                        users[socket.userId].nanovorInventory.push(nanovorData);

                        // Update counts
                        users[socket.userId].nanovorCount = users[socket.userId].nanovorInventory.length;
                        users[socket.userId].nanovorCountUnique = users[socket.userId].nanovorInventory.length; // Simplified for now

                        // Save user data after updating inventory
                        saveUserData(socket.userId);
                    }
                    response = `<msg t="xt"><body action="xtRes" r="-1"><![CDATA[{"_cmd":"nanovorAdded"}]]></body></msg>\x00`;
                    break;

                case 'removeNanovor':
                    // Remove a nanovor from the user's inventory
                    if (params.nanovorId !== undefined && users[socket.userId]) {
                        const removeNanovorId = parseInt(params.nanovorId);

                        if (users[socket.userId].nanovorInventory) {
                            // Filter out the nanovor with the specified ID
                            users[socket.userId].nanovorInventory = users[socket.userId].nanovorInventory.filter(nanovor => nanovor.id !== removeNanovorId);

                            // Update counts
                            users[socket.userId].nanovorCount = users[socket.userId].nanovorInventory.length;
                            users[socket.userId].nanovorCountUnique = users[socket.userId].nanovorInventory.length; // Simplified for now

                            // Save user data after updating inventory
                            saveUserData(socket.userId);
                        }
                    }
                    response = `<msg t="xt"><body action="xtRes" r="-1"><![CDATA[{"_cmd":"nanovorRemoved"}]]></body></msg>\x00`;
                    break;

                case 'addEm':
                    // Add an Energy Matrix to the user's inventory (EM ids are integers only, no uuid)
                    if (params.emData && users[socket.userId]) {
                        const emData = params.emData;
                        const parsedId = typeof emData.id === 'number' ? Math.floor(emData.id) : parseInt(emData.id, 10);
                        if (Number.isNaN(parsedId) || parsedId < 1) {
                            emData.id = getNextEmAssetId();
                        } else {
                            emData.id = parsedId;
                        }
                        emData.assetTypeId = typeof emData.assetTypeId === 'number' ? Math.floor(emData.assetTypeId) : (parseInt(emData.assetTypeId, 10) || 0);

                        // Ensure emInventory exists
                        if (!users[socket.userId].emInventory) {
                            users[socket.userId].emInventory = [];
                        }

                        // Add the new EM to inventory
                        users[socket.userId].emInventory.push(emData);

                        // Update EM count
                        users[socket.userId].ems = users[socket.userId].emInventory.length;

                        // Save user data after updating inventory
                        saveUserData(socket.userId);
                    }
                    response = `<msg t="xt"><body action="xtRes" r="-1"><![CDATA[{"_cmd":"emAdded"}]]></body></msg>\x00`;
                    break;

                case 'removeEm':
                    // Remove an Energy Matrix from the user's inventory
                    if (params.emId !== undefined && users[socket.userId]) {
                        const emId = parseInt(params.emId);

                        if (users[socket.userId].emInventory) {
                            // Filter out the EM with the specified ID
                            users[socket.userId].emInventory = users[socket.userId].emInventory.filter(em => em.id !== emId);

                            // Update EM count
                            users[socket.userId].ems = users[socket.userId].emInventory.length;

                            // Save user data after updating inventory
                            saveUserData(socket.userId);
                        }
                    }
                    response = `<msg t="xt"><body action="xtRes" r="-1"><![CDATA[{"_cmd":"emRemoved"}]]></body></msg>\x00`;
                    break;
                case 'initialize':  // Initial command sent by client to loginXt extension
                case 'login':
                case 'init':
                    // logOK: do not send id so client uses SFS login id (session.accountId) for battle.
                    response = `<msg t="xt"><body action="xtRes" r="-1"><![CDATA[{"_cmd":"logOK","chatRoomName":"Lobby","username":"${socket.userName || 'n'}"}]]></body></msg>\x00`;
                    break;
                default:
                    // For unknown commands, return unknown command response
                    response = `<msg t="xt"><body action="xtRes" r="-1"><![CDATA[{"_cmd":"unknownCommand"}]]></body></msg>\x00`;
                    break;
            }
            break;
            
        case 'chatXt':
            handleChatExtension(socket, command, params);
            return;
            
        case 'tradeXt':
            handleTradeExtension(socket, command, params);
            return;
            
        case 'buddyListXt':
            handleBuddyExtension(socket, command, params);
            return;

        case 'gameXt':
            // Handle battle-related commands
            handleGameXtCommand(socket, command, params);
            return; // Return early since response is handled in the function

        default:
            response = `<msg t="xt"><body action="xtRes" r="-1"><![CDATA[{"_cmd":"unknownExtension"}]]></body></msg>\x00`;
    }

    socket.write(response);
}

// 式式式 Chat Extension 式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式

function _getLobbyUserCount() {
    return getAllSockets().length;
}

function handleChatExtension(socket, command, params) {
    const avatarId = (users[socket.userId] || {}).avatarId || 1;
    const nmp = (users[socket.userId] || {}).nmp || 0;

    switch (command) {
        case 'getChatRoomList': {
            const lobbyCount = _getLobbyUserCount();
            sendJson(socket, {
                _cmd: 'chatRoomListResponse',
                chatRoomList: 'Lobby',
                chatRoomCounts: String(lobbyCount),
            });
            break;
        }
        case 'joinChatRoom': {
            const roomName = params.chatRoomName || 'Lobby';
            sendJson(socket, {
                _cmd: 'chatInvitationJoined',
                chatRoomName: roomName,
                messageList: [],
            });
            break;
        }
        case 'sendChatMessage': {
            const message = params.message || '';
            const roomName = params.chatRoomName || 'Lobby';
            const chatResponse = {
                _cmd: 'sendChatMessage',
                message: message,
                username: socket.userName || 'test',
                avatarId: avatarId,
                nmp: nmp,
                chatRoomName: roomName,
            };
            // Broadcast to all connected clients
            for (const s of getAllSockets()) {
                sendJson(s, chatResponse);
            }
            break;
        }
        case 'inviteToChat': {
            const inviteeName = (params.inviteeName || '').trim();
            const chatRoomName = params.chatRoomName || 'Private';
            const inviteeSocket = findSocketByUsername(inviteeName);
            if (inviteeSocket && inviteeSocket !== socket) {
                pendingPrivateInvites[inviteeName.toLowerCase()] = (socket.userName || 'Unknown').trim();
                sendJson(inviteeSocket, {
                    _cmd: 'chatInvitationRequest',
                    chatRoomName: chatRoomName,
                    inviterName: socket.userName || 'Unknown',
                    inviterAvatarId: avatarId,
                    inviterNMP: nmp,
                });
            } else {
                sendJson(socket, { _cmd: 'chatInvitationRejected', inviteeName: inviteeName });
            }
            break;
        }
        case 'replyChatInvitation': {
            const accept = params.accept || false;
            const chatRoomName = params.chatRoomName || 'Private';
            const inviteeUsername = (socket.userName || '').trim().toLowerCase();
            const inviterUsername = pendingPrivateInvites[inviteeUsername] || null;
            delete pendingPrivateInvites[inviteeUsername];
            const inviterSocket = inviterUsername ? findSocketByUsername(inviterUsername) : null;

            if (accept) {
                sendJson(socket, {
                    _cmd: 'chatInvitationJoined',
                    chatRoomName: chatRoomName,
                    messageList: [],
                });
                if (inviterSocket) {
                    const inviteeAvatarId = (users[socket.userId] || {}).avatarId || 1;
                    const inviteeNmp = (users[socket.userId] || {}).nmp || 0;
                    sendJson(inviterSocket, {
                        _cmd: 'chatInvitationResponse',
                        chatRoomName: chatRoomName,
                        inviteeName: socket.userName || 'Unknown',
                        accept: true,
                        inviteeAvatarId: inviteeAvatarId,
                        inviteeNMP: inviteeNmp,
                    });
                    sendJson(inviterSocket, { _cmd: 'chatRoomCreated', chatRoomName: chatRoomName });
                    const inviterUname = (inviterSocket.userName || '').trim().toLowerCase();
                    if (inviterUname && inviteeUsername) {
                        privateChatPeers[inviterUname] = inviteeUsername;
                        privateChatPeers[inviteeUsername] = inviterUname;
                    }
                }
            } else {
                if (inviterSocket) {
                    sendJson(inviterSocket, { _cmd: 'chatInvitationRejected', inviteeName: socket.userName || 'Unknown' });
                }
            }
            break;
        }
        case 'leaveChatRoom':
        case 'exitChatRoom': {
            const roomName = params.chatRoomName || 'Lobby';
            if (roomName === 'Private') {
                const myUname = (socket.userName || '').trim().toLowerCase();
                const otherUname = privateChatPeers[myUname] || null;
                if (otherUname) {
                    delete privateChatPeers[myUname];
                    delete privateChatPeers[otherUname];
                    const otherSocket = findSocketByUsername(otherUname);
                    if (otherSocket) {
                        sendJson(otherSocket, {
                            _cmd: 'userLeftChatRoom',
                            chatRoomName: roomName,
                            username: socket.userName || 'Unknown',
                        });
                        sendJson(otherSocket, {
                            _cmd: 'chatRoomDestroyed',
                            chatRoomName: roomName,
                            reason: 'other_user_left',
                        });
                    }
                }
            }
            sendJson(socket, { _cmd: 'chatRoomLeft', chatRoomName: roomName });
            break;
        }
        default:
            console.log(`[SFS chatXt] Unknown command: ${command}`);
            sendJson(socket, { _cmd: 'unknownCommand' });
    }
}

// 式式式 Trade Extension 式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式

function _tradeNameAndPairForSocket(socket) {
    for (const tname of Object.keys(activeTrades)) {
        const pair = activeTrades[tname];
        if (pair && (pair.inviter === socket || pair.invitee === socket)) {
            return { tname, pair };
        }
    }
    return null;
}

function _cleanupTrade(tname) {
    delete activeTrades[tname];
    delete tradeStartedIds[tname];
    delete tradeCurrentOfferer[tname];
    delete tradeCurrentResponder[tname];
    delete tradeResponderAccepted[tname];
    delete tradeResponderModifiedCart[tname];
    delete tradeConfirmedIds[tname];
    delete tradeCarts[tname];
}

function _getTradeAssets(accountId) {
    const u = users[accountId];
    if (!u) return { nanovorList: [], emList: [] };
    const nanovorList = (u.nanovorInventory || []).map(n => ({
        id: n.id,
        assetTypeId: n.assetTypeId,
        name: n.name || n.assetTypeName || '',
    }));
    const emList = (u.emInventory || []).map(e => ({
        id: e.id,
        assetTypeId: e.assetTypeId,
        name: e.name || e.assetTypeName || '',
    }));
    return { nanovorList, emList };
}

function _executeTradeTransfer(accountA, accountB, cartA, cartB) {
    // Transfer assets from A to B and vice versa
    const userA = users[accountA];
    const userB = users[accountB];
    if (!userA || !userB) return;

    for (const assetId of cartA) {
        // Move from A to B
        let idx = (userA.nanovorInventory || []).findIndex(n => n.id === assetId);
        if (idx >= 0) {
            const item = userA.nanovorInventory.splice(idx, 1)[0];
            userB.nanovorInventory = userB.nanovorInventory || [];
            userB.nanovorInventory.push(item);
            continue;
        }
        idx = (userA.emInventory || []).findIndex(e => e.id === assetId);
        if (idx >= 0) {
            const item = userA.emInventory.splice(idx, 1)[0];
            userB.emInventory = userB.emInventory || [];
            userB.emInventory.push(item);
        }
    }
    for (const assetId of cartB) {
        // Move from B to A
        let idx = (userB.nanovorInventory || []).findIndex(n => n.id === assetId);
        if (idx >= 0) {
            const item = userB.nanovorInventory.splice(idx, 1)[0];
            userA.nanovorInventory = userA.nanovorInventory || [];
            userA.nanovorInventory.push(item);
            continue;
        }
        idx = (userB.emInventory || []).findIndex(e => e.id === assetId);
        if (idx >= 0) {
            const item = userB.emInventory.splice(idx, 1)[0];
            userA.emInventory = userA.emInventory || [];
            userA.emInventory.push(item);
        }
    }
    // Update counts and save
    userA.nanovorCount = (userA.nanovorInventory || []).length;
    userA.ems = (userA.emInventory || []).length;
    userB.nanovorCount = (userB.nanovorInventory || []).length;
    userB.ems = (userB.emInventory || []).length;
    saveUserData(accountA);
    saveUserData(accountB);
}

function handleTradeExtension(socket, command, params) {
    const userId = socket.userId;

    switch (command) {
        case 'createTrade': {
            const tradeName = `trade_${userId}_${Date.now() % 100000}`;
            sendJson(socket, { _cmd: 'tradeCreated', tradeName });
            break;
        }
        case 'inviteUserToTrade': {
            const buddyName = (params.buddy || '').trim();
            const tradeName = (params.tradeName || '').trim();
            const invitee = findSocketByUsername(buddyName);
            if (invitee && invitee !== socket) {
                pendingTradeInvites[tradeName] = socket;
                const inviterName = socket.userName || 'Unknown';
                const inviterAvatarId = (users[userId] || {}).avatarId || 1;
                const inviterNmp = (users[userId] || {}).nmp || 0;
                sendJson(invitee, {
                    _cmd: 'tradeInvitationRequest',
                    inviter: { username: inviterName, userRefId: userId },
                    inviterName: inviterName,
                    inviterId: userId,
                    tradeName: tradeName,
                    inviterAvatarId: inviterAvatarId,
                    inviterNMP: inviterNmp,
                    messageId: 'fl_invitation_to_trade',
                    type: 'trade',
                    invitationType: 'trade',
                });
            }
            break;
        }
        case 'replyInvitationToTrade': {
            const tradeName = (params.tradeName || '').trim();
            const accept = params.accept || false;
            const replyReason = params.replyReason || '';
            const inviter = pendingTradeInvites[tradeName];
            if (inviter) {
                const inviteeName = socket.userName || 'Unknown';
                const inviteeId = socket.userId;
                const inviterName = inviter.userName || 'Unknown';
                const inviterId = inviter.userId;
                sendJson(inviter, {
                    _cmd: 'tradeInvitationResponse',
                    tradeName,
                    inviterName,
                    inviterId,
                    inviteeName,
                    inviteeId,
                    acceptedInvitation: accept,
                    replyReason,
                });
            }
            break;
        }
        case 'joinAndGetCollections': {
            const tradeName = (params.tradeName || '').trim();
            const inviter = pendingTradeInvites[tradeName];
            delete pendingTradeInvites[tradeName];
            if (!inviter || inviter.destroyed) {
                sendJson(socket, { _cmd: 'joinTradeError', tradeName });
                return;
            }
            activeTrades[tradeName] = { inviter, invitee: socket };
            const joinerId = socket.userId;
            const otherId = inviter.userId;
            tradeCarts[tradeName] = {};
            tradeCarts[tradeName][joinerId] = new Set();
            tradeCarts[tradeName][otherId] = new Set();

            const joinerAssets = _getTradeAssets(joinerId);
            const otherAssets = _getTradeAssets(otherId);

            sendJson(socket, { _cmd: 'playerJoinTrade', tradeName });
            sendJson(socket, { _cmd: 'collectionSet', userRefId: joinerId, nanovorList: joinerAssets.nanovorList, emList: joinerAssets.emList });
            sendJson(socket, { _cmd: 'collectionSet', userRefId: otherId, nanovorList: otherAssets.nanovorList, emList: otherAssets.emList });
            sendJson(socket, {
                _cmd: 'otherPlayerJoinTrade',
                tradeName,
                username: inviter.userName || 'Unknown',
                userRefId: otherId,
                avatarId: (users[otherId] || {}).avatarId || 1,
            });
            sendJson(inviter, { _cmd: 'playerJoinTrade', tradeName });
            sendJson(inviter, { _cmd: 'collectionSet', userRefId: otherId, nanovorList: otherAssets.nanovorList, emList: otherAssets.emList });
            sendJson(inviter, { _cmd: 'collectionSet', userRefId: joinerId, nanovorList: joinerAssets.nanovorList, emList: joinerAssets.emList });
            sendJson(inviter, {
                _cmd: 'otherPlayerJoinTrade',
                tradeName,
                username: socket.userName || 'Unknown',
                userRefId: joinerId,
                avatarId: (users[joinerId] || {}).avatarId || 1,
            });
            break;
        }
        case 'startTrade': {
            const tradeName = (params.tradeName || '').trim();
            const tnp = _tradeNameAndPairForSocket(socket);
            if (!tnp) {
                sendJson(socket, { _cmd: 'tradeError', tradeName });
                return;
            }
            const { pair } = tnp;
            if (!tradeStartedIds[tradeName]) tradeStartedIds[tradeName] = new Set();
            tradeStartedIds[tradeName].add(userId);

            // Only inviter clicking Start Trade sets TRADING/WAITING
            if (socket === pair.inviter) {
                const payload = { _cmd: 'tradeStarted', tradeName, userRefId: userId };
                sendJson(pair.inviter, payload);
                sendJson(pair.invitee, payload);
            }
            if (tradeStartedIds[tradeName].size >= 2) {
                const ready = { _cmd: 'allTradePlayersReady', tradeName };
                sendJson(pair.inviter, ready);
                sendJson(pair.invitee, ready);
            }
            break;
        }
        case 'addToCart': {
            const userRefId = params.userRefId;
            const assetId = params.assetId;
            const payload = { _cmd: 'addedToCart', userRefId, assetId };
            const tnp = _tradeNameAndPairForSocket(socket);
            if (tnp) {
                const { tname, pair } = tnp;
                payload.tradeName = tname;
                if (tradeCurrentResponder[tname] === userId) {
                    tradeResponderModifiedCart[tname] = true;
                }
                const uid = parseInt(userRefId) || 0;
                const aid = parseInt(assetId) || 0;
                if (tradeCarts[tname] && uid && aid) {
                    if (!tradeCarts[tname][uid]) tradeCarts[tname][uid] = new Set();
                    tradeCarts[tname][uid].add(aid);
                }
                const other = socket === pair.invitee ? pair.inviter : pair.invitee;
                if (other) sendJson(other, payload);
            }
            sendJson(socket, payload);
            break;
        }
        case 'removeFromCart': {
            const userRefId = params.userRefId;
            const assetId = params.assetId;
            const payload = { _cmd: 'removedFromCart', userRefId, assetId };
            const tnp = _tradeNameAndPairForSocket(socket);
            if (tnp) {
                const { tname, pair } = tnp;
                payload.tradeName = tname;
                if (tradeCurrentResponder[tname] === userId) {
                    tradeResponderModifiedCart[tname] = true;
                }
                const uid = parseInt(userRefId) || 0;
                const aid = parseInt(assetId) || 0;
                if (tradeCarts[tname] && uid && tradeCarts[tname][uid]) {
                    tradeCarts[tname][uid].delete(aid);
                }
                const other = socket === pair.invitee ? pair.inviter : pair.invitee;
                if (other) sendJson(other, payload);
            }
            sendJson(socket, payload);
            break;
        }
        case 'makeOffer': {
            const offererId = userId;
            const tnp = _tradeNameAndPairForSocket(socket);
            if (!tnp) return;
            const { tname, pair } = tnp;
            const other = socket === pair.invitee ? pair.inviter : pair.invitee;
            const responderId = other ? other.userId : 0;

            const currentResponder = tradeCurrentResponder[tname];
            const responderModified = tradeResponderModifiedCart[tname];

            // Treat as accept when responder makes offer without modifying cart
            if (currentResponder !== undefined && offererId === currentResponder
                && !tradeResponderAccepted[tname] && !responderModified) {
                console.log(`[SFS tradeXt] makeOffer from responder ${offererId} (no cart change) -> accept`);
                const acceptPayload = { _cmd: 'offerAccepted', tradeName: tname, userRefId: offererId, code: '1' };
                sendJson(pair.inviter, acceptPayload);
                sendJson(pair.invitee, acceptPayload);
                tradeResponderAccepted[tname] = true;
                return;
            }

            tradeCurrentOfferer[tname] = offererId;
            tradeCurrentResponder[tname] = responderId;
            delete tradeResponderAccepted[tname];
            delete tradeResponderModifiedCart[tname];

            const payload = {
                _cmd: 'offerMade',
                tradeName: tname,
                userRefId: String(responderId),
                code: '0',
            };
            if (other) sendJson(other, payload);
            sendJson(socket, payload);
            // Resend to responder after short delay
            if (other) {
                setTimeout(() => sendJson(other, payload), 250);
            }
            break;
        }
        case 'confirmTransaction': {
            const userRefId = userId;
            const tnp = _tradeNameAndPairForSocket(socket);
            if (!tnp) return;
            const { tname, pair } = tnp;
            const code = '1';

            const responderId = tradeCurrentResponder[tname];
            const accepted = tradeResponderAccepted[tname];

            // Phase 1: responder accepts -> send offerAccepted
            if (userRefId === responderId && !accepted) {
                const acceptPayload = { _cmd: 'offerAccepted', tradeName: tname, userRefId, code };
                sendJson(pair.inviter, acceptPayload);
                sendJson(pair.invitee, acceptPayload);
                tradeResponderAccepted[tname] = true;
                return;
            }

            // Phase 2: both must confirm
            if (accepted) {
                if (!tradeConfirmedIds[tname]) tradeConfirmedIds[tname] = new Set();
                tradeConfirmedIds[tname].add(userRefId);

                if (tradeConfirmedIds[tname].size >= 2) {
                    const accountA = pair.inviter.userId;
                    const accountB = pair.invitee.userId;
                    const cartA = Array.from((tradeCarts[tname] || {})[accountA] || []);
                    const cartB = Array.from((tradeCarts[tname] || {})[accountB] || []);
                    try {
                        _executeTradeTransfer(accountA, accountB, cartA, cartB);
                        console.log(`[SFS tradeXt] Trade DB transfer: ${accountA} <-> ${accountB}, ${cartA.length} + ${cartB.length} assets`);
                    } catch (e) {
                        console.error(`[SFS tradeXt] Trade transfer error: ${e.message}`);
                    }
                    const confirmed = { _cmd: 'transactionConfirmed', tradeName: tname, code };
                    sendJson(pair.inviter, confirmed);
                    sendJson(pair.invitee, confirmed);
                    _cleanupTrade(tname);
                }
            }
            break;
        }
        case 'quitTrade': {
            const userRefId = parseInt(params.userRefId) || 0;
            const tnp = _tradeNameAndPairForSocket(socket);
            if (tnp) {
                const { tname, pair } = tnp;
                const quitPayload = { _cmd: 'tradeQuit', userRefId, reason: 'quit' };
                sendJson(pair.inviter, quitPayload);
                sendJson(pair.invitee, quitPayload);
                _cleanupTrade(tname);
            }
            break;
        }
        case 'getBadgeList':
            sendJson(socket, { _cmd: 'tradeBadgeList', badgeList: '' });
            break;
        default:
            console.log(`[SFS tradeXt] Unknown command: ${command}`);
            sendJson(socket, { _cmd: 'unknownCommand' });
    }
}

// 式式式 Buddy Extension 式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式式

function _getBuddyIds(accountId) {
    return buddies[accountId] ? Array.from(buddies[accountId]) : [];
}

function _addBuddy(accountA, accountB) {
    if (!buddies[accountA]) buddies[accountA] = new Set();
    if (!buddies[accountB]) buddies[accountB] = new Set();
    buddies[accountA].add(accountB);
    buddies[accountB].add(accountA);
    // Persist buddy lists to user data
    const userA = users[accountA];
    const userB = users[accountB];
    if (userA) { userA.buddyList = Array.from(buddies[accountA]); saveUserData(accountA); }
    if (userB) { userB.buddyList = Array.from(buddies[accountB]); saveUserData(accountB); }
}

function _removeBuddy(accountA, accountB) {
    if (buddies[accountA]) buddies[accountA].delete(accountB);
    if (buddies[accountB]) buddies[accountB].delete(accountA);
    const userA = users[accountA];
    const userB = users[accountB];
    if (userA) { userA.buddyList = Array.from(buddies[accountA] || []); saveUserData(accountA); }
    if (userB) { userB.buddyList = Array.from(buddies[accountB] || []); saveUserData(accountB); }
}

function handleBuddyExtension(socket, command, params) {
    const userId = socket.userId;

    switch (command) {
        case 'getBuddyList': {
            if (!userId) {
                sendJson(socket, { _cmd: 'buddyListLoaded', buddyList: [] });
                return;
            }
            const buddyIds = _getBuddyIds(userId);
            const buddyList = buddyIds.map(bid => {
                const u = users[bid] || {};
                const online = !!socketMap[bid] && !socketMap[bid].destroyed;
                return {
                    username: u.username || 'Unknown',
                    status: online ? 'online' : 'offline',
                    userRefId: String(bid),
                    avatarId: u.avatarId || 1,
                    nmp: u.nmp || 0,
                };
            });
            sendJson(socket, { _cmd: 'buddyListLoaded', buddyList });
            break;
        }
        case 'getBuddyInvitationList':
        case 'loadInvitations': {
            const myUsername = (socket.userName || '').trim().toLowerCase();
            const pendingInviter = pendingBuddyInvites[myUsername];
            const invitations = pendingInviter ? [{ username: pendingInviter }] : [];
            sendJson(socket, {
                _cmd: 'invitationsLoaded',
                invitations,
                rejectedInvitations: [],
                acceptedInvitations: [],
            });
            break;
        }
        case 'getRecentlyPlayedList':
            sendJson(socket, { _cmd: 'recentlyPlayedListResponse', players: [] });
            break;
        case 'inviteBuddy': {
            const buddyName = (params.buddy || '').trim();
            const buddySocket = findSocketByUsername(buddyName);
            if (buddySocket && buddySocket !== socket) {
                const inviterName = socket.userName || 'Unknown';
                pendingBuddyInvites[buddyName.toLowerCase()] = inviterName;
                sendJson(buddySocket, { _cmd: 'buddyInvitationRequest', inviter: inviterName });
                sendJson(socket, { _cmd: 'buddyInvited' });
                console.log(`[SFS buddy] inviteBuddy: ${inviterName} -> ${buddyName}`);
            } else {
                sendJson(socket, { _cmd: 'buddyDoesNotExist', username: buddyName });
            }
            break;
        }
        case 'replyBuddyInvitation': {
            let inviterName = (params.buddy || params.inviterName || '').trim();
            const accept = params.accept || false;
            const myUsername = (socket.userName || '').trim().toLowerCase();

            if (!inviterName && myUsername) {
                inviterName = pendingBuddyInvites[myUsername] || '';
            }
            delete pendingBuddyInvites[myUsername];

            const inviterSocket = inviterName ? findSocketByUsername(inviterName) : null;
            console.log(`[SFS buddy] replyBuddyInvitation: inviter=${inviterName}, accept=${accept}`);

            if (accept && inviterSocket && userId && inviterSocket.userId) {
                _addBuddy(inviterSocket.userId, userId);
                // Notify both
                const myAvatarId = (users[userId] || {}).avatarId || 1;
                const myNmp = (users[userId] || {}).nmp || 0;
                sendJson(inviterSocket, {
                    _cmd: 'buddyInvitationAccepted',
                    username: socket.userName || 'Unknown',
                    userRefId: userId,
                    avatarId: myAvatarId,
                    status: 'online',
                    nmp: myNmp,
                });
                sendJson(socket, {
                    _cmd: 'buddyInvitationAccepted',
                    username: inviterSocket.userName || 'Unknown',
                    userRefId: inviterSocket.userId,
                    avatarId: (users[inviterSocket.userId] || {}).avatarId || 1,
                    status: 'online',
                    nmp: (users[inviterSocket.userId] || {}).nmp || 0,
                });
            } else if (!accept && inviterSocket) {
                sendJson(inviterSocket, {
                    _cmd: 'buddyInvitationRejected',
                    username: socket.userName || 'Unknown',
                });
            }
            break;
        }
        case 'removeBuddy': {
            const buddyRefId = parseInt(params.buddyRefId) || 0;
            if (!userId || buddyRefId <= 0) return;
            _removeBuddy(userId, buddyRefId);
            // Notify the other user if online
            const buddySocket = socketMap[buddyRefId];
            if (buddySocket && !buddySocket.destroyed) {
                sendJson(buddySocket, { _cmd: 'buddyRemoved', userRefId: userId });
            }
            sendJson(socket, { _cmd: 'buddyRemoved', userRefId: buddyRefId });
            break;
        }
        default:
            console.log(`[SFS buddyListXt] Unknown command: ${command}`);
            sendJson(socket, { _cmd: 'unknownCommand' });
    }
}

// Load existing user data at startup

module.exports = handleExtensionCommand;
