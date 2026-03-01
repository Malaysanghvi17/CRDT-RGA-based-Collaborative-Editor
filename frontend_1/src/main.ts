import './style.css';
import { EditorService } from '../services/editor.service';
import {
  createRemoteCursorOverlay,
  getSharedCursorPosition,
  getUserColor,
  type RemoteCursor,
  type SharedCursorPosition,
} from '../utils/cursor.utils';

// ── Config ──────────────────────────────────────────────────────────────

const protocol = window.location.protocol === "https:" ? "wss" : "ws";
const WS_URL = `${protocol}://${window.location.host}`;
// const WS_URL = "http://localhost:8080/";

const HEALTH_CHECK_INTERVAL = 1000;

// ── Generate / load user ID ─────────────────────────────────────────────
function getUserId(): string {
  let id = localStorage.getItem('collab-user-id');
  if (!id) {
    id = 'user-' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem('collab-user-id', id);
  }
  return id;
}

function getDocumentIdFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('doc') || 'default';
}

// ── DOM references ───────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const textarea = $<HTMLTextAreaElement>('editor');
const editorContainer = $<HTMLDivElement>('editor-container');
const docTitle = $<HTMLSpanElement>('doc-title');
const statusEl = $<HTMLSpanElement>('connection-status');
const statusText = statusEl.querySelector('.status-text') as HTMLSpanElement;
const saveBtn = $<HTMLButtonElement>('save-btn');
const sidebar = $<HTMLElement>('sidebar');
const sidebarToggle = $<HTMLButtonElement>('sidebar-toggle');
const sidebarBackdrop = $<HTMLDivElement>('sidebar-backdrop');
const docList = $<HTMLUListElement>('doc-list');
const newDocBtn = $<HTMLButtonElement>('new-doc-btn');

// Nav tabs
const navTabs = document.querySelectorAll<HTMLButtonElement>('.nav-tab');
const pages = document.querySelectorAll<HTMLDivElement>('.page');

// ── State ────────────────────────────────────────────────────────────────
const userId = getUserId();
let currentDocId = getDocumentIdFromUrl();
let currentDocName = currentDocId;
let editorService: EditorService | null = null;
let healthInterval: ReturnType<typeof setInterval> | null = null;

// Track documents list for sidebar
interface DocEntry { id: string; name: string; }
let documents: DocEntry[] = [];

// ── Nav tab switching & Routing ────────────────────────────────────────────
navTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab!;
    const newRoute = `/${target}`;
    window.history.pushState({}, '', newRoute + window.location.search);
    initializeView(newRoute);
  });
});

window.addEventListener('popstate', () => {
  handleRouting();
});

let isAboutLoaded = false;
async function initializeView(route: string) {
  if (route.startsWith('/about')) {
    navTabs.forEach(t => t.classList.remove('active'));
    document.querySelector('[data-tab="about"]')?.classList.add('active');
    pages.forEach(p => p.classList.toggle('active', p.id === 'page-about'));

    if (!isAboutLoaded) {
      const aboutContainer = document.getElementById('about-content');
      if (aboutContainer) {
        try {
          const res = await fetch('/api/pages/about');
          if (res.ok) {
            const data = await res.json();
            aboutContainer.innerHTML = data.htmlContent;
            isAboutLoaded = true;
          } else {
            aboutContainer.innerHTML = '<p>Failed to load content.</p>';
          }
        } catch (e) {
          aboutContainer.innerHTML = '<p>Error loading content.</p>';
        }
      }
    }
  } else {
    // defaults to editor
    navTabs.forEach(t => t.classList.remove('active'));
    document.querySelector('[data-tab="editor"]')?.classList.add('active');
    pages.forEach(p => p.classList.toggle('active', p.id === 'page-editor'));
    // Make sure doc is in URL
    const url = new URL(window.location.href);
    if (!url.searchParams.has('doc')) {
      url.searchParams.set('doc', currentDocId);
      window.history.replaceState({}, '', url.toString());
    }
  }
}

async function handleRouting() {
  const path = window.location.pathname;
  if (path === '/' || path === '') {
    try {
      const res = await fetch('/api/pages/default');
      const data = await res.json();
      const defaultRoute = data.route || '/editor';
      window.history.replaceState({}, '', defaultRoute + window.location.search);
      initializeView(defaultRoute);
    } catch (e) {
      window.history.replaceState({}, '', '/editor' + window.location.search);
      initializeView('/editor');
    }
  } else {
    initializeView(path);
  }
}

// ── Mobile sidebar toggle ────────────────────────────────────────────────
function openSidebar() {
  sidebar.classList.add('open');
  sidebarBackdrop.classList.add('visible');
  sidebarBackdrop.style.display = 'block';
}

function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.remove('visible');
  setTimeout(() => { sidebarBackdrop.style.display = 'none'; }, 250);
}

sidebarToggle.addEventListener('click', () => {
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
});

sidebarBackdrop.addEventListener('click', closeSidebar);

// ── Sidebar: render document list ────────────────────────────────────────
function renderDocList() {
  docList.innerHTML = '';
  documents.forEach(doc => {
    const li = document.createElement('li');
    li.textContent = doc.name || doc.id;
    li.title = doc.id;
    if (doc.id === currentDocId) li.classList.add('active');

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'delete-doc-btn';
    delBtn.textContent = '×';
    delBtn.title = 'Delete document';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Delete "${doc.name || doc.id}"?`)) {
        editorService?.deleteDocument(doc.id);
      }
    });
    li.appendChild(delBtn);

    li.addEventListener('click', () => {
      if (doc.id === currentDocId) return;
      switchDocument(doc.id, doc.name || doc.id);
      closeSidebar();
    });
    docList.appendChild(li);
  });
}

// ── New document ─────────────────────────────────────────────────────────
newDocBtn.addEventListener('click', () => {
  const name = prompt('Document name:');
  if (!name || !name.trim()) return;
  const id = name.trim().toLowerCase().replace(/\s+/g, '-') + '-' + Date.now().toString(36);
  editorService?.createDocument(id, name.trim());
});

// ── Save ─────────────────────────────────────────────────────────────────
saveBtn.addEventListener('click', () => {
  editorService?.saveDocument();
});

// ── Connection health polling ────────────────────────────────────────────
function startHealthCheck() {
  if (healthInterval) clearInterval(healthInterval);
  healthInterval = setInterval(() => {
    const connected = editorService?.isWsConnected ?? false;
    if (connected) {
      statusEl.className = 'status connected';
      statusText.textContent = 'Connected';
    } else {
      statusEl.className = 'status disconnected';
      statusText.textContent = 'Disconnected';
    }
  }, HEALTH_CHECK_INTERVAL);
}

// ── Switch document ──────────────────────────────────────────────────────
function switchDocument(docId: string, docName: string) {
  // Destroy old service
  if (editorService) {
    editorService.destroy();
  }

  currentDocId = docId;
  currentDocName = docName;
  docTitle.textContent = docName;
  textarea.value = '';

  // Update URL without reload
  const url = new URL(window.location.href);
  url.searchParams.set('doc', docId);
  window.history.replaceState({}, '', url.toString());

  // Create new service
  initEditorService();
  renderDocList();
}

// ── Init EditorService + wire events ─────────────────────────────────────
function initEditorService() {
  editorService = new EditorService(userId, currentDocId, WS_URL);

  // ── Remote document update → push into textarea ──────────────────────
  editorService.setOnBeforeDocumentUpdate(() => {
    return {
      startAnchor: editorService!.getAnchorAtVisibleIndex(textarea.selectionStart - 1),
      endAnchor: editorService!.getAnchorAtVisibleIndex(textarea.selectionEnd - 1),
      direction: textarea.selectionDirection
    };
  });

  editorService.setOnDocumentUpdate((text: string, context?: any) => {
    let startAnchor = context?.startAnchor;
    let endAnchor = context?.endAnchor;
    let direction = context?.direction || 'none';

    if (!context) {
      startAnchor = editorService!.getAnchorAtVisibleIndex(textarea.selectionStart - 1);
      endAnchor = editorService!.getAnchorAtVisibleIndex(textarea.selectionEnd - 1);
      direction = textarea.selectionDirection;
    }

    textarea.value = text;

    const newStart = editorService!.getVisibleIndexFromAnchor(startAnchor) + 1;
    const newEnd = editorService!.getVisibleIndexFromAnchor(endAnchor) + 1;

    // Ensure valid ranges and restore
    textarea.setSelectionRange(
      Math.max(0, newStart),
      Math.max(0, newEnd),
      direction as any
    );

    // Update remote cursors too
    updateRemoteCursors();
  });

  // ── Remote cursor updates ────────────────────────────────────────────
  editorService.setOnCursorUpdate((cursors: Map<string, SharedCursorPosition>) => {
    const remoteCursors: RemoteCursor[] = [];
    cursors.forEach((pos, uid) => {
      if (uid !== userId) {
        remoteCursors.push({
          userId: uid,
          position: pos,
          color: getUserColor(uid),
        });
      }
    });
    createRemoteCursorOverlay(editorContainer, textarea, remoteCursors);
  });

  // ── Document list ────────────────────────────────────────────────────
  editorService.setOnDocumentsList((docs: any[]) => {
    documents = docs.map((d: any) => ({
      id: d.id || d.documentId || d,
      name: d.name || d.documentName || d.id || d.documentId || d,
    }));
    // Sync current document name if missing or updated
    const current = documents.find(d => d.id === currentDocId);
    if (current && current.name) {
      currentDocName = current.name;
      docTitle.textContent = currentDocName;
      docTitle.title = "Double click to rename";
    }
    renderDocList();
  });

  // ── Document created ─────────────────────────────────────────────────
  editorService.setOnDocumentCreated((docId: string, docName: string) => {
    // Add to our local list if not already there
    if (!documents.find(d => d.id === docId)) {
      documents.push({ id: docId, name: docName });
      renderDocList();
    }
    // Switch to the new document
    switchDocument(docId, docName);
  });

  // ── Document deleted ─────────────────────────────────────────────────
  editorService.setOnDocumentDeleted((docId: string) => {
    documents = documents.filter(d => d.id !== docId);
    renderDocList();
    // If we deleted the current doc, switch to first available or default
    if (docId === currentDocId) {
      if (documents.length > 0) {
        switchDocument(documents[0].id, documents[0].name);
      } else {
        switchDocument('default', 'Untitled');
      }
    }
  });

  // ── Document renamed ─────────────────────────────────────────────────
  editorService.setOnDocumentRenamed((docId: string, docName: string) => {
    const doc = documents.find(d => d.id === docId);
    if (doc) doc.name = docName;
    if (docId === currentDocId) {
      currentDocName = docName;
      docTitle.textContent = docName;
    }
    renderDocList();
  });

  // Request document list
  editorService.getDocuments();

  startHealthCheck();
}

// ── Remote cursor overlay helper ─────────────────────────────────────────
function updateRemoteCursors() {
  if (!editorService) return;
  // Force re-render of remote cursors by triggering the callback with cached data
  // (they get re-rendered on any document update)
}

// ── Local cursor broadcast ───────────────────────────────────────────────
function broadcastCursorPosition() {
  if (!editorService) return;
  const pos = getSharedCursorPosition(textarea);
  editorService.sendCursorPosition(pos);
}

// ── IME composition handling ─────────────────────────────────────────────
textarea.addEventListener('compositionstart', () => {
  editorService?.compositionStart();
});

textarea.addEventListener('compositionend', () => {
  editorService?.compositionEnd();
  // After composition ends, the textarea already has the final text.
  // Diff it into the CRDT.
  editorService?.handleTextChange(textarea.value);
  broadcastCursorPosition();
});

// ── Normal input (non-IME) ───────────────────────────────────────────────
textarea.addEventListener('input', () => {
  if (editorService?.isComposing) return;
  if (editorService?.isApplyingRemote) return;
  editorService?.handleTextChange(textarea.value);
  broadcastCursorPosition();
});

// ── Cursor position broadcast on selection changes ───────────────────────
textarea.addEventListener('mouseup', broadcastCursorPosition);
textarea.addEventListener('keyup', broadcastCursorPosition);

// Also listen for selectionchange at the document level (fires for all selection changes)
document.addEventListener('selectionchange', () => {
  if (document.activeElement === textarea) {
    broadcastCursorPosition();
  }
});

// ── Scroll → re-render remote cursors ────────────────────────────────────
textarea.addEventListener('scroll', () => {
  // Trigger a re-render of remote cursors on scroll since their pixel
  // positions depend on scrollTop.
  updateRemoteCursors();
});

textarea.addEventListener('beforeinput', (e: InputEvent) => {
  console.log("beforeinput", e.inputType, e.data);
});

// ── Bootstrap ────────────────────────────────────────────────────────────
docTitle.textContent = currentDocName;
docTitle.title = "Double click to rename";
docTitle.style.cursor = "pointer";

docTitle.addEventListener('dblclick', () => {
  const newName = prompt('Enter new document name:', currentDocName);
  if (newName && newName.trim() && newName.trim() !== currentDocName) {
    editorService?.renameDocument(currentDocId, newName.trim());
  }
});

initEditorService();
handleRouting();
