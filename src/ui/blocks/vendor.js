  // ---------- lazy vendor loaders (cached promises) ----------
  let chartPromise = null;
  function loadChart() {
    if (window.Chart) return Promise.resolve(window.Chart);
    if (chartPromise) return chartPromise;
    chartPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/chart.umd.js';
      s.onload = () => (window.Chart ? resolve(window.Chart) : reject(new Error('Chart.js failed to load')));
      s.onerror = () => reject(new Error('Chart.js failed to load'));
      document.head.appendChild(s);
    });
    return chartPromise;
  }

  let mermaidPromise = null;
  function loadMermaid() {
    if (window.mermaid) return Promise.resolve(window.mermaid);
    if (mermaidPromise) return mermaidPromise;
    mermaidPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/mermaid.min.js';
      s.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error('Mermaid failed to load')));
      s.onerror = () => reject(new Error('Mermaid failed to load'));
      document.head.appendChild(s);
    });
    return mermaidPromise;
  }

  let vizPromise = null;
  function loadViz() {
    if (window.Viz) return Promise.resolve(window.Viz);
    if (vizPromise) return vizPromise;
    vizPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/viz-standalone.js';
      s.onload = () => (window.Viz ? resolve(window.Viz) : reject(new Error('Graphviz failed to load')));
      s.onerror = () => reject(new Error('Graphviz failed to load'));
      document.head.appendChild(s);
    });
    return vizPromise;
  }

