(() => {
  'use strict';

  const PLUGIN_ID = 'cardmirror-round-tools';
  const PLUGIN_NAME = 'Round Tools';
  const STORAGE_KEY = 'roundContext';
  const RUNTIME_KEY = '__cardMirrorRoundToolsRuntime';
  const STYLE_ID = 'cardmirror-round-tools-style';
  const OVERLAY_ID = 'cardmirror-round-tools-context-overlay';
  const SMART_DOC_OVERLAY_ID = 'cardmirror-round-tools-smart-doc-overlay';
  const ROUND_REPORT_OVERLAY_ID = 'cardmirror-round-tools-round-report-overlay';
  const RIBBON_PANEL_ID = 'cardmirror-round-tools-ribbon-panel';
  const UI_TOAST_ID = 'cardmirror-round-tools-ui-toast';
  const REPORT_STATE_KEY = 'roundReportState';
  const REPORT_CHANNEL_NAME = 'cardmirror-round-tools-round-report-v1';
  const HOST_SETTINGS_STORAGE_KEY = 'pmd-settings';
  const SMART_DOC_FILENAME_TEMPLATE = '{speech}';
  const SPEECHES = ['1AC', '1NC', '2AC', '2NC', '1NR', '1AR', '2NR', '2AR'];
  const REPORT_INSTANCE_ID = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'rt-' + Math.random().toString(36).slice(2) + '-' + Date.now();
  const WINDOW_ID_KEY = '__cardMirrorRoundToolsWindowId';
  const WINDOW_INSTANCE_ID = window[WINDOW_ID_KEY] || ('window-' + REPORT_INSTANCE_ID);
  window[WINDOW_ID_KEY] = WINDOW_INSTANCE_ID;

  // Clean up UI from a previous local development load. CardMirror owns command
  // registration; this only prevents duplicate plugin-owned DOM/styles.
  try {
    window[RUNTIME_KEY]?.destroy?.();
  } catch (err) {
    console.warn('[Round Tools] previous runtime cleanup failed:', err);
  }

  let activeOverlay = null;
  let pluginApi = null;
  let restoreFocusTo = null;
  let lastFocusedRoot = null;
  let reportChannel = null;
  let reportState = { assignments: {}, form: {}, contextUpdatedAt: 0, updatedAt: 0 };
  let reportStateInitialized = false;
  let ribbonRefreshFrame = 0;
  const rootIdentityKeys = new WeakMap();
  let rootIdentityCounter = 0;

  function stringValue(value) {
    return typeof value === 'string' ? value : '';
  }

  function normalizeSide(value) {
    const side = stringValue(value).trim().toUpperCase();
    return side === 'AFF' || side === 'NEG' ? side : '';
  }

  function emptyContext() {
    return {
      schema: 1,
      tournamentName: '',
      roundNumber: '',
      ourTeam: '',
      opponentTeam: '',
      side: '',
      judgeName: '',
      updatedAt: 0,
    };
  }

  function normalizeContext(raw) {
    if (!raw || typeof raw !== 'object') return emptyContext();
    return {
      schema: 1,
      tournamentName: stringValue(raw.tournamentName).trim(),
      roundNumber: stringValue(raw.roundNumber).trim(),
      ourTeam: stringValue(raw.ourTeam).trim(),
      opponentTeam: stringValue(raw.opponentTeam).trim(),
      side: normalizeSide(raw.side),
      judgeName: stringValue(raw.judgeName).trim(),
      updatedAt: Number(raw.updatedAt) || 0,
    };
  }

  function readContext(api) {
    try {
      return normalizeContext(api.storage.get(STORAGE_KEY));
    } catch (err) {
      console.warn('[Round Tools] could not read round context:', err);
      return emptyContext();
    }
  }

  function hasContext(context) {
    return Boolean(
      context.tournamentName ||
      context.roundNumber ||
      context.ourTeam ||
      context.opponentTeam ||
      context.side ||
      context.judgeName
    );
  }

  function deriveTeams(context) {
    if (context.side === 'AFF') {
      return { affTeam: context.ourTeam, negTeam: context.opponentTeam };
    }
    if (context.side === 'NEG') {
      return { affTeam: context.opponentTeam, negTeam: context.ourTeam };
    }
    return { affTeam: '', negTeam: '' };
  }

  function saveContext(api, context) {
    const normalized = normalizeContext({ ...context, updatedAt: Date.now() });
    normalized.updatedAt = Date.now();
    api.storage.set(STORAGE_KEY, normalized);
    return normalized;
  }

  function clearContext(api) {
    api.storage.set(STORAGE_KEY, emptyContext());
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .cm-rt-overlay {
        position: fixed;
        inset: 0;
        z-index: 100000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        box-sizing: border-box;
        background: rgba(0, 0, 0, 0.34);
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .cm-rt-overlay .cm-rt-dialog {
        width: min(620px, calc(100vw - 32px));
        max-height: min(760px, calc(100vh - 32px));
        overflow: auto;
        box-sizing: border-box;
        padding: 18px;
        border: 1px solid var(--pmd-c-border, rgba(127,127,127,.45));
        border-radius: 12px;
        background: var(--pmd-c-bg, Canvas);
        color: var(--pmd-c-text, CanvasText);
        box-shadow: 0 18px 55px rgba(0,0,0,.28);
      }
      .cm-rt-overlay .cm-rt-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 16px;
      }
      .cm-rt-overlay .cm-rt-title {
        margin: 0;
        font-size: 19px;
        line-height: 1.25;
        font-weight: 700;
      }
      .cm-rt-overlay .cm-rt-subtitle {
        margin: 5px 0 0;
        color: var(--pmd-c-text-muted, color-mix(in srgb, currentColor 66%, transparent));
        font-size: 12.5px;
        line-height: 1.4;
      }
      .cm-rt-overlay .cm-rt-close {
        flex: 0 0 auto;
        width: 32px;
        height: 32px;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: inherit;
        font-size: 24px;
        line-height: 28px;
        cursor: pointer;
      }
      .cm-rt-overlay .cm-rt-close:hover {
        background: color-mix(in srgb, currentColor 9%, transparent);
      }
      .cm-rt-overlay .cm-rt-fields {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .cm-rt-overlay .cm-rt-field {
        display: flex;
        flex-direction: column;
        gap: 5px;
        min-width: 0;
      }
      .cm-rt-overlay .cm-rt-field.cm-rt-wide {
        grid-column: 1 / -1;
      }
      .cm-rt-overlay .cm-rt-field-label {
        font-size: 12px;
        font-weight: 650;
      }
      .cm-rt-overlay .cm-rt-optional {
        font-weight: 400;
        opacity: .68;
      }
      .cm-rt-overlay input,
      .cm-rt-overlay select {
        width: 100%;
        box-sizing: border-box;
        min-height: 38px;
        padding: 8px 10px;
        border: 1px solid var(--pmd-c-border, rgba(127,127,127,.48));
        border-radius: 7px;
        background: var(--pmd-c-bg, Canvas);
        color: inherit;
        font: inherit;
        outline: none;
      }
      .cm-rt-overlay input:focus,
      .cm-rt-overlay select:focus {
        border-color: var(--pmd-c-accent, Highlight);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--pmd-c-accent, Highlight) 22%, transparent);
      }
      .cm-rt-overlay .cm-rt-preview {
        margin-top: 14px;
        padding: 10px 11px;
        border: 1px solid var(--pmd-c-border, rgba(127,127,127,.35));
        border-radius: 8px;
        background: color-mix(in srgb, currentColor 4%, transparent);
        font-size: 12.5px;
        line-height: 1.45;
      }
      .cm-rt-overlay .cm-rt-preview strong { font-weight: 650; }
      .cm-rt-overlay .cm-rt-actions {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-top: 18px;
      }
      .cm-rt-overlay .cm-rt-action-group {
        display: flex;
        gap: 8px;
        margin-left: auto;
      }
      .cm-rt-overlay button.cm-rt-btn {
        min-height: 36px;
        padding: 7px 13px;
        border: 1px solid var(--pmd-c-border, rgba(127,127,127,.48));
        border-radius: 7px;
        background: var(--pmd-c-bg, Canvas);
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      .cm-rt-overlay button.cm-rt-btn:hover {
        background: color-mix(in srgb, currentColor 7%, transparent);
      }
      .cm-rt-overlay button.cm-rt-primary {
        border-color: var(--pmd-c-accent, Highlight);
        background: var(--pmd-c-accent, Highlight);
        color: var(--pmd-c-accent-contrast, HighlightText);
        font-weight: 650;
      }
      .cm-rt-overlay button.cm-rt-clear {
        color: var(--pmd-c-danger, #c0392b);
      }
      .cm-rt-overlay .cm-rt-smart-summary {
        margin: 0 0 14px;
        padding: 10px 11px;
        border: 1px solid var(--pmd-c-border, rgba(127,127,127,.35));
        border-radius: 8px;
        background: color-mix(in srgb, currentColor 4%, transparent);
        font-size: 12.5px;
        line-height: 1.5;
      }
      .cm-rt-overlay .cm-rt-smart-name {
        margin-top: 14px;
        padding: 11px 12px;
        border: 1px solid var(--pmd-c-border, rgba(127,127,127,.35));
        border-radius: 8px;
        background: color-mix(in srgb, currentColor 4%, transparent);
        font-size: 13px;
        line-height: 1.45;
        overflow-wrap: anywhere;
      }
      .cm-rt-overlay .cm-rt-smart-note {
        margin: 9px 0 0;
        color: var(--pmd-c-text-muted, color-mix(in srgb, currentColor 66%, transparent));
        font-size: 11.5px;
        line-height: 1.45;
      }

      .cm-rt-overlay .cm-rt-assignment-list {
        margin: 0 0 15px;
        padding: 10px 11px;
        border: 1px solid var(--pmd-c-border, rgba(127,127,127,.35));
        border-radius: 8px;
        background: color-mix(in srgb, currentColor 4%, transparent);
      }
      .cm-rt-overlay .cm-rt-assignment-title {
        margin-bottom: 7px;
        font-size: 12px;
        font-weight: 700;
      }
      .cm-rt-overlay .cm-rt-assignment-row {
        display: grid;
        grid-template-columns: 48px minmax(0, 1fr);
        gap: 8px;
        align-items: baseline;
        padding: 3px 0;
        font-size: 12.5px;
      }
      .cm-rt-overlay .cm-rt-assignment-row strong { font-weight: 700; }
      .cm-rt-overlay .cm-rt-assignment-row span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--pmd-c-text-muted, color-mix(in srgb, currentColor 72%, transparent));
      }
      .cm-rt-overlay .cm-rt-report-note {
        margin: 10px 0 0;
        color: var(--pmd-c-text-muted, color-mix(in srgb, currentColor 66%, transparent));
        font-size: 11.5px;
        line-height: 1.45;
      }
      #cardmirror-round-tools-ribbon-panel {
        display: flex;
        flex-direction: column;
        gap: 3px;
        align-self: center;
        justify-content: center;
        margin-left: 4px;
        padding-left: 5px;
        border-left: 1px solid var(--pmd-c-border, rgba(127,127,127,.35));
      }
      #cardmirror-round-tools-ribbon-panel .cm-rt-ribbon-row {
        display: flex;
        gap: 3px;
        min-width: 0;
      }
      #cardmirror-round-tools-ribbon-panel .cm-rt-ribbon-btn {
        min-width: 32px;
        height: 21px;
        min-height: 21px;
        box-sizing: border-box;
        padding: 2px 5px;
        font-size: 10.5px;
        font-weight: 650;
        line-height: 1.15;
        white-space: nowrap;
      }
      #cardmirror-round-tools-ribbon-panel .cm-rt-speech-row .cm-rt-ribbon-btn {
        width: 39px;
        padding-inline: 3px;
      }
      #cardmirror-round-tools-ribbon-panel .cm-rt-action-row .cm-rt-ribbon-btn {
        flex: 1 1 0;
        min-width: 0;
        padding-inline: 7px;
      }
      #cardmirror-round-tools-ribbon-panel .cm-rt-ribbon-btn.cm-rt-assigned {
        border-color: color-mix(in srgb, #2e8b57 70%, var(--pmd-c-border, #888));
        background: color-mix(in srgb, #2e8b57 72%, var(--pmd-c-bg, #fff));
        color: #fff;
      }
      #cardmirror-round-tools-ui-toast {
        position: fixed;
        left: 50%;
        bottom: 34px;
        z-index: 100002;
        transform: translateX(-50%);
        max-width: min(560px, calc(100vw - 40px));
        box-sizing: border-box;
        padding: 8px 12px;
        border: 1px solid var(--pmd-c-border, rgba(127,127,127,.45));
        border-radius: 8px;
        background: var(--pmd-c-bg, #fff);
        color: var(--pmd-c-text, #111);
        box-shadow: 0 6px 22px rgba(0,0,0,.22);
        font: 12.5px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        pointer-events: none;
      }
      @media (max-width: 620px) {
        .cm-rt-overlay .cm-rt-fields { grid-template-columns: 1fr; }
        .cm-rt-overlay .cm-rt-field.cm-rt-wide { grid-column: auto; }
      }
    `;
    document.head.appendChild(style);
  }

  function rememberApi(api) {
    if (api && api.storage && typeof api.showToast === 'function') pluginApi = api;
    return api;
  }

  function localStorageBag() {
    const key = `plugin:${PLUGIN_ID}`;
    const read = () => {
      try {
        const raw = JSON.parse(localStorage.getItem(key) || '{}');
        return raw && typeof raw === 'object' ? raw : {};
      } catch (_) {
        return {};
      }
    };
    return {
      get(name) { return read()[name]; },
      set(name, value) {
        const bag = read();
        bag[name] = value;
        try { localStorage.setItem(key, JSON.stringify(bag)); } catch (_) {}
      },
    };
  }

  let uiToastTimer = null;
  function showUiToast(message) {
    ensureStyles();
    let toast = document.getElementById(UI_TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = UI_TOAST_ID;
      toast.setAttribute('role', 'status');
      document.body.appendChild(toast);
    }
    toast.textContent = String(message);
    if (uiToastTimer) clearTimeout(uiToastTimer);
    uiToastTimer = setTimeout(() => {
      const current = document.getElementById(UI_TOAST_ID);
      if (current) current.remove();
      uiToastTimer = null;
    }, 2600);
  }

  function buttonApi() {
    if (pluginApi) return pluginApi;
    // The public API only hands the capability object to command callbacks.
    // Ribbon buttons live outside that callback, so before the first command
    // run we mirror only the tiny subset Round Tools needs. Storage uses the
    // exact bag CardMirror's public API uses (`plugin:<id>`).
    return {
      appVersion: '',
      docInfo() { return null; },
      showToast: showUiToast,
      storage: localStorageBag(),
      settings: { get() { return undefined; }, onChanged() { return () => {}; } },
    };
  }

  function normalizeDocTitle(value) {
    return stringValue(value).trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function rootIdentityKey(root) {
    if (!(root instanceof Element)) return '';
    let key = rootIdentityKeys.get(root);
    if (!key) {
      rootIdentityCounter += 1;
      key = `${WINDOW_INSTANCE_ID}:editor-${rootIdentityCounter}`;
      rootIdentityKeys.set(root, key);
    }
    return key;
  }

  function titleNearRoot(root) {
    if (!(root instanceof Element)) return '';
    const containers = [];
    let current = root.parentElement;
    for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
      containers.push(current);
    }
    const selectors = [
      '[data-doc-title]',
      '.pmd-pane-doc-title',
      '.pmd-pane-title',
      '.pmd-doc-title',
      '.pmd-doc-name',
      '.pmd-pane-chip',
      '.pmd-doc-chip',
      '[class*="pane"][class*="title"]',
      '[class*="doc"][class*="title"]',
    ];
    for (const container of containers) {
      for (const selector of selectors) {
        const el = container.querySelector(selector);
        if (!(el instanceof HTMLElement)) continue;
        const explicit = stringValue(el.dataset?.docTitle).trim();
        if (explicit) return explicit;
        const text = stringValue(el.textContent).trim();
        if (text && text.length <= 240) return text;
      }
    }
    return '';
  }

  function currentDocumentIdentity(api) {
    const root = getActiveRoot();
    if (!root) return null;
    let info = null;
    try { info = api?.docInfo?.() || null; } catch (_) {}
    const fallbackTitle = titleNearRoot(root) || currentDocTitle(api, root);
    const title = stringValue(info?.docTitle || fallbackTitle).trim() || 'Untitled';
    return {
      docId: info?.docId || null,
      title,
      titleKey: normalizeDocTitle(title),
      viewKey: rootIdentityKey(root),
    };
  }

  function sameDocumentIdentity(a, b) {
    if (!a || !b) return false;
    const aTitleKey = a.titleKey || normalizeDocTitle(a.title);
    const bTitleKey = b.titleKey || normalizeDocTitle(b.title);
    if (a.docId && b.docId) return a.docId === b.docId;
    if (a.viewKey && b.viewKey && a.viewKey === b.viewKey) {
      if (!aTitleKey || !bTitleKey) return true;
      return aTitleKey === bTitleKey;
    }
    // Compatibility for assignments made by beta.6/beta.7 before view keys
    // existed. A legacy assignment can still match the current document by
    // title until it is reassigned once under beta.8's stronger identity.
    if ((!a.docId && !a.viewKey) || (!b.docId && !b.viewKey)) {
      return Boolean(aTitleKey && bTitleKey && aTitleKey === bTitleKey);
    }
    return false;
  }

  function scheduleRibbonRefresh() {
    if (ribbonRefreshFrame) cancelAnimationFrame(ribbonRefreshFrame);
    ribbonRefreshFrame = requestAnimationFrame(() => {
      ribbonRefreshFrame = 0;
      refreshRibbonButtons();
    });
  }

  function refreshRibbonButtons() {
    const panel = document.getElementById(RIBBON_PANEL_ID);
    if (!panel) return;
    const api = buttonApi();
    const state = loadReportState(api);
    const currentIdentity = currentDocumentIdentity(api);
    for (const speech of SPEECHES) {
      const button = panel.querySelector(`[data-rt-speech="${speech}"]`);
      if (!(button instanceof HTMLButtonElement)) continue;
      const assignment = state.assignments[speech];
      const assignedHere = Boolean(assignment && sameDocumentIdentity(assignment, currentIdentity));
      button.classList.toggle('cm-rt-assigned', assignedHere);
      button.setAttribute('aria-pressed', assignedHere ? 'true' : 'false');
      if (assignedHere) {
        button.title = `${speech}: current document is assigned — click to clear`;
      } else if (assignment) {
        button.title = `${speech}: assigned to ${assignment.title || 'another document'} — click to assign the current document instead`;
      } else {
        button.title = `Assign current document to ${speech} (Alt-${SPEECHES.indexOf(speech) + 1})`;
      }
    }
  }

  function makeRibbonButton(label, title, onClick, extra = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ribbon-doc-ops-btn cm-rt-ribbon-btn';
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    if (extra.speech) {
      button.dataset.rtSpeech = extra.speech;
      button.setAttribute('aria-pressed', 'false');
    }
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', onClick);
    return button;
  }

  function mountRibbonPanel() {
    ensureStyles();
    const existing = document.getElementById(RIBBON_PANEL_ID);
    if (existing) {
      refreshRibbonButtons();
      return true;
    }
    const customPanel = document.getElementById('custom-ribbon-panel');
    const host = customPanel?.parentElement || document.querySelector('#ribbon .ribbon-left');
    if (!host) return false;

    const panel = document.createElement('div');
    panel.id = RIBBON_PANEL_ID;
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'Round Tools');

    const speechRow = document.createElement('div');
    speechRow.className = 'cm-rt-ribbon-row cm-rt-speech-row';
    for (const speech of SPEECHES) {
      speechRow.appendChild(makeRibbonButton(speech, `Assign current document to ${speech}`, () => {
        assignSpeech(buttonApi(), speech);
        scheduleRibbonRefresh();
      }, { speech }));
    }

    const actionRow = document.createElement('div');
    actionRow.className = 'cm-rt-ribbon-row cm-rt-action-row';

    const contextButton = makeRibbonButton('Round Context', 'Round Context', () => showContextModal(buttonApi()));
    contextButton.classList.add('cm-rt-ribbon-action');
    actionRow.appendChild(contextButton);

    const smartDocButton = makeRibbonButton('Smart Doc', 'Smart Doc', () => showSmartDocModal(buttonApi()));
    smartDocButton.classList.add('cm-rt-ribbon-action');
    actionRow.appendChild(smartDocButton);

    const reportButton = makeRibbonButton('Round Report', 'Round Report (Alt-0)', () => showRoundReportModal(buttonApi()));
    reportButton.classList.add('cm-rt-ribbon-action');
    actionRow.appendChild(reportButton);

    panel.append(speechRow, actionRow);

    if (customPanel && customPanel.parentElement === host) host.insertBefore(panel, customPanel);
    else host.appendChild(panel);
    refreshRibbonButtons();
    return true;
  }

  function closePluginModal() {
    if (!activeOverlay) return;
    const overlay = activeOverlay;
    activeOverlay = null;
    overlay.remove();
    const target = restoreFocusTo;
    restoreFocusTo = null;
    if (target && target.isConnected && typeof target.focus === 'function') {
      try { target.focus(); } catch (_) {}
    }
  }

  function showContextModal(api) {
    closePluginModal();
    ensureStyles();

    const context = readContext(api);
    restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'cm-rt-overlay';
    overlay.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className = 'cm-rt-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'cm-rt-context-title');

    const header = document.createElement('div');
    header.className = 'cm-rt-header';

    const headingWrap = document.createElement('div');
    const title = document.createElement('h2');
    title.id = 'cm-rt-context-title';
    title.className = 'cm-rt-title';
    title.textContent = 'Round Context';
    const subtitle = document.createElement('p');
    subtitle.className = 'cm-rt-subtitle';
    subtitle.textContent = 'Save the round information that Smart Doc and Round Report will reuse.';
    headingWrap.append(title, subtitle);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'cm-rt-close';
    closeButton.setAttribute('aria-label', 'Close Round Context');
    closeButton.textContent = '×';
    closeButton.addEventListener('click', closePluginModal);
    header.append(headingWrap, closeButton);

    const fields = document.createElement('div');
    fields.className = 'cm-rt-fields';

    const controls = {};

    function addTextField(key, label, placeholder, options = {}) {
      const wrapper = document.createElement('label');
      wrapper.className = 'cm-rt-field' + (options.wide ? ' cm-rt-wide' : '');
      const labelNode = document.createElement('span');
      labelNode.className = 'cm-rt-field-label';
      labelNode.textContent = label;
      if (options.optional) {
        const optional = document.createElement('span');
        optional.className = 'cm-rt-optional';
        optional.textContent = ' (optional)';
        labelNode.appendChild(optional);
      }
      const input = document.createElement('input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.placeholder = placeholder;
      input.value = context[key] || '';
      wrapper.append(labelNode, input);
      fields.appendChild(wrapper);
      controls[key] = input;
      return input;
    }

    addTextField('tournamentName', 'Tournament', 'e.g. Harvard');
    addTextField('roundNumber', 'Round', 'e.g. 4 or Octos');
    addTextField('ourTeam', 'Our team', 'e.g. Poly Prep HX');
    addTextField('opponentTeam', 'Opponent team', 'e.g. MBA HL');

    const sideWrapper = document.createElement('label');
    sideWrapper.className = 'cm-rt-field';
    const sideLabel = document.createElement('span');
    sideLabel.className = 'cm-rt-field-label';
    sideLabel.textContent = 'Our side';
    const side = document.createElement('select');
    for (const [value, text] of [['', 'Select side…'], ['AFF', 'AFF'], ['NEG', 'NEG']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      if (value === context.side) option.selected = true;
      side.appendChild(option);
    }
    sideWrapper.append(sideLabel, side);
    fields.appendChild(sideWrapper);
    controls.side = side;

    function updateTeamPlaceholders() {
      if (side.value === 'NEG') {
        controls.ourTeam.placeholder = 'e.g. MBA HL';
        controls.opponentTeam.placeholder = 'e.g. Poly Prep HX';
      } else {
        controls.ourTeam.placeholder = 'e.g. Poly Prep HX';
        controls.opponentTeam.placeholder = 'e.g. MBA HL';
      }
    }
    side.addEventListener('change', updateTeamPlaceholders);
    updateTeamPlaceholders();

    addTextField('judgeName', 'Judge(s)', 'e.g. Mike Li', { optional: true });

    const preview = document.createElement('div');
    preview.className = 'cm-rt-preview';

    function draftContext() {
      return normalizeContext({
        tournamentName: controls.tournamentName.value,
        roundNumber: controls.roundNumber.value,
        ourTeam: controls.ourTeam.value,
        opponentTeam: controls.opponentTeam.value,
        side: controls.side.value,
        judgeName: controls.judgeName.value,
      });
    }

    function updatePreview() {
      const draft = draftContext();
      const teams = deriveTeams(draft);
      const roundLabel = draft.roundNumber ? `Round ${draft.roundNumber}` : 'Round —';
      const matchup = draft.side
        ? `${draft.side}: ${draft.ourTeam || 'our team'} vs. ${draft.opponentTeam || 'opponent'}`
        : `${draft.ourTeam || 'our team'} vs. ${draft.opponentTeam || 'opponent'}`;
      preview.replaceChildren();
      const strong = document.createElement('strong');
      strong.textContent = 'Saved context preview: ';
      preview.appendChild(strong);
      preview.appendChild(document.createTextNode(
        `${draft.tournamentName || 'Tournament —'} · ${roundLabel} · ${matchup}`
      ));
      if (draft.side && teams.affTeam && teams.negTeam) {
        preview.appendChild(document.createElement('br'));
        preview.appendChild(document.createTextNode(`AFF ${teams.affTeam} · NEG ${teams.negTeam}`));
      }
      if (draft.judgeName) {
        preview.appendChild(document.createTextNode(` · Judge(s) ${draft.judgeName}`));
      }
    }

    for (const control of Object.values(controls)) {
      control.addEventListener('input', () => {
        updatePreview();
        if (clearArmed) disarmClear();
      });
      control.addEventListener('change', () => {
        updatePreview();
        if (clearArmed) disarmClear();
      });
    }
    updatePreview();

    const actions = document.createElement('div');
    actions.className = 'cm-rt-actions';

    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'cm-rt-btn cm-rt-clear';
    clearButton.textContent = 'Clear saved context';
    clearButton.hidden = !hasContext(context);
    let clearArmed = false;
    let clearResetTimer = null;

    function disarmClear() {
      clearArmed = false;
      if (clearResetTimer !== null) {
        window.clearTimeout(clearResetTimer);
        clearResetTimer = null;
      }
      clearButton.textContent = 'Clear saved context';
    }

    clearButton.addEventListener('click', () => {
      if (!clearArmed) {
        clearArmed = true;
        clearButton.textContent = 'Click again to clear';
        clearResetTimer = window.setTimeout(disarmClear, 5000);
        return;
      }

      disarmClear();
      clearContext(api);
      controls.tournamentName.value = '';
      controls.roundNumber.value = '';
      controls.ourTeam.value = '';
      controls.opponentTeam.value = '';
      controls.side.value = '';
      controls.judgeName.value = '';
      updatePreview();
      clearButton.hidden = true;
      api.showToast('Round context cleared.');
      requestAnimationFrame(() => {
        try { controls.tournamentName.focus(); } catch (_) {}
      });
    });

    const actionGroup = document.createElement('div');
    actionGroup.className = 'cm-rt-action-group';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'cm-rt-btn';
    cancelButton.textContent = 'Cancel';
    cancelButton.addEventListener('click', closePluginModal);

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'cm-rt-btn cm-rt-primary';
    saveButton.textContent = 'Save';
    saveButton.addEventListener('click', () => {
      const draft = draftContext();
      const missing = [];
      if (!draft.tournamentName) missing.push('Tournament');
      if (!draft.roundNumber) missing.push('Round');
      if (!draft.ourTeam) missing.push('Our team');
      if (!draft.opponentTeam) missing.push('Opponent team');
      if (!draft.side) missing.push('Our side');
      if (missing.length) {
        api.showToast('Please fill in: ' + missing.join(', '));
        return;
      }
      const saved = saveContext(api, draft);
      closePluginModal();
      api.showToast(
        `Round context saved: ${saved.tournamentName} Round ${saved.roundNumber} — ${saved.side} vs. ${saved.opponentTeam}.`
      );
    });

    actionGroup.append(cancelButton, saveButton);
    actions.append(clearButton, actionGroup);

    dialog.append(header, fields, preview, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    activeOverlay = overlay;

    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) closePluginModal();
    });

    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePluginModal();
        return;
      }
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
        event.preventDefault();
        saveButton.click();
      }
    });

    requestAnimationFrame(() => {
      try { controls.tournamentName.focus(); } catch (_) {}
    });
  }

  function contextReady(context) {
    return Boolean(
      context.tournamentName &&
      context.roundNumber &&
      context.ourTeam &&
      context.opponentTeam &&
      context.side
    );
  }

  function smartDocName(context, speech) {
    return `${context.tournamentName} Round ${context.roundNumber}---${speech} vs. ${context.opponentTeam}`;
  }

  function dispatchHostSettingsStorageEvent(oldValue, newValue) {
    try {
      window.dispatchEvent(new StorageEvent('storage', {
        key: HOST_SETTINGS_STORAGE_KEY,
        oldValue,
        newValue,
        storageArea: localStorage,
        url: window.location.href,
      }));
    } catch (err) {
      console.warn('[Round Tools] could not dispatch CardMirror settings refresh:', err);
    }
  }

  function temporarilyUseExactSpeechFilename(api) {
    let originalRaw = null;
    try {
      originalRaw = localStorage.getItem(HOST_SETTINGS_STORAGE_KEY);
      const parsed = originalRaw ? JSON.parse(originalRaw) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('CardMirror settings are not an object');
      }
      if (parsed.speechDocFilenameTemplate === SMART_DOC_FILENAME_TEMPLATE) {
        return () => {};
      }
      const temporary = { ...parsed, speechDocFilenameTemplate: SMART_DOC_FILENAME_TEMPLATE };
      const temporaryRaw = JSON.stringify(temporary);
      localStorage.setItem(HOST_SETTINGS_STORAGE_KEY, temporaryRaw);
      // CardMirror's settings store normally learns about localStorage writes
      // only in OTHER windows. Dispatch the same event locally so the window
      // creating this Smart Doc sees {speech} before the prompt resolves.
      dispatchHostSettingsStorageEvent(originalRaw, temporaryRaw);
    } catch (err) {
      console.warn('[Round Tools] could not temporarily set exact speech filename:', err);
      api.showToast('Smart Doc could not apply its exact filename format.');
      return null;
    }

    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      try {
        const beforeRestore = localStorage.getItem(HOST_SETTINGS_STORAGE_KEY);
        if (originalRaw === null) localStorage.removeItem(HOST_SETTINGS_STORAGE_KEY);
        else localStorage.setItem(HOST_SETTINGS_STORAGE_KEY, originalRaw);
        dispatchHostSettingsStorageEvent(beforeRestore, originalRaw);
      } catch (err) {
        console.warn('[Round Tools] could not restore CardMirror speech filename setting:', err);
      }
    };
  }

  function nativeSpeechPromptParts() {
    const dialogs = Array.from(document.querySelectorAll('.pmd-text-prompt-dialog'));
    for (const dialog of dialogs) {
      if (!(dialog instanceof HTMLElement)) continue;
      const header = dialog.querySelector('.pmd-route-header');
      const input = dialog.querySelector('.pmd-text-prompt-input');
      const ok = dialog.querySelector('.pmd-text-prompt-ok');
      const headerText = header?.textContent?.trim().toLowerCase() || '';
      if (!headerText.includes('speech')) continue;
      if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) continue;
      if (!(ok instanceof HTMLButtonElement)) continue;
      return { input, ok };
    }
    return null;
  }

  function restoreRoundContextIfLost(api, expectedContext) {
    const expected = normalizeContext(expectedContext);
    if (!hasContext(expected)) return;
    let current = emptyContext();
    try { current = readContext(api); } catch (_) {}
    // Smart Doc never intentionally writes Round Context. If CardMirror's
    // create-window flow caused the plugin bag to be observed as empty, put
    // the exact pre-create context back. Never overwrite a different nonempty
    // context that the user may have intentionally saved in another window.
    if (!hasContext(current)) {
      try { api.storage.set(STORAGE_KEY, expected); } catch (err) {
        console.warn('[Round Tools] could not restore Round Context after Smart Doc creation:', err);
      }
    }
  }

  function launchNativeSpeechDocument(api, generatedName, expectedContext) {
    const nativeButton = document.getElementById('speech-new-btn');
    if (!(nativeButton instanceof HTMLButtonElement)) {
      api.showToast('Smart Doc could not find CardMirror\'s New Speech Document command.');
      return;
    }

    let finished = false;
    let timeoutId = null;
    const observer = new MutationObserver(() => tryComplete());

    function cleanup() {
      if (finished) return;
      finished = true;
      observer.disconnect();
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    }

    function tryComplete() {
      if (finished) return false;
      const prompt = nativeSpeechPromptParts();
      if (!prompt) return false;
      prompt.input.value = generatedName;
      prompt.input.dispatchEvent(new Event('input', { bubbles: true }));
      prompt.input.dispatchEvent(new Event('change', { bubbles: true }));
      const restoreFilenameTemplate = temporarilyUseExactSpeechFilename(api);
      if (!restoreFilenameTemplate) {
        cleanup();
        return true;
      }
      cleanup();
      requestAnimationFrame(() => {
        prompt.ok.click();
        // CardMirror reads the filename template immediately after its prompt
        // resolves. Give that continuation a turn, then put the user's global
        // Files setting back exactly as it was.
        window.setTimeout(() => {
          restoreFilenameTemplate();
          restoreRoundContextIfLost(api, expectedContext);
        }, 250);
        window.setTimeout(() => restoreRoundContextIfLost(api, expectedContext), 900);
      });
      return true;
    }

    observer.observe(document.body, { childList: true, subtree: true });
    timeoutId = window.setTimeout(() => {
      if (tryComplete()) return;
      cleanup();
      api.showToast('Smart Doc opened CardMirror\'s speech flow, but could not fill the speech name automatically.');
    }, 1800);

    try {
      nativeButton.click();
      tryComplete();
    } catch (err) {
      cleanup();
      console.warn('[Round Tools] native speech document launch failed:', err);
      api.showToast('Smart Doc could not start CardMirror\'s New Speech Document flow.');
    }
  }

  function showSmartDocModal(api) {
    closePluginModal();
    ensureStyles();

    const context = readContext(api);
    if (!contextReady(context)) {
      api.showToast('Save Round Context before creating a Smart Doc.');
      showContextModal(api);
      return;
    }

    restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const overlay = document.createElement('div');
    overlay.id = SMART_DOC_OVERLAY_ID;
    overlay.className = 'cm-rt-overlay';
    overlay.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className = 'cm-rt-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'cm-rt-smart-doc-title');

    const header = document.createElement('div');
    header.className = 'cm-rt-header';

    const headingWrap = document.createElement('div');
    const title = document.createElement('h2');
    title.id = 'cm-rt-smart-doc-title';
    title.className = 'cm-rt-title';
    title.textContent = 'Smart Doc';
    const subtitle = document.createElement('p');
    subtitle.className = 'cm-rt-subtitle';
    subtitle.textContent = 'Choose the speech. Round Tools will reuse the saved Round Context.';
    headingWrap.append(title, subtitle);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'cm-rt-close';
    closeButton.setAttribute('aria-label', 'Close Smart Doc');
    closeButton.textContent = '×';
    closeButton.addEventListener('click', closePluginModal);
    header.append(headingWrap, closeButton);

    const teams = deriveTeams(context);
    const summary = document.createElement('div');
    summary.className = 'cm-rt-smart-summary';
    summary.textContent = `${context.tournamentName} · Round ${context.roundNumber} · AFF ${teams.affTeam} · NEG ${teams.negTeam}`;
    if (context.judgeName) summary.textContent += ` · Judge(s) ${context.judgeName}`;

    const speechWrapper = document.createElement('label');
    speechWrapper.className = 'cm-rt-field cm-rt-wide';
    const speechLabel = document.createElement('span');
    speechLabel.className = 'cm-rt-field-label';
    speechLabel.textContent = 'Speech';
    const speechSelect = document.createElement('select');
    const defaultSpeech = context.side === 'NEG' ? '1NC' : '1AC';
    for (const speech of SPEECHES) {
      const option = document.createElement('option');
      option.value = speech;
      option.textContent = speech;
      if (speech === defaultSpeech) option.selected = true;
      speechSelect.appendChild(option);
    }
    speechWrapper.append(speechLabel, speechSelect);

    const namePreview = document.createElement('div');
    namePreview.className = 'cm-rt-smart-name';
    const nameLabel = document.createElement('strong');
    nameLabel.textContent = 'Generated speech name: ';
    const nameText = document.createElement('span');
    namePreview.append(nameLabel, nameText);

    const note = document.createElement('p');
    note.className = 'cm-rt-smart-note';
    note.textContent = 'The Smart Doc filename and Pocket heading will use this exact name. CardMirror still controls the file format and default speech folder.';

    function refreshName() {
      nameText.textContent = smartDocName(context, speechSelect.value);
    }
    speechSelect.addEventListener('change', refreshName);
    refreshName();

    const actions = document.createElement('div');
    actions.className = 'cm-rt-actions';
    const actionGroup = document.createElement('div');
    actionGroup.className = 'cm-rt-action-group';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'cm-rt-btn';
    cancelButton.textContent = 'Cancel';
    cancelButton.addEventListener('click', closePluginModal);

    const createButton = document.createElement('button');
    createButton.type = 'button';
    createButton.className = 'cm-rt-btn cm-rt-primary';
    createButton.textContent = 'Create Smart Doc';
    createButton.addEventListener('click', () => {
      const generatedName = smartDocName(context, speechSelect.value);
      closePluginModal();
      launchNativeSpeechDocument(api, generatedName, context);
    });

    actionGroup.append(cancelButton, createButton);
    actions.append(actionGroup);
    dialog.append(header, summary, speechWrapper, namePreview, note, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    activeOverlay = overlay;

    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) closePluginModal();
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePluginModal();
        return;
      }
      if (event.key === 'Enter' && event.target === speechSelect) {
        event.preventDefault();
        createButton.click();
      }
    });

    requestAnimationFrame(() => {
      try { speechSelect.focus(); } catch (_) {}
    });
  }


  function escapeHtml(value) {
    return stringValue(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeFilePart(value) {
    return stringValue(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim();
  }

  function escXml(value) {
    return xmlEsc(value);
  }

  function normalizedRound(value) {
    return stringValue(value).trim().replace(/^round\s*/i, '').trim() || '1';
  }

  function emptyReportState() {
    return { assignments: {}, form: {}, contextUpdatedAt: 0, updatedAt: 0 };
  }

  function normalizeReportState(raw) {
    if (!raw || typeof raw !== 'object') return emptyReportState();
    const assignments = {};
    const source = raw.assignments && typeof raw.assignments === 'object' ? raw.assignments : {};
    for (const speech of SPEECHES) {
      const item = source[speech];
      if (item && typeof item === 'object' && item.json && typeof item.json === 'object') assignments[speech] = item;
    }
    return {
      assignments,
      form: raw.form && typeof raw.form === 'object' ? raw.form : {},
      contextUpdatedAt: Number(raw.contextUpdatedAt) || 0,
      updatedAt: Number(raw.updatedAt) || 0,
    };
  }

  function loadReportState(api) {
    let stored = emptyReportState();
    try { stored = normalizeReportState(api.storage.get(REPORT_STATE_KEY)); } catch (_) {}
    if (!reportStateInitialized || stored.updatedAt > reportState.updatedAt) {
      reportState = stored;
      reportStateInitialized = true;
    }
    return reportState;
  }

  function persistReportState(api, nextState, shouldBroadcast = true) {
    reportState = normalizeReportState(nextState);
    reportState.updatedAt = Number(nextState.updatedAt) || Date.now();
    reportStateInitialized = true;
    try { api.storage.set(REPORT_STATE_KEY, reportState); } catch (err) {
      console.warn('[Round Tools] could not save round report state:', err);
    }
    if (shouldBroadcast && reportChannel) {
      try { reportChannel.postMessage({ type: 'state', sender: REPORT_INSTANCE_ID, state: reportState }); } catch (_) {}
    }
    refreshRibbonButtons();
    return reportState;
  }

  function setupReportChannel() {
    try {
      reportChannel = new BroadcastChannel(REPORT_CHANNEL_NAME);
      reportChannel.addEventListener('message', (event) => {
        const msg = event && event.data;
        if (!msg || msg.sender === REPORT_INSTANCE_ID) return;
        if (msg.type === 'request-state') {
          if (reportStateInitialized) {
            try { reportChannel.postMessage({ type: 'state', sender: REPORT_INSTANCE_ID, state: reportState }); } catch (_) {}
          }
          return;
        }
        if (msg.type === 'state') {
          const remote = normalizeReportState(msg.state);
          if (!reportStateInitialized || remote.updatedAt >= reportState.updatedAt) {
            reportState = remote;
            reportStateInitialized = true;
            refreshRibbonButtons();
          }
        }
      });
      reportChannel.postMessage({ type: 'request-state', sender: REPORT_INSTANCE_ID });
    } catch (_) {
      reportChannel = null;
    }
  }

  function rememberEditorRoot(event) {
    const target = event && event.target;
    if (!(target instanceof Element)) return;
    const root = target.closest('.ProseMirror');
    if (root && root.isConnected) {
      lastFocusedRoot = root;
      scheduleRibbonRefresh();
    }
  }

  function activeEditorRoot() {
    const active = document.activeElement;
    if (active instanceof Element) {
      const root = active.closest('.ProseMirror');
      if (root) return root;
    }
    const focused = document.querySelector('.ProseMirror.ProseMirror-focused');
    if (focused) return focused;
    return lastFocusedRoot && lastFocusedRoot.isConnected ? lastFocusedRoot : null;
  }

  function getActiveRoot() {
    const root = activeEditorRoot();
    if (root && root.isConnected) {
      lastFocusedRoot = root;
      return root;
    }
    const roots = Array.from(document.querySelectorAll('.ProseMirror'));
    if (roots.length === 1) {
      lastFocusedRoot = roots[0];
      return roots[0];
    }
    return null;
  }

  function currentDocTitle(api, root = null) {
    try {
      const info = api?.docInfo?.();
      if (info && info.docTitle) return info.docTitle;
    } catch (_) {}
    const nearby = titleNearRoot(root || getActiveRoot());
    if (nearby) return nearby;
    const chip = document.querySelector('#doc-name-chip-text, #doc-name-chip, .doc-name-chip');
    return stringValue(chip && chip.textContent).trim() || 'Untitled';
  }

  function captureCurrentSnapshot(api) {
    const root = getActiveRoot();
    if (!root) {
      api.showToast('Open or focus a document before assigning a speech.');
      return null;
    }
    const desc = root.pmViewDesc;
    const node = desc && desc.node;
    if (!node || typeof node.toJSON !== 'function') {
      api.showToast('Round Tools could not read the current CardMirror document.');
      return null;
    }
    let info = null;
    try { info = api.docInfo(); } catch (_) {}
    const json = node.toJSON();
    const title = (info && info.docTitle) || currentDocTitle(api, root);
    const titleKey = normalizeDocTitle(title);
    const viewKey = rootIdentityKey(root);
    const provisionalKey = viewKey ? `view:${viewKey}|title:${titleKey}` : `title:${titleKey}`;
    return {
      key: info && info.docId ? 'doc:' + info.docId : provisionalKey,
      provisionalKey,
      docId: info && info.docId ? info.docId : null,
      viewKey,
      titleKey,
      title,
      json,
      capturedAt: Date.now(),
    };
  }

  function assignSpeech(api, speech) {
    const snap = captureCurrentSnapshot(api);
    if (!snap) return;
    const current = loadReportState(api);
    const assignments = { ...current.assignments };
    const existing = assignments[speech];
    const sameDoc = existing && sameDocumentIdentity(existing, snap);
    if (sameDoc) {
      delete assignments[speech];
      persistReportState(api, { ...current, assignments, updatedAt: Date.now() });
      api.showToast(`${speech} assignment cleared.`);
      return;
    }
    for (const other of SPEECHES) {
      if (other === speech) continue;
      const assigned = assignments[other];
      if (assigned && sameDocumentIdentity(assigned, snap)) delete assignments[other];
    }
    assignments[speech] = snap;
    persistReportState(api, { ...current, assignments, updatedAt: Date.now() });
    api.showToast(`${snap.title || 'Document'} assigned to ${speech}.`);
  }

  function reportDefaults(api) {
    const context = readContext(api);
    const state = loadReportState(api);
    const teams = deriveTeams(context);
    const sameContext = context.updatedAt > 0
      ? Number(state.contextUpdatedAt) === Number(context.updatedAt)
      : Number(state.contextUpdatedAt) === 0;
    const oldForm = sameContext ? state.form : {};
    return {
      context,
      state,
      values: {
        tournamentName: context.tournamentName || stringValue(oldForm.tournamentName),
        roundNumber: context.roundNumber || stringValue(oldForm.roundNumber),
        judgeName: context.judgeName || stringValue(oldForm.judgeName),
        affTeam: teams.affTeam || stringValue(oldForm.affTeam),
        negTeam: teams.negTeam || stringValue(oldForm.negTeam),
        affirmative: stringValue(oldForm.affirmative),
        negOff1NC: stringValue(oldForm.negOff1NC),
        negOff2NR: stringValue(oldForm.negOff2NR),
      },
    };
  }
  function markWrap(text, marks) {
    let out = escapeHtml(text);
    for (const mark of (marks || [])) {
      const type = stringValue(mark && mark.type).toLowerCase();
      if (type.includes('strong') || type === 'bold') out = '<strong>' + out + '</strong>';
      else if (type.includes('em') || type === 'italic') out = '<em>' + out + '</em>';
      else if (type.includes('underline')) out = '<u>' + out + '</u>';
      else if (type.includes('strike')) out = '<s>' + out + '</s>';
      else if (type === 'link' && mark.attrs && mark.attrs.href) {
        out = '<a href="' + escapeHtml(mark.attrs.href) + '">' + out + '</a>';
      }
    }
    return out;
  }

  // Render the ProseMirror JSON tree rather than relying only on the rendered
  // DOM. CardMirror uses custom node views for cards, and some of their body
  // content isn't represented in the simple HTML we were previously feeding
  // to the DOCX converter.
  function jsonNodeToHtml(node, depth=0) {
    if (!node) return '';
    if (node.type === 'text') return markWrap(node.text || '', node.marks);

    const children = (node.content || []).map(child => jsonNodeToHtml(child, depth + 1)).join('');
    const type = stringValue(node.type).toLowerCase();

    if (type === 'hard_break' || type === 'hardbreak') return '<br>';
    if (type === 'image') {
      const src = node.attrs && (node.attrs.src || node.attrs.url);
      return src ? '<img src="' + escapeHtml(src) + '">' : '';
    }

    // CardMirror's semantic nodes.
    if (type === 'tag') return '<h4 class="pmd-tag">' + children + '</h4>';
    if (type === 'card') return '<div class="pmd-card">' + children + '</div>';
    if (type === 'card_body' || type === 'cardbody') return '<div class="pmd-card-body">' + children + '</div>';
    if (type === 'undertag') return '<div class="pmd-undertag">' + children + '</div>';
    if (type === 'cite_paragraph' || type === 'citeparagraph') return '<p class="pmd-cite-para">' + children + '</p>';
    if (type === 'analytic_unit' || type === 'analyticunit') return '<p class="pmd-analytic">' + children + '</p>';
    if (type === 'pocket') return '<h1 class="pmd-pocket">' + children + '</h1>';
    if (type === 'hat') return '<h2 class="pmd-hat">' + children + '</h2>';
    if (type === 'block') return '<h3 class="pmd-block">' + children + '</h3>';

    // Common ProseMirror block nodes.
    if (type === 'paragraph' || type === 'p') return '<p>' + children + '</p>';
    if (type === 'heading') {
      const level = Math.min(6, Math.max(1, Number(node.attrs && node.attrs.level) || 2));
      return '<h' + level + '>' + children + '</h' + level + '>';
    }
    if (type === 'bullet_list') return '<ul>' + children + '</ul>';
    if (type === 'ordered_list') return '<ol>' + children + '</ol>';
    if (type === 'list_item') return '<li>' + children + '</li>';
    if (type === 'blockquote') return '<blockquote>' + children + '</blockquote>';
    if (type === 'code_block') return '<pre>' + children + '</pre>';

    // Unknown containers are deliberately retained as divs so we never drop
    // a custom CardMirror node just because the plugin doesn't know its name.
    return children ? '<div data-pm-node="' + escapeHtml(node.type || 'unknown') + '">' + children + '</div>' : '';
  }

  function snapshotSpeechHtml(snapshot) {
    if (!snapshot) return '';
    if (snapshot.json) {
      const rendered = jsonNodeToHtml(snapshot.json);
      if (rendered.trim()) return rendered;
    }
    return stringValue(snapshot.html);
  }


  function crc32(bytes){ let c=0xffffffff; for(let i=0;i<bytes.length;i++){ c^=bytes[i]; for(let k=0;k<8;k++) c=(c>>>1)^((c&1)?0xedb88320:0); } return (~c)>>>0; }
  function zipStore(entries){
    const enc=new TextEncoder(); const locals=[]; const central=[]; let offset=0;
    for(const [name,data0] of entries){
      const nameB=enc.encode(name); const data=data0 instanceof Uint8Array?data0:enc.encode(data0); const crc=crc32(data);
      const h=new Uint8Array(30+nameB.length+data.length); const d=new DataView(h.buffer);
      d.setUint32(0,0x04034b50,true); d.setUint16(4,20,true); d.setUint16(6,0,true); d.setUint16(8,0,true); d.setUint16(10,0,true);
      d.setUint16(12,0,true); d.setUint32(14,crc,true); d.setUint32(18,data.length,true); d.setUint32(22,data.length,true); d.setUint16(26,nameB.length,true); d.setUint16(28,0,true); h.set(nameB,30); h.set(data,30+nameB.length);
      locals.push(h); const centralH=new Uint8Array(46+nameB.length); const c=new DataView(centralH.buffer);
      c.setUint32(0,0x02014b50,true); c.setUint16(4,20,true); c.setUint16(6,20,true); c.setUint16(8,0,true); c.setUint16(10,0,true); c.setUint16(12,0,true); c.setUint16(14,0,true); c.setUint32(16,crc,true); c.setUint32(20,data.length,true); c.setUint32(24,data.length,true); c.setUint16(28,nameB.length,true); c.setUint16(30,0,true); c.setUint16(32,0,true); c.setUint16(34,0,true); c.setUint16(36,0,true); c.setUint32(38,0,true); c.setUint32(42,offset,true); centralH.set(nameB,46); central.push(centralH); offset+=h.length;
    }
    const cdSize=central.reduce((n,x)=>n+x.length,0); const end=new Uint8Array(22); const e=new DataView(end.buffer); e.setUint32(0,0x06054b50,true); e.setUint16(4,0,true); e.setUint16(6,0,true); e.setUint16(8,entries.length,true); e.setUint16(10,entries.length,true); e.setUint32(12,cdSize,true); e.setUint32(16,offset,true); e.setUint16(20,0,true);
    const out=new Uint8Array(offset+cdSize+22); let p=0; for(const x of locals){out.set(x,p);p+=x.length} for(const x of central){out.set(x,p);p+=x.length} out.set(end,p); return out;
  }

  function wordRun(text, opts={}) {
    if (!text) return '';
    let rPr='';
    if (opts.bold) rPr += '<w:b/>';
    if (opts.italic) rPr += '<w:i/>';
    if (opts.underline) rPr += '<w:u w:val="single"/>';
    return '<w:r>'+(rPr?'<w:rPr>'+rPr+'</w:rPr>':'')+'<w:t xml:space="preserve">'+escXml(text)+'</w:t></w:r>';
  }

  function inlineRuns(node, opts={}) {
    if (node.nodeType === Node.TEXT_NODE) return wordRun(node.nodeValue || '', opts);
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el=node; const tag=el.tagName.toLowerCase();
    const next={...opts};
    if (tag==='strong' || tag==='b') next.bold=true;
    if (tag==='em' || tag==='i') next.italic=true;
    if (tag==='u') next.underline=true;
    if (tag==='br') return '<w:br/>';
    return Array.from(el.childNodes).map(n=>inlineRuns(n,next)).join('');
  }

  function wordParagraph(el, style) {
    const runs=inlineRuns(el);
    const pPr=style?'<w:pPr><w:pStyle w:val="'+style+'"/></w:pPr>':'';
    return '<w:p>'+pPr+runs+'</w:p>';
  }

  // Build WordprocessingML directly from the captured ProseMirror JSON.
  // This avoids losing CardMirror's card_body paragraphs when an HTML
  // intermediate is parsed by the lightweight DOCX writer.
  function xmlEsc(v) {
    return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  }

  function markRunProps(marks) {
    const props=[];
    for(const mark of (marks || [])){
      const type=stringValue(mark && mark.type).toLowerCase();
      const attrs=(mark && mark.attrs) || {};
      if(type==='bold') props.push('<w:b/>');
      else if(type==='bold_off') props.push('<w:b w:val="0"/>');
      else if(type==='italic') props.push('<w:i/><w:iCs/>');
      else if(type==='strikethrough' || type==='strike') props.push('<w:strike/>');
      else if(type==='underline_mark' || type==='underline_direct' || type==='underline') props.push('<w:u w:val="single"/>');
      else if(type==='superscript') props.push('<w:vertAlign w:val="superscript"/>');
      else if(type==='subscript') props.push('<w:vertAlign w:val="subscript"/>');
      else if(type==='cite_mark') props.push('<w:rStyle w:val="Style13ptBold"/>');
      else if(type==='emphasis_mark') props.push('<w:rStyle w:val="Emphasis"/>');
      else if(type==='undertag_mark') props.push('<w:rStyle w:val="UndertagChar"/>');
      else if(type==='analytic_mark') props.push('<w:rStyle w:val="AnalyticChar"/>');
      else if(type==='font_size'){
        const hp=Number(attrs.halfPoints ?? 22);
        if(Number.isFinite(hp) && hp>0) props.push('<w:sz w:val="'+Math.round(hp)+'"/><w:szCs w:val="'+Math.round(hp)+'"/>');
      } else if(type==='font_color'){
        const c=stringValue(attrs.color || '000000').replace(/[^0-9a-f]/gi,'').slice(0,6);
        if(c.length===6 && c!=='000000') props.push('<w:color w:val="'+c+'"/>');
      } else if(type==='highlight'){
        const c=stringValue(attrs.color || 'yellow');
        const allowed=new Set(['yellow','green','cyan','magenta','blue','red','darkBlue','darkCyan','darkGreen','darkMagenta','darkRed','darkYellow','darkGray','lightGray','black','none']);
        if(allowed.has(c) && c!=='none') props.push('<w:highlight w:val="'+c+'"/>');
      } else if(type==='shading'){
        const c=stringValue(attrs.color || 'D2D2D2').replace(/[^0-9a-f]/gi,'').slice(0,6);
        if(c.length===6) props.push('<w:shd w:fill="'+c+'"/>');
      } else if(type==='font_family'){
        const n=stringValue(attrs.name);
        if(n) props.push('<w:rFonts w:ascii="'+xmlEsc(n)+'" w:hAnsi="'+xmlEsc(n)+'" w:cs="'+xmlEsc(n)+'"/>');
      }
    }
    return props.length ? '<w:rPr>'+props.join('')+'</w:rPr>' : '';
  }

  function textRunXml(text, marks) {
    const value=stringValue(text);
    if(!value) return '';
    const chunks=value.split('\n');
    let out='';
    chunks.forEach((chunk,i)=>{
      if(i>0) out+='<w:br/>';
      if(!chunk) return;
      out+='<w:r>'+markRunProps(marks)+'<w:t xml:space="preserve">'+xmlEsc(chunk)+'</w:t></w:r>';
    });
    return out;
  }

  function inlineXml(node) {
    if(!node) return '';
    if(node.type==='text') return textRunXml(node.text || '', node.marks);
    if(node.type==='hard_break' || node.type==='hardbreak') return '<w:r><w:br/></w:r>';
    if(node.type==='image'){
      // Preserve a readable placeholder rather than silently dropping an image.
      const alt=(node.attrs && node.attrs.alt) || '[image]';
      return textRunXml('['+alt+']', []);
    }
    return (node.content || []).map(inlineXml).join('');
  }

  let rrBookmarkCounter = 1;
  function paragraphXml(node, styleId) {
    const attrs=(node && node.attrs) || {};
    const pPr=[];
    if(styleId) pPr.push('<w:pStyle w:val="'+xmlEsc(styleId)+'"/>');
    const indent=Number(attrs.indent || 0);
    if(Number.isFinite(indent) && indent>0) pPr.push('<w:ind w:left="'+Math.round(indent)+'"/>');
    if(attrs.alignment) pPr.push('<w:jc w:val="'+xmlEsc(attrs.alignment)+'"/>');

    const structural = styleId === 'Heading1' || styleId === 'Heading2' ||
      styleId === 'Heading3' || styleId === 'Heading4' || styleId === 'Analytic';
    let bookmarkStart = '';
    let bookmarkEnd = '';
    if (structural) {
      const numericId = rrBookmarkCounter++;
      const rawName = stringValue(attrs.id) || ('rr-' + styleId.toLowerCase() + '-' + numericId);
      const bookmarkName = ('pmd-heading-' + rawName).replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 38);
      bookmarkStart = '<w:bookmarkStart w:id="'+numericId+'" w:name="'+xmlEsc(bookmarkName)+'"/>';
      bookmarkEnd = '<w:bookmarkEnd w:id="'+numericId+'"/>';
    }

    return '<w:p>'+(pPr.length?'<w:pPr>'+pPr.join('')+'</w:pPr>':'')+
      bookmarkStart+inlineXml(node)+bookmarkEnd+'</w:p>';
  }

  function jsonNodeToWordXml(node) {
    if(!node) return '';
    const type=stringValue(node.type).toLowerCase();
    const children=node.content || [];

    if(type==='doc') return children.map(jsonNodeToWordXml).join('');
    if(type==='pocket') return paragraphXml(node,'Heading1');
    if(type==='hat') return paragraphXml(node,'Heading2');
    if(type==='block') return paragraphXml(node,'Heading3');
    if(type==='tag') {
      const p=paragraphXml(node,'Heading4');
      return p;
    }
    if(type==='analytic') return paragraphXml(node,'Analytic');
    if(type==='card_body') return paragraphXml(node,'Normal');
    if(type==='cite_paragraph') return paragraphXml(node,'Normal');
    if(type==='undertag') return paragraphXml(node,'Normal');
    if(type==='paragraph') return paragraphXml(node,'Normal');

    if(type==='card' || type==='analytic_unit' || type==='transclusion_ref' || type==='self_ref')
      return children.map(jsonNodeToWordXml).join('');

    if(type==='table'){
      const rows=children.map(row=>{
        const cells=(row.content || []).map(cell=>{
          const paras=(cell.content || []).map(p=>paragraphXml(p,'Normal')).join('');
          return '<w:tc>'+paras+'</w:tc>';
        }).join('');
        return '<w:tr>'+cells+'</w:tr>';
      }).join('');
      return '<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>'+rows+'</w:tbl>';
    }

    // Any unknown block is retained recursively.
    return children.map(jsonNodeToWordXml).join('');
  }

  function htmlToWordBody(html) {
    const doc=new DOMParser().parseFromString(html,'text/html');
    const out=[];
    const walk=(el)=>{
      if (el.nodeType !== Node.ELEMENT_NODE) return;
      const tag=el.tagName.toLowerCase();
      if (tag==='table') {
        const rows=Array.from(el.querySelectorAll(':scope > tbody > tr, :scope > tr'));
        if (rows.length) {
          out.push('<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>');
          for(const tr of rows){
            out.push('<w:tr>');
            for(const cell of Array.from(tr.children)){ out.push('<w:tc>'+wordParagraph(cell)+'</w:tc>'); }
            out.push('</w:tr>');
          }
          out.push('</w:tbl>');
        }
        return;
      }
      const style = tag==='h1' ? 'Heading1' : tag==='h2' ? 'Heading2' : tag==='h3' ? 'Heading3' : tag==='h4' ? 'Heading4' : null;
      const block = new Set(['p','div','li','h1','h2','h3','h4','h5','h6','blockquote','pre']);
      if (block.has(tag)) {
        const hasBlock=Array.from(el.children).some(c=>block.has(c.tagName.toLowerCase()) || c.tagName.toLowerCase()==='table');
        if (!hasBlock || ['h1','h2','h3','h4','h5','h6','p','li','blockquote','pre'].includes(tag)) {
          const text=el.textContent || '';
          if (text.trim() || el.querySelector('br')) out.push(wordParagraph(el, style));
          if (!['div'].includes(tag)) return;
        }
      }
      for(const child of Array.from(el.children)) walk(child);
    };
    for(const child of Array.from(doc.body.children)) walk(child);
    return out.join('');
  }

  function docxFromJson(json, fallbackHtml){
    const body=jsonNodeToWordXml(json) || htmlToWordBody(fallbackHtml || '') || '<w:p/>';
    const documentXml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+body+'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>';
    const rels='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    const styles='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:aliases w:val="Pocket"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="480"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="52"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:aliases w:val="Hat"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="480"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:u w:val="double"/><w:sz w:val="44"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:aliases w:val="Block"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="200"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:u w:val="single"/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:aliases w:val="Tag"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="200"/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Analytic"><w:name w:val="Analytic"/><w:basedOn w:val="Heading4"/><w:pPr><w:outlineLvl w:val="3"/></w:pPr></w:style></w:styles>';
    const ct='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>';
    return zipStore([['[Content_Types].xml',ct],['_rels/.rels',rels],['word/document.xml',documentXml],['word/styles.xml',styles],['word/_rels/document.xml.rels','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>']]);
  }


  async function saveRoundReport(api, data) {
    const state = loadReportState(api);
    const textNode = (text) => ({ type: 'text', text: String(text ?? '') });
    const tagNode = (label, value) => ({
      type: 'tag',
      content: [textNode(label + ': '), textNode(String(value ?? ''))],
    });
    const content = [];
    content.push({
      type: 'pocket',
      content: [textNode(
        `${data.tournamentName} Round ${normalizedRound(data.roundNumber)}---Aff ${data.affTeam} vs. Neg ${data.negTeam}`
      )],
    });
    content.push(tagNode('AFF', data.affTeam));
    content.push(tagNode('NEG', data.negTeam));
    content.push(tagNode('1AC', data.affirmative));
    content.push(tagNode('1NC', data.negOff1NC));
    content.push(tagNode('2NR', data.negOff2NR));
    content.push(tagNode(`Reason for Decision ${data.judgeName}`, ''));

    for (const speech of SPEECHES) {
      content.push({ type: 'pocket', content: [textNode(speech)] });
      const assignment = state.assignments[speech];
      if (assignment && assignment.json && Array.isArray(assignment.json.content)) {
        content.push(...assignment.json.content);
      }
    }

    rrBookmarkCounter = 1;
    const bytes = docxFromJson({ type: 'doc', content }, '');
    const filename = `${escapeFilePart(data.tournamentName)} Round ${escapeFilePart(normalizedRound(data.roundNumber))}---AFF ${escapeFilePart(data.affTeam)} vs. NEG ${escapeFilePart(data.negTeam)}.docx`;
    const bridge = window.electronAPI;
    if (!bridge || typeof bridge.saveAs !== 'function') {
      throw new Error('CardMirror desktop save bridge is unavailable.');
    }
    const result = await bridge.saveAs(filename, bytes, {
      filters: [{ name: 'Microsoft Word (.docx)', extensions: ['docx'] }],
    });
    if (!result) return false;

    const context = readContext(api);
    persistReportState(api, {
      assignments: {},
      form: data,
      contextUpdatedAt: context.updatedAt,
      updatedAt: Date.now(),
    });
    api.showToast(`Round report saved as ${result.name || filename}.`);
    return true;
  }

  function showRoundReportModal(api) {
    closePluginModal();
    ensureStyles();
    const { context, state, values } = reportDefaults(api);
    restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const overlay = document.createElement('div');
    overlay.id = ROUND_REPORT_OVERLAY_ID;
    overlay.className = 'cm-rt-overlay';
    overlay.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className = 'cm-rt-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'cm-rt-report-title');

    const header = document.createElement('div');
    header.className = 'cm-rt-header';
    const headingWrap = document.createElement('div');
    const title = document.createElement('h2');
    title.id = 'cm-rt-report-title';
    title.className = 'cm-rt-title';
    title.textContent = 'Round Report';
    const subtitle = document.createElement('p');
    subtitle.className = 'cm-rt-subtitle';
    subtitle.textContent = 'Review speech assignments and round details, then export a Word round report.';
    headingWrap.append(title, subtitle);
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'cm-rt-close';
    closeButton.setAttribute('aria-label', 'Close Round Report');
    closeButton.textContent = '×';
    closeButton.addEventListener('click', closePluginModal);
    header.append(headingWrap, closeButton);

    const assignmentsPanel = document.createElement('div');
    assignmentsPanel.className = 'cm-rt-assignment-list';
    const assignmentsTitle = document.createElement('div');
    assignmentsTitle.className = 'cm-rt-assignment-title';
    assignmentsTitle.textContent = 'Assigned speech documents';
    assignmentsPanel.appendChild(assignmentsTitle);
    for (const speech of SPEECHES) {
      const row = document.createElement('div');
      row.className = 'cm-rt-assignment-row';
      const label = document.createElement('strong');
      label.textContent = speech;
      const value = document.createElement('span');
      value.textContent = state.assignments[speech]?.title || '—';
      row.append(label, value);
      assignmentsPanel.appendChild(row);
    }

    const fields = document.createElement('div');
    fields.className = 'cm-rt-fields';
    const fieldDefs = [
      ['tournamentName', 'Tournament', 'e.g. Harvard'],
      ['roundNumber', 'Round', 'e.g. 4 or Octos'],
      ['judgeName', 'Judge(s)', 'e.g. Mike Li'],
      ['affTeam', 'AFF team', 'e.g. Poly Prep HX'],
      ['negTeam', 'NEG team', 'e.g. MBA HL'],
      ['affirmative', 'Affirmative name', 'e.g. Single Payer'],
      ['negOff1NC', '1NC positions', 'e.g. Politics DA, States CP, Econ DA'],
      ['negOff2NR', '2NR position(s)', 'e.g. Politics DA, States CP'],
    ];
    const inputs = {};
    for (const [key, labelText, placeholder] of fieldDefs) {
      const field = document.createElement('label');
      field.className = 'cm-rt-field';
      const label = document.createElement('span');
      label.className = 'cm-rt-field-label';
      label.textContent = labelText;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = stringValue(values[key]);
      input.placeholder = placeholder;
      field.append(label, input);
      fields.appendChild(field);
      inputs[key] = input;
    }

    const note = document.createElement('p');
    note.className = 'cm-rt-report-note';
    if (hasContext(context)) {
      note.textContent = 'Tournament, round, judge(s), and AFF/NEG teams are prefilled from Round Context. You can edit them here without changing the saved Round Context.';
    } else {
      note.textContent = 'No Round Context is saved, so fill in the round details here. Saving this report form does not create Round Context.';
    }

    const actions = document.createElement('div');
    actions.className = 'cm-rt-actions';
    const actionGroup = document.createElement('div');
    actionGroup.className = 'cm-rt-action-group';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'cm-rt-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', closePluginModal);
    const exportButton = document.createElement('button');
    exportButton.type = 'button';
    exportButton.className = 'cm-rt-btn cm-rt-primary';
    exportButton.textContent = 'Export Round Report';
    exportButton.addEventListener('click', async () => {
      const data = {};
      const missing = [];
      for (const [key, labelText] of fieldDefs) {
        data[key] = inputs[key].value.trim();
        if (!data[key]) missing.push(labelText);
      }
      if (missing.length) {
        api.showToast(`Please fill in: ${missing.join(', ')}.`);
        return;
      }
      const current = loadReportState(api);
      const contextNow = readContext(api);
      persistReportState(api, {
        ...current,
        form: data,
        contextUpdatedAt: contextNow.updatedAt,
        updatedAt: Date.now(),
      });
      exportButton.disabled = true;
      exportButton.textContent = 'Exporting…';
      try {
        const saved = await saveRoundReport(api, data);
        if (saved) closePluginModal();
      } catch (err) {
        console.error('[Round Tools] Round Report export failed:', err);
        api.showToast(`Round report failed: ${err && err.message ? err.message : String(err)}`);
      } finally {
        exportButton.disabled = false;
        exportButton.textContent = 'Export Round Report';
      }
    });
    actionGroup.append(cancel, exportButton);
    actions.append(actionGroup);

    dialog.append(header, assignmentsPanel, fields, note, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    activeOverlay = overlay;

    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) closePluginModal();
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePluginModal();
      }
    });
    requestAnimationFrame(() => {
      try { inputs.tournamentName.focus(); } catch (_) {}
    });
  }

  document.addEventListener('focusin', rememberEditorRoot, true);
  document.addEventListener('pointerdown', rememberEditorRoot, true);
  setupReportChannel();

  const runtime = {
    destroy() {
      closePluginModal();
      const style = document.getElementById(STYLE_ID);
      if (style) style.remove();
      const ribbonPanel = document.getElementById(RIBBON_PANEL_ID);
      if (ribbonPanel) ribbonPanel.remove();
      const uiToast = document.getElementById(UI_TOAST_ID);
      if (uiToast) uiToast.remove();
      if (uiToastTimer) clearTimeout(uiToastTimer);
      uiToastTimer = null;
      if (ribbonRefreshFrame) cancelAnimationFrame(ribbonRefreshFrame);
      ribbonRefreshFrame = 0;
      document.removeEventListener('focusin', rememberEditorRoot, true);
      document.removeEventListener('pointerdown', rememberEditorRoot, true);
      try { reportChannel?.close?.(); } catch (_) {}
      reportChannel = null;
      if (window[RUNTIME_KEY] === runtime) delete window[RUNTIME_KEY];
    },
    readContext(api) {
      return readContext(api);
    },
  };
  window[RUNTIME_KEY] = runtime;

  window.__registerCardMirrorPlugin?.({
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    apiVersion: 1,
    commands: [
      {
        id: `${PLUGIN_ID}.roundContext`,
        label: 'Round Tools: Round Context',
        keywords: ['round', 'context', 'tournament', 'opponent', 'judge'],
        defaultKey: null,
        run(api) {
          rememberApi(api);
          showContextModal(api);
        },
      },
      {
        id: `${PLUGIN_ID}.smartDoc`,
        label: 'Round Tools: Smart Doc',
        keywords: ['round', 'smart', 'doc', 'speech', '1ac', '1nc', '2ac', '2nc', '1nr', '1ar', '2nr', '2ar'],
        defaultKey: null,
        run(api) {
          rememberApi(api);
          showSmartDocModal(api);
        },
      },
      ...SPEECHES.map((speech, index) => ({
        id: `${PLUGIN_ID}.assign${speech}`,
        label: `Round Tools: Assign ${speech}`,
        keywords: ['round', 'report', 'assign', 'speech', speech.toLowerCase()],
        defaultKey: `Alt-${index + 1}`,
        run(api) {
          rememberApi(api);
          assignSpeech(api, speech);
          refreshRibbonButtons();
        },
      })),
      {
        id: `${PLUGIN_ID}.roundReport`,
        label: 'Round Tools: Round Report',
        keywords: ['round', 'report', 'rr', 'export', 'docx'],
        defaultKey: 'Alt-0',
        run(api) {
          rememberApi(api);
          showRoundReportModal(api);
        },
      },
    ],
  });

  mountRibbonPanel();
})();
