var store = function () {
    // can't use browser.storage
    // we need a synchronous api
    var firestoreSettingKey = 'firestoreEnabled';
    var firestoreEnabled = (window.localStorage.getItem(firestoreSettingKey) === 'true') || false;
    // enable api plugin by default
    var plugin = _GORGIAS_API_PLUGIN;

    if (firestoreEnabled) {
        plugin = _FIRESTORE_PLUGIN;
        // migrate legacy data
        _FIRESTORE_PLUGIN.startup();
    }

    // firestore toggle
    window.TOGGLE_FIRESTORE = function (enabled = false) {
        window.localStorage.setItem(firestoreSettingKey, `${enabled}`);
    };

    window.FIRESTORE_ENABLED = function () {
        return firestoreEnabled;
    };

    // respond to content
    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
        if (
            req.type &&
            typeof plugin[req.type] === 'function'
        ) {
            plugin[req.type](req.data).then((data) => {
                if (typeof data !== 'undefined') {
                    sendResponse(data);
                }
            }).catch((err) => console.err(err));
        }

        return true;
    });

    // debug store calls
    var debugPlugin = {};
    Object.keys(plugin).forEach((key) => {
        debugPlugin[key] = function () {
            console.log(key, arguments[0]);
            return plugin[key].apply(null, arguments);
        };
    });

    if (ENV !== 'production') {
        return debugPlugin;
    }

    return plugin;
}();