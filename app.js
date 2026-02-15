class TradingSignalsApp {
  constructor() {
    // Runtime state
    this.currentLanguage = 'en';
    this.currentMarket = 'forex'; // 'forex' | 'otc'
    this.selectedExpiration = null; // seconds
    this.isLoading = false;
    this.cooldownTimers = {}; // key: pair => intervalId
    this.tradingViewWidget = null;

    // Данные с сервера
    this.flags = {};                // { lang: flagPath }
    this.translations = {};         // { lang: { key: value } }
    this.marketData = { forex: [], otc: [] }; // { forex: string[], otc: string[] }
    this.signalHistory = {};

    // UI state
    this.hasActualSignal = false;   // получили ли реальный сигнал в текущей сессии
    this.lastDisplayedSignal = null;

    document.addEventListener('DOMContentLoaded', () => this.bootstrap());
  }

  // ---------------------- Bootstrap ----------------------
  async bootstrap() {
    await this.loadConfig();
    this.applyLangFromUrl();
    this.buildLanguageDropdown();
    this.signalHistory = this.loadSignalHistory();
    this.init();
  }

  applyLangFromUrl() {
    const params  = new URLSearchParams(window.location.search);
    const rawLang = (params.get('lang') || params.get('utm_lang') || '').toLowerCase();
    const langs   = Object.keys(this.translations || {});

    if (rawLang) {
      // если язык из URL поддержан — используем его; иначе принудительно 'en'
      const chosen = langs.includes(rawLang) ? rawLang : 'en';
      this.currentLanguage = chosen;
      localStorage.setItem('preferred-language', chosen);
      // параметр из URL НЕ удаляем
    }
  }

  async loadConfig() {
    try {
      const resp = await fetch('config.php?ts=' + Date.now(), {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Accept': 'application/json' }
      });
      if (!resp.ok) throw new Error('Config HTTP ' + resp.status);
      const cfg = await resp.json();

      if (cfg && cfg.flags && typeof cfg.flags === 'object') this.flags = cfg.flags;
      if (cfg && cfg.translations && typeof cfg.translations === 'object') this.translations = cfg.translations;

      if (cfg && cfg.markets && (Array.isArray(cfg.markets.forex) || Array.isArray(cfg.markets.otc))) {
        this.marketData.forex = Array.isArray(cfg.markets.forex) ? cfg.markets.forex : [];
        this.marketData.otc   = Array.isArray(cfg.markets.otc)   ? cfg.markets.otc   : [];
        if (!this.marketData.otc.length && this.marketData.forex.length) {
          this.marketData.otc = this.marketData.forex.map(p => 'OTC ' + p);
        }
      } else if (Array.isArray(cfg.pairs)) {
        this.marketData.forex = cfg.pairs;
        this.marketData.otc   = cfg.pairs.map(p => 'OTC ' + p);
      }
    } catch (e) {
      console.error('Config load error:', e);
    }
  }

  // Построить выпадающий список языков
  buildLanguageDropdown() {
    const dd = document.getElementById('languageDropdown');
    const btnFlag = document.getElementById('currentFlag');
    const btnLang = document.getElementById('currentLanguage');
    if (!dd) return;

    dd.innerHTML = '';

    const langs = Object.keys(this.translations || {});
    langs.forEach((lang) => {
      const opt = document.createElement('div');
      opt.className = 'language-option';
      opt.dataset.lang = lang;

      const img = document.createElement('img');
      img.className = 'flag';
      img.width = 20; img.height = 15;
      img.src = this.getFlagSrc(lang);
      img.alt = lang;

      const span = document.createElement('span');
      span.className = 'language-name';
      span.textContent = this.humanLangName(lang);

      opt.appendChild(img);
      opt.appendChild(span);
      dd.appendChild(opt);
    });

    const active = dd.querySelector(`.language-option[data-lang="${this.currentLanguage}"]`);
    if (active) active.classList.add('active');

    if (btnFlag) btnFlag.src = this.getFlagSrc(this.currentLanguage);
    if (btnLang) btnLang.textContent = this.humanLangName(this.currentLanguage);
  }

  humanLangName(code) {
    const names = {
      en:'English', ru:'Русский', uk:'Українська', es:'Español', de:'Deutsch',
      pt:'Português', hi:'हिन्दी', tr:'Türkçe', ar:'العربية',
      uz:"O'zbekcha", tg:'Тоҷикӣ', az:'Azərbaycan', am:'Հայերեն'
    };
    return names[code] || code.toUpperCase();
  }

  applyRtlIfNeeded() {
    const root = document.documentElement;
    if (this.currentLanguage === 'ar') {
      root.setAttribute('dir', 'rtl');
      root.setAttribute('lang', 'ar');
    } else {
      root.setAttribute('dir', 'ltr');
      root.setAttribute('lang', this.currentLanguage || 'en');
    }
  }

  tvLocale() {
    const map = {
      en:'en', ru:'ru', uk:'uk', es:'es', de:'de', pt:'pt',
      hi:'hi', tr:'tr', ar:'ar', uz:'en', tg:'en', az:'az', am:'hy'
    };
    return map[this.currentLanguage] || 'en';
  }

  getCurrentSymbol() {
    const pair = this.getCurrentPair();
    return pair ? ('FX:' + pair.replace('/', '')) : 'FX:EURUSD';
  }

  // ---------------------- Init ----------------------
  init() {
    this.detectLanguage();
    this.setupEventListeners();
    this.updateTranslations();

    if (this.currentMarket === 'forex' && this.isForexMarketClosed()) {
      this.currentMarket = 'otc';
      this.toast(this.t('weekendMessage'));
    }

    this.updateExpirationButtons(this.currentMarket);
    this.loadMarketPairs();
    this.updateMarketTabStates();

    this.initTradingView();

    this.addAnimations();
    this.updateCooldownDisplay();

    // На старте блок с тире (плейсхолдер)
    this.showPlaceholder();
  }

  // Показать плейсхолдер «–» и НЕ скрывать карточку
  showPlaceholder() {
    const res   = document.getElementById('signalResult');
    const dirEl = document.getElementById('signalDirection');
    const confEl= document.getElementById('confidenceLevel');
    const tsEl  = document.getElementById('signalTimestamp');
    const pairEl= document.getElementById('signalPair');
    const expEl = document.getElementById('signalExpiration');

    if (!res) return;

    if (dirEl) { dirEl.textContent = '–'; dirEl.className = 'signal-value signal-direction'; }
    if (confEl){ confEl.textContent = '–'; confEl.className = 'signal-value'; }
    if (tsEl)  { tsEl.textContent = new Date().toLocaleTimeString(); } // как на скрине
    if (pairEl){ const p = this.getCurrentPair(); if (p) pairEl.textContent = p; }
    if (expEl) { const t = this.selectedExpiration; expEl.textContent = (t && t<60) ? `${t}s` : (t? `${Math.round(t/60)}m` : ''); }

    res.style.display = 'block';
    res.classList.add('show');
  }

  // ---------------------- Language ----------------------
  detectLanguage() {
    const saved = localStorage.getItem('preferred-language');
    const langs = Object.keys(this.translations || {});
    if (saved && langs.includes(saved)) {
      this.currentLanguage = saved;
    } else {
      const nav = (navigator.language || 'en').toLowerCase();
      const base = nav.slice(0,2);
      const pick = langs.includes(base) ? base
                : (langs.includes('ru') && nav.startsWith('ru')) ? 'ru'
                : (langs.includes('uk') && nav.startsWith('uk')) ? 'uk'
                : (langs[0] || 'en');
      this.currentLanguage = pick;
      localStorage.setItem('preferred-language', this.currentLanguage);
    }

    const flag = document.getElementById('currentFlag');
    if (flag) flag.src = this.getFlagSrc(this.currentLanguage);
    this.applyRtlIfNeeded();
  }

  t(key) {
    const pack = (this.translations && this.translations[this.currentLanguage]) || {};
    return (key in pack) ? pack[key] : key;
  }

  getFlagSrc(lang) {
    return (this.flags && this.flags[lang]) ? this.flags[lang] : (this.flags['en'] || '');
  }

  updateTranslations() {
    const ids = {
      appTitle: 'appTitle',
      appSubtitle: 'appSubtitle',
      panelTitle: 'panelTitle',
      currencyPairLabel: 'currencyPair',
      expirationTimeLabel: 'expirationTime',
      getSignalText: 'getSignal',
      signalGeneratedText: 'signalGenerated',
      signalDirectionLabel: 'signalDirection',
      confidenceLabel: 'confidence',
      chartTitle: 'chartTitle',
      chartSubtitle: 'chartSubtitle',
      forexTabText: 'forexTab',
      otcTabText: 'otcTab'
    };
    Object.entries(ids).forEach(([elId, key]) => {
      const el = document.getElementById(elId);
      if (el) el.textContent = this.t(key);
    });

    const flag = document.getElementById('currentFlag');
    const currentLanguageEl = document.getElementById('currentLanguage');
    if (flag) flag.src = this.getFlagSrc(this.currentLanguage);
    if (currentLanguageEl) {
      const activeOpt = document.querySelector(`.language-option[data-lang="${this.currentLanguage}"] .language-name`);
      currentLanguageEl.textContent = activeOpt ? activeOpt.textContent : this.currentLanguage;
    }

    this.applyRtlIfNeeded();

    // если уже есть реальный сигнал — перерисуем его в новой локали
    if (this.hasActualSignal && this.lastDisplayedSignal) {
      this.displaySignal(this.lastDisplayedSignal);
    } else {
      // иначе просто обновим плейсхолдер
      this.showPlaceholder();
    }

    if (this.tradingViewWidget && this.currentMarket === 'forex') {
      this.recreateTradingViewWidget(this.getCurrentSymbol());
    }
  }

  // ---------------------- Events ----------------------
  setupEventListeners() {
    // Language dropdown
    const btn = document.getElementById('languageSelectorBtn');
    const dd  = document.getElementById('languageDropdown');
    if (btn && dd) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        dd.classList.toggle('show');
        btn.classList.toggle('active');
      });
      document.addEventListener('click', (e) => {
        if (!btn.contains(e.target) && !dd.contains(e.target)) {
          dd.classList.remove('show');
          btn.classList.remove('active');
        }
      });

      dd.addEventListener('click', (e) => {
        const opt = e.target.closest('.language-option');
        if (!opt) return;
        const lang = opt.dataset.lang;
        if (!lang || !this.translations[lang]) return;

        this.currentLanguage = lang;
        localStorage.setItem('preferred-language', lang);

        dd.querySelectorAll('.language-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        dd.classList.remove('show');

        this.updateTranslations();
      });
    }

    // Market tabs
    document.querySelectorAll('.market-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const market = e.currentTarget?.dataset?.market;
        if (market) this.switchMarket(market);
      });
    });

    // Expiration buttons (delegated)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.expiration-btn');
      if (!btn) return;
      this.selectExpirationTime(btn);
      // если сигнала ещё не было — просто обновим плейсхолдер (время)
      if (!this.hasActualSignal) this.showPlaceholder();
    });

    // Get signal
    const getBtn = document.getElementById('getSignalBtn');
    if (getBtn) getBtn.addEventListener('click', () => this.generateSignal());

    // Pair change
    const pairSelect = document.getElementById('currencyPair');
    if (pairSelect) pairSelect.addEventListener('change', (e) => {
      const newPair = e.target.value;
      const oldPair = this.getCurrentPair();
      if (oldPair && oldPair !== newPair) this.stopCooldownTimer(oldPair);
      if (this.currentMarket === 'forex') this.updateTradingViewSymbol(newPair);

      // если ещё не было реального сигнала — держим плейсхолдер
      if (!this.hasActualSignal) this.showPlaceholder();

      this.updateCooldownDisplay();
    });
  }

  // ---------------------- Markets / pairs ----------------------
  isWeekend() {
    const d = new Date().getUTCDay();
    return d === 0 || d === 6;
  }

  isForexMarketClosed() {
    return this.isWeekend();
  }

  switchMarket(target) {
    let market = target;

    if (market === 'forex' && this.isForexMarketClosed()) {
      this.toast(this.t('weekendMessage'));
      market = 'otc';
    }

    Object.keys(this.cooldownTimers).forEach((pair) => this.stopCooldownTimer(pair));

    this.currentMarket = market;
    this.updateMarketTabStates();
    this.updateExpirationButtons(market);
    this.loadMarketPairs();

    if (market === 'forex') {
      const first = (this.marketData[market] || [])[0];
      if (first) this.updateTradingViewSymbol(first);
      this.showTradingViewChart();
    }

    // если ещё не было реального сигнала — держим плейсхолдер
    if (!this.hasActualSignal) this.showPlaceholder();

    this.updateCooldownDisplay();
  }

  updateMarketTabStates() {
    document.querySelectorAll('.market-tab').forEach(t => t.classList.remove('active'));
    const cur = document.querySelector(`.market-tab[data-market="${this.currentMarket}"]`);
    if (cur) cur.classList.add('active');
  }

  loadMarketPairs() {
    const sel = document.getElementById('currencyPair');
    if (!sel) return;

    const list = (this.marketData && this.marketData[this.currentMarket]) ? this.marketData[this.currentMarket] : [];
    sel.innerHTML = '';
    list.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p; opt.textContent = p; sel.appendChild(opt);
    });

    if (list.length) {
      const first = list[0];
      sel.value = first;
      if (this.currentMarket === 'forex') this.updateTradingViewSymbol(first);
      // Историю больше не показываем автоматически
    }
  }

  // ---------------------- Expiration ----------------------
  updateExpirationButtons(market) {
    const all = document.querySelectorAll('.expiration-btn');
    all.forEach(b => { b.style.display = 'none'; b.classList.remove('active'); });

    const visible = document.querySelectorAll(`.expiration-btn[data-market="${market}"]`);
    visible.forEach(b => { b.style.display = 'flex'; });

    let minBtn = null; let min = Infinity;
    visible.forEach(b => {
      const t = parseInt(b.dataset.time, 10);
      if (!Number.isNaN(t) && t < min) { min = t; minBtn = b; }
    });

    if (minBtn) {
      minBtn.classList.add('active');
      this.selectedExpiration = parseInt(minBtn.dataset.time, 10);
      setTimeout(() => this.updateCooldownDisplay(), 50);
    }
  }

  selectExpirationTime(btn) {
    const market = this.currentMarket;
    document.querySelectorAll(`.expiration-btn[data-market="${market}"]`).forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const t = parseInt(btn.dataset.time, 10);
    this.selectedExpiration = Number.isNaN(t) ? null : t;
    this.updateCooldownDisplay();
  }

  // ---------------------- Signals ----------------------
  generateSignal() {
    if (this.isLoading) return;
    if (this.currentMarket === 'forex' && this.isForexMarketClosed()) {
      this.toast(this.t('weekendMessage'));
      return;
    }
    if (!this.selectedExpiration || Number.isNaN(this.selectedExpiration)) {
      this.updateExpirationButtons(this.currentMarket);
      return;
    }
    if (this.isInCooldown()) return;

    this.isLoading = true;
    const btn = document.getElementById('getSignalBtn');
    const prevHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.classList.add('loading');
      btn.innerHTML = `<div class="loading-spinner"></div><span>${this.t('loading')}</span>`;
    }

    const delay = 1200 + Math.random() * 1200;
    setTimeout(() => {
      const signal = this.createFakeSignal();
      this.displaySignal(signal);
      this.saveSignal(signal);
      this.hasActualSignal = true;
      this.lastDisplayedSignal = signal;

      this.startCooldown(this.selectedExpiration);
      if (btn) {
        btn.innerHTML = prevHtml;
        btn.classList.remove('loading');
        btn.disabled = false;
      }
      this.isLoading = false;
      this.updateCooldownDisplay();
    }, delay);
  }

  createFakeSignal() {
    const direction = Math.random() > 0.5 ? 'buy' : 'sell';
    const r = Math.random();
    const confidence = r > 0.7 ? 'high' : r > 0.4 ? 'medium' : 'low';
    const pair = this.getCurrentPair();
    return {
      direction,
      confidence,
      pair,
      market: this.currentMarket,
      expiration: this.selectedExpiration,
      timestamp: new Date().toLocaleTimeString(),
      createdAt: Date.now()
    };
  }

  displaySignal(s) {
    const res = document.getElementById('signalResult');
    if (!res) return;
    const pairEl = document.getElementById('signalPair');
    const expEl = document.getElementById('signalExpiration');
    const dirEl = document.getElementById('signalDirection');
    const confEl = document.getElementById('confidenceLevel');
    const tsEl = document.getElementById('signalTimestamp');

    if (pairEl) pairEl.textContent = s.pair;
    if (expEl) expEl.textContent = s.expiration < 60 ? `${s.expiration}s` : `${Math.round(s.expiration/60)}m`;

    if (dirEl) {
      dirEl.className = 'signal-value signal-direction ' + (s.direction === 'buy' ? 'buy' : 'sell');
      dirEl.innerHTML = `<span>${this.t(s.direction)}</span>`;
    }

    if (confEl) {
      confEl.className = 'signal-value confidence-' + s.confidence;
      confEl.textContent = this.t(s.confidence);
    }

    if (tsEl) tsEl.textContent = s.timestamp;

    res.style.display = 'block';
    res.classList.add('show');
    res.style.animation = 'fadeIn 0.4s ease-out';
  }

  saveSignal(s) {
    const key = `signal_${s.market}_${s.pair}`;
    this.signalHistory[key] = s;
    localStorage.setItem('trading_signals_history', JSON.stringify(this.signalHistory));
  }

  loadSignalHistory() {
    try {
      const raw = localStorage.getItem('trading_signals_history');
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }

  // Больше не автопоказываем историю
  loadLastSignal(pair) { return; }

  getCurrentPair() {
    const sel = document.getElementById('currencyPair');
    return sel ? sel.value : null;
  }

  // ---------------------- Cooldown ----------------------
  startCooldown(seconds) {
    if (!seconds || seconds <= 0) return;
    const pair = this.getCurrentPair();
    if (!pair) return;

    const key = `signal_cooldown_${this.currentMarket}_${pair}`;
    const until = Date.now() + seconds * 1000;
    localStorage.setItem(key, String(until));

    this.stopCooldownTimer(pair);
    this.cooldownTimers[pair] = setInterval(() => this.updateCooldownDisplay(), 1000);
    this.updateCooldownDisplay();
  }

  stopCooldownTimer(pair) {
    const t = this.cooldownTimers[pair];
    if (t) {
      clearInterval(t);
      this.cooldownTimers[pair] = null;
    }
  }

  isInCooldown() {
    const pair = this.getCurrentPair();
    if (!pair) return false;
    const key = `signal_cooldown_${this.currentMarket}_${pair}`;
    const val = localStorage.getItem(key);
    if (!val) return false;
    return Date.now() < parseInt(val, 10);
  }

  formatCooldown(ms) {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return m > 0 ? `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${s}s`;
  }

  updateCooldownDisplay() {
    const pair      = this.getCurrentPair();
    const btn       = document.getElementById('getSignalBtn');
    const textNode  = document.getElementById('getSignalText');
    const timeNode  = document.getElementById('cooldownTime');

    if (!pair || !btn || !textNode || !timeNode) return;

    // --- ОЧИСТКА КУЛДАУНОВ ПОСЛЕ ЗАГРУЗКИ СТРАНИЦЫ ---
    // Выполнится один раз за текущую загрузку (после F5 сбросится)
    if (!window.__cooldownClearedOnce) {
      Object.keys(localStorage).forEach((k) => {
        if (k.startsWith('signal_cooldown_')) {
          localStorage.removeItem(k);
        }
      });
      window.__cooldownClearedOnce = true;
    }

    const key = `signal_cooldown_${this.currentMarket}_${pair}`;
    const raw = localStorage.getItem(key);

    // --- Нет кулдауна ---
    if (!raw) {
      btn.disabled = false;
      btn.classList.remove('disabled');
      textNode.textContent = this.t('getSignal');  // обычный текст кнопки
      timeNode.classList.add('hidden');            // таймер прячем
      this.stopCooldownTimer(pair);
      return;
    }

    const left = parseInt(raw, 10) - Date.now();

    // --- Время вышло ---
    if (left <= 0) {
      localStorage.removeItem(key);
      btn.disabled = false;
      btn.classList.remove('disabled');
      textNode.textContent = this.t('getSignal');
      timeNode.classList.add('hidden');
      this.stopCooldownTimer(pair);
      return;
    }

    // --- Кулдаун активен ---
    btn.disabled = true;
    btn.classList.add('disabled');

    // Текст типа "Next signal in" / "Следующий сигнал через"
    textNode.textContent = this.t('cooldownText');
    timeNode.textContent = this.formatCooldown(left);
    timeNode.classList.remove('hidden');
  }


  // ---------------------- TradingView ----------------------
  initTradingView() {
    const hasTV = typeof window.TradingView !== 'undefined' && typeof window.TradingView.widget === 'function';
    const container = document.getElementById('tradingview_chart');
    if (!hasTV || !container) return;

    try {
      this.tradingViewWidget = new window.TradingView.widget({
        autosize: true,
        symbol: 'FX:EURUSD',
        interval: '1',
        timezone: 'Etc/UTC',
        theme: 'dark',
        style: '1',
        locale: this.tvLocale(),
        enable_publishing: false,
        allow_symbol_change: true,
        container_id: 'tradingview_chart',
        studies: ['RSI@tv-basicstudies','MASimple@tv-basicstudies','Volume@tv-basicstudies'],
        hide_top_toolbar: false,
        hide_legend: false,
        backgroundColor: 'rgba(19,23,34,1)',
        gridColor: 'rgba(240,243,250,0.07)',
        height: 500,
      });
    } catch (e) {
      console.warn('TradingView init failed:', e);
    }
  }

  updateTradingViewSymbol(pair) {
    if (!this.tradingViewWidget || !pair) return;
    if (this.currentMarket !== 'forex') return;

    const symbol = 'FX:' + pair.replace('/', '');
    try {
      const chart = this.tradingViewWidget.chart && this.tradingViewWidget.chart();
      if (chart && chart.setSymbol) chart.setSymbol(symbol);
    } catch (e) {
      this.recreateTradingViewWidget(symbol);
    }
  }

  recreateTradingViewWidget(symbol) {
    const container = document.getElementById('tradingview_chart');
    if (container) container.innerHTML = '';
    const hasTV = typeof window.TradingView !== 'undefined' && typeof window.TradingView.widget === 'function';
    if (!hasTV) return;

    this.tradingViewWidget = new window.TradingView.widget({
      autosize: true,
      symbol,
      interval: '1',
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: '1',
      locale: this.tvLocale(),
      enable_publishing: false,
      allow_symbol_change: true,
      container_id: 'tradingview_chart',
      studies: ['RSI@tv-basicstudies','MASimple@tv-basicstudies','Volume@tv-basicstudies'],
      backgroundColor: 'rgba(19,23,34,1)',
      gridColor: 'rgba(240,243,250,0.07)',
      height: 500,
    });
  }

  hideTradingViewChart() { /* не используем */ }

  showTradingViewChart() {
    if (!this.tradingViewWidget) {
      this.initTradingView();
      return;
    }
    const container = document.getElementById('tradingview_chart');
    const hasIframe = container && container.querySelector('iframe');
    if (!hasIframe) {
      this.recreateTradingViewWidget(this.getCurrentSymbol());
    }
  }

  // ---------------------- UI niceties ----------------------
  addAnimations() {
    const cards = document.querySelectorAll('.card');
    cards.forEach((c, i) => {
      c.style.animationDelay = `${i * 0.08}s`;
      c.classList.add('fade-in');
      c.addEventListener('mouseenter', () => { c.style.transform = 'translateY(-4px)'; });
      c.addEventListener('mouseleave', () => { c.style.transform = 'translateY(0)'; });
    });
  }

  toast(message) {
    if (!message) return;
    const box = document.createElement('div');
    box.style.cssText = `position:fixed;top:20px;right:20px;background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;padding:14px 18px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.3);z-index:10000;font-weight:500;max-width:420px;border:1px solid rgba(255,255,255,.2)`;
    box.textContent = message;
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 4500);
  }
}

// Утилиты для консоли
window.TradingSignalsUtils = {
  formatTime: (s) => (s < 60 ? `${s}s` : `${Math.floor(s/60)}m`),
  rndConfidence: () => (Math.random()>0.7?'high':Math.random()>0.4?'medium':'low'),
  rndDirection: () => (Math.random()>0.5?'buy':'sell')
};

// Boot
window.app = new TradingSignalsApp();
