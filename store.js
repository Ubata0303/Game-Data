// ============================================================
// データ保存層：PeerJS (WebRTC) を使用した P2P リアルタイム同期
// ------------------------------------------------------------
// アカウント登録・ログイン・外部サーバー設定は一切不要！
// 同じ試合URLを開いたPC・タブレット間で暗号化P2P通信で即座に同期します。
// ============================================================
(function () {
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('スクリプト読み込み失敗: ' + src));
      document.head.appendChild(s);
    });
  }

  class P2PStore {
    constructor() {
      this.mode = 'p2p';
      this.key = 'fdl_data_v1';
      this.listeners = new Set();
      this.statusListeners = new Set();
      this.activeGid = null;
      this.isHost = false;
      this.peer = null;
      this.hostConn = null;
      this.guestConns = new Map(); // peerId -> conn
      this.status = { text: '準備完了', cls: 'ok' };

      // 同一端末の複数タブ間同期
      this.ch = 'BroadcastChannel' in window ? new BroadcastChannel('fdl_sync_p2p') : null;
      if (this.ch) this.ch.onmessage = () => this._emit();
      window.addEventListener('storage', (e) => { if (e.key === this.key) this._emit(); });
    }

    _load() {
      try { return JSON.parse(localStorage.getItem(this.key)) || { games: {}, plays: {} }; }
      catch { return { games: {}, plays: {} }; }
    }
    _save(d) {
      localStorage.setItem(this.key, JSON.stringify(d));
      if (this.ch) this.ch.postMessage('u');
      this._emit();
    }
    _emit() { this.listeners.forEach((f) => f()); }
    _sub(fn) { this.listeners.add(fn); fn(); return () => this.listeners.delete(fn); }

    onStatusChange(cb) {
      this.statusListeners.add(cb);
      cb(this.status.text, this.status.cls);
      return () => this.statusListeners.delete(cb);
    }
    _setStatus(text, cls) {
      this.status = { text, cls };
      this.statusListeners.forEach((cb) => cb(text, cls));
    }

    subscribeGames(cb) {
      return this._sub(() => {
        const d = this._load();
        cb(Object.entries(d.games).map(([id, g]) => ({ id, ...g })).sort((a, b) => b.createdAt - a.createdAt));
      });
    }
    createGame(data) {
      const d = this._load(); const id = uid();
      d.games[id] = { ...data, createdAt: Date.now() };
      d.plays[id] = {};
      this._save(d); return id;
    }
    subscribePlays(gid, cb) {
      this.connectP2P(gid);
      return this._sub(() => {
        const d = this._load();
        cb(Object.entries(d.plays[gid] || {}).map(([id, p]) => ({ id, ...p })));
      });
    }

    addPlay(gid, data) {
      const d = this._load(); const id = uid();
      (d.plays[gid] ||= {})[id] = data;
      this._save(d);
      this._broadcast({ type: 'ADD_PLAY', gid, id, data });
      return id;
    }
    updatePlay(gid, pid, patch) {
      const d = this._load();
      if (!d.plays[gid] || !d.plays[gid][pid]) return;
      Object.assign(d.plays[gid][pid], patch);
      this._save(d);
      this._broadcast({ type: 'UPDATE_PLAY', gid, pid, patch });
    }
    deletePlay(gid, pid) {
      const d = this._load();
      if (d.plays[gid]) delete d.plays[gid][pid];
      this._save(d);
      this._broadcast({ type: 'DELETE_PLAY', gid, pid });
    }

    // ---------- P2P 通信制御 (PeerJS) ----------
    _cleanupPeer() {
      if (this.hostConn) { try { this.hostConn.close(); } catch {} this.hostConn = null; }
      this.guestConns.forEach((conn) => { try { conn.close(); } catch {} });
      this.guestConns.clear();
      if (this.peer) { try { this.peer.destroy(); } catch {} this.peer = null; }
      this.isHost = false;
    }

    leaveGame() {
      this._cleanupPeer();
      this.activeGid = null;
      this._setStatus('● 待機中', 'ok');
    }

    connectP2P(gid) {
      if (this.activeGid === gid && this.peer && !this.peer.destroyed) return;
      this._cleanupPeer();
      this.activeGid = gid;
      this._setStatus('接続中...', 'warn');

      const hostId = `fdl-v2-${gid}-host`;

      // まず自分が親機（ホスト）になれるか試す
      try {
        this.peer = new Peer(hostId, { debug: 1 });
      } catch (e) {
        console.warn('Peer作成エラー:', e);
        this._startGuest(gid, hostId);
        return;
      }

      this.peer.on('open', () => {
        // ホスト取得成功
        this.isHost = true;
        this._refreshHostStatus();
        this._setupHostListeners();
      });

      this.peer.on('error', (err) => {
        // 既に他の端末がホストとして開いている場合はゲストとして参加
        if (err.type === 'unavailable-id') {
          this._startGuest(gid, hostId);
        } else {
          console.warn('P2Pエラー:', err);
          this._setStatus('接続待機中', 'warn');
        }
      });
    }

    _setupHostListeners() {
      this.peer.on('connection', (conn) => {
        conn.on('open', () => {
          this.guestConns.set(conn.peer, conn);
          this._refreshHostStatus();

          // 接続してきた端末へ手元の最新データを丸ごと送信
          const d = this._load();
          conn.send({
            type: 'SYNC_ALL',
            game: d.games[this.activeGid],
            plays: d.plays[this.activeGid] || {}
          });
        });

        conn.on('data', (msg) => {
          this._handleRemoteMessage(msg);
          // 他の参加端末にも中継（ブロードキャスト）
          this.guestConns.forEach((c, peerId) => {
            if (peerId !== conn.peer && c.open) {
              try { c.send(msg); } catch {}
            }
          });
        });

        conn.on('close', () => {
          this.guestConns.delete(conn.peer);
          this._refreshHostStatus();
        });
      });
    }

    _startGuest(gid, hostId) {
      this._cleanupPeer();
      const guestId = `fdl-v2-${gid}-g-${Math.random().toString(36).slice(2, 9)}`;
      this.peer = new Peer(guestId, { debug: 1 });

      this.peer.on('open', () => {
        this._setStatus('ホストへ接続中...', 'warn');
        const conn = this.peer.connect(hostId, { reliable: true });
        this.hostConn = conn;

        conn.on('open', () => {
          this._setStatus('● 同期中（接続済）', 'ok');
        });

        conn.on('data', (msg) => {
          this._handleRemoteMessage(msg);
        });

        conn.on('close', () => {
          this._setStatus('ホスト切断（再接続待機）', 'warn');
          setTimeout(() => {
            if (this.activeGid === gid) this.connectP2P(gid);
          }, 2000);
        });
      });

      this.peer.on('error', (err) => {
        console.warn('ゲスト接続エラー:', err);
        setTimeout(() => {
          if (this.activeGid === gid) this.connectP2P(gid);
        }, 3000);
      });
    }

    _refreshHostStatus() {
      const count = this.guestConns.size;
      if (count === 0) {
        this._setStatus('○ 待機中（他端末の接続待ち）', 'warn');
      } else {
        this._setStatus(`● 同期中（接続: ${count + 1}台）`, 'ok');
      }
    }

    _broadcast(msg) {
      if (this.isHost) {
        this.guestConns.forEach((conn) => {
          if (conn.open) {
            try { conn.send(msg); } catch {}
          }
        });
      } else if (this.hostConn && this.hostConn.open) {
        try { this.hostConn.send(msg); } catch {}
      }
    }

    _handleRemoteMessage(msg) {
      const d = this._load();
      if (msg.type === 'SYNC_ALL') {
        if (msg.game && !d.games[this.activeGid]) {
          d.games[this.activeGid] = msg.game;
        }
        d.plays[this.activeGid] = { ...(d.plays[this.activeGid] || {}), ...msg.plays };
        this._save(d);
      } else if (msg.type === 'ADD_PLAY') {
        (d.plays[msg.gid] ||= {})[msg.id] = msg.data;
        this._save(d);
      } else if (msg.type === 'UPDATE_PLAY') {
        if (d.plays[msg.gid] && d.plays[msg.gid][msg.pid]) {
          Object.assign(d.plays[msg.gid][msg.pid], msg.patch);
          this._save(d);
        }
      } else if (msg.type === 'DELETE_PLAY') {
        if (d.plays[msg.gid]) {
          delete d.plays[msg.gid][msg.pid];
          this._save(d);
        }
      }
    }
  }

  window.createStore = async function () {
    // PeerJS の公式ライブラリ（CDN）を読み込む
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js');
    } catch {
      await loadScript('https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js');
    }
    return new P2PStore();
  };
})();
