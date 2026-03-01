export interface SharedCursorPosition {
  index: number; // Cursor index in the shared document text
}

export interface RemoteCursor {
  userId: string;
  position: SharedCursorPosition;
  color: string;
}

const CURSOR_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', 
  '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'
];

interface CursorPixelPosition {
  x: number;
  y: number;
  height: number;
}

export function getSharedCursorPosition(
  textarea: HTMLTextAreaElement
): SharedCursorPosition {
  return { index: textarea.selectionStart };
}

function clampIndex(index: number, textLength: number): number {
  return Math.max(0, Math.min(textLength, index));
}

function getCursorPixelPosition(
  textarea: HTMLTextAreaElement,
  sharedPosition: SharedCursorPosition
): CursorPixelPosition {
  const style = window.getComputedStyle(textarea);
  const cursorIndex = clampIndex(sharedPosition.index, textarea.value.length);

  const mirror = document.createElement('div');
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.pointerEvents = 'none';
  mirror.style.left = '-99999px';
  mirror.style.top = '0';
  mirror.style.boxSizing = 'border-box';
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.height = 'auto';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.wordBreak = 'break-word';
  mirror.style.font = style.font;
  mirror.style.letterSpacing = style.letterSpacing;
  mirror.style.lineHeight = style.lineHeight;
  mirror.style.padding = style.padding;
  mirror.style.tabSize = style.tabSize;
  mirror.style.textTransform = style.textTransform;
  mirror.style.textIndent = style.textIndent;
  mirror.style.direction = style.direction;
  mirror.style.textAlign = style.textAlign;

  mirror.textContent = textarea.value.slice(0, cursorIndex);

  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  mirror.appendChild(marker);

  document.body.appendChild(mirror);

  const markerRect = marker.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();

  const rawLineHeight = Number.parseFloat(style.lineHeight);
  const cursorHeight = Number.isFinite(rawLineHeight) ? rawLineHeight : markerRect.height;
  const x = markerRect.left - mirrorRect.left - textarea.scrollLeft;
  const y = markerRect.top - mirrorRect.top - textarea.scrollTop;

  document.body.removeChild(mirror);

  return { x, y, height: Math.max(14, cursorHeight) };
}

export function createRemoteCursorOverlay(
  container: HTMLElement,
  textarea: HTMLTextAreaElement,
  cursors: RemoteCursor[]
): void {
  // Remove existing cursors
  container.querySelectorAll('.remote-cursor').forEach(el => el.remove());
  
  const rect = textarea.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  
  cursors.forEach((cursor) => {
    const projectedPosition = getCursorPixelPosition(textarea, cursor.position);
    const x = projectedPosition.x;
    const y = projectedPosition.y;

    // Only show cursor if it is within the current viewport of the textarea
    if (y + projectedPosition.height < -10 || y > textarea.clientHeight + 10) return;
    
    const cursorEl = document.createElement('div');
    cursorEl.className = 'remote-cursor';
    cursorEl.style.position = 'absolute';
    cursorEl.style.left = `${rect.left - containerRect.left + x}px`;
    cursorEl.style.top = `${rect.top - containerRect.top + y}px`;
    cursorEl.style.width = '2px';
    cursorEl.style.height = `${projectedPosition.height}px`;
    cursorEl.style.backgroundColor = cursor.color;
    cursorEl.style.pointerEvents = 'none';
    cursorEl.style.zIndex = '10';
    
    const label = document.createElement('div');
    label.textContent = cursor.userId;
    label.style.position = 'absolute';
    label.style.top = '-20px';
    label.style.left = '0';
    label.style.fontSize = '10px';
    label.style.backgroundColor = cursor.color;
    label.style.color = 'white';
    label.style.padding = '2px 4px';
    label.style.borderRadius = '3px';
    label.style.whiteSpace = 'nowrap';
    
    cursorEl.appendChild(label);
    container.appendChild(cursorEl);
  });
}

export function getUserColor(userId: string): string {
  const hash = userId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}
