const Module = require('module');
const originalRequire = Module.prototype.require;

Module.prototype.require = function(modulePath) {
    if (modulePath === 'vscode') {
        return {
            workspace: {
                getConfiguration: () => ({
                    get: () => undefined
                })
            },
            window: {
                showErrorMessage: async () => {},
                showInformationMessage: async () => {},
                withProgress: async (_, fn) => fn({ report: () => {} })
            },
            commands: {
                executeCommand: async () => {}
            },
            ProgressLocation: {
                Notification: 15
            }
        };
    }
    return originalRequire.apply(this, arguments);
};

require('../out/test/backend.test.js');
