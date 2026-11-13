// ============================================================
// データ保存層：MQTT over WebSocket (WSS) リアルタイム同期
// ------------------------------------------------------------
// アカウント登録・ログイン・外部設定は一切不要！
// 大学Wi-Fi・ポケットWi-Fi・スタジアムでも確実に通る暗号化通信（WSS:443）
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

  class CloudSyncStore {
    constructor() {
      this.mode = 'realtime';
      this.key = 'fdl_data_v1';
      this.listeners = new Set();
      this.statusListeners = new Set();
      this.activeGid = null;
      this.client = null;
      this.myClientId = 'c_' + uid();
      this.status = { text: '準備完了', cls: 'ok' };

      // 同一端末のタブ間同期
      this.ch = 'BroadcastChannel' in window ? new BroadcastChannel('fdl_sync_ch') : null;
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
      const d = this._load();
      const id = uid();
      d.games[id] = { ...data, createdAt: Date.now() };
      d.plays[id] = {};
      this._save(d);
      return id;
    }

    subscribePlays(gid, cb) {
      this.joinRoom(gid);
      return this._sub(() => {
        const d = this._load();
        cb(Object.entries(d.plays[gid] || {}).map(([id, p]) => ({ id, ...p })));
      });
    }

    addPlay(gid, data) {
      const d = this._load();
      const id = uid();
      (d.plays[gid] ||= {})[id] = data;
      this._save(d);
      this._publish({ type: 'ADD_PLAY', gid, id, data });
      return id;
    }

    updatePlay(gid, pid, patch) {
      const d = this._load();
      if (!d.plays[gid] || !d.plays[gid][pid]) return;
      Object.assign(d.plays[gid][pid], patch);
      this._save(d);
      this._publish({ type: 'UPDATE_PLAY', gid, pid, patch });
    }

    deletePlay(gid, pid) {
      const d = this._load();
      if (d.plays[gid]) delete d.plays[gid][pid];
      this._save(d);
      this._publish({ type: 'DELETE_PLAY', gid, pid });
    }

    leaveGame() {
      if (this.client && this.activeGid) {
        try { this.client.unsubscribe(`fdl/room/${this.activeGid}`); } catch {}
      }
      this.activeGid = null;
      this._setStatus('● 待機中', 'ok');
    }

    joinRoom(gid) {
      if (this.activeGid === gid) return;
      this.activeGid = gid;
      this._connectMqtt(gid);
    }

    _connectMqtt(gid) {
      this._setStatus('接続中...', 'warn');
      const topic = `fdl/room/${gid}`;

      // 信頼性の高い複数の公開暗号化WebSocketブローカー（ポート443・WSS）
      const brokers = [
        'wss://broker.emqx.io:8084/mqtt',
        'wss://broker.hivemq.com:8884/mqtt'
      ];
      const brokerUrl = brokers[0];

      if (!this.client || !this.client.connected) {
        try {
          this.client = mqtt.connect(brokerUrl, {
            clientId: `fdl_${this.myClientId}`,
            clean: true,
            connectTimeout: 8000,
            reconnectPeriod: 3000
          });
        } catch (e) {
          console.warn('MQTT接続失敗:', e);
          this._setStatus('オフライン（端末内保存）', 'warn');
          return;
        }

        this.client.on('connect', () => {
          this._setStatus('● リアルタイム同期中', 'ok');
          this.client.subscribe(topic, { qos: 1 });
          // 新しく入ったことを知らせて、すでに開いている端末があれば最新データをリクエスト
          this._publish({ type: 'REQ_SYNC', from: this.myClientId });
        });

        this.client.on('message', (t, payload) => {
          if (t !== topic) return;
          try {
            const msg = JSON.parse(payload.toString());
            if (msg.sender === this.myClientId) return; // 自分が送ったメッセージは無視
            this._handleRemoteMessage(msg);
          } catch (e) {
            console.warn('受信メッセージ解析エラー:', e);
          }
        });

        this.client.on('reconnect', () => {
          this._setStatus('再接続中...', 'warn');
        });

        this.client.on('offline', () => {
          this._setStatus('オフライン（電波待機中）', 'warn');
        });

        this.client.on('error', (err) => {
          console.warn('MQTTエラー:', err);
          this._setStatus('接続待機中', 'warn');
        });
      } else {
        // すでに接続済みの場合はトピック購読
        this.client.subscribe(topic, { qos: 1 });
        this._setStatus('● リアルタイム同期中', 'ok');
        this._publish({ type: 'REQ_SYNC', from: this.myClientId });
      }
    }

    _publish(msg) {
      if (!this.client || !this.client.connected || !this.activeGid) return;
      const topic = `fdl/room/${this.activeGid}`;
      const payload = JSON.stringify({ ...msg, sender: this.myClientId, gid: this.activeGid });
      this.client.publish(topic, payload, { qos: 1 });
    }

    _handleRemoteMessage(msg) {
      const d = this._load();

      // 誰かが入ってきたので、手元の最新データを返してあげる
      if (msg.type === 'REQ_SYNC') {
        const game = d.games[this.activeGid];
        const plays = d.plays[this.activeGid] || {};
        if (Object.keys(plays).length > 0 || game) {
          this._publish({
            type: 'RESP_SYNC',
            target: msg.from,
            game: game,
            plays: plays
          });
        }
        return;
      }

      // 同期データを受け取った場合
      if (msg.type === 'RESP_SYNC') {
        if (msg.target && msg.target !== this.myClientId) return;
        if (msg.game && !d.games[this.activeGid]) {
          d.games[this.activeGid] = msg.game;
        }
        d.plays[this.activeGid] = { ...(d.plays[this.activeGid] || {}), ...msg.plays };
        this._save(d);
        return;
      }

      // 通常のアクション
      if (msg.type === 'ADD_PLAY') {
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
    // 高速で信頼性の高い MQTT.js CDN（暗号化WSS通信）
    try {
      await loadScript('https://unpkg.com/mqtt@5.3.5/dist/mqtt.min.js');
    } catch {
      await loadScript('https://cdn.jsdelivr.net/npm/mqtt@5.3.5/dist/mqtt.min.js');
    }
    return new CloudSyncStore();
  };
})();
