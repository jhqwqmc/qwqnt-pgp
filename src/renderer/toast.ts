const MAX_TOASTS = 5;
const FADE_MS = 250;
const timers = new Map<HTMLElement, number>();
let stack: HTMLElement | undefined;

function removeToast(element: HTMLElement): void {
  window.clearTimeout(timers.get(element));
  timers.delete(element);
  element.remove();
  if (timers.size === 0) {
    stack?.remove();
    stack = undefined;
  }
}

export function toast(text: string, timeout = 2600): void {
  if (!stack) {
    stack = document.createElement('div');
    stack.style.cssText = [
      'position:fixed', 'right:18px', 'bottom:90px', 'z-index:2147483647',
      'display:flex', 'flex-direction:column', 'align-items:flex-end', 'justify-content:flex-end',
      'gap:8px', 'max-width:min(420px,calc(100vw - 36px))',
      'max-height:max(0px,calc(100vh - 106px))', 'pointer-events:none'
    ].join(';');
    document.body.append(stack);
  }

  const element = document.createElement('div');
  element.setAttribute('role', 'status');
  element.style.cssText = [
    'box-sizing:border-box', 'flex-shrink:0', 'max-width:100%', 'overflow-wrap:anywhere',
    'padding:8px 14px', 'border-radius:8px', 'font-size:13px',
    'background:var(--bg_top_standard,var(--bg_bottom_standard,Canvas))',
    'color:var(--text_primary,CanvasText)',
    'box-shadow:var(--shadow_bg_middle_primary,0 4px 18px rgba(0,0,0,.3))',
    `transition:opacity ${FADE_MS}ms`
  ].join(';');
  stack.append(element);
  element.textContent = text;
  timers.set(element, window.setTimeout(() => {
    element.style.opacity = '0';
    timers.set(element, window.setTimeout(() => removeToast(element), FADE_MS));
  }, timeout));

  for (const oldest of timers.keys()) {
    if (timers.size <= MAX_TOASTS && stack.scrollHeight <= stack.clientHeight) break;
    if (oldest === element) break;
    removeToast(oldest);
  }
}
