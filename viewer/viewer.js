// Lightweight book-style PDF viewer: renders only the current page (or spread)
// plus its neighbours, so long PDFs stay smooth.
(() => {
    'use strict';

    const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';

    const FILE = document.body.dataset.pdf;
    const STORE_KEY = 'pdfviewer:' + FILE;
    // Printed page number = PDF page − OFFSET; earlier pages get roman numerals.
    const OFFSET = +document.body.dataset.offset || 0;
    const PAD = 16, GAP = 0;          // must match #spread padding / #sheet gap in CSS
    const MIN_ZOOM = 0.2, MAX_ZOOM = 8;
    const MAX_PIXELS = 16e6;          // canvas size cap (iOS limit is ~16.7M)
    const SUPERSAMPLE = 2;            // render sharper than the screen, then downscale…
    const SUPERSAMPLE_PIXELS = 7e6;   // …but only while the canvas stays under this size
    const CACHE_PAGES = 10;           // rendered pages kept in memory

    const ICON = {
        menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
        prev: '<path d="M15 18l-6-6 6-6"/>',
        next: '<path d="M9 18l6-6-6-6"/>',
        zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35M8 11h6"/>',
        zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35M8 11h6M11 8v6"/>',
        fitPage: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M12 7v10M9.5 9.5L12 7l2.5 2.5M9.5 14.5L12 17l2.5-2.5"/>',
        fitWidth: '<path d="M3 4v16M21 4v16M7 12h10M10 9l-3 3 3 3M14 9l3 3-3 3"/>',
        single: '<rect x="6" y="3" width="12" height="18" rx="2"/>',
        double: '<path d="M2 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H2zM22 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z"/>',
        full: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
    };
    const svg = name => `<svg viewBox="0 0 24 24">${ICON[name]}</svg>`;

    document.getElementById('app').innerHTML = `
        <div class="bar">
            <button class="ic" id="sideBtn" title="Contents / pages (T)">${svg('menu')}</button>
            <div class="title"></div>
            <div class="group page-group">
                <button class="ic" id="prevBtn" title="Previous (←)">${svg('prev')}</button>
                <label class="pagebox"><input id="pageInput" inputmode="numeric" autocomplete="off" aria-label="Page"><span id="pageCount"></span></label>
                <button class="ic" id="nextBtn" title="Next (→)">${svg('next')}</button>
            </div>
            <div class="sep hide-narrow"></div>
            <div class="group">
                <button class="ic hide-narrow" id="zoomOutBtn" title="Zoom out (−)">${svg('zoomOut')}</button>
                <button class="zoomlabel hide-narrow" id="zoomLabel" title="Reset zoom (0)"></button>
                <button class="ic hide-narrow" id="zoomInBtn" title="Zoom in (+)">${svg('zoomIn')}</button>
                <button class="ic" id="fitBtn"></button>
                <button class="ic" id="spreadBtn"></button>
                <button class="ic hide-narrow" id="fullBtn" title="Fullscreen (F)">${svg('full')}</button>
            </div>
        </div>
        <div class="progress"><div id="progress"></div></div>
        <div class="main">
            <aside class="side" id="side" hidden>
                <div class="tabs" id="tabs" hidden>
                    <button data-tab="outline" class="on">Contents</button>
                    <button data-tab="thumbs">Pages</button>
                </div>
                <div class="panel outline" id="outlinePanel" hidden></div>
                <div class="panel" id="thumbPanel"><div class="thumbs" id="thumbs"></div></div>
            </aside>
            <div class="view">
                <div id="stage" tabindex="0"><div id="spread"><div id="sheet"></div></div></div>
                <button class="flip prev" id="flipPrev" title="Previous">${svg('prev')}</button>
                <button class="flip next" id="flipNext" title="Next">${svg('next')}</button>
                <div class="msg" id="msg">Loading…</div>
            </div>
        </div>`;

    const $ = id => document.getElementById(id);
    const stage = $('stage'), spreadEl = $('spread');
    document.querySelector('.title').textContent = document.title;

    // ---------- state ----------

    let pdf = null, numPages = 0;
    let cur = 1;                 // first page of the visible spread
    let twoUp = false;
    let zoom = 'page';           // 'page' | 'width' | number (absolute scale)
    let scale = 1;               // scale actually in use
    let slots = [];              // [{n, el}] for visible pages
    let gen = 0;                 // bumps on every navigation / zoom render

    const sizes = [];            // sizes[n] = {w, h} at scale 1
    const pageProms = new Map(); // n -> Promise<PDFPageProxy>
    const rendered = new Map();  // n -> {r, canvas}   (insertion order = LRU)
    const tasks = new Map();     // n -> {r, task, promise}

    const prefs = (() => { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } })();
    const savePrefs = () => {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify({
                page: cur, twoUp, zoom: typeof zoom === 'string' ? zoom : 'page',
            }));
        } catch { /* storage unavailable */ }
    };

    // ---------- helpers ----------

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const dpr = () => window.devicePixelRatio || 1;
    const sizeOf = n => sizes[n] || sizes[1] || { w: 595, h: 842 };

    const ROMAN = ['', 'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii'];
    const label = n => n > OFFSET ? String(n - OFFSET) : (ROMAN[n] || String(n));
    function fromLabel(v) {
        v = String(v).trim().toLowerCase();
        if (/^\d+$/.test(v)) return +v + OFFSET;
        const i = ROMAN.indexOf(v);
        return i > 0 ? i : NaN;
    }

    function getPage(n) {
        if (!pageProms.has(n)) {
            pageProms.set(n, pdf.getPage(n).then(p => {
                const v = p.getViewport({ scale: 1 });
                const known = sizes[n];
                sizes[n] = { w: v.width, h: v.height };
                if (!known && slots.some(s => s.n === n)) layout();
                return p;
            }));
        }
        return pageProms.get(n);
    }

    // Book layout: cover on its own, then 2–3, 4–5, ...
    function spreadOf(p) {
        if (!twoUp || p === 1) return [p];
        const left = p % 2 === 0 ? p : p - 1;
        return left + 1 <= numPages ? [left, left + 1] : [left];
    }
    const nextStart = p => { const s = spreadOf(p); return s[s.length - 1] + 1; };
    const prevStart = p => spreadOf(p)[0] > 1 ? spreadOf(spreadOf(p)[0] - 1)[0] : null;

    function fitScales(ns) {
        const w = ns.reduce((a, n) => a + sizeOf(n).w, 0) + GAP * (ns.length - 1);
        const h = Math.max(...ns.map(n => sizeOf(n).h));
        const sw = stage.clientWidth - 2 * PAD, sh = stage.clientHeight - 2 * PAD;
        return { page: Math.max(0.05, Math.min(sw / w, sh / h)), width: Math.max(0.05, sw / w) };
    }
    const scaleFor = ns => typeof zoom === 'number' ? zoom : fitScales(ns)[zoom];

    // Device pixel ratio to render at for page n at CSS scale s (capped).
    // Renders up to 2× the screen resolution (within a pixel budget) and lets the
    // browser downscale, which keeps small text crisp at fit-to-window sizes.
    function renderRatio(n, s) {
        const { w, h } = sizeOf(n);
        const base = s * dpr();
        let r = Math.max(base, Math.min(base * SUPERSAMPLE, Math.sqrt(SUPERSAMPLE_PIXELS / (w * h))));
        if (w * h * r * r > MAX_PIXELS) r = Math.sqrt(MAX_PIXELS / (w * h));
        return Math.round(r * 1000) / 1000;
    }

    // ---------- rendering ----------

    function remember(n, entry) {
        const old = rendered.get(n);
        if (old && old.canvas !== entry.canvas && !slots.some(s => s.el.contains(old.canvas))) old.canvas.width = 0;
        rendered.delete(n);
        rendered.set(n, entry);
        const keep = new Set(slots.map(s => s.n));
        for (const [k, v] of rendered) {
            if (rendered.size <= CACHE_PAGES) break;
            if (keep.has(k)) continue;
            v.canvas.width = 0; // release memory
            rendered.delete(k);
        }
    }

    function ensureRender(n, s) {
        const r = renderRatio(n, s);
        const done = rendered.get(n);
        if (done && done.r === r) return Promise.resolve(done.canvas);
        const running = tasks.get(n);
        if (running) {
            if (running.r === r) return running.promise;
            running.task && running.task.cancel();
            tasks.delete(n);
        }
        const job = { r, task: null, promise: null };
        job.promise = getPage(n).then(page => {
            if (tasks.get(n) !== job) throw new Error('stale');
            const vp = page.getViewport({ scale: r });
            const canvas = document.createElement('canvas');
            canvas.width = Math.floor(vp.width);
            canvas.height = Math.floor(vp.height);
            job.task = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp });
            return job.task.promise.then(() => {
                if (tasks.get(n) === job) tasks.delete(n);
                remember(n, { r, canvas });
                return canvas;
            });
        });
        job.promise.catch(() => { if (tasks.get(n) === job) tasks.delete(n); });
        tasks.set(n, job);
        return job.promise;
    }

    function attach(n, canvas) {
        const slot = slots.find(s => s.n === n);
        if (!slot) return;
        const old = slot.el.querySelector('canvas');
        if (old !== canvas) old ? old.replaceWith(canvas) : slot.el.prepend(canvas);
        slot.el.classList.remove('loading');
    }

    function buildSlots() {
        const ns = spreadOf(cur);
        slots = ns.map(n => {
            const el = document.createElement('div');
            el.className = 'page';
            const cached = rendered.get(n);
            if (cached) el.appendChild(cached.canvas); else el.classList.add('loading');
            const slot = { n, el };
            addContentsLinks(slot);
            return slot;
        });
        $('sheet').replaceChildren(...slots.map(s => s.el));
    }

    // ---------- clickable contents pages ----------

    const linkCache = new Map(); // n -> Promise<[{x, y, w, h, target}]> in scale-1 units

    // Finds contents-style lines ("Cells ........ 4") on the front pages and
    // returns a clickable box for each, pointing at the printed page number.
    function contentsLinks(n) {
        if (n > OFFSET) return Promise.resolve([]);
        if (!linkCache.has(n)) linkCache.set(n, getPage(n).then(async page => {
            const vp = page.getViewport({ scale: 1 });
            const { items } = await page.getTextContent();
            const rows = new Map();
            for (const it of items) {
                if (!it.str.trim()) continue;
                const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
                const col = x < vp.width / 2 ? 0 : 1;
                const key = col + ':' + Math.round(y);
                if (!rows.has(key)) rows.set(key, { col, y, items: [] });
                rows.get(key).items.push({ x, w: it.width, h: it.height, str: it.str });
            }
            const links = [];
            for (const col of [0, 1]) {
                const lines = [...rows.values()].filter(r => r.col === col).sort((a, b) => a.y - b.y);
                let pending = []; // heading / wrapped lines that belong to the next numbered line
                for (const r of lines) {
                    r.items.sort((a, b) => a.x - b.x);
                    r.h = Math.max(...r.items.map(i => i.h));
                    r.x0 = r.items[0].x;
                    r.x1 = Math.max(...r.items.map(i => i.x + i.w));
                    const last = pending[pending.length - 1];
                    if (last && r.y - last.y > 1.8 * r.h) pending = [];
                    const m = r.items.map(i => i.str).join('').match(/\.{2,}\s*(\d[\d ]*)\s*$/);
                    if (!m) { pending.push(r); continue; }
                    const group = [...pending, r];
                    pending = [];
                    const x0 = Math.min(...group.map(g => g.x0)), x1 = Math.max(...group.map(g => g.x1));
                    const y0 = group[0].y - group[0].h, y1 = r.y + r.h * 0.3;
                    links.push({ x: x0 - 3, y: y0, w: x1 - x0 + 6, h: y1 - y0, target: +m[1].replace(/ /g, '') });
                }
            }
            return links;
        }).catch(() => []));
        return linkCache.get(n);
    }

    function addContentsLinks(slot) {
        contentsLinks(slot.n).then(links => {
            if (!links.length || !slots.includes(slot)) return;
            const { w, h } = sizeOf(slot.n);
            const layer = document.createElement('div');
            layer.className = 'links';
            for (const l of links) {
                const a = document.createElement('a');
                a.title = 'Go to page ' + l.target;
                a.style.cssText = `left:${l.x / w * 100}%;top:${l.y / h * 100}%;width:${l.w / w * 100}%;height:${l.h / h * 100}%`;
                a.onclick = () => goTo(l.target + OFFSET);
                layer.appendChild(a);
            }
            slot.el.appendChild(layer);
        });
    }

    function layout() {
        if (!pdf) return;
        const ns = slots.map(s => s.n);
        scale = clamp(scaleFor(ns), 0.05, MAX_ZOOM);
        for (const s of slots) {
            const { w, h } = sizeOf(s.n);
            s.el.style.width = Math.round(w * scale) + 'px';
            s.el.style.height = Math.round(h * scale) + 'px';
        }
        updateZoomUI();
    }

    async function renderVisible() {
        const my = ++gen;
        const ns = slots.map(s => s.n);
        await Promise.all(ns.map(n =>
            ensureRender(n, scale).then(c => { if (my === gen) attach(n, c); }, () => {})
        ));
        if (my !== gen) return;
        // Prefetch neighbouring spreads so flipping is instant.
        for (const start of [nextStart(cur), prevStart(cur)]) {
            if (!start || start > numPages) continue;
            const nb = spreadOf(start), s = clamp(scaleFor(nb), 0.05, MAX_ZOOM);
            for (const n of nb) {
                if (my !== gen) return;
                await ensureRender(n, s).catch(() => {});
            }
        }
    }

    let renderTimer = 0;
    function scheduleRender(delay = 150) {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(renderVisible, delay);
    }

    // ---------- navigation ----------

    function goTo(p, { atEnd = false, force = false } = {}) {
        if (!pdf) return;
        p = spreadOf(clamp(Math.round(p) || 1, 1, numPages))[0];
        if (p === cur && !force) return;
        cur = p;
        // Cancel renders for pages we've moved away from.
        const wanted = new Set([...spreadOf(cur), ...spreadOf(Math.min(nextStart(cur), numPages)),
            ...(prevStart(cur) ? spreadOf(prevStart(cur)) : [])]);
        for (const [n, job] of tasks) if (!wanted.has(n)) { job.task && job.task.cancel(); tasks.delete(n); }
        buildSlots();
        layout();
        stage.scrollTop = atEnd ? stage.scrollHeight : 0;
        stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
        clearTimeout(renderTimer);
        renderVisible();
        updatePageUI();
        savePrefs();
        history.replaceState(null, '', '#page=' + label(cur));
    }
    const next = () => { const n = nextStart(cur); if (n <= numPages) goTo(n); };
    const prev = (atEnd = false) => { const p = prevStart(cur); if (p) goTo(p, { atEnd }); };

    // ---------- zoom ----------

    function setZoom(z, cx, cy) {
        const rect = stage.getBoundingClientRect();
        if (cx === undefined) { cx = rect.left + stage.clientWidth / 2; cy = rect.top + stage.clientHeight / 2; }
        const before = spreadEl.getBoundingClientRect();
        const fx = (cx - before.left) / before.width, fy = (cy - before.top) / before.height;
        zoom = typeof z === 'number' ? clamp(z, MIN_ZOOM, MAX_ZOOM) : z;
        layout();
        const after = spreadEl.getBoundingClientRect();
        stage.scrollLeft += after.left + fx * after.width - cx;
        stage.scrollTop += after.top + fy * after.height - cy;
        scheduleRender();
        savePrefs();
    }
    const zoomBy = (f, cx, cy) => setZoom(scale * f, cx, cy);

    // ---------- UI state ----------

    function updatePageUI() {
        const ns = spreadOf(cur);
        if (document.activeElement !== $('pageInput')) $('pageInput').value = label(cur);
        $('pageCount').textContent = (ns.length > 1 ? `–${label(ns[1])} ` : '') + `/ ${numPages - OFFSET}`;
        const atStart = !prevStart(cur), atEnd = nextStart(cur) > numPages;
        $('prevBtn').disabled = $('flipPrev').disabled = atStart;
        $('nextBtn').disabled = $('flipNext').disabled = atEnd;
        $('progress').style.width = (ns[ns.length - 1] / numPages * 100) + '%';
        document.querySelectorAll('.thumb.on').forEach(t => t.classList.remove('on'));
        ns.forEach(n => { const t = thumbEls[n - 1]; t && t.classList.add('on'); });
    }

    function updateZoomUI() {
        $('zoomLabel').textContent = Math.round(scale * 100) + '%';
        const fit = $('fitBtn');
        const width = zoom === 'width';
        fit.innerHTML = svg(width ? 'fitWidth' : 'fitPage');
        fit.title = width ? 'Fit width (W) – click for fit page' : 'Fit page (0) – click for fit width';
        fit.classList.toggle('on', typeof zoom === 'string');
        const sp = $('spreadBtn');
        sp.innerHTML = svg(twoUp ? 'double' : 'single');
        sp.title = twoUp ? 'Two pages (D) – click for one' : 'One page (D) – click for two';
        sp.classList.toggle('on', twoUp);
        stage.classList.toggle('grab', stage.scrollWidth > stage.clientWidth + 1 || stage.scrollHeight > stage.clientHeight + 1);
    }

    function setTwoUp(on) {
        twoUp = on;
        goTo(cur, { force: true });
        updateZoomUI();
    }

    // ---------- sidebar ----------

    const thumbEls = [];
    let thumbQueue = [], thumbBusy = false, thumbsBuilt = false;
    const thumbObserver = new IntersectionObserver(entries => {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            thumbObserver.unobserve(e.target);
            thumbQueue.push(+e.target.dataset.n);
        }
        pumpThumbs();
    }, { root: $('thumbPanel'), rootMargin: '300px 0px' });

    async function pumpThumbs() {
        if (thumbBusy) return;
        thumbBusy = true;
        while (thumbQueue.length) {
            const n = thumbQueue.shift();
            try {
                const page = await getPage(n);
                const v1 = page.getViewport({ scale: 1 });
                const vp = page.getViewport({ scale: 150 * dpr() / v1.width });
                const c = document.createElement('canvas');
                c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
                await page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp }).promise;
                thumbEls[n - 1].firstChild.replaceChildren(c);
            } catch { /* skip */ }
        }
        thumbBusy = false;
    }

    function buildThumbs() {
        thumbsBuilt = true;
        const { w, h } = sizeOf(1);
        const frag = document.createDocumentFragment();
        for (let n = 1; n <= numPages; n++) {
            const t = document.createElement('div');
            t.className = 'thumb';
            t.dataset.n = n;
            t.innerHTML = `<div class="img" style="aspect-ratio:${w}/${h}"></div>${label(n)}`;
            t.onclick = () => { goTo(n); if (innerWidth <= 760) toggleSide(false); };
            thumbEls.push(t);
            frag.appendChild(t);
            thumbObserver.observe(t);
        }
        $('thumbs').appendChild(frag);
        updatePageUI();
    }

    async function buildOutline() {
        let outline = null;
        try { outline = await pdf.getOutline(); } catch { /* none */ }
        if (!outline || !outline.length) return;
        const list = items => {
            const ul = document.createElement('ul');
            for (const it of items) {
                const li = document.createElement('li');
                const a = document.createElement('a');
                a.textContent = it.title;
                a.onclick = async () => {
                    try {
                        let dest = it.dest;
                        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
                        if (!dest) return;
                        const idx = typeof dest[0] === 'object' ? await pdf.getPageIndex(dest[0]) : dest[0];
                        goTo(idx + 1);
                        if (innerWidth <= 760) toggleSide(false);
                    } catch { /* bad link */ }
                };
                li.appendChild(a);
                if (it.items && it.items.length) li.appendChild(list(it.items));
                ul.appendChild(li);
            }
            return ul;
        };
        $('outlinePanel').appendChild(list(outline));
        $('tabs').hidden = false;
        showTab('outline');
    }

    function showTab(tab) {
        $('outlinePanel').hidden = tab !== 'outline';
        $('thumbPanel').hidden = tab !== 'thumbs';
        $('tabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
        if (tab === 'thumbs') scrollThumbIntoView();
    }

    function scrollThumbIntoView() {
        const t = thumbEls[cur - 1];
        if (t && !$('thumbPanel').hidden) t.scrollIntoView({ block: 'center' });
    }

    function toggleSide(force) {
        if (!pdf) return;
        const side = $('side');
        side.hidden = force === undefined ? !side.hidden : !force;
        $('sideBtn').classList.toggle('on', !side.hidden);
        if (!side.hidden) {
            if (!thumbsBuilt) buildThumbs();
            scrollThumbIntoView();
        }
    }

    // ---------- events ----------

    $('prevBtn').onclick = $('flipPrev').onclick = () => prev();
    $('nextBtn').onclick = $('flipNext').onclick = next;
    $('zoomInBtn').onclick = () => zoomBy(1.25);
    $('zoomOutBtn').onclick = () => zoomBy(0.8);
    $('zoomLabel').onclick = () => setZoom('page');
    $('fitBtn').onclick = () => setZoom(zoom === 'page' ? 'width' : 'page');
    $('spreadBtn').onclick = () => setTwoUp(!twoUp);
    $('sideBtn').onclick = () => toggleSide();
    $('fullBtn').onclick = () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
    };
    $('tabs').onclick = e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); };

    const pageInput = $('pageInput');
    pageInput.onkeydown = e => {
        if (e.key === 'Enter') { goTo(fromLabel(pageInput.value)); pageInput.blur(); stage.focus(); }
        if (e.key === 'Escape') { pageInput.blur(); }
    };
    pageInput.onfocus = () => pageInput.select();
    pageInput.onblur = updatePageUI;

    document.addEventListener('keydown', e => {
        if (!pdf || e.target === pageInput) return;
        const ctrl = e.ctrlKey || e.metaKey;
        const k = e.key;
        const vScroll = stage.scrollHeight > stage.clientHeight + 1;
        const atBottom = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2;
        const atTop = stage.scrollTop <= 1;
        let handled = true;
        if (ctrl && (k === '=' || k === '+')) zoomBy(1.25);
        else if (ctrl && k === '-') zoomBy(0.8);
        else if (ctrl && k === '0') setZoom('page');
        else if (ctrl || e.altKey) handled = false;
        else if (k === 'ArrowRight' || k === 'PageDown') next();
        else if (k === 'ArrowLeft' || k === 'PageUp') prev();
        else if (k === ' ' && !e.shiftKey && (!vScroll || atBottom)) next();
        else if (k === ' ' && e.shiftKey && (!vScroll || atTop)) prev(true);
        else if (k === 'Home') goTo(1);
        else if (k === 'End') goTo(numPages);
        else if (k === '+' || k === '=') zoomBy(1.25);
        else if (k === '-') zoomBy(0.8);
        else if (k === '0') setZoom('page');
        else if (k === 'w' || k === 'W') setZoom('width');
        else if (k === 'd' || k === 'D') setTwoUp(!twoUp);
        else if (k === 't' || k === 'T') toggleSide();
        else if (k === 'f' || k === 'F') $('fullBtn').click();
        else handled = false;
        if (handled) e.preventDefault();
    });

    // Wheel: ctrl/pinch-trackpad zooms; plain wheel flips pages when the page fits.
    let wheelAcc = 0;
    stage.addEventListener('wheel', e => {
        if (!pdf) return;
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
            zoomBy(Math.exp(-clamp(dy, -50, 50) * 0.01), e.clientX, e.clientY);
            return;
        }
        if (stage.scrollHeight > stage.clientHeight + 1) return; // let it scroll
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        e.preventDefault();
        wheelAcc += e.deltaY;
        if (Math.abs(wheelAcc) >= 40) {
            wheelAcc > 0 ? next() : prev();
            wheelAcc = 0;
        }
    }, { passive: false });

    // Mouse drag to pan when zoomed in.
    let drag = null;
    stage.addEventListener('pointerdown', e => {
        if (e.pointerType !== 'mouse' || e.button !== 0 || !stage.classList.contains('grab')) return;
        drag = { x: e.clientX, y: e.clientY, l: stage.scrollLeft, t: stage.scrollTop };
        stage.classList.add('grabbing');
        stage.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    stage.addEventListener('pointermove', e => {
        if (!drag) return;
        stage.scrollLeft = drag.l - (e.clientX - drag.x);
        stage.scrollTop = drag.t - (e.clientY - drag.y);
    });
    const endDrag = () => { drag = null; stage.classList.remove('grabbing'); };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    // Double-click / double-tap: toggle between fit and 2.5× at that point.
    stage.addEventListener('dblclick', e => {
        if (typeof zoom === 'string') setZoom(scale * 2.5, e.clientX, e.clientY);
        else setZoom('page');
    });

    // Touch: pinch to zoom, swipe to flip.
    let pinch = null, swipe = null;
    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    stage.addEventListener('touchstart', e => {
        if (e.touches.length === 2) {
            const [a, b] = e.touches;
            pinch = { d: dist(a, b), s: scale };
            swipe = null;
        } else if (e.touches.length === 1) {
            const t = e.touches[0];
            swipe = { x: t.clientX, y: t.clientY, time: Date.now(), l: stage.scrollLeft };
        }
    }, { passive: true });
    stage.addEventListener('touchmove', e => {
        if (pinch && e.touches.length === 2) {
            e.preventDefault();
            const [a, b] = e.touches;
            setZoom(pinch.s * dist(a, b) / pinch.d, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
        }
    }, { passive: false });
    stage.addEventListener('touchend', e => {
        if (pinch && e.touches.length < 2) { pinch = null; scheduleRender(0); return; }
        if (!swipe || e.touches.length) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
        const noHScroll = stage.scrollWidth <= stage.clientWidth + 1;
        if (noHScroll && Date.now() - swipe.time < 600 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            dx < 0 ? next() : prev();
        }
        swipe = null;
    });
    document.addEventListener('gesturestart', e => e.preventDefault()); // iOS native pinch

    new ResizeObserver(() => {
        if (!pdf) return;
        layout();
        scheduleRender();
    }).observe(stage);

    // ---------- load ----------

    function startPage() {
        const m = location.hash.match(/page=([0-9a-z]+)/i);
        const p = m ? fromLabel(m[1]) : NaN;
        return p || prefs.page || 1;
    }

    const task = pdfjsLib.getDocument({
        url: encodeURI(FILE),
        disableAutoFetch: true,   // only download what's needed for visible pages
        disableStream: true,
        rangeChunkSize: 256 * 1024,
    });
    task.onProgress = ({ loaded, total }) => {
        if (!pdf && total) $('msg').textContent = `Loading… ${Math.round(loaded / total * 100)}%`;
    };
    task.promise.then(async doc => {
        pdf = doc;
        numPages = doc.numPages;
        await getPage(1);
        twoUp = prefs.twoUp ?? (innerWidth > 1000 && innerWidth > innerHeight * 1.2);
        zoom = prefs.zoom === 'width' ? 'width' : 'page';
        $('msg').hidden = true;
        cur = 0;
        goTo(startPage());
        updateZoomUI();
        stage.focus();
        buildOutline();
    }).catch(err => {
        $('msg').textContent = 'Couldn’t load the PDF: ' + (err && err.message || err);
    });

    window.addEventListener('hashchange', () => { if (pdf) goTo(startPage()); });
})();
