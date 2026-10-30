// electron-builder validates every exported key, so the testable function lives in scripts/.
module.exports = require("./scripts/builder-config.cjs").builderConfig();
