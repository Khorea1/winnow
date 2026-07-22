(() => {
'use strict';

/* ==================== helpers ==================== */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { fn(...args); }, ms);
  };
}

/* ==================== i18n ==================== */

const I18N = {
  pt: {
    pageTitle: 'Winnow — painel',
    tagline: 'painel de operação',
    sidebarHideLabel: 'Esconder',
    sidebarShowLabel: 'Mostrar',
    sidebarHideTitle: 'Esconder configurações',
    sidebarShowTitle: 'Mostrar configurações',
    sidebarHideAria: 'Esconder painel de configuração',
    sidebarShowAria: 'Mostrar painel de configuração',
    connecting: 'conectando…',
    liveActive: 'tempo real ativo',
    reconnecting: 'reconectando…',
    validatingChip: 'validação em andamento',
    statTotalLabel: 'Proxies no pool',
    statAliveLabel: 'Saudáveis agora',
    statRetriesLabel: 'Retries / timeout',
    statTargetsLabel: 'Alvos monitorados',
    statFileLabel: 'Arquivo ativo',
    allVisible: 'todos visíveis',
    sampleOf: 'amostra: {n} de {total}',
    sampleBannedPrefix: 'amostra:',
    bannedSuffix: 'banidos',
    msPerAttempt: 'ms por tentativa',
    periodicCheck: 'checagem periódica',
    definedAtStart: 'definido no início do processo',
    spectrumTitle: 'Distribuição de saúde da amostra',
    legendHealthy: 'saudável',
    legendSlow: 'lento',
    legendError: 'com erro',
    legendBanned: 'banido',
    spectrumAriaLabel: 'Barras representando o estado de cada proxy da amostra atual',
    poolTitle: 'Pool de proxies',
    filterChipOk: 'ok',
    filterChipWarn: 'lento',
    filterChipErr: 'erro',
    filterChipBan: 'banido',
    filterAriaGroup: 'Filtrar por estado',
    filterPlaceholder: 'filtrar (Ctrl+K)',
    filterAriaInput: 'Filtrar proxies',
    copyAllTitle: 'Copiar proxies filtrados',
    thStatus: 'Status',
    thProxy: 'Proxy',
    thScore: 'Score',
    thLatency: 'Latência',
    thErrors: 'Erros',
    thOk: 'OKs',
    thBannedUntil: 'Banido até',
    trendLatency: 'latência média (ms)',
    trendErrors: 'erros acumulados',
    logTitle: 'Log em tempo real',
    autoscroll: 'autoscroll',
    clearLogTitle: 'Limpar log',
    logAriaLabel: 'Log em tempo real',
    logWaiting: 'Aguardando eventos…',
    logCleared: 'Log limpo.',
    eventsTitle: 'Eventos de proxy',
    evtFilterAria: 'Filtrar por tipo',
    evtFilterAll: 'todos',
    clearEventsTitle: 'Limpar eventos',
    eventFeedAria: 'Eventos de proxy',
    eventsWaiting: 'Aguardando eventos de conexão…',
    eventsCleared: 'Eventos limpos.',
    rotatorConfigTitle: 'Configuração do rotator',
    proxyFileLabel: 'Arquivo de proxies',
    proxyFileHint: 'Definido por linha de comando ou variável de ambiente ao iniciar o processo — não é editável por aqui.',
    retriesLabel: 'Retries',
    retriesHint: 'tentativas por requisição',
    maxErrorsLabel: 'Máx. erros',
    maxErrorsHint: 'acima disso, proxy é ignorado',
    rotatorTimeoutLabel: 'Timeout do rotator (ms)',
    upstreamIdleLabel: 'Timeout idle do upstream (ms)',
    upstreamIdleHint: '0 = automático (2× timeout do rotator), define quanto tempo sem dados do upstream antes de abortar',
    targetsLabel: 'Alvos de health-check (um por linha)',
    saveConfigBtn: 'Salvar configuração',
    validatorTitle: 'Validador',
    threadsLabel: 'Threads',
    threadsHint: '10–20 para proxies gratuitos',
    modeLabel: 'Modo',
    modeTcpOnly: 'tcp-only — só TCP',
    modeQuick: 'quick — só IP',
    modeStandard: 'standard — IP + stream',
    modeStrict: 'strict — completo',
    modeStream: 'stream — só streaming',
    baseUrlLabel: 'Base URL',
    baseUrlHint: 'endpoints http:// tendem a funcionar melhor com proxies http',
    maxLatLabel: 'Latência máx. (ms)',
    connTimeoutLabel: 'Timeout de conexão (s)',
    throttleLabel: 'Throttle (ms)',
    throttleHint: 'jitter aleatório 0..N',
    ttfbLabel: 'Tolerância de TTFB (%)',
    ttfbHint: '100 desativa a checagem',
    pruneLabel: 'Remover inválidos do arquivo ao final',
    anonLabel: 'Exigir anonimato (rejeita proxies transparentes)',
    insecureLabel: 'Ignorar certificado TLS inválido',
    vstatTotal: 'total',
    vstatOk: 'válidos',
    vstatFail: 'inválidos',
    validateBtn: 'Validar agora',
    validateBtnRunning: 'Validando…',
    stopBtn: 'Parar',
    stopBtnStopping: 'Parando…',
    validateLogAria: 'Resultados da validação',
    validateLogEmpty: 'Sem atividade ainda. Clique em Validar para iniciar.',
    footerSse: 'SSE em tempo real',
    footerCtrlK: 'para filtrar o pool',
    copiedGeneric: 'Copiado',
    copiedCount: 'Copiados {n} proxies',
    copyFail: 'Não foi possível copiar',
    copyBtnTitle: 'Copiar',
    copyBtnAria: 'Copiar {proxy}',
    delBtnTitle: 'Remover do pool',
    delBtnAria: 'Remover {proxy} do pool',
    delConfirmTitle: 'Clique de novo para confirmar (edita o arquivo, não pode ser desfeito)',
    delConfirmAria: 'Confirmar remoção de {proxy} do pool',
    delConfirm: 'Remover "{proxy}" do pool?\n\nIsso edita o arquivo de proxies e não pode ser desfeito.',
    delSuccessToast: 'Proxy removido do pool',
    delErrorToast: 'Erro ao remover: {msg}',
    emptyNoMatch: 'Nenhum proxy para "{term}"',
    emptyPoolEmpty: 'Pool vazio — rode uma validação para popular.',
    emptyFilters: 'Nenhum proxy corresponde aos filtros.',
    sampleShowing: 'Mostrando os {n} proxies com melhor score, de {total} no total.',
    spectrumEmpty: 'Sem dados ainda — valide o arquivo de proxies para popular a amostra.',
    statusOk: 'saudável',
    statusWarn: 'lento',
    statusErr: 'erro',
    statusBan: 'banido',
    evtStatusOk: 'OK',
    evtStatusFail: 'FAIL',
    evtStatusAttempt: 'TENT',
    evtStatusInfo: 'INFO',
    errStatsFetch: 'Erro ao buscar estatísticas: {msg}',
    errSyncStatus: 'Falha ao sincronizar estado da validação: {msg}',
    modeDescTcpOnly: 'Testa apenas se a conexão TCP com o proxy abre. Não valida HTTP nem os alvos configurados — o mais rápido possível, útil para uma primeira triagem grosseira.',
    modeDescQuick: 'Testa apenas TCP + /ip. O mais rápido, ideal para listas grandes de proxies gratuitos — nunca falha por causa de buffering de streaming.',
    modeDescStandard: 'TCP + /ip + 5 chunks de streaming (tolerante). Usa 100% de tolerância de TTFB por padrão para não reprovar proxies com buffering. Recomendado para testar streaming real.',
    modeDescStrict: 'quick + streaming de 5 chunks + POST + streaming de 20 chunks. Mais rigoroso — vai reprovar boa parte dos proxies gratuitos.',
    modeDescStream: 'Testa apenas streaming. Use com uma Stream URL própria para validar contra seu backend real (SSE, APIs de IA, etc).',
    validationStarted: 'Validação iniciada — job #{id}, modo {mode}, {threads} threads',
    validationStartedToast: 'Validação #{id} iniciada',
    validationStartErr: 'Erro ao iniciar validação: {msg}',
    validationStartErrToast: 'Erro ao iniciar validação',
    stopRequested: 'Parada solicitada — encerrando processos…',
    stopRequestedToast: 'Parando — deve levar menos de 2s',
    stopErr: 'Erro ao parar: {msg}',
    stopErrToast: 'Erro ao parar',
    savingConfig: 'Salvando…',
    configSaved: 'Configuração salva.',
    configSavedToast: 'Configuração salva',
    configErr: 'Erro: {msg}',
    configErrToast: 'Erro ao salvar configuração',
    errLoadConfig: 'Erro ao carregar configuração: {msg}',
    connectedLog: 'Conectado — atualizações em tempo real ativas',
    connLostLog: 'Conexão perdida — tentando novamente em {delay}s…',
    stoppingValidationLog: 'Parando validação — encerrando processos…',
    validationStoppedLog: 'Validação interrompida pelo usuário',
    validationErrLog: 'Erro na validação: {msg}',
    validationDoneLog: 'Validação concluída: {ok} válidos, {fail} inválidos (código {code})',
    validationStoppedToast: 'Validação parada',
    validationDoneToast: 'Validação: {ok} ok / {fail} falhas',
    preparing: 'Preparando…',
    progressStatus: '{ok} válidos, {fail} inválidos — {done} de {total}',
  },
  en: {
    pageTitle: 'Winnow — dashboard',
    tagline: 'operations dashboard',
    sidebarHideLabel: 'Hide',
    sidebarShowLabel: 'Show',
    sidebarHideTitle: 'Hide settings',
    sidebarShowTitle: 'Show settings',
    sidebarHideAria: 'Hide settings panel',
    sidebarShowAria: 'Show settings panel',
    connecting: 'connecting…',
    liveActive: 'live updates active',
    reconnecting: 'reconnecting…',
    validatingChip: 'validation running',
    statTotalLabel: 'Proxies in pool',
    statAliveLabel: 'Healthy now',
    statRetriesLabel: 'Retries / timeout',
    statTargetsLabel: 'Monitored targets',
    statFileLabel: 'Active file',
    allVisible: 'all visible',
    sampleOf: 'sample: {n} of {total}',
    sampleBannedPrefix: 'sample:',
    bannedSuffix: 'banned',
    msPerAttempt: 'ms per attempt',
    periodicCheck: 'periodic check',
    definedAtStart: 'set when the process starts',
    spectrumTitle: 'Health distribution of the sample',
    legendHealthy: 'healthy',
    legendSlow: 'slow',
    legendError: 'errored',
    legendBanned: 'banned',
    spectrumAriaLabel: 'Bars representing the state of each proxy in the current sample',
    poolTitle: 'Proxy pool',
    filterChipOk: 'ok',
    filterChipWarn: 'slow',
    filterChipErr: 'error',
    filterChipBan: 'banned',
    filterAriaGroup: 'Filter by status',
    filterPlaceholder: 'filter (Ctrl+K)',
    filterAriaInput: 'Filter proxies',
    copyAllTitle: 'Copy filtered proxies',
    thStatus: 'Status',
    thProxy: 'Proxy',
    thScore: 'Score',
    thLatency: 'Latency',
    thErrors: 'Errors',
    thOk: 'OKs',
    thBannedUntil: 'Banned until',
    trendLatency: 'average latency (ms)',
    trendErrors: 'accumulated errors',
    logTitle: 'Live log',
    autoscroll: 'autoscroll',
    clearLogTitle: 'Clear log',
    logAriaLabel: 'Live log',
    logWaiting: 'Waiting for events…',
    logCleared: 'Log cleared.',
    eventsTitle: 'Proxy events',
    evtFilterAria: 'Filter by type',
    evtFilterAll: 'all',
    clearEventsTitle: 'Clear events',
    eventFeedAria: 'Proxy events',
    eventsWaiting: 'Waiting for connection events…',
    eventsCleared: 'Events cleared.',
    rotatorConfigTitle: 'Rotator configuration',
    proxyFileLabel: 'Proxy file',
    proxyFileHint: 'Set via command line or environment variable when the process starts — not editable here.',
    retriesLabel: 'Retries',
    retriesHint: 'attempts per request',
    maxErrorsLabel: 'Max errors',
    maxErrorsHint: 'above this, the proxy is ignored',
    rotatorTimeoutLabel: 'Rotator timeout (ms)',
    upstreamIdleLabel: 'Upstream idle timeout (ms)',
    upstreamIdleHint: '0 = automatic (2× rotator timeout); how long without upstream data before aborting',
    targetsLabel: 'Health-check targets (one per line)',
    saveConfigBtn: 'Save configuration',
    validatorTitle: 'Validator',
    threadsLabel: 'Threads',
    threadsHint: '10–20 for free proxies',
    modeLabel: 'Mode',
    modeTcpOnly: 'tcp-only — TCP only',
    modeQuick: 'quick — IP only',
    modeStandard: 'standard — IP + stream',
    modeStrict: 'strict — full',
    modeStream: 'stream — streaming only',
    baseUrlLabel: 'Base URL',
    baseUrlHint: 'http:// endpoints tend to work better with http proxies',
    maxLatLabel: 'Max latency (ms)',
    connTimeoutLabel: 'Connect timeout (s)',
    throttleLabel: 'Throttle (ms)',
    throttleHint: 'random jitter 0..N',
    ttfbLabel: 'TTFB tolerance (%)',
    ttfbHint: '100 disables the check',
    pruneLabel: 'Remove invalid entries from the file when done',
    anonLabel: 'Require anonymity (rejects transparent proxies)',
    insecureLabel: 'Ignore invalid TLS certificate',
    vstatTotal: 'total',
    vstatOk: 'valid',
    vstatFail: 'invalid',
    validateBtn: 'Validate now',
    validateBtnRunning: 'Validating…',
    stopBtn: 'Stop',
    stopBtnStopping: 'Stopping…',
    validateLogAria: 'Validation results',
    validateLogEmpty: 'No activity yet. Click Validate to start.',
    footerSse: 'Live SSE',
    footerCtrlK: 'to filter the pool',
    copiedGeneric: 'Copied',
    copiedCount: 'Copied {n} proxies',
    copyFail: 'Could not copy',
    copyBtnTitle: 'Copy',
    copyBtnAria: 'Copy {proxy}',
    delBtnTitle: 'Remove from pool',
    delBtnAria: 'Remove {proxy} from pool',
    delConfirmTitle: 'Click again to confirm (edits the file, cannot be undone)',
    delConfirmAria: 'Confirm removing {proxy} from pool',
    delConfirm: 'Remove "{proxy}" from the pool?\n\nThis edits the proxy file and cannot be undone.',
    delSuccessToast: 'Proxy removed from pool',
    delErrorToast: 'Error removing: {msg}',
    emptyNoMatch: 'No proxy matches "{term}"',
    emptyPoolEmpty: 'Pool empty — run a validation to populate it.',
    emptyFilters: 'No proxy matches the filters.',
    sampleShowing: 'Showing the {n} proxies with the best score, out of {total} total.',
    spectrumEmpty: 'No data yet — validate the proxy file to populate the sample.',
    statusOk: 'healthy',
    statusWarn: 'slow',
    statusErr: 'error',
    statusBan: 'banned',
    evtStatusOk: 'OK',
    evtStatusFail: 'FAIL',
    evtStatusAttempt: 'ATT',
    evtStatusInfo: 'INFO',
    errStatsFetch: 'Error fetching stats: {msg}',
    errSyncStatus: 'Failed to sync validation status: {msg}',
    modeDescTcpOnly: 'Only tests whether the TCP connection to the proxy opens. Does not validate HTTP or the configured targets — the fastest option, useful for a first rough pass.',
    modeDescQuick: 'Tests only TCP + /ip. The fastest option, ideal for large lists of free proxies — never fails because of streaming buffering.',
    modeDescStandard: 'TCP + /ip + 5 streaming chunks (tolerant). Uses 100% TTFB tolerance by default so proxies with buffering aren\u2019t failed unfairly. Recommended for testing real streaming.',
    modeDescStrict: 'quick + 5-chunk streaming + POST + 20-chunk streaming. Stricter — will fail a good share of free proxies.',
    modeDescStream: 'Tests streaming only. Use with your own Stream URL to validate against your real backend (SSE, AI APIs, etc).',
    validationStarted: 'Validation started — job #{id}, mode {mode}, {threads} threads',
    validationStartedToast: 'Validation #{id} started',
    validationStartErr: 'Error starting validation: {msg}',
    validationStartErrToast: 'Error starting validation',
    stopRequested: 'Stop requested — shutting down processes…',
    stopRequestedToast: 'Stopping — should take less than 2s',
    stopErr: 'Error stopping: {msg}',
    stopErrToast: 'Error stopping',
    savingConfig: 'Saving…',
    configSaved: 'Configuration saved.',
    configSavedToast: 'Configuration saved',
    configErr: 'Error: {msg}',
    configErrToast: 'Error saving configuration',
    errLoadConfig: 'Error loading configuration: {msg}',
    connectedLog: 'Connected — live updates active',
    connLostLog: 'Connection lost — retrying in {delay}s…',
    stoppingValidationLog: 'Stopping validation — shutting down processes…',
    validationStoppedLog: 'Validation stopped by user',
    validationErrLog: 'Validation error: {msg}',
    validationDoneLog: 'Validation complete: {ok} valid, {fail} invalid (exit code {code})',
    validationStoppedToast: 'Validation stopped',
    validationDoneToast: 'Validation: {ok} ok / {fail} failed',
    preparing: 'Preparing…',
    progressStatus: '{ok} valid, {fail} invalid — {done} of {total}',
  },
};

const LANG_KEY = 'rotator:lang';

function detectDefaultLang() {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === 'pt' || saved === 'en') return saved;
  return ((navigator.language || '').toLowerCase().indexOf('pt') === 0 ? 'pt' : 'en');
}

let lang = detectDefaultLang();

function t(key, vars) {
  const dict = I18N[lang] || I18N.en;
  let str = dict[key];
  if (str === undefined) str = (I18N.en[key] !== undefined ? I18N.en[key] : key);
  if (vars) {
    for (const k in vars) str = str.split(`{${k}}`).join(vars[k]);
  }
  return str;
}

function locale() { return lang === 'pt' ? 'pt-BR' : 'en-US'; }

/* ==================== data model ==================== */

let proxyData = [];
let proxyDataFiltered = [];
const latencyHistory = [];
const MAX_HISTORY = 60;
let sortKey = 'score';
let sortDir = 'asc';
let filterTerm = '';
const statusFilter = new Set();
let isValidating = false;
let CFG = {};
let valCounters = { total: 0, ok: 0, fail: 0 };
let refreshScheduled = false;
let _sseRetryCount = 0;

/* ==================== DOM refs ==================== */

function layoutEl() { return document.getElementById('layout'); }

/* ==================== sidebar toggle ==================== */

const layout = document.getElementById('layout');
const sidebarToggle = document.getElementById('sidebar-toggle');

function updateSidebarUI(hidden) {
  if (!sidebarToggle) return;
  sidebarToggle.classList.toggle('active', hidden);
  const icon = sidebarToggle.querySelector('.icon');
  if (icon) icon.textContent = hidden ? '◀' : '▶';
  const label = document.getElementById('sidebar-toggle-label');
  if (label) label.textContent = hidden ? t('sidebarShowLabel') : t('sidebarHideLabel');
  sidebarToggle.setAttribute('aria-label', hidden ? t('sidebarShowAria') : t('sidebarHideAria'));
  sidebarToggle.title = hidden ? t('sidebarShowTitle') : t('sidebarHideTitle');
}

if (sidebarToggle) {
  sidebarToggle.addEventListener('click', () => {
    const hidden = layout.classList.toggle('sidebar-hidden');
    updateSidebarUI(hidden);
    localStorage.setItem('rotator:sidebar', hidden ? 'hidden' : 'visible');
  });
}

// Restore sidebar state
(() => {
  const state = localStorage.getItem('rotator:sidebar');
  if (state === 'hidden') {
    layout.classList.add('sidebar-hidden');
    if (sidebarToggle) sidebarToggle.classList.add('active');
  }
})();

/* ==================== i18n helpers ==================== */

function applyStaticI18n() {
  document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
  document.title = t('pageTitle');
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  const vlog = document.getElementById('validate-log');
  if (vlog) vlog.dataset.emptyMsg = t('validateLogEmpty');
  const efeed = document.getElementById('event-feed');
  if (efeed) efeed.dataset.emptyMsg = t('eventsWaiting');
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
  updateSidebarUI(layout.classList.contains('sidebar-hidden'));
}

// Apply initial i18n after sidebar state is restored
applyStaticI18n();

function setLang(next) {
  if (next !== 'pt' && next !== 'en') return;
  lang = next;
  localStorage.setItem(LANG_KEY, lang);
  applyStaticI18n();
  updateModeDesc();
  renderProxyTable();
  renderSpectrum();
}

document.querySelectorAll('.lang-btn').forEach((btn) => {
  btn.addEventListener('click', () => { setLang(btn.dataset.lang); });
});

/* ==================== toast ==================== */

function toast(msg, ms) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.classList.remove('show'); }, ms || 3000);
}

/* ==================== clock ==================== */

function fmtClock() {
  const el = document.getElementById('live-clock');
  if (el) el.textContent = new Date().toLocaleTimeString(locale());
}
setInterval(fmtClock, 1000);
fmtClock();

/* ==================== real-time log ==================== */

function log(text, cls) {
  const container = document.getElementById('log');
  const empty = container.querySelector('.log-empty');
  if (empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'log-line' + (cls ? ' ' + cls : '');
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString(locale());
  const txt = document.createElement('span');
  txt.className = 'log-text';
  txt.textContent = text;
  row.appendChild(time);
  row.appendChild(txt);
  const autoscroll = document.getElementById('chk-autoscroll')?.checked ?? true;
  container.appendChild(row);
  if (autoscroll) container.scrollTop = container.scrollHeight;
  while (container.children.length > 300) container.removeChild(container.firstChild);
}

document.getElementById('btn-clear-logs')?.addEventListener('click', () => {
  document.getElementById('log').innerHTML = `<div class="log-empty">${esc(t('logCleared'))}</div>`;
});

/* ==================== fetch helper ==================== */

async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const txt = await r.text().catch(() => r.statusText);
    let msg = txt;
    try { const j = JSON.parse(txt); msg = j.error || txt; } catch { /* ignore */ }
    throw new Error(msg || r.statusText);
  }
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) return r.json();
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return {}; }
}

/* ==================== status classification ==================== */

function classify(p, now) {
  const banned = p.banned || now < p.bannedUntil;
  if (banned) return 'ban';
  const maxErrors = CFG.maxErrors ?? 3;
  if (p.errors >= maxErrors) return 'err';
  const timeout = CFG.timeout || 3500;
  if (p.latency !== 9999 && p.latency > timeout * 0.55) return 'warn';
  return 'ok';
}

function statusLabel(status) {
  return { ok: t('statusOk'), warn: t('statusWarn'), err: t('statusErr'), ban: t('statusBan') }[status];
}

const STATUS_BADGE_CLASS = { ok: 'badge-ok', warn: 'badge-warn', err: 'badge-err', ban: 'badge-ban' };

/* ==================== stats refresh ==================== */

async function refreshStats() {
  try {
    const d = await fetchJSON('/__stats');
    proxyData = d.top || [];
    document.getElementById('stat-total').textContent = d.total ?? proxyData.length;
    document.getElementById('stat-total-sub').textContent =
      (d.total ?? 0) > proxyData.length
        ? t('sampleOf', { n: proxyData.length, total: d.total })
        : t('allVisible');
    const now = Date.now();
    const bannedInSample = proxyData.filter((p) => p.banned || now < p.bannedUntil).length;
    document.getElementById('stat-sample-banned').textContent = bannedInSample;
    document.getElementById('stat-alive').textContent = d.alive ?? 0;
    document.getElementById('stat-retries').textContent = d.retries ?? '—';
    document.getElementById('stat-timeout').textContent = d.timeout ?? CFG.timeout ?? '—';
    const targetsEl = document.getElementById('stat-targets');
    const targetsStr = Array.isArray(d.targets) ? (d.targets.join(', ') || '—') : (d.targets || '—');
    targetsEl.textContent = targetsStr;
    targetsEl.title = targetsStr;
    const note = document.getElementById('table-note');
    note.textContent = (d.total ?? 0) > proxyData.length
      ? t('sampleShowing', { n: proxyData.length, total: d.total })
      : '';

    const withLatency = proxyData.filter((p) => p.latency !== 9999);
    const avgLat = withLatency.length
      ? Math.round(withLatency.reduce((s, p) => s + p.latency, 0) / withLatency.length)
      : 0;
    const totalErrors = proxyData.reduce((s, p) => s + p.errors, 0);
    latencyHistory.push({ latency: avgLat, errors: totalErrors });
    if (latencyHistory.length > MAX_HISTORY) latencyHistory.shift();

    renderProxyTable();
    renderSpectrum();
    renderTrend();
  } catch (e) {
    log(t('errStatsFetch', { msg: e.message }), 'fail');
  }
}

/* ==================== sort & filter ==================== */

function getSortedFiltered() {
  let list = proxyData.slice();
  if (filterTerm) {
    list = list.filter((p) => p.proxy.toLowerCase().includes(filterTerm));
  }
  if (statusFilter.size > 0) {
    const now = Date.now();
    list = list.filter((p) => statusFilter.has(classify(p, now)));
  }
  const now = Date.now();
  list.sort((a, b) => {
    let va, vb;
    switch (sortKey) {
      case 'proxy': va = a.proxy; vb = b.proxy; break;
      case 'status': va = classify(a, now); vb = classify(b, now); break;
      case 'score': va = a.score; vb = b.score; break;
      case 'latency': va = a.latency; vb = b.latency; break;
      case 'errors': va = a.errors; vb = b.errors; break;
      case 'ok': va = a.successes; vb = b.successes; break;
      default: va = a.score; vb = b.score;
    }
    if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });
  return list;
}

function updateSortIndicators() {
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    if (th.dataset.sort === sortKey) {
      th.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending');
    } else {
      th.setAttribute('aria-sort', 'none');
    }
  });
}

document.querySelectorAll('th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (sortKey === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = key;
      sortDir = 'asc';
    }
    updateSortIndicators();
    renderProxyTable();
  });
  th.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      th.click();
    }
  });
});
updateSortIndicators();

/* ==================== proxy table rendering ==================== */

function buildRow(p, now) {
  const status = classify(p, now);
  const tr = document.createElement('tr');
  tr.dataset.proxyKey = p.proxy;

  // Status badge
  const tdStatus = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = `badge ${STATUS_BADGE_CLASS[status]}`;
  badge.textContent = statusLabel(status);
  tdStatus.appendChild(badge);
  tr.appendChild(tdStatus);

  // Proxy cell with copy and delete buttons
  const tdProxy = document.createElement('td');
  const cell = document.createElement('div');
  cell.className = 'proxy-cell';
  const addr = document.createElement('span');
  addr.className = 'addr';
  addr.textContent = p.proxy;
  addr.title = p.proxy;
  const copyBtn = document.createElement('button');
  copyBtn.className = 'icon-btn';
  copyBtn.textContent = '⧉';
  copyBtn.title = t('copyBtnTitle');
  copyBtn.setAttribute('aria-label', t('copyBtnAria', { proxy: p.proxy }));
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(p.proxy)
      .then(() => { toast(t('copiedGeneric')); })
      .catch(() => {});
  });
  const delBtn = document.createElement('button');
  delBtn.className = 'icon-btn danger';
  delBtn.textContent = '✕';
  delBtn.title = t('delBtnTitle');
  delBtn.setAttribute('aria-label', t('delBtnAria', { proxy: p.proxy }));
  let armTimer = null;
  let armed = false;
  function disarm() {
    armed = false;
    clearTimeout(armTimer);
    delBtn.classList.remove('confirming');
    delBtn.textContent = '✕';
    delBtn.title = t('delBtnTitle');
    delBtn.setAttribute('aria-label', t('delBtnAria', { proxy: p.proxy }));
  }
  delBtn.addEventListener('blur', disarm);
  delBtn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      delBtn.classList.add('confirming');
      delBtn.textContent = '✓';
      delBtn.title = t('delConfirmTitle');
      delBtn.setAttribute('aria-label', t('delConfirmAria', { proxy: p.proxy }));
      armTimer = setTimeout(disarm, 3000);
      return;
    }
    clearTimeout(armTimer);
    delBtn.disabled = true;
    try {
      await fetchJSON(`/api/proxy?key=${encodeURIComponent(p.proxy)}`, { method: 'DELETE' });
      proxyData = proxyData.filter((x) => x.proxy !== p.proxy);
      renderProxyTable();
      renderSpectrum();
      toast(t('delSuccessToast'));
    } catch (e) {
      delBtn.disabled = false;
      disarm();
      toast(t('delErrorToast', { msg: e.message }));
    }
  });
  cell.appendChild(addr);
  cell.appendChild(copyBtn);
  cell.appendChild(delBtn);
  tdProxy.appendChild(cell);
  tr.appendChild(tdProxy);

  // Score
  const tdScore = document.createElement('td');
  tdScore.className = 'mono';
  tdScore.textContent = p.score === Infinity ? '∞' : Math.round(p.score);
  tr.appendChild(tdScore);

  // Latency
  const tdLat = document.createElement('td');
  tdLat.className = `num ${
    status === 'err' || status === 'ban' ? 'err'
      : status === 'warn' ? 'warn'
      : 'ok'
  }`;
  tdLat.textContent = p.latency === 9999 ? '—' : `${p.latency} ms`;
  tr.appendChild(tdLat);

  // Errors
  const tdErr = document.createElement('td');
  tdErr.textContent = p.errors;
  tr.appendChild(tdErr);

  // Successes (OKs)
  const tdOk = document.createElement('td');
  tdOk.textContent = p.successes;
  tr.appendChild(tdOk);

  // Ban countdown
  const tdBan = document.createElement('td');
  tdBan.className = 'mono';
  tdBan.style.fontSize = '11px';
  const banned = p.banned || now < p.bannedUntil;
  tdBan.textContent = banned ? `${Math.max(0, Math.round((p.bannedUntil - now) / 1000))}s` : '—';
  tr.appendChild(tdBan);

  return tr;
}

function renderProxyTable() {
  const tbody = document.getElementById('proxy-table');
  const filtered = getSortedFiltered();
  proxyDataFiltered = filtered;
  tbody.innerHTML = '';

  if (!filtered.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'empty-row';
    let msg;
    if (filterTerm && statusFilter.size > 0) {
      msg = t('emptyFilters');
    } else if (filterTerm) {
      msg = t('emptyNoMatch', { term: filterTerm });
    } else if (statusFilter.size > 0) {
      msg = t('emptyFilters');
    } else {
      msg = t('emptyPoolEmpty');
    }
    td.textContent = msg;
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    const now = Date.now();
    const frag = document.createDocumentFragment();
    filtered.forEach((p) => { frag.appendChild(buildRow(p, now)); });
    tbody.appendChild(frag);
  }

  // Update filter chip counts
  const statusCounts = { ok: 0, warn: 0, err: 0, ban: 0 };
  const now2 = Date.now();
  proxyData.forEach((p) => {
    const s = classify(p, now2);
    if (statusCounts[s] !== undefined) statusCounts[s]++;
  });
  document.querySelectorAll('.filter-chip .count').forEach((el) => {
    el.textContent = statusCounts[el.dataset.status] || 0;
  });

  const countEl = document.getElementById('pool-count');
  countEl.textContent = proxyData.length ? `· ${filtered.length} / ${proxyData.length}` : '';
}

/* ==================== ban countdown tick ==================== */

setInterval(() => {
  const rows = document.querySelectorAll('#proxy-table tr[data-proxy-key]');
  const now = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const p = proxyDataFiltered[i];
    if (!p) continue;
    const cell = rows[i].cells[6];
    if (!cell) continue;
    const banned = p.banned || now < p.bannedUntil;
    cell.textContent = banned ? `${Math.max(0, Math.round((p.bannedUntil - now) / 1000))}s` : '—';
  }
}, 1000);

/* ==================== health spectrum ==================== */

function renderSpectrum() {
  const el = document.getElementById('spectrum');
  if (!proxyData.length) {
    el.innerHTML = `<div class="spectrum-empty">${esc(t('spectrumEmpty'))}</div>`;
    return;
  }
  const now = Date.now();
  const ordered = proxyData.slice().sort((a, b) => a.score - b.score);
  const finiteScores = ordered.map((p) => p.score).filter((s) => s !== Infinity);
  const maxScore = finiteScores.length ? Math.max.apply(null, finiteScores) : 1;
  el.innerHTML = '';
  const frag = document.createDocumentFragment();
  ordered.forEach((p) => {
    const status = classify(p, now);
    const bar = document.createElement('div');
    bar.className = `bar ${status}`;
    let heightPct;
    if (status === 'ban' || p.score === Infinity) {
      heightPct = 8;
    } else {
      heightPct = Math.max(10, 100 - Math.round((p.score / (maxScore || 1)) * 90));
    }
    bar.style.height = `${heightPct}%`;
    bar.title = `${p.proxy} — ${statusLabel(status)}${p.latency !== 9999 ? `, ${p.latency}ms` : ''}`;
    frag.appendChild(bar);
  });
  el.appendChild(frag);
}

/* ==================== trend sparkline ==================== */

function renderTrend() {
  const svg = document.getElementById('trend-svg');
  if (!latencyHistory.length) { svg.innerHTML = ''; return; }
  const w = 600, h = 64, pad = 4;
  const n = latencyHistory.length;
  const lat = latencyHistory.map((d) => d.latency);
  const err = latencyHistory.map((d) => d.errors);
  const maxLat = Math.max(1, Math.max.apply(null, lat));
  const maxErr = Math.max(1, Math.max.apply(null, err));
  function pathFor(values, max) {
    return values.map((v, i) => {
      const x = n > 1 ? pad + (i / (n - 1)) * (w - pad * 2) : pad;
      const y = h - pad - (v / max) * (h - pad * 2);
      return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join(' ');
  }
  const latPath = pathFor(lat, maxLat);
  const errPath = pathFor(err, maxErr);
  const tokens = getComputedStyle(document.documentElement);
  const warnColor = tokens.getPropertyValue('--warn').trim() || '#e2a13c';
  const errColor = tokens.getPropertyValue('--err').trim() || '#e06363';
  svg.innerHTML =
    `<path d="${latPath}" fill="none" stroke="${warnColor}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<path d="${errPath}" fill="none" stroke="${errColor}" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round" opacity="0.75"/>`;
}

/* ==================== search / filter / copy-all ==================== */

// Debounced search: collect input value on each keystroke but batch renders
const handleSearchInput = debounce(() => {
  const input = document.getElementById('proxy-filter');
  filterTerm = input.value.toLowerCase().trim();
  renderProxyTable();
}, 120);

document.getElementById('proxy-filter').addEventListener('input', handleSearchInput);

// Ctrl+K / Cmd+K to focus search
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    document.getElementById('proxy-filter').focus();
  }
});

// Copy all filtered
document.getElementById('btn-copy-all')?.addEventListener('click', () => {
  const txt = proxyDataFiltered.map((p) => p.proxy).join('\n');
  navigator.clipboard.writeText(txt)
    .then(() => { toast(t('copiedCount', { n: proxyDataFiltered.length })); })
    .catch(() => { toast(t('copyFail')); });
});

// Status filter chips
document.querySelectorAll('.filter-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const status = chip.dataset.status;
    if (statusFilter.has(status)) {
      statusFilter.delete(status);
    } else {
      statusFilter.add(status);
    }
    chip.classList.toggle('active');
    renderProxyTable();
  });
});

/* ==================== SSE connection ==================== */

function connectSSE() {
  const ev = new EventSource('/events');
  const dot = document.getElementById('sse-dot');
  const txt = document.getElementById('sse-text');

  ev.addEventListener('connected', () => {
    log(t('connectedLog'));
    if (dot) dot.className = 'dot live';
    if (txt) txt.textContent = t('liveActive');
    syncValidationStatus();
    _sseRetryCount = 0;  // Reset retry count on successful connection
  });

  ev.addEventListener('health:update', () => {
    if (!refreshScheduled) {
      refreshScheduled = true;
      setTimeout(() => { refreshScheduled = false; refreshStats(); }, 600);
    }
  });

  addSSEListeners(ev);
  addEventFeedSSE(ev);

  ev.onerror = () => {
    ev.close();
    _sseRetryCount++;
    const delay = Math.min(1000 * Math.pow(2, _sseRetryCount), 30000);
    log(t('connLostLog', { delay: Math.round(delay / 1000) }), 'fail');
    if (dot) dot.className = 'dot down';
    if (txt) txt.textContent = t('reconnecting');
    setTimeout(connectSSE, delay);
  };
}

/* ==================== validation SSE listeners ==================== */

function addSSEListeners(ev) {
  ev.addEventListener('validation:progress', (e) => {
    try {
      const d = JSON.parse(e.data);
      const el = document.getElementById('validate-log');
      const line = document.createElement('div');
      const txt = d.line || '';
      line.textContent = txt;
      if (txt.includes('[VALID]')) {
        line.className = 'ok';
        valCounters.ok++;
        valCounters.total = Math.max(valCounters.total, valCounters.ok + valCounters.fail);
      } else if (txt.includes('[INVALID]')) {
        line.className = 'fail';
        valCounters.fail++;
        valCounters.total = Math.max(valCounters.total, valCounters.ok + valCounters.fail);
      } else {
        line.className = 'info';
        const m = txt.match(/[Tt]otal:\s*(\d+)/);
        if (m) valCounters.total = parseInt(m[1], 10);
      }
      document.getElementById('vstat-total').textContent = valCounters.total || (valCounters.ok + valCounters.fail);
      document.getElementById('vstat-ok').textContent = valCounters.ok;
      document.getElementById('vstat-fail').textContent = valCounters.fail;
      updateProgress();
      el.appendChild(line);
      el.scrollTop = el.scrollHeight;
      while (el.children.length > 500) el.removeChild(el.firstChild);
    } catch { /* ignore parse errors */ }
  });

  ev.addEventListener('validation:stopping', () => {
    log(t('stoppingValidationLog'), 'info');
  });

  ev.addEventListener('validation:complete', (e) => {
    try {
      const d = JSON.parse(e.data);
      stopValidationUI();
      if (d.stopped) {
        log(t('validationStoppedLog'), 'info');
      } else if (d.error) {
        log(t('validationErrLog', { msg: d.error }), 'fail');
      } else {
        log(t('validationDoneLog', { ok: d.passed, fail: d.failed, code: d.exitCode }), d.exitCode === 0 ? 'ok' : 'fail');
      }
      toast(d.stopped ? t('validationStoppedToast') : t('validationDoneToast', { ok: d.passed, fail: d.failed }));
      refreshStats();
    } catch { /* ignore parse errors */ }
  });
}

/* ==================== event feed ==================== */

let eventFilter = '';
let lastRenderedEventId = 0;

async function loadInitialEvents() {
  try {
    const res = await fetch('/api/events');
    const events = await res.json();
    for (const e of events) {
      renderEventLine(e);
      if (e.id > lastRenderedEventId) lastRenderedEventId = e.id;
    }
  } catch { /* ignore */ }
}

function renderEventLine(e) {
  if (e.id <= lastRenderedEventId) return;
  lastRenderedEventId = e.id;
  const container = document.getElementById('event-feed');
  const empty = container.querySelector('.log-empty');
  if (empty) empty.remove();

  if (eventFilter && e.type !== eventFilter) return;

  const line = document.createElement('div');
  line.className = 'evt-line';
  line.dataset.type = e.type;

  // --- Primary row (time · type · proxy · status · latency · bytes) ---
  const primary = document.createElement('div');
  primary.className = 'evt-primary';

  // Time
  const time = document.createElement('span');
  time.className = 'evt-time';
  time.textContent = new Date(e.ts).toLocaleTimeString(locale());
  primary.appendChild(time);

  // Type badge
  const typeBadge = document.createElement('span');
  typeBadge.className = `evt-type ${e.type}`;
  typeBadge.textContent = e.type;
  primary.appendChild(typeBadge);

  // Proxy
  const proxy = document.createElement('span');
  proxy.className = 'evt-proxy';
  proxy.textContent = e.proxy || '—';
  proxy.title = e.proxy || '';
  primary.appendChild(proxy);

  // Status
  const status = document.createElement('span');
  status.className = `evt-status ${e.status}`;
  const statusLabelMap = { success: t('evtStatusOk'), failure: t('evtStatusFail'), attempt: t('evtStatusAttempt'), info: t('evtStatusInfo') };
  status.textContent = statusLabelMap[e.status] || e.status;
  primary.appendChild(status);

  // Latency detail
  if (e.latency !== undefined && e.latency !== null) {
    const lat = document.createElement('span');
    lat.className = 'evt-detail';
    lat.textContent = `${e.latency}ms`;
    primary.appendChild(lat);
  }

  // Bytes detail
  if (e.bytes !== undefined && e.bytes !== null) {
    const bytes = document.createElement('span');
    bytes.className = 'evt-detail';
    bytes.textContent = `${(e.bytes / 1024).toFixed(1)}KB`;
    primary.appendChild(bytes);
  }

  line.appendChild(primary);

  // --- Secondary rows (target, error, detail — each full-width) ---

  // Target
  if (e.target) {
    const sec = document.createElement('div');
    sec.className = 'evt-secondary';
    const icon = document.createElement('span');
    icon.className = 'evt-secondary-icon';
    icon.textContent = '\u2192';
    sec.appendChild(icon);
    const target = document.createElement('span');
    target.className = 'evt-target';
    target.textContent = e.target;
    target.title = e.target;
    sec.appendChild(target);
    line.appendChild(sec);
  }

  // Error
  if (e.error) {
    const sec = document.createElement('div');
    sec.className = 'evt-secondary';
    const icon = document.createElement('span');
    icon.className = 'evt-secondary-icon';
    icon.textContent = '\u2717';
    sec.appendChild(icon);
    const err = document.createElement('span');
    err.className = 'evt-error';
    err.textContent = e.error;
    err.title = e.error;
    sec.appendChild(err);
    line.appendChild(sec);
  }

  // Extra detail
  if (e.detail) {
    const sec = document.createElement('div');
    sec.className = 'evt-secondary';
    const det = document.createElement('span');
    det.className = 'evt-detail';
    det.textContent = e.detail;
    sec.appendChild(det);
    line.appendChild(sec);
  }

  const autoscroll = document.getElementById('evt-autoscroll')?.checked ?? true;
  container.appendChild(line);
  if (autoscroll) container.scrollTop = container.scrollHeight;
  while (container.children.length > 500) container.removeChild(container.firstChild);
}

function addEventFeedSSE(ev) {
  ev.addEventListener('proxy:event', (e) => {
    try {
      const d = JSON.parse(e.data);
      renderEventLine(d);
    } catch { /* ignore */ }
  });
}

// Event filter dropdown
document.getElementById('evt-filter')?.addEventListener('change', (e) => {
  eventFilter = e.target.value;
  document.getElementById('event-feed').innerHTML = '';
  loadInitialEvents();
});

// Clear events
document.getElementById('btn-clear-events')?.addEventListener('click', () => {
  document.getElementById('event-feed').innerHTML = `<div class="log-empty">${esc(t('eventsCleared'))}</div>`;
  eventFilter = '';
  const sel = document.getElementById('evt-filter');
  if (sel) sel.value = '';
});

/* ==================== validation UI ==================== */

function startValidationUI() {
  isValidating = true;
  valCounters = { total: 0, ok: 0, fail: 0 };
  document.getElementById('vstat-total').textContent = '0';
  document.getElementById('vstat-ok').textContent = '0';
  document.getElementById('vstat-fail').textContent = '0';
  const btn = document.getElementById('btn-validate');
  btn.disabled = true;
  btn.textContent = t('validateBtnRunning');
  document.getElementById('btn-stop-validate').style.display = 'inline-flex';
  document.getElementById('running-chip').style.display = 'inline-flex';
  document.getElementById('validate-log').innerHTML = '';
  updateProgress();
}

function stopValidationUI() {
  isValidating = false;
  const btn = document.getElementById('btn-validate');
  btn.disabled = false;
  btn.textContent = t('validateBtn');
  document.getElementById('btn-stop-validate').style.display = 'none';
  document.getElementById('running-chip').style.display = 'none';
  document.getElementById('val-status').textContent = '';
  updateProgress();
}

function updateProgress() {
  const total = valCounters.total || 0;
  const done = valCounters.ok + valCounters.fail;
  const fill = document.getElementById('progress-fill');
  const status = document.getElementById('val-status');
  if (!fill) return;
  if (isValidating) {
    if (total === 0) {
      fill.style.width = '30%';
      fill.classList.add('indet');
      if (status) status.textContent = t('preparing');
    } else {
      fill.classList.remove('indet');
      const pct = Math.min(100, Math.round((done / Math.max(total, 1)) * 100));
      fill.style.width = `${pct}%`;
      if (status) status.textContent = t('progressStatus', { ok: valCounters.ok, fail: valCounters.fail, done, total });
    }
  } else {
    fill.classList.remove('indet');
    fill.style.width = '0%';
    if (status) status.textContent = '';
  }
}

async function syncValidationStatus() {
  try {
    const st = await fetchJSON('/api/validate/status');
    if (st.running && !isValidating) {
      startValidationUI();
    } else if (!st.running && isValidating) {
      stopValidationUI();
    }
  } catch (e) {
    log(t('errSyncStatus', { msg: e.message }), 'fail');
  }
}

/* ==================== validation mode description ==================== */

function updateModeDesc() {
  const mode = document.getElementById('cfg-val-mode').value;
  const map = {
    'tcp-only': t('modeDescTcpOnly'),
    quick: t('modeDescQuick'),
    standard: t('modeDescStandard'),
    strict: t('modeDescStrict'),
    stream: t('modeDescStream'),
  };
  document.getElementById('val-mode-desc').textContent = map[mode] || '';
  document.getElementById('val-mode-pill').textContent = mode;
}

document.getElementById('cfg-val-mode')?.addEventListener('change', updateModeDesc);

/* ==================== validate buttons ==================== */

document.getElementById('btn-validate')?.addEventListener('click', async () => {
  startValidationUI();
  try {
    const custom = {
      threads: parseInt(document.getElementById('cfg-val-threads').value, 10) || 10,
      mode: document.getElementById('cfg-val-mode').value,
      baseUrl: document.getElementById('cfg-val-baseurl').value.trim(),
      maxLatency: parseInt(document.getElementById('cfg-val-maxlat').value, 10),
      connectTimeout: parseInt(document.getElementById('cfg-val-conntimeout').value, 10),
      throttle: parseInt(document.getElementById('cfg-val-throttle').value, 10),
      prune: document.getElementById('cfg-val-prune').checked,
      anonCheck: document.getElementById('cfg-val-anon').checked,
      insecure: document.getElementById('cfg-val-insecure').checked,
    };
    const result = await fetchJSON('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(custom),
    });
    log(t('validationStarted', { id: result.jobId, mode: result.mode, threads: result.threads }), 'info');
    toast(t('validationStartedToast', { id: result.jobId }));
  } catch (e) {
    log(t('validationStartErr', { msg: e.message }), 'fail');
    toast(t('validationStartErrToast'));
    stopValidationUI();
  }
});

document.getElementById('btn-stop-validate')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-stop-validate');
  btn.disabled = true;
  btn.textContent = t('stopBtnStopping');
  try {
    await fetchJSON('/api/validate/stop', { method: 'POST' });
    log(t('stopRequested'), 'info');
    toast(t('stopRequestedToast'));
  } catch (e) {
    log(t('stopErr', { msg: e.message }), 'fail');
    toast(t('stopErrToast'));
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = t('stopBtn'); }, 2000);
});

/* ==================== config ==================== */

async function loadConfig() {
  try {
    const cfg = await fetchJSON('/api/config');
    CFG = cfg;
    document.getElementById('cfg-retries').value = cfg.retries ?? 5;
    document.getElementById('cfg-maxErrors').value = cfg.maxErrors ?? 3;
    document.getElementById('cfg-timeout').value = cfg.timeout ?? 3500;
    document.getElementById('cfg-upstreamIdleTimeout').value = cfg.upstreamIdleTimeout ?? 0;
    document.getElementById('cfg-targets').value = (cfg.targets || []).join('\n');
    document.getElementById('cfg-file-readonly').textContent = cfg.proxyFile || '—';
    const statFileEl = document.getElementById('stat-file');
    statFileEl.textContent = cfg.proxyFile || '—';
    statFileEl.title = cfg.proxyFile || '';
    document.getElementById('cfg-val-threads').value = cfg.validationThreads ?? 20;
    document.getElementById('cfg-val-mode').value = cfg.validationMode ?? 'quick';
    document.getElementById('cfg-val-baseurl').value = cfg.validationBaseUrl ?? 'http://httpbin.org';
    document.getElementById('cfg-val-maxlat').value = cfg.validationMaxLatency ?? 7000;
    document.getElementById('cfg-val-conntimeout').value = cfg.validationConnectTimeout ?? 4;
    document.getElementById('cfg-val-throttle').value = cfg.validationThrottle ?? 100;
    document.getElementById('cfg-val-ttfb').value = cfg.validationTtfbRatio ?? 100;
    document.getElementById('cfg-val-prune').checked = cfg.validationPrune !== false;
    document.getElementById('cfg-val-anon').checked = !!cfg.validationAnonCheck;
    document.getElementById('cfg-val-insecure').checked = !!cfg.validationInsecure;
    updateModeDesc();
  } catch (e) {
    log(t('errLoadConfig', { msg: e.message }), 'fail');
  }
}

document.getElementById('cfg-save')?.addEventListener('click', async () => {
  const btn = document.getElementById('cfg-save');
  btn.disabled = true;
  const msg = document.getElementById('cfg-msg');
  msg.textContent = t('savingConfig');
  msg.style.color = 'var(--ink-faint)';
  try {
    const targets = document.getElementById('cfg-targets').value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const body = {
      retries: parseInt(document.getElementById('cfg-retries').value, 10),
      maxErrors: parseInt(document.getElementById('cfg-maxErrors').value, 10),
      timeout: parseInt(document.getElementById('cfg-timeout').value, 10),
      upstreamIdleTimeout: parseInt(document.getElementById('cfg-upstreamIdleTimeout').value, 10) || 0,
      targets,
      validationThreads: parseInt(document.getElementById('cfg-val-threads').value, 10),
      validationMode: document.getElementById('cfg-val-mode').value,
      validationBaseUrl: document.getElementById('cfg-val-baseurl').value.trim() || 'http://httpbin.org',
      validationMaxLatency: parseInt(document.getElementById('cfg-val-maxlat').value, 10),
      validationConnectTimeout: parseInt(document.getElementById('cfg-val-conntimeout').value, 10),
      validationThrottle: parseInt(document.getElementById('cfg-val-throttle').value, 10),
      validationTtfbRatio: parseInt(document.getElementById('cfg-val-ttfb').value, 10),
      validationPrune: document.getElementById('cfg-val-prune').checked,
      validationAnonCheck: document.getElementById('cfg-val-anon').checked,
      validationInsecure: document.getElementById('cfg-val-insecure').checked,
    };
    const updated = await fetchJSON('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    Object.assign(CFG, updated);
    msg.textContent = t('configSaved');
    msg.style.color = 'var(--ok)';
    toast(t('configSavedToast'));
  } catch (e) {
    msg.textContent = t('configErr', { msg: e.message });
    msg.style.color = 'var(--err)';
    toast(t('configErrToast'));
  }
  btn.disabled = false;
});

/* ==================== initialization ==================== */

(async () => {
  try { await loadConfig(); } catch { /* config not critical for first render */ }
  try { await refreshStats(); } catch { /* stats fail gracefully */ }
  setInterval(refreshStats, 5000);
  connectSSE();
  try { await loadInitialEvents(); } catch { /* initial events optional */ }
})();

})();
