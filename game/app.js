var WOPW = require('./wopw.js');

new WOPW().start().catch(function(err) {
    console.error("Failed to start game server:", err);
    process.exit(1);
});
