/**
 * Shoe Life PWA v0.3 — on-device only.
 * Estimates usage. Does not diagnose or make health claims.
 * Factors (typeFactor, weightFactor, standingStepEquivalent) are PLACEHOLDERS.
 */
(function () {
  'use strict';

  const DB_NAME = 'shoe-life';
  const DB_VERSION = 1;
  const STORE = 'kv';
  const KEY = 'state';

  /** Placeholder factors — labeled as estimates in UI. Not validated. */
  const TYPE_FACTOR = {
    running: 1.0,
    walking: 0.9,
    work: 0.8,
    casual: 1.0,
  };
  const TYPE_LABEL = {
    running: 'Running / max-cushion',
    walking: 'Walking / court',
    work: 'Work / nursing clog',
    casual: 'Casual / fashion',
  };
  const WEIGHT_FACTOR = {
    lt60: 0.9,
    '60-80': 1.0,
    '80-100': 1.1,
    gt100: 1.2,
  };
  /** Pure assumption — flagged in UI */
  const STANDING_STEP_EQUIVALENT = 500;
  /** v0.3: default base check point 700,000 steps (= 350 mi at 2,000 steps/mi). Heuristic, not validated. */
  const DEFAULT_THRESHOLD = 700000;
  /** v0.1/v0.2 default; untouched profiles move to the new default during migration. */
  const LEGACY_DEFAULT_THRESHOLD = 750000;
  /** Display only: miles = steps / 2000. The wear model still works in (effective) steps. */
  const STEPS_PER_MILE = 2000;
  /** Pair photos: downscaled on-device to fit this box, stored as JPEG data URL in IndexedDB. Never uploaded. */
  const PHOTO_MAX_PX = 512;
  const PHOTO_JPEG_QUALITY = 0.8;

  /**
   * v0.2 foam life multipliers — PLACEHOLDER estimates, not validated.
   * Applied to the check point (lower = check sooner).
   */
  const FOAM_FACTOR = {
    standard: 1.0, // EVA (default)
    super: 0.7,    // PEBA / ETPU racing or "super" foams
    firm: 1.1,     // firm PU / work shoe
    unsure: 1.0,
  };
  const FOAM_LABEL = {
    standard: 'Standard foam (EVA)',
    super: 'Racing / super foam (PEBA, ETPU)',
    firm: 'Firm / PU / work shoe',
    unsure: 'Unsure',
  };
  /** v0.2 age heuristic — PLACEHOLDER: no reduction before ~12 months, full effect by ~24 months. */
  const AGE_DECAY_START_MONTHS = 12;
  const AGE_DECAY_FULL_MONTHS = 24;
  const AGE_DECAY_MIN_MULT = 0.6;
  const ROTATION_MIN_PAIRS = 2;
  const SHOP_SEARCH_BASE = 'https://duckduckgo.com/?q=';
  /**
   * v0.3 check-point card links. All affiliate URLs are null on purpose: the buttons open a plain
   * DuckDuckGo search (no tracking parameters).
   * TODO(affiliate): set affiliateUrl only after Rene approves a program and the claims review.
   * When any affiliateUrl is non-null the card shows AFFILIATE_DISCLOSURE automatically and the links
   * get rel="sponsored". privacy.html already carries a standing disclosure entry. Never add tracking params.
   */
  const AFFILIATE_LINKS = {
    insoles: { affiliateUrl: null, searchTerms: 'replacement insoles' },
    shoes: { affiliateUrl: null },
  };
  const AFFILIATE_DISCLOSURE = 'Some links may be affiliate links; we may earn a commission.';
  const STATE_VERSION = 3;
  const TIME_CHECK_MONTHS = 6;
  const PROMPT_PCT = [0.5, 0.8, 1.0];

  const REQUIRED_FOOTER =
    "Shoe Life estimates usage only. It can't tell you how your shoes or your body are doing.";

  // --- state ---
  let db = null;
  let state = defaultState();
  let toastTimer = null;

  function defaultState() {
    return {
      version: STATE_VERSION,
      pairs: [],
      dayLogs: [],
      allocations: [],
      checks: [],
      profile: {
        bodyWeightBand: '',
        units: 'metric',
        usualSteps: 8000,
        defaultThreshold: DEFAULT_THRESHOLD,
        standingHoursDefault: 0,
      },
      shiftTemplates: [
        { id: uid(), name: '12 h nursing shift', steps: 12000 },
        { id: uid(), name: 'Retail shift', steps: 8000 },
      ],
    };
  }

  function uid() {
    return 'id_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function todayISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  /**
   * Migrate v0.1 / v0.2 (or imported) data to v0.3 without dropping anything.
   * v0.2: existing pairs get foam = standard and firstWorn = their start/created date.
   * v0.3: photo is optional (null when missing or not an image data URL); an untouched legacy
   * default threshold (750,000) moves to the new 700,000 default; custom values are kept.
   */
  function migrateState(raw) {
    const fromVersion = Number(raw && raw.version) || 1;
    const base = defaultState();
    const s = Object.assign(base, raw || {});
    s.profile = Object.assign(defaultState().profile, (raw && raw.profile) || {});
    ['pairs', 'dayLogs', 'allocations', 'checks', 'shiftTemplates'].forEach(function (k) {
      if (!Array.isArray(s[k])) s[k] = defaultState()[k];
    });
    s.pairs.forEach(function (p) {
      if (!p.foam || !(p.foam in FOAM_FACTOR)) p.foam = 'standard';
      if (!p.createdAt) p.createdAt = p.purchaseDate || todayISO();
      if (!p.firstWorn) p.firstWorn = p.purchaseDate || p.createdAt;
      if (p.brandModel == null) p.brandModel = '';
      if (typeof p.photoDataUrl !== 'string' || p.photoDataUrl.indexOf('data:image/') !== 0) p.photoDataUrl = null;
    });
    if (fromVersion < 3 && Number(s.profile.defaultThreshold) === LEGACY_DEFAULT_THRESHOLD) {
      s.profile.defaultThreshold = DEFAULT_THRESHOLD;
    }
    s.version = STATE_VERSION;
    return s;
  }

  // --- IndexedDB ---
  function openDb() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE);
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function loadState() {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.get(KEY);
      req.onsuccess = function () {
        resolve(req.result || null);
      };
      req.onerror = function () { reject(req.error); };
    });
  }

  function saveState() {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.put(state, KEY);
      req.onsuccess = function () { resolve(); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function wipeDb() {
    state = defaultState();
    await saveState();
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      // caches cleared by SW message if needed
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(function (k) { return caches.delete(k); }));
    }
  }

  // --- wear math (placeholders) ---
  function weightFactor() {
    const band = state.profile.bodyWeightBand;
    if (!band || !(band in WEIGHT_FACTOR)) return 1.0;
    return WEIGHT_FACTOR[band];
  }

  function typeFactor(type) {
    return TYPE_FACTOR[type] != null ? TYPE_FACTOR[type] : 1.0;
  }

  function effectiveForDay(log, pair) {
    const tf = typeFactor(pair.type);
    const wf = weightFactor();
    const steps = Number(log.totalSteps) || 0;
    const standing = Number(log.standingHours) || 0;
    return steps * tf * wf + standing * STANDING_STEP_EQUIVALENT * tf * wf;
  }

  function pairEffectiveSteps(pair) {
    let total = Number(pair.startSteps) || 0;
    const allocs = state.allocations.filter(function (a) { return a.pairId === pair.id; });
    allocs.forEach(function (a) {
      const log = state.dayLogs.find(function (l) { return l.date === a.date; });
      if (!log) return;
      total += effectiveForDay(log, pair) * (a.fraction || 1);
    });
    return Math.round(total);
  }

  function baseThreshold(pair) {
    if (pair.checkThresholdOverride) return Number(pair.checkThresholdOverride);
    return Number(state.profile.defaultThreshold) || DEFAULT_THRESHOLD;
  }

  function foamFactor(foam) {
    return FOAM_FACTOR[foam] != null ? FOAM_FACTOR[foam] : 1.0;
  }

  /** Fractional months between an ISO date and now (approx. 30.44 days/month). */
  function monthsBetween(dateStr, now) {
    if (!dateStr) return 0;
    const start = new Date(dateStr + 'T12:00:00');
    if (isNaN(start.getTime())) return 0;
    const ms = (now || new Date()).getTime() - start.getTime();
    return Math.max(0, ms / (86400000 * 30.44));
  }

  function monthsSince(dateStr) {
    return Math.floor(monthsBetween(dateStr));
  }

  /** Age multiplier on the check point: 1.0 until ~12 mo, easing to AGE_DECAY_MIN_MULT by ~24 mo. Estimate. */
  function ageMultiplier(firstWorn, now) {
    const m = monthsBetween(firstWorn, now);
    if (m <= AGE_DECAY_START_MONTHS) return 1.0;
    const t = Math.min(1, (m - AGE_DECAY_START_MONTHS) / (AGE_DECAY_FULL_MONTHS - AGE_DECAY_START_MONTHS));
    const eased = t * t * (3 - 2 * t); // smoothstep: gradual start and finish
    return 1 - (1 - AGE_DECAY_MIN_MULT) * eased;
  }

  /** Effective check point = base × foam factor × age multiplier (all estimates). */
  function pairThreshold(pair, now) {
    const thr = baseThreshold(pair) * foamFactor(pair.foam) * ageMultiplier(pair.firstWorn || pair.purchaseDate, now);
    return Math.round(thr);
  }

  function lastWornDate(pair) {
    let last = null;
    state.allocations.forEach(function (a) {
      if (a.pairId === pair.id && (!last || a.date > last)) last = a.date;
    });
    return last;
  }

  function daysSince(dateStr, now) {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T12:00:00');
    const n = now || new Date();
    const today = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 12);
    return Math.max(0, Math.round((today - d) / 86400000));
  }

  function lastWornText(pair) {
    const d = daysSince(lastWornDate(pair));
    if (d == null) return 'Last worn: not logged yet';
    if (d === 0) return 'Last worn: today';
    if (d === 1) return 'Last worn: 1 day ago';
    return 'Last worn: ' + d + ' days ago';
  }

  /** Display only. */
  function stepsToMiles(steps) {
    return (Number(steps) || 0) / STEPS_PER_MILE;
  }

  function formatMiles(steps) {
    const m = stepsToMiles(steps);
    return (m < 100 ? m.toFixed(1) : Math.round(m).toLocaleString()) + ' mi';
  }

  /** Logged (raw) steps worn in a pair: starting steps + allocated day logs. Used for the miles display. */
  function pairStepsWorn(pair) {
    let total = Number(pair.startSteps) || 0;
    state.allocations.forEach(function (a) {
      if (a.pairId !== pair.id) return;
      const log = state.dayLogs.find(function (l) { return l.date === a.date; });
      if (log) total += (Number(log.totalSteps) || 0) * (a.fraction || 1);
    });
    return Math.round(total);
  }

  function insolesUrl(pair) {
    if (AFFILIATE_LINKS.insoles.affiliateUrl) return AFFILIATE_LINKS.insoles.affiliateUrl;
    const bm = (pair.brandModel || '').trim();
    return SHOP_SEARCH_BASE + encodeURIComponent(AFFILIATE_LINKS.insoles.searchTerms + (bm ? ' ' + bm : ''));
  }

  function shoesUrl(pair) {
    return AFFILIATE_LINKS.shoes.affiliateUrl || shopUrl(pair);
  }

  function affiliateActive() {
    return Object.keys(AFFILIATE_LINKS).some(function (k) { return !!AFFILIATE_LINKS[k].affiliateUrl; });
  }

  function shopUrl(pair) {
    const q = ((pair.brandModel || '').trim() || (pair.nickname || '').trim() || 'shoes') + ' shoes';
    // Plain search link. No affiliate tag, no tracking parameters.
    return SHOP_SEARCH_BASE + encodeURIComponent(q);
  }

  /** Map the three visual/press checks to a suggested outcome. */
  function suggestOutcome(crease, tilt, press) {
    const vals = [crease, tilt, press];
    const yes = vals.filter(function (v) { return v === 'yes'; }).length;
    const some = vals.filter(function (v) { return v === 'some'; }).length;
    if (yes >= 2 || (yes >= 1 && some >= 1)) return 'replace';
    if (yes === 1 || some >= 1) return 'watch';
    return 'ok';
  }

  function usagePct(pair) {
    const thr = pairThreshold(pair);
    if (!thr) return 0;
    return pairEffectiveSteps(pair) / thr;
  }

  function promptLevel(pair) {
    if (pair.status !== 'active') return null;
    const pct = usagePct(pair);
    let level = null;
    if (pct >= 1.0) level = { pct: 100, kind: 'steps', label: '100%' };
    else if (pct >= 0.8) level = { pct: 80, kind: 'steps', label: '80%' };
    else if (pct >= 0.5) level = { pct: 50, kind: 'steps', label: '50%' };
    const months = monthsSince(pair.firstWorn || pair.purchaseDate);
    if (months >= TIME_CHECK_MONTHS) {
      if (!level || level.pct < 80) {
        level = { pct: level ? level.pct : 0, kind: 'time', label: TIME_CHECK_MONTHS + ' months' };
      }
    }
    return level;
  }

  // --- UI helpers ---
  function $(id) { return document.getElementById(id); }

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 2800);
  }

  function showView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.add('hidden'); });
    const map = {
      home: 'view-home',
      today: 'view-today',
      check: 'view-check',
      settings: 'view-settings',
      'pair-form': 'view-pair-form',
      'pair-detail': 'view-pair-detail',
    };
    const id = map[name] || 'view-home';
    $(id).classList.remove('hidden');
    document.querySelectorAll('.tab').forEach(function (t) {
      const on = t.getAttribute('data-view') === name;
      t.classList.toggle('active', on);
      if (on) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });
    if (name === 'home') renderHome();
    if (name === 'today') renderToday();
    if (name === 'check') renderCheck();
    if (name === 'settings') renderSettings();
  }

  function usageIcon(pct) {
    if (pct >= 1) return '⚠️';
    if (pct >= 0.8) return '🔔';
    if (pct >= 0.5) return '👀';
    return '✓';
  }

  function usageFillClass(pct) {
    if (pct >= 1) return 'high';
    if (pct >= 0.8) return 'mid';
    if (pct >= 0.5) return 'mid';
    return '';
  }

  function formatSteps(n) {
    return Math.round(n).toLocaleString();
  }

  // --- render ---
  /** Pair chosen on the dashboard for 'Wearing These Today' (defaults to today's / most recent pair). */
  let selectedPairId = null;
  /** Photo picked in the pair form: undefined = unchanged, '' = removed, string = new downscaled JPEG. */
  let pendingPhoto;

  function todayLog() {
    const t = todayISO();
    return state.dayLogs.find(function (l) { return l.date === t; }) || null;
  }

  function todayPairId() {
    const t = todayISO();
    const a = state.allocations.find(function (x) { return x.date === t; });
    return a ? a.pairId : null;
  }

  function defaultSelectedPair() {
    const actives = state.pairs.filter(function (p) { return p.status === 'active'; });
    if (selectedPairId && actives.some(function (p) { return p.id === selectedPairId; })) return selectedPairId;
    const tp = todayPairId();
    if (tp && actives.some(function (p) { return p.id === tp; })) return tp;
    let best = null, bestDate = '';
    actives.forEach(function (p) {
      const d = lastWornDate(p) || '';
      if (!best || d > bestDate) { best = p; bestDate = d; }
    });
    return best ? best.id : null;
  }

  function photoHtml(pair, cls) {
    if (pair.photoDataUrl) {
      return '<img class="' + cls + '" src="' + escapeAttr(pair.photoDataUrl) + '" alt="Photo of ' + escapeAttr(pair.nickname) + '">';
    }
    return '<span class="' + cls + ' photo-placeholder" aria-hidden="true">👟</span>';
  }

  function renderHome() {
    const list = $('pair-list');
    const empty = $('home-empty');
    const banners = $('check-banners');
    list.innerHTML = '';
    banners.innerHTML = '';

    const active = state.pairs.filter(function (p) { return p.status === 'active'; });
    const retired = state.pairs.filter(function (p) { return p.status === 'retired'; });
    selectedPairId = defaultSelectedPair();

    if (state.pairs.length === 0) {
      empty.classList.remove('hidden');
    } else {
      empty.classList.add('hidden');
    }

    active.forEach(function (pair) {
      if (usagePct(pair) >= 1) {
        banners.appendChild(checkpointAlert(pair));
        return;
      }
      const level = promptLevel(pair);
      if (level) {
        const eff = pairEffectiveSteps(pair);
        const ban = document.createElement('div');
        ban.className = 'banner';
        const msg = level.kind === 'time'
          ? (pair.nickname + ': about ' + TIME_CHECK_MONTHS + ' months since start. Time to check your shoes.')
          : (pair.nickname + ': about ' + formatSteps(eff) + ' estimated steps (' + formatMiles(eff) + '). Time to check your shoes.');
        ban.innerHTML =
          '<span class="banner-icon" aria-hidden="true">' + usageIcon(usagePct(pair)) + '</span>' +
          '<div><strong>' + escapeHtml(pair.nickname) + '</strong><p>' + escapeHtml(msg) + '</p>' +
          '<button type="button" class="btn btn-secondary banner-go" data-pair="' + escapeAttr(pair.id) + '">Start check</button></div>';
        banners.appendChild(ban);
      }
    });

    if (active.length >= ROTATION_MIN_PAIRS) {
      const tip = document.createElement('div');
      tip.className = 'banner tip';
      tip.id = 'rotation-tip';
      let rows = '';
      active.forEach(function (p) {
        rows += '<li>' + escapeHtml(p.nickname) + ' · ' + escapeHtml(lastWornText(p)) + '</li>';
      });
      tip.innerHTML =
        '<span class="banner-icon" aria-hidden="true">🔄</span>' +
        '<div><strong>Tip: take turns</strong>' +
        '<p>You have ' + active.length + ' active pairs. Some people like to alternate pairs from day to day. ' +
        'It is just a habit you can try; this app does not measure its effect.</p>' +
        '<ul class="list-plain">' + rows + '</ul></div>';
      banners.appendChild(tip);
    }

    banners.querySelectorAll('.banner-go').forEach(function (btn) {
      btn.addEventListener('click', function () {
        showView('check');
        $('check-pair').value = btn.getAttribute('data-pair');
      });
    });

    function card(pair) {
      const pct = usagePct(pair);
      const left = Math.max(0, 100 - Math.round(pct * 100));
      const worn = pairStepsWorn(pair);
      const isActive = pair.status === 'active';
      const selected = isActive && pair.id === selectedPairId;
      const wrap = document.createElement('div');
      wrap.className = 'closet-card' + (selected ? ' selected' : '') + (isActive ? '' : ' retired');
      wrap.setAttribute('data-id', pair.id);
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'closet-select pair-card';
      main.setAttribute('data-id', pair.id);
      if (isActive) main.setAttribute('aria-pressed', selected ? 'true' : 'false');
      main.innerHTML =
        photoHtml(pair, 'closet-photo') +
        '<span class="closet-body">' +
          '<span class="pair-name">' + escapeHtml(pair.nickname) + '</span>' +
          (selected ? '<span class="selected-pill">✓ Selected</span>' : '') +
          (isActive ? '' : '<span class="status-pill retired">Retired</span>') +
          '<span class="pair-meta">' + escapeHtml(FOAM_LABEL[pair.foam] || FOAM_LABEL.standard) + '</span>' +
          '<span class="pair-miles"><strong>' + formatMiles(worn) + '</strong> worn · ' + formatSteps(worn) + ' steps</span>' +
          '<span class="usage-bar-wrap">' +
            '<span class="usage-label">' + (pct >= 1 ? 'Check point reached (estimate)' : 'About ' + left + '% of check point left (estimate)') + '</span>' +
            '<span class="usage-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + left + '" aria-label="Estimated check point remaining">' +
              '<span class="usage-fill ' + usageFillClass(pct) + '"></span>' +
            '</span>' +
          '</span>' +
        '</span>';
      // Width via CSSOM: inline style attributes are blocked by the CSP (style-src 'self').
      main.querySelector('.usage-fill').style.width = left + '%';
      main.addEventListener('click', function () {
        if (!isActive) { openPairDetail(pair.id); return; }
        selectedPairId = pair.id;
        renderHome();
        const b = $('btn-wear-today');
        if (b) b.focus();
      });
      wrap.appendChild(main);
      if (isActive) {
        const det = document.createElement('button');
        det.type = 'button';
        det.className = 'btn btn-secondary closet-details';
        det.innerHTML = 'Details<span class="visually-hidden"> for ' + escapeHtml(pair.nickname) + '</span>';
        det.addEventListener('click', function () { openPairDetail(pair.id); });
        wrap.appendChild(det);
      }
      list.appendChild(wrap);
    }

    active.forEach(card);
    retired.forEach(card);

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'closet-add';
    add.id = 'btn-add-pair-tile';
    add.innerHTML = '<span class="closet-add-plus" aria-hidden="true">＋</span><span>Add pair</span>';
    add.addEventListener('click', function () { openPairForm(null); });
    list.appendChild(add);

    renderWearToday();
  }

  function renderWearToday() {
    const panel = $('wear-today');
    if (!panel) return;
    const actives = state.pairs.filter(function (p) { return p.status === 'active'; });
    panel.classList.toggle('hidden', actives.length === 0);
    const pair = state.pairs.find(function (p) { return p.id === selectedPairId; });
    const log = todayLog();
    const tp = todayPairId();
    const tpPair = tp ? state.pairs.find(function (p) { return p.id === tp; }) : null;
    $('wear-selected').textContent = pair
      ? 'Selected: ' + pair.nickname
      : 'Tap a pair above, then tap the button.';
    $('wear-status').textContent = log
      ? 'Today so far: ' + formatSteps(log.totalSteps) + ' steps (' + formatMiles(log.totalSteps) + ')' +
        (tpPair ? ' logged to ' + tpPair.nickname + '.' : '.')
      : 'Nothing logged for today yet.';
    if (document.activeElement !== $('wear-steps')) {
      $('wear-steps').value = log ? String(log.totalSteps) : '';
    }
    $('btn-wear-today').disabled = !pair;
  }

  /** Visually distinct, neutral card shown when an active pair crosses its estimated check point. */
  function checkpointAlert(pair) {
    const eff = pairEffectiveSteps(pair);
    const worn = pairStepsWorn(pair);
    const card = document.createElement('section');
    card.className = 'checkpoint-alert';
    card.setAttribute('data-pair', pair.id);
    const hid = 'ca-' + pair.id;
    card.setAttribute('aria-labelledby', hid);
    card.innerHTML =
      '<div class="ca-head"><span class="ca-icon" aria-hidden="true">👟</span>' +
      '<h3 id="' + escapeAttr(hid) + '">Time to check your shoes</h3></div>' +
      '<p><strong>' + escapeHtml(pair.nickname) + '</strong> has reached its estimated check point of about ' +
      formatSteps(pairThreshold(pair)) + ' effective steps (' + formatMiles(pairThreshold(pair)) + '). ' +
      'Estimated so far: ' + formatSteps(eff) + ' effective steps; ' + formatMiles(worn) + ' logged. ' +
      'This is a reminder based on your step count, not a verdict on the shoes. ' +
      'A quick look-and-press check can help you decide what to do next.</p>' +
      '<div class="ca-actions"></div>';
    const actions = card.querySelector('.ca-actions');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn btn-primary banner-go';
    go.setAttribute('data-pair', pair.id);
    go.textContent = 'Start check';
    actions.appendChild(go);
    appendCheckpointLinks(actions, pair);
    card.appendChild(linkNote());
    return card;
  }

  function linkNote() {
    const p = document.createElement('p');
    if (affiliateActive()) {
      p.className = 'hint affiliate-disclosure';
      p.textContent = AFFILIATE_DISCLOSURE;
    } else {
      p.className = 'hint';
      p.textContent = 'Links open a plain web search in a new tab. No tracking.';
    }
    return p;
  }

  function appendCheckpointLinks(container, pair) {
    container.appendChild(outLink(insolesUrl(pair), 'insoles', pair, '🔧', 'Replace the cushioning',
      'opens a web search for replacement insoles'));
    container.appendChild(outLink(shoesUrl(pair), 'shoes', pair, '🛒', 'Shop new shoes',
      'opens a web search for ' + (pair.brandModel || pair.nickname)));
  }

  function outLink(href, kind, pair, icon, label, srText) {
    const a = document.createElement('a');
    a.className = 'btn btn-secondary shop-link';
    a.href = href;
    a.target = '_blank';
    a.rel = AFFILIATE_LINKS[kind] && AFFILIATE_LINKS[kind].affiliateUrl ? 'sponsored noopener noreferrer' : 'noopener noreferrer';
    a.referrerPolicy = 'no-referrer';
    a.setAttribute('data-link', kind);
    a.setAttribute('data-shop', pair.id);
    a.innerHTML = '<span aria-hidden="true">' + icon + '</span> ' + escapeHtml(label) +
      ' <span class="visually-hidden">(' + escapeHtml(srText) + ', new tab)</span>';
    return a;
  }

  function renderToday() {
    $('log-date').value = todayISO();
    const sel = $('log-pair');
    sel.innerHTML = '';
    const actives = state.pairs.filter(function (p) { return p.status === 'active'; });
    if (actives.length === 0) {
      sel.innerHTML = '<option value="">Add a pair first</option>';
    } else {
      actives.forEach(function (p) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.nickname;
        sel.appendChild(o);
      });
      const def = defaultSelectedPair();
      if (def) sel.value = def;
    }

    const shiftSel = $('shift-template');
    shiftSel.innerHTML = '';
    state.shiftTemplates.forEach(function (t) {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.name + ' (~' + t.steps + ' steps)';
      shiftSel.appendChild(o);
    });
    updateShiftHint();

    const ul = $('recent-logs');
    ul.innerHTML = '';
    const recent = state.dayLogs.slice().sort(function (a, b) { return b.date.localeCompare(a.date); }).slice(0, 14);
    if (recent.length === 0) {
      ul.innerHTML = '<li>No logs yet.</li>';
    } else {
      recent.forEach(function (log) {
        const alloc = state.allocations.find(function (a) { return a.date === log.date; });
        const pair = alloc ? state.pairs.find(function (p) { return p.id === alloc.pairId; }) : null;
        const li = document.createElement('li');
        li.textContent = log.date + ' · ' + formatSteps(log.totalSteps) + ' steps (' + formatMiles(log.totalSteps) + ') · ' +
          log.source + (pair ? ' · ' + pair.nickname : '');
        ul.appendChild(li);
      });
    }
  }

  function updateShiftHint() {
    const id = $('shift-template').value;
    const t = state.shiftTemplates.find(function (x) { return x.id === id; });
    $('shift-hint').textContent = t
      ? 'Will log ' + t.steps + ' steps from this template (estimate of a typical shift).'
      : '';
  }

  function renderCheck() {
    const sel = $('check-pair');
    sel.innerHTML = '';
    state.pairs.filter(function (p) { return p.status === 'active'; }).forEach(function (p) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.nickname + ' (~' + formatSteps(pairEffectiveSteps(p)) + ' est. steps, ' + formatMiles(pairEffectiveSteps(p)) + ')';
      sel.appendChild(o);
    });
  }

  function renderSettings() {
    $('weight-band').value = state.profile.bodyWeightBand || '';
    $('usual-steps').value = state.profile.usualSteps || 8000;
    $('default-threshold').value = state.profile.defaultThreshold || DEFAULT_THRESHOLD;
    const wrap = $('shift-list');
    wrap.innerHTML = '';
    state.shiftTemplates.forEach(function (t) {
      const row = document.createElement('div');
      row.className = 'shift-row';
      row.innerHTML =
        '<input type="text" aria-label="Shift name" data-id="' + escapeAttr(t.id) + '" data-field="name" value="' + escapeAttr(t.name) + '">' +
        '<input type="number" aria-label="Steps" data-id="' + escapeAttr(t.id) + '" data-field="steps" value="' + t.steps + '" min="0" step="100">' +
        '<button type="button" class="btn btn-danger" data-remove="' + escapeAttr(t.id) + '" aria-label="Remove template">✕</button>';
      wrap.appendChild(row);
    });
    wrap.querySelectorAll('[data-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.shiftTemplates = state.shiftTemplates.filter(function (t) { return t.id !== btn.getAttribute('data-remove'); });
        renderSettings();
      });
    });
  }

  function openPairForm(pair) {
    $('pair-form-heading').textContent = pair ? 'Edit pair' : 'Add pair';
    $('pair-id').value = pair ? pair.id : '';
    $('pair-nickname').value = pair ? pair.nickname : '';
    $('pair-type').value = pair ? pair.type : 'work';
    $('pair-purchase').value = pair ? pair.purchaseDate : todayISO();
    $('pair-first-worn').value = pair ? (pair.firstWorn || pair.purchaseDate) : todayISO();
    $('pair-foam').value = pair && pair.foam ? pair.foam : 'standard';
    $('pair-brand').value = pair ? (pair.brandModel || '') : '';
    $('pair-start-steps').value = pair ? (pair.startSteps || 0) : 0;
    $('pair-threshold').value = pair && pair.checkThresholdOverride ? pair.checkThresholdOverride : '';
    $('pair-baseline').value = pair && pair.baselineGauge != null ? pair.baselineGauge : '';
    $('pair-photo').value = '';
    $('pair-photo-camera').value = '';
    pendingPhoto = undefined;
    showPhotoPreview(pair ? pair.photoDataUrl : null);
    showView('pair-form');
  }

  function openPairDetail(id) {
    const pair = state.pairs.find(function (p) { return p.id === id; });
    if (!pair) return;
    $('pair-detail-heading').textContent = pair.nickname;
    const pct = usagePct(pair);
    const checks = state.checks.filter(function (c) { return c.pairId === id; })
      .sort(function (a, b) { return b.date.localeCompare(a.date); });
    const worn = pairStepsWorn(pair);
    let checksHtml = '<h3 class="subhead">Checks</h3>';
    if (checks.length === 0) {
      checksHtml += '<p class="hint">No checks recorded yet.</p>';
    } else {
      checksHtml += '<ul class="list-plain">';
      checks.forEach(function (c) {
        checksHtml += '<li>' + escapeHtml(c.date) + ' · ' + escapeHtml(c.method) + ' · ' +
          escapeHtml(c.result) + (c.visual ? ' · crease ' + escapeHtml(c.visual.crease) + ', tilt ' +
          escapeHtml(c.visual.tilt) + ', press ' + escapeHtml(c.visual.press) : '') + (c.reading != null ? ' · reading ' + escapeHtml(String(c.reading)) : '') +
          (c.note ? ' — ' + escapeHtml(c.note) : '') + '</li>';
      });
      checksHtml += '</ul>';
    }
    $('pair-detail-body').innerHTML =
      (pair.photoDataUrl ? photoHtml(pair, 'pair-photo-large') : '') +
      '<dl class="detail-stats">' +
        '<dt>Worn</dt><dd>' + formatMiles(worn) + ' · ' + formatSteps(worn) + ' logged steps (miles = steps ÷ ' + STEPS_PER_MILE.toLocaleString() + ')</dd>' +
        '<dt>Type</dt><dd>' + escapeHtml(TYPE_LABEL[pair.type] || pair.type) +
          ' (typeFactor ' + typeFactor(pair.type) + ' — estimate)</dd>' +
        '<dt>Estimated effective steps</dt><dd>' + formatSteps(pairEffectiveSteps(pair)) + ' (' + formatMiles(pairEffectiveSteps(pair)) + ')</dd>' +
        '<dt>Foam</dt><dd>' + escapeHtml(FOAM_LABEL[pair.foam] || FOAM_LABEL.standard) +
          ' (factor ' + foamFactor(pair.foam) + ' — estimate)</dd>' +
        '<dt>First worn</dt><dd>' + escapeHtml(pair.firstWorn || pair.purchaseDate || '') +
          ' (age factor ' + ageMultiplier(pair.firstWorn || pair.purchaseDate).toFixed(2) + ' — estimate)</dd>' +
        '<dt>Last worn</dt><dd>' + escapeHtml(lastWornText(pair).replace('Last worn: ', '')) + '</dd>' +
        '<dt>Check point</dt><dd>' + formatSteps(pairThreshold(pair)) + ' effective steps, about ' + formatMiles(pairThreshold(pair)) +
          ' (heuristic: base ' + formatSteps(baseThreshold(pair)) + ' adjusted for foam and age; weight band counts on the usage side)</dd>' +
        '<dt>Usage</dt><dd>About ' + Math.min(100, Math.round(pct * 100)) + '% of check point ' + usageIcon(pct) + '</dd>' +
        (pair.brandModel ? '<dt>Brand / model</dt><dd>' + escapeHtml(pair.brandModel) + '</dd>' : '') +
        '<dt>Started</dt><dd>' + escapeHtml(pair.purchaseDate) + '</dd>' +
        '<dt>Baseline gauge</dt><dd>' + (pair.baselineGauge != null ? escapeHtml(String(pair.baselineGauge)) : 'Not set') + '</dd>' +
        '<dt>Status</dt><dd>' + escapeHtml(pair.status) + '</dd>' +
      '</dl>' +
      checksHtml +
      '<div class="btn-row">' +
        '<button type="button" class="btn btn-secondary" id="btn-edit-pair">Edit</button>' +
        (pair.status === 'active'
          ? '<button type="button" class="btn btn-danger" id="btn-retire-pair">Retire pair</button>'
          : '<button type="button" class="btn btn-secondary" id="btn-reactivate-pair">Reactivate</button>') +
      '</div>' +
      '<div id="detail-shop"></div>';
    if (pair.status === 'active' && pct >= 1) {
      const box = $('detail-shop');
      box.className = 'ca-actions';
      appendCheckpointLinks(box, pair);
      box.appendChild(linkNote());
    }
    $('btn-edit-pair').addEventListener('click', function () { openPairForm(pair); });
    const retireBtn = $('btn-retire-pair');
    if (retireBtn) {
      retireBtn.addEventListener('click', async function () {
        pair.status = 'retired';
        await saveState();
        toast('Pair retired');
        openPairDetail(id);
      });
    }
    const reactBtn = $('btn-reactivate-pair');
    if (reactBtn) {
      reactBtn.addEventListener('click', async function () {
        pair.status = 'active';
        await saveState();
        toast('Pair reactivated');
        openPairDetail(id);
      });
    }
    showView('pair-detail');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // --- CSV stub ---
  function parseCsvStub(text) {
    // Minimal stub: look for a column that looks like steps and a date column.
    // Real fixtures for Google Fit / Samsung / Apple come later (see TODO.md).
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) {
      return { ok: false, message: 'CSV looks empty. (Stub parser — real fixtures not wired yet.)' };
    }
    const header = lines[0].toLowerCase();
    if (header.indexOf('step') === -1 && header.indexOf('count') === -1) {
      return {
        ok: false,
        message: 'Stub: no "steps"/"count" column found. Label this import as incomplete — use manual entry for now. (AI-written stub message)',
      };
    }
    // Sum numeric cells that look like step counts from data rows (very naive)
    let total = 0;
    let days = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      for (let j = 0; j < cols.length; j++) {
        const n = parseInt(cols[j].replace(/"/g, '').trim(), 10);
        if (!isNaN(n) && n > 100 && n < 100000) {
          total += n;
          days++;
          break;
        }
      }
    }
    if (days === 0) {
      return { ok: false, message: 'Stub: could not find step values. Use manual entry. (AI-written stub)' };
    }
    return {
      ok: true,
      message: 'Stub import: found ~' + days + ' day(s), total ~' + total +
        ' steps. Applying as a single combined day log for the selected date. Real per-day mapping comes later. (AI-written stub)',
      totalSteps: total,
      days: days,
    };
  }

  // --- events ---
  function bind() {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        showView(tab.getAttribute('data-view'));
      });
    });

    $('btn-add-pair').addEventListener('click', function () { openPairForm(null); });
    $('btn-pair-cancel').addEventListener('click', function () { showView('home'); });
    $('btn-detail-back').addEventListener('click', function () { showView('home'); });

    ['pair-photo', 'pair-photo-camera'].forEach(function (inputId) {
      $(inputId).addEventListener('change', async function () {
        const f = $(inputId).files[0];
        if (!f) return;
        try {
          pendingPhoto = await downscalePhoto(f);
          showPhotoPreview(pendingPhoto);
        } catch (err) {
          toast('Could not read that photo');
        }
        $(inputId).value = '';
      });
    });
    $('btn-photo-remove').addEventListener('click', function () {
      pendingPhoto = '';
      showPhotoPreview(null);
    });

    $('btn-wear-today').addEventListener('click', wearToday);

    $('form-pair').addEventListener('submit', async function (e) {
      e.preventDefault();
      const id = $('pair-id').value || uid();
      const existing = state.pairs.find(function (p) { return p.id === id; });
      let photoDataUrl = existing ? (existing.photoDataUrl || null) : null;
      if (pendingPhoto !== undefined) photoDataUrl = pendingPhoto || null;
      const thrRaw = $('pair-threshold').value;
      const baseRaw = $('pair-baseline').value;
      const pair = {
        id: id,
        nickname: $('pair-nickname').value.trim(),
        type: $('pair-type').value,
        purchaseDate: $('pair-purchase').value,
        firstWorn: $('pair-first-worn').value || $('pair-purchase').value,
        foam: FOAM_FACTOR[$('pair-foam').value] != null ? $('pair-foam').value : 'standard',
        brandModel: $('pair-brand').value.trim(),
        createdAt: existing && existing.createdAt ? existing.createdAt : todayISO(),
        startSteps: Number($('pair-start-steps').value) || 0,
        status: existing ? existing.status : 'active',
        baselineGauge: baseRaw === '' ? null : Number(baseRaw),
        checkThresholdOverride: thrRaw === '' ? null : Number(thrRaw),
        photoDataUrl: photoDataUrl,
      };
      if (existing) {
        Object.assign(existing, pair);
      } else {
        state.pairs.push(pair);
        if (!selectedPairId) selectedPairId = pair.id;
      }
      pendingPhoto = undefined;
      await saveState();
      toast('Pair saved');
      showView('home');
    });

    document.querySelectorAll('input[name="log-source"]').forEach(function (r) {
      r.addEventListener('change', function () {
        const v = document.querySelector('input[name="log-source"]:checked').value;
        $('manual-fields').classList.toggle('hidden', v !== 'manual');
        $('shift-fields').classList.toggle('hidden', v !== 'shift');
        $('csv-fields').classList.toggle('hidden', v !== 'csv');
      });
    });

    $('shift-template').addEventListener('change', updateShiftHint);

    $('btn-same-usual').addEventListener('click', function () {
      $('log-steps').value = state.profile.usualSteps || 8000;
    });

    $('csv-file').addEventListener('change', function () {
      const f = $('csv-file').files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = function () {
        const result = parseCsvStub(String(reader.result || ''));
        $('csv-status').textContent = result.message;
        if (result.ok) {
          $('csv-status').dataset.steps = String(result.totalSteps);
        } else {
          delete $('csv-status').dataset.steps;
        }
      };
      reader.readAsText(f);
    });

    $('form-log-steps').addEventListener('submit', async function (e) {
      e.preventDefault();
      const source = document.querySelector('input[name="log-source"]:checked').value;
      const date = $('log-date').value;
      const pairId = $('log-pair').value;
      if (!pairId) {
        toast('Add a pair first');
        return;
      }
      let steps = 0;
      if (source === 'manual') {
        steps = Number($('log-steps').value);
        if (!steps && steps !== 0) {
          toast('Enter steps');
          return;
        }
      } else if (source === 'shift') {
        const t = state.shiftTemplates.find(function (x) { return x.id === $('shift-template').value; });
        if (!t) { toast('Pick a shift template'); return; }
        steps = t.steps;
      } else if (source === 'csv') {
        const s = $('csv-status').dataset.steps;
        if (!s) { toast('Import a CSV first (stub)'); return; }
        steps = Number(s);
      }
      const standing = Number($('log-standing').value) || 0;
      await logDay(date, steps, standing, source, pairId);
      toast('Day log saved');
      $('log-steps').value = '';
      $('log-standing').value = '';
      renderToday();
      maybeNotifyChecks();
    });

    $('form-check').addEventListener('submit', async function (e) {
      e.preventDefault();
      const pairId = $('check-pair').value;
      if (!pairId) { toast('Pick a pair'); return; }
      const result = document.querySelector('input[name="check-result"]:checked').value;
      const readingRaw = $('check-reading').value;
      const check = {
        pairId: pairId,
        date: todayISO(),
        method: $('check-method').value,
        result: result,
        reading: readingRaw === '' ? null : Number(readingRaw),
        note: $('check-note').value.trim(),
        visual: {
          crease: radioVal('vc-crease'),
          tilt: radioVal('vc-tilt'),
          press: radioVal('vc-press'),
        },
      };
      state.checks.push(check);
      const pair = state.pairs.find(function (p) { return p.id === pairId; });
      if (pair && $('check-retire').checked) {
        pair.status = 'retired';
      }
      // If first gauge reading and no baseline, store as baseline
      if (pair && check.method === 'gauge' && check.reading != null && pair.baselineGauge == null) {
        pair.baselineGauge = check.reading;
      }
      await saveState();
      toast('Check saved');
      $('check-note').value = '';
      $('check-reading').value = '';
      $('check-retire').checked = false;
      resetVisualChecks();
      showView('home');
    });

    ['vc-crease', 'vc-tilt', 'vc-press'].forEach(function (name) {
      document.querySelectorAll('input[name="' + name + '"]').forEach(function (r) {
        r.addEventListener('change', applySuggestedOutcome);
      });
    });

    $('form-settings').addEventListener('submit', async function (e) {
      e.preventDefault();
      state.profile.bodyWeightBand = $('weight-band').value;
      state.profile.usualSteps = Number($('usual-steps').value) || 8000;
      state.profile.defaultThreshold = Number($('default-threshold').value) || DEFAULT_THRESHOLD;
      // collect shift edits
      $('shift-list').querySelectorAll('input[data-id]').forEach(function (inp) {
        const t = state.shiftTemplates.find(function (x) { return x.id === inp.getAttribute('data-id'); });
        if (!t) return;
        if (inp.getAttribute('data-field') === 'name') t.name = inp.value.trim() || t.name;
        if (inp.getAttribute('data-field') === 'steps') t.steps = Number(inp.value) || 0;
      });
      await saveState();
      toast('Settings saved');
    });

    $('btn-add-shift').addEventListener('click', function () {
      state.shiftTemplates.push({ id: uid(), name: 'New shift', steps: 10000 });
      renderSettings();
    });

    $('btn-export').addEventListener('click', function () {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'shoe-life-export-' + todayISO() + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Exported');
    });

    $('btn-import').addEventListener('change', function () {
      const f = $('btn-import').files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = async function () {
        try {
          const data = JSON.parse(String(reader.result));
          if (!data || !Array.isArray(data.pairs)) throw new Error('bad shape');
          state = migrateState(data);
          await saveState();
          toast('Imported');
          showView('home');
        } catch (err) {
          toast('Import failed — check JSON');
        }
        $('btn-import').value = '';
      };
      reader.readAsText(f);
    });

    $('btn-wipe').addEventListener('click', async function () {
      if (!confirm('Wipe all Shoe Life data on this device? This cannot be undone.')) return;
      await wipeDb();
      toast('All data wiped');
      showView('home');
    });
  }

  /**
   * Upsert one day log and give 100% of that day to one pair (the existing v0.1 active-pair rule).
   * Shared by the Log steps form and the dashboard 'Wearing These Today' button.
   */
  async function logDay(date, steps, standing, source, pairId) {
    const existing = state.dayLogs.find(function (l) { return l.date === date; });
    if (existing) {
      existing.totalSteps = steps;
      existing.standingHours = standing;
      existing.source = source;
    } else {
      state.dayLogs.push({ date: date, totalSteps: steps, standingHours: standing, source: source });
    }
    state.allocations = state.allocations.filter(function (a) { return a.date !== date; });
    state.allocations.push({ date: date, pairId: pairId, fraction: 1.0 });
    selectedPairId = pairId;
    await saveState();
  }

  async function wearToday() {
    const pair = state.pairs.find(function (p) { return p.id === selectedPairId && p.status === 'active'; });
    if (!pair) { toast('Tap a pair first'); return; }
    const raw = String($('wear-steps').value || '').trim();
    const existing = todayLog();
    let steps;
    let source = 'manual';
    let standing = 0;
    if (raw === '') {
      if (!existing) { toast('Enter today\'s steps'); $('wear-steps').focus(); return; }
      steps = Number(existing.totalSteps) || 0;
      source = existing.source || 'manual';
    } else {
      steps = Math.round(Number(raw));
      if (!isFinite(steps) || steps < 0 || steps > 100000) { toast('Enter steps between 0 and 100,000'); return; }
    }
    if (existing) standing = Number(existing.standingHours) || 0;
    await logDay(todayISO(), steps, standing, source, pair.id);
    if (document.activeElement === $('wear-steps')) $('wear-steps').blur();
    toast(formatSteps(steps) + ' steps today → ' + pair.nickname);
    renderHome();
    maybeNotifyChecks();
  }

  function showPhotoPreview(dataUrl) {
    const img = $('pair-photo-preview');
    if (dataUrl) {
      img.src = dataUrl;
      img.classList.remove('hidden');
      $('btn-photo-remove').classList.remove('hidden');
    } else {
      img.removeAttribute('src');
      img.classList.add('hidden');
      $('btn-photo-remove').classList.add('hidden');
    }
  }

  /** Downscale a picked/taken photo on-device to fit PHOTO_MAX_PX and re-encode as JPEG. Never uploaded. */
  function downscalePhoto(file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        try {
          const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
          const scale = Math.min(1, PHOTO_MAX_PX / Math.max(w0, h0));
          const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          URL.revokeObjectURL(url);
          resolve(canvas.toDataURL('image/jpeg', PHOTO_JPEG_QUALITY));
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = function (e) { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }

  function radioVal(name) {
    const el = document.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : 'skip';
  }

  function applySuggestedOutcome() {
    const c = radioVal('vc-crease'), t = radioVal('vc-tilt'), p = radioVal('vc-press');
    if (c === 'skip' && t === 'skip' && p === 'skip') { $('vc-suggest').textContent = ''; return; }
    const out = suggestOutcome(c, t, p);
    const r = document.querySelector('input[name="check-result"][value="' + out + '"]');
    if (r) r.checked = true;
    const label = { ok: 'Looks fine for now', watch: 'Worth a closer look', replace: 'Consider replacing soon' }[out];
    $('vc-suggest').textContent = 'Suggested result: ' + label + '. You can change it below.';
  }

  function resetVisualChecks() {
    ['vc-crease', 'vc-tilt', 'vc-press'].forEach(function (name) {
      const r = document.querySelector('input[name="' + name + '"][value="skip"]');
      if (r) r.checked = true;
    });
    $('vc-suggest').textContent = '';
  }

  function maybeNotifyChecks() {
    const needing = state.pairs.filter(function (p) { return promptLevel(p); });
    if (needing.length === 0) return;
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      needing.slice(0, 2).forEach(function (p) {
        const eff = pairEffectiveSteps(p);
        try {
          new Notification('Shoe Life', {
            body: p.nickname + ': about ' + formatSteps(eff) + ' estimated steps. Time to check your shoes.',
            tag: 'shoe-life-' + p.id,
          });
        } catch (_) { /* ignore */ }
      });
    } else if (Notification.permission === 'default') {
      // Ask once lightly — optional local notifications, no push server
      Notification.requestPermission();
    }
  }

  // Verify required footer is present (dev sanity)
  function assertFooter() {
    const foot = document.querySelector('.app-footer');
    if (!foot || foot.textContent.indexOf("can't tell you how your shoes") === -1) {
      console.warn('Required footer missing or altered');
    }
  }

  // Expose for tests (optional)
  window.ShoeLife = {
    TYPE_FACTOR: TYPE_FACTOR,
    WEIGHT_FACTOR: WEIGHT_FACTOR,
    STANDING_STEP_EQUIVALENT: STANDING_STEP_EQUIVALENT,
    DEFAULT_THRESHOLD: DEFAULT_THRESHOLD,
    REQUIRED_FOOTER: REQUIRED_FOOTER,
    effectiveForDay: function (log, pair, band) {
      const saved = state.profile.bodyWeightBand;
      if (band != null) state.profile.bodyWeightBand = band;
      const r = effectiveForDay(log, pair);
      state.profile.bodyWeightBand = saved;
      return r;
    },
    parseCsvStub: parseCsvStub,
    FOAM_FACTOR: FOAM_FACTOR,
    migrateState: migrateState,
    ageMultiplier: ageMultiplier,
    suggestOutcome: suggestOutcome,
    shopUrl: shopUrl,
    STEPS_PER_MILE: STEPS_PER_MILE,
    LEGACY_DEFAULT_THRESHOLD: LEGACY_DEFAULT_THRESHOLD,
    AFFILIATE_LINKS: AFFILIATE_LINKS,
    AFFILIATE_DISCLOSURE: AFFILIATE_DISCLOSURE,
    stepsToMiles: stepsToMiles,
    formatMiles: formatMiles,
    insolesUrl: insolesUrl,
    shoesUrl: shoesUrl,
    affiliateActive: affiliateActive,
    /** Test helper: run fn with a temporary state (migrated), then restore. */
    withState: function (s, fn) {
      const saved = state;
      state = migrateState(s);
      try { return fn({ usagePct: usagePct, pairStepsWorn: pairStepsWorn, pairEffectiveSteps: pairEffectiveSteps, pairThreshold: pairThreshold, state: state }); }
      finally { state = saved; }
    },
    pairThreshold: function (pair, profile, now) {
      const saved = state.profile;
      if (profile) state.profile = Object.assign({}, saved, profile);
      const r = pairThreshold(pair, now);
      state.profile = saved;
      return r;
    },
  };

  async function init() {
    assertFooter();
    try {
      db = await openDb();
      const loaded = await loadState();
      if (loaded) {
        state = migrateState(loaded);
        if (loaded.version !== STATE_VERSION) await saveState();
      }
    } catch (err) {
      console.error('IndexedDB unavailable, using memory only', err);
    }
    bind();
    showView('home');

    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('sw.js');
      } catch (err) {
        console.warn('SW register failed', err);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
