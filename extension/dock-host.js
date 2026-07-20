(function () {
  const DOCK_ID = 'scout-dock-root';
  const STORAGE_KEY = 'scoutDockWidth';

  function getDockWidth() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (r) => resolve(r[STORAGE_KEY] || 480));
    });
  }

  function setDockWidth(w) {
    chrome.storage.local.set({ [STORAGE_KEY]: w });
  }

  async function openDock() {
    if (document.getElementById(DOCK_ID)) {
      document.getElementById(DOCK_ID).style.display = 'block';
      return;
    }

    const width = await getDockWidth();
    const root = document.createElement('div');
    root.id = DOCK_ID;
    Object.assign(root.style, {
      position: 'fixed',
      top: '0',
      right: '0',
      height: '100vh',
      width: `${width}px`,
      zIndex: '2147483646',
      boxShadow: '-4px 0 24px rgba(0,0,0,0.45)',
      display: 'flex',
      background: '#0a0e14',
    });

    const resize = document.createElement('div');
    Object.assign(resize.style, {
      width: '6px',
      cursor: 'ew-resize',
      background: 'linear-gradient(90deg, transparent, #1d9bf055)',
      flexShrink: '0',
    });

    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('dock.html');
    Object.assign(iframe.style, {
      flex: '1',
      border: 'none',
      height: '100%',
      background: '#0a0e14',
    });

    let dragging = false;
    let startX = 0;
    let startW = width;

    resize.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startW = root.offsetWidth;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.min(860, Math.max(340, startW + (startX - e.clientX)));
      root.style.width = `${w}px`;
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      setDockWidth(root.offsetWidth);
    });

    window.addEventListener('message', (e) => {
      if (e.data?.type === 'SCOUT_CLOSE_DOCK') {
        root.style.display = 'none';
      }
      if (e.data?.type === 'SCOUT_RESIZE' && e.data.width) {
        root.style.width = `${e.data.width}px`;
        setDockWidth(e.data.width);
      }
    });

    root.appendChild(resize);
    root.appendChild(iframe);
    document.body.appendChild(root);
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type === 'OPEN_DOCK') {
      openDock().then(() => sendResponse({ ok: true }));
      return true;
    }
  });
})();
