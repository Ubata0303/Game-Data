// ============================================================
// データ保存層：MQTT over WebSocket (WSS) リアルタイム同期
// ------------------------------------------------------------
// アカウント登録・ログイン・外部設定は一切不要！
// オフラインキュー機能搭載：ネット切断中に打ち込んだデータは端末に保存され、
// 再接続した瞬間に自動で全件送信＆他端末と完全同期されます。
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
      this.pendingQueue = [];
      this._loadPending();

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

    _loadPending() {
      try {
        this.pendingQueue = JSON.parse(localStorage.getItem('fdl_pending_v1')) || [];
      } catch {
        this.pendingQueue = [];
      }
    }
    _savePending() {
      try {
        localStorage.setItem('fdl_pending_v1', JSON.stringify(this.pendingQueue));
      } catch {}
    }

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

    updateGame(gid, patch) {
      const d = this._load();
      if (!d.games[gid]) return;
      Object.assign(d.games[gid], patch);
      this._save(d);
      this._publish({ type: 'UPDATE_GAME', gid, patch });
    }

    deleteGame(gid) {
      const d = this._load();
      if (d.games[gid]) {
        delete d.games[gid];
        delete d.plays[gid];
        this._save(d);
        this._publish({ type: 'DELETE_GAME', gid });
      }
    }

    subscribePlays(gid, cb) {
      this.joinRoom(gid);
      return this._sub(() => {
        const d = this._load();
        const pendingPids = new Set(this.pendingQueue.map((m) => m.pid || m.id).filter(Boolean));
        cb(Object.entries(d.plays[gid] || {}).map(([id, p]) => ({
          id,
          ...p,
          _pending: pendingPids.has(id) // 未送信のプレーにフラグを付与
        })));
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
            reconnectPeriod: 2500
          });
        } catch (e) {
          console.warn('MQTT接続失敗:', e);
          this._updateOfflineStatus();
          return;
        }

        this.client.on('connect', () => {
          this.client.subscribe(topic, { qos: 1 });
          // 接続した瞬間に、未送信キューをすべて一気に再送！
          this._flushPending();
          // 他端末へ最新同期をリクエスト
          this._sendDirect({ type: 'REQ_SYNC', from: this.myClientId });
          this._setStatus('● リアルタイム同期中', 'ok');
        });

        this.client.on('message', (t, payload) => {
          if (t !== topic) return;
          try {
            const msg = JSON.parse(payload.toString());
            if (msg.sender === this.myClientId) return; // 自分が送ったものは無視
            this._handleRemoteMessage(msg);
          } catch (e) {
            console.warn('受信メッセージ解析エラー:', e);
          }
        });

        this.client.on('reconnect', () => {
          this._updateOfflineStatus('再接続中...');
        });

        this.client.on('offline', () => {
          this._updateOfflineStatus('オフライン');
        });

        this.client.on('error', (err) => {
          console.warn('MQTTエラー:', err);
          this._updateOfflineStatus('接続待機中');
        });
      } else {
        this.client.subscribe(topic, { qos: 1 });
        this._flushPending();
        this._sendDirect({ type: 'REQ_SYNC', from: this.myClientId });
        this._setStatus('● リアルタイム同期中', 'ok');
      }
    }

    _updateOfflineStatus(prefix = 'オフライン') {
      const count = this.pendingQueue.length;
      if (count > 0) {
        this._setStatus(`${prefix}（未送信 ${count}件）`, 'warn');
      } else {
        this._setStatus(`${prefix}（電波待機中）`, 'warn');
      }
    }

    _sendDirect(msg) {
      if (!this.client || !this.client.connected || !this.activeGid) return;
      const topic = `fdl/room/${this.activeGid}`;
      const payload = JSON.stringify({ ...msg, sender: this.myClientId, gid: this.activeGid });
      this.client.publish(topic, payload, { qos: 1 });
    }

    _publish(msg) {
      if (!this.activeGid) return;
      const fullMsg = { ...msg, sender: this.myClientId, gid: this.activeGid, time: Date.now() };

      if (!this.client || !this.client.connected) {
        // 回線切断中：未送信キューに保存
        this.pendingQueue.push(fullMsg);
        this._savePending();
        this._updateOfflineStatus();
        this._emit(); // 画面の ⏳ アイコンを更新
        return;
      }

      const topic = `fdl/room/${this.activeGid}`;
      const payload = JSON.stringify(fullMsg);
      this.client.publish(topic, payload, { qos: 1 });
    }

    // 接続復帰時に未送信キューを一気に送信＆他端末と完全マージ
    _flushPending() {
      if (!this.client || !this.client.connected || !this.activeGid) return;
      const topic = `fdl/room/${this.activeGid}`;

      if (this.pendingQueue.length > 0) {
        console.log(`未送信データ ${this.pendingQueue.length} 件を一括送信中...`);
        while (this.pendingQueue.length > 0) {
          const msg = this.pendingQueue.shift();
          try {
            this.client.publish(topic, JSON.stringify(msg), { qos: 1 });
          } catch (e) {
            console.warn('再送エラー:', e);
          }
        }
        this._savePending();
      }

      // 念のため、手元の最新データ一式を全端末へブロードキャスト（相互補完）
      const d = this._load();
      const game = d.games[this.activeGid];
      const plays = d.plays[this.activeGid] || {};
      if (Object.keys(plays).length > 0) {
        this.client.publish(topic, JSON.stringify({
          type: 'SYNC_FULL',
          sender: this.myClientId,
          gid: this.activeGid,
          game,
          plays
        }), { qos: 1 });
      }

      this._emit(); // ⏳ マークを解除
    }

    _handleRemoteMessage(msg) {
      const d = this._load();

      // 他の端末が入ってきたので手元の最新データを返信
      if (msg.type === 'REQ_SYNC') {
        const game = d.games[this.activeGid];
        const plays = d.plays[this.activeGid] || {};
        if (Object.keys(plays).length > 0 || game) {
          this._sendDirect({
            type: 'RESP_SYNC',
            target: msg.from,
            game: game,
            plays: plays
          });
        }
        return;
      }

      // 初回同期データを受信
      if (msg.type === 'RESP_SYNC') {
        if (msg.target && msg.target !== this.myClientId) return;
        if (msg.game && !d.games[this.activeGid]) {
          d.games[this.activeGid] = msg.game;
        }
        d.plays[this.activeGid] = { ...(msg.plays || {}), ...(d.plays[this.activeGid] || {}) };
        this._save(d);
        return;
      }

      // 回線復帰時のフル同期（相互補完マージ）
      if (msg.type === 'SYNC_FULL') {
        if (msg.game && !d.games[this.activeGid]) {
          d.games[this.activeGid] = msg.game;
        }
        const localPlays = d.plays[this.activeGid] || {};
        const remotePlays = msg.plays || {};
        const merged = { ...localPlays };

        Object.entries(remotePlays).forEach(([pid, rPlay]) => {
          const lPlay = merged[pid];
          if (!lPlay) {
            merged[pid] = rPlay;
          } else {
            // 両方にある場合は各項目をマージ
            merged[pid] = { ...lPlay, ...rPlay, updatedAt: Math.max(lPlay.updatedAt || 0, rPlay.updatedAt || 0) };
          }
        });

        d.plays[this.activeGid] = merged;
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
      } else if (msg.type === 'UPDATE_GAME') {
        if (d.games[msg.gid]) {
          Object.assign(d.games[msg.gid], msg.patch);
          this._save(d);
        }
      } else if (msg.type === 'DELETE_GAME') {
        if (d.games[msg.gid]) {
          delete d.games[msg.gid];
          delete d.plays[msg.gid];
          this._save(d);
        }
      }
    }
  }

  window.createStore = async function () {
    try {
      await loadScript('https://unpkg.com/mqtt@5.3.5/dist/mqtt.min.js');
    } catch {
      await loadScript('https://cdn.jsdelivr.net/npm/mqtt@5.3.5/dist/mqtt.min.js');
    }
    return new CloudSyncStore();
  };
})();
