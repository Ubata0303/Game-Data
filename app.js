(() => {
  // 万が一エラーが起きた場合に画面に理由を表示
  window.onerror = function (msg, url, line, col, err) {
    alert(`エラーが発生しました:\n${msg}\n(行: ${line}, 列: ${col})\n${err?.stack || ''}`);
  };
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // ---------- 入力項目の定義（項目を増やすときはここに追加） ----------
  const FIELDS = [
    { key: 'qtr', label: 'Quarter（1〜4 / OT）', type: 'allowed', allowed: ['1', '2', '3', '4', 'OT'] },
    { key: 'series', label: 'Series', type: 'number', min: 1, max: 99 },
    { key: 'hash', label: 'Hash', type: 'buttons', options: ['L', 'M', 'R'] },
    // 敵陣エンドラインからのヤード数（1〜99）
    { key: 'ballOn', label: 'Ball On（敵陣エンドラインから 1〜99yd）', type: 'number', min: 1, max: 99 },
    { key: 'down', key2: 'dist', label: 'Down & Distance', type: 'downdist' },
    { key: 'personnel', label: 'Personnel', type: 'text', inputMode: 'numeric' },
    { key: 'formation', label: 'OFF Formation', type: 'text', capitalize: true },
    // upperWords: どう打っても全部大文字にする単語
    { key: 'play', label: 'Play', type: 'text', capitalize: true, upperWords: ['RPO', 'PAP'] },
    { key: 'defSign', label: 'Def Sign', type: 'text', capitalize: true },
  ];
  const CSV_COLS = [
    ['qtr', 'Quarter'], ['series', 'Series'], ['hash', 'Hash'], ['ballOn', 'Ball On'],
    ['down', 'Down'], ['dist', 'Distance'], ['personnel', 'Personnel'],
    ['formation', 'OFF Formation'], ['play', 'Play'], ['defSign', 'Def Sign'],
  ];

  // ---------- 担当（役割）の定義 ----------
  // canAdd: 「＋ 次のプレー」で行を追加できる担当（同時に押して行が重複するのを防ぐ）
  const ROLES = {
    situation: { label: '状況', keys: ['qtr', 'series', 'hash', 'ballOn', 'down', 'dist'], canAdd: true },
    offense: { label: 'オフェンス', keys: ['personnel', 'formation', 'play'], canAdd: false },
    defense: { label: 'Def Sign', keys: ['defSign'], canAdd: false },
    all: { label: '全項目', keys: null, canAdd: true },
  };
  let role = ROLES[localStorage.getItem('fdl_role')] ? localStorage.getItem('fdl_role') : 'all';
  const roleHas = (key) => !ROLES[role].keys || ROLES[role].keys.includes(key);

  // ---------- 状態 ----------
  let store;
  let me = localStorage.getItem('fdl_name') || '';
  const clientId = localStorage.getItem('fdl_client') || (() => {
    const id = Math.random().toString(36).slice(2, 10);
    localStorage.setItem('fdl_client', id);
    return id;
  })();
  let games = [];
  let plays = [];
  let currentGameId = null;
  let unsubPlays = null;
  let selectedId = null;
  let prevUpdated = {};
  let lastNewestId = null;
  let pendingFollow = false;
  let isViewOnly = false;
  const controls = {};

  // ---------- 共通 ----------
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 1800);
  }
  const selectedPlay = () => plays.find((p) => p.id === selectedId) || null;
  const newestId = () => (plays.length ? plays[plays.length - 1].id : null);
  const editorFocused = () => $('#editor').contains(document.activeElement) &&
    document.activeElement.tagName === 'INPUT';
  const ddText = (p) => (p.down || p.dist ? `${p.down || ''}-${p.dist || ''}` : '');
  // "gun ace slot +" → "Gun Ace Slot +"（各単語の1文字目だけ大文字。残りはそのまま）
  // upperWords に指定した単語は全部大文字（"rpo" → "RPO"）
  // 入力中は単語の後にスペース等が打たれた時点で変換（"paper" などを途中で "PAPer" にしないため）。保存時は末尾も変換
  const capitalizeWords = (s, upperWords = [], final = true) => {
    let out = s.replace(/(^|\s)(\S)/g, (m, sp, ch) => sp + ch.toUpperCase());
    const end = final ? '$|' : '';
    upperWords.forEach((w) => {
      out = out.replace(new RegExp(`(^|[^A-Za-z0-9])(${w})(?=${end}[^A-Za-z0-9])`, 'gi'), (m, pre) => pre + w.toUpperCase());
    });
    return out;
  };

  function save(key, value, pid = selectedId) {
    if (value === null) return; // 入力値が不正
    if (!currentGameId || !pid) { toast('先に「＋ 次のプレー」で行を追加してください'); return; }
    const p = plays.find((x) => x.id === pid);
    if (p && (p[key] ?? '') === value) return;
    store.updatePlay(currentGameId, pid, {
      [key]: value, updatedBy: me, updatedByClient: clientId, updatedAt: Date.now(),
    });
  }

  // フォーカス時点のプレーIDを覚えておき、途中で選択が変わっても正しい行に保存する
  function bindInput(input, key, getValue) {
    let pid = null;
    let timer = null;
    input.addEventListener('focus', () => { pid = selectedId; });
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => save(key, getValue(), pid || selectedId), 500);
    });
    input.addEventListener('change', () => {
      clearTimeout(timer);
      save(key, getValue(), pid || selectedId);
    });
  }

  // ---------- 入力パネル ----------
  function buildEditor() {
    const root = $('#editor');
    root.innerHTML = '';
    Object.keys(controls).forEach((k) => delete controls[k]);
    root.classList.toggle('large', role !== 'all');
    for (const f of FIELDS) {
      if (!roleHas(f.key)) continue;
      const wrap = el('div', 'field field-' + f.type);
      wrap.appendChild(el('label', 'field-label', f.label));
      const body = el('div', 'field-body');
      wrap.appendChild(body);
      root.appendChild(wrap);
      controls[f.key] = makeControl(f, body);
    }
  }

  function makeButtons(container, options, onClick) {
    const box = el('div', 'btns');
    const btns = options.map((o) => {
      const b = el('button', 'opt', o.label ?? o);
      b.type = 'button';
      b.dataset.v = o.value ?? o;
      b.addEventListener('click', () => onClick(b.dataset.v));
      box.appendChild(b);
      return b;
    });
    container.appendChild(box);
    return (v) => btns.forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  }

  function makeControl(f, body) {
    switch (f.type) {
      case 'buttons': {
        const setOn = makeButtons(body, f.options, (v) => {
          const cur = selectedPlay()?.[f.key] ?? '';
          save(f.key, cur === v ? '' : v); // 同じボタンをもう一度押すと解除
        });
        return { set: (v) => setOn(v ?? '') };
      }
      case 'allowed': {
        // 決められた値だけ手打ちで受け付ける（小文字は大文字に変換）
        const input = el('input', 'num');
        input.maxLength = Math.max(...f.allowed.map((a) => a.length));
        input.autocapitalize = 'characters';
        input.placeholder = f.allowed.join('/');
        const getValue = () => {
          const s = input.value.normalize('NFKC').trim().toUpperCase(); // 全角「ｏｔ」も OT に
          if (s === '' || f.allowed.includes(s)) { input.classList.remove('invalid'); return s; }
          input.classList.add('invalid');
          toast(`${f.allowed.join(' / ')} のどれかを入力してください`);
          return null;
        };
        // 打った瞬間に大文字に変換して表示（ot → OT）
        input.addEventListener('input', () => {
          const up = input.value.normalize('NFKC').toUpperCase();
          if (up !== input.value) input.value = up;
        });
        bindInput(input, f.key, getValue);
        body.appendChild(input);
        return {
          set: (v) => {
            if (document.activeElement !== input) { input.value = v ?? ''; input.classList.remove('invalid'); }
          },
        };
      }
      case 'number': {
        // 数値の手打ち入力（範囲外は保存しない）
        const input = el('input', 'num');
        // type="number" だと上下矢印が出るので、テキスト入力＋数字キーボードにする
        input.inputMode = 'numeric'; input.maxLength = String(f.max).length;
        input.placeholder = `${f.min}-${f.max}`;
        const getValue = () => {
          const s = input.value.normalize('NFKC').trim(); // 全角数字も受け付ける
          if (s === '') return '';
          const n = Number(s);
          if (!Number.isInteger(n) || n < f.min || n > f.max) {
            input.classList.add('invalid');
            toast(`${f.min}〜${f.max} の数字を入力してください`);
            return null;
          }
          input.classList.remove('invalid');
          return String(n);
        };
        bindInput(input, f.key, getValue);
        body.appendChild(input);
        return {
          set: (v) => {
            if (document.activeElement !== input) { input.value = v ?? ''; input.classList.remove('invalid'); }
          },
        };
      }
      case 'downdist': {
        // [Down] − [Distance] の2マス手打ち。Downに1〜4を打つと自動でDistanceへ移動
        const down = el('input', 'num dd-down');
        down.inputMode = 'numeric'; down.maxLength = 1; down.placeholder = 'D';
        const dash = el('span', 'dd-dash', '−');
        const dist = el('input', 'num dd-dist');
        dist.inputMode = 'numeric'; dist.maxLength = 3; dist.placeholder = 'Dist';
        const getDown = () => {
          const s = down.value.trim();
          if (s === '' || /^[1-4]$/.test(s)) { down.classList.remove('invalid'); return s; }
          down.classList.add('invalid');
          toast('Down は 1〜4 で入力してください');
          return null;
        };
        bindInput(down, f.key, getDown);
        bindInput(dist, f.key2, () => dist.value.trim().toUpperCase());
        down.addEventListener('input', () => {
          if (/^[1-4]$/.test(down.value.trim())) { dist.focus(); dist.select(); }
        });
        body.append(down, dash, dist);
        return {
          set: (v, p) => {
            if (document.activeElement !== down) { down.value = v ?? ''; down.classList.remove('invalid'); }
            if (document.activeElement !== dist) dist.value = p?.[f.key2] ?? '';
          },
        };
      }
      case 'text': {
        const input = el('input', 'text');
        if (f.inputMode) input.inputMode = f.inputMode;
        const listId = 'dl_' + f.key;
        input.setAttribute('list', listId);
        input.placeholder = f.label + ' を入力';
        const dl = el('datalist');
        dl.id = listId;
        const chips = el('div', 'chips');
        const clean = (s) => (f.capitalize ? capitalizeWords(s, f.upperWords) : s).trim();
        if (f.capitalize) {
          // 打った瞬間に各単語の1文字目を大文字に（カーソル位置は維持。日本語変換中は待つ）
          input.autocapitalize = 'words';
          const apply = () => {
            const cap = capitalizeWords(input.value, f.upperWords, false);
            if (cap === input.value) return;
            const { selectionStart: s, selectionEnd: e } = input;
            input.value = cap;
            input.setSelectionRange(s, e);
          };
          input.addEventListener('input', (ev) => { if (!ev.isComposing) apply(); });
          input.addEventListener('compositionend', apply);
          // 入力を終えたら末尾の単語も含めて最終変換（"zone rpo" → "Zone RPO"）
          input.addEventListener('change', () => { input.value = capitalizeWords(input.value, f.upperWords, true); });
        }
        bindInput(input, f.key, () => clean(input.value));
        body.append(input, dl, chips);
        return {
          set: (v) => { if (document.activeElement !== input) input.value = v ?? ''; },
          // この試合でよく使われた値をワンタップ候補として表示
          refreshChoices: () => {
            const freq = {};
            plays.forEach((p) => { const v = (p[f.key] || '').trim(); if (v) freq[v] = (freq[v] || 0) + 1; });
            const sorted = Object.keys(freq).sort((a, b) => freq[b] - freq[a]);
            dl.innerHTML = '';
            sorted.forEach((v) => { const o = el('option'); o.value = v; dl.appendChild(o); });
            chips.innerHTML = '';
            const cur = selectedPlay()?.[f.key] ?? '';
            sorted.slice(0, 10).forEach((v) => {
              const c = el('button', 'chip' + (v === cur ? ' on' : ''), v);
              c.type = 'button';
              c.onclick = () => { input.value = v; save(f.key, v); };
              chips.appendChild(c);
            });
          },
        };
      }
    }
  }

  const ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' };
  const ballOnText = (v) => (v ? `Ball On ${v}` : '');

  function syncEditor() {
    const p = selectedPlay();
    $('#editorPane').classList.toggle('no-selection', !p);
    if (p) {
      const idx = plays.indexOf(p) + 1;
      $('#editingLabel').textContent = `編集中: #${idx}` + (p.updatedBy ? `（最終更新: ${p.updatedBy}）` : '');
      // どのプレーを入力しているか一目でわかる状況表示
      const dd = p.down ? `${ORD[p.down] || p.down} & ${p.dist || '?'}` : '';
      const parts = [p.qtr && `Q${p.qtr}`, p.series && `S${p.series}`, dd, ballOnText(p.ballOn), p.hash && `Hash ${p.hash}`];
      $('#situation').textContent = parts.filter(Boolean).join('   ') || '（状況未入力）';
    } else {
      $('#editingLabel').textContent = 'プレー未選択';
      $('#situation').textContent = '—';
    }
    for (const f of FIELDS) {
      const c = controls[f.key];
      if (!c) continue;
      c.set(p ? p[f.key] : '', p);
      if (c.refreshChoices) c.refreshChoices();
    }
  }

  function applyRole() {
    const r = ROLES[role];
    document.querySelectorAll('#roleBar button').forEach((b) => b.classList.toggle('on', b.dataset.role === role));
    $('#actions').classList.toggle('hidden', !r.canAdd);
    $('#deleteBtn').classList.toggle('hidden', !r.canAdd);
    $('#roleHint').classList.toggle('hidden', r.canAdd);
    document.querySelectorAll('#playTable th[data-key]').forEach((th) => {
      th.classList.toggle('mine', role !== 'all' && roleHas(th.dataset.key));
    });
    $('#userBtn').textContent = '👤 ' + (me || '未設定') + (role !== 'all' ? `（${r.label}）` : '');
    buildEditor();
    renderTable();
    syncEditor();
  }

  function setRole(r) {
    if (editorFocused()) document.activeElement.blur();
    role = r;
    localStorage.setItem('fdl_role', r);
    applyRole();
  }

  function selectPlay(id, { fromUser = false } = {}) {
    if (editorFocused()) document.activeElement.blur();
    selectedId = id;
    if (fromUser) {
      // 過去のプレーを修正するときは追従を自動でオフにする
      $('#followLatest').checked = id === newestId();
    }
    renderTable();
    syncEditor();
  }

  // ---------- Hudl風 絞り込みフィルター（閲覧専用） ----------
  const HUDL_FILTERS = [
    { key: 'personnel', label: 'PERSONNEL' },
    { key: 'formation', label: '体型 (FORMATION)' },
    { key: 'play', label: 'PLAY名' },
    { key: 'down', label: 'DOWN', format: (v) => ORD[v] || v },
    { key: 'dist', label: 'DISTANCE' },
    { key: 'hash', label: 'HASH' },
    { key: 'ballOn', label: 'BALL ON' },
  ];

  const activeFilters = {
    personnel: new Set(),
    formation: new Set(),
    play: new Set(),
    down: new Set(),
    dist: new Set(),
    hash: new Set(),
    ballOn: new Set(),
  };

  function hasActiveFilter() {
    return Object.values(activeFilters).some((s) => s.size > 0);
  }

  function matchesFilter(p) {
    if (!isViewOnly) return true;
    for (const f of HUDL_FILTERS) {
      const selected = activeFilters[f.key];
      if (selected.size === 0) continue; // すべて (ALL)
      const val = (p[f.key] || '').trim();
      // 同一項目内は OR（選択した値のどれかに一致すればOK）
      if (!selected.has(val)) return false;
    }
    return true;
  }

  function refreshHudlFilters() {
    if (!isViewOnly) return;
    const container = $('#hudlFilterList');
    if (!container) return;

    HUDL_FILTERS.forEach((f) => {
      const counts = {};
      plays.forEach((p) => {
        const v = (p[f.key] || '').trim();
        if (v) counts[v] = (counts[v] || 0) + 1;
      });

      let item = container.querySelector(`[data-fkey="${f.key}"]`);
      if (!item) {
        item = el('div', 'hudl-filter-item');
        item.dataset.fkey = f.key;
        item.appendChild(el('div', 'hudl-filter-label', f.label));

        const btn = el('button', 'hudl-filter-btn');
        btn.type = 'button';
        btn.innerHTML = `<span class="hudl-btn-text">すべて (ALL)</span><span class="hudl-btn-arrow">▾</span>`;
        item.appendChild(btn);

        const drop = el('div', 'hudl-dropdown hidden');
        item.appendChild(drop);

        btn.onclick = (e) => {
          e.stopPropagation();
          const isClosed = drop.classList.contains('hidden');
          document.querySelectorAll('.hudl-dropdown').forEach((d) => d.classList.add('hidden'));
          if (isClosed) drop.classList.remove('hidden');
        };

        drop.onclick = (e) => e.stopPropagation();
        container.appendChild(item);
      }

      updateFilterDropdown(item, f, counts);
    });
  }

  function updateFilterDropdown(item, f, counts) {
    const drop = item.querySelector('.hudl-dropdown');
    const selected = activeFilters[f.key];
    drop.innerHTML = '';

    // 「すべて (ALL)」行
    const allLabel = el('label', 'hudl-option hudl-option-all');
    const allCheck = el('input');
    allCheck.type = 'checkbox';
    allCheck.checked = (selected.size === 0);
    allLabel.appendChild(allCheck);
    allLabel.appendChild(el('span', 'opt-text', 'すべて (ALL)'));
    allCheck.onchange = () => {
      selected.clear();
      refreshHudlFilters();
      renderTable();
    };
    drop.appendChild(allLabel);

    // 各値の行
    const sortedKeys = Object.keys(counts).sort((a, b) => {
      if (f.key === 'down' || f.key === 'ballOn' || f.key === 'dist') {
        const na = parseInt(a, 10), nb = parseInt(b, 10);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
      }
      return counts[b] - counts[a] || a.localeCompare(b);
    });

    sortedKeys.forEach((val) => {
      const optLabel = el('label', 'hudl-option');
      const chk = el('input');
      chk.type = 'checkbox';
      chk.checked = selected.has(val);
      chk.onchange = () => {
        if (chk.checked) selected.add(val);
        else selected.delete(val);
        allCheck.checked = (selected.size === 0);
        updateFilterButton(item, f);
        renderTable();
      };
      optLabel.appendChild(chk);
      const displayVal = f.format ? f.format(val) : val;
      optLabel.appendChild(el('span', 'opt-text', displayVal));
      optLabel.appendChild(el('span', 'opt-count', `(${counts[val]})`));
      drop.appendChild(optLabel);
    });

    updateFilterButton(item, f);
  }

  function updateFilterButton(item, f) {
    const selected = activeFilters[f.key];
    const btnText = item.querySelector('.hudl-btn-text');
    const btn = item.querySelector('.hudl-filter-btn');
    if (selected.size === 0) {
      btnText.textContent = 'すべて (ALL)';
      btn.classList.remove('active');
    } else if (selected.size === 1) {
      const v = Array.from(selected)[0];
      btnText.textContent = f.format ? f.format(v) : v;
      btn.classList.add('active');
    } else {
      btnText.textContent = `${selected.size}件選択中`;
      btn.classList.add('active');
    }
  }

  function clearAllHudlFilters() {
    Object.values(activeFilters).forEach((s) => s.clear());
    refreshHudlFilters();
    renderTable();
  }

  // ---------- プレー一覧 ----------
  function renderTable() {
    const tbody = $('#playTable tbody');
    tbody.innerHTML = '';
    let visibleCount = 0;
    const isFiltering = isViewOnly && hasActiveFilter();

    plays.forEach((p, i) => {
      if (!matchesFilter(p)) return;
      visibleCount++;

      const tr = el('tr');
      if (p.id === selectedId) tr.classList.add('selected');
      const prev = prevUpdated[p.id];
      if (p.updatedByClient && p.updatedByClient !== clientId && prev !== undefined && prev !== p.updatedAt) {
        tr.classList.add('flash');
      }
      const cells = [
        ['#', i + 1], ['qtr', p.qtr], ['series', p.series], ['hash', p.hash], ['ballOn', p.ballOn],
        ['down', ddText(p)], ['personnel', p.personnel], ['formation', p.formation], ['play', p.play], ['defSign', p.defSign],
      ];
      cells.forEach(([k, v]) => {
        const td = el('td', null, v ?? '');
        if (role !== 'all' && k !== '#' && roleHas(k)) td.className = 'mine';
        tr.appendChild(td);
      });
      const who = el('td', 'who', (p._pending ? '⏳ ' : '') + (p.updatedBy || ''));
      if (p._pending) who.title = '未送信（電波復帰後に自動送信）';
      tr.appendChild(who);
      if (!isViewOnly) {
        tr.addEventListener('click', () => selectPlay(p.id, { fromUser: true }));
      }
      tbody.appendChild(tr);
    });

    if (isFiltering) {
      $('#playCount').textContent = `(${visibleCount} / 全${plays.length})`;
    } else {
      $('#playCount').textContent = `(${plays.length})`;
    }
  }

  function onPlays(list) {
    list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id));
    plays = list;
    if (selectedId && !plays.find((p) => p.id === selectedId)) selectedId = null;

    const nid = newestId();
    const follow = $('#followLatest').checked;
    if (follow && nid && (nid !== lastNewestId || !selectedId)) {
      if (editorFocused()) pendingFollow = true; // 入力中は邪魔しない。入力を終えたら移動
      else selectedId = nid;
    }
    const added = nid !== lastNewestId && lastNewestId !== null;
    lastNewestId = nid;

    renderTable();
    syncEditor();
    plays.forEach((p) => { prevUpdated[p.id] = p.updatedAt; });
    if (added && follow) {
      const wrap = $('.table-wrap');
      wrap.scrollTop = wrap.scrollHeight;
    }

    if (isViewOnly) {
      refreshHudlFilters();
      const last = plays[plays.length - 1];
      if (last) {
        const idx = plays.length;
        const dd = last.down ? `${ORD[last.down] || last.down} & ${last.dist || '?'}` : '';
        const parts = [`#${idx}`, last.qtr && `Q${last.qtr}`, last.series && `S${last.series}`, dd, ballOnText(last.ballOn), last.hash && `Hash ${last.hash}`];
        $('#viewBanner').textContent = '現在の最新状況: ' + (parts.filter(Boolean).join('   ') || '（未入力）');
      } else {
        $('#viewBanner').textContent = 'まだプレーがありません';
      }
    }

    updateStatus();
  }

  function addPlay(newSeries) {
    const last = plays[plays.length - 1];
    const now = Date.now();
    const data = {
      qtr: last?.qtr || '1',
      series: newSeries ? String((parseInt(last?.series, 10) || 0) + 1) : (last?.series || '1'),
      hash: '', ballOn: '',
      down: newSeries ? '1' : '', dist: newSeries ? '10' : '',
      personnel: '', formation: '', play: '', defSign: '',
      createdAt: now, createdBy: me,
      updatedAt: now, updatedBy: me, updatedByClient: clientId,
    };
    const id = store.addPlay(currentGameId, data);
    $('#followLatest').checked = true;
    lastNewestId = id;
    selectPlay(id);
  }

  function exportCsv() {
    const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const lines = [['#', ...CSV_COLS.map((c) => c[1])].map(q).join(',')];
    plays.forEach((p, i) => lines.push([i + 1, ...CSV_COLS.map((c) => p[c[0]])].map(q).join(',')));
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv' }); // BOM付きでExcelの文字化け防止
    const a = document.createElement('a');
    const name = (games.find((g) => g.id === currentGameId)?.name || 'game').replace(/[\\/:*?"<>|]/g, '_');
    a.href = URL.createObjectURL(blob);
    a.download = name + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- ステータス ----------
  function updateStatus(text, cls) {
    const s = $('#status');
    if (text != null) {
      s.textContent = text;
      s.className = 'status ' + (cls || 'ok');
      return;
    }
    if (!navigator.onLine) {
      s.textContent = 'オフライン';
      s.className = 'status bad';
    }
  }

  // ---------- 画面切り替え ----------
  function renderGames() {
    const ul = $('#gameList');
    ul.innerHTML = '';
    if (!games.length) ul.appendChild(el('li', 'muted', 'まだ試合がありません'));
    games.forEach((g) => {
      const li = el('li');
      const a = el('a', null, g.name);
      a.href = '#/game/' + g.id;
      li.append(a, el('span', 'muted', new Date(g.createdAt).toLocaleString('ja-JP')));
      ul.appendChild(li);
    });
    if (currentGameId) $('#gameTitle').textContent = games.find((g) => g.id === currentGameId)?.name || '';
  }

  function route() {
    const m = location.hash.match(/^#\/(game|view)\/(.+)$/);
    if (unsubPlays) { unsubPlays(); unsubPlays = null; }
    if (m) {
      isViewOnly = (m[1] === 'view');
      document.body.classList.toggle('view-only', isViewOnly);
      currentGameId = m[2].split('?')[0];
      selectedId = null; plays = []; prevUpdated = {}; lastNewestId = null;
      clearAllHudlFilters();
      $('#home').classList.add('hidden');
      $('#game').classList.remove('hidden');
      $('#backBtn').classList.remove('hidden');
      const gname = games.find((g) => g.id === currentGameId)?.name || '';
      $('#gameTitle').textContent = gname + (isViewOnly ? '（閲覧用）' : '');
      $('#viewBanner').classList.toggle('hidden', !isViewOnly);
      $('#filterBar').classList.toggle('hidden', !isViewOnly);
      unsubPlays = store.subscribePlays(currentGameId, onPlays);
    } else {
      isViewOnly = false;
      document.body.classList.remove('view-only');
      if (store.leaveGame) store.leaveGame();
      currentGameId = null;
      $('#game').classList.add('hidden');
      $('#home').classList.remove('hidden');
      $('#backBtn').classList.add('hidden');
      $('#gameTitle').textContent = '';
      $('#viewBanner').classList.add('hidden');
      $('#filterBar').classList.add('hidden');
    }
  }

  function askName() {
    const d = $('#nameDialog');
    $('#nameInput').value = me;
    d.showModal();
    d.addEventListener('close', () => {
      me = $('#nameInput').value.trim() || me || 'ゲスト';
      localStorage.setItem('fdl_name', me);
      $('#userBtn').textContent = '👤 ' + me + (role !== 'all' ? `（${ROLES[role].label}）` : '');
    }, { once: true });
  }

  // ---------- 起動 ----------
  async function init() {
    try {
      store = await window.createStore();
    } catch (e) {
      alert('Firebase の読み込みに失敗しました。ネット接続を確認してください。\n' + e.message);
      return;
    }
    // 担当切り替えボタン
    Object.entries(ROLES).forEach(([key, r]) => {
      const b = el('button', 'role-btn', r.label);
      b.type = 'button';
      b.dataset.role = key;
      b.onclick = () => setRole(key);
      $('#roleBar').appendChild(b);
    });
    applyRole();

    $('#userBtn').onclick = askName;
    if (!me) askName();

    $('#newGameForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('#newGameName').value.trim();
      if (!name) return;
      const id = store.createGame({ name, createdBy: me });
      $('#newGameName').value = '';
      location.hash = '#/game/' + id;
    });
    $('#addPlayBtn').onclick = () => addPlay(false);
    $('#newSeriesBtn').onclick = () => addPlay(true);
    $('#deleteBtn').onclick = () => {
      const p = selectedPlay();
      if (!p) return;
      if (confirm(`#${plays.indexOf(p) + 1} のプレーを削除しますか？（全員の画面から消えます）`)) {
        store.deletePlay(currentGameId, p.id);
      }
    };
    $('#csvBtn').onclick = exportCsv;
    let shareMode = 'edit';
    function updateShareDialog() {
      const base = location.href.split('#')[0];
      const targetHash = (shareMode === 'view') ? `#/view/${currentGameId}` : `#/game/${currentGameId}`;
      const url = base + targetHash;
      $('#shareUrlInput').value = url;
      $('#qrImg').src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;
      $('#shareModeEdit').classList.toggle('on', shareMode === 'edit');
      $('#shareModeView').classList.toggle('on', shareMode === 'view');
      $('#shareDesc').textContent = (shareMode === 'view')
        ? '閲覧用リンク：入力欄が隠れ、見るだけ専用になります（誤タップの心配なし）'
        : '編集用リンク：3人で分担して同時入力・編集ができます';
    }

    $('#shareModeEdit').onclick = () => { shareMode = 'edit'; updateShareDialog(); };
    $('#shareModeView').onclick = () => { shareMode = 'view'; updateShareDialog(); };

    $('#shareBtn').onclick = () => {
      shareMode = isViewOnly ? 'view' : 'edit';
      updateShareDialog();
      $('#shareDialog').showModal();
    };
    $('#copyShareUrlBtn').onclick = async () => {
      const url = $('#shareUrlInput').value;
      try {
        await navigator.clipboard.writeText(url);
        toast('URLをコピーしました！');
      } catch {
        $('#shareUrlInput').select();
        document.execCommand('copy');
        toast('URLをコピーしました！');
      }
    };
    $('#followLatest').addEventListener('change', (e) => {
      if (e.target.checked && newestId()) selectPlay(newestId());
    });

    // 閲覧用画面の絞り込みイベント（Hudl風）
    $('#clearFilterBtn').onclick = clearAllHudlFilters;
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.hudl-filter-item')) {
        document.querySelectorAll('.hudl-dropdown').forEach((d) => d.classList.add('hidden'));
      }
    });

    $('#editor').addEventListener('focusout', () => setTimeout(() => {
      if (pendingFollow && !editorFocused()) { pendingFollow = false; selectPlay(newestId()); }
    }, 0));
    window.addEventListener('online', () => updateStatus());
    window.addEventListener('offline', () => updateStatus());
    window.addEventListener('hashchange', route);

    if (store.onStatusChange) {
      store.onStatusChange((text, cls) => updateStatus(text, cls));
    }

    store.subscribeGames((list) => { games = list; renderGames(); });
    updateStatus();
    route();
  }

  init();
})();
