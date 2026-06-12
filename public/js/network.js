// RelayNet: relay-layer WebSocket client (DESIGN.md §F, v2). Strictly
// game-agnostic — game payloads travel opaquely inside `d` and are never
// inspected here. JSON text frames over ws(s)://host/ws.

// Normalize a user-entered server address into a relay ws URL. Bare
// "host:port" is assumed plain ws (LAN style); a bare domain without a port
// is assumed wss (tunnel/cloud style); explicit schemes win.
export function relayUrl(spec) {
  let s = (spec || '').trim();
  if (!s) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return proto + '://' + location.host + '/ws';
  }
  let secure = null;
  for (const [prefix, sec] of [['https://', true], ['wss://', true], ['http://', false], ['ws://', false]]) {
    if (s.toLowerCase().startsWith(prefix)) {
      secure = sec;
      s = s.slice(prefix.length);
      break;
    }
  }
  s = s.replace(/[/?#].*$/, '').replace(/\s+/g, '');
  if (secure === null) secure = !/:\d+$/.test(s);
  return (secure ? 'wss' : 'ws') + '://' + s + '/ws';
}

export class RelayNet {
  constructor() {
    this.ws = null;
    this.connectedTo = '';  // serverSpec this socket was opened with ('' = same origin)
    // Callback properties, assigned by main.js.
    this.onHosted = null;   // ({room, id})
    this.onAccepted = null; // ({id, hostId})
    this.onError = null;    // (code) — 'no-room' | 'full' | 'taken' | 'bad-name'
    this.onRooms = null;    // (rooms) — [{room, players, meta}]
    this.onMsg = null;      // (d, fromId|null) — fromId set only on the host side
    this.onPeerIn = null;   // (id)
    this.onPeerOut = null;  // (id)
    this.onPromote = null;  // ({room, oldHostId, peers})
    this.onNewHost = null;  // ({hostId, oldHostId})
    this.onClose = null;    // ()
  }

  // Resolves when the socket opens, rejects if it errors/closes before that.
  // onClose only fires for sockets that actually opened.
  // serverSpec: optional "host[:port]" or full http(s)/ws(s) URL; empty/omitted
  // means same-origin (the page was served by the relay itself).
  connect(serverSpec) {
    this.connectedTo = (serverSpec || '').trim();
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(relayUrl(serverSpec));
      } catch (err) {
        reject(err);
        return;
      }
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        console.log('[vc] ws connected');
        resolve();
      };
      ws.onerror = () => {
        if (!opened) {
          reject(new Error('WebSocket connection failed'));
        } else {
          console.error('[vc] ws error');
        }
      };
      ws.onclose = () => {
        this.ws = null;
        if (!opened) {
          reject(new Error('WebSocket closed before opening'));
          return;
        }
        if (this.onClose) this.onClose();
      };
      ws.onmessage = (ev) => this._handleMessage(ev.data);
    });
  }

  _handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (err) {
      return; // ignore malformed frames
    }
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'hosted':
        if (this.onHosted) this.onHosted({ room: msg.room, id: msg.id });
        break;
      case 'accepted':
        if (this.onAccepted) this.onAccepted({ id: msg.id, hostId: msg.hostId });
        break;
      case 'error':
        if (this.onError) this.onError(msg.code);
        break;
      case 'rooms':
        if (this.onRooms) this.onRooms(Array.isArray(msg.rooms) ? msg.rooms : []);
        break;
      case 'msg':
        // Host receives {t:'msg', from, d}; members receive {t:'msg', d}.
        if (this.onMsg) this.onMsg(msg.d, msg.from != null ? msg.from : null);
        break;
      case 'peer-in':
        if (this.onPeerIn) this.onPeerIn(msg.id);
        break;
      case 'peer-out':
        if (this.onPeerOut) this.onPeerOut(msg.id);
        break;
      case 'promote':
        if (this.onPromote) {
          this.onPromote({ room: msg.room, oldHostId: msg.oldHostId, peers: msg.peers });
        }
        break;
      case 'newhost':
        if (this.onNewHost) this.onNewHost({ hostId: msg.hostId, oldHostId: msg.oldHostId });
        break;
      default:
        break;
    }
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  // opts: {room, public=true, meta=null}. room = the user-chosen room name
  // (full Unicode — the relay owns normalization and `bad-name`/`taken`
  // rejection). meta is opaque to the relay (≤256 chars serialized); clients
  // use the {n: hostName} convention.
  hostRoom(opts) {
    const o = opts || {};
    this._send({
      t: 'host',
      room: String(o.room == null ? '' : o.room),
      public: o.public === undefined ? true : !!o.public,
      meta: o.meta === undefined ? null : o.meta,
    });
  }

  // Join by room name, sent verbatim apart from trimming — the relay does the
  // NFC/whitespace/case-insensitive normalization, never the client.
  joinRoom(name) {
    this._send({ t: 'join', room: String(name == null ? '' : name).trim() });
  }

  // Allowed from any connection (even unbound); reply arrives via onRooms.
  listRooms() {
    this._send({ t: 'list' });
  }

  // member -> host
  sendToHost(d) {
    this._send({ t: 'msg', d });
  }

  // host -> one member
  sendTo(id, d) {
    this._send({ t: 'msg', to: id, d });
  }

  // host -> all members (optionally excluding one)
  cast(d, exceptId) {
    if (exceptId == null) this._send({ t: 'cast', d });
    else this._send({ t: 'cast', d, except: exceptId });
  }

  close() {
    if (this.ws) this.ws.close();
  }
}
