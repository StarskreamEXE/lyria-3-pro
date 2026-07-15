import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Reusable, imperative right-click context menu. One singleton host mounted once
// (see <ContextMenuHost /> below, rendered at the app root) — call showContextMenu()
// from anywhere to pop it open at the cursor. No external library; portaled to
// document.body so it always paints above panel-local overflow/stacking contexts.

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

type Listener = (state: MenuState | null) => void;
let listener: Listener | null = null;

// Imperative helper — the only thing call sites need to import besides the host.
export function showContextMenu(e: MouseEvent | React.MouseEvent, items: ContextMenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  const clientX = 'clientX' in e ? e.clientX : 0;
  const clientY = 'clientY' in e ? e.clientY : 0;
  listener?.({ x: clientX, y: clientY, items });
}

export function hideContextMenu() {
  listener?.(null);
}

const MENU_WIDTH = 200;
const MENU_MARGIN = 8;

// Mount this once near the app root (e.g. in App.tsx, alongside other singleton
// overlays). Every call to showContextMenu() from anywhere in the tree renders here.
export function ContextMenuHost() {
  const [state, setState] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listener = setState;
    return () => {
      if (listener === setState) listener = null;
    };
  }, []);

  useEffect(() => {
    if (!state) return;
    const close = () => setState(null);
    const closeOnKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setState(null);
    };
    // pointerdown (not click) so the same right-click that opens a menu over empty
    // space doesn't immediately close it; a fresh pointerdown anywhere closes it.
    window.addEventListener('pointerdown', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', closeOnKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', closeOnKey);
      window.removeEventListener('blur', close);
    };
  }, [state]);

  if (!state) return null;

  // Clamp to viewport so a right-click near an edge never renders off-screen.
  const estimatedHeight = state.items.length * 30 + 8;
  const x = Math.min(state.x, window.innerWidth - MENU_WIDTH - MENU_MARGIN);
  const y = Math.min(state.y, window.innerHeight - estimatedHeight - MENU_MARGIN);

  return createPortal(
    <div
      ref={menuRef}
      // Stop the pointerdown-closes-menu listener above from firing when the click
      // originates inside the menu itself — item buttons handle their own close.
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      role="menu"
      // z-50: top of the app's 10/20/40/50 stacking scale — above the sidebar popouts
      // (z-40) and peers with the model dropdown (z-50), which it always paints over
      // because this portal is appended to <body> last.
      style={{ position: 'fixed', left: Math.max(MENU_MARGIN, x), top: Math.max(MENU_MARGIN, y), width: MENU_WIDTH, zIndex: 50 }}
      className="bg-[#110e0c] border border-lyria-border rounded-lg shadow-[0_15px_40px_rgba(0,0,0,0.6)] py-1 overflow-hidden"
    >
      {state.items.map((item, i) => (
        <button
          key={`${item.label}-${i}`}
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onClick();
            setState(null);
          }}
          role="menuitem"
          className={`w-full text-left px-3 py-1.5 text-[11px] tracking-wide transition-colors duration-150 lyria-focus-ring ${
            item.disabled
              ? 'text-lyria-text-muted cursor-not-allowed'
              : item.danger
                ? 'text-lyria-signal hover:bg-lyria-signal/10 cursor-pointer'
                : 'text-lyria-text-main hover:bg-lyria-gold/10 hover:text-lyria-gold cursor-pointer'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
