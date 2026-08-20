// Stylish dialog primitives + concrete dialogs (Edit/Add Item, Confirm).

const { useState: useStateD, useEffect: useEffectD, useRef: useRefD, useCallback: useCallbackD } = React;

// ---- Rich Text Editor (lightweight WYSIWYG using contenteditable) ----
function RichTextEditor({ value, onChange, placeholder = "Add details...", collapsed = false, onExpand }) {
  const editorRef = useRefD(null);
  const [isExpanded, setIsExpanded] = useStateD(!collapsed || !!value);
  const [showCopyMenu, setShowCopyMenu] = useStateD(false);
  const [copyMenuPos, setCopyMenuPos] = useStateD({ x: 0, y: 0 });
  const toolbarRef = useRefD(null);
  const isEditingRef = useRefD(false);
  const initializedRef = useRefD(false);

  // Initialize editor content only when value changes externally (not from our own edits)
  useEffectD(() => {
    if (editorRef.current && value !== undefined && !isEditingRef.current) {
      const html = MarkdownUtils.toHtml(value || '');
      // Only set innerHTML on first load or when value is reset externally
      if (!initializedRef.current || editorRef.current.innerHTML === '') {
        editorRef.current.innerHTML = html;
        initializedRef.current = true;
      }
    }
  }, [value]);

  // Reset initialized flag when dialog closes/opens (value becomes null/undefined)
  useEffectD(() => {
    if (value === null || value === undefined) {
      initializedRef.current = false;
    }
  }, [value]);

  const handleInput = useCallbackD(() => {
    if (editorRef.current) {
      isEditingRef.current = true;
      const md = MarkdownUtils.toMarkdown(editorRef.current.innerHTML);
      onChange?.(md || null);
      // Reset editing flag after a short delay to allow state updates
      setTimeout(() => { isEditingRef.current = false; }, 100);
    }
  }, [onChange]);

  const execCmd = useCallbackD((cmd, val = null) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, val);
    handleInput();
  }, [handleInput]);

  const handleKeyDown = useCallbackD((e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      execCmd('insertText', '  ');
    }
    // Auto-convert "- " or "* " at line start to bullet list
    if (e.key === ' ') {
      const sel = window.getSelection();
      if (sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const node = range.startContainer;
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent;
          const offset = range.startOffset;
          // Check if cursor is right after "- " or "* " at line start
          if (offset === 1 && (text[0] === '-' || text[0] === '*')) {
            e.preventDefault();
            // Remove the "-" or "*" character
            node.textContent = text.slice(1);
            // Convert to bullet list
            execCmd('insertUnorderedList');
            return;
          }
          // Also check for "1. " to convert to numbered list
          if (offset === 2 && text[0] === '1' && text[1] === '.') {
            e.preventDefault();
            node.textContent = text.slice(2);
            execCmd('insertOrderedList');
            return;
          }
        }
      }
    }
    // Ctrl/Cmd + B/I/K shortcuts
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'b') { e.preventDefault(); execCmd('bold'); }
      if (e.key === 'i') { e.preventDefault(); execCmd('italic'); }
      if (e.key === 'k') { e.preventDefault(); insertLink(); }
    }
  }, [execCmd]);

  const insertLink = useCallbackD(() => {
    const url = prompt('Enter URL:');
    if (url) execCmd('createLink', url);
  }, [execCmd]);

  const insertImage = useCallbackD(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        execCmd('insertHTML', `<img src="${reader.result}" alt="${file.name}" class="rte-img">`);
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }, [execCmd]);

  const insertTable = useCallbackD(() => {
    const html = '<table class="rte-table"><thead><tr><th>Header 1</th><th>Header 2</th></tr></thead><tbody><tr><td>Cell 1</td><td>Cell 2</td></tr></tbody></table><p><br></p>';
    execCmd('insertHTML', html);
  }, [execCmd]);

  const insertCodeBlock = useCallbackD(() => {
    execCmd('insertHTML', '<pre class="rte-code-block"><code>code here</code></pre><p><br></p>');
  }, [execCmd]);

  const handleCopyMenu = useCallbackD((e) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    setCopyMenuPos({ x: rect.left, y: rect.bottom + 4 });
    setShowCopyMenu(true);
  }, []);

  const copyAs = useCallbackD(async (format) => {
    setShowCopyMenu(false);
    const html = editorRef.current?.innerHTML || '';
    const md = MarkdownUtils.toMarkdown(html);
    if (format === 'html') await ClipboardUtils.copyHtml(html, md);
    else if (format === 'markdown') await ClipboardUtils.copyMarkdown(md);
    else if (format === 'text') await ClipboardUtils.copyPlainText(html);
  }, []);

  const expand = useCallbackD(() => {
    setIsExpanded(true);
    onExpand?.();
    setTimeout(() => editorRef.current?.focus(), 50);
  }, [onExpand]);

  // Close copy menu on outside click
  useEffectD(() => {
    if (!showCopyMenu) return;
    const close = () => setShowCopyMenu(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [showCopyMenu]);

  if (!isExpanded) {
    return (
      <div className="rte-collapsed" onClick={expand}>
        <span className="rte-collapsed-placeholder">{placeholder}</span>
        <Icon name="plus" size={12} />
      </div>
    );
  }

  return (
    <div className="rte-wrap">
      <div className="rte-toolbar" ref={toolbarRef}>
        <button type="button" onClick={() => execCmd('bold')} title="Bold (Ctrl+B)"><strong>B</strong></button>
        <button type="button" onClick={() => execCmd('italic')} title="Italic (Ctrl+I)"><em>I</em></button>
        <span className="rte-toolbar-sep" />
        <button type="button" onClick={insertLink} title="Link (Ctrl+K)">
          <svg width="14" height="14" viewBox="0 0 20 20"><path d="M8 12l4-4M6 10l-1 1a3 3 0 0 0 4.24 4.24l1-1M14 10l1-1a3 3 0 0 0-4.24-4.24l-1 1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
        <span className="rte-toolbar-sep" />
        <button type="button" onClick={() => execCmd('formatBlock', 'h1')} title="Heading 1">H1</button>
        <button type="button" onClick={() => execCmd('formatBlock', 'h2')} title="Heading 2">H2</button>
        <button type="button" onClick={() => execCmd('formatBlock', 'h3')} title="Heading 3">H3</button>
        <span className="rte-toolbar-sep" />
        <button type="button" onClick={() => execCmd('insertUnorderedList')} title="Bullet list">
          <svg width="14" height="14" viewBox="0 0 20 20"><g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="8" y1="6" x2="17" y2="6"/><line x1="8" y1="10" x2="17" y2="10"/><line x1="8" y1="14" x2="17" y2="14"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="10" r="1" fill="currentColor"/><circle cx="4" cy="14" r="1" fill="currentColor"/></g></svg>
        </button>
        <button type="button" onClick={() => execCmd('insertOrderedList')} title="Numbered list">
          <svg width="14" height="14" viewBox="0 0 20 20"><g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="8" y1="6" x2="17" y2="6"/><line x1="8" y1="10" x2="17" y2="10"/><line x1="8" y1="14" x2="17" y2="14"/><text x="3" y="7" fontSize="5" fill="currentColor" stroke="none">1</text><text x="3" y="11" fontSize="5" fill="currentColor" stroke="none">2</text><text x="3" y="15" fontSize="5" fill="currentColor" stroke="none">3</text></g></svg>
        </button>
        <span className="rte-toolbar-sep" />
        <button type="button" onClick={insertCodeBlock} title="Code block">
          <svg width="14" height="14" viewBox="0 0 20 20"><g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="7,5 3,10 7,15"/><polyline points="13,5 17,10 13,15"/></g></svg>
        </button>
        <button type="button" onClick={insertTable} title="Table">
          <svg width="14" height="14" viewBox="0 0 20 20"><g fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="14" height="12" rx="1.5"/><line x1="3" y1="8" x2="17" y2="8"/><line x1="10" y1="8" x2="10" y2="16"/></g></svg>
        </button>
        <button type="button" onClick={insertImage} title="Image">
          <svg width="14" height="14" viewBox="0 0 20 20"><g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><rect x="3" y="4" width="14" height="12" rx="1.5"/><circle cx="7" cy="8" r="1.5"/><path d="M3 14l4-4 3 3 4-4 3 3"/></g></svg>
        </button>
        <span className="rte-toolbar-sep" />
        <button type="button" onClick={handleCopyMenu} title="Copy as..." className="rte-copy-btn">
          <Icon name="copy" size={12} />
          <svg width="8" height="8" viewBox="0 0 10 10"><polyline points="2,4 5,7 8,4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      </div>
      {showCopyMenu && (
        <div className="rte-copy-menu" style={{ left: copyMenuPos.x, top: copyMenuPos.y }}>
          <button type="button" onClick={() => copyAs('html')}>Copy for Docs/Word</button>
          <button type="button" onClick={() => copyAs('markdown')}>Copy as Markdown</button>
          <button type="button" onClick={() => copyAs('text')}>Copy as Plain Text</button>
        </div>
      )}
      <div
        ref={editorRef}
        className="rte-editor"
        contentEditable
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        data-placeholder={placeholder}
        onContextMenu={(e) => {
          // Allow default context menu but add copy options via showCopyMenu
        }}
      />
    </div>
  );
}

function Dialog({ open, onClose, children, width = 460, labelledBy }) {
  useEffectD(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="dlg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby={labelledBy} style={{ maxWidth: width }}>
        {children}
      </div>
    </div>
  );
}

function DialogHeader({ eyebrow, title, onClose, id }) {
  return (
    <div className="dlg-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h3 id={id} className="dlg-title">{title}</h3>
      </div>
      {onClose && (
        <button className="dlg-close" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
        </button>
      )}
    </div>
  );
}

// --- Item editor (used for both edit and add) ---
function ItemDialog({ open, mode, initial, onClose, onSubmit, recentTags = [] }) {
  const [title, setTitle] = useStateD("");
  const [body, setBody] = useStateD(null);
  const [priority, setPriority] = useStateD("P2");
  const [status, setStatus] = useStateD("open");
  const [due, setDue] = useStateD("");
  const [tags, setTags] = useStateD([]);
  const [tagInput, setTagInput] = useStateD("");
  const [reason, setReason] = useStateD("");
  const [progress, setProgress] = useStateD(0);
  const titleRef = useRefD(null);

  useEffectD(() => {
    if (!open) return;
    setTitle(initial?.title || "");
    setBody(initial?.body || null);
    setPriority(initial?.priority || "P2");
    setStatus(initial?.status || "open");
    setDue(initial?.due || "");
    setTags(initial?.tags || []);
    setTagInput("");
    setReason(initial?.reason || "");
    setProgress(initial?.progress ?? 0);
    setTimeout(() => titleRef.current?.focus(), 50);
  }, [open, initial]);

  const addTag = (t) => {
    const v = t.trim().replace(/^#/, "");
    if (!v) return;
    if (tags.includes(v)) return;
    setTags([...tags, v]);
  };
  const removeTag = (t) => setTags(tags.filter(x => x !== t));

  const submit = (e) => {
    e?.preventDefault();
    if (!title.trim()) return;
    // Reconcile progress with status before submitting.
    let outProgress = snapProgress(progress);
    if (status === "done") outProgress = 100;
    onSubmit({
      title: title.trim(),
      body: body || null,
      priority, status,
      due: due || null,
      tags,
      reason: status === "blocked" ? reason.trim() || null : null,
      progress: outProgress
    });
  };

  const tagSuggestions = recentTags.filter(t => !tags.includes(t)).slice(0, 8);

  return (
    <Dialog open={open} onClose={onClose} width={520} labelledBy="dlg-item-title">
      <form onSubmit={submit}>
        <DialogHeader
          id="dlg-item-title"
          eyebrow={mode === "edit" ? "Edit item" : (mode === "add-child" ? "Add sub-item" : "New item")}
          title={mode === "edit" ? "Edit details" : "Create item"}
          onClose={onClose}
        />

        <div className="dlg-body">
          <div className="field">
            <label className="field-label">Title</label>
            <input
              ref={titleRef}
              className="text-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to happen?"
              required
            />
          </div>

          <div className="field">
            <label className="field-label">Details <span className="field-hint">rich text, supports markdown</span></label>
            <RichTextEditor
              value={body}
              onChange={setBody}
              placeholder="Add notes, context, or details..."
              collapsed={!body}
            />
          </div>

          <div className="field-row">
            <div className="field">
              <label className="field-label">Priority</label>
              <div className="seg">
                {PRIORITIES.map(p => (
                  <button type="button" key={p}
                    className={`seg-btn pri-${p} ${priority === p ? "active" : ""}`}
                    onClick={() => setPriority(p)}>
                    {p === "P0" && <span className="p0-dot"/>}
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label className="field-label">Due</label>
              <input className="text-input" type="date" value={due} onChange={(e) => setDue(e.target.value)}/>
            </div>
          </div>

          <div className="field">
            <label className="field-label">Status</label>
            <div className="status-grid">
              {STATUSES.map(s => (
                <button type="button" key={s.key}
                  className={`status-card ${status === s.key ? "active" : ""}`}
                  onClick={() => setStatus(s.key)}>
                  <span className={`status-card-icon status-${s.key}`}>
                    <StatusIcon status={s.key} size={16}/>
                  </span>
                  <span className="status-card-label">{s.label}</span>
                </button>
              ))}
            </div>
          </div>

          {status !== "cancelled" && (
            <div className="field">
              <label className="field-label">
                Completion
                <span className="field-hint">
                  {status === "done"
                    ? "locked at 100% while marked done"
                    : "rough estimate — set 100% to mark done"}
                </span>
              </label>
              <div className="progress-row">
                <div className={`seg progress-seg ${status === "done" ? "locked" : ""}`}>
                  {PROGRESS_STEPS.map(p => (
                    <button type="button" key={p}
                      className={`seg-btn ${progress === p ? "active" : ""}`}
                      onClick={() => setProgress(p)}
                      disabled={status === "done"}>
                      {p}%
                    </button>
                  ))}
                </div>
                <ProgressGauge value={status === "done" ? 100 : progress} size="md"/>
              </div>
            </div>
          )}

          {status === "blocked" && (
            <div className="field">
              <label className="field-label">Block reason</label>
              <input className="text-input" value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Waiting for…"/>
            </div>
          )}

          <div className="field">
            <label className="field-label">Tags <span className="field-hint">type a name, press Enter or comma to add</span></label>
            <TagAutocompleteInput
              tags={tags}
              setTags={setTags}
              tagInput={tagInput}
              setTagInput={setTagInput}
              addTag={addTag}
              removeTag={removeTag}
              allTags={recentTags}
            />
          </div>
        </div>

        <div className="dlg-foot">
          <span className="dlg-hint">⌘↩ to save · Esc to cancel</span>
          <div className="dlg-foot-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={!title.trim()}>
              {mode === "edit" ? "Save changes" : "Create item"}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

// --- Confirm dialog ---
function ConfirmDialog({ open, title, message, detail, confirmLabel = "Confirm", danger = false, onCancel, onConfirm }) {
  return (
    <Dialog open={open} onClose={onCancel} width={420} labelledBy="dlg-confirm-title">
      <DialogHeader id="dlg-confirm-title" eyebrow="Confirm" title={title} onClose={onCancel}/>
      <div className="dlg-body">
        <p className="dlg-msg">{message}</p>
        {detail && <div className="dlg-detail">{detail}</div>}
      </div>
      <div className="dlg-foot">
        <span/>
        <div className="dlg-foot-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button type="button"
            className={danger ? "btn-danger" : "btn-primary"}
            onClick={onConfirm} autoFocus>{confirmLabel}</button>
        </div>
      </div>
    </Dialog>
  );
}

// --- Tag autocomplete (typed input + filtered dropdown) ---
function TagAutocompleteInput({ tags, setTags, tagInput, setTagInput, addTag, removeTag, allTags }) {
  const [focused, setFocused] = useStateD(false);
  const [highlighted, setHighlighted] = useStateD(0);
  const inputRef = useRefD(null);
  const wrapRef = useRefD(null);

  const q = tagInput.trim().toLowerCase().replace(/^#/, "");
  // suggestions: filter out already-applied; rank exact prefix > contains
  const pool = (allTags || []).filter(t => !tags.includes(t));
  let suggestions;
  if (q) {
    const starts = pool.filter(t => t.toLowerCase().startsWith(q));
    const contains = pool.filter(t => !t.toLowerCase().startsWith(q) && t.toLowerCase().includes(q));
    suggestions = [...starts, ...contains].slice(0, 8);
  } else {
    suggestions = pool.slice(0, 8); // recents
  }
  const exactMatch = q && pool.some(t => t.toLowerCase() === q);
  const showCreate = q && !exactMatch && !tags.includes(q);
  // index 0 = "create new" (if shown), then suggestions
  const items = [
    ...(showCreate ? [{ kind: "create", value: q }] : []),
    ...suggestions.map(t => ({ kind: "suggestion", value: t }))
  ];

  useEffectD(() => { setHighlighted(0); }, [tagInput, focused]);

  const pick = (it) => {
    if (!it) return;
    addTag(it.value);
    setTagInput("");
    setHighlighted(0);
  };

  const onKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length) setHighlighted((h) => (h + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length) setHighlighted((h) => (h - 1 + items.length) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (items[highlighted]) pick(items[highlighted]);
      else if (tagInput.trim()) { addTag(tagInput); setTagInput(""); }
    } else if (e.key === "," || e.key === "Tab") {
      if (tagInput.trim()) {
        e.preventDefault();
        if (items[highlighted]) pick(items[highlighted]);
        else { addTag(tagInput); setTagInput(""); }
      }
    } else if (e.key === "Backspace" && !tagInput && tags.length) {
      removeTag(tags[tags.length - 1]);
    } else if (e.key === "Escape") {
      if (tagInput) { setTagInput(""); e.preventDefault(); }
      else inputRef.current?.blur();
    }
  };

  return (
    <div className="tag-ac" ref={wrapRef}>
      <div className={`tag-input ${focused ? "focused" : ""}`} onClick={(e) => {
        if (e.target === e.currentTarget) inputRef.current?.focus();
      }}>
        {tags.map(t => (
          <span key={t} className="tag-pill">
            #{t}
            <button type="button" onClick={() => removeTag(t)} aria-label={`Remove ${t}`}>×</button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="tag-input-field"
          placeholder={tags.length ? "+ add tag" : "e.g. urgent, frontend, errand"}
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={onKey}
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={focused && items.length > 0}
        />
      </div>

      {focused && items.length > 0 && (
        <div className="tag-ac-pop" role="listbox">
          {!q && (
            <div className="tag-ac-cap">Recent</div>
          )}
          {items.map((it, i) => (
            <button
              key={`${it.kind}-${it.value}`}
              type="button"
              role="option"
              aria-selected={i === highlighted}
              className={`tag-ac-item ${i === highlighted ? "highlighted" : ""} ${it.kind === "create" ? "create" : ""}`}
              onMouseEnter={() => setHighlighted(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(it); }}
            >
              {it.kind === "create" ? (
                <>
                  <Icon name="plus" size={11}/>
                  <span>Create <strong>#{it.value}</strong></span>
                </>
              ) : (
                <span>{q ? <TagMatchHL text={it.value} match={q}/> : `#${it.value}`}</span>
              )}
            </button>
          ))}
          <div className="tag-ac-foot">
            <span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span>
            <span><kbd>↵</kbd> to add</span>
            <span><kbd>esc</kbd> to dismiss</span>
          </div>
        </div>
      )}
    </div>
  );
}

function TagMatchHL({ text, match }) {
  const i = text.toLowerCase().indexOf(match);
  if (i < 0) return `#${text}`;
  return (
    <>
      #{text.slice(0, i)}<span className="hl">{text.slice(i, i + match.length)}</span>{text.slice(i + match.length)}
    </>
  );
}

window.Dialog = Dialog;
window.ItemDialog = ItemDialog;
window.ConfirmDialog = ConfirmDialog;
window.RichTextEditor = RichTextEditor;
