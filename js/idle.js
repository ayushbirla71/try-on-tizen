/*
 * Local fallback for the server's idle timer (covers a dropped socket). While the TV is in RESULTS,
 * if nothing happened (no display:state, no key press) for idleTimeoutSeconds, we fall back to ads
 * locally. The server runs the same timer; whatever display:state it sends next simply wins.
 */
(function () {
    var TV = window.TV = window.TV || {};

    var timeoutSec = 0;
    var armed = false;
    var lastActivity = 0;
    var tick = null;

    function check() {
        if (!armed || !timeoutSec) { return; }
        if (Date.now() - lastActivity >= timeoutSec * 1000) {
            armed = false;
            TV.log('local idle timeout reached -> ads');
            TV.bus.emit('idle:timeout');
        }
    }

    TV.idle = {
        init: function () {
            timeoutSec = TV.config.defaultIdleSeconds;
            if (tick) { clearInterval(tick); }
            tick = setInterval(check, 1000);
        },

        setTimeoutSeconds: function (s) {
            s = Number(s);
            if (s > 0 && isFinite(s)) { timeoutSec = s; }
        },

        seconds: function () { return timeoutSec; },

        /** Start counting (entering / refreshing RESULTS). */
        arm: function () {
            armed = true;
            lastActivity = Date.now();
        },

        disarm: function () { armed = false; },

        /** Any key press or state change. */
        activity: function () { lastActivity = Date.now(); },

        isArmed: function () { return armed; }
    };
})();
