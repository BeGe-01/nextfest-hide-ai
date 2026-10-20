// ==UserScript==
// @name         AI Filter for Steam Next Fest
// @namespace    nextfest-hide-ai
// @version      1.0
// @description  Hides Steam Next Fest games that disclose AI-generated content, or only AI art/audio. Not affiliated with Valve or Steam.
// @match        https://store.steampowered.com/sale/nextfest*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  // ───────────────────────── Flags & modes ─────────────────────────
  const FLAG = { AI: 1, ART: 2, AUDIO: 4 };
  const PENDING = 'pending';

  const MODES = [
    { label: 'All', hides: f => !!(f & FLAG.AI) },
    { label: 'Artworks + Audio Only', hides: f => !!(f & (FLAG.ART | FLAG.AUDIO)), default: true },
    { label: 'Artworks Only', hides: f => !!(f & FLAG.ART) },
    { label: 'Audio Only', hides: f => !!(f & FLAG.AUDIO) },
    { label: 'Off', hides: () => false, off: true },
  ];

  const TITLE = 'AI Filter for Steam Next Fest';
  const VERSION = '1.0';

  // ───────────────────────── Storage ─────────────────────────

  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch {} },
    removeOtherKeys(prefix, keep) {
      try {
        Object.keys(localStorage)
          .filter(k => k.startsWith(prefix) && !keep.includes(k))
          .forEach(k => localStorage.removeItem(k));
      } catch {}
    },
  };

  const MODE_KEY = 'nfai:mode';
  const CACHE_KEY = 'nfai:cache';

  storage.removeOtherKeys('nfai:', [MODE_KEY, CACHE_KEY]);

  const savedMode = MODES.findIndex(m => m.label === storage.get(MODE_KEY));
  let mode = savedMode >= 0 ? savedMode : MODES.findIndex(m => m.default);
  const cachedFlags = parseJSON(storage.get(CACHE_KEY)) || {};
  const saveCache = () => storage.set(CACHE_KEY, JSON.stringify(cachedFlags));

  // ───────────────────────── Steam API ─────────────────────────

  const API_URL = 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/';
  const BATCH_SIZE = 100;
  const RATE_LIMIT_WAIT_MS = 30000;
  const country = storeCountry() || 'US';

  async function fetchFlags(appids) {
    const input = {
      ids: appids.map(id => ({ appid: Number(id) })),
      context: { language: 'english', country_code: country },
      data_request: { include_extra_details: true },
    };
    const res = await fetch(`${API_URL}?input_json=${encodeURIComponent(JSON.stringify(input))}`);
    if (!res.ok) throw Object.assign(new Error(`GetItems ${res.status}`), { status: res.status });

    const result = new Map();
    for (const item of (await res.json()).response?.store_items ?? []) {
      if (item.success !== 1) continue; // unknown to Steam (e.g. not sold in this region)
      result.set(String(item.appid), flagsOf(item.extra_details?.content_survey_ai_notes));
    }
    return result;
  }

  function storeCountry() {
    const config = parseJSON(document.getElementById('application_config')?.dataset.config);
    return config?.COUNTRY;
  }

  // ───────────────────────── Checking queue ─────────────────────────

  const gameFlags = new Map();
  const queue = [];
  let checking = false;

  function flagsFor(appid) {
    if (!gameFlags.has(appid)) {
      if (appid in cachedFlags) gameFlags.set(appid, cachedFlags[appid]);
      else { gameFlags.set(appid, PENDING); queue.push(appid); }
    }
    return gameFlags.get(appid);
  }

  const pendingCount = () => [...gameFlags.values()].filter(v => v === PENDING).length;

  async function processQueue() {
    if (checking) return;
    checking = true;
    while (queue.length) {
      await checkBatch(queue.splice(0, BATCH_SIZE));
      scheduleScan();
    }
    checking = false;
  }

  async function checkBatch(appids) {
    try {
      const fetched = await fetchFlags(appids);
      for (const id of appids) {
        // Games Steam didn't return stay visible and aren't cached, so they're retried next visit.
        gameFlags.set(id, fetched.get(id) ?? 0);
        if (fetched.has(id)) cachedFlags[id] = fetched.get(id);
      }
      saveCache();
    } catch (err) {
      if (err.status === 429) {
        await sleep(RATE_LIMIT_WAIT_MS);
        queue.push(...appids);
      } else {
        appids.forEach(id => gameFlags.set(id, 0)); // network error: leave visible
      }
    }
  }

  // ───────────────────────── Hiding games on the page ─────────────────────────

  const APP_LINKS = 'a[href*="/app/"]';
  const HIDDEN_CLASS = 'nfai-hide';
  const MAX_CLIMB = 8;

  const appIdFromUrl = url => url.match(/\/app\/(\d+)/)?.[1];

  function tileOf(link, appid) {
    let tile = link;
    for (let i = 0; i < MAX_CLIMB; i++) {
      const parent = tile.parentElement;
      if (!parent || parent === document.body || siblingHasOtherGame(tile, appid)) break;
      tile = parent;
    }
    return tile;
  }

  function siblingHasOtherGame(el, appid) {
    for (const sibling of el.parentElement.children) {
      if (sibling === el) continue;
      const links = sibling.matches(APP_LINKS) ? [sibling] : sibling.querySelectorAll(APP_LINKS);
      for (const a of links) if (appIdFromUrl(a.href) !== appid) return true;
    }
    return false;
  }

  function scan() {
    document.querySelectorAll('.' + HIDDEN_CLASS).forEach(el => el.classList.remove(HIDDEN_CLASS));

    const hiddenGames = new Set();
    for (const link of document.querySelectorAll(APP_LINKS)) {
      const appid = appIdFromUrl(link.href);
      if (!appid) continue;
      const f = flagsFor(appid);
      if (f !== PENDING && MODES[mode].hides(f)) {
        tileOf(link, appid).classList.add(HIDDEN_CLASS);
        hiddenGames.add(appid);
      }
    }

    processQueue();
    ui.update(hiddenGames.size);
  }

  let scanTimer;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 250);
  }

  // ───────────────────────── Filter button & panel ─────────────────────────

  const ui = createUI();

  function createUI() {
    document.head.append(Object.assign(document.createElement('style'), {
      textContent: `
        .${HIDDEN_CLASS} { display: none !important; }

        #nfai-btn, #nfai-panel { --u: max(1px, 100vw / 1920); }

        #nfai-btn {
          position: fixed; bottom: calc(16 * var(--u)); right: calc(16 * var(--u)); z-index: 99999;
          width: calc(44 * var(--u)); height: calc(44 * var(--u)); display: grid; place-items: center;
          border: 0; border-radius: 50%; cursor: pointer; padding: 0;
          background: #3d4450; color: #fff; box-shadow: 0 calc(2 * var(--u)) calc(8 * var(--u)) #0008;
        }
        #nfai-btn.nfai-active { background: #1a9fff; }
        #nfai-btn svg { width: calc(20 * var(--u)); height: calc(20 * var(--u)); }

        .nfai-status {
          position: absolute; right: calc(100% + 8 * var(--u)); top: 50%; transform: translateY(-50%);
          display: none; align-items: center; gap: calc(6 * var(--u));
          padding: calc(4 * var(--u)) calc(8 * var(--u)); border-radius: calc(4 * var(--u));
          white-space: nowrap; pointer-events: none;
          background: #1b2838; color: #fff; font: calc(12 * var(--u)) "Motiva Sans", Arial, sans-serif;
          box-shadow: 0 calc(2 * var(--u)) calc(8 * var(--u)) #0008;
        }
        #nfai-btn.nfai-checking .nfai-status { display: flex; }
        .nfai-spinner {
          width: calc(10 * var(--u)); height: calc(10 * var(--u)); border-radius: 50%;
          border: calc(2 * var(--u)) solid #fff4; border-top-color: #fff;
          animation: nfai-spin 0.8s linear infinite;
        }
        @keyframes nfai-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .nfai-spinner { animation-duration: 3s; } }

        #nfai-panel {
          inset: auto calc(16 * var(--u)) calc(72 * var(--u)) auto; margin: 0;
          padding: calc(12 * var(--u)) calc(14 * var(--u)); min-width: calc(230 * var(--u));
          max-width: calc(100vw - 32 * var(--u)); box-sizing: border-box;
          border: 1px solid #3d4450; border-radius: calc(6 * var(--u));
          box-shadow: 0 calc(4 * var(--u)) calc(16 * var(--u)) #000a;
          background: #1b2838; color: #c7d5e0; font: calc(13 * var(--u)) "Motiva Sans", Arial, sans-serif;
        }
        #nfai-panel h2 {
          display: flex; align-items: baseline; gap: calc(4 * var(--u));
          margin: 0 0 calc(10 * var(--u)); padding-bottom: calc(8 * var(--u)); border-bottom: 1px solid #3d4450;
          color: #fff; font: bold calc(14 * var(--u)) "Motiva Sans", Arial, sans-serif;
          text-transform: none; letter-spacing: normal;
        }
        #nfai-panel h2 small { font-size: calc(11 * var(--u)); font-weight: normal; font-style: italic; color: #8f98a0; }
        #nfai-panel h2 .nfai-version {
          margin-left: auto; padding-left: calc(12 * var(--u));
          font-size: calc(11 * var(--u)); font-weight: normal; color: #8f98a0;
        }
        #nfai-panel label { display: block; color: #fff; font-weight: bold; margin-bottom: calc(6 * var(--u)); }
        #nfai-panel select {
          display: block; width: 100%; margin-bottom: calc(10 * var(--u)); padding: calc(5 * var(--u)) calc(6 * var(--u));
          border: 1px solid #3d4450; border-radius: calc(3 * var(--u));
          background: #2a3f5a; color: #fff; font: inherit; cursor: pointer;
        }
        #nfai-panel b { color: #fff; }`,
    }));

    const panel = document.createElement('div');
    panel.id = 'nfai-panel';
    panel.popover = 'auto';
    const select = el('select', { id: 'nfai-mode' }, MODES.map((m, i) => el('option', { value: i }, [m.label])));
    panel.append(
      el('h2', {}, [TITLE + ' ', el('span', { className: 'nfai-version' }, ['v' + VERSION])]),
      el('label', { htmlFor: 'nfai-mode' }, ['Filter Mode']),
      select,
      el('div', {}, [el('b', {}, ['Games Hidden:']), ' ', el('span', { className: 'nfai-count' }, ['0'])]),
    );
    select.value = mode;
    select.addEventListener('change', () => {
      mode = Number(select.value);
      storage.set(MODE_KEY, MODES[mode].label);
      scan();
    });

    const button = document.createElement('button');
    button.id = 'nfai-btn';
    button.setAttribute('aria-label', TITLE);
    button.setAttribute('popovertarget', panel.id);
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
      + '<path d="M3 4h18l-7 8.5V19l-4 2v-8.5z"/></svg>'
      + '<span class="nfai-status" aria-hidden="true"><span class="nfai-spinner"></span><span class="nfai-status-text"></span></span>';

    document.body.append(panel, button);
    const count = panel.querySelector('.nfai-count');
    const status = button.querySelector('.nfai-status-text');

    return {
      update(hiddenCount) {
        const pending = pendingCount();
        setText(count, pending ? `${hiddenCount} (checking ${pending}…)` : String(hiddenCount));
        if (pending) setText(status, `Checking... (${pending})`);
        button.classList.toggle('nfai-active', !MODES[mode].off);
        button.classList.toggle('nfai-checking', pending > 0);
        button.title = pending ? `${TITLE} (checking ${pending} game${pending === 1 ? '' : 's'}…)` : TITLE;
      },
    };
  }

  // ───────────────────────── Helpers ─────────────────────────

  function parseJSON(text) { try { return JSON.parse(text); } catch { return null; } }
  function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
  function el(tag, props, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  // ───────────────────────── AI art / audio classifier ─────────────────────────

  // <classifier>
  // The disclosure is already about AI, so a clause counts as AI art (or audio) if it names a visual (or audio) asset
  // and doesn't deny it.
  const words = list => String.raw`\b(?:${list.join('|')})\b`;
  const anyOf = (...parts) => new RegExp(parts.join('|'), 'i');

  const ART = anyOf(
    words(['art', 'arts', 'artworks?', 'visuals?', 'imagery', 'images?', 'imagenes', 'illustrations?', 'graphics?',
      'textures?', 'sprites?', 'portraits?', 'icons?', 'backgrounds?(?! music)', 'backdrops?', 'capsules?',
      'drawings?', 'paintings?', 'pictures?', 'posters?', 'cgs?', 'cutscenes?', 'animations?', '3d models?',
      'character models?', 'key ?art', 'concept art', 'character designs?']),
    '立绘', '美术', '插画', '图片', '画像', 'イラスト', '立ち絵', '背景', '이미지', '일러스트',
  );

  const AI = anyOf(
    words(['ai', String.raw`a\.i\.`, 'artificial intelligence', 'genai', 'generative', 'midjourney', 'stable diffusion',
      'dall-?e', 'firefly', 'chatgpt', 'gpt', 'gemini', 'codex', 'leonardo', 'flux', 'sora', 'kling', 'runway',
      'meshy', 'tripo', 'nano banana', 'imagen', 'comfyui', 'suno', 'udio', 'elevenlabs', 'aiva',
      '(?:image|art|diffusion|generative|ml|machine learning) (?:models?|tools?|generators?)',
      'text-to-image', 'image-to-image', 'img2img', 'diffusion']),
    '生成', 'ＡＩ', '人工智能',
  );

  const DENY = anyOf(
    words(['no', 'not', 'never', 'none', 'nothing', 'without', 'nor', 'zero', 'except', 'if']),
    String.raw`n't\b`, 'procedural',
    '不使用', '未使用', '没有使用', '使用していません', '사용하지',
  );

  // Human-made claims only count when the clause doesn't also name AI ("AI art, then hand-edited" is still AI art).
  const HUMAN = anyOf(
    'hand[- ]?(?:drawn|made|painted|crafted|built)', 'by hand', 'manually',
    'human[- ]?(?:made|authored|drawn|painted|work)',
    String.raw`\b(?:created|made|designed|drawn|produced|authored|painted|illustrated|crafted|built)\b.*\bby\b`,
    words(['(?:our|their|my) own']), 'in-engine', 'rendered by',
    "by (?:the |that |same )*(?:game'?s )?(?:own )?code",
    'photograph', 'stock', 'third[- ]party', 'licensed',
    '人工', '手绘', '手描き',
  );

  const AUDIO = anyOf(
    words(['audio', 'sounds?', 'sound ?effects?', 'sfx', 'music', 'musical', 'bgm', 'soundtracks?', 'songs?', 'tracks?',
      'themes? songs?', 'voices?', 'voice ?overs?', 'voice ?lines?', 'voice acting', 'vo', 'narrations?', 'narrators?',
      'dub(?:bing)?', 'tts', 'text-to-speech', 'speech', 'jingles?', 'ambien(?:t|ce)', 'elevenlabs', 'suno', 'udio']),
    '音乐', '音效', '配音', '语音', '音楽', '効果音', '音声', '보이스', '음악', '효과음',
  );
  // Narrower words for "human-made audio" denials ("recorded by real voice actors").
  const HUMAN_AUDIO = anyOf(
    String.raw`\b(?:recorded|performed|composed|voiced)\b`, 'voice actors?', 'composers?', 'musicians?', 'foley',
  );

  // "Assets" alone is vague: it counts as art only when the clause names AI and the disclosure never mentions audio
  // (otherwise "AI-assisted assets" usually means the sound effects or voices listed next to it).
  const ASSETS = /\b(?:game )?assets?\b(?![/\\])/i; // lookahead skips file paths like "assets/voice/"
  const REMOVED = /\b(?:removed|replaced)\b/i; // "we removed all temporary AI assets"

  // Split on sentence ends, on "but/however/whereas/, while", and on ", no/not…" so denials stay in their own clause.
  const CLAUSES = anyOf(
    String.raw`[.!?;\n。！？；]+`,
    String.raw`,?\s+(?:but|however|whereas)\s+`,
    String.raw`,\s*while\s+`,
    String.raw`,\s*(?=(?:and |while )?(?:no|not|none|nothing)\b)`,
  );

  // A clause made by humans, unless it also names AI ("AI music, then edited by hand" is still AI music).
  const isHumanOnly = (s, human) => human.test(s) && !AI.test(s);

  const isAIArtClause = s => ART.test(s) && !DENY.test(s) && !isHumanOnly(s, HUMAN);
  const isAIAssetClause = s => ASSETS.test(s) && AI.test(s) && !DENY.test(s) && !REMOVED.test(s);
  const isAIArt = notes => {
    const assetsMeanArt = !AUDIO.test(notes);
    return notes.split(CLAUSES).some(s => isAIArtClause(s) || (assetsMeanArt && isAIAssetClause(s)));
  };

  // ponytail: "AI audio" from voice/music words only; vague "assets" next to audio isn't counted as audio.
  const isAIAudioClause = s => AUDIO.test(s) && !DENY.test(s) && !isHumanOnly(s, HUMAN) && !isHumanOnly(s, HUMAN_AUDIO);
  const isAIAudio = notes => notes.split(CLAUSES).some(isAIAudioClause);

  // Flags for one disclosure (undefined = the game has none).
  const flagsOf = notes => notes === undefined ? 0
    : FLAG.AI | (isAIArt(notes) ? FLAG.ART : 0) | (isAIAudio(notes) ? FLAG.AUDIO : 0);
  // </classifier>

  // ───────────────────────── Start ─────────────────────────

  new MutationObserver(scheduleScan).observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['href'],
  });
  scan();
})();
