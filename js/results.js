/*
 * Results slider. Pure renderer: it shows exactly the `items` / `index` it is given (from the
 * server's display:state) and never decides on its own which image comes next.
 * Transition: slide left/right when the index moved by one, cross-fade for a new item set
 * (or when a swipe interrupts a transition that is still running).
 *
 * Images are full-size and can take a while over the TV's network, so a slide never waits for
 * its image to decide what to do: it appears at once with a loading spinner and the picture
 * fades in whenever it arrives. A failed download is retried a few times before giving up.
 */
(function () {
    var TV = window.TV = window.TV || {};

    var slidesEl, resultsEl, counterEl, dotsEl, qrEl, qrCodeEl;
    var items = [];
    var curKey = null;
    var curIndex = -1;
    var currentSlide = null;
    var transToken = 0;
    var visible = false;
    var hideTimer = null;
    var dotsCount = -1;
    var animating = false;

    var preloadRefs = [];
    var preloadQueue = [];
    var preloadActive = 0;
    var preloadGen = 0;      // bumped to cancel downloads queued by an older pass
    var preloaded = {};

    // Admin-chosen photo background colour ("#RRGGBB" or null). It is also the colour of the slide
    // while its image is loading, so the screen is never a different colour from the photo.
    var HEX_RE = /^#[0-9a-fA-F]{6}$/;
    var pendingBackground = null;

    // "Scan to download" QR (admin setting): shown or not, and in which corner.
    var QR_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    var qrEnabled = false;
    var qrPosition = 'bottom-right';
    var qrShownUrl = null;   // the link currently drawn, so an unchanged QR is not rebuilt

    var SLIDE_MS = 450;
    // A swipe to an image that is not downloaded yet waits this long for it before sliding in
    // a loading slide, so an almost-ready image does not flash a spinner.
    var SWIPE_WAIT_MS = 500;
    var RETRY_DELAYS_MS = [1500, 3000, 6000];
    var PRELOAD_PARALLEL = 2;

    function applyBackground() {
        if (!resultsEl || !resultsEl.style || !resultsEl.style.setProperty) { return; }
        var color = pendingBackground;
        if (!color) {
            resultsEl.style.removeProperty('--results-bg');
            resultsEl.style.removeProperty('--results-fg');
            resultsEl.style.removeProperty('--results-fg-dim');
            return;
        }
        var r = parseInt(color.slice(1, 3), 16);
        var g = parseInt(color.slice(3, 5), 16);
        var b = parseInt(color.slice(5, 7), 16);
        var light = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6;
        // spinner / loading text must stay readable on both light and dark backgrounds
        resultsEl.style.setProperty('--results-bg', color);
        resultsEl.style.setProperty('--results-fg', light ? '#1f2937' : '#ffffff');
        resultsEl.style.setProperty('--results-fg-dim', light ? 'rgba(31, 41, 55, 0.18)' : 'rgba(255, 255, 255, 0.18)');
    }

    function keyOf(list) {
        var k = [];
        for (var i = 0; i < list.length; i++) { k.push(list[i].historyId || list[i].url); }
        return k.join(',');
    }

    function translate(el, x) {
        el.style.webkitTransform = el.style.transform = 'translate3d(' + x + ',0,0)';
    }

    function makeSlide(item, token) {
        var wrap = document.createElement('div');
        wrap.className = 'slide';
        var img = document.createElement('img');
        img.alt = '';
        wrap.appendChild(img);

        var loading = document.createElement('div');
        loading.className = 'slide-loading';
        var spinner = document.createElement('div');
        spinner.className = 'spinner';
        var text = document.createElement('div');
        text.className = 'loading-text';
        text.textContent = 'Loading your look...';
        loading.appendChild(spinner);
        loading.appendChild(text);
        wrap.appendChild(loading);

        return { el: wrap, img: img, url: item.url, token: token, loaded: false, failed: false,
            retries: 0, retryTimer: null, onSettled: null };
    }

    function renderBar() {
        var n = items.length;
        TV.setClass(resultsEl, 'single', n <= 1);
        counterEl.textContent = (curIndex + 1) + ' / ' + n;
        if (dotsCount !== n) {
            dotsEl.innerHTML = '';
            for (var i = 0; i < n; i++) {
                var d = document.createElement('span');
                d.className = 'dot';
                dotsEl.appendChild(d);
            }
            dotsCount = n;
        }
        for (var j = 0; j < dotsEl.childNodes.length; j++) {
            TV.setClass(dotsEl.childNodes[j], 'on', j === curIndex);
        }
    }

    // ---------- "scan to download" QR ----------

    function qrUrlFor(item) {
        if (!item) { return null; }
        var path = item.downloadPath || (item.historyId ? '/try-on/' + item.historyId + '/download' : null);
        return path ? TV.api.url(path) : null;
    }

    // Follows the photo that is on screen; hidden when switched off or when nothing is shown.
    function updateQr() {
        if (!qrEl) { return; }
        var url = (qrEnabled && visible && curIndex >= 0) ? qrUrlFor(items[curIndex]) : null;
        if (url && url !== qrShownUrl) {
            try {
                var qr = window.qrcode(0, 'M');   // type 0 = smallest version that fits the link
                qr.addData(url);
                qr.make();
                qrCodeEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
                qrShownUrl = url;
            } catch (e) {
                TV.log('QR failed', e && e.message);
                url = null;
                qrShownUrl = null;
            }
        }
        if (!url) { qrShownUrl = null; }
        qrEl.className = 'results-qr pos-' + qrPosition + (url ? ' show' : '');
    }

    // ---------- preloading ----------

    function pumpPreload(gen) {
        while (gen === preloadGen && preloadActive < PRELOAD_PARALLEL && preloadQueue.length) {
            var url = preloadQueue.shift();
            if (preloaded[url]) { continue; }
            preloaded[url] = true;
            preloadActive++;
            var im = new Image();
            // Callbacks from a cancelled pass must not touch the counters of the current one.
            var done = function () {
                if (gen !== preloadGen) { return; }
                preloadActive--;
                pumpPreload(gen);
            };
            im.onload = done;
            im.onerror = done; // the slide itself retries when it needs this image
            im.src = url;
            preloadRefs.push(im);
        }
    }

    // Neighbours first (the next swipe), then the rest by distance. Started once the image that
    // is on screen has finished, so it never competes with it for bandwidth.
    function preloadAll() {
        var n = items.length;
        if (n < 2) { return; }
        var seen = {};
        seen[curIndex] = true;
        preloadQueue = [];
        for (var d = 1; d <= n; d++) {
            var cand = [(curIndex + d) % n, (curIndex - d + n) % n];
            for (var c = 0; c < cand.length; c++) {
                if (!seen[cand[c]]) { seen[cand[c]] = true; preloadQueue.push(items[cand[c]].url); }
            }
        }
        preloadGen++;
        preloadActive = 0;
        pumpPreload(preloadGen);
    }

    // ---------- slide image loading (with retries) ----------

    function settled(slide) {
        if (slide.onSettled) { var f = slide.onSettled; slide.onSettled = null; f(); }
        if (slide.token === transToken) { preloadAll(); }
    }

    function startLoad(slide) {
        slide.img.onload = function () {
            slide.loaded = true;
            slide.failed = false;
            TV.setClass(slide.el, 'failed', false);
            TV.setClass(slide.el, 'ready', true);
            var err = slide.el.querySelector('.slide-error');
            if (err) { slide.el.removeChild(err); }
            settled(slide);
        };
        slide.img.onerror = function () {
            if (slide.token !== transToken) { return; } // no longer the wanted slide: stop retrying
            if (slide.retries < RETRY_DELAYS_MS.length) {
                var delay = RETRY_DELAYS_MS[slide.retries++];
                TV.log('result image failed, retry', slide.retries, 'in', delay, 'ms');
                slide.retryTimer = setTimeout(function () {
                    if (slide.token !== transToken || slide.loaded) { return; }
                    slide.img.removeAttribute('src');
                    slide.img.src = slide.url;
                }, delay);
                // let a waiting swipe start now (it shows the spinner while we retry)
                if (slide.onSettled) { var f = slide.onSettled; slide.onSettled = null; f(); }
                return;
            }
            slide.failed = true;
            TV.setClass(slide.el, 'failed', true);
            if (!slide.el.querySelector('.slide-error')) {
                var msg = document.createElement('div');
                msg.className = 'slide-error';
                msg.textContent = 'Image unavailable';
                slide.el.appendChild(msg);
            }
            settled(slide);
        };
        slide.img.src = slide.url;
        if (slide.img.complete && slide.img.naturalWidth > 0) { slide.img.onload(); }
    }

    // ---------- transitions ----------

    // Drop everything except the slide that is on screen (finishes any running transition).
    function settle() {
        if (!slidesEl) { return; }
        var kids = slidesEl.childNodes;
        for (var i = kids.length - 1; i >= 0; i--) {
            if (!currentSlide || kids[i] !== currentSlide.el) { slidesEl.removeChild(kids[i]); }
        }
        if (currentSlide) {
            TV.setClass(currentSlide.el, 'animating', false);
            translate(currentSlide.el, '0');
            currentSlide.el.style.opacity = '1';
        }
        animating = false;
    }

    /** dir: 1 = new slide comes from the right, -1 = from the left, 0 = cross-fade. */
    function go(index, dir) {
        transToken++;
        var token = transToken;
        var interrupted = animating;
        settle();
        // Snapping a half-finished slide into place and then sliding again looks like a jump;
        // fade the new image in over it instead.
        if (interrupted) { dir = 0; }
        var item = items[index];
        if (!item) { return; }
        var slide = makeSlide(item, token);
        var old = currentSlide;
        var started = false;
        var waitTimer = null;

        function begin() {
            if (started || token !== transToken) { return; }
            started = true;
            clearTimeout(waitTimer);
            var el = slide.el;
            if (dir === 0 || !old) {
                el.style.opacity = '0';
            } else {
                translate(el, dir > 0 ? '100%' : '-100%');
            }
            slidesEl.appendChild(el);
            currentSlide = slide;
            void el.offsetWidth; // flush styles so the transition starts from the position above
            animating = true;
            if (old) { TV.setClass(old.el, 'animating', true); }
            TV.setClass(el, 'animating', true);
            translate(el, '0');
            el.style.opacity = '1';
            if (old) {
                if (dir === 0) {
                    old.el.style.opacity = '0';
                } else {
                    translate(old.el, dir > 0 ? '-100%' : '100%');
                }
            }
            setTimeout(function () {
                if (token !== transToken) { return; }
                settle();
            }, SLIDE_MS + 80);
        }

        slide.onSettled = begin;
        // First screen of a set: show the (loading) slide immediately. Swipes: give an image that
        // is almost there a moment, otherwise slide in with the spinner.
        waitTimer = setTimeout(begin, old ? SWIPE_WAIT_MS : 0);
        startLoad(slide);
    }

    function direction(oldIndex, newIndex, n) {
        if (n < 2 || oldIndex < 0) { return 0; }
        if (newIndex === (oldIndex + 1) % n) { return 1; }
        if (newIndex === (oldIndex - 1 + n) % n) { return -1; }
        return newIndex > oldIndex ? 1 : -1;
    }

    TV.results = {
        init: function () {
            slidesEl = TV.$('slides');
            resultsEl = TV.$('results');
            counterEl = TV.$('resultsCounter');
            dotsEl = TV.$('resultsDots');
            qrEl = TV.$('resultsQr');
            qrCodeEl = TV.$('resultsQrCode');
            applyBackground();
            updateQr();
        },

        /** enabled: boolean, position: one of the four corners. Safe to call at any time. */
        setQr: function (enabled, position) {
            qrEnabled = enabled === true;
            qrPosition = QR_POSITIONS.indexOf(position) >= 0 ? position : 'bottom-right';
            updateQr();
        },

        /** color: "#RRGGBB" or null/undefined for the default black. Safe to call at any time. */
        setBackground: function (color) {
            pendingBackground = (typeof color === 'string' && HEX_RE.test(color)) ? color : null;
            applyBackground();
        },

        /** Render server state. Safe to call repeatedly with the same data. */
        render: function (newItems, index) {
            if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
            var n = newItems.length;
            if (!n) { TV.results.hide(); return; }
            index = Math.max(0, Math.min(n - 1, index | 0));
            var key = keyOf(newItems);
            var wasVisible = visible;
            visible = true;
            var oldIndex = curIndex;
            var sameSet = key === curKey;
            items = newItems;
            curKey = key;
            curIndex = index;
            renderBar();
            updateQr();
            if (!sameSet) { preloadGen++; preloaded = {}; preloadQueue = []; preloadRefs = []; }
            if (!wasVisible || !sameSet || !currentSlide) {
                go(index, 0);
            } else if (index !== oldIndex) {
                go(index, direction(oldIndex, index, n));
            }
        },

        /** Results screen is no longer shown: free the images. */
        hide: function () {
            if (!visible && !currentSlide) { return; }
            visible = false;
            transToken++;
            updateQr();
            hideTimer = setTimeout(function () {
                hideTimer = null;
                if (visible) { return; }
                slidesEl.innerHTML = '';
                currentSlide = null;
                items = [];
                curKey = null;
                curIndex = -1;
                preloadGen++;
                preloadRefs = [];
                preloadQueue = [];
                preloaded = {};
                dotsCount = -1;
                animating = false;
            }, 600);
        },

        status: function () {
            return { visible: visible, index: curIndex, count: items.length, key: curKey };
        }
    };
})();
