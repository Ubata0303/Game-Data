// データ保存層：Firebase（クラウド同期）とローカル（お試し）の2種類を同じインターフェースで提供
(function () {
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('読み込み失敗: ' + src));
      document.head.appendChild(s);
    });
  }

  // ---------- ローカルモード（localStorage + BroadcastChannel） ----------
  class LocalStore {
    constructor() {
      this.mode = 'local';
      this.key = 'fdl_data_v1';
      this.listeners = new Set();
      this.ch = 'BroadcastChannel' in window ? new BroadcastChannel('fdl_sync') : null;
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
      return this._sub(() => {
        const d = this._load();
        cb(Object.entries(d.plays[gid] || {}).map(([id, p]) => ({ id, ...p })));
      });
    }
    addPlay(gid, data) {
      const d = this._load(); const id = uid();
      (d.plays[gid] ||= {})[id] = data;
      this._save(d); return id;
    }
    updatePlay(gid, pid, patch) {
      const d = this._load();
      if (!d.plays[gid] || !d.plays[gid][pid]) return;
      Object.assign(d.plays[gid][pid], patch);
      this._save(d);
    }
    deletePlay(gid, pid) {
      const d = this._load();
      if (d.plays[gid]) delete d.plays[gid][pid];
      this._save(d);
    }
  }

  // ---------- Firebase Firestore モード ----------
  class FirestoreStore {
    constructor(cfg) {
      this.mode = 'cloud';
      firebase.initializeApp(cfg);
      this.db = firebase.firestore();
      // 電波が一時的に切れても入力を端末に保持し、復帰時に自動送信
      this.db.enablePersistence({ synchronizeTabs: true }).catch((e) => console.warn('persistence', e));
    }
    _plays(gid) { return this.db.collection('games').doc(gid).collection('plays'); }

    subscribeGames(cb) {
      return this.db.collection('games').orderBy('createdAt', 'desc')
        .onSnapshot((s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))), (e) => alert('試合一覧の取得に失敗: ' + e.message));
    }
    createGame(data) {
      const ref = this.db.collection('games').doc();
      ref.set({ ...data, createdAt: Date.now() });
      return ref.id;
    }
    subscribePlays(gid, cb) {
      return this._plays(gid).onSnapshot({ includeMetadataChanges: true },
        (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data(), _pending: d.metadata.hasPendingWrites }))),
        (e) => alert('プレーの取得に失敗: ' + e.message));
    }
    addPlay(gid, data) {
      const ref = this._plays(gid).doc();
      ref.set(data);
      return ref.id;
    }
    // 項目単位で更新するので、3人が同じプレーの別項目を同時に編集しても上書きし合わない
    updatePlay(gid, pid, patch) { this._plays(gid).doc(pid).update(patch).catch((e) => console.warn(e)); }
    deletePlay(gid, pid) { this._plays(gid).doc(pid).delete(); }
  }

  window.createStore = async function () {
    const cfg = window.FIREBASE_CONFIG;
    if (!cfg) return new LocalStore();
    const v = '10.14.1';
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-app-compat.js`);
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore-compat.js`);
    return new FirestoreStore(cfg);
  };
})();
