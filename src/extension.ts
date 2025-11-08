// ============================================
// FILE: src/extension.ts
// WHAT IT DOES: Main extension entry point
// ============================================

import * as vscode from 'vscode';
import { BardGraphPanel } from './graphPanel';

// This is called when your extension is activated (user opens a .bard file)
export function activate(context: vscode.ExtensionContext) {
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
        BardGraphPanel.createOrShow(context.extensionUri, fileContent, filePath);
    });

    // Auto-update graph when file is saved
    vscode.workspace.onDidSaveTextDocument(document => {
        if (document.languageId === 'bard') {
            BardGraphPanel.updateIfVisible(document.getText());
        }
    });

    context.subscriptions.push(showGraph);
}

// This is called when your extension is deactivated
export function deactivate() { }