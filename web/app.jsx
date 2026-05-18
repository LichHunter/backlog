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

function saveLocalState(expandedMap, tweaks, multiProjectMode = null) {
  try { 
    const state = { expandedMap, tweaks };
    if (multiProjectMode !== null) state.multiProjectMode = multiProjectMode;
    else if (loadLocalState()?.multiProjectMode) state.multiProjectMode = loadLocalState().multiProjectMode;
    localStorage.setItem(LS_KEY, JSON.stringify(state)); 
  } catch { /* quota */ }
}

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

function buildMergedDataFromProjects(projectsData) {
  const allEntries = [];
  const allHistory = [];
  const statusMix = { open: 0, 'in-progress': 0, blocked: 0, postponed: 0, done: 0, cancelled: 0 };

  for (const proj of projectsData) {
    for (const entry of proj.entries) {
      entry._projectId = proj.id;
      entry._projectName = proj.name;
    }
    allEntries.push(...proj.entries);
    allHistory.push(...proj.history.map(h => ({ ...h, _projectId: proj.id })));
    walkTree(proj.entries, it => { statusMix[it.status] = (statusMix[it.status] || 0) + 1; });
  }

  allHistory.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day => ({ day, count: 0 }));
  return {
    entries: allEntries,
    history: allHistory,
    meta: { saved: null, checksum: '—', entryCount: allEntries.length, historyCount: allHistory.length },
    health: {
      integrityOk: projectsData.every(p => p.checksumOk),
      lastSave: null, lastBackup: null,
      masterSize: 0, backupDirSize: 0, backupCount: 0,
      statsSize: 0, historySize: 0, historyOldest: null,
      mode: 'Multi-project workspace',
      projectCount: projectsData.length,
    },
    stats: {
      createdThisWeek: 0, completedThisWeek: 0, avgInProgressDays: null,
      mostActiveProject: projectsData[0]?.name || '—',
      completionByDay: days.map(d => ({ ...d })),
      createdByDay: days.map(d => ({ ...d })),
      statusMix,
    },
    backups: [],
  };
}

function filterProjectEntries(entries, filters, sortMode) {
  const f = { ...filters, text: filters.text?.trim() || '' };
  const noFilters = !f.statuses?.length && !f.priorities?.length && !f.tags?.length && !f.dueRange && !f.text;
  let tree = noFilters ? entries : filterTree(entries, f);
  tree = structuredClone(tree);
  if (sortMode === 'priority') {
    function sortRecur(list) {
      list.sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority));
      list.forEach(it => it.children?.length && sortRecur(it.children));
    }
    sortRecur(tree);
  }
  if (f.scope === 'top') tree = tree.map(it => ({ ...it, children: [] }));
  return tree;
}

function App() {
  const [data, setData]             = useStateMain(buildEmptyData);
  const [storageMode, setStorageMode] = useStateMain('local');
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

  const [isMultiProject, setIsMultiProject] = useStateMain(false);
  const [projects, setProjects]     = useStateMain([]);
  const [projectExpandedMap, setProjectExpandedMap] = useStateMain({});
  const [workspaceName, setWorkspaceName] = useStateMain(null);

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
        const mode = await Storage.detect();
        setStorageMode(mode);

        if (mode === 'local') { setIsLoading(false); return; }

        if (mode === 'browser') {
          if (cancelled) return;
          
          const savedState = loadLocalState();
          if (savedState?.multiProjectMode === 'browser-multiproject') {
            const projectsData = await BrowserMultiProjectBackend.loadAll();
            if (projectsData.length > 0) {
              setProjects(projectsData);
              setIsMultiProject(true);
              setStorageMode('browser-multiproject');
              setWorkspaceName('Browser Storage');
              const mergedData = buildMergedDataFromProjects(projectsData);
              setData(mergedData);
              const em = {};
              projectsData.forEach(p => { walkTree(p.entries, it => { em[it.id] = !it.collapsed; }); });
              setExpandedMap(savedState.expandedMap || em);
              const pem = {};
              projectsData.forEach(p => { pem[p.id] = true; });
              setProjectExpandedMap(pem);
              setIsLoading(false);
              return;
            }
          }
          
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
    return () => { cancelled = true; SyncPoller.stop(); };
  }, []);

  // Persist expanded/collapsed row state and tweaks locally. Data itself lives in backlog.md.
  useEffectMain(() => {
    saveLocalState(latestExpandedMap.current, tweaks);
  }, [expandedMap, tweaks]);

  const showToast = (msg, kind = 'ok') => {
    setToast({ msg, kind, t: Date.now() });
    setTimeout(() => setToast(t => (t && Date.now() - t.t >= 2400) ? null : t), 2500);
  };

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

  const handleConnectWorkspace = async () => {
    try {
      await MultiProjectBackend.connect();
      const projectsData = await MultiProjectBackend.loadAll();
      if (projectsData.length === 0) {
        showToast('No projects found. Create a subfolder with backlog.md to start.', 'warn');
        return;
      }
      setProjects(projectsData);
      setIsMultiProject(true);
      setStorageMode('multiproject');
      setWorkspaceName(MultiProjectBackend.workspaceHandle?.name || 'Workspace');

      const mergedData = buildMergedDataFromProjects(projectsData);
      setData(mergedData);

      const em = {};
      projectsData.forEach(p => {
        walkTree(p.entries, it => { em[it.id] = !it.collapsed; });
      });
      setExpandedMap(em);

      const pem = {};
      projectsData.forEach(p => { pem[p.id] = true; });
      setProjectExpandedMap(pem);

      setNeedsConnect(false);
      showToast(`Loaded ${projectsData.length} project${projectsData.length > 1 ? 's' : ''}`);
    } catch (e) {
      showToast('Workspace connect failed: ' + e.message, 'err');
    }
  };

  const handleCreateProject = async () => {
    const name = prompt('Project name:');
    if (!name || !name.trim()) return;
    const safeName = name.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
    try {
      const backend = storageMode === 'browser-multiproject' ? BrowserMultiProjectBackend : MultiProjectBackend;
      await backend.createProject(safeName);
      const projectsData = await backend.loadAll();
      setProjects(projectsData);
      const mergedData = buildMergedDataFromProjects(projectsData);
      setData(mergedData);
      setProjectExpandedMap(prev => ({ ...prev, [safeName]: true }));
      showToast(`Created project: ${safeName}`);
    } catch (e) {
      showToast('Failed to create project: ' + e.message, 'err');
    }
  };

  const handleEnableBrowserMultiProject = async () => {
    try {
      const projectsData = await BrowserMultiProjectBackend.loadAll();
      
      if (projectsData.length === 0 && data.entries.length > 0) {
        const importExisting = window.confirm('Import current items into a "default" project?');
        if (importExisting) {
          await BrowserMultiProjectBackend.createProject('default');
          const content = await Parser.serialize({ entries: data.entries, history: data.history });
          await BrowserMultiProjectBackend.saveProject('default', content);
        }
      }
      
      const freshData = await BrowserMultiProjectBackend.loadAll();
      if (freshData.length === 0) {
        await BrowserMultiProjectBackend.createProject('default');
      }
      
      const finalData = await BrowserMultiProjectBackend.loadAll();
      setProjects(finalData);
      setIsMultiProject(true);
      setStorageMode('browser-multiproject');
      setWorkspaceName('Browser Storage');

      const mergedData = buildMergedDataFromProjects(finalData);
      setData(mergedData);

      const em = {};
      finalData.forEach(p => { walkTree(p.entries, it => { em[it.id] = !it.collapsed; }); });
      setExpandedMap(em);

      const pem = {};
      finalData.forEach(p => { pem[p.id] = true; });
      setProjectExpandedMap(pem);

      saveLocalState(expandedMap, tweaks, 'browser-multiproject');
      showToast(`Multi-project enabled: ${finalData.length} project${finalData.length !== 1 ? 's' : ''}`);
    } catch (e) {
      showToast('Failed to enable multi-project: ' + e.message, 'err');
    }
  };

  const handleRenameProject = async (projectId) => {
    const proj = projects.find(p => p.id === projectId);
    if (!proj) return;
    const newName = prompt('New project name:', proj.name);
    if (!newName || newName.trim() === proj.name) return;
    
    try {
      const backend = storageMode === 'browser-multiproject' ? BrowserMultiProjectBackend : MultiProjectBackend;
      const result = await backend.renameProject(projectId, newName);
      if (!result.ok) throw new Error(result.error);
      
      const projectsData = await backend.loadAll();
      setProjects(projectsData);
      const mergedData = buildMergedDataFromProjects(projectsData);
      setData(mergedData);
      setProjectExpandedMap(prev => {
        const next = { ...prev };
        delete next[projectId];
        next[result.newId] = true;
        return next;
      });
      showToast(`Renamed to: ${result.newId}`);
    } catch (e) {
      showToast('Rename failed: ' + e.message, 'err');
    }
  };

  const handleRemoveProject = (projectId) => {
    const proj = projects.find(p => p.id === projectId);
    if (!proj) return;
    const itemCount = countAll(proj.entries);
    const isBrowserMode = storageMode === 'browser-multiproject';
    
    setConfirm({
      title: 'Delete project?',
      message: <>Delete <strong>{proj.name}</strong>?</>,
      detail: (
        <span className="muted">
          {isBrowserMode 
            ? `This will permanently delete ${itemCount} item${itemCount !== 1 ? 's' : ''} from browser storage.`
            : `The folder and ${itemCount} item${itemCount !== 1 ? 's' : ''} will remain on disk.`}
        </span>
      ),
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        try {
          if (isBrowserMode) {
            await BrowserMultiProjectBackend.removeProject(projectId);
          }
          const newProjects = projects.filter(p => p.id !== projectId);
          setProjects(newProjects);
          const newEntries = data.entries.filter(e => e._projectId !== projectId);
          const newHistory = data.history.filter(h => h._projectId !== projectId);
          setData(prev => ({ ...prev, entries: newEntries, history: newHistory }));
          setProjectExpandedMap(prev => {
            const next = { ...prev };
            delete next[projectId];
            return next;
          });
          setConfirm(null);
          showToast(`Deleted: ${proj.name}`);
        } catch (e) {
          showToast('Delete failed: ' + e.message, 'err');
          setConfirm(null);
        }
      },
    });
  };

  const triggerSave = (label, projectId = null) => {
    isDirtyRef.current = true;
    setSaveState(prev => ({ ...prev, status: 'saving' }));
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    saveTimerRef.current = setTimeout(async () => {
      const d  = latestData.current;
      const em = latestExpandedMap.current;
      try {
        if (isMultiProject) {
          const backend = storageMode === 'browser-multiproject' ? BrowserMultiProjectBackend : MultiProjectBackend;
          const dirtyProjects = projectId 
            ? [projectId] 
            : [...new Set(d.entries.map(e => e._projectId).filter(Boolean))];
          
          for (const pId of dirtyProjects) {
            const projectEntries = d.entries.filter(e => e._projectId === pId);
            const projectHistory = d.history.filter(h => h._projectId === pId);
            const content = await Parser.serialize({ entries: projectEntries, history: projectHistory });
            await backend.saveProject(pId, content);
          }
        } else if (Storage.isConnected()) {
          const content = await Parser.serialize({ entries: d.entries, history: d.history });
          await Storage.save(content);
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
        if (status === 'done') it.progress = 100;
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
        const i = r.list.findIndex(x => x.id === id);
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
        const dragged = src.list[draggedIdx];
        src.list.splice(draggedIdx, 1);
        const newTargetIdx = tgt.list.findIndex(x => x.id === targetId);
        tgt.list.splice(newTargetIdx, 0, dragged);
        const histEntry = { timestamp: new Date().toISOString(), itemId: draggedId, action: 'item_reordered', details: `dropped before ${targetId}` };
        if (dragged._projectId) histEntry._projectId = dragged._projectId;
        d.history.unshift(histEntry);
      });
      triggerSave('Reordered', item?._projectId);
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
      setConfirm({
        title: 'Delete this item?',
        message: <>Delete <strong>{it.title}</strong>{childCount > 0 ? ` and ${childCount} sub-item${childCount > 1 ? 's' : ''}` : ''}?</>,
        detail: <span className="muted">This will be recorded in the history log.</span>,
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: () => {
          const projectId = it._projectId;
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

  const submitItemDialog = async (vals) => {
    if (vals.createAsProject && isMultiProject) {
      const safeName = vals.title.replace(/[^a-zA-Z0-9_-]/g, '-');
      try {
        const backend = storageMode === 'browser-multiproject' ? BrowserMultiProjectBackend : MultiProjectBackend;
        await backend.createProject(safeName);
        const projectsData = await backend.loadAll();
        setProjects(projectsData);
        const mergedData = buildMergedDataFromProjects(projectsData);
        setData(mergedData);
        setProjectExpandedMap(prev => ({ ...prev, [safeName]: true }));
        showToast(`Created project: ${safeName}`);
      } catch (e) {
        showToast('Failed to create project: ' + e.message, 'err');
      }
      setItemDialog(null);
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
      let targetProjectId = itemDialog.projectId || projects[0]?.id || null;
      
      mutate(d => {
        const node = { id: newId, level: 1, ...vals, children: [], collapsed: false };
        if (itemDialog.mode === 'add-child' && itemDialog.parentId) {
          const parent = findItem(d.entries, itemDialog.parentId);
          if (parent) {
            parent.children = parent.children || [];
            node.level = (parent.level || 1) + 1;
            if (parent._projectId) {
              node._projectId = parent._projectId;
              node._projectName = parent._projectName;
              targetProjectId = parent._projectId;
            }
            parent.children.push(node);
            setExpandedMap(m => ({ ...m, [parent.id]: true }));
          }
        } else {
          if (isMultiProject && targetProjectId) {
            node._projectId = targetProjectId;
            node._projectName = projects.find(p => p.id === targetProjectId)?.name;
          }
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
  const setProjectExpanded = (projectId, val) => setProjectExpandedMap(m => ({ ...m, [projectId]: val }));

  const tagsList = useMemoMain(() => allTags(data.entries),          [data]);
  const counts   = useMemoMain(() => countByStatus(data.entries),    [data]);

  const entriesByProject = useMemoMain(() => {
    if (!isMultiProject) return null;
    const grouped = {};
    for (const proj of projects) {
      grouped[proj.id] = { id: proj.id, name: proj.name, entries: [] };
    }
    for (const entry of data.entries) {
      const pId = entry._projectId;
      if (pId && grouped[pId]) {
        grouped[pId].entries.push(entry);
      }
    }
    return Object.values(grouped);
  }, [data.entries, projects, isMultiProject]);

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
  const handleImport = async ({ entries, history }) => {
    const projectIds = [...new Set(entries.map(e => e._projectId).filter(Boolean))];
    const hasProjectSections = projectIds.length > 0;
    
    if (hasProjectSections && !isMultiProject) {
      setIsMultiProject(true);
      setStorageMode('browser-multiproject');
      setWorkspaceName('Browser Storage');
      localStorage.setItem('multiProjectMode', 'browser-multiproject');
    }

    if (hasProjectSections || isMultiProject) {
      const backend = BrowserMultiProjectBackend;
      
      for (const pid of projectIds) {
        try { await backend.createProject(pid); } catch {}
      }
      
      if (projectIds.length === 0 && entries.length > 0) {
        const defaultProject = projects[0]?.id || 'default';
        try { await backend.createProject(defaultProject); } catch {}
        entries.forEach(e => { e._projectId = defaultProject; e._projectName = defaultProject; });
        history.forEach(h => { h._projectId = defaultProject; });
        projectIds.push(defaultProject);
      }

      for (const pid of projectIds) {
        const projectEntries = entries.filter(e => e._projectId === pid);
        const projectHistory = history.filter(h => h._projectId === pid);
        const content = await Parser.serialize({ entries: projectEntries, history: projectHistory });
        await backend.saveProject(pid, content);
      }
      
      const projectsData = await backend.loadAll();
      setProjects(projectsData);
      const mergedData = buildMergedDataFromProjects(projectsData);
      mergedData.history.unshift({ timestamp: new Date().toISOString(), itemId: 'system', action: 'imported', details: `${entries.length} top-level entries` });
      setData(mergedData);
      setImportExportOpen(false);
      showToast('Imported');
      return;
    }

    mutate(d => {
      d.entries = entries;
      if (history?.length) d.history = [...history, ...d.history];
      d.history.unshift({ timestamp: new Date().toISOString(), itemId: 'system', action: 'imported', details: `${entries.length} top-level entries` });
    });
    setImportExportOpen(false);
    triggerSave('Imported');
  };

  const saveLabel  = saveState.status === 'saving' ? 'Saving…'
                   : saveState.status === 'error'  ? 'Save failed'
                   : `Saved · ${fmtTimestamp(saveState.lastSaved)}`;
  const hasFilters = filters.text || filters.statuses?.length || filters.priorities?.length || filters.tags?.length || filters.dueRange;

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

      {storageMode === 'browser' && !isMultiProject && (
        <div className="banner info" style={{gap:8}}>
          <Icon name="folder" size={14}/>
          <span>
            Data saved in <strong>browser storage</strong> — persists until you clear site data.{' '}
            Use <em>Import/Export</em> to back up to a file.
          </span>
        </div>
      )}

      {needsConnect && !isMultiProject && (
        <div className="banner info">
          <Icon name="folder" size={14}/>
          <span style={{flex:1}}>
            Connect to a folder containing your <code className="mono">backlog.md</code> file.
          </span>
          <button className="btn-secondary" style={{flexShrink:0,fontSize:12,padding:'3px 10px',marginRight:8}}
            onClick={handleConnect}>Single file</button>
          <button className="btn-primary" style={{flexShrink:0,fontSize:12,padding:'3px 10px'}}
            onClick={handleConnectWorkspace}>Workspace (multi-project)</button>
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
                    {hasFilters ? <>{filteredCount} of {totalCount} items</> : <>{totalCount} items</>}
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
              ) : isMultiProject && entriesByProject ? (
                <div className="project-sections">
                  {entriesByProject.map(proj => {
                    const projFiltered = filterProjectEntries(proj.entries, filters, tweaks.sort_mode);
                    const isExpanded = projectExpandedMap[proj.id] !== false;
                    const itemCount = countAll(proj.entries);
                    return (
                      <div key={proj.id} className="project-section">
                        <div 
                          className={`project-section-header ${isExpanded ? 'expanded' : 'collapsed'}`}
                          onClick={() => setProjectExpanded(proj.id, !isExpanded)}
                        >
                          <span className="project-section-chevron">{isExpanded ? '▼' : '▶'}</span>
                          <span className="project-section-name">{proj.name}</span>
                          <span className="project-section-count">{itemCount} item{itemCount !== 1 ? 's' : ''}</span>
                          <div className="project-section-actions">
                            <button 
                              className="project-section-btn"
                              onClick={(e) => { e.stopPropagation(); onMutate.addRoot(proj.id); }}
                              title={`Add item to ${proj.name}`}
                            >
                              <Icon name="plus" size={11}/>
                            </button>
                            <button
                              className="project-section-btn"
                              onClick={(e) => { e.stopPropagation(); handleRenameProject(proj.id); }}
                              title="Rename project"
                            >
                              <Icon name="edit" size={11}/>
                            </button>
                            <button
                              className="project-section-btn project-section-btn-danger"
                              onClick={(e) => { e.stopPropagation(); handleRemoveProject(proj.id); }}
                              title="Remove project from workspace"
                            >
                              <Icon name="trash" size={11}/>
                            </button>
                          </div>
                        </div>
                        {isExpanded && (
                          <div className="project-section-content">
                            {projFiltered.length === 0 ? (
                              <div className="project-empty">No items in this project</div>
                            ) : (
                              <BacklogTree
                                items={projFiltered}
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
            </div>
          </section>
        </div>
      ) : (
        <AdminPage
          data={data}
          history={data.history}
          tweaks={tweaks}
          setTweak={setTweak}
          storageMode={storageMode}
          isMultiProject={isMultiProject}
          projectCount={projects.length}
          onEnableMultiProject={handleEnableBrowserMultiProject}
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
        />
      )}

      <ItemDialog
        open={!!itemDialog}
        mode={itemDialog?.mode}
        initial={itemDialog?.initial}
        recentTags={recentTags}
        onClose={() => setItemDialog(null)}
        onSubmit={submitItemDialog}
        isMultiProject={isMultiProject}
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

function Header({ view, setView, saveState, saveLabel, storageMode, searchValue, onSearch, onOpenImportExport }) {
  const modeIcon = storageMode === 'api' ? '⚡' : storageMode === 'direct' ? '📁' : storageMode === 'multiproject' ? '📂' : storageMode === 'browser-multiproject' ? '🗂️' : storageMode === 'browser' ? '🌐' : '💾';
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

window.App = App;
