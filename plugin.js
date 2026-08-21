(() => {
  'use strict';

  const PLUGIN_ID = 'cardmirror-round-tools';
  const PLUGIN_NAME = 'Round Tools';
  const STORAGE_KEY = 'roundContext';
  const RUNTIME_KEY = '__cardMirrorRoundToolsRuntime';
  const STYLE_ID = 'cardmirror-round-tools-style';
  const OVERLAY_ID = 'cardmirror-round-tools-context-overlay';

  // Clean up UI from a previous local development load. CardMirror owns command
  // registration; this only prevents duplicate plugin-owned DOM/styles.
  try {
    window[RUNTIME_KEY]?.destroy?.();
  } catch (err) {
    console.warn('[Round Tools] previous runtime cleanup failed:', err);
  }

  let activeOverlay = null;
  let restoreFocusTo = null;

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
      #${OVERLAY_ID} {
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
      #${OVERLAY_ID} .cm-rt-dialog {
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
      #${OVERLAY_ID} .cm-rt-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 16px;
      }
      #${OVERLAY_ID} .cm-rt-title {
        margin: 0;
        font-size: 19px;
        line-height: 1.25;
        font-weight: 700;
      }
      #${OVERLAY_ID} .cm-rt-subtitle {
        margin: 5px 0 0;
        color: var(--pmd-c-text-muted, color-mix(in srgb, currentColor 66%, transparent));
        font-size: 12.5px;
        line-height: 1.4;
      }
      #${OVERLAY_ID} .cm-rt-close {
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
      #${OVERLAY_ID} .cm-rt-close:hover {
        background: color-mix(in srgb, currentColor 9%, transparent);
      }
      #${OVERLAY_ID} .cm-rt-fields {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      #${OVERLAY_ID} .cm-rt-field {
        display: flex;
        flex-direction: column;
        gap: 5px;
        min-width: 0;
      }
      #${OVERLAY_ID} .cm-rt-field.cm-rt-wide {
        grid-column: 1 / -1;
      }
      #${OVERLAY_ID} .cm-rt-field-label {
        font-size: 12px;
        font-weight: 650;
      }
      #${OVERLAY_ID} .cm-rt-optional {
        font-weight: 400;
        opacity: .68;
      }
      #${OVERLAY_ID} input,
      #${OVERLAY_ID} select {
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
      #${OVERLAY_ID} input:focus,
      #${OVERLAY_ID} select:focus {
        border-color: var(--pmd-c-accent, Highlight);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--pmd-c-accent, Highlight) 22%, transparent);
      }
      #${OVERLAY_ID} .cm-rt-preview {
        margin-top: 14px;
        padding: 10px 11px;
        border: 1px solid var(--pmd-c-border, rgba(127,127,127,.35));
        border-radius: 8px;
        background: color-mix(in srgb, currentColor 4%, transparent);
        font-size: 12.5px;
        line-height: 1.45;
      }
      #${OVERLAY_ID} .cm-rt-preview strong { font-weight: 650; }
      #${OVERLAY_ID} .cm-rt-actions {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-top: 18px;
      }
      #${OVERLAY_ID} .cm-rt-action-group {
        display: flex;
        gap: 8px;
        margin-left: auto;
      }
      #${OVERLAY_ID} button.cm-rt-btn {
        min-height: 36px;
        padding: 7px 13px;
        border: 1px solid var(--pmd-c-border, rgba(127,127,127,.48));
        border-radius: 7px;
        background: var(--pmd-c-bg, Canvas);
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      #${OVERLAY_ID} button.cm-rt-btn:hover {
        background: color-mix(in srgb, currentColor 7%, transparent);
      }
      #${OVERLAY_ID} button.cm-rt-primary {
        border-color: var(--pmd-c-accent, Highlight);
        background: var(--pmd-c-accent, Highlight);
        color: var(--pmd-c-accent-contrast, HighlightText);
        font-weight: 650;
      }
      #${OVERLAY_ID} button.cm-rt-clear {
        color: var(--pmd-c-danger, #c0392b);
      }
      @media (max-width: 620px) {
        #${OVERLAY_ID} .cm-rt-fields { grid-template-columns: 1fr; }
        #${OVERLAY_ID} .cm-rt-field.cm-rt-wide { grid-column: auto; }
      }
    `;
    document.head.appendChild(style);
  }

  function closeContextModal() {
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
    closeContextModal();
    ensureStyles();

    const context = readContext(api);
    restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
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
    closeButton.addEventListener('click', closeContextModal);
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
    addTextField('ourTeam', 'Our team', 'e.g. Georgetown BM');
    addTextField('opponentTeam', 'Opponent team', 'e.g. Harvard GS');

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

    addTextField('judgeName', 'Judge', 'e.g. Jane Smith', { optional: true });

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
        preview.appendChild(document.createTextNode(` · Judge ${draft.judgeName}`));
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
    cancelButton.addEventListener('click', closeContextModal);

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
      closeContextModal();
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
      if (event.target === overlay) closeContextModal();
    });

    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeContextModal();
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

  const runtime = {
    destroy() {
      closeContextModal();
      const style = document.getElementById(STYLE_ID);
      if (style) style.remove();
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
          showContextModal(api);
        },
      },
    ],
  });
})();
