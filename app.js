import { ScriptMatcher, isMatchableChar } from './matcher.js';

const STORAGE_CARDS_KEY = 'cuecard_web_cards_v1';
const STORAGE_SETTINGS_KEY = 'cuecard_web_settings_v1';

const DEFAULT_CARDS = [
  {
    id: 'demo-zh-1',
    title: '中文口播测试稿（语音跟读体验）',
    content: `大家好，欢迎测试这个网页版的中文智能提词器。

当你点击「开始跟读」之后，请自然地对着麦克风朗读这段文字。你会发现，屏幕上的高亮光标会跟着你的声音实时前进，不需要去猜固定滚动速度。

你可以试着在读到这里的时候稍微停顿两秒，喝口水，或者临时补充一句不在稿子里的即兴发挥，它都会乖乖停在原地等你。

等你继续往下念的时候，提词器又会重新咬住你的节奏，平滑地把下一句送到屏幕顶部靠近摄像头的位置。

如果你希望在开会或录屏时把提词条浮在其他窗口前面，可以在桌面版 Chrome 或 Edge 里点击右上角的「悬浮窗」按钮，把小窗拖到摄像头正下方。

如果觉得某一段读卡壳了，直接用鼠标或手指点一下文稿里的任意一个字，就可以立刻从那个位置重新开始。祝你口播一遍过！`
  },
  {
    id: 'demo-zh-2',
    title: '产品演示 / 会议汇报卡片',
    content: `各位好，今天花三分钟快速同步一下我们本周的核心进展。

第一点，在语音跟随的稳定性上，我们针对中文没有空格的特点，做了局部滑动窗口和常见同音字容错，避免了传统提词器动不动跨段乱跳的问题。

第二点，针对不同网络和设备环境，我们内置了三种模式：标准语音跟读、完全离线的声控滚动，以及经典的匀速滚动，保证在任何会议现场都不会掉链子。

第三点，文稿全部保存在浏览器本地，不经过第三方服务器，既保护了会议隐私，也支持随时导入和导出纯文本。

以上就是本次汇报的全部内容，下面进入答疑环节，欢迎大家提问。`
  }
];

const DEFAULT_SETTINGS = {
  fontSize: 38,
  lineHeight: 1.65,
  scriptWidth: 680,
  scrollSpeed: 48,
  vadThreshold: 14,
  lang: 'zh-CN',
  mirror: false,
  centered: false,
  mode: 'voice' // 'voice' | 'vad' | 'auto'
};

// ---------------- State ----------------
let cards = loadCards();
let activeCardId = cards[0]?.id || null;
let settings = loadSettings();

const matcher = new ScriptMatcher('');
let charElements = []; // index -> <span> element (对应 rawText 索引)
let tokenToRaw = [];

let isRunning = false;
let recognition = null;
let shouldRestartRecognition = false;
let lastRestartTime = 0;
let networkErrorFallbackWarned = false;

// Audio / VAD 状态
let audioStream = null;
let audioCtx = null;
let analyser = null;
let vadDataArray = null;
let currentVolume = 0;
let lastVoiceActiveAt = 0;

// 动画循环
let rafId = null;
let lastFrameTime = 0;
let targetScrollTop = null;

// PiP 状态
let pipWindow = null;

// 屏幕常亮 (Wake Lock) 状态
let wakeLockSentinel = null;

// ---------------- DOM 引用 ----------------
const $ = (id) => document.getElementById(id);

const els = {
  btnCards: $('btnCards'),
  btnToggleRun: $('btnToggleRun'),
  runLabel: $('runLabel'),
  btnReset: $('btnReset'),
  btnEdit: $('btnEdit'),
  btnPip: $('btnPip'),
  btnSettings: $('btnSettings'),
  modeBtns: document.querySelectorAll('.mode-btn'),

  statusBadge: $('statusBadge'),
  liveTranscript: $('liveTranscript'),
  vuBar: $('vuBar'),
  progressText: $('progressText'),

  stageWrapper: $('stageWrapper'),
  prompterStage: $('prompterStage'),
  scriptViewport: $('scriptViewport'),
  scriptContent: $('scriptContent'),

  pipBtnToggle: $('pipBtnToggle'),
  pipBtnReset: $('pipBtnReset'),
  pipBtnFontMinus: $('pipBtnFontMinus'),
  pipBtnFontPlus: $('pipBtnFontPlus'),
  pipTranscript: $('pipTranscript'),

  cardsDrawer: $('cardsDrawer'),
  cardList: $('cardList'),
  btnNewCard: $('btnNewCard'),
  fileImport: $('fileImport'),
  btnExportCard: $('btnExportCard'),

  settingsDrawer: $('settingsDrawer'),
  optFontSize: $('optFontSize'),
  valFontSize: $('valFontSize'),
  optLineHeight: $('optLineHeight'),
  valLineHeight: $('valLineHeight'),
  optWidth: $('optWidth'),
  valWidth: $('valWidth'),
  optSpeed: $('optSpeed'),
  valSpeed: $('valSpeed'),
  optVadThreshold: $('optVadThreshold'),
  valVadThreshold: $('valVadThreshold'),
  optLang: $('optLang'),
  optMirror: $('optMirror'),
  optCenter: $('optCenter'),

  editorModal: $('editorModal'),
  editTitle: $('editTitle'),
  editBody: $('editBody'),
  wordStats: $('wordStats'),
  btnCloseEditor: $('btnCloseEditor'),
  btnCancelEdit: $('btnCancelEdit'),
  btnSaveEdit: $('btnSaveEdit'),

  scrim: $('scrim'),
  toast: $('toast')
};

// ---------------- 存储 ----------------
function loadCards() {
  try {
    const raw = localStorage.getItem(STORAGE_CARDS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (_) {}
  return structuredClone(DEFAULT_CARDS);
}

function saveCards() {
  try {
    localStorage.setItem(STORAGE_CARDS_KEY, JSON.stringify(cards));
  } catch (_) {}
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (_) {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(settings));
  } catch (_) {}
}

function getActiveCard() {
  return cards.find((c) => c.id === activeCardId) || cards[0];
}

// ---------------- UI 渲染 ----------------
function showToast(msg, duration = 2600) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    els.toast.classList.remove('show');
  }, duration);
}

function setStatus(text, type = '') {
  els.statusBadge.textContent = text;
  els.statusBadge.className = 'status-badge' + (type ? ` ${type}` : '');
}

function setTranscript(text) {
  els.liveTranscript.textContent = text;
  els.pipTranscript.textContent = text;
}

function applySettingsToDOM() {
  const roots = [document.documentElement];
  if (pipWindow && !pipWindow.closed) {
    roots.push(pipWindow.document.documentElement);
  }
  for (const root of roots) {
    root.style.setProperty('--font-size', `${settings.fontSize}px`);
    root.style.setProperty('--line-height', String(settings.lineHeight));
    root.style.setProperty('--script-width', `${settings.scriptWidth}px`);
  }

  els.scriptContent.classList.toggle('mirrored', settings.mirror);
  els.scriptContent.classList.toggle('centered', settings.centered);

  // 同步表单控件
  els.optFontSize.value = settings.fontSize;
  els.valFontSize.textContent = `${settings.fontSize}px`;

  els.optLineHeight.value = settings.lineHeight;
  els.valLineHeight.textContent = Number(settings.lineHeight).toFixed(2);

  els.optWidth.value = settings.scriptWidth;
  els.valWidth.textContent = `${settings.scriptWidth}px`;

  els.optSpeed.value = settings.scrollSpeed;
  els.valSpeed.textContent = `${settings.scrollSpeed} px/s`;

  els.optVadThreshold.value = settings.vadThreshold;
  els.valVadThreshold.textContent = String(settings.vadThreshold);

  els.optLang.value = settings.lang;
  els.optMirror.checked = settings.mirror;
  els.optCenter.checked = settings.centered;

  els.modeBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === settings.mode);
  });

  updateRunButtonUI();
}

function renderCardList() {
  els.cardList.innerHTML = '';
  for (const card of cards) {
    const item = document.createElement('div');
    item.className = 'card-item' + (card.id === activeCardId ? ' active' : '');
    item.innerHTML = `
      <div class="card-item-top">
        <span class="card-title"></span>
        ${cards.length > 1 ? '<button class="card-del-btn" title="删除">删除</button>' : ''}
      </div>
      <div class="card-preview"></div>
    `;
    item.querySelector('.card-title').textContent = card.title || '未命名提词卡';
    item.querySelector('.card-preview').textContent = (card.content || '').replace(/\s+/g, ' ').trim();

    item.addEventListener('click', (e) => {
      if (e.target.closest('.card-del-btn')) return;
      selectCard(card.id);
      closeDrawers();
    });

    const delBtn = item.querySelector('.card-del-btn');
    if (delBtn) {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (cards.length <= 1) return;
        cards = cards.filter((c) => c.id !== card.id);
        if (activeCardId === card.id) {
          activeCardId = cards[0].id;
          loadActiveCardIntoStage();
        }
        saveCards();
        renderCardList();
        showToast('已删除提词卡');
      });
    }

    els.cardList.appendChild(item);
  }
}

function loadActiveCardIntoStage() {
  const card = getActiveCard();
  if (!card) return;
  activeCardId = card.id;
  const text = card.content || '';
  matcher.setScript(text);

  els.scriptContent.innerHTML = '';
  charElements = new Array(text.length);
  tokenToRaw = matcher.tokens.map((t) => t.rawIndex);

  const frag = document.createDocumentFragment();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      frag.appendChild(document.createTextNode('\n'));
      continue;
    }
    const span = document.createElement('span');
    span.className = 'ch unread';
    span.textContent = ch;
    span.dataset.idx = String(i);
    charElements[i] = span;
    frag.appendChild(span);
  }
  els.scriptContent.appendChild(frag);

  updateHighlight(0, true);
  renderCardList();
}

function selectCard(id) {
  stopRunning();
  activeCardId = id;
  loadActiveCardIntoStage();
}

/**
 * 更新文字高亮并计算平滑滚动目标
 */
function updateHighlight(cursorTokenIdx, instantScroll = false) {
  const rawCursor = cursorTokenIdx >= matcher.tokens.length
    ? matcher.rawText.length
    : matcher.tokens[cursorTokenIdx].rawIndex;

  // 找当前高亮窗口（当前词后 1~2 个字）
  const highlightEnd = Math.min(matcher.rawText.length, rawCursor + 2);

  for (let i = 0; i < charElements.length; i++) {
    const el = charElements[i];
    if (!el) continue;
    if (i < rawCursor) {
      el.className = 'ch read';
    } else if (i < highlightEnd && cursorTokenIdx < matcher.tokens.length) {
      el.className = 'ch current';
    } else {
      el.className = 'ch unread';
    }
  }

  const pct = Math.round(matcher.getProgress() * 100);
  els.progressText.textContent = `${pct}%`;

  // 计算目标滚动位置，使当前高亮字对齐视线引导线（移动端更贴近顶部前置镜头）
  const anchorEl = charElements[rawCursor] || charElements.find((e, idx) => idx >= rawCursor && e);
  if (anchorEl) {
    const viewport = els.scriptViewport;
    const isMobile = window.matchMedia('(max-width: 720px)').matches;
    const focusY = viewport.clientHeight * (isMobile ? 0.20 : 0.28);
    const desiredTop = Math.max(0, anchorEl.offsetTop - focusY);
    if (instantScroll || !isRunning) {
      viewport.scrollTo({
        top: desiredTop,
        behavior: instantScroll ? 'auto' : 'smooth'
      });
      targetScrollTop = null;
    } else {
      targetScrollTop = desiredTop;
    }
  }
}

// ---------------- 屏幕常亮 (Wake Lock) ----------------
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    if (wakeLockSentinel) return;
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => {
      wakeLockSentinel = null;
    });
  } catch (_) {
    // 低电量模式或系统策略拒绝时静默忽略
  }
}

async function releaseWakeLock() {
  if (!wakeLockSentinel) return;
  try {
    await wakeLockSentinel.release();
  } catch (_) {}
  wakeLockSentinel = null;
}

function isIOSStandalone() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  return isIOS && standalone;
}

// ---------------- 运行与模式控制 ----------------
function updateRunButtonUI() {
  const labelMap = {
    voice: isRunning ? '停止跟读' : '开始跟读',
    vad: isRunning ? '停止声控' : '开始声控',
    auto: isRunning ? '暂停滚动' : '开始滚动'
  };
  els.runLabel.textContent = labelMap[settings.mode];
  els.btnToggleRun.classList.toggle('running', isRunning);

  els.pipBtnToggle.textContent = isRunning ? '暂停' : '开始';
  els.pipBtnToggle.classList.toggle('running', isRunning);
}

async function startRunning() {
  if (isRunning) return;
  isRunning = true;
  networkErrorFallbackWarned = false;
  updateRunButtonUI();

  if (settings.mode === 'voice') {
    const ok = startSpeechRecognition();
    if (!ok) {
      isRunning = false;
      updateRunButtonUI();
      return;
    }
    // 同时也尽量开启音量条（非强制）
    startMicMeter().catch(() => {});
    setStatus('语音跟读中', 'listening');
    setTranscript('正在聆听中文语音，请自然朗读...');
  } else if (settings.mode === 'vad') {
    try {
      await startMicMeter();
      setStatus('声控监听中', 'listening');
      setTranscript('离线声控已开启：开口即滚动，停顿即暂停');
    } catch (err) {
      isRunning = false;
      updateRunButtonUI();
      setStatus('麦克风不可用', 'warn');
      showToast('无法访问麦克风，请检查浏览器权限或使用 HTTPS / localhost');
      return;
    }
  } else {
    setStatus('匀速滚动中', 'listening');
    setTranscript(`匀速滚动中（${settings.scrollSpeed} px/s），按 ↑/↓ 可调速`);
  }

  requestWakeLock();
  lastFrameTime = performance.now();
  startAnimationLoop();
}

function stopRunning() {
  if (!isRunning) return;
  isRunning = false;
  shouldRestartRecognition = false;

  stopSpeechRecognition();
  stopMicMeter();
  stopAnimationLoop();
  releaseWakeLock();

  els.vuBar.style.width = '0%';
  setStatus('已暂停');
  updateRunButtonUI();
}

function toggleRunning() {
  if (isRunning) stopRunning();
  else startRunning();
}

function resetProgress() {
  matcher.reset();
  updateHighlight(0, true);
  if (settings.mode !== 'voice') {
    els.scriptViewport.scrollTop = 0;
  }
  setTranscript('已回到开头');
}

// ---------------- Web Speech API 中文识别 ----------------
function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function startSpeechRecognition() {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    showToast('当前浏览器不支持语音识别，已自动切到「声控滚动」模式', 3400);
    switchMode('vad');
    return false;
  }

  stopSpeechRecognition();
  shouldRestartRecognition = true;

  const rec = new Ctor();
  rec.lang = settings.lang || 'zh-CN';
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    setStatus('语音跟读中', 'listening');
  };

  rec.onresult = (event) => {
    // 拼接最近若干条识别片段（含 interim），保证跨句衔接不断层
    let combined = '';
    const startIdx = Math.max(0, event.results.length - 2);
    for (let i = startIdx; i < event.results.length; i++) {
      combined += event.results[i][0].transcript;
    }
    const trimmed = combined.trim();
    if (!trimmed) return;

    const preview = trimmed.length > 28 ? '…' + trimmed.slice(-28) : trimmed;
    setTranscript(`识别：${preview}`);

    const res = matcher.feed(trimmed);
    if (res.advanced) {
      updateHighlight(res.cursor, false);
      if (res.cursor >= matcher.tokens.length) {
        setStatus('已读完', 'listening');
        showToast('太棒了，文稿已全部读完！');
      }
    }
  };

  rec.onerror = (event) => {
    const err = event.error;
    if (err === 'no-speech' || err === 'aborted') {
      return; // 正常静音超时，onend 会自动重连
    }
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      shouldRestartRecognition = false;
      stopRunning();
      setStatus('语音识别受限', 'warn');
      if (isIOSStandalone()) {
        showToast('iPhone 主屏幕全屏模式下系统可能限制语音识别，请用 Safari 打开或切「声控滚动」', 4200);
      } else {
        showToast('请允许浏览器使用麦克风与语音识别权限');
      }
      return;
    }
    if (err === 'network') {
      setStatus('语音服务网络受限', 'warn');
      if (!networkErrorFallbackWarned) {
        networkErrorFallbackWarned = true;
        showToast('语音识别服务连不上（Chrome 国内常见），建议换 Safari/Edge 或点上方切「声控滚动」', 4500);
      }
      shouldRestartRecognition = false;
      stopRunning();
    }
  };

  rec.onend = () => {
    if (shouldRestartRecognition && isRunning && settings.mode === 'voice') {
      const now = Date.now();
      const delay = now - lastRestartTime < 400 ? 450 : 120;
      lastRestartTime = now;
      setTimeout(() => {
        if (shouldRestartRecognition && isRunning && settings.mode === 'voice') {
          try {
            rec.start();
          } catch (_) {}
        }
      }, delay);
    }
  };

  recognition = rec;
  try {
    rec.start();
    return true;
  } catch (err) {
    showToast('启动语音识别失败，请重试');
    return false;
  }
}

function stopSpeechRecognition() {
  shouldRestartRecognition = false;
  if (recognition) {
    try {
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      recognition.stop();
    } catch (_) {}
    recognition = null;
  }
}

// ---------------- Web Audio 离线声控（VAD）与音量条 ----------------
async function startMicMeter() {
  if (audioStream) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('getUserMedia not supported');
  }
  audioStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioCtx();
  const source = audioCtx.createMediaStreamSource(audioStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  vadDataArray = new Uint8Array(analyser.frequencyBinCount);
}

function stopMicMeter() {
  if (audioStream) {
    audioStream.getTracks().forEach((t) => t.stop());
    audioStream = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  analyser = null;
  vadDataArray = null;
  currentVolume = 0;
}

function sampleMicVolume() {
  if (!analyser || !vadDataArray) return 0;
  analyser.getByteTimeDomainData(vadDataArray);
  let sumSq = 0;
  for (let i = 0; i < vadDataArray.length; i++) {
    const v = (vadDataArray[i] - 128) / 128;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / vadDataArray.length);
  return Math.min(100, Math.round(rms * 280));
}

// ---------------- 丝滑滚动动画循环 ----------------
function startAnimationLoop() {
  stopAnimationLoop();
  const tick = (now) => {
    const dt = Math.min(0.08, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    if (analyser) {
      currentVolume = sampleMicVolume();
      els.vuBar.style.width = `${currentVolume}%`;
      if (currentVolume >= settings.vadThreshold) {
        lastVoiceActiveAt = now;
      }
    }

    const viewport = els.scriptViewport;

    if (settings.mode === 'voice') {
      // 平滑插值逼近语音定位目标
      if (targetScrollTop !== null) {
        const diff = targetScrollTop - viewport.scrollTop;
        if (Math.abs(diff) < 0.8) {
          viewport.scrollTop = targetScrollTop;
          targetScrollTop = null;
        } else {
          viewport.scrollTop += diff * Math.min(1, dt * 8.5);
        }
      }
    } else if (settings.mode === 'vad') {
      // 说话后保持 320ms 缓冲惯性，避免字间换气抖动
      const isSpeaking = now - lastVoiceActiveAt < 320;
      if (isSpeaking) {
        viewport.scrollTop += settings.scrollSpeed * dt;
        setStatus('检测到人声 · 滚动中', 'listening');
      } else {
        setStatus('等待开口...', '');
      }
      updateManualScrollProgress();
    } else if (settings.mode === 'auto') {
      viewport.scrollTop += settings.scrollSpeed * dt;
      updateManualScrollProgress();
    }

    if (isRunning) {
      rafId = requestAnimationFrame(tick);
    }
  };
  rafId = requestAnimationFrame(tick);
}

function stopAnimationLoop() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function updateManualScrollProgress() {
  const viewport = els.scriptViewport;
  const maxScroll = Math.max(1, viewport.scrollHeight - viewport.clientHeight);
  const pct = Math.min(100, Math.max(0, Math.round((viewport.scrollTop / maxScroll) * 100)));
  els.progressText.textContent = `${pct}%`;
}

// ---------------- 桌面悬浮置顶窗 (Document PiP) ----------------
async function togglePictureInPicture() {
  if (pipWindow && !pipWindow.closed) {
    pipWindow.close();
    return;
  }

  if (!('documentPictureInPicture' in window)) {
    showToast('当前浏览器不支持网页悬浮小窗（请使用桌面版 Chrome / Edge）', 3500);
    return;
  }

  try {
    pipWindow = await window.documentPictureInPicture.requestWindow({
      width: 560,
      height: 220
    });

    // 复制样式表到 PiP 窗口
    for (const sheet of document.styleSheets) {
      try {
        const cssRules = [...sheet.cssRules].map((r) => r.cssText).join('\n');
        const style = pipWindow.document.createElement('style');
        style.textContent = cssRules;
        pipWindow.document.head.appendChild(style);
      } catch (_) {
        if (sheet.href) {
          const link = pipWindow.document.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          pipWindow.document.head.appendChild(link);
        }
      }
    }

    pipWindow.document.body.classList.add('in-pip');
    pipWindow.document.body.appendChild(els.prompterStage);

    // 主窗口显示占位提示
    els.stageWrapper.innerHTML = `
      <div class="pip-placeholder">
        <p>提词器已在桌面悬浮窗中打开，请将它拖到摄像头正下方。</p>
        <button id="btnReturnStage" class="icon-btn">收回主窗口</button>
      </div>
    `;
    $('btnReturnStage').addEventListener('click', () => {
      if (pipWindow && !pipWindow.closed) pipWindow.close();
    });

    applySettingsToDOM();

    pipWindow.addEventListener('pagehide', () => {
      els.stageWrapper.innerHTML = '';
      els.stageWrapper.appendChild(els.prompterStage);
      pipWindow = null;
      applySettingsToDOM();
    });
  } catch (err) {
    showToast('打开悬浮窗失败：' + (err.message || '未知错误'));
  }
}

// ---------------- 抽屉与弹窗 ----------------
function openDrawer(drawerEl) {
  closeDrawers();
  drawerEl.classList.add('open');
  drawerEl.setAttribute('aria-hidden', 'false');
  els.scrim.classList.add('open');
}

function closeDrawers() {
  [els.cardsDrawer, els.settingsDrawer].forEach((d) => {
    d.classList.remove('open');
    d.setAttribute('aria-hidden', 'true');
  });
  els.scrim.classList.remove('open');
}

function openEditor(isNew = false) {
  stopRunning();
  closeDrawers();
  const card = isNew ? { id: null, title: '', content: '' } : getActiveCard();
  els.editorModal.dataset.editingId = card.id || '';
  els.editTitle.value = card.title || '';
  els.editBody.value = card.content || '';
  updateWordStats();
  els.editorModal.classList.add('open');
  els.editorModal.setAttribute('aria-hidden', 'false');
  setTimeout(() => els.editBody.focus(), 50);
}

function closeEditor() {
  els.editorModal.classList.remove('open');
  els.editorModal.setAttribute('aria-hidden', 'true');
}

function updateWordStats() {
  const text = els.editBody.value || '';
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (isMatchableChar(text[i])) count++;
  }
  // 中文口播平均约 200~220 字/分钟 ≈ 3.5 字/秒
  const secs = Math.ceil(count / 3.5);
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  const dur = mins > 0 ? `${mins} 分 ${rem} 秒` : `${rem} 秒`;
  els.wordStats.textContent = `${count} 字 · 预计口播 ${dur}`;
}

function saveEditorContent() {
  const title = els.editTitle.value.trim() || '未命名提词卡';
  const content = els.editBody.value.trim();
  if (!content) {
    showToast('文稿内容不能为空');
    return;
  }

  const editingId = els.editorModal.dataset.editingId;
  if (editingId) {
    const target = cards.find((c) => c.id === editingId);
    if (target) {
      target.title = title;
      target.content = content;
    }
    activeCardId = editingId;
  } else {
    const newId = 'card-' + Date.now();
    cards.unshift({ id: newId, title, content });
    activeCardId = newId;
  }

  saveCards();
  loadActiveCardIntoStage();
  closeEditor();
  showToast('提词卡已保存');
}

function switchMode(newMode) {
  const wasRunning = isRunning;
  if (wasRunning) stopRunning();
  settings.mode = newMode;
  saveSettings();
  applySettingsToDOM();
  if (wasRunning) startRunning();
}

// ---------------- 事件绑定 ----------------
function bindEvents() {
  els.btnToggleRun.addEventListener('click', toggleRunning);
  els.pipBtnToggle.addEventListener('click', toggleRunning);
  els.btnReset.addEventListener('click', resetProgress);
  els.pipBtnReset.addEventListener('click', resetProgress);

  els.pipBtnFontMinus.addEventListener('click', () => {
    settings.fontSize = Math.max(20, settings.fontSize - 2);
    saveSettings();
    applySettingsToDOM();
  });
  els.pipBtnFontPlus.addEventListener('click', () => {
    settings.fontSize = Math.min(72, settings.fontSize + 2);
    saveSettings();
    applySettingsToDOM();
  });

  els.modeBtns.forEach((btn) => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
  });

  els.btnCards.addEventListener('click', () => openDrawer(els.cardsDrawer));
  els.btnSettings.addEventListener('click', () => openDrawer(els.settingsDrawer));
  els.btnEdit.addEventListener('click', () => openEditor(false));
  els.btnNewCard.addEventListener('click', () => openEditor(true));
  els.btnPip.addEventListener('click', togglePictureInPicture);

  document.querySelectorAll('.close-drawer-btn[data-close]').forEach((btn) => {
    btn.addEventListener('click', closeDrawers);
  });
  els.scrim.addEventListener('click', closeDrawers);

  els.btnCloseEditor.addEventListener('click', closeEditor);
  els.btnCancelEdit.addEventListener('click', closeEditor);
  els.btnSaveEdit.addEventListener('click', saveEditorContent);
  els.editBody.addEventListener('input', updateWordStats);

  // 点击任意字跳转到该位置继续跟读
  els.scriptContent.addEventListener('click', (e) => {
    const span = e.target.closest('.ch');
    if (!span) return;
    const rawIdx = Number(span.dataset.idx);
    if (Number.isNaN(rawIdx)) return;
    matcher.setCursorByRawIndex(rawIdx);
    updateHighlight(matcher.cursor, false);
    setTranscript('已手动定位，可从此处继续朗读');
  });

  // 导入导出
  els.fileImport.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const newId = 'card-' + Date.now();
    cards.unshift({
      id: newId,
      title: file.name.replace(/\.(txt|md)$/i, ''),
      content: text.trim()
    });
    activeCardId = newId;
    saveCards();
    loadActiveCardIntoStage();
    closeDrawers();
    showToast(`已导入：${file.name}`);
    e.target.value = '';
  });

  els.btnExportCard.addEventListener('click', () => {
    const card = getActiveCard();
    if (!card) return;
    const blob = new Blob([card.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${card.title || '提词稿'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // 设置项实时生效
  els.optFontSize.addEventListener('input', (e) => {
    settings.fontSize = Number(e.target.value);
    saveSettings();
    applySettingsToDOM();
  });
  els.optLineHeight.addEventListener('input', (e) => {
    settings.lineHeight = Number(e.target.value);
    saveSettings();
    applySettingsToDOM();
  });
  els.optWidth.addEventListener('input', (e) => {
    settings.scriptWidth = Number(e.target.value);
    saveSettings();
    applySettingsToDOM();
  });
  els.optSpeed.addEventListener('input', (e) => {
    settings.scrollSpeed = Number(e.target.value);
    saveSettings();
    applySettingsToDOM();
  });
  els.optVadThreshold.addEventListener('input', (e) => {
    settings.vadThreshold = Number(e.target.value);
    saveSettings();
    applySettingsToDOM();
  });
  els.optLang.addEventListener('change', (e) => {
    settings.lang = e.target.value;
    saveSettings();
    if (isRunning && settings.mode === 'voice') {
      stopRunning();
      startRunning();
    }
  });
  els.optMirror.addEventListener('change', (e) => {
    settings.mirror = e.target.checked;
    saveSettings();
    applySettingsToDOM();
  });
  els.optCenter.addEventListener('change', (e) => {
    settings.centered = e.target.checked;
    saveSettings();
    applySettingsToDOM();
  });

  // 键盘快捷键
  window.addEventListener('keydown', (e) => {
    if (els.editorModal.classList.contains('open')) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        saveEditorContent();
      } else if (e.key === 'Escape') {
        closeEditor();
      }
      return;
    }
    if (e.target.matches('input, textarea, select')) return;

    if (e.code === 'Space') {
      e.preventDefault();
      toggleRunning();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      resetProgress();
    } else if (e.key === 'm' || e.key === 'M') {
      settings.mirror = !settings.mirror;
      saveSettings();
      applySettingsToDOM();
      showToast(settings.mirror ? '已开启镜像翻转' : '已关闭镜像翻转');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      settings.scrollSpeed = Math.min(140, settings.scrollSpeed + 6);
      saveSettings();
      applySettingsToDOM();
      showToast(`滚动速度：${settings.scrollSpeed} px/s`, 1200);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      settings.scrollSpeed = Math.max(15, settings.scrollSpeed - 6);
      saveSettings();
      applySettingsToDOM();
      showToast(`滚动速度：${settings.scrollSpeed} px/s`, 1200);
    } else if (e.key === 'Escape') {
      closeDrawers();
    }
  });
}

// ---------------- 初始化 ----------------
function init() {
  applySettingsToDOM();
  loadActiveCardIntoStage();
  bindEvents();

  // 仅在支持 Document Picture-in-Picture 的桌面浏览器显示悬浮窗按钮
  if (!('documentPictureInPicture' in window)) {
    els.btnPip.classList.add('hidden');
  }

  // 页面切回前台时自动恢复屏幕常亮
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isRunning) {
      requestWakeLock();
    }
  });
}

init();
