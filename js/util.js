/* Small shared helpers: logging, safe localStorage, tiny event bus. */
(function () {
    var TV = window.TV = window.TV || {};

    TV.log = function () {
        try {
            if (window.console && console.log) {
                var args = ['[TV]'].concat(Array.prototype.slice.call(arguments));
                console.log.apply(console, args);
            }
        } catch (e) { /* ignore */ }
    };

    // localStorage can throw (disabled / quota). Always go through this.
    TV.store = {
        get: function (key) {
            try { return window.localStorage.getItem('tv.' + key); } catch (e) { return null; }
        },
        set: function (key, value) {
            try { window.localStorage.setItem('tv.' + key, String(value)); return true; } catch (e) { return false; }
        },
        remove: function (key) {
            try { window.localStorage.removeItem('tv.' + key); } catch (e) { /* ignore */ }
        },
        getJson: function (key) {
            var raw = TV.store.get(key);
            if (!raw) { return null; }
            try { return JSON.parse(raw); } catch (e) { return null; }
        },
        setJson: function (key, value) {
            return TV.store.set(key, JSON.stringify(value));
        }
    };

    // Tiny pub/sub so modules do not need to know about each other.
    var handlers = {};
    TV.bus = {
        on: function (name, fn) {
            (handlers[name] = handlers[name] || []).push(fn);
        },
        off: function (name, fn) {
            var list = handlers[name] || [];
            var i = list.indexOf(fn);
            if (i >= 0) { list.splice(i, 1); }
        },
        emit: function (name, payload) {
            var list = (handlers[name] || []).slice();
            for (var i = 0; i < list.length; i++) {
                try { list[i](payload); } catch (e) { TV.log('handler for ' + name + ' threw', e && e.message); }
            }
        }
    };

    TV.randomId = function () {
        var s = '';
        var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        for (var i = 0; i < 24; i++) { s += chars.charAt(Math.floor(Math.random() * chars.length)); }
        return s;
    };

    // Exponential backoff helper: delay for attempt n (0-based) with jitter.
    TV.backoff = function (attempt, baseMs, maxMs) {
        var d = Math.min(maxMs, baseMs * Math.pow(2, attempt));
        return Math.round(d * (0.75 + Math.random() * 0.5));
    };
})();
