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

// Only UI state (expanded rows, project section collapse, tweaks) is persisted locally.
// Backlog data always lives in backlog.md — never in localStorage.
function saveLocalState(expandedMap, tweaks, projectExpandedMap = {}) {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ expandedMap, tweaks, projectExpandedMap })); } catch { /* quota / private mode */ }
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

// Build ONE merged data object from per-project loads (api mode). Every entry
// and history row is tagged with _projectId; stats derive through the same
// buildDataFromStorage pipeline as single-project mode. A single registered
// project degenerates cleanly — the merged model is the ONLY api data path.
async function buildMergedDataFromProjects(projectsData, { sizeInfo = {}, backups = [] } = {}) {
  // Parser ids derive from a Date.now() counter, so loadAllProjects' parallel
  // per-project parses can mint IDENTICAL ids (same-millisecond start).
  // De-collide deterministically per project — stable across reloads — and
  // remap that project's history rows to the new id.
  const seenIds = new Set();
  const allEntries   = [];
  const taggedHistory = [];

  for (const proj of projectsData) {
    walkTree(proj.entries, it => {
      if (seenIds.has(it.id)) {
        const nid = `${it.id}~${proj.id}`;
        for (const h of proj.history) if (h.itemId === it.id) h.itemId = nid;
        it.id = nid;
      }
      seenIds.add(it.id);
      it._projectId = proj.id;
    });
    allEntries.push(...proj.entries);
    for (const h of proj.history) taggedHistory.push({ ...h, _projectId: proj.id });
  }
  taggedHistory.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const metas = projectsData.map(p => p.meta).filter(Boolean);
  const mergedMeta = metas.length ? {
    saved:        metas.map(m => m.saved).filter(Boolean).sort().pop() ?? null,
    checksum:     '—',
    entryCount:   countAll(allEntries),
    historyCount: taggedHistory.length,
  } : null;

  const merged = await buildDataFromStorage(
    { entries: allEntries, history: taggedHistory, meta: mergedMeta, checksumOk: projectsData.every(p => p.checksumOk) },
    backups, 'api', sizeInfo,
  );

  // Stats above derive from the merged tree; mostActiveProject is the project
  // with the most entries.
  let mostActive = '—', maxCount = -1;
  for (const proj of projectsData) {
    const n = countAll(proj.entries);
    if (n > maxCount) { maxCount = n; mostActive = proj.name; }
  }
  merged.stats.mostActiveProject = mostActive;
  return merged;
}

// Which projects have local changes to persist? An explicit id wins (or an
// array of ids for cross-project moves); otherwise derive from _projectId tags
// on entries AND history rows, with untagged rows falling back to the first
// registered project.
function computeDirtyProjectIds(data, explicitProjectId, fallbackFirst) {
  if (Array.isArray(explicitProjectId)) return explicitProjectId.filter(Boolean);
  if (explicitProjectId) return [explicitProjectId];
  const ids = new Set();
  for (const e of data.entries) ids.add(e._projectId ?? fallbackFirst);
  for (const h of data.history) ids.add(h._projectId ?? fallbackFirst);
  ids.delete(null);
  ids.delete(undefined);
  return [...ids];
}

// Re-tag a node and all its descendants as belonging to `projectId`.
// Used by cross-project drag&drop (todo 6 drop zones) and project rename.
function retagSubtree(node, projectId) {
  walkTree([node], it => { it._projectId = projectId; });
}

// Disk counterpart of the in-memory de-collision in buildMergedDataFromProjects:
// strip the merge-only `~<projectId>` suffix from entry ids, history itemIds and
// restore-path segments of THIS project's subset before serializing, so every
// project file stays a standard upstream backlog.md (upstream ids never contain
// `~`). Only an exact `~<projectId>` ending is stripped — other projects'
// suffixes or natural `~` pass through untouched. PURE: the in-memory tree keeps
// its suffixed ids for de-collision; deep-safe copies are returned.
function toDiskIds(entries, history, projectId) {
  if (!projectId) return { entries, history };
  const suffix = '~' + projectId;
  const strip = id => (typeof id === 'string' && id.endsWith(suffix)) ? id.slice(0, id.length - suffix.length) : id;
  const mapEntry = it => ({
    ...it,
    id: strip(it.id),
    restorePath: typeof it.restorePath === 'string' && it.restorePath
      ? it.restorePath.split('/').map(strip).join('/')
      : it.restorePath,
    children: it.children ? it.children.map(mapEntry) : it.children,
  });
  return {
    entries: entries.map(mapEntry),
    history: history.map(h => ({ ...h, itemId: strip(h.itemId) })),
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
  const [projects, setProjects] = useStateMain([]);
  const [projectExpandedMap, setProjectExpandedMap] = useStateMain(() => loadLocalState()?.projectExpandedMap ?? {});
  const [prompt, setPrompt] = useStateMain(null); // PromptDialog state {title, message, placeholder, onConfirm}

  const TWEAK_DEFAULTS = { accent_hue: 35, density: 'comfortable', show_ids: false, paper_texture: true, status_style: 'color', sort_mode: 'priority', theme: 'system' };
  const [tweaks, setTweak] = useTweaks({ ...TWEAK_DEFAULTS, ...(loadLocalState()?.tweaks ?? {}) });

  // Refs for async callbacks that need latest state without stale closures.
  const latestData        = useRefMain(data);
  const latestExpandedMap = useRefMain(expandedMap);
  const latestProjects          = useRefMain(projects);
  const latestProjectExpandedMap = useRefMain(projectExpandedMap);
  const isDirtyRef        = useRefMain(false);
  const saveTimerRef      = useRefMain(null);

  useEffectMain(() => { latestData.current = data; },         [data]);
  useEffectMain(() => { latestExpandedMap.current = expandedMap; }, [expandedMap]);
  useEffectMain(() => { latestProjects.current = projects; },           [projects]);
  useEffectMain(() => { latestProjectExpandedMap.current = projectExpandedMap; }, [projectExpandedMap]);

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

  // ---- Multi-project loading (api mode) ----
  // Full reload of every registered project + merged data rebuild. Used by
  // init, 'set-changed' polls, restores, and the admin flows (todos 6-8).
  const reloadProjects = async ({ seedExpanded = false } = {}) => {
    const [projs, sizeInfo, backups] = await Promise.all([
      ApiBackend.loadAllProjects(),
      Storage.getHealthInfo(),
      Storage.listBackups(),
    ]);
    const newData = await buildMergedDataFromProjects(projs, { sizeInfo, backups });
    latestProjects.current = projs;
    setProjects(projs);
    setData(newData);
    if (seedExpanded && !loadLocalState()?.expandedMap) {
      const em = {};
      walkTree(newData.entries, it => { em[it.id] = !it.collapsed; });
      setExpandedMap(em);
    }
    return { data: newData, projects: projs };
  };

  // SyncPoller callback for multi-project polling (api mode).
  const handleExternalChangeMulti = async (kind, payload) => {
    if (kind === 'warn') {
      showToast('File changed externally — you have unsaved edits', 'warn');
    } else if (kind === 'set-changed') {
      try {
        await reloadProjects({ seedExpanded: false });
        showToast('Projects changed on server — reloaded');
      } catch (e) {
        console.error('Project set reload failed:', e); // keep current state; next poll retries
      }
    } else if (kind === 'project-reloaded' && payload) {
      const { name, parsed } = payload;
      const cur = latestProjects.current;
      const idx = cur.findIndex(p => p.id === name);
      if (idx === -1) return; // unknown project — a set-changed poll will pick it up
      const newProjs = cur.map(p => p.id === name
        ? { ...p, entries: parsed.entries, history: parsed.history, meta: parsed.meta, checksumOk: parsed.checksumOk, missing: false, error: null }
        : p);
      latestProjects.current = newProjs;
      setProjects(newProjs);
      const merged = await buildMergedDataFromProjects(newProjs, {
        sizeInfo: latestData.current.health,
        backups:  latestData.current.backups,
      });
      setData(merged);
      showToast(`Reloaded ${name}`);
    }
  };

  // ---- Storage initialisation (runs once on mount) ----
  useEffectMain(() => {
    let cancelled = false;

    async function initStorage() {
      try {
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
        if (mode === 'api') {
          await applyProjectsData(() => cancelled);
        } else {
          await applyStorageData(mode, () => cancelled);
        }
      } catch (e) {
        if (cancelled) return;
        setStorageMode('local');
        showToast('Storage init failed: ' + e.message, 'err');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    async function applyProjectsData(isCancelled) {
      const { data: newData, projects: projs } = await reloadProjects({ seedExpanded: true });
      if (isCancelled?.()) return;

      const saved = loadLocalState();
      const pem = {};
      for (const p of projs) pem[p.id] = saved?.projectExpandedMap?.[p.id] ?? true;
      setProjectExpandedMap(pem);

      if (projs.some(p => !p.checksumOk && p.meta)) setShowWarning(true);

      SyncPoller.startMulti({
        isDirty: () => isDirtyRef.current,
        onExternalChange: handleExternalChangeMulti,
      });
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
    return () => { cancelled = true; SyncPoller.stop(); };
  }, []);

  // Persist expanded/collapsed row state and tweaks locally. Data itself lives in backlog.md.
  useEffectMain(() => {
    saveLocalState(latestExpandedMap.current, tweaks, latestProjectExpandedMap.current);
  }, [expandedMap, projectExpandedMap, tweaks]);

  const showToast = (msg, kind = 'ok') => {
    setToast({ msg, kind, t: Date.now() });
    setTimeout(() => setToast(t => (t && Date.now() - t.t >= 2400) ? null : t), 2500);
  };

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
  // projectId (string or array) restricts the save to that project(s);
  // omitted = derive the dirty set from _projectId tags.
  const triggerSave = (label, projectId = null) => {
    isDirtyRef.current = true;
    setSaveState(prev => ({ ...prev, status: 'saving' }));
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    saveTimerRef.current = setTimeout(async () => {
      const d  = latestData.current;
      const em = latestExpandedMap.current;
      try {
        if (Storage.mode === 'api') {
          // Unified api save path: serialize every DIRTY project separately.
          // A single registered project is the same loop with one element.
          const fallbackFirst = latestProjects.current[0]?.id ?? null;
          const dirtyIds = computeDirtyProjectIds(d, projectId, fallbackFirst);
          for (const pId of dirtyIds) {
            const projectEntries = d.entries.filter(e => (e._projectId ?? fallbackFirst) === pId);
            const projectHistory = d.history.filter(h => (h._projectId ?? fallbackFirst) === pId);
            const content = await Parser.serialize(toDiskIds(projectEntries, projectHistory, pId));
            const result  = await ApiBackend.saveProject(pId, content);
            // Keep SyncPoller in sync with our own save to avoid false external-change triggers.
            if (result?.checksum) SyncPoller.lastChecksums[pId] = result.checksum;
          }
        } else if (Storage.isConnected()) {
          const content = await Parser.serialize({ entries: d.entries, history: d.history });
          await Storage.save(content);
          // Keep SyncPoller in sync with our own save to avoid false external-change triggers.
          const cm = content.match(/checksum:\s*(sha256:[a-f0-9]+)/);
          if (cm) SyncPoller.lastChecksum = cm[1];
        }
        saveLocalState(em, tweaks, latestProjectExpandedMap.current);
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
    isDirtyRef.current = true;
    setData(d => { const c = structuredClone(d); fn(c); return c; });
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
      const item = findItem(data.entries, id);
      mutate(d => {
        const it = findItem(d.entries, id);
        if (!it || it.status === status) return;
        const histEntry = { timestamp: new Date().toISOString(), itemId: id, action: 'status_changed', details: `${it.status} → ${status}` };
        if (it._projectId) histEntry._projectId = it._projectId;
        d.history.unshift(histEntry);
        const wasDone = it.status === 'done';
        it.status = status;
        if (status !== 'blocked') it.reason = null;
        if (status === 'done')                    it.progress = 100;
        else if (wasDone && (it.progress ?? 0) >= 100) it.progress = 75;
      });
      triggerSave(null, item?._projectId);
    },

    setPriority: (id, priority) => {
      const item = findItem(data.entries, id);
      mutate(d => {
        const it = findItem(d.entries, id);
        if (!it || it.priority === priority) return;
        const histEntry = { timestamp: new Date().toISOString(), itemId: id, action: 'priority_changed', details: `${it.priority} → ${priority}` };
        if (it._projectId) histEntry._projectId = it._projectId;
        d.history.unshift(histEntry);
        it.priority = priority;
      });
      triggerSave(null, item?._projectId);
    },

    setProgress: (id, progress) => {
      const item = findItem(data.entries, id);
      mutate(d => {
        const it = findItem(d.entries, id);
        if (!it) return;
        const v = snapProgress(progress);
        if ((it.progress ?? 0) === v) return;
        const before = it.progress ?? 0;
        it.progress = v;
        const histEntry = { timestamp: new Date().toISOString(), itemId: id, action: 'progress_changed', details: `${before}% → ${v}%` };
        if (it._projectId) histEntry._projectId = it._projectId;
        d.history.unshift(histEntry);
      });
      triggerSave(null, item?._projectId);
    },

    moveWithinPriority: (id, dir) => {
      const item = findItem(data.entries, id);
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
        const histEntry = { timestamp: new Date().toISOString(), itemId: id, action: 'item_reordered', details: `moved ${dir < 0 ? 'up' : 'down'}` };
        if (me._projectId) histEntry._projectId = me._projectId;
        d.history.unshift(histEntry);
      });
      triggerSave(null, item?._projectId);
    },

    reorder: (draggedId, targetId) => {
      const item = findItem(data.entries, draggedId);
      mutate(d => {
        const src = findParentList(d.entries, draggedId);
        const tgt = findParentList(d.entries, targetId);
        if (!src || !tgt || src.list !== tgt.list) return;
        const draggedIdx = src.list.findIndex(x => x.id === draggedId);
        const dragged    = src.list[draggedIdx];
        src.list.splice(draggedIdx, 1);
        const newTargetIdx = tgt.list.findIndex(x => x.id === targetId);
        tgt.list.splice(newTargetIdx, 0, dragged);
        const histEntry = { timestamp: new Date().toISOString(), itemId: draggedId, action: 'item_reordered', details: `dropped before ${targetId}` };
        if (dragged._projectId) histEntry._projectId = dragged._projectId;
        d.history.unshift(histEntry);
      });
      triggerSave('Reordered', item?._projectId);
    },

    // Cross-project drag&drop (todo 6 section drop zones call this): move the
    // node to the destination project's root, re-tagging the whole subtree.
    // Both source and destination files change, so both are saved.
    moveToProject: (draggedId, projectId) => {
      const dragged = findItem(data.entries, draggedId);
      if (!dragged || !projectId || dragged._projectId === projectId) return;
      const srcProjectId = dragged._projectId ?? latestProjects.current[0]?.id ?? null;
      mutate(d => {
        const r = findParentList(d.entries, draggedId);
        if (!r) return;
        const i = r.list.findIndex(x => x.id === draggedId);
        if (i < 0) return;
        const [node] = r.list.splice(i, 1);
        retagSubtree(node, projectId);
        (function setLevel(it, lv) { it.level = lv; (it.children || []).forEach(c => setLevel(c, lv + 1)); })(node, 1);
        d.entries.push(node);
        const histEntry = { timestamp: new Date().toISOString(), itemId: draggedId, action: 'item_reordered', details: `moved to project ${projectId}` };
        histEntry._projectId = projectId;
        d.history.unshift(histEntry);
      });
      triggerSave('Moved', [srcProjectId, projectId]);
    },

    addChild: (parentId) => setItemDialog({ mode: 'add-child', parentId, initial: null }),
    addRoot:  (projectId = null) => setItemDialog({ mode: 'add', parentId: null, initial: null, projectId }),

    editItem: (id) => {
      const it = findItem(data.entries, id);
      if (!it) return;
      setItemDialog({ mode: 'edit', itemId: id, initial: it });
    },

    deleteItem: (id) => {
      const it = findItem(data.entries, id);
      if (!it) return;
      const childCount = (() => { let n = 0; walkTree([it], () => n++); return n - 1; })();
      const projectId = it._projectId ?? null;
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
            const histEntry = { timestamp: new Date().toISOString(), itemId: id, action: 'item_deleted', details: `final: ${it.status}` };
            if (projectId) histEntry._projectId = projectId;
            d.history.unshift(histEntry);
          });
          setConfirm(null);
          triggerSave('Deleted', projectId);
        },
      });
    },
  };

  // Which project does a NEW item belong to? An explicit hint (dialog select
  // or section context — todos 6-7) wins; otherwise the first registered
  // project. Non-api modes have no projects → null → item stays untagged.
  const resolveTargetProjectId = (hint = null) => {
    if (hint) return hint;
    const first = latestProjects.current[0];
    return first ? first.id : null;
  };

  const submitItemDialog = (vals) => {
    if (vals.createAsProject && vals.projectPath) {
      const path = vals.projectPath;
      setItemDialog(null);
      ApiBackend.registerProject(path, vals.title || null)
        .then(async (result) => {
          if (!result.ok) throw new Error(result.error || 'Register failed');
          await reloadProjects({ seedExpanded: false });
          await SyncPoller.syncChecksums();
          showToast(`Project registered: ${result.name}`);
        })
        .catch(e => showToast('Register failed: ' + e.message, 'err'));
      return;
    }
    if (itemDialog.mode === 'edit') {
      const editedItem = findItem(data.entries, itemDialog.itemId);
      mutate(d => {
        const x = findItem(d.entries, itemDialog.itemId);
        if (!x) return;
        const before = { priority: x.priority, status: x.status };
        Object.assign(x, vals);
        if (before.status !== vals.status) {
          const histEntry = { timestamp: new Date().toISOString(), itemId: x.id, action: 'status_changed', details: `${before.status} → ${vals.status}` };
          if (x._projectId) histEntry._projectId = x._projectId;
          d.history.unshift(histEntry);
        }
        if (before.priority !== vals.priority) {
          const histEntry = { timestamp: new Date().toISOString(), itemId: x.id, action: 'priority_changed', details: `${before.priority} → ${vals.priority}` };
          if (x._projectId) histEntry._projectId = x._projectId;
          d.history.unshift(histEntry);
        }
      });
      triggerSave('Saved', editedItem?._projectId);
    } else {
      const newId = 'n-' + Math.random().toString(36).slice(2, 8);
      const parentForTarget = itemDialog.mode === 'add-child' && itemDialog.parentId
        ? findItem(data.entries, itemDialog.parentId)
        : null;
      const targetProjectId = resolveTargetProjectId(
        vals.projectId || itemDialog.projectId || parentForTarget?._projectId || null
      );
      mutate(d => {
        const node = { id: newId, level: 1, ...vals, children: [], collapsed: false };
        if (targetProjectId) node._projectId = targetProjectId;
        if (parentForTarget) {
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
        const histEntry = { timestamp: new Date().toISOString(), itemId: newId, action: 'item_created', details: vals.title };
        if (targetProjectId) histEntry._projectId = targetProjectId;
        d.history.unshift(histEntry);
      });
      triggerSave('Added', targetProjectId);
    }
    setItemDialog(null);
  };

  const setExpanded = (id, val) => setExpandedMap(m => ({ ...m, [id]: val }));

  // ---- Project section actions (multi-project api mode, todo 6) ----
  const toggleProjectExpanded = (projectId) => {
    setProjectExpandedMap(m => {
      const isExpanded = m[projectId] !== false;
      return { ...m, [projectId]: !isExpanded };
    });
  };

  // Cross-project drag&drop: tree rows only accept drops from their OWN tree
  // (draggedId is local state per BacklogTree), so a drag that lands anywhere
  // else in a section falls through to this drop zone. The dragged id travels
  // in the text/plain payload set by the row's dragstart.
  const sectionDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('drop-target');
  };
  const sectionDragLeave = (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('drop-target');
  };
  const handleSectionDrop = (e, projectId) => {
    e.preventDefault();
    e.currentTarget.classList.remove('drop-target');
    let draggedId = null;
    try { draggedId = e.dataTransfer.getData('text/plain') || null; }
    catch { draggedId = null; } // protected drag data — nothing sensible to move
    if (!draggedId) return;
    const dragged = findItem(data.entries, draggedId);
    if (!dragged) return;
    const fromId = dragged._projectId ?? latestProjects.current[0]?.id;
    if (fromId === projectId) return; // intra-project drops stay the tree's own reorder
    onMutate.moveToProject(draggedId, projectId);
  };

  const handleRenameProject = (projectId) => {
    const proj = projects.find(p => p.id === projectId);
    if (!proj) return;
    setPrompt({
      title: 'Rename project',
      message: <>New name for <strong>{proj.name}</strong>?</>,
      placeholder: proj.name,
      confirmLabel: 'Rename',
      onConfirm: async (newName) => {
        if (!newName || newName === proj.name) return;
        try {
          const result = await ApiBackend.renameProject(projectId, newName);
          if (!result.ok) throw new Error(result.error || 'Rename failed');
          setProjectExpandedMap(prev => {
            const next = { ...prev };
            const was = next[projectId] ?? true;
            delete next[projectId];
            next[result.name] = was;
            return next;
          });
          await reloadProjects({ seedExpanded: false });
          await SyncPoller.syncChecksums();
          showToast(`Renamed to ${result.name}`);
        } catch (e) {
          showToast('Rename failed: ' + e.message, 'err');
        }
      },
    });
  };

  const handleRemoveProject = (projectId) => {
    const proj = projects.find(p => p.id === projectId);
    if (!proj) return;
    const itemCount = countAll(proj.entries);
    setConfirm({
      title: 'Delete project?',
      message: <>Delete <strong>{proj.name}</strong> from the registry?</>,
      detail: (
        <span className="muted">
          {`The file contains ${itemCount} item${itemCount !== 1 ? 's' : ''}. `}
          Unregistering keeps the file on disk.
        </span>
      ),
      checkbox: 'Also delete the file from disk',
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async (deleteFromDisk) => {
        const del = deleteFromDisk === true;
        setConfirm(null);
        try {
          const result = await ApiBackend.unregisterProject(projectId, del);
          if (!result.ok) throw new Error(result.error || 'Delete failed');
          // Optimistic removal of every trace — a partial clean would resurrect
          // the section on the next reloadProjects.
          latestProjects.current = latestProjects.current.filter(p => p.id !== projectId);
          setProjects(prev => prev.filter(p => p.id !== projectId));
          setData(prev => ({
            ...prev,
            entries: prev.entries.filter(e => e._projectId !== projectId),
            history: prev.history.filter(h => h._projectId !== projectId),
          }));
          setProjectExpandedMap(prev => { const n = { ...prev }; delete n[projectId]; return n; });
          await SyncPoller.syncChecksums();
          showToast(result.warning
            ? `Removed ${proj.name} — file not deleted: ${result.warning}`
            : del ? `Deleted from disk: ${proj.name}` : `Removed: ${proj.name}`);
        } catch (e) {
          showToast('Delete failed: ' + e.message, 'err');
        }
      },
    });
  };


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
          if (Storage.isConnected()) {
            const result = await Storage.restoreBackup(b.name);
            if (!result.ok) throw new Error(result.error || 'Restore failed');
            if (Storage.mode === 'api') {
              // The legacy backup route restored the default project — refresh everything.
              await reloadProjects({ seedExpanded: false });
              await SyncPoller.syncChecksums();
            } else {
              const [raw, backups, sizeInfo] = await Promise.all([Storage.load(), Storage.listBackups(), Storage.getHealthInfo()]);
              const parsed  = await Parser.parse(raw?.content || '');
              const newData = await buildDataFromStorage(parsed, backups, storageMode, sizeInfo);
              setData(newData);
              SyncPoller.lastChecksum = parsed.meta?.checksum || '';
            }
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
    // In api mode imported rows land in the first project (todo 8 adds a
    // target-project selector); other projects are left untouched.
    const pid = Storage.mode === 'api' ? resolveTargetProjectId() : null;
    mutate(d => {
      if (pid) {
        for (const e of entries) e._projectId = pid;
      }
      d.entries = entries;
      if (history?.length) d.history = [...history.map(h => pid ? { ...h, _projectId: pid } : h), ...d.history];
      const histEntry = { timestamp: new Date().toISOString(), itemId: 'system', action: 'imported', details: `${entries.length} top-level entries` };
      if (pid) histEntry._projectId = pid;
      d.history.unshift(histEntry);
    });
    setImportExportOpen(false);
    triggerSave('Imported', pid);
  };

  // ---- Archive functions ----
  const loadArchive = async () => {
    try {
      if (Storage.mode === 'api') {
        // Each project has its own archive.md — merge them, tagged per project.
        const projs = latestProjects.current;
        const parsedAll = await Promise.all(projs.map(async p => {
          try {
            const raw = await ApiBackend.loadArchive(p.id);
            if (raw.exists && raw.content) return await Parser.parse(raw.content);
          } catch (e) { console.error(`Failed to load archive for ${p.id}:`, e); }
          return { entries: [], history: [] };
        }));
        const entries = [], history = [];
        projs.forEach((p, i) => {
          for (const e of parsedAll[i].entries) e._projectId = p.id;
          entries.push(...parsedAll[i].entries);
          history.push(...parsedAll[i].history);
        });
        setArchiveData({ entries, history });
      } else {
        const raw = await Storage.loadArchive();
        if (raw.exists && raw.content) {
          const parsed = await Parser.parse(raw.content);
          setArchiveData({ entries: parsed.entries || [], history: parsed.history || [] });
        }
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

    // Add history entries
    const newHistory = [...data.history];
    for (const item of toArchive) {
      const histEntry = {
        timestamp: new Date().toISOString(),
        itemId: item.id,
        action: 'item_archived',
        details: `moved to archive.md`
      };
      if (item._projectId) histEntry._projectId = item._projectId;
      newHistory.unshift(histEntry);
    }

    // Add to archive
    const newArchiveEntries = [...archiveData.entries, ...toArchive];

    try {
      if (Storage.mode === 'api') {
        // Per-project archive: group the batch by _projectId, then for each
        // affected project write its remaining backlog + its own archive.
        const fallbackFirst = latestProjects.current[0]?.id ?? null;
        const pidOf = x => x._projectId ?? fallbackFirst;
        const groups = new Map();
        for (const item of toArchive) {
          const pid = pidOf(item);
          if (!groups.has(pid)) groups.set(pid, []);
          groups.get(pid).push(item);
        }
        const existing = await Promise.all([...groups.keys()].map(async pid => {
          try {
            const raw = await ApiBackend.loadArchive(pid);
            if (raw.exists && raw.content) {
              const parsed = await Parser.parse(raw.content);
              return { pid, entries: parsed.entries || [], history: parsed.history || [] };
            }
          } catch (e) { console.error(`Failed to load archive for ${pid}:`, e); }
          return { pid, entries: [], history: [] };
        }));
        for (const { pid, entries: archEntries, history: archHistory } of existing) {
          const backlogContent = await Parser.serialize(toDiskIds(
            newEntries.filter(e => pidOf(e) === pid),
            newHistory.filter(h => pidOf(h) === pid),
            pid,
          ));
          const archiveContent = await Parser.serialize(toDiskIds(
            [...archEntries, ...groups.get(pid)],
            archHistory,
            pid,
          ));
          const result = await ApiBackend.saveArchive(backlogContent, archiveContent, pid);
          if (!result.ok) throw new Error('Archive failed');
        }
        await SyncPoller.syncChecksums();
      } else {
        // Serialize both files
        const backlogContent = await Parser.serialize({ entries: newEntries, history: newHistory });
        const archiveContent = await Parser.serialize({ entries: newArchiveEntries, history: archiveData.history });

        // Save both atomically
        const result = await Storage.saveArchive(backlogContent, archiveContent);
        if (!result.ok) throw new Error('Archive failed');
      }

      // Update local state
      setData(d => ({ ...d, entries: newEntries, history: newHistory }));
      if (Storage.mode === 'api') {
        await loadArchive(); // refresh the merged per-project archive view from disk
      } else {
        setArchiveData({ entries: newArchiveEntries, history: archiveData.history });
      }
      isDirtyRef.current = false;

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
      const histEntry = {
        timestamp: new Date().toISOString(),
        itemId: item.id,
        action: 'item_restored',
        details: `restored from archive`
      };
      if (item._projectId) histEntry._projectId = item._projectId;
      newHistory.unshift(histEntry);
    }

    try {
      if (Storage.mode === 'api') {
        // Mirror of the archive flow per project: only projects whose items
        // were restored get their backlog + archive rewritten.
        const fallbackFirst = latestProjects.current[0]?.id ?? null;
        const pidOf = x => x._projectId ?? fallbackFirst;
        for (const pid of [...new Set(toRestore.map(pidOf))]) {
          const backlogContent = await Parser.serialize(toDiskIds(
            newEntries.filter(e => pidOf(e) === pid),
            newHistory.filter(h => pidOf(h) === pid),
            pid,
          ));
          const archiveContent = await Parser.serialize(toDiskIds(
            remainingArchive.filter(e => pidOf(e) === pid),
            [],
            pid,
          ));
          const result = await ApiBackend.restoreFromArchive(backlogContent, archiveContent, pid);
          if (!result.ok) throw new Error('Restore failed');
        }
        await SyncPoller.syncChecksums();
      } else {
        // Serialize both files
        const backlogContent = await Parser.serialize({ entries: newEntries, history: newHistory });
        const archiveContent = await Parser.serialize({ entries: remainingArchive, history: archiveData.history });

        // Save both atomically
        const result = await Storage.restoreFromArchive(backlogContent, archiveContent);
        if (!result.ok) throw new Error('Restore failed');
      }

      // Update local state
      setData(d => ({ ...d, entries: newEntries, history: newHistory }));
      if (Storage.mode === 'api') {
        await loadArchive(); // refresh the merged per-project archive view from disk
      } else {
        setArchiveData({ entries: remainingArchive, history: archiveData.history });
      }
      isDirtyRef.current = false;

      let msg = `Restored ${toRestore.length} item${toRestore.length > 1 ? 's' : ''}`;
      if (warnings.length) msg += ` (${warnings.length} to root - parent not found)`;
      showToast(msg);
    } catch (e) {
      showToast('Restore failed: ' + e.message, 'err');
    }
  };

  const saveLabel  = saveState.status === 'saving' ? 'Saving…'
                   : saveState.status === 'error'  ? 'Save failed'
                   : `Saved · ${fmtTimestamp(saveState.lastSaved)}`;
  const hasFilters = filters.text || filters.statuses?.length || filters.priorities?.length || filters.tags?.length || filters.dueRange;
  const isMulti = projects.length > 1; // UI gating only — the merged model is the single data path

  if (isLoading) {
    return (
      <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <div style={{ textAlign: 'center', color: 'var(--ink-3)' }}>
          <div style={{ fontSize: 22, marginBottom: 8 }}>Loading…</div>
          <div style={{ fontSize: 13 }}>Connecting to storage</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <StatusStyleContext.Provider value={tweaks.status_style}>
      <Header
        view={view} setView={setView}
        saveState={saveState} saveLabel={saveLabel}
        storageMode={storageMode}
        searchValue={filters.text}
        onSearch={(v) => setFilters({ ...filters, text: v })}
        onForceSave={() => triggerSave('Saved manually')}
        onOpenImportExport={() => setImportExportOpen(true)}
      />

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
              {isMulti && projects.length > 0 ? (
                <div className="project-sections">
                  {projects.map(p => {
                    const pidOf = e => e._projectId ?? projects[0]?.id;
                    const projEntries = filtered.filter(e => pidOf(e) === p.id);
                    const itemCount = countAll(data.entries.filter(e => pidOf(e) === p.id));
                    const isExpanded = projectExpandedMap[p.id] !== false;
                    const unhealthy = p.missing || p.error;
                    return (
                      <div key={p.id} className="project-section">
                        <div
                          className={`project-section-header ${isExpanded ? 'expanded' : 'collapsed'}${unhealthy ? ' missing' : ''}`}
                          onClick={() => toggleProjectExpanded(p.id)}
                          title={p.path}
                        >
                          <span className="project-section-chevron">
                            <Icon name={isExpanded ? 'chevron' : 'chevronRight'} size={12}/>
                          </span>
                          <span className="project-section-name">{p.name}</span>
                          {unhealthy && <span className="project-missing-badge">{p.missing ? 'missing' : 'error'}</span>}
                          <span className="project-section-count">{itemCount} item{itemCount !== 1 ? 's' : ''}</span>
                          <div className="project-section-actions">
                            <button className="project-section-btn"
                              title={`Add item to ${p.name}`}
                              onClick={(e) => { e.stopPropagation(); onMutate.addRoot(p.id); }}>
                              <Icon name="plus" size={11}/>
                            </button>
                            <button className="project-section-btn"
                              title="Rename project"
                              onClick={(e) => { e.stopPropagation(); handleRenameProject(p.id); }}>
                              <Icon name="edit" size={11}/>
                            </button>
                            <button className="project-section-btn project-section-btn-danger"
                              title="Remove project from registry"
                              onClick={(e) => { e.stopPropagation(); handleRemoveProject(p.id); }}>
                              <Icon name="trash" size={11}/>
                            </button>
                          </div>
                        </div>
                        {isExpanded && (
                          <div
                            className="project-section-content"
                            onDragOver={sectionDragOver}
                            onDragLeave={sectionDragLeave}
                            onDrop={(e) => handleSectionDrop(e, p.id)}
                          >
                            {unhealthy ? (
                              <div className="project-empty">
                                {p.missing
                                  ? <>File not found on disk — restore it, or remove this project. <span className="mono">{p.path}</span></>
                                  : <>Failed to load this project: {p.error}</>}
                              </div>
                            ) : projEntries.length === 0 ? (
                              <div className="project-empty">{hasFilters ? 'No items match these filters.' : 'No items in this project yet.'}</div>
                            ) : (
                              <BacklogTree
                                items={projEntries}
                                expandedMap={expandedMap}
                                setExpanded={setExpanded}
                                onMutate={onMutate}
                                query={filters.text?.trim() || ''}
                                statusStyle={tweaks.status_style}
                                manualOrder={tweaks.sort_mode === 'manual'}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : filtered.length === 0 ? (
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
        isMultiProject={isMulti && storageMode === 'api'}
        projects={projects}
        defaultProjectId={itemDialog?.projectId ?? projects[0]?.id}
        onClose={() => setItemDialog(null)}
        onSubmit={submitItemDialog}
      />

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title}
        message={confirm?.message}
        detail={confirm?.detail}
        checkbox={confirm?.checkbox}
        confirmLabel={confirm?.confirmLabel}
        danger={confirm?.danger}
        onCancel={() => setConfirm(null)}
        onConfirm={confirm?.onConfirm}
      />

      {prompt && (
        <window.PromptDialog
          open
          title={prompt.title}
          message={prompt.message}
          placeholder={prompt.placeholder}
          confirmLabel={prompt.confirmLabel}
          onCancel={() => setPrompt(null)}
          onConfirm={(value) => { const cb = prompt.onConfirm; setPrompt(null); cb?.(value); }}
        />
      )}

      <ImportExportDialog
        open={importExportOpen}
        data={data}
        storageMode={storageMode}
        onClose={() => setImportExportOpen(false)}
        onImport={handleImport}
      />

      {toast && (
        <div className={`toast ${toast.kind}`}><Icon name="check" size={12}/> {toast.msg}</div>
      )}

      <TweaksPanel title="Tweaks">
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
function Header({ view, setView, saveState, saveLabel, storageMode, searchValue, onSearch, onOpenImportExport }) {
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

// Multi-project data-layer helpers — consumed by todos 6-8 (sections UI,
// dialogs, admin) and the todo-5 verification harness.
Object.assign(window, {
  buildMergedDataFromProjects,
  computeDirtyProjectIds,
  retagSubtree,
  toDiskIds,
});

window.App = App;
