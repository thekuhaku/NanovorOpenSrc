# Nanovor Server

A Node.js server that emulates the original **SmartFoxServer** and **Service Request Broker (SRB)** backend for the Nanovor game. It allows the official (or compatible) Nanovor client to connect, log in, and play using HTTP/XML-RPC and a custom TCP protocol.

## Features

- **SRB (XML-RPC)** - Login/connect, session tokens, service endpoints
- **HTTP API** - Account, stats, bankfe, assets, manifests, device endpoints
- **SFS TCP server** - SmartFoxServer-style socket protocol (XML/JSON messages): login, rooms, extensions (loginXt, gameXt, chatXt, etc.), battles

## Requirements

- **Node.js** 16+ (tested on 20.x, 25.x)
- **npm** (for dependencies)

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start
# or
node NanoServ.js
```

**HTTP server** runs on **port 8443**.  
**SFS (game socket) server** runs on **port 9339**.

---

## Windows PowerShell

If you see:

```text
running scripts is disabled on this system
```

when running `npm install` or `npm start`, use one of these:

**Option A - Use Node to run npm (no policy change):**
```powershell
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" install
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" start
```

**Option B - Allow scripts for your user (once):**
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```
Then `npm install` and `npm start` work as usual.

**Option C - Use Command Prompt (cmd)** for `npm`; no script policy there.

---

## Configuration

| Item | Purpose |
|------|--------|
| `version.INI` | Server version (major, minor, build). Optional; defaults to 0.0.0 if missing. |
| `Config/` | XML configs: `connection_settings.xml`, `LoginScreenConfig.xml`, etc. |
| `UserData/` | Created at runtime; one JSON file per user (by username). **Not in git** (see `.gitignore`). |
| `Manifests/` | Root manifests; route-specific copies live under `routes/Manifests/`. |

---

## Data & IDs

- **Account IDs** and **EM (Evolution Module) asset IDs** are **integers** only (no UUIDs). New IDs come from in-memory counters (`state.js`); existing users/EMs are migrated from legacy string IDs on load.
- **UserData** is stored as JSON in `UserData/<username>.json`. It is created on first login and updated when the user logs out or when inventory/stats change.

---

## Project Structure

```
NanovorOpenSrc/
|-- NanoServ.js           # Entry point: Express app, SFS server, route registration, loadAllUserData, listen & shutdown
|-- package.json
|-- version.INI            # Optional; server version
|-- config.js              # Loads version.INI and Config/*.xml
|-- state.js               # In-memory state: users, sessions, gameRooms, socketMap, battleRooms; nextAccountId, nextEmAssetId
|-- user.js                # findSessionByToken, createUserProfile, save/load UserData (integer IDs, EM migration)
|-- battle.js              # Battle helpers: sendMessageToUser, broadcastToBattle
|-- gameRooms.js           # createGameRoom, getUserGameRoom, advanceTurn
|-- eslint.config.js       # ESLint 9 flat config
|-- .gitignore             # node_modules/, UserData/
|-- lib/
|   |-- srb.js             # SRB XML-RPC: extractParamsFromRequest, createSrbResponse
|   +-- utils.js           # generateToken, formatDateForNanovor, etc.
|-- routes/
|   |-- index.js           # registerRoutes(app)
|   |-- srb.js             # POST /xmlrpc (SRB connect)
|   |-- shard.js           # GET /scws/ (shard list)
|   |-- rest.js            # bankfe, account, assets, manifests, test-login, guest login, etc.
|   +-- Manifests/         # Route-specific manifest/Client XML (e.g. sensei-players.xml)
|-- sfs/                   # SmartFoxServer TCP emulator
|   |-- server.js          # createSfsServer(), sfsPort; socket lifecycle, message dispatch
|   +-- handlers/
|       |-- xml.js         # verChk, login, autoJoin, getRmList, logout, ...
|       |-- json.js        # handleJsonMessage -> extension
|       |-- string.js      # handleStringMessage
|       |-- extension.js   # loginXt, chatXt, gameXt (addEm, removeEm, setSwarm, ...)
|       +-- gameXt.js      # Battles, sensei/tutorial, swarm, ready, turn flow
|-- scripts/
|   +-- smoke-test.js      # HTTP smoke tests (server must be running)
|-- Config/                # XML config files
|-- Manifests/             # Root manifest/asset XML
+-- UserData/              # Runtime only; user JSON files (gitignored)
```

---

## Development

```bash
npm run lint   # ESLint (flat config, ESLint 9)
npm test       # Smoke tests - start the server first, then run (or use CI)
```

CI (`.github/workflows/ci.yml`) runs on push/PR: `npm ci` then `npm run lint` then start server then `node scripts/smoke-test.js`.

---

## TODO / Known Gaps

Based on the decompiled client (SmartFox extensions, GameState, TradeState, chat/trade/battle handlers), the following are missing or incomplete:

### Battle (gameXt)
- **Matchmaking** - `createQuickBattle` / `cancelQuickBattle` (find random opponent); currently only sensei/invited battles.
- **Invited battles** - Full `createGame`, `inviteUser`, `replyInvitation` flow; invitation timeouts and errors.
- **Battle lifecycle** - `getBadgeList`, `kickPlayerOut`, `declinedToWatch`; proper `roomDestroyed`, `playerKickedOut`, `playerQuitGame` broadcast.
- **Combat flow** - All round/attack events: `killNanovor`, `swapNanovor`, `blockSwap`, `selectNanovor`, `setRoundInfo`, `performAttack`, `roundCompleted`, `showGameResults`; full parity with client handlers.
- **Tutorial / sensei** - Full parity (rewards, flow edge cases); test with client.

### Chat (chatXt)
- **Rooms** - Real chat room creation/list; currently only stub `getChatRoomList` with static data.
- **Invitations** - `inviteToChat`, `replyChatInvitation`; server-side `chatInvitationRequest` / `chatInvitationResponse`.
- **Join / leave** - `joinChatRoom`, `exitChatRoom`, `removeUserFromChatRoom`; `chatRoomCreated`, `chatRoomJoined`, `userLeftChatRoom`, `userRemovedFromChatRoom`, `chatRoomDestroyed`.
- **Messages** - `sendChatMessage` and broadcast to room members; `chatRoomMemberList`.

### Trade (tradeXt)
- **Lifecycle** - `createTrade`, `inviteUserToTrade`, `replyInvitationToTrade`, `cancelTradeInvitation`; `tradeCreated`, `tradeInvitationRequest`, `tradeInvitationResponse`, `tradeInvitationCanceled`.
- **Session** - `joinAndGetCollections` (exchange collections with other player), `startTrade`; `collectionSet`, `tradeStarted`, `playerJoinTrade`, `otherPlayerJoinTrade`.
- **Cart and confirm** - `addToCart`, `removeFromCart`, `makeOffer`, `confirmTransaction`, `quitTrade`; `addedToCart`, `removedFromCart`, `offerMade`, `offerAccepted`, `transactionConfirmed`, `tradeQuit`, `tradeOver`.
- **Badges** - `getBadgeList` (stub exists); real badge data if needed for trade UI.

### Collection
- **HTTP** - bankfe account collections: ensure virmon + EM list and format match what the client expects (e.g. collection viewer, trade collectionSet).
- **SFS** - Collection data may be requested in trade context via `joinAndGetCollections`.

### Evolution (Evolve)
- **bankfe** - Client uses evolution/EvoManager and may call bankfe asset or evolution endpoints; verify evolution XML and evolve result endpoints (e.g. evolve game success/fail).
- **State** - Evolve game flow (EvoGameState, EvoTreeState) may need server-side support or is client-only; confirm from client calls.

### Buddy list (buddyListXt)
- **List** - `getBuddyList` currently returns empty; real buddy list and online status.
- **Integration** - With chat/trade/battle invitations (invite by buddy).

### General
- **Persistence of ID counters** - `nextAccountId` and `nextEmAssetId` in-memory only; persist or derive from UserData on startup.
- **More tests** - Expand smoke tests (auth, account, assets, SFS login); add unit tests.
- **Security** - No HTTPS; tokens/passwords in plaintext. Local/dev only unless hardened.
- **Rate limiting** - No rate limiting on login or HTTP endpoints.
- **Documentation** - API docs (bankfe routes, SFS extension commands) for contributors.
- **Cleanup** - Stale sessions, old battle/trade/chat rooms; TTL or periodic cleanup.

---

## Ports

| Port | Service |
|------|--------|
| **8443** | HTTP (SRB, bankfe, account, assets, manifests, shard list, etc.) |
| **9339** | SFS TCP (game socket: login, rooms, extensions, battles). Same port used for HTTP manifest requests from the client. |

---

## License

Open source. See repository for details.
