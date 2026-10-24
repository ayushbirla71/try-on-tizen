/*
 * Remote-control keys.
 *   RESULTS screen:  LEFT/RIGHT (and rewind / fast-forward)  -> display:key {dir:'prev'|'next'}
 *                    RETURN / BACK / ESC / STOP / "A"        -> display:key {dir:'ads'}
 *   The UI is never changed here: the key goes to the server and the screen follows the
 *   display:state the server broadcasts (so the kiosk phone stays mirrored).
 *   ADS / pairing screens: RETURN is swallowed. The app NEVER exits on RETURN (the Home key of the
 *   remote leaves the app); an accidental press on a public-facing TV must not kill the signage.
 */
(function () {
    var TV = window.TV = window.TV || {};

    var KEY = {
        LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
        RETURN: 10009, BACKSPACE: 8, ESC: 27, A: 65,
        REWIND: 412, STOP: 413, FAST_FORWARD: 417
    };

    function registerTizenKeys() {
        try {
            if (window.tizen && tizen.tvinputdevice && typeof tizen.tvinputdevice.registerKey === 'function') {
                var names = ['MediaRewind', 'MediaFastForward', 'MediaStop'];
                for (var i = 0; i < names.length; i++) {
                    try { tizen.tvinputdevice.registerKey(names[i]); } catch (e) { TV.log('registerKey failed', names[i], e && e.message); }
                }
            }
        } catch (e2) { TV.log('tvinputdevice unavailable', e2 && e2.message); }
    }

    function sendKey(dir) {
        TV.socket.sendKey(dir).then(null, function (err) {
            TV.log('display:key failed:', err.code, err.message);
            TV.ui.flash(err.code === 'OFFLINE' ? 'Offline - remote disabled' : 'Remote: ' + err.message, 2500);
        });
    }

    function onKeyDown(e) {
        var code = e.keyCode;
        // Every key counts as activity (resets the local idle timer).
        TV.idle.activity();

        var inResults = TV.ui.screen() === 'results';
        var handled = true;

        switch (code) {
            case KEY.LEFT:
            case KEY.REWIND:
                if (inResults) { sendKey('prev'); }
                break;
            case KEY.RIGHT:
            case KEY.FAST_FORWARD:
                if (inResults) { sendKey('next'); }
                break;
            case KEY.RETURN:
            case KEY.BACKSPACE:
            case KEY.ESC:
            case KEY.STOP:
            case KEY.A:
                if (inResults) { sendKey('ads'); }
                break;
            case KEY.UP:
            case KEY.DOWN:
            case KEY.ENTER:
                break;
            default:
                handled = false;
        }
        if (handled && e.preventDefault) { e.preventDefault(); }
    }

    TV.keys = {
        KEY: KEY,
        init: function () {
            registerTizenKeys();
            document.addEventListener('keydown', onKeyDown);
        }
    };
})();
