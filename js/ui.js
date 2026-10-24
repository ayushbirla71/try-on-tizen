/* DOM helpers: which layer is visible, pairing texts, discreet status overlay, stage scaling. */
(function () {
    var TV = window.TV = window.TV || {};

    function $(id) { return document.getElementById(id); }
    TV.$ = $;

    var SCREENS = { pairing: 'pairing', ads: 'ads', results: 'results' };
    var currentScreen = null;
    var statusTimer = null;
    var persistentStatus = '';   // e.g. "Reconnecting..." stays until cleared
    var flashText = '';

    function setClass(el, name, on) {
        if (!el) { return; }
        var has = (' ' + el.className + ' ').indexOf(' ' + name + ' ') >= 0;
        if (on && !has) { el.className = (el.className ? el.className + ' ' : '') + name; }
        if (!on && has) {
            el.className = (' ' + el.className + ' ').replace(' ' + name + ' ', ' ').replace(/^\s+|\s+$/g, '');
        }
    }
    TV.setClass = setClass;

    /*
     * Make the stage cover the WHOLE screen, whatever its shape. The short side of the screen is
     * 1080 design pixels (1080x1920 on a portrait TV, 1920x1080 on a landscape one); the stage is
     * that big and then scaled to the physical resolution, so there are never black bars or an
     * empty margin. The "portrait" / "landscape" class lets the CSS adapt the pairing/idle layout.
     */
    function fitStage() {
        var stage = $('stage');
        if (!stage) { return; }
        var w = window.innerWidth || 1920;
        var h = window.innerHeight || 1080;
        var s = Math.min(w, h) / 1080;
        if (!isFinite(s) || s <= 0) { s = 1; }
        stage.style.width = (w / s) + 'px';
        stage.style.height = (h / s) + 'px';
        stage.style.left = '0px';
        stage.style.top = '0px';
        stage.style.webkitTransform = stage.style.transform = 'scale(' + s + ')';
        setClass(stage, 'portrait', h > w);
        setClass(stage, 'landscape', h <= w);
    }

    function renderStatus() {
        var el = $('status');
        var text = flashText || persistentStatus;
        if (!el) { return; }
        el.textContent = text;
        setClass(el, 'show', !!text);
    }

    TV.ui = {
        init: function () {
            fitStage();
            window.addEventListener('resize', fitStage);
            // Some TVs only report the new size a moment after the rotation setting changes.
            window.addEventListener('orientationchange', function () {
                fitStage();
                setTimeout(fitStage, 300);
            });
        },

        /** name: 'pairing' | 'ads' | 'results' */
        showScreen: function (name) {
            if (!SCREENS[name]) { return; }
            currentScreen = name;
            for (var k in SCREENS) {
                if (SCREENS.hasOwnProperty(k)) { setClass($(SCREENS[k]), 'active', k === name); }
            }
            TV.log('screen ->', name);
        },

        screen: function () { return currentScreen; },

        /**
         * opts: { code, status, statusOk, hint, footer }  (undefined fields are left unchanged)
         */
        setPairing: function (opts) {
            if (opts.code !== undefined) {
                var c = String(opts.code || '');
                $('pairingCode').textContent = c ? (c.length === 6 ? c.slice(0, 3) + ' ' + c.slice(3) : c) : '------';
            }
            if (opts.status !== undefined) { $('pairingStatus').textContent = opts.status; }
            if (opts.statusOk !== undefined) { setClass($('pairingStatus'), 'ok', !!opts.statusOk); }
            if (opts.hint !== undefined) { $('pairingHint').textContent = opts.hint; }
            if (opts.footer !== undefined) { $('pairingFooter').textContent = opts.footer; }
        },

        /** Persistent small status (connection problems). Empty string clears. */
        setConnection: function (text) {
            persistentStatus = text || '';
            renderStatus();
        },

        /** Temporary message (key errors etc.). */
        flash: function (text, ms) {
            flashText = text || '';
            renderStatus();
            if (statusTimer) { clearTimeout(statusTimer); }
            statusTimer = setTimeout(function () { flashText = ''; renderStatus(); }, ms || 3000);
        }
    };
})();
