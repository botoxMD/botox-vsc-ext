const Module = require('module');
const originalRequire = Module.prototype.require;

Module.prototype.require = function(modulePath) {
    if (modulePath === 'vscode') {
        class Position {
            constructor(line, character) {
                this.line = line;
                this.character = character;
            }
        }
        class Range {
            constructor(startLine, startChar, endLine, endChar) {
                this.start = typeof startLine === 'number' ? new Position(startLine, startChar) : startLine;
                this.end = typeof startLine === 'number' ? new Position(endLine, endChar) : startChar;
            }
        }
        class WorkspaceEdit {
            constructor() {
                this.edits = [];
            }
            insert(uri, pos, text) {
                this.edits.push({ type: 'insert', uri, pos, text });
            }
            replace(uri, range, text) {
                this.edits.push({ type: 'replace', uri, range, text });
            }
        }
        class CodeAction {
            constructor(title, kind) {
                this.title = title;
                this.kind = kind;
            }
        }
        return {
            Position,
            Range,
            WorkspaceEdit,
            CodeAction,
            CodeActionKind: { QuickFix: 'quickfix' },
            DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
            languages: {
                createDiagnosticCollection: () => ({
                    set: () => {},
                    delete: () => {},
                    clear: () => {},
                    dispose: () => {}
                })
            },
            workspace: {
                getConfiguration: () => ({
                    get: (_k, def) => def
                }),
                textDocuments: []
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
require('../out/test/inspector.test.js');
