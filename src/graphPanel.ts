// ============================================
// FILE: src/graphPanel.ts
// WHAT IT DOES: Manages the graph webview panel
// ============================================
import * as vscode from 'vscode';
import * as path from 'path';
import { CompilationResult, CompiledStory } from './compiler';

export class BardGraphPanel {
    public static currentPanel: BardGraphPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _filePath: string;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, compilationResult: CompilationResult | string, filePath: string) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._filePath = filePath;

        // Set the HTML content
        this._update(compilationResult);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'nodeClicked':
                        this._jumpToPassage(message.passageName);
                        break;
                }
            },
            null,
            this._disposables
        );

        // Clean up when panel is closed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public static createOrShow(extensionUri: vscode.Uri, compilationResult: CompilationResult | string, filePath: string) {
        const column = vscode.ViewColumn.Two;

        // If we already have a panel, show it
        if (BardGraphPanel.currentPanel) {
            BardGraphPanel.currentPanel._panel.reveal(column);
            BardGraphPanel.currentPanel._update(compilationResult);
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            'bardGraph',
            'Bardic Story Graph',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview')]
            }
        );

        BardGraphPanel.currentPanel = new BardGraphPanel(panel, extensionUri, compilationResult, filePath);
    }

    public static updateIfVisible(compilationResult: CompilationResult | string) {
        if (BardGraphPanel.currentPanel) {
            BardGraphPanel.currentPanel._update(compilationResult);
        }
    }

    private async _update(compilationResult: CompilationResult | string) {
        let graphData: any;

        if (typeof compilationResult === 'string') {
            // Legacy path: file content string (for backward compatibility)
            graphData = await this._simpleParse(compilationResult);
        } else {
            // New path: CompilationResult
            if (compilationResult.success && compilationResult.data) {
                // Use pre-compiled CLI data
                graphData = compilationResult.data;
            } else {
                // Show error or fall back to simple parser
                if (compilationResult.error) {
                    this._panel.webview.html = this._getErrorHtml(compilationResult.error);
                    return;
                } else {
                    // Simple parser method - need to parse file
                    const fs = require('fs');
                    const content = await fs.promises.readFile(this._filePath, 'utf-8');
                    graphData = await this._simpleParse(content);
                }
            }
        }

        // Sanitize graph data to only include what the webview needs
        // This prevents vis.js from choking on arrays in the passages data
        const sanitizedGraphData = {
            nodes: graphData.nodes,
            edges: graphData.edges,
            startPassage: graphData.startPassage,
            missingPassages: graphData.missingPassages || [],
            orphanPassages: graphData.orphanPassages || []
        };

        console.log('[Bardic] Sanitized graph data structure:', {
            nodeCount: sanitizedGraphData.nodes?.length,
            edgeCount: sanitizedGraphData.edges?.length,
            sampleNode: sanitizedGraphData.nodes?.[0],
            sampleEdge: sanitizedGraphData.edges?.[0]
        });

        this._panel.webview.html = this._getHtmlForWebview(sanitizedGraphData);
    }

    private _getErrorHtml(error: any): string {
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
        .error-container {
            max-width: 600px;
            background: rgba(74, 0, 0, 0.5);
            border: 2px solid #ff4444;
            padding: 30px;
            border-radius: 8px;
        }
        .error-title {
            font-size: 24px;
            color: #ff6666;
            margin-bottom: 15px;
        }
        .error-message {
            font-size: 16px;
            line-height: 1.6;
            margin-bottom: 15px;
        }
        .error-hint {
            font-size: 14px;
            color: #ffcccc;
            font-style: italic;
            border-left: 3px solid #ff4444;
            padding-left: 15px;
            margin-top: 20px;
        }
        .error-location {
            font-family: monospace;
            background: rgba(0, 0, 0, 0.3);
            padding: 10px;
            border-radius: 4px;
            margin-top: 15px;
        }
    </style>
</head>
<body>
    <div class="error-container">
        <div class="error-title">⚠️ Compilation Error</div>
        <div class="error-message">${error.message || 'Unknown error'}</div>
        ${error.filePath && error.lineNumber ? `
            <div class="error-location">
                ${error.filePath}:${error.lineNumber}
            </div>
        ` : ''}
        ${error.hint ? `
            <div class="error-hint">
                💡 ${error.hint}
            </div>
        ` : ''}
    </div>
</body>
</html>`;
    }

    private async _parseStory(fileContent: string): Promise<any> {
        // Use the simple parser
        return this._simpleParse(fileContent);
    }

    private _convertToGraphFormat(storyData: any) {
        // Convert your JSON format to vis.js format
        const nodes: any[] = [];
        const edges: any[] = [];

        Object.keys(storyData.passages).forEach(passageName => {
            const passage = storyData.passages[passageName];

            // Add node
            nodes.push({
                id: passageName,
                label: passageName,
                title: `Click to jump to ${passageName}`  // Tooltip
            });

            // Add edges for each choice
            if (passage.choices && Array.isArray(passage.choices)) {
                passage.choices.forEach((choice: any) => {
                    edges.push({
                        from: passageName,
                        to: choice.target,
                        label: choice.text,
                        title: choice.text  // Tooltip
                    });
                });
            }
        });

        return { nodes, edges, startPassage: storyData.start_passage };
    }

    private _simpleParse(fileContent: string) {
        const passages: any = {};
        const lines = fileContent.split('\n');
        let currentPassage = '';
        let inPyBlock = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            if (!trimmed) continue;

            if (trimmed.startsWith('@py:') || trimmed === '@py') {
                inPyBlock = true;
                continue;
            }
            if (trimmed === '@endpy') {
                inPyBlock = false;
                continue;
            }
            if (inPyBlock) {
                continue;
            }

            // Check for passage declaration (with optional parameters)
            const passageMatch = /^::\s+([\w.]+)(\([^)]*\))?/.exec(trimmed);
            if (passageMatch) {
                const baseName = passageMatch[1];  // Just the name
                const params = passageMatch[2] || '';  // The (params) part
                const fullName = baseName + params;  // Full signature

                currentPassage = baseName;  // Use base name as ID

                if (!passages[currentPassage]) {
                    passages[currentPassage] = {
                        choices: [],
                        fullName: fullName,  // Store full name for display
                        hasParams: !!params  // Track if passage has parameters
                    };
                }
                continue;
            }

            if (!currentPassage) continue;

            // All the choice/jump patterns stay the same
            // (they already just extract the base name without params)

            const jumpMatch = /^->\s+([\w.]+)/.exec(trimmed);
            if (jumpMatch) {
                passages[currentPassage].choices.push({
                    text: '→',
                    target: jumpMatch[1],
                    isJump: true
                });
                continue;
            }

            const conditionalChoiceMatch = /^[+*]\s+\{[^}]+\}\s+\[(.*?)\]\s+->\s+([\w.]+)/.exec(trimmed);
            if (conditionalChoiceMatch) {
                passages[currentPassage].choices.push({
                    text: conditionalChoiceMatch[1],
                    target: conditionalChoiceMatch[2],
                    isConditional: true
                });
                continue;
            }

            const simpleChoiceMatch = /^[+*]\s+\[(.*?)\]\s+->\s+([\w.]+)/.exec(trimmed);
            if (simpleChoiceMatch) {
                passages[currentPassage].choices.push({
                    text: simpleChoiceMatch[1],
                    target: simpleChoiceMatch[2],
                    isConditional: false
                });
                continue;
            }

            if (trimmed.includes('->')) {
                const anyTargetMatch = /->\s+([\w.]+)/.exec(trimmed);
                if (anyTargetMatch) {
                    const hasChoice = /\[(.*?)\]/.exec(trimmed);
                    if (hasChoice) {
                        passages[currentPassage].choices.push({
                            text: hasChoice[1],
                            target: anyTargetMatch[1],
                            isConditional: true
                        });
                    } else {
                        passages[currentPassage].choices.push({
                            text: '→',
                            target: anyTargetMatch[1],
                            isJump: true
                        });
                    }
                }
            }
        }

        // Rest of the function - creating nodes and edges
        const nodes: any[] = [];
        const edges: any[] = [];
        const passageNames = Object.keys(passages);

        const referencedPassages = new Set<string>();
        const allTargets = new Set<string>();

        passageNames.forEach(passageName => {
            passages[passageName].choices.forEach((choice: any) => {
                allTargets.add(choice.target);
                if (passages[choice.target]) {
                    referencedPassages.add(choice.target);
                }
            });
        });

        const missingPassages = Array.from(allTargets).filter(
            target => !passages[target]
        );

        const startPassage = passageNames[0] || 'Start';
        const orphanPassages = passageNames.filter(
            name => !referencedPassages.has(name) && name !== startPassage
        );

        passageNames.forEach(passageName => {
            const passage = passages[passageName];
            const displayName = passage.fullName || passageName;  // Use full name with params
            const wrappedLabel = this._wrapLabel(displayName, 20);
            const isOrphan = orphanPassages.includes(passageName);

            nodes.push({
                id: passageName,  // ID is base name (for linking)
                label: wrappedLabel,  // Display includes params
                title: isOrphan
                    ? `⚠️ ORPHAN: ${displayName} (nothing points here)`
                    : `Click to jump to ${displayName}`,
                isOrphan: isOrphan,
                isMissing: false,
                hasParams: passage.hasParams || false
            });

            const seenTargets = new Set<string>();

            passages[passageName].choices.forEach((choice: any) => {
                const edgeKey = `${passageName}->${choice.target}`;

                if (!seenTargets.has(edgeKey)) {
                    seenTargets.add(edgeKey);

                    edges.push({
                        from: passageName,
                        to: choice.target,
                        label: this._wrapEdgeLabel(choice.text, 12),
                        title: choice.text,
                        dashes: choice.isConditional ? [5, 5] : false,
                        width: choice.isJump ? 3 : 2,
                        isConditional: choice.isConditional,
                        isJump: choice.isJump
                    });
                }
            });
        });

        missingPassages.forEach(passageName => {
            const wrappedLabel = this._wrapLabel(passageName, 20);

            nodes.push({
                id: passageName,
                label: wrappedLabel + '\n🚨 MISSING',
                title: `🚨 MISSING PASSAGE: ${passageName} is referenced but doesn't exist!`,
                isMissing: true,
                isOrphan: false
            });
        });

        return { nodes, edges, startPassage, missingPassages, orphanPassages };
    }

    private _wrapLabel(label: string, maxLength: number): string {
        // If label is short enough, return as-is
        if (label.length <= maxLength) {
            return label;
        }

        // Special handling for parameterized passages: PassageName(param1, param2, optional=default)
        // Strategy: Split name and params onto separate lines
        const paramMatch = /^([^(]+)(\(.+\))$/.exec(label);
        if (paramMatch) {
            const passageName = paramMatch[1];
            const params = paramMatch[2];

            // Wrap the passage name first
            const wrappedName = this._wrapLabel(passageName, maxLength);

            // If params are short enough, add on same line as last name line
            if (params.length <= maxLength) {
                const nameLines = wrappedName.split('\n');
                const lastLine = nameLines[nameLines.length - 1];

                if (lastLine.length + params.length <= maxLength) {
                    nameLines[nameLines.length - 1] = lastLine + params;
                    return nameLines.join('\n');
                } else {
                    // Params on new line
                    return wrappedName + '\n' + params;
                }
            } else {
                // Params are long - try to break them nicely
                // Split params by comma: (param1, param2, key=value)
                const paramsContent = params.slice(1, -1); // Remove ( and )
                const paramParts = paramsContent.split(',').map(p => p.trim());

                // If we can fit 2-3 params per line
                const paramLines: string[] = [];
                let currentLine = '(';

                for (let i = 0; i < paramParts.length; i++) {
                    const part = paramParts[i];
                    const separator = i < paramParts.length - 1 ? ', ' : '';
                    const testLine = currentLine === '('
                        ? currentLine + part
                        : currentLine + ', ' + part;

                    if (testLine.length + separator.length + 1 <= maxLength) { // +1 for closing )
                        currentLine = testLine;
                        if (i === paramParts.length - 1) {
                            currentLine += ')';
                        }
                    } else {
                        // Line is full, start new line
                        if (currentLine !== '(') {
                            currentLine += ',';
                            paramLines.push(currentLine);
                            currentLine = ' ' + part; // Indent continuation
                            if (i === paramParts.length - 1) {
                                currentLine += ')';
                            }
                        } else {
                            // First param is too long, just add it
                            currentLine = '(' + part;
                            if (i === paramParts.length - 1) {
                                currentLine += ')';
                            }
                        }
                    }
                }

                if (currentLine && currentLine !== '(') {
                    paramLines.push(currentLine);
                }

                return wrappedName + '\n' + paramLines.join('\n');
            }
        }

        // Strategy 1: Try breaking on dots first (for namespaces like Chen.Session1.Start)
        if (label.includes('.')) {
            const parts = label.split('.');
            const lines: string[] = [];
            let currentLine = '';

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const separator = i < parts.length - 1 ? '.' : '';

                // If adding this part would exceed maxLength, start new line
                if (currentLine && (currentLine + separator + part).length > maxLength) {
                    lines.push(currentLine + separator);
                    currentLine = part;
                } else {
                    currentLine += (currentLine ? separator : '') + part;
                }
            }

            if (currentLine) {
                lines.push(currentLine);
            }

            // Check if any individual line is still too long
            const needsFurtherWrapping = lines.some(line => line.length > maxLength);

            if (!needsFurtherWrapping) {
                return lines.join('\n');
            }

            // If lines are still too long, fall through to Strategy 2
            label = lines.join('.');
        }

        // Strategy 2: Break on underscores (for names like Chen_Session_Long_Name)
        if (label.includes('_')) {
            const parts = label.split('_');
            const lines: string[] = [];
            let currentLine = '';

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const separator = i < parts.length - 1 ? '_' : '';

                if (currentLine && (currentLine + separator + part).length > maxLength) {
                    lines.push(currentLine + separator);
                    currentLine = part;
                } else {
                    currentLine += (currentLine ? separator : '') + part;
                }
            }

            if (currentLine) {
                lines.push(currentLine);
            }

            // Check if any individual line is still too long
            const needsFurtherWrapping = lines.some(line => line.length > maxLength);

            if (!needsFurtherWrapping) {
                return lines.join('\n');
            }
        }

        // Strategy 3: Break on capital letters (camelCase or PascalCase)
        const words: string[] = [];
        let currentWord = '';

        for (let i = 0; i < label.length; i++) {
            const char = label[i];

            // Break on capital letter (but not at start)
            if (char === char.toUpperCase() && char !== char.toLowerCase() && i > 0) {
                if (currentWord) {
                    words.push(currentWord);
                }
                currentWord = char;
            } else {
                currentWord += char;
            }
        }

        if (currentWord) {
            words.push(currentWord);
        }

        // Combine words into lines that fit maxLength
        const lines: string[] = [];
        let currentLine = '';

        for (const word of words) {
            if (currentLine.length + word.length > maxLength && currentLine.length > 0) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                currentLine += word;
            }
        }

        if (currentLine) {
            lines.push(currentLine);
        }

        // Strategy 4: If still too long, hard wrap at maxLength
        if (lines.some(line => line.length > maxLength)) {
            const hardWrappedLines: string[] = [];

            for (const line of lines) {
                if (line.length <= maxLength) {
                    hardWrappedLines.push(line);
                } else {
                    // Break into chunks of maxLength
                    for (let i = 0; i < line.length; i += maxLength) {
                        hardWrappedLines.push(line.substring(i, i + maxLength));
                    }
                }
            }

            return hardWrappedLines.join('\n');
        }

        return lines.join('\n') || label;
    }

    private _wrapEdgeLabel(label: string, maxLength: number = 10): string {
        if (!label || label === '→') {
            return label;
        }

        if (label.length <= maxLength) {
            return label;
        }

        // If label is REALLY long (>60 chars), truncate first
        const maxTotalLength = 60;
        if (label.length > maxTotalLength) {
            label = label.substring(0, maxTotalLength) + '...';
        }


        // Split on spaces and wrap
        const words = label.split(' ');
        const lines: string[] = [];
        let currentLine = '';

        for (const word of words) {
            if (currentLine.length + word.length + 1 <= maxLength) {
                currentLine += (currentLine ? ' ' : '') + word;
            } else {
                if (currentLine) {
                    lines.push(currentLine);
                }
                currentLine = word;
            }
        }

        if (currentLine) {
            lines.push(currentLine);
        }

        // Limit to 3 lines max
        if (lines.length > 9) {
            return lines.slice(0, 9).join('\n') + '...';
        }

        return lines.join('\n');
    }

    private _jumpToPassage(passageName: string) {
        // Find the .bard file editor, even if it's not currently focused
        const bardEditors = vscode.window.visibleTextEditors.filter(
            editor => editor.document.languageId === 'bard'
        );

        if (bardEditors.length === 0) {
            vscode.window.showErrorMessage('No .bard file editor found');
            return;
        }

        // Use the first .bard editor we find
        const editor = bardEditors[0];
        const text = editor.document.getText();

        // Escape dots and other special regex characters
        const escapedName = passageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`^::\\s+${escapedName}`, 'gm');

        const match = regex.exec(text);

        if (match) {
            const pos = editor.document.positionAt(match.index);
            const range = new vscode.Range(pos, pos);

            // Show the editor and jump to the passage
            vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One).then(e => {
                e.selection = new vscode.Selection(pos, pos);
                e.revealRange(range, vscode.TextEditorRevealType.InCenter);
            });
        } else {
            vscode.window.showWarningMessage(`Passage "${passageName}" not found in file`);
        }
    }

    private _getHtmlForWebview(graphData: any) {
        // Safely embed the data as JSON in a script tag
        const graphDataJson = JSON.stringify(graphData);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bardic Story Graph</title>
    <script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
    <style>
        body {
            margin: 0;
            padding: 0;
            background: #1a0033;
            font-family: Georgia, serif;
            overflow: hidden;
        }
        #mynetwork {
            width: 100vw;
            height: 100vh;
        }
        .vis-network {
            outline: none;
        }
        .control-button {
            background: rgba(26, 0, 51, 0.85);
            color: #d4af37;
            border: 1px solid rgba(212, 175, 55, 0.5);
            padding: 4px 8px;
            margin: 2px;
            cursor: pointer;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            border-radius: 3px;
            font-size: 9px;
            font-weight: 500;
            backdrop-filter: blur(4px);
            transition: all 0.15s ease;
            opacity: 0.9;
        }
        .control-button:hover {
            background: rgba(45, 27, 78, 0.95);
            opacity: 1;
            border-color: rgba(212, 175, 55, 0.8);
        }
    </style>
</head>
<body>
    <!-- Embed graph data as JSON -->
    <script type="application/json" id="graph-data">${graphDataJson}</script>

    <div id="controls" style="position: absolute; top: 8px; right: 8px; z-index: 1000; display: flex; gap: 2px;">
        <button onclick="exportAsPNG()" class="control-button">PNG</button>
        <button onclick="exportAsSVG()" class="control-button">SVG</button>
    </div>

    <div id="stats" style="
        position: absolute;
        top: 8px;
        left: 8px;
        background: rgba(26, 0, 51, 0.85);
        border: 1px solid rgba(212, 175, 55, 0.5);
        padding: 6px 8px;
        border-radius: 4px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #f4e4c1;
        font-size: 9px;
        line-height: 1.4;
        z-index: 1000;
        backdrop-filter: blur(4px);
    ">
        <div style="font-weight: 600; margin-bottom: 3px; color: #d4af37; font-size: 10px; opacity: 0.9;">Stats</div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <span style="opacity: 0.85; cursor: help;" title="Passages">P: <span id="passage-count" style="font-weight: 600;">0</span></span>
            <span style="opacity: 0.85; cursor: help;" title="Choices">C: <span id="choice-count" style="font-weight: 600;">0</span></span>
            <span style="color: #ff4444; opacity: 0.85; cursor: help;" title="Missing Passages">M: <span id="missing-count" style="font-weight: 600;">0</span></span>
            <span style="color: #66d9ef; opacity: 0.85; cursor: help;" title="Orphan Passages">O: <span id="orphan-count" style="font-weight: 600;">0</span></span>
        </div>
    </div>

    <div id="legend" style="
        position: absolute;
        bottom: 8px;
        left: 8px;
        background: rgba(26, 0, 51, 0.85);
        border: 1px solid rgba(212, 175, 55, 0.5);
        padding: 6px 8px;
        border-radius: 4px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #f4e4c1;
        font-size: 9px;
        line-height: 1.3;
        z-index: 1000;
        backdrop-filter: blur(4px);
    ">
        <div style="font-weight: 600; margin-bottom: 3px; color: #d4af37; font-size: 10px; opacity: 0.9;">Legend</div>
        <div style="display: flex; gap: 8px; margin-bottom: 2px;">
            <div style="display: flex; align-items: center; gap: 3px;">
                <span style="display: inline-block; width: 16px; height: 1.5px; background: #9b4dca;"></span>
                <span style="opacity: 0.85;">Choice</span>
            </div>
            <div style="display: flex; align-items: center; gap: 3px;">
                <span style="display: inline-block; width: 16px; height: 1.5px; background: #ff9f43; border-top: 1.5px dashed #ff9f43;"></span>
                <span style="opacity: 0.85;">Cond</span>
            </div>
            <div style="display: flex; align-items: center; gap: 3px;">
                <span style="display: inline-block; width: 16px; height: 2px; background: #d4af37;"></span>
                <span style="opacity: 0.85;">Jump</span>
            </div>
        </div>
        <div style="display: flex; gap: 8px; margin-top: 3px; margin-bottom: 2px;">
            <div style="display: flex; align-items: center; gap: 3px;">
                <span style="display: inline-block; width: 8px; height: 8px; background: #2d1b4e; border: 1.5px solid #d4af37;"></span>
                <span style="opacity: 0.85;">Start</span>
            </div>
            <div style="display: flex; align-items: center; gap: 3px;">
                <span style="display: inline-block; width: 8px; height: 8px; background: #2d1b4e; border: 1.5px solid #66bb6a;"></span>
                <span style="opacity: 0.85;">Reuse</span>
            </div>
        </div>
        <div style="display: flex; gap: 8px; margin-top: 2px;">
            <div style="display: flex; align-items: center; gap: 3px;">
                <span style="display: inline-block; width: 8px; height: 8px; background: #1a3a4a; border: 1.5px solid #9b4dca;"></span>
                <span style="opacity: 0.85;">Orphan</span>
            </div>
            <div style="display: flex; align-items: center; gap: 3px;">
                <span style="display: inline-block; width: 8px; height: 8px; background: #4a0000; border: 1.5px solid #ff4444;"></span>
                <span style="opacity: 0.85;">Miss</span>
            </div>
        </div>
    </div>

    <div id="mynetwork"></div>

    <script>
        (function() {
            const vscode = acquireVsCodeApi();

            // Read graph data from the JSON script tag
            const graphData = JSON.parse(document.getElementById('graph-data').textContent);

            console.log('[Webview] Graph data loaded:', graphData);
            console.log('[Webview] First node:', graphData.nodes?.[0]);
            console.log('[Webview] First edge:', graphData.edges?.[0]);

            // Check for arrays in nodes
            if (graphData.nodes && graphData.nodes.length > 0) {
                const firstNode = graphData.nodes[0];
                console.log('[Webview] First node keys:', Object.keys(firstNode));
                Object.keys(firstNode).forEach(function(key) {
                    if (Array.isArray(firstNode[key])) {
                        console.warn('[Webview] Found array in node property:', key, firstNode[key]);
                    }
                });
            }

            // Check for arrays in edges
            if (graphData.edges && graphData.edges.length > 0) {
                const firstEdge = graphData.edges[0];
                console.log('[Webview] First edge keys:', Object.keys(firstEdge));
                Object.keys(firstEdge).forEach(function(key) {
                    if (Array.isArray(firstEdge[key])) {
                        console.warn('[Webview] Found array in edge property:', key, firstEdge[key]);
                    }
                });
            }

            // Update stats
            const realPassages = graphData.nodes.filter(function(n) { return !n.isMissing; }).length;
            document.getElementById('passage-count').textContent = realPassages;
            document.getElementById('choice-count').textContent = graphData.edges.length;
            document.getElementById('missing-count').textContent = (graphData.missingPassages || []).length;
            document.getElementById('orphan-count').textContent = (graphData.orphanPassages || []).length;

            // Create nodes with Bardic styling
            console.log('[Webview] About to create vis.DataSet for nodes');
            const nodes = new vis.DataSet(
                graphData.nodes.map(function(node) {
                    let bgColor = '#2d1b4e';  // Default purple background
                    let borderColor = '#9b4dca';  // Default purple border
                    let borderWidth = 2;
                    let fontColor = '#f4e4c1';

                    // Background = warnings/issues
                    if (node.isMissing) {
                        bgColor = '#4a0000';  // Red background for missing
                        fontColor = '#ffcccc';
                    } else if (node.isOrphan) {
                        bgColor = '#1a3a4a';  // Dark cyan background for orphans
                    }

                    // Border = passage type (can combine with background warnings)
                    if (node.isMissing) {
                        borderColor = '#ff4444';  // Red border for missing
                        borderWidth = 3;
                    } else if (node.id === graphData.startPassage) {
                        borderColor = '#d4af37';  // Gold for start
                        borderWidth = 3;
                    } else if (node.hasParams) {
                        borderColor = '#66bb6a';  // Mint green for reusable
                        borderWidth = 3;
                    }

                    return {
                        id: node.id,
                        label: node.label,
                        title: node.title,
                        isMissing: node.isMissing,
                        isOrphan: node.isOrphan,
                        color: {
                            background: bgColor,
                            border: borderColor,
                            highlight: {
                                background: node.isMissing ? '#6a0000' : (node.isOrphan ? '#2a5a6a' : '#3d2b5e'),
                                border: '#f4e4c1'
                            },
                            hover: {
                                background: node.isMissing ? '#6a0000' : (node.isOrphan ? '#2a5a6a' : '#3d2b5e'),
                                border: '#d4af37'
                            }
                        },
                        font: {
                            color: fontColor,
                            face: 'Georgia',
                            size: 14,
                            multi: 'html'
                        },
                        borderWidth: borderWidth,
                        shape: 'box',
                        margin: 10,
                        widthConstraint: {
                            minimum: 120,
                            maximum: 250
                        },
                        heightConstraint: {
                            minimum: 40
                        }
                    };
                })
            );

            // Create edges
            const edges = new vis.DataSet(
                graphData.edges.map(function(edge) {
                    const baseEdge = {
                        from: edge.from,
                        to: edge.to,
                        label: edge.label,
                        title: edge.title,
                        arrows: 'to',
                        smooth: {
                            type: 'curvedCW',
                            roundness: 0.2
                        }
                    };

                    if (edge.isJump) {
                        return Object.assign({}, baseEdge, {
                            color: {
                                color: '#d4af37',
                                highlight: '#f4e4c1',
                                hover: '#f4e4c1'
                            },
                            width: 3,
                            font: {
                                color: '#d4af37',
                                size: 12,
                                bold: true,
                                background: 'rgba(26, 0, 51, 0.8)',
                                strokeWidth: 0,
                                multi: 'html',
                                align: 'horizontal'
                            },
                            dashes: false
                        });
                    }

                    if (edge.isConditional) {
                        return Object.assign({}, baseEdge, {
                            color: {
                                color: '#ff9f43',
                                highlight: '#ffc875',
                                hover: '#ffc875'
                            },
                            width: 2,
                            dashes: [5, 5],
                            font: {
                                color: '#ffc875',
                                size: 11,
                                background: 'rgba(26, 0, 51, 0.8)',
                                strokeWidth: 0,
                                multi: 'html',
                                align: 'horizontal'
                            }
                        });
                    }

                    return Object.assign({}, baseEdge, {
                        color: {
                            color: '#9b4dca',
                            highlight: '#c9a0dc',
                            hover: '#c9a0dc'
                        },
                        width: 2,
                        font: {
                            color: '#f4e4c1',
                            size: 11,
                            background: 'rgba(26, 0, 51, 0.8)',
                            strokeWidth: 0,
                            multi: 'html',
                            align: 'horizontal'
                        }
                    });
                })
            );

            // Create network
            console.log('[Webview] About to create vis.Network');
            const container = document.getElementById('mynetwork');
            const data = { nodes: nodes, edges: edges };

            console.log('[Webview] data object:', {
                nodesType: typeof nodes,
                edgesType: typeof edges,
                nodeCount: nodes.length,
                edgeCount: edges.length
            });

            const options = {
                layout: {
                    hierarchical: {
                        direction: 'UD',
                        sortMethod: 'directed',
                        nodeSpacing: 300,
                        levelSeparation: 300,
                        treeSpacing: 300,
                        blockShifting: true,
                        edgeMinimization: true,
                        parentCentralization: true
                    }
                },
                physics: {
                    enabled: true,
                    hierarchicalRepulsion: {
                        nodeDistance: 250,
                        centralGravity: 0.0,
                        springLength: 250,
                        springConstant: 0.01,
                        damping: 0.09
                    },
                    stabilization: {
                        enabled: true,
                        iterations: 1000,
                        fit: true
                    }
                },
                interaction: {
                    hover: true,
                    tooltipDelay: 100,
                    zoomView: true,
                    dragView: true
                },
                nodes: {
                    shape: 'box'
                }
            };

            let network;
            try {
                console.log('[Webview] Creating vis.Network with options:', options);
                network = new vis.Network(container, data, options);
                console.log('[Webview] vis.Network created successfully!');
            } catch (error) {
                console.error('[Webview] ERROR creating vis.Network:', error);
                console.error('[Webview] Error stack:', error.stack);
                console.error('[Webview] Error message:', error.message);
                throw error;
            }

            // Handle node clicks
            network.on('click', function(params) {
                if (params.nodes.length > 0) {
                    const passageName = params.nodes[0];
                    vscode.postMessage({
                        command: 'nodeClicked',
                        passageName: passageName
                    });
                }
            });

            // Fit to view after layout stabilizes
            network.once('stabilizationIterationsDone', function() {
                network.fit({
                    animation: {
                        duration: 1000,
                        easingFunction: 'easeInOutQuad'
                    }
                });
            });

            // Export functions (make them global)
            window.exportAsPNG = function() {
                const canvas = document.querySelector('#mynetwork canvas');
                if (canvas) {
                    const link = document.createElement('a');
                    link.download = 'story-graph.png';
                    link.href = canvas.toDataURL('image/png');
                    link.click();
                } else {
                    alert('Canvas not found. Wait for graph to render.');
                }
            };

            window.exportAsSVG = function() {
                try {
                    const svg = createSVG(network, graphData);
                    const blob = new Blob([svg], {type: 'image/svg+xml;charset=utf-8'});
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.download = 'story-graph.svg';
                    link.href = url;
                    link.click();
                    setTimeout(function() { URL.revokeObjectURL(url); }, 100);
                } catch (e) {
                    console.error('SVG export failed:', e);
                    alert('SVG export failed: ' + e.message);
                }
            };

            function createSVG(network, graphData) {
                const positions = network.getPositions();

                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                Object.keys(positions).forEach(function(key) {
                    const pos = positions[key];
                    minX = Math.min(minX, pos.x);
                    minY = Math.min(minY, pos.y);
                    maxX = Math.max(maxX, pos.x);
                    maxY = Math.max(maxY, pos.y);
                });

                const width = maxX - minX + 400;
                const height = maxY - minY + 400;
                const offsetX = -minX + 200;
                const offsetY = -minY + 200;

                let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '">';
                svg += '<rect width="100%" height="100%" fill="#1a0033"/>';

                svg += '<defs>';
                svg += '<marker id="arrow-choice" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#9b4dca" /></marker>';
                svg += '<marker id="arrow-cond" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#ff9f43" /></marker>';
                svg += '<marker id="arrow-jump" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#d4af37" /></marker>';
                svg += '</defs>';

                graphData.edges.forEach(function(edge) {
                    const fromPos = positions[edge.from];
                    const toPos = positions[edge.to];
                    if (!fromPos || !toPos) return;

                    const x1 = fromPos.x + offsetX;
                    const y1 = fromPos.y + offsetY;
                    const x2 = toPos.x + offsetX;
                    const y2 = toPos.y + offsetY;

                    let color = '#9b4dca';
                    let strokeWidth = 2;
                    let dasharray = '';
                    let markerType = 'choice';

                    if (edge.isJump) {
                        color = '#d4af37';
                        strokeWidth = 3;
                        markerType = 'jump';
                    } else if (edge.isConditional) {
                        color = '#ff9f43';
                        dasharray = '5,5';
                        markerType = 'cond';
                    }

                    svg += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + color + '" stroke-width="' + strokeWidth + '" stroke-dasharray="' + dasharray + '" marker-end="url(#arrow-' + markerType + ')"/>';
                });

                graphData.nodes.forEach(function(node) {
                    const pos = positions[node.id];
                    if (!pos) return;

                    const x = pos.x + offsetX;
                    const y = pos.y + offsetY;
                    const boxWidth = 120;
                    const boxHeight = 50;

                    let bgColor = '#2d1b4e';  // Default purple background
                    let borderColor = '#9b4dca';  // Default purple border
                    let borderWidth = 2;

                    // Background = warnings/issues
                    if (node.isMissing) {
                        bgColor = '#4a0000';  // Red background for missing
                    } else if (node.isOrphan) {
                        bgColor = '#1a3a4a';  // Dark cyan background for orphans
                    }

                    // Border = passage type (can combine with background warnings)
                    if (node.isMissing) {
                        borderColor = '#ff4444';  // Red border for missing
                        borderWidth = 3;
                    } else if (node.id === graphData.startPassage) {
                        borderColor = '#d4af37';  // Gold for start
                        borderWidth = 3;
                    } else if (node.hasParams) {
                        borderColor = '#66bb6a';  // Mint green for reusable
                        borderWidth = 3;
                    }

                    svg += '<rect x="' + (x - boxWidth/2) + '" y="' + (y - boxHeight/2) + '" width="' + boxWidth + '" height="' + boxHeight + '" rx="10" fill="' + bgColor + '" stroke="' + borderColor + '" stroke-width="' + borderWidth + '"/>';

                    const labelLines = (node.label || '').split('\\n');
                    const lineHeight = 16;
                    const startY = y - ((labelLines.length - 1) * lineHeight) / 2;

                    labelLines.forEach(function(line, i) {
                        const escapedLine = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                        svg += '<text x="' + x + '" y="' + (startY + i * lineHeight) + '" text-anchor="middle" dominant-baseline="middle" fill="#f4e4c1" font-family="Georgia" font-size="14">' + escapedLine + '</text>';
                    });
                });

                svg += '</svg>';
                return svg;
            }
        })();
    </script>
</body>
</html>`;
    }

    public dispose() {
        BardGraphPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}