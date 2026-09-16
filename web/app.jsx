// Main App — top shell, state management, real storage load/save flow.

const { useState: useStateMain, useEffect: useEffectMain, useMemo: useMemoMain, useRef: useRefMain } = React;

const LS_KEY = "personal-backlog-state-v1";

function loadLocalState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

// Only UI state (expanded rows, tweaks) is persisted locally.
// Backlog data always lives in backlog.md — never in localStorage.
function saveLocalState(expandedMap, tweaks) {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ expandedMap, tweaks })); } catch { /* quota / private mode */ }
}

// Multi-project mode: each project keeps its own UI state under
// LS_KEY + ':' + id. The bare LS_KEY is only ever written by standalone mode.
const ACTIVE_PROJECT_KEY = 'backlog.activeProject';

function loadProjectLocalState(projectId) {
  try {
    const raw = localStorage.getItem(LS_KEY + ':' + projectId);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function saveProjectLocalState(projectId, expandedMap, tweaks) {
  try { localStorage.setItem(LS_KEY + ':' + projectId, JSON.stringify({ expandedMap, tweaks })); } catch { /* quota */ }
}

// Empty starting state — used when there is no saved data and no seed data loaded.
function buildEmptyData() {
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day => ({ day, count: 0 }));
  return {
    entries: [],
    history: [],
    meta: { saved: null, checksum: '—', entryCount: 0, historyCount: 0 },
    health: {
      integrityOk: true, lastSave: null, lastBackup: null,
      masterSize: 0, backupDirSize: 0, backupCount: 0,
      statsSize: 0, historySize: 0, historyOldest: null,
      mode: 'localStorage only',
    },
    stats: {
      createdThisWeek: 0, completedThisWeek: 0, avgInProgressDays: null,
      mostActiveProject: '—',
      completionByDay: days.map(d => ({ ...d })),
      createdByDay:    days.map(d => ({ ...d })),
      statusMix: { open: 0, 'in-progress': 0, blocked: 0, postponed: 0, done: 0, cancelled: 0 },
    },
    backups: [],
  };
}

function App() {
  const [data, setData]             = useStateMain(buildEmptyData);
  const [storageMode, setStorageMode] = useStateMain('local'); // 'api' | 'direct' | 'local'
  const [isLoading, setIsLoading]   = useStateMain(true);
  const [view, setView]             = useStateMain('backlog');
  const [filters, setFilters]       = useStateMain({ statuses: [], priorities: [], tags: [], dueRange: null, scope: 'all', text: '' });
  const [expandedMap, setExpandedMap] = useStateMain(() => loadLocalState()?.expandedMap ?? {});
  const [saveState, setSaveState]   = useStateMain({ status: 'idle', lastSaved: data.health?.lastSave || null });
  const [toast, setToast]           = useStateMain(null);
  const [showWarning, setShowWarning] = useStateMain(false);
  const [importExportOpen, setImportExportOpen] = useStateMain(false);
  const [itemDialog, setItemDialog] = useStateMain(null);
  const [confirm, setConfirm]       = useStateMain(null);
  const [needsConnect, setNeedsConnect] = useStateMain(false);
  const [archiveData, setArchiveData] = useStateMain({ entries: [], history: [] });

  // ---- Multi-project mode state (app server present) ----
  const [appMode, setAppMode]             = useStateMain(null);   // 'multi' | 'standalone' | null (booting)
  const [projects, setProjects]           = useStateMain([]);     // [{id,name,path,default}]
  const [activeProjectId, setActiveProjectId] = useStateMain(null);
  const [docsVersion, setDocsVersion]     = useStateMain(0);      // re-render tick for docsRef mutations
  const [switching, setSwitching]         = useStateMain(false);  // lazy-loading a tab's doc
  const [addProject, setAddProject]       = useStateMain(null);   // {path, name} while dialog open
  const [tabMenu, setTabMenu]             = useStateMain(null);   // {x, y, project}

  const appModeRef         = useRefMain(null);
  const activeProjectIdRef = useRefMain(null);
  const docsRef            = useRefMain(new Map());   // id → {data, checksum, dirty, saving, error, conflict, loaded, savedAt}
  const multiRef           = useRefMain(null);        // {api, poller, backends:Map, timers:Map}
  const pendingLabelsRef   = useRefMain(new Map());   // id → toast label for the in-flight save
  const deleteFilesRef     = useRefMain(false);
  const flushAllDirtyRef   = useRefMain(null);

  const touchDocs = () => setDocsVersion(v => v + 1);

  const TWEAK_DEFAULTS = { accent_hue: 35, density: 'comfortable', show_ids: false, paper_texture: true, status_style: 'color', sort_mode: 'priority', theme: 'system' };
  const [tweaks, setTweak] = useTweaks({ ...TWEAK_DEFAULTS, ...(loadLocalState()?.tweaks ?? {}) });

  // Refs for async callbacks that need latest state without stale closures.
  const latestData        = useRefMain(data);
  const latestExpandedMap = useRefMain(expandedMap);
  const isDirtyRef        = useRefMain(false);
  const saveTimerRef      = useRefMain(null);

  useEffectMain(() => { latestData.current = data; },         [data]);
  useEffectMain(() => { latestExpandedMap.current = expandedMap; }, [expandedMap]);

  useEffectMain(() => {
    document.documentElement.style.setProperty('--accent-hue', tweaks.accent_hue);
    document.documentElement.dataset.density  = tweaks.density;
    document.documentElement.dataset.showIds  = tweaks.show_ids ? 'true' : 'false';
    document.documentElement.dataset.paper    = tweaks.paper_texture ? 'true' : 'false';
  }, [tweaks]);

  useEffectMain(() => {
    const apply = () => {
      const t = tweaks.theme === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : tweaks.theme;
      document.documentElement.dataset.theme = t;
    };
    apply();
    if (tweaks.theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [tweaks.theme]);

  // ---- Storage initialisation (runs once on mount) ----
  useEffectMain(() => {
    let cancelled = false;

    async function initStorage() {
      try {
        const detected = await detectAppMode();
        if (cancelled) return;
        appModeRef.current = detected;
        setAppMode(detected);

        if (detected === 'multi') {
          let multiReady = false;
          try {
            multiReady = await initMulti(() => cancelled);
          } catch (e) {
            showToast('Projects init failed: ' + e.message, 'err');
          }
          if (multiReady) {
            if (!cancelled) setIsLoading(false);
            return;
          }
          if (cancelled) return;
          // Server stopped answering between probes — continue with the
          // standalone detection chain below.
          multiRef.current = null;
          setSwitching(false);
          appModeRef.current = 'standalone';
          setAppMode('standalone');
        }

        const mode = await Storage.detect();
        setStorageMode(mode);

        if (mode === 'local') { setIsLoading(false); return; }

        if (mode === 'browser') {
          if (cancelled) return;
          await applyStorageData(mode, () => cancelled);
          return;
        }

        if (mode === 'direct') {
          // Try silent reconnect — works if permission is still active from a previous session.
          const ok = await Storage.tryAutoConnect();
          if (!ok) {
            // Can't connect without a user gesture — show the connect button instead of blocking.
            setIsLoading(false);
            setNeedsConnect(true);
            return;
          }
        }
        // API mode needs no init — server is already running.

        if (cancelled) return;
        await applyStorageData(mode, () => cancelled);
      } catch (e) {
        if (cancelled) return;
        setStorageMode('local');
        showToast('Storage init failed: ' + e.message, 'err');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    async function applyStorageData(mode, isCancelled) {
      const [raw, backups, sizeInfo] = await Promise.all([
        Storage.load(),
        Storage.listBackups(),
        Storage.getHealthInfo(),
      ]);
      if (isCancelled?.()) return;

      const parsed  = await Parser.parse(raw?.content || '');
      const newData = await buildDataFromStorage(parsed, backups, mode || Storage.mode, sizeInfo);

      if (isCancelled?.()) return;
      setData(newData);

      if (!loadLocalState()?.expandedMap) {
        const em = {};
        walkTree(newData.entries, it => { em[it.id] = !it.collapsed; });
        setExpandedMap(em);
      }

      if (!parsed.checksumOk && parsed.meta) setShowWarning(true);

      SyncPoller.lastChecksum = parsed.meta?.checksum || '';
      SyncPoller.start({
        isDirty: () => isDirtyRef.current,
        onExternalChange: async (kind, freshParsed) => {
          if (kind === 'warn') {
            showToast('File changed externally — you have unsaved edits', 'warn');
          } else if (kind === 'reload' && freshParsed) {
            const [nb, ns] = await Promise.all([Storage.listBackups(), Storage.getHealthInfo()]);
            setData(await buildDataFromStorage(freshParsed, nb, Storage.mode, ns));
            showToast('Reloaded from disk');
          }
        },
      });
    }


    initStorage();
    return () => {
      cancelled = true;
      SyncPoller.stop();
      const m = multiRef.current;
      if (m) {
        m.poller.stop();
        for (const t of m.timers.values()) clearTimeout(t);
        m.timers.clear();
        multiRef.current = null;
      }
    };
  }, []);

  // Persist expanded/collapsed row state and tweaks locally. Data itself lives in backlog.md.
  // Multi mode keeps one such record per project; the bare LS_KEY stays standalone-only.
  useEffectMain(() => {
    if (appModeRef.current === 'multi') {
      if (activeProjectId) saveProjectLocalState(activeProjectId, latestExpandedMap.current, tweaks);
      return;
    }
    saveLocalState(latestExpandedMap.current, tweaks);
  }, [expandedMap, tweaks, activeProjectId]);

  // Multi mode: never lose a background tab's pending edits when the page
  // hides or unloads — fire every dirty project's save immediately.
  useEffectMain(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushAllDirtyRef.current?.(); };
    const onUnload = () => flushAllDirtyRef.current?.();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, []);

  const showToast = (msg, kind = 'ok') => {
    setToast({ msg, kind, t: Date.now() });
    setTimeout(() => setToast(t => (t && Date.now() - t.t >= 2400) ? null : t), 2500);
  };

  // ---- Multi-project mode: per-project load/save/poll lifecycle ----
  // Every project owns its doc record, its backend and its save timer; nothing
  // is keyed by display name and no shared "latest" state is read at save time.

  function getBackend(projectId) {
    const m = multiRef.current;
    if (!m) return createProjectBackend(projectId);
    let b = m.backends.get(projectId);
    if (!b) { b = createProjectBackend(projectId); m.backends.set(projectId, b); }
    return b;
  }

  function applyProjectLocalState(projectId) {
    const st = loadProjectLocalState(projectId);
    setExpandedMap(st?.expandedMap ?? {});
    setTweak({ ...TWEAK_DEFAULTS, ...(st?.tweaks ?? {}) });
  }

  async function loadDoc(projectId) {
    const m = multiRef.current; if (!m) return;
    let doc = docsRef.current.get(projectId);
    if (!doc) {
      doc = { data: null, checksum: '', dirty: false, saving: false, error: false, conflict: false, loaded: false, savedAt: null };
      docsRef.current.set(projectId, doc);
    }
    if (doc.loaded) {
      if (projectId === activeProjectIdRef.current && doc.data) setData(doc.data);
      touchDocs();
      return;
    }
    try {
      const backend = getBackend(projectId);
      const [raw, backups, sizeInfo] = await Promise.all([backend.load(), backend.listBackups(), backend.health()]);
      const parsed  = await Parser.parse(raw?.content || '');
      const newData = await buildDataFromStorage(parsed, backups, 'api', sizeInfo);
      doc.data = newData;
      doc.checksum = raw?.checksum || '';
      doc.loaded = true;
      m.poller.setBaseline(projectId, doc.checksum);
      if (!parsed.checksumOk && parsed.meta && projectId === activeProjectIdRef.current) setShowWarning(true);
      if (projectId === activeProjectIdRef.current) {
        setData(newData);
        if (!loadProjectLocalState(projectId)?.expandedMap) {
          const em = {};
          walkTree(newData.entries, it => { em[it.id] = !it.collapsed; });
          setExpandedMap(em);
        }
      }
    } catch (e) {
      if (projectId === activeProjectIdRef.current) showToast('Load failed: ' + e.message, 'err');
    }
    touchDocs();
  }

  async function initMulti(isCancelled) {
    const api = new ProjectsApi();
    let list;
    try { list = await api.list(); } catch { return false; }
    if (isCancelled?.() || !list?.length) return false;

    const poller = createProjectsPoller(handleExternalChange);
    multiRef.current = { api, poller, backends: new Map(), timers: new Map() };
    setProjects(list);

    const savedId = (() => { try { return localStorage.getItem(ACTIVE_PROJECT_KEY); } catch { return null; } })();
    const fallback = list.find(p => p.default)?.id ?? list[0].id;
    const active = list.some(p => p.id === savedId) ? savedId : fallback;
    activeProjectIdRef.current = active;
    setActiveProjectId(active);
    try { localStorage.setItem(ACTIVE_PROJECT_KEY, active); } catch { /* private mode */ }
    applyProjectLocalState(active);

    setSwitching(true);
    await loadDoc(active);
    setSwitching(false);
    if (isCancelled?.()) return true;
    setStorageMode('api');
    poller.start();
    return true;
  }

  async function switchTab(targetId) {
    const m = multiRef.current;
    if (!m || targetId === activeProjectIdRef.current) return;
    saveProjectLocalState(activeProjectIdRef.current, latestExpandedMap.current, tweaks);
    activeProjectIdRef.current = targetId;
    setActiveProjectId(targetId);
    try { localStorage.setItem(ACTIVE_PROJECT_KEY, targetId); } catch { /* private mode */ }
    applyProjectLocalState(targetId);
    setArchiveData({ entries: [], history: [] });
    const doc = docsRef.current.get(targetId);
    if (doc?.loaded) {
      setData(doc.data);
    } else {
      setSwitching(true);
      setData(buildEmptyData());
      await loadDoc(targetId);
      setSwitching(false);
    }
  }

  function scheduleSave(projectId) {
    const m = multiRef.current; if (!m) return;
    if (m.timers.has(projectId)) clearTimeout(m.timers.get(projectId));
    m.timers.set(projectId, setTimeout(() => {
      m.timers.delete(projectId);
      saveDocNow(projectId);
    }, 600));
  }

  async function saveDocNow(projectId) {
    const m = multiRef.current; if (!m) return;
    const doc = docsRef.current.get(projectId);
    if (!doc?.loaded || !doc.dirty || doc.saving) return;
    doc.saving = true;
    doc.error = false;
    touchDocs();
    try {
      const backend = getBackend(projectId);
      const content = await Parser.serialize({ entries: doc.data.entries, history: doc.data.history });
      const res = await backend.save(content);
      if (!res?.ok) throw new Error(res?.error || 'save failed');
      doc.dirty = false;
      doc.checksum = res.checksum || doc.checksum;
      doc.conflict = false;
      doc.savedAt = new Date().toISOString();
      doc.data = {
        ...doc.data,
        health: { ...doc.data.health, lastSave: doc.savedAt },
        meta:   { ...doc.data.meta,   saved: res.saved || doc.savedAt },
      };
      if (projectId === activeProjectIdRef.current) setData(doc.data);
      m.poller.setBaseline(projectId, doc.checksum);
      const label = pendingLabelsRef.current.get(projectId);
      if (label) {
        pendingLabelsRef.current.delete(projectId);
        if (projectId === activeProjectIdRef.current) showToast(label);
      }
    } catch (e) {
      doc.error = true;
      if (projectId === activeProjectIdRef.current) showToast('Save failed: ' + e.message, 'err');
    } finally {
      doc.saving = false;
      touchDocs();
    }
  }

  function flushAllDirty() {
    if (appModeRef.current !== 'multi') return;
    const m = multiRef.current; if (!m) return;
    for (const [id, doc] of docsRef.current) {
      if (!doc.loaded || !doc.dirty || doc.saving) continue;
      if (m.timers.has(id)) { clearTimeout(m.timers.get(id)); m.timers.delete(id); }
      saveDocNow(id);
    }
  }
  flushAllDirtyRef.current = flushAllDirty;

  function handleExternalChange({ projectId }) {
    const doc = docsRef.current.get(projectId);
    if (!doc?.loaded) return;
    doc.conflict = true;
    touchDocs();
    if (projectId === activeProjectIdRef.current) {
      showToast(doc.dirty ? 'File changed externally — you have unsaved edits' : 'File changed externally', 'warn');
    }
  }

  async function reloadDoc(projectId, { skipConfirm = false } = {}) {
    const doc = docsRef.current.get(projectId);
    if (!doc) return;
    const doReload = async () => {
      const m = multiRef.current; if (!m) return;
      try {
        const backend = getBackend(projectId);
        const [raw, backups, sizeInfo] = await Promise.all([backend.load(), backend.listBackups(), backend.health()]);
        const parsed  = await Parser.parse(raw?.content || '');
        const newData = await buildDataFromStorage(parsed, backups, 'api', sizeInfo);
        doc.data = newData;
        doc.checksum = raw?.checksum || '';
        doc.dirty = false;
        doc.conflict = false;
        doc.error = false;
        doc.loaded = true;
        doc.savedAt = null;
        m.poller.setBaseline(projectId, doc.checksum);
        if (projectId === activeProjectIdRef.current) {
          setData(newData);
          if (!loadProjectLocalState(projectId)?.expandedMap) {
            const em = {};
            walkTree(newData.entries, it => { em[it.id] = !it.collapsed; });
            setExpandedMap(em);
          }
        }
        touchDocs();
        showToast('Reloaded from disk');
      } catch (e) {
        showToast('Reload failed: ' + e.message, 'err');
      }
    };
    if (doc.dirty && !skipConfirm) {
      setConfirm({
        title: 'Reload from disk?',
        danger: true,
        message: <>This project changed on disk while you had unsaved edits.</>,
        detail: <span className="muted">Reloading discards your unsaved edits and takes the on-disk version.</span>,
        confirmLabel: 'Reload',
        onConfirm: () => { setConfirm(null); doReload(); },
      });
    } else {
      await doReload();
    }
  }

  async function syncActiveBaseline() {
    const m = multiRef.current; if (!m) return;
    const id = activeProjectIdRef.current;
    const doc = docsRef.current.get(id);
    if (!doc?.loaded) return;
    try {
      const raw = await getBackend(id).load();
      doc.checksum = raw?.checksum || '';
      doc.dirty = false;
      doc.conflict = false;
      m.poller.setBaseline(id, doc.checksum);
      touchDocs();
    } catch { /* keep previous baseline */ }
  }

  function handleRenameProject(p) {
    const input = window.prompt('Rename project:', p.name);
    if (input == null) return;
    const name = input.trim();
    if (!name || name === p.name) return;
    multiRef.current?.api.rename(p.id, name)
      .then(() => setProjects(ps => ps.map(x => (x.id === p.id ? { ...x, name } : x))))
      .catch(e => showToast('Rename failed: ' + e.message, 'err'));
  }

  function confirmRemoveProject(p) {
    deleteFilesRef.current = false;
    setConfirm({
      title: 'Remove this project?',
      danger: true,
      message: <>Remove <strong>{p.name}</strong> from the project list?</>,
      detail: <RemoveProjectDetail path={p.path} onChange={v => { deleteFilesRef.current = v; }}/>,
      confirmLabel: 'Remove',
      onConfirm: () => { setConfirm(null); doRemoveProject(p.id, deleteFilesRef.current, projects); },
    });
  }

  async function doRemoveProject(projectId, deleteFiles, projectsNow) {
    const m = multiRef.current; if (!m) return;
    try {
      await m.api.remove(projectId, deleteFiles);
    } catch (e) {
      showToast('Remove failed: ' + e.message, 'err');
      return;
    }
    if (m.timers.has(projectId)) { clearTimeout(m.timers.get(projectId)); m.timers.delete(projectId); }
    m.backends.delete(projectId);
    docsRef.current.delete(projectId);
    const remaining = projectsNow.filter(x => x.id !== projectId);
    setProjects(remaining);
    if (!remaining.length) return;
    if (projectId === activeProjectIdRef.current) {
      const next = remaining.find(x => x.default)?.id ?? remaining[0].id;
      activeProjectIdRef.current = next;
      setActiveProjectId(next);
      try { localStorage.setItem(ACTIVE_PROJECT_KEY, next); } catch { /* private mode */ }
      applyProjectLocalState(next);
      setArchiveData({ entries: [], history: [] });
      const doc = docsRef.current.get(next);
      if (doc?.loaded) {
        setData(doc.data);
      } else {
        setSwitching(true);
        setData(buildEmptyData());
        await loadDoc(next);
        setSwitching(false);
      }
    }
    showToast(deleteFiles ? 'Project removed — files deleted' : 'Project removed');
  }

  async function handleAddProject() {
    const m = multiRef.current; if (!m) return;
    let prefill = '';
    try {
      const res = await m.api.pickFolder();
      if (!res?.path) return;
      prefill = res.path;
    } catch {
      // Picker unavailable (no desktop app handle) — fall back to a typed path.
    }
    setAddProject({ path: prefill, name: '' });
  }

  async function submitAddProject() {
    const m = multiRef.current;
    const path = addProject?.path?.trim();
    if (!m || !path) return;
    const name = addProject.name?.trim();
    try {
      const res = await m.api.register(path, name || null);
      const p = res?.project;
      if (!p?.id) throw new Error('no project in response');
      setProjects(ps => [...ps, { id: p.id, name: p.name, path: p.path, default: false }]);
      setAddProject(null);
      await switchTab(p.id);
      showToast('Project added');
    } catch (e) {
      showToast('Add project failed: ' + e.message, 'err');
    }
  }

  // ---- Connect to backlog.md (user-triggered, called from the connect banner) ----
  const handleConnect = async () => {
    try {
      await Storage.connect();
      const [raw, backups, sizeInfo] = await Promise.all([
        Storage.load(),
        Storage.listBackups(),
        Storage.getHealthInfo(),
      ]);
      const parsed  = await Parser.parse(raw?.content || '');
      const newData = await buildDataFromStorage(parsed, backups, Storage.mode, sizeInfo);
      setData(newData);
      if (!loadLocalState()?.expandedMap) {
        const em = {};
        walkTree(newData.entries, it => { em[it.id] = !it.collapsed; });
        setExpandedMap(em);
      }
      if (!parsed.checksumOk && parsed.meta) setShowWarning(true);
      SyncPoller.lastChecksum = parsed.meta?.checksum || '';
      SyncPoller.start({
        isDirty: () => isDirtyRef.current,
        onExternalChange: async (kind, freshParsed) => {
          if (kind === 'warn') {
            showToast('File changed externally — you have unsaved edits', 'warn');
          } else if (kind === 'reload' && freshParsed) {
            const [nb, ns] = await Promise.all([Storage.listBackups(), Storage.getHealthInfo()]);
            setData(await buildDataFromStorage(freshParsed, nb, Storage.mode, ns));
            showToast('Reloaded from disk');
          }
        },
      });
      setNeedsConnect(false);
    } catch (e) {
      showToast('Connect failed: ' + e.message, 'err');
    }
  };

  // ---- Real async save ----
  const triggerSave = (label) => {
    if (appModeRef.current === 'multi') {
      const id = activeProjectIdRef.current;
      const doc = docsRef.current.get(id);
      if (doc?.loaded) { doc.dirty = true; touchDocs(); }
      if (label) pendingLabelsRef.current.set(id, label);
      scheduleSave(id);
      return;
    }
    isDirtyRef.current = true;
    setSaveState(prev => ({ ...prev, status: 'saving' }));
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    saveTimerRef.current = setTimeout(async () => {
      const d  = latestData.current;
      const em = latestExpandedMap.current;
      try {
        if (Storage.isConnected()) {
          const content = await Parser.serialize({ entries: d.entries, history: d.history });
          await Storage.save(content);
          // Keep SyncPoller in sync with our own save to avoid false external-change triggers.
          const cm = content.match(/checksum:\s*(sha256:[a-f0-9]+)/);
          if (cm) SyncPoller.lastChecksum = cm[1];
        }
        saveLocalState(em, tweaks);
        isDirtyRef.current = false;
        const now = new Date().toISOString();
        setSaveState({ status: 'saved', lastSaved: now });
        setData(prev => ({
          ...prev,
          health: { ...prev.health, lastSave: now },
          meta:   { ...prev.meta,   saved: now },
        }));
        if (label) showToast(label);
      } catch (e) {
        setSaveState(prev => ({ ...prev, status: 'error' }));
        showToast('Save failed: ' + e.message, 'err');
      }
    }, 600);
  };

  const mutate = (fn) => {
    const c = structuredClone(latestData.current);
    fn(c);
    latestData.current = c;
    setData(c);
    if (appModeRef.current === 'multi') {
      const doc = docsRef.current.get(activeProjectIdRef.current);
      if (doc) { doc.data = c; doc.dirty = true; }
      touchDocs();
      scheduleSave(activeProjectIdRef.current);
    } else {
      isDirtyRef.current = true;
    }
  };

  // ---- Helpers ----
  function findParentList(items, id, parent = null) {
    for (const it of items) {
      if (it.id === id) return { list: items, parent };
      if (it.children?.length) {
        const r = findParentList(it.children, id, it);
        if (r) return r;
      }
    }
    return null;
  }

  const recentTags = useMemoMain(() => {
    const counts = {};
    walkTree(data.entries, it => (it.tags || []).forEach(t => counts[t] = (counts[t] || 0) + 1));
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [data]);

  // ---- Mutations ----
  const onMutate = {
    setStatus: (id, status) => {
      mutate(d => {
        const it = findItem(d.entries, id);
        if (!it || it.status === status) return;
        d.history.unshift({ timestamp: new Date().toISOString(), itemId: id, action: 'status_changed', details: `${it.status} → ${status}` });
        const wasDone = it.status === 'done';
        it.status = status;
        if (status !== 'blocked') it.reason = null;
        if (status === 'done')                    it.progress = 100;
        else if (wasDone && (it.progress ?? 0) >= 100) it.progress = 75;
      });
      triggerSave();
    },

    setPriority: (id, priority) => {
      mutate(d => {
        const it = findItem(d.entries, id);
        if (!it || it.priority === priority) return;
        d.history.unshift({ timestamp: new Date().toISOString(), itemId: id, action: 'priority_changed', details: `${it.priority} → ${priority}` });
        it.priority = priority;
      });
      triggerSave();
    },

    setProgress: (id, progress) => {
      mutate(d => {
        const it = findItem(d.entries, id);
        if (!it) return;
        const v = snapProgress(progress);
        if ((it.progress ?? 0) === v) return;
        const before = it.progress ?? 0;
        it.progress = v;
        d.history.unshift({ timestamp: new Date().toISOString(), itemId: id, action: 'progress_changed', details: `${before}% → ${v}%` });
      });
      triggerSave();
    },

    moveWithinPriority: (id, dir) => {
      mutate(d => {
        const r = findParentList(d.entries, id);
        if (!r) return;
        const i  = r.list.findIndex(x => x.id === id);
        if (i < 0) return;
        const me = r.list[i];
        let j = i + dir;
        while (j >= 0 && j < r.list.length && r.list[j].priority !== me.priority) j += dir;
        if (j < 0 || j >= r.list.length) return;
        [r.list[i], r.list[j]] = [r.list[j], r.list[i]];
        d.history.unshift({ timestamp: new Date().toISOString(), itemId: id, action: 'item_reordered', details: `moved ${dir < 0 ? 'up' : 'down'}` });
      });
      triggerSave();
    },

    reorder: (draggedId, targetId) => {
      mutate(d => {
        const src = findParentList(d.entries, draggedId);
        const tgt = findParentList(d.entries, targetId);
        if (!src || !tgt || src.list !== tgt.list) return;
        const draggedIdx = src.list.findIndex(x => x.id === draggedId);
        const dragged    = src.list[draggedIdx];
        src.list.splice(draggedIdx, 1);
        const newTargetIdx = tgt.list.findIndex(x => x.id === targetId);
        tgt.list.splice(newTargetIdx, 0, dragged);
        d.history.unshift({ timestamp: new Date().toISOString(), itemId: draggedId, action: 'item_reordered', details: `dropped before ${targetId}` });
      });
      triggerSave('Reordered');
    },

    addChild: (parentId) => setItemDialog({ mode: 'add-child', parentId, initial: null }),
    addRoot:  ()         => setItemDialog({ mode: 'add',       parentId: null, initial: null }),

    editItem: (id) => {
      const it = findItem(data.entries, id);
      if (!it) return;
      setItemDialog({ mode: 'edit', itemId: id, initial: it });
    },

    deleteItem: (id) => {
      const it = findItem(data.entries, id);
      if (!it) return;
      const childCount = (() => { let n = 0; walkTree([it], () => n++); return n - 1; })();
      setConfirm({
        title: 'Delete this item?',
        message: <>Delete <strong>{it.title}</strong>{childCount > 0 ? ` and ${childCount} sub-item${childCount > 1 ? 's' : ''}` : ''}?</>,
        detail: <span className="muted">This will be recorded in the history log.</span>,
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: () => {
          mutate(d => {
            function remove(list) {
              const i = list.findIndex(x => x.id === id);
              if (i >= 0) { list.splice(i, 1); return true; }
              for (const x of list) if (x.children?.length && remove(x.children)) return true;
              return false;
            }
            remove(d.entries);
            d.history.unshift({ timestamp: new Date().toISOString(), itemId: id, action: 'item_deleted', details: `final: ${it.status}` });
          });
          setConfirm(null);
          triggerSave('Deleted');
        },
      });
    },
  };

  const submitItemDialog = (vals) => {
    if (itemDialog.mode === 'edit') {
      mutate(d => {
        const x = findItem(d.entries, itemDialog.itemId);
        if (!x) return;
        const before = { priority: x.priority, status: x.status };
        Object.assign(x, vals);
        if (before.status !== vals.status)
          d.history.unshift({ timestamp: new Date().toISOString(), itemId: x.id, action: 'status_changed', details: `${before.status} → ${vals.status}` });
        if (before.priority !== vals.priority)
          d.history.unshift({ timestamp: new Date().toISOString(), itemId: x.id, action: 'priority_changed', details: `${before.priority} → ${vals.priority}` });
      });
      triggerSave('Saved');
    } else {
      const newId = 'n-' + Math.random().toString(36).slice(2, 8);
      mutate(d => {
        const node = { id: newId, level: 1, ...vals, children: [], collapsed: false };
        if (itemDialog.mode === 'add-child' && itemDialog.parentId) {
          const parent = findItem(d.entries, itemDialog.parentId);
          if (parent) {
            parent.children = parent.children || [];
            node.level = (parent.level || 1) + 1;
            parent.children.push(node);
            setExpandedMap(m => ({ ...m, [parent.id]: true }));
          }
        } else {
          d.entries.push(node);
        }
        d.history.unshift({ timestamp: new Date().toISOString(), itemId: newId, action: 'item_created', details: vals.title });
      });
      triggerSave('Added');
    }
    setItemDialog(null);
  };

  const setExpanded = (id, val) => setExpandedMap(m => ({ ...m, [id]: val }));

  const tagsList = useMemoMain(() => allTags(data.entries),          [data]);
  const counts   = useMemoMain(() => countByStatus(data.entries),    [data]);

  const filtered = useMemoMain(() => {
    const f = { ...filters, text: filters.text?.trim() || '' };
    const noFilters = !f.statuses?.length && !f.priorities?.length && !f.tags?.length && !f.dueRange && !f.text;
    let tree = noFilters ? data.entries : filterTree(data.entries, f);
    tree = structuredClone(tree);
    if (tweaks.sort_mode === 'priority') {
      function sortRecur(list) {
        list.sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority));
        list.forEach(it => it.children?.length && sortRecur(it.children));
      }
      sortRecur(tree);
    }
    if (f.scope === 'top') tree = tree.map(it => ({ ...it, children: [] }));
    return tree;
  }, [data, filters, tweaks.sort_mode]);

  const filteredCount = useMemoMain(() => countAll(filtered),       [filtered]);
  const totalCount    = useMemoMain(() => countAll(data.entries),    [data]);
  const archiveMatchCount = useMemoMain(() => {
    if (!filters.text?.trim()) return 0;
    const q = filters.text.trim().toLowerCase();
    let count = 0;
    walkTree(archiveData.entries, (item) => {
      if (item.title.toLowerCase().includes(q) ||
          item.body?.toLowerCase().includes(q) ||
          item.tags?.some(t => t.toLowerCase().includes(q))) {
        count++;
      }
    });
    return count;
  }, [filters.text, archiveData.entries]);

  // ---- Keyboard shortcuts ----
  useEffectMain(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === '/' && !e.metaKey) { e.preventDefault(); document.querySelector('.search-input')?.focus(); }
      if (e.key === 'g') setView('backlog');
      if (e.key === 'a') setView('admin');
      if (e.key === 'n') onMutate.addRoot();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- Restore from backup ----
  const handleRestore = (b) => {
    setConfirm({
      title:    'Restore this backup?',
      danger:   false,
      message:  <>Overwrite <code className="mono">backlog.md</code> with the contents of this backup.</>,
      detail: (
        <>
          <div className="mono small">{b.name}</div>
          {!b.valid && (
            <div className="restore-warn">
              <Icon name="warn" size={14}/>
              <div>
                <div className="restore-warn-title">Checksum mismatch on this backup</div>
                <div className="restore-warn-body">The file may be partially written or edited externally.</div>
              </div>
            </div>
          )}
        </>
      ),
      confirmLabel: 'Restore',
      onConfirm: async () => {
        setConfirm(null);
        try {
          if (appModeRef.current === 'multi') {
            const id = activeProjectIdRef.current;
            const backend = getBackend(id);
            const result = await backend.restoreBackup(b.name);
            if (!result.ok) throw new Error(result.error || 'Restore failed');
            await reloadDoc(id, { skipConfirm: true });
          } else if (Storage.isConnected()) {
            const result = await Storage.restoreBackup(b.name);
            if (!result.ok) throw new Error(result.error || 'Restore failed');
            const [raw, backups, sizeInfo] = await Promise.all([Storage.load(), Storage.listBackups(), Storage.getHealthInfo()]);
            const parsed  = await Parser.parse(raw?.content || '');
            const newData = await buildDataFromStorage(parsed, backups, storageMode, sizeInfo);
            setData(newData);
            SyncPoller.lastChecksum = parsed.meta?.checksum || '';
            isDirtyRef.current = false;
          }
          showToast(`Restored from ${b.name.slice(0, 28)}…`);
        } catch (e) {
          showToast('Restore failed: ' + e.message, 'err');
        }
      },
    });
  };

  // ---- Import entries from parsed content ----
  const handleImport = ({ entries, history }) => {
    mutate(d => {
      d.entries = entries;
      if (history?.length) d.history = [...history, ...d.history];
      d.history.unshift({ timestamp: new Date().toISOString(), itemId: 'system', action: 'imported', details: `${entries.length} top-level entries` });
    });
    setImportExportOpen(false);
    triggerSave('Imported');
  };

  // ---- Archive functions ----
  const loadArchive = async () => {
    try {
      const raw = appModeRef.current === 'multi'
        ? await getBackend(activeProjectIdRef.current).loadArchive()
        : await Storage.loadArchive();
      if (raw.exists && raw.content) {
        const parsed = await Parser.parse(raw.content);
        setArchiveData({ entries: parsed.entries || [], history: parsed.history || [] });
      }
    } catch (e) {
      console.error('Failed to load archive:', e);
    }
  };

  // Load archive when switching to admin view
  useEffectMain(() => {
    if (view === 'admin') loadArchive();
  }, [view]);

  const handleArchiveItems = async (itemIds) => {
    const now = new Date().toISOString().slice(0, 10);
    const toArchive = [];

    // Build items to archive with restore-path metadata
    for (const id of itemIds) {
      const item = findItem(data.entries, id);
      if (!item) continue;
      const restorePath = getRestorePath(data.entries, id);
      // Deep clone and add archive metadata
      const cloned = JSON.parse(JSON.stringify(item));
      cloned.archived = now;
      cloned.restorePath = restorePath || null;
      toArchive.push(cloned);
    }

    if (toArchive.length === 0) return;

    // Remove from backlog
    const { entries: newEntries } = removeItems([...data.entries], itemIds);

    // Add to archive
    const newArchiveEntries = [...archiveData.entries, ...toArchive];

    // Add history entries
    const newHistory = [...data.history];
    for (const item of toArchive) {
      newHistory.unshift({
        timestamp: new Date().toISOString(),
        itemId: item.id,
        action: 'item_archived',
        details: `moved to archive.md`
      });
    }

    try {
      // Serialize both files
      const backlogContent = await Parser.serialize({ entries: newEntries, history: newHistory });
      const archiveContent = await Parser.serialize({ entries: newArchiveEntries, history: archiveData.history });

      // Save both atomically
      const result = appModeRef.current === 'multi'
        ? await getBackend(activeProjectIdRef.current).saveArchive(backlogContent, archiveContent)
        : await Storage.saveArchive(backlogContent, archiveContent);
      if (!result.ok) throw new Error('Archive failed');

      // Update local state
      if (appModeRef.current === 'multi') {
        const doc = docsRef.current.get(activeProjectIdRef.current);
        const nd = { ...latestData.current, entries: newEntries, history: newHistory };
        if (doc) doc.data = nd;
        latestData.current = nd;
        setData(nd);
      } else {
        setData(d => ({ ...d, entries: newEntries, history: newHistory }));
      }
      setArchiveData({ entries: newArchiveEntries, history: archiveData.history });
      if (appModeRef.current === 'multi') await syncActiveBaseline();
      else isDirtyRef.current = false;

      showToast(`Archived ${toArchive.length} item${toArchive.length > 1 ? 's' : ''}`);
    } catch (e) {
      showToast('Archive failed: ' + e.message, 'err');
    }
  };

  const handleRestoreItems = async (itemIds) => {
    const toRestore = [];
    const remainingArchive = [];

    // Find items to restore
    for (const item of archiveData.entries) {
      if (itemIds.includes(item.id)) {
        toRestore.push(item);
      } else {
        remainingArchive.push(item);
      }
    }

    if (toRestore.length === 0) return;

    // Restore to backlog
    const newEntries = [...data.entries];
    const warnings = [];
    for (const item of toRestore) {
      const restorePath = item.restorePath;
      // Clear archive metadata
      delete item.archived;
      delete item.restorePath;
      // Try to insert at original location
      const inserted = insertAtPath(newEntries, item, restorePath);
      if (!inserted) {
        warnings.push(item.title);
      }
    }

    // Add history entries
    const newHistory = [...data.history];
    for (const item of toRestore) {
      newHistory.unshift({
        timestamp: new Date().toISOString(),
        itemId: item.id,
        action: 'item_restored',
        details: `restored from archive`
      });
    }

    try {
      // Serialize both files
      const backlogContent = await Parser.serialize({ entries: newEntries, history: newHistory });
      const archiveContent = await Parser.serialize({ entries: remainingArchive, history: archiveData.history });

      // Save both atomically
      const result = appModeRef.current === 'multi'
        ? await getBackend(activeProjectIdRef.current).restoreFromArchive(backlogContent, archiveContent)
        : await Storage.restoreFromArchive(backlogContent, archiveContent);
      if (!result.ok) throw new Error('Restore failed');

      // Update local state
      if (appModeRef.current === 'multi') {
        const doc = docsRef.current.get(activeProjectIdRef.current);
        const nd = { ...latestData.current, entries: newEntries, history: newHistory };
        if (doc) doc.data = nd;
        latestData.current = nd;
        setData(nd);
      } else {
        setData(d => ({ ...d, entries: newEntries, history: newHistory }));
      }
      setArchiveData({ entries: remainingArchive, history: archiveData.history });
      if (appModeRef.current === 'multi') await syncActiveBaseline();
      else isDirtyRef.current = false;

      let msg = `Restored ${toRestore.length} item${toRestore.length > 1 ? 's' : ''}`;
      if (warnings.length) msg += ` (${warnings.length} to root - parent not found)`;
      showToast(msg);
    } catch (e) {
      showToast('Restore failed: ' + e.message, 'err');
    }
  };

  const activeDoc = (appMode === 'multi' && activeProjectId) ? docsRef.current.get(activeProjectId) : null;
  const multiSaveStatus = !activeDoc
    ? 'idle'
    : activeDoc.error ? 'error'
    : (activeDoc.saving || activeDoc.dirty) ? 'saving'
    : activeDoc.loaded ? 'saved' : 'idle';
  const multiSaveLabel = !activeDoc ? '…'
    : (activeDoc.saving || activeDoc.dirty) ? 'Saving…'
    : activeDoc.error ? 'Save failed'
    : `Saved · ${fmtTimestamp(activeDoc.savedAt || activeDoc.data?.health?.lastSave || null)}`;
  const headerSaveState = appMode === 'multi'
    ? { status: multiSaveStatus, lastSaved: activeDoc?.savedAt || activeDoc?.data?.health?.lastSave || null }
    : saveState;
  const saveLabel  = appMode === 'multi' ? multiSaveLabel
                   : saveState.status === 'saving' ? 'Saving…'
                   : saveState.status === 'error'  ? 'Save failed'
                   : `Saved · ${fmtTimestamp(saveState.lastSaved)}`;
  const hasFilters = filters.text || filters.statuses?.length || filters.priorities?.length || filters.tags?.length || filters.dueRange;

  if (isLoading || switching) {
    return (
      <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <div style={{ textAlign: 'center', color: 'var(--ink-3)' }}>
          <div style={{ fontSize: 22, marginBottom: 8 }}>Loading…</div>
          <div style={{ fontSize: 13 }}>{switching && !isLoading ? 'Opening project' : 'Connecting to storage'}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <StatusStyleContext.Provider value={tweaks.status_style}>
      <Header
        view={view} setView={setView}
        saveState={headerSaveState} saveLabel={saveLabel}
        storageMode={storageMode}
        searchValue={filters.text}
        onSearch={(v) => setFilters({ ...filters, text: v })}
        onForceSave={() => triggerSave('Saved manually')}
        onOpenImportExport={() => setImportExportOpen(true)}
        theme={tweaks.theme}
        onSetTheme={(t) => setTweak('theme', t)}
      />

      {appMode === 'multi' && (
        <TabBar
          projects={projects}
          activeProjectId={activeProjectId}
          getDocState={id => docsRef.current.get(id)}
          onSelect={switchTab}
          onAdd={handleAddProject}
          onTabMenu={(e, p) => { e.preventDefault(); setTabMenu({ x: e.clientX, y: e.clientY, project: p }); }}
        />
      )}

      {appMode === 'multi' && activeDoc?.conflict && (
        <div className="banner warn" style={{gap:8}}>
          <Icon name="warn" size={14}/>
          <span>
            {activeDoc.dirty
              ? <>Changed on disk while you have unsaved edits — reloading discards them; your next save overwrites the file.</>
              : <>This project changed on disk.</>}
          </span>
          <button className="btn-primary" style={{marginLeft:'auto',flexShrink:0,fontSize:12,padding:'3px 10px'}}
            onClick={() => reloadDoc(activeProjectId)}>Reload from disk</button>
          <button className="banner-close" onClick={() => { activeDoc.conflict = false; touchDocs(); }}>dismiss</button>
        </div>
      )}

      {storageMode === 'local' && (
        <div className="banner warn" style={{gap:8}}>
          <Icon name="warn" size={14}/>
          <span>
            This browser can't access local files directly — <strong>changes won't be saved.</strong>{' '}
            Open in Chrome or Edge to save without a server, or run{' '}
            <code className="mono">python3 server/server.py</code> for any browser.
          </span>
        </div>
      )}

      {storageMode === 'browser' && (
        <div className="banner info" style={{gap:8}}>
          <Icon name="folder" size={14}/>
          <span>
            Data saved in <strong>browser storage</strong> — persists until you clear site data.{' '}
            Use <em>Import/Export</em> to back up to a file.
          </span>
        </div>
      )}

      {needsConnect && (
        <div className="banner info">
          <Icon name="folder" size={14}/>
          No <code className="mono">backlog.md</code> connected — grant one-time folder access, then reloads are silent.
          <button className="btn-primary" style={{marginLeft:'auto',flexShrink:0,fontSize:12,padding:'3px 10px'}}
            onClick={handleConnect}>Open folder…</button>
        </div>
      )}

      {showWarning && (
        <div className="banner warn">
          <Icon name="warn" size={14}/>
          File was edited outside the app — checksum mismatch. The next save will rewrite a correct marker.
          <button className="banner-close" onClick={() => setShowWarning(false)}>dismiss</button>
        </div>
      )}

      {view === 'backlog' ? (
        <div className="main">
          <FilterPanel filters={filters} setFilters={setFilters} tagsList={tagsList} counts={counts}/>
          <section className="content">
            <div className="content-sticky">
              <div className="content-head">
                <div>
                  <div className="eyebrow">Backlog</div>
                  <h1 className="content-title">
                    {hasFilters ? (
                      <>
                        {filteredCount} of {totalCount} items
                        {archiveMatchCount > 0 && <> · {archiveMatchCount} in archive</>}
                      </>
                    ) : (
                      <>{totalCount} items</>
                    )}
                  </h1>
                </div>
                <div className="content-head-actions">
                  <div className="seg seg-mini" title="Order">
                    <button className={`seg-btn ${tweaks.sort_mode === 'priority' ? 'active' : ''}`}
                      onClick={() => setTweak('sort_mode', 'priority')}>By priority</button>
                    <button className={`seg-btn ${tweaks.sort_mode === 'manual' ? 'active' : ''}`}
                      onClick={() => setTweak('sort_mode', 'manual')}>Manual</button>
                  </div>
                  <button className="btn-primary" onClick={onMutate.addRoot}>
                    <Icon name="plus" size={12}/> New item
                  </button>
                </div>
              </div>

              <ViewChips filters={filters} setFilters={setFilters}/>

              <div className="legend">
                <span className="legend-cap">Status:</span>
                {STATUSES.map(s => (
                  <span key={s.key} className="legend-item">
                    <StatusIcon status={s.key} size={13}/>
                    <span>{s.label}</span>
                  </span>
                ))}
                <span className="legend-sep">·</span>
                <span className="legend-hint">
                  {tweaks.sort_mode === 'manual' ? <>Drag rows to reorder · </> : <>Auto-sorted by priority · drag/arrows reorder within priority · </>}
                  <kbd>/</kbd> search · <kbd>n</kbd> new
                </span>
              </div>
            </div>

            <div className="content-scroll">
              {filtered.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-glyph">∅</div>
                  <div>{hasFilters ? 'No items match these filters.' : 'No items yet. Press n or click "+ New item" to start.'}</div>
                </div>
              ) : (
                <BacklogTree
                  items={filtered}
                  expandedMap={expandedMap}
                  setExpanded={setExpanded}
                  onMutate={onMutate}
                  query={filters.text?.trim() || ''}
                  statusStyle={tweaks.status_style}
                  manualOrder={tweaks.sort_mode === 'manual'}
                />
              )}
              {filters.text?.trim() && (
                <ArchiveSearchResults
                  query={filters.text.trim()}
                  archiveEntries={archiveData.entries}
                  onRestore={handleRestoreItems}
                  onLoadArchive={loadArchive}
                  onView={(item) => setItemDialog({ mode: 'view', initial: item })}
                />
              )}
            </div>
          </section>
        </div>
      ) : (
        <AdminPage
          data={data}
          history={data.history}
          tweaks={tweaks}
          setTweak={setTweak}
          onClose={() => setView('backlog')}
          onForceSave={() => triggerSave('Force-saved')}
          onForceBackup={() => triggerSave('Force-backed up')}
          onCompact={() => {
            mutate(d => {
              if (d.history.length > 200) d.history = d.history.slice(0, 200);
            });
            triggerSave('History compacted');
          }}
          onRestore={handleRestore}
          onDownloadBackup={(name) => {
            if (Storage.mode === 'api') {
              const a = document.createElement('a');
              a.href     = `/api/backups/${encodeURIComponent(name)}`;
              a.download = name;
              a.click();
            } else {
              showToast(`${name.slice(0, 28)}… — download not available in direct mode`);
            }
          }}
          archiveData={archiveData}
          onArchiveItems={handleArchiveItems}
          onRestoreItems={handleRestoreItems}
          onViewItem={(item) => setItemDialog({ mode: 'view', initial: item })}
        />
      )}

      <ItemDialog
        open={!!itemDialog}
        mode={itemDialog?.mode}
        initial={itemDialog?.initial}
        recentTags={recentTags}
        onClose={() => setItemDialog(null)}
        onSubmit={submitItemDialog}
      />

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title}
        message={confirm?.message}
        detail={confirm?.detail}
        confirmLabel={confirm?.confirmLabel}
        danger={confirm?.danger}
        onCancel={() => setConfirm(null)}
        onConfirm={confirm?.onConfirm}
      />

      <ImportExportDialog
        open={importExportOpen}
        data={data}
        storageMode={storageMode}
        onClose={() => setImportExportOpen(false)}
        onImport={handleImport}
      />

      {appMode === 'multi' && (
        <AddProjectDialog
          open={!!addProject}
          path={addProject?.path || ''}
          name={addProject?.name || ''}
          onPath={(v) => setAddProject(ap => ({ path: v, name: ap?.name || '' }))}
          onName={(v) => setAddProject(ap => ({ path: ap?.path || '', name: v }))}
          onCancel={() => setAddProject(null)}
          onSubmit={submitAddProject}
        />
      )}

      {tabMenu && (
        <TabContextMenu
          x={tabMenu.x} y={tabMenu.y} project={tabMenu.project}
          onClose={() => setTabMenu(null)}
          onRename={handleRenameProject}
          onRemove={confirmRemoveProject}
        />
      )}

      {toast && (
        <div className={`toast ${toast.kind}`}><Icon name="check" size={12}/> {toast.msg}</div>
      )}

      <TweaksPanel title="Tweaks">
        <TweakSection title="Theme">
          <TweakRadio label="Appearance"
            value={tweaks.theme}
            options={[
              { value: 'light',  label: 'Light'  },
              { value: 'dark',   label: 'Dark'   },
              { value: 'system', label: 'System' },
            ]}
            onChange={v => setTweak('theme', v)}/>
        </TweakSection>
        <TweakSection title="Status icons">
          <TweakRadio label="Style"
            value={tweaks.status_style}
            options={[
              { value: 'flat',  label: 'Flat'  },
              { value: 'ascii', label: 'ASCII' },
              { value: 'color', label: 'Color' },
              { value: 'emoji', label: 'Emoji' },
            ]}
            onChange={v => setTweak('status_style', v)}/>
        </TweakSection>
        <TweakSection title="Order">
          <TweakRadio label="Sort"
            value={tweaks.sort_mode}
            options={[
              { value: 'priority', label: 'By priority' },
              { value: 'manual',   label: 'Manual'      },
            ]}
            onChange={v => setTweak('sort_mode', v)}/>
        </TweakSection>
        <TweakSection title="Accent">
          <TweakSlider label="Hue" value={tweaks.accent_hue} min={0} max={360} step={1}
            onChange={v => setTweak('accent_hue', v)} formatValue={v => `${v}°`}/>
        </TweakSection>
        <TweakSection title="Layout">
          <TweakRadio label="Density"
            value={tweaks.density}
            options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]}
            onChange={v => setTweak('density', v)}/>
          <TweakToggle label="Paper texture" checked={tweaks.paper_texture} onChange={v => setTweak('paper_texture', v)}/>
        </TweakSection>
        <TweakSection title="Demo">
          <TweakButton label="Show checksum-mismatch banner"   onClick={() => setShowWarning(true)}/>
          <TweakButton label="Simulate external file change"   onClick={() => showToast('File reloaded from disk')}/>
          {window.SEED_DATA && (
            <TweakButton label="Load sample / test data" onClick={() => {
              const seed = structuredClone(window.SEED_DATA);
              const defaults = { done: 100, cancelled: 0, 'in-progress': 50, blocked: 25, postponed: 25, open: 0 };
              walkTree(seed.entries, it => {
                if (typeof it.progress !== 'number') it.progress = defaults[it.status] ?? 0;
                else if (it.status === 'done') it.progress = 100;
              });
              setData(seed);
              const em = {};
              walkTree(seed.entries, it => { em[it.id] = !it.collapsed; });
              setExpandedMap(em);
              showToast('Sample data loaded');
            }}/>
          )}
        </TweakSection>
      </TweaksPanel>
      </StatusStyleContext.Provider>
    </div>
  );
}

// ----- Project tab bar (multi mode) -----
function TabBar({ projects, activeProjectId, getDocState, onSelect, onAdd, onTabMenu }) {
  return (
    <div className="tabs" role="tablist" aria-label="Projects"
      style={{ gap: 2, padding: '6px 24px', borderBottom: '1px solid var(--rule)', alignItems: 'center', overflowX: 'auto' }}>
      {projects.map(p => {
        const st = getDocState(p.id) || {};
        const active = p.id === activeProjectId;
        return (
          <button key={p.id}
            role="tab"
            aria-selected={active}
            className={`tab ptab ${active ? 'active' : ''}`}
            data-project-id={p.id}
            data-dirty={st.dirty ? 'true' : 'false'}
            data-conflict={st.conflict ? 'true' : 'false'}
            title={p.path}
            onClick={() => onSelect(p.id)}
            onContextMenu={(e) => onTabMenu(e, p)}>
            <span>{p.name}</span>
            {st.dirty && <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--accent)' }} title="Unsaved changes">●</span>}
            {st.conflict && <span style={{ marginLeft: 4, fontSize: 10, color: '#b45309' }} title="Changed externally">⚠</span>}
          </button>
        );
      })}
      <button className="tab ptab-add" onClick={onAdd} title="Add project" aria-label="Add project">+</button>
    </div>
  );
}

function TabContextMenu({ x, y, project, onClose, onRename, onRemove }) {
  const ref = useRefMain(null);
  const [pos, setPos] = useStateMain({ left: x, top: y });

  useEffectMain(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    let left = x, top = y;
    if (left + r.width  > window.innerWidth  - pad) left = Math.max(pad, window.innerWidth  - r.width  - pad);
    if (top  + r.height > window.innerHeight - pad) top  = Math.max(pad, window.innerHeight - r.height - pad);
    setPos({ left, top });
  }, [x, y]);

  useEffectMain(() => {
    const close = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [onClose]);

  return ReactDOM.createPortal(
    <div ref={ref} role="menu" aria-label="Project actions"
      style={{
        position: 'fixed', left: pos.left, top: pos.top, zIndex: 150,
        display: 'flex', flexDirection: 'column', minWidth: 160,
        background: 'var(--paper)', border: '1px solid var(--rule)',
        borderRadius: 'var(--radius)', padding: 4,
        boxShadow: '0 6px 24px oklch(0.22 0.012 60 / 0.18)',
      }}>
      <button role="menuitem" style={tabMenuItemStyle}
        onClick={() => { onClose(); onRename(project); }}>Rename…</button>
      <button role="menuitem" style={{ ...tabMenuItemStyle, color: '#b3261e' }}
        onClick={() => { onClose(); onRemove(project); }}>Remove…</button>
    </div>,
    document.body
  );
}

const tabMenuItemStyle = {
  textAlign: 'left', border: 0, background: 'transparent',
  padding: '7px 10px', borderRadius: 'var(--radius)',
  fontSize: 13, color: 'var(--ink)', cursor: 'pointer',
};

function RemoveProjectDetail({ path, onChange }) {
  const [deleteFiles, setDeleteFiles] = useStateMain(false);
  return (
    <div>
      <div className="mono small">{path}</div>
      <label style={{ display: 'flex', gap: 7, alignItems: 'center', marginTop: 8, fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox" checked={deleteFiles}
          onChange={(e) => { setDeleteFiles(e.target.checked); onChange(e.target.checked); }}/>
        Also delete files on disk (backlog.md, archive.md, backups/)
      </label>
    </div>
  );
}

function AddProjectDialog({ open, path, name, onPath, onName, onCancel, onSubmit }) {
  return (
    <Dialog open={open} onClose={onCancel} width={480} labelledBy="dlg-addproj-title">
      <DialogHeader id="dlg-addproj-title" eyebrow="Projects" title="Add project" onClose={onCancel}/>
      <div className="dlg-body">
        <div className="field">
          <label className="field-label">Path <span className="field-hint">folder or backlog.md file</span></label>
          <input className="text-input" value={path} onChange={(e) => onPath(e.target.value)}
            placeholder="/path/to/project (or /path/to/backlog.md)" autoFocus/>
        </div>
        <div className="field">
          <label className="field-label">Name <span className="field-hint">optional — defaults to the file name</span></label>
          <input className="text-input" value={name} onChange={(e) => onName(e.target.value)}
            placeholder="Project name"/>
        </div>
      </div>
      <div className="dlg-foot">
        <span className="dlg-hint">Registering a folder creates backlog.md there if missing.</span>
        <div className="dlg-foot-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn-primary" onClick={onSubmit} disabled={!path.trim()}>Add project</button>
        </div>
      </div>
    </Dialog>
  );
}

// ----- View chips (saved searches) -----
const VIEW_CHIPS = [
  { key: 'all',     label: 'All',         statuses: [] },
  { key: 'open',    label: 'Open',        statuses: ['open'] },
  { key: 'wip',     label: 'In progress', statuses: ['in-progress'] },
  { key: 'active',  label: 'Active',      statuses: ['open', 'in-progress', 'blocked', 'postponed'], hint: 'everything not done or cancelled' },
  { key: 'blocked', label: 'Blocked',     statuses: ['blocked'] },
  { key: 'closed',  label: 'Closed',      statuses: ['done', 'cancelled'], hint: 'done + cancelled' },
];

function ViewChips({ filters, setFilters }) {
  const cur = filters.statuses || [];
  const same = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  const activeKey = VIEW_CHIPS.find(v => same(v.statuses, cur))?.key;
  return (
    <div className="view-chips" role="tablist" aria-label="Saved views">
      {VIEW_CHIPS.map(v => (
        <button key={v.key}
          role="tab"
          aria-selected={activeKey === v.key}
          className={`view-chip ${activeKey === v.key ? 'active' : ''}`}
          title={v.hint || v.label}
          onClick={() => setFilters({ ...filters, statuses: v.statuses })}>
          {v.label}
        </button>
      ))}
    </div>
  );
}

// ----- Header -----
const THEME_CYCLE = { system: 'light', light: 'dark', dark: 'system' };
const THEME_META  = { system: { icon: 'monitor', label: 'System' }, light: { icon: 'sun', label: 'Light' }, dark: { icon: 'moon', label: 'Dark' } };

function Header({ view, setView, saveState, saveLabel, storageMode, searchValue, onSearch, onOpenImportExport, theme, onSetTheme }) {
  const themeMeta = THEME_META[theme] || THEME_META.system;
  const modeIcon = storageMode === 'api' ? '⚡' : storageMode === 'direct' ? '📁' : storageMode === 'browser' ? '🌐' : '💾';
  return (
    <header className="header">
      <div className="brand">
        <span className="brand-glyph"><StatusIcon status="in-progress" size={16}/></span>
        <span className="brand-name">backlog</span>
        <span className="brand-sub mono" title={`Storage: ${storageMode}`}>backlog.md {modeIcon}</span>
      </div>

      <nav className="tabs">
        <button className={`tab ${view === 'backlog' ? 'active' : ''}`} onClick={() => setView('backlog')}>
          <Icon name="list" size={13}/> Backlog
        </button>
        <button className={`tab ${view === 'admin' ? 'active' : ''}`} onClick={() => setView('admin')}>
          <Icon name="cog" size={13}/> Admin
        </button>
      </nav>

      <div className="search-wrap">
        <Icon name="search" size={14}/>
        <input className="search-input"
          placeholder="Search titles, tags, reasons…  ( / )"
          value={searchValue}
          onChange={(e) => onSearch(e.target.value)}/>
        {searchValue && <button className="search-clear" onClick={() => onSearch('')}>×</button>}
      </div>

      <div className="header-right">
        <button className="header-btn" onClick={() => onSetTheme(THEME_CYCLE[theme] || 'system')}
          title={`Theme: ${themeMeta.label} — click to switch`} aria-label={`Theme: ${themeMeta.label}`}>
          <Icon name={themeMeta.icon} size={13}/> {themeMeta.label}
        </button>
        <button className="header-btn" onClick={onOpenImportExport} title="Import / Export">
          <Icon name="archive" size={13}/> Import/Export
        </button>
        <div className={`save-indicator ${saveState.status}`}>
          <span className={`save-dot ${saveState.status}`}/>
          {saveLabel}
        </div>
      </div>
    </header>
  );
}

// ----- Import / Export dialog -----
function ImportExportDialog({ open, data, storageMode, onClose, onImport }) {
  const { useState: useStateD, useEffect: useEffectD, useRef: useRefD } = React;
  const [tab, setTab]         = useStateD('md');
  const [copied, setCopied]   = useStateD(false);
  const [mdContent, setMdContent] = useStateD('');
  const fileInputRef = useRefD(null);

  // Async-generate markdown when dialog opens or data changes.
  useEffectD(() => {
    if (!open || !data) return;
    let cancelled = false;
    Parser.serialize({ entries: data.entries, history: data.history })
      .then(md => { if (!cancelled) setMdContent(md); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open, data]);

  const jsonContent = React.useMemo(() => {
    if (!data) return '';
    return JSON.stringify({ entries: data.entries, history: data.history, meta: data.meta }, null, 2);
  }, [data]);

  const currentContent = tab === 'md' ? mdContent : jsonContent;
  const filename       = tab === 'md' ? 'backlog.md' : 'backlog_export.json';
  const mimeType       = tab === 'md' ? 'text/markdown' : 'application/json';

  const copyContent = async () => {
    try { await navigator.clipboard.writeText(currentContent); }
    catch {
      const ta = Object.assign(document.createElement('textarea'), {
        value: currentContent, style: 'position:fixed;opacity:0',
      });
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const downloadFile = () => {
    const blob = new Blob([currentContent], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleFileInput = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      const text = await file.text();
      let entries, history;
      if (file.name.endsWith('.json')) {
        const obj = JSON.parse(text);
        entries = obj.entries || [];
        history = obj.history || [];
      } else {
        const parsed = await Parser.parse(text);
        entries = parsed.entries;
        history = parsed.history;
      }
      onImport({ entries, history });
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} width={760} labelledBy="dlg-ie-title">
      <DialogHeader id="dlg-ie-title" eyebrow="Backup & sync" title="Import / Export" onClose={onClose}/>
      <div className="dlg-body">
        <div className="ie-tabs">
          <button className={`ie-tab ${tab === 'md'   ? 'active' : ''}`} onClick={() => setTab('md')}>
            Markdown <span className="ie-tab-sub">.md</span>
          </button>
          <button className={`ie-tab ${tab === 'json' ? 'active' : ''}`} onClick={() => setTab('json')}>
            JSON <span className="ie-tab-sub">structured</span>
          </button>
          <button
            className={`ie-copy-btn ${copied ? 'copied' : ''}`}
            onClick={copyContent}
            title={`Copy ${tab === 'md' ? 'Markdown' : 'JSON'} to clipboard`}
            aria-live="polite"
          >
            {copied
              ? <><Icon name="check" size={13}/> <span>Copied</span></>
              : <><Icon name="copy"  size={13}/> <span>Copy</span></>}
          </button>
        </div>
        <pre className="export-pre">{currentContent || '…generating…'}</pre>
      </div>
      <div className="dlg-foot">
        <div>
          <input ref={fileInputRef} type="file" accept=".md,.json" style={{ display: 'none' }} onChange={handleFileInput}/>
          <button className="btn-secondary" onClick={() => fileInputRef.current?.click()}>
            <Icon name="upload" size={12}/> Import file…
          </button>
        </div>
        <div className="dlg-foot-actions">
          <button className="btn-secondary" onClick={onClose}>Close</button>
          <button className="btn-primary" onClick={downloadFile}>
            <Icon name="download" size={12}/> Download {tab === 'md' ? '.md' : '.json'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// ----- Archive Search Results -----
function ArchiveSearchResults({ query, archiveEntries, onRestore, onLoadArchive, onView }) {
  const [loading, setLoading] = useStateMain(false);
  const loadedRef = useRefMain(false);

  // Auto-load archive on first render
  useEffectMain(() => {
    if (!loadedRef.current && archiveEntries.length === 0) {
      loadedRef.current = true;
      setLoading(true);
      onLoadArchive().finally(() => setLoading(false));
    }
  }, []);

  // Filter archive entries by query
  const matches = [];
  if (query) {
    const q = query.toLowerCase();
    walkTree(archiveEntries, (item) => {
      if (item.title.toLowerCase().includes(q) ||
          item.body?.toLowerCase().includes(q) ||
          item.tags?.some(t => t.toLowerCase().includes(q))) {
        matches.push(item);
      }
    });
  }

  if (loading) {
    return (
      <div className="archive-search-section">
        <div className="archive-search-header">Archive — loading...</div>
      </div>
    );
  }

  if (matches.length === 0) return null;

  return (
    <div className="archive-search-section">
      <div className="archive-search-header">Archive ({matches.length})</div>
      <div className="archive-search-results">
        {matches.slice(0, 10).map(item => (
          <div key={item.id} className="archive-search-item">
            <StatusIcon status={item.status} size={14}/>
            <span className="archive-search-title" onDoubleClick={() => onView(item)}>{item.title}</span>
            {item.archived && <span className="archive-search-date">{item.archived}</span>}
            <button className="btn-secondary btn-xs" onClick={() => onRestore([item.id])}>Restore</button>
          </div>
        ))}
        {matches.length > 10 && (
          <div className="archive-search-more">
            ...and {matches.length - 10} more (see Admin → Archive)
          </div>
        )}
      </div>
    </div>
  );
}

window.App = App;
