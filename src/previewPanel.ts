/**
 * Preview panel for rendering Bardic passages with the engine.
 */

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { CompiledStory } from './compiler';

export class PreviewPanel {
    public static currentPanel: PreviewPanel | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _pythonProcess: ChildProcess | undefined;
    private _disposables: vscode.Disposable[] = [];
    private _storyData: CompiledStory;
    private _pythonPath: string;
    private _currentState: Record<string, any> = {};
    private _responseHandlers: Map<number, (data: any) => void> = new Map();
    private _requestId = 0;
    private _intentionalKill = false;

    public static async createOrShow(
        extensionUri: vscode.Uri,
        passageName: string,
        storyData: CompiledStory,
        pythonPath: string,
        initialState?: Record<string, any>
    ): Promise<void> {
        const column = vscode.ViewColumn.Two;

        // If panel exists, show it
        if (PreviewPanel.currentPanel) {
            PreviewPanel.currentPanel._panel.reveal(column);
            await PreviewPanel.currentPanel.previewPassage(passageName, initialState || {});
            return;
        }

        // Create new panel
        const panel = vscode.window.createWebviewPanel(
            'bardicPreview',
            'Bardic Preview',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        PreviewPanel.currentPanel = new PreviewPanel(
            panel,
            extensionUri,
            storyData,
            pythonPath
        );

        await PreviewPanel.currentPanel.previewPassage(passageName, initialState || {});
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        storyData: CompiledStory,
        pythonPath: string
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._storyData = storyData;
        this._pythonPath = pythonPath;

        // Set initial HTML with the webview interface
        this._panel.webview.html = this._getHtmlForWebview();

        // Handle panel disposal
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from webview
        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'choiceSelected':
                        await this.handleChoiceSelected(message.index);
                        break;
                    case 'editState':
                        await this.handleEditState();
                        break;
                    case 'reset':
                        await this.handleReset();
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    private async startPythonProcess(): Promise<void> {
        return new Promise((resolve, reject) => {
            const scriptPath = path.join(this._extensionUri.fsPath, 'src', 'preview_server.py');

            console.log('[Bardic Preview] Starting Python process:', {
                python: this._pythonPath,
                script: scriptPath
            });

            this._pythonProcess = spawn(this._pythonPath, [scriptPath]);

            let stdout = '';
            let stderr = '';

            // Handle stdout
            this._pythonProcess.stdout?.on('data', (data) => {
                const lines = data.toString().split('\n').filter((l: string) => l.trim());

                for (const line of lines) {
                    try {
                        const response = JSON.parse(line);

                        if (response.status === 'ready') {
                            console.log('[Bardic Preview] Python process ready');
                            resolve();
                        } else if (response.error) {
                            console.error('[Bardic Preview] Python error:', response);
                            this._panel.webview.html = this._getErrorHtml(response.message || response.error);
                        } else {
                            // Handle response
                            this.handleResponse(response);
                        }
                    } catch (e) {
                        console.log('[Bardic Preview] Stdout:', line);
                    }
                }
            });

            // Handle stderr
            this._pythonProcess.stderr?.on('data', (data) => {
                stderr += data.toString();
                console.error('[Bardic Preview] Python stderr:', data.toString());
            });

            // Handle process exit
            this._pythonProcess.on('close', (code) => {
                console.log('[Bardic Preview] Python process exited:', code);

                // Don't show error if we intentionally killed it
                if (this._intentionalKill) {
                    this._intentionalKill = false;
                    return;
                }

                if (code !== 0 && code !== null) {
                    this._panel.webview.html = this._getErrorHtml(
                        `Preview process exited with code ${code}\n${stderr}`
                    );
                }
            });

            // Handle spawn errors
            this._pythonProcess.on('error', (error) => {
                console.error('[Bardic Preview] Failed to start Python:', error);
                reject(error);
            });

            // Send story data with all required fields for BardEngine
            const storyJson = JSON.stringify({
                passages: this._storyData.passages,
                initial_passage: this._storyData.startPassage,
                imports: this._storyData.imports || [],
                metadata: this._storyData.metadata || {},
                version: this._storyData.version || '0.1.0'
            });

            this._pythonProcess.stdin?.write(storyJson + '\n');
        });
    }

    private async sendCommand(command: any): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this._pythonProcess || !this._pythonProcess.stdin) {
                reject(new Error('Python process not running'));
                return;
            }

            const requestId = this._requestId++;
            this._responseHandlers.set(requestId, resolve);

            const commandJson = JSON.stringify({ ...command, requestId });
            this._pythonProcess.stdin.write(commandJson + '\n');

            // Timeout after 5 seconds
            setTimeout(() => {
                if (this._responseHandlers.has(requestId)) {
                    this._responseHandlers.delete(requestId);
                    reject(new Error('Command timeout'));
                }
            }, 5000);
        });
    }

    private handleResponse(response: any): void {
        // For now, just update the webview with the response
        // In a full implementation, we'd match requestId to handlers
        if (response.content !== undefined) {
            this._panel.webview.postMessage({
                command: 'render',
                data: {
                    content: response.content,
                    choices: response.choices || [],
                    passageName: response.passage_id,
                    state: this._currentState
                }
            });
        }
    }

    public async previewPassage(passageName: string, state: Record<string, any>): Promise<void> {
        this._currentState = { ...this._currentState, ...state };

        // Start Python process if not running
        if (!this._pythonProcess) {
            try {
                await this.startPythonProcess();
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to start preview: ${error.message}`);
                return;
            }
        }

        // Send preview command
        const command = {
            type: 'preview',
            passage: passageName,
            state: this._currentState
        };

        try {
            this._pythonProcess?.stdin?.write(JSON.stringify(command) + '\n');
        } catch (error: any) {
            vscode.window.showErrorMessage(`Preview failed: ${error.message}`);
        }
    }

    private async handleChoiceSelected(index: number): Promise<void> {
        const command = {
            type: 'choice',
            index
        };

        try {
            this._pythonProcess?.stdin?.write(JSON.stringify(command) + '\n');
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to select choice: ${error.message}`);
        }
    }

    private async handleEditState(): Promise<void> {
        const stateJson = JSON.stringify(this._currentState, null, 2);

        const newStateJson = await vscode.window.showInputBox({
            prompt: 'Enter state as JSON',
            value: stateJson,
            placeHolder: '{"hp": 100, "gold": 50}',
            validateInput: (value) => {
                try {
                    JSON.parse(value);
                    return undefined;
                } catch (e: any) {
                    return `Invalid JSON: ${e.message}`;
                }
            }
        });

        if (newStateJson) {
            try {
                const newState = JSON.parse(newStateJson);
                this._currentState = newState;

                // Re-render current passage with new state
                const command = {
                    type: 'current'
                };
                this._pythonProcess?.stdin?.write(JSON.stringify(command) + '\n');
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to update state: ${error.message}`);
            }
        }
    }

    private async handleReset(): Promise<void> {
        this._currentState = {};

        // Restart Python process to reset engine
        if (this._pythonProcess) {
            this._intentionalKill = true;
            this._pythonProcess.kill();
            this._pythonProcess = undefined;
        }

        // Re-render starting passage
        await this.previewPassage(this._storyData.startPassage, {});
    }

    public dispose(): void {
        PreviewPanel.currentPanel = undefined;

        // Kill Python process
        if (this._pythonProcess) {
            this._intentionalKill = true;
            this._pythonProcess.kill();
        }

        // Clean up resources
        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    private _getLoadingHtml(): string {
        return `<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            background: #1a0033;
            color: #f4e4c1;
            font-family: Georgia, serif;
            padding: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
        }
        .loading {
            text-align: center;
            font-size: 18px;
        }
    </style>
</head>
<body>
    <div class="loading">Loading preview...</div>
</body>
</html>`;
    }

    private _getErrorHtml(error: string): string {
        return `<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            background: #1a0033;
            color: #f4e4c1;
            font-family: Georgia, serif;
            padding: 40px;
            margin: 0;
        }
        .error {
            background: rgba(74, 0, 0, 0.5);
            border: 2px solid #ff4444;
            padding: 30px;
            border-radius: 8px;
            max-width: 600px;
            margin: 0 auto;
        }
        .error-title {
            font-size: 24px;
            color: #ff6666;
            margin-bottom: 15px;
        }
        pre {
            background: rgba(0, 0, 0, 0.3);
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
        }
    </style>
</head>
<body>
    <div class="error">
        <div class="error-title">Preview Error</div>
        <pre>${error}</pre>
    </div>
</body>
</html>`;
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bardic Preview</title>
    <style>
        body {
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            padding: 20px;
            margin: 0;
            line-height: 1.6;
        }

        .container {
            max-width: 800px;
            margin: 0 auto;
        }

        .passage-header {
            border-bottom: 2px solid var(--vscode-textLink-foreground);
            padding-bottom: 10px;
            margin-bottom: 20px;
        }

        .passage-name {
            font-size: 24px;
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
        }

        .passage-content {
            margin-bottom: 30px;
            white-space: pre-wrap;
            color: var(--vscode-editor-foreground);
        }

        .choices {
            display: flex;
            flex-direction: column;
            gap: 10px;
            margin-bottom: 30px;
        }

        .choice {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: 1px solid var(--vscode-button-border);
            padding: 12px 16px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s ease;
            text-align: left;
            font-family: var(--vscode-font-family);
        }

        .choice:hover {
            background-color: var(--vscode-button-hoverBackground);
            transform: translateX(5px);
        }

        .no-choices {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            text-align: center;
            padding: 20px;
        }

        .controls {
            display: flex;
            gap: 10px;
            padding-top: 20px;
            border-top: 1px solid var(--vscode-panel-border);
        }

        .control-button {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: 14px;
            transition: all 0.15s ease;
        }

        .control-button:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .state-panel {
            position: fixed;
            top: 10px;
            right: 10px;
            background-color: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            padding: 12px;
            border-radius: 4px;
            font-size: 11px;
            max-width: 250px;
            max-height: 400px;
            overflow-y: auto;
        }

        .state-title {
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
            margin-bottom: 8px;
            font-size: 12px;
        }

        .state-var {
            margin: 4px 0;
            font-family: var(--vscode-editor-font-family);
            word-break: break-all;
        }

        .state-var-name {
            color: var(--vscode-symbolIcon-variableForeground);
        }

        .state-var-value {
            color: var(--vscode-symbolIcon-stringForeground);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="passage-header">
            <div class="passage-name" id="passage-name">Loading...</div>
        </div>

        <div class="passage-content" id="passage-content"></div>

        <div class="choices" id="choices"></div>

        <div class="controls">
            <button class="control-button" onclick="editState()">⚙ Edit State</button>
            <button class="control-button" onclick="reset()">⟳ Reset</button>
        </div>
    </div>

    <div class="state-panel">
        <div class="state-title">State Variables</div>
        <div id="state-vars">
            <div style="color: #999; font-style: italic;">Empty</div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        // Render passage data
        function render(data) {
            document.getElementById('passage-name').textContent = data.passageName;
            document.getElementById('passage-content').textContent = data.content;

            // Render choices
            const choicesEl = document.getElementById('choices');
            choicesEl.innerHTML = '';

            if (data.choices && data.choices.length > 0) {
                data.choices.forEach((choice, index) => {
                    const btn = document.createElement('button');
                    btn.className = 'choice';
                    btn.textContent = choice.text;
                    btn.onclick = () => selectChoice(index);
                    choicesEl.appendChild(btn);
                });
            } else {
                const noChoices = document.createElement('div');
                noChoices.className = 'no-choices';
                noChoices.textContent = 'No choices available (end of passage)';
                choicesEl.appendChild(noChoices);
            }

            // Render state
            const stateEl = document.getElementById('state-vars');
            stateEl.innerHTML = '';

            const stateEntries = Object.entries(data.state || {});
            if (stateEntries.length === 0) {
                const empty = document.createElement('div');
                empty.style.color = '#999';
                empty.style.fontStyle = 'italic';
                empty.textContent = 'Empty';
                stateEl.appendChild(empty);
            } else {
                stateEntries.forEach(([key, value]) => {
                    const varEl = document.createElement('div');
                    varEl.className = 'state-var';

                    const nameSpan = document.createElement('span');
                    nameSpan.className = 'state-var-name';
                    nameSpan.textContent = key;

                    const valueSpan = document.createElement('span');
                    valueSpan.className = 'state-var-value';
                    valueSpan.textContent = ': ' + JSON.stringify(value);

                    varEl.appendChild(nameSpan);
                    varEl.appendChild(valueSpan);
                    stateEl.appendChild(varEl);
                });
            }
        }

        function selectChoice(index) {
            vscode.postMessage({
                command: 'choiceSelected',
                index: index
            });
        }

        function editState() {
            vscode.postMessage({ command: 'editState' });
        }

        function reset() {
            vscode.postMessage({ command: 'reset' });
        }

        // Listen for messages from extension
        window.addEventListener('message', event => {
            const message = event.data;

            switch (message.command) {
                case 'render':
                    render(message.data);
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}
