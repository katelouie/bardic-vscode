// ============================================
// FILE: src/extension.ts
// WHAT IT DOES: Main extension entry point
// ============================================

import * as vscode from 'vscode';
import { BardGraphPanel } from './graphPanel';
import { PythonEnvironmentManager } from './pythonEnvironment';
import { BardCompiler } from './compiler';
import { PreviewPanel } from './previewPanel';
import { PassageDetector } from './passageDetector';
import { BardFoldingProvider } from './foldingProvider';

// This is called when your extension is activated (user opens a .bard file)
export async function activate(context: vscode.ExtensionContext) {
    console.log('[Bardic] Extension activated!');

    // Initialize Python environment manager
    const pythonManager = new PythonEnvironmentManager();
    await pythonManager.initialize();

    // Initialize compiler
    const compiler = new BardCompiler(pythonManager);

    // Initialize passage detector
    const passageDetector = new PassageDetector();

    // Register folding provider for passages
    const foldingProvider = vscode.languages.registerFoldingRangeProvider(
        { language: 'bard' },
        new BardFoldingProvider()
    );
    context.subscriptions.push(foldingProvider);

    // Register the "Show Graph" command
    let showGraph = vscode.commands.registerCommand('bardic.showGraph', async () => {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        if (editor.document.languageId !== 'bard') {
            vscode.window.showErrorMessage('This is not a .bard file');
            return;
        }

        const filePath = editor.document.uri.fsPath;

        // Show progress indicator
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Compiling Bardic story...',
            cancellable: false
        }, async (progress) => {
            // Compile the file
            const result = await compiler.compile(filePath);

            if (result.success || result.method === 'simple-parser') {
                // Show graph with compiled data
                BardGraphPanel.createOrShow(context.extensionUri, result, filePath);

                // Show warnings if using simple parser
                if (result.warnings && result.warnings.length > 0) {
                    const warning = result.warnings[0];
                    const action = warning.includes('not selected') ? 'Select Python Interpreter' : 'Install Bardic';

                    vscode.window.showWarningMessage(
                        warning,
                        action,
                        'Learn More'
                    ).then(async selection => {
                        if (selection === 'Select Python Interpreter') {
                            await vscode.commands.executeCommand('python.setInterpreter');
                            // Wait a bit for Python extension to update
                            setTimeout(async () => {
                                const pythonPath = await pythonManager.getPythonPath();
                                if (pythonPath) {
                                    vscode.window.showInformationMessage('Python interpreter selected! Re-compiling graph...', 'OK');
                                    const newResult = await compiler.compile(filePath);
                                    BardGraphPanel.updateIfVisible(newResult);
                                }
                            }, 500);
                        } else if (selection === 'Install Bardic') {
                            vscode.window.showInformationMessage(
                                'To install Bardic, run: pip install bardic',
                                'Open Terminal'
                            ).then(action => {
                                if (action === 'Open Terminal') {
                                    vscode.commands.executeCommand('workbench.action.terminal.new');
                                }
                            });
                        } else if (selection === 'Learn More') {
                            vscode.env.openExternal(vscode.Uri.parse('https://github.com/katelouie/bardic#installation'));
                        }
                    });
                }
            } else {
                // CLI or simple parser failed
                if (result.error?.message && result.error.message.includes('Target passage')) {
                    // Missing passage error - this shouldn't happen now (we fall back to simple parser)
                    // But if it does, don't show error notification
                    console.log('[Bardic] Missing passage target error - should have fallen back to simple parser');
                } else {
                    // Real error - show to user
                    const error = result.error;
                    const message = error?.hint
                        ? `${error.message}\n\n💡 ${error.hint}`
                        : error?.message || 'Unknown error';

                    if (error?.lineNumber) {
                        // Offer to jump to line
                        vscode.window.showErrorMessage(message, 'Go to Line').then(selection => {
                            if (selection === 'Go to Line' && error.lineNumber) {
                                const position = new vscode.Position(error.lineNumber - 1, 0);
                                const selection = new vscode.Selection(position, position);
                                editor.selection = selection;
                                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
                            }
                        });
                    } else {
                        vscode.window.showErrorMessage(message);
                    }
                }
            }
        });
    });

    // Listen for Python environment changes
    pythonManager.onEnvironmentChanged(async () => {
        const pythonPath = await pythonManager.getPythonPath();
        console.log('[Bardic] Python environment changed to:', pythonPath);

        if (BardGraphPanel.currentPanel) {
            vscode.window.showInformationMessage('Python environment changed! Re-compiling graph...');
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'bard') {
                const filePath = editor.document.uri.fsPath;
                const result = await compiler.compile(filePath);
                BardGraphPanel.updateIfVisible(result);
            }
        }
    });

    // Auto-update graph on save
    vscode.workspace.onDidSaveTextDocument(async document => {
        if (document.languageId === 'bard' && BardGraphPanel.currentPanel) {
            const result = await compiler.compile(document.uri.fsPath);
            BardGraphPanel.updateIfVisible(result);
        }
    });

    // Register the "Preview Passage" command
    let previewPassage = vscode.commands.registerCommand('bardic.previewPassage', async () => {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        if (editor.document.languageId !== 'bard') {
            vscode.window.showErrorMessage('This is not a .bard file');
            return;
        }

        // Find passage at cursor
        const passageInfo = passageDetector.findPassageAtPosition(
            editor.document,
            editor.selection.active
        );

        if (!passageInfo) {
            vscode.window.showErrorMessage('Cursor not inside a passage. Place cursor inside a passage to preview it.');
            return;
        }

        const filePath = editor.document.uri.fsPath;

        // Get Python path
        const pythonPath = await pythonManager.getPythonPath();
        if (!pythonPath) {
            vscode.window.showErrorMessage(
                'No Python interpreter selected. Please select a Python interpreter to use preview.',
                'Select Interpreter'
            ).then(async selection => {
                if (selection === 'Select Interpreter') {
                    await vscode.commands.executeCommand('python.setInterpreter');
                }
            });
            return;
        }

        // Check if bardic installed
        const hasBardic = await pythonManager.isBardicInstalled(pythonPath);
        if (!hasBardic) {
            vscode.window.showErrorMessage(
                'Bardic not installed in selected Python environment. Preview requires bardic.',
                'Install Bardic'
            ).then(selection => {
                if (selection === 'Install Bardic') {
                    vscode.window.showInformationMessage(
                        'To install Bardic, run: pip install bardic',
                        'Open Terminal'
                    ).then(action => {
                        if (action === 'Open Terminal') {
                            vscode.commands.executeCommand('workbench.action.terminal.new');
                        }
                    });
                }
            });
            return;
        }

        // Compile the story
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Compiling story for preview...',
            cancellable: false
        }, async (progress) => {
            const result = await compiler.compile(filePath);

            if (!result.success || !result.data) {
                const error = result.error;
                const message = error?.hint
                    ? `${error.message}\n\n💡 ${error.hint}`
                    : error?.message || 'Unknown compilation error';

                vscode.window.showErrorMessage(`Cannot preview: ${message}`);
                return;
            }

            // Ask for initial state (simple version - just JSON input)
            const stateJson = await vscode.window.showInputBox({
                prompt: 'Enter initial state as JSON (optional)',
                placeHolder: '{"hp": 100, "gold": 50} or leave empty',
                value: '{}',
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return undefined; // Empty is ok
                    }
                    try {
                        JSON.parse(value);
                        return undefined;
                    } catch (e: any) {
                        return `Invalid JSON: ${e.message}`;
                    }
                }
            });

            if (stateJson === undefined) {
                return; // User cancelled
            }

            const initialState = stateJson.trim() ? JSON.parse(stateJson) : {};

            // Show preview
            await PreviewPanel.createOrShow(
                context.extensionUri,
                passageInfo.name,
                result.data,
                pythonPath,
                initialState
            );
        });
    });

    context.subscriptions.push(showGraph, previewPassage);
}

// This is called when your extension is deactivated
export function deactivate() { }