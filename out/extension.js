"use strict";
// ============================================
// FILE: src/extension.ts
// WHAT IT DOES: Main extension entry point
// ============================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const graphPanel_1 = require("./graphPanel");
// This is called when your extension is activated (user opens a .bard file)
function activate(context) {
    console.log('Bardic extension activated!');
    // Register the "Show Graph" command
    let showGraph = vscode.commands.registerCommand('bardic.showGraph', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }
        if (editor.document.languageId !== 'bard') {
            vscode.window.showErrorMessage('This is not a .bard file');
            return;
        }
        // Get the file content
        const fileContent = editor.document.getText();
        const filePath = editor.document.uri.fsPath;
        // Show the graph panel
        graphPanel_1.BardGraphPanel.createOrShow(context.extensionUri, fileContent, filePath);
    });
    // Auto-update graph when file is saved
    vscode.workspace.onDidSaveTextDocument(document => {
        if (document.languageId === 'bard') {
            graphPanel_1.BardGraphPanel.updateIfVisible(document.getText());
        }
    });
    context.subscriptions.push(showGraph);
}
// This is called when your extension is deactivated
function deactivate() { }
//# sourceMappingURL=extension.js.map