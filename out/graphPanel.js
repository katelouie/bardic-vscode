"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BardGraphPanel = void 0;
// ============================================
// FILE: src/graphPanel.ts
// WHAT IT DOES: Manages the graph webview panel
// ============================================
const vscode = require("vscode");
const child_process_1 = require("child_process");
const util_1 = require("util");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
class BardGraphPanel {
    constructor(panel, extensionUri, fileContent, filePath) {
        this._disposables = [];
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._filePath = filePath;
        // Set the HTML content
        this._update(fileContent);
        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case 'nodeClicked':
                    this._jumpToPassage(message.passageName);
                    break;
            }
        }, null, this._disposables);
        // Clean up when panel is closed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }
    static createOrShow(extensionUri, fileContent, filePath) {
        const column = vscode.ViewColumn.Two;
        // If we already have a panel, show it
        if (BardGraphPanel.currentPanel) {
            BardGraphPanel.currentPanel._panel.reveal(column);
            BardGraphPanel.currentPanel._update(fileContent);
            return;
        }
        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel('bardGraph', 'Bardic Story Graph', column, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview')]
        });
        BardGraphPanel.currentPanel = new BardGraphPanel(panel, extensionUri, fileContent, filePath);
    }
    static updateIfVisible(fileContent) {
        if (BardGraphPanel.currentPanel) {
            BardGraphPanel.currentPanel._update(fileContent);
        }
    }
    async _update(fileContent) {
        const graphData = await this._parseStory(fileContent);
        this._panel.webview.html = this._getHtmlForWebview(graphData);
    }
    async _parseStory(fileContent) {
        // Just use the simple parser for now
        // We can add CLI support later if needed
        return this._simpleParse(fileContent);
    }
    _convertToGraphFormat(storyData) {
        // Convert your JSON format to vis.js format
        const nodes = [];
        const edges = [];
        Object.keys(storyData.passages).forEach(passageName => {
            const passage = storyData.passages[passageName];
            // Add node
            nodes.push({
                id: passageName,
                label: passageName,
                title: `Click to jump to ${passageName}` // Tooltip
            });
            // Add edges for each choice
            if (passage.choices && Array.isArray(passage.choices)) {
                passage.choices.forEach((choice) => {
                    edges.push({
                        from: passageName,
                        to: choice.target,
                        label: choice.text,
                        title: choice.text // Tooltip
                    });
                });
            }
        });
        return { nodes, edges, startPassage: storyData.start_passage };
    }
    _simpleParse(fileContent) {
        const passages = {};
        const lines = fileContent.split('\n');
        let currentPassage = '';
        let inPyBlock = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (!trimmed)
                continue;
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
                const baseName = passageMatch[1]; // Just the name
                const params = passageMatch[2] || ''; // The (params) part
                const fullName = baseName + params; // Full signature
                currentPassage = baseName; // Use base name as ID
                if (!passages[currentPassage]) {
                    passages[currentPassage] = {
                        choices: [],
                        fullName: fullName // Store full name for display
                    };
                }
                continue;
            }
            if (!currentPassage)
                continue;
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
                    }
                    else {
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
        const nodes = [];
        const edges = [];
        const passageNames = Object.keys(passages);
        const referencedPassages = new Set();
        const allTargets = new Set();
        passageNames.forEach(passageName => {
            passages[passageName].choices.forEach((choice) => {
                allTargets.add(choice.target);
                if (passages[choice.target]) {
                    referencedPassages.add(choice.target);
                }
            });
        });
        const missingPassages = Array.from(allTargets).filter(target => !passages[target]);
        const startPassage = passageNames[0] || 'Start';
        const orphanPassages = passageNames.filter(name => !referencedPassages.has(name) && name !== startPassage);
        passageNames.forEach(passageName => {
            const passage = passages[passageName];
            const displayName = passage.fullName || passageName; // Use full name with params
            const wrappedLabel = this._wrapLabel(displayName, 20);
            const isOrphan = orphanPassages.includes(passageName);
            nodes.push({
                id: passageName, // ID is base name (for linking)
                label: wrappedLabel, // Display includes params
                title: isOrphan
                    ? `⚠️ ORPHAN: ${displayName} (nothing points here)`
                    : `Click to jump to ${displayName}`,
                isOrphan: isOrphan,
                isMissing: false
            });
            const seenTargets = new Set();
            passages[passageName].choices.forEach((choice) => {
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
    _wrapLabel(label, maxLength) {
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
                }
                else {
                    // Params on new line
                    return wrappedName + '\n' + params;
                }
            }
            else {
                // Params are long - try to break them nicely
                // Split params by comma: (param1, param2, key=value)
                const paramsContent = params.slice(1, -1); // Remove ( and )
                const paramParts = paramsContent.split(',').map(p => p.trim());
                // If we can fit 2-3 params per line
                const paramLines = [];
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
                    }
                    else {
                        // Line is full, start new line
                        if (currentLine !== '(') {
                            currentLine += ',';
                            paramLines.push(currentLine);
                            currentLine = ' ' + part; // Indent continuation
                            if (i === paramParts.length - 1) {
                                currentLine += ')';
                            }
                        }
                        else {
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
            const lines = [];
            let currentLine = '';
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const separator = i < parts.length - 1 ? '.' : '';
                // If adding this part would exceed maxLength, start new line
                if (currentLine && (currentLine + separator + part).length > maxLength) {
                    lines.push(currentLine + separator);
                    currentLine = part;
                }
                else {
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
            const lines = [];
            let currentLine = '';
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const separator = i < parts.length - 1 ? '_' : '';
                if (currentLine && (currentLine + separator + part).length > maxLength) {
                    lines.push(currentLine + separator);
                    currentLine = part;
                }
                else {
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
        const words = [];
        let currentWord = '';
        for (let i = 0; i < label.length; i++) {
            const char = label[i];
            // Break on capital letter (but not at start)
            if (char === char.toUpperCase() && char !== char.toLowerCase() && i > 0) {
                if (currentWord) {
                    words.push(currentWord);
                }
                currentWord = char;
            }
            else {
                currentWord += char;
            }
        }
        if (currentWord) {
            words.push(currentWord);
        }
        // Combine words into lines that fit maxLength
        const lines = [];
        let currentLine = '';
        for (const word of words) {
            if (currentLine.length + word.length > maxLength && currentLine.length > 0) {
                lines.push(currentLine);
                currentLine = word;
            }
            else {
                currentLine += word;
            }
        }
        if (currentLine) {
            lines.push(currentLine);
        }
        // Strategy 4: If still too long, hard wrap at maxLength
        if (lines.some(line => line.length > maxLength)) {
            const hardWrappedLines = [];
            for (const line of lines) {
                if (line.length <= maxLength) {
                    hardWrappedLines.push(line);
                }
                else {
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
    _wrapEdgeLabel(label, maxLength = 10) {
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
        const lines = [];
        let currentLine = '';
        for (const word of words) {
            if (currentLine.length + word.length + 1 <= maxLength) {
                currentLine += (currentLine ? ' ' : '') + word;
            }
            else {
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
    _jumpToPassage(passageName) {
        // Find the .bard file editor, even if it's not currently focused
        const bardEditors = vscode.window.visibleTextEditors.filter(editor => editor.document.languageId === 'bard');
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
        }
        else {
            vscode.window.showWarningMessage(`Passage "${passageName}" not found in file`);
        }
    }
    _getHtmlForWebview(graphData) {
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
            background: #2d1b4e;
            color: #d4af37;
            border: 2px solid #d4af37;
            padding: 8px 16px;
            margin: 4px;
            cursor: pointer;
            font-family: Georgia, serif;
            border-radius: 4px;
            font-size: 12px;
        }
        .control-button:hover {
            background: #3d2b5e;
        }
    </style>
</head>
<body>
    <!-- Embed graph data as JSON -->
    <script type="application/json" id="graph-data">${graphDataJson}</script>

    <div id="controls" style="position: absolute; top: 10px; right: 10px; z-index: 1000;">
        <button onclick="exportAsPNG()" class="control-button">Export PNG</button>
        <button onclick="exportAsSVG()" class="control-button">Export SVG</button>
    </div>

    <div id="stats" style="
        position: absolute;
        top: 10px;
        left: 10px;
        background: rgba(45, 27, 78, 0.95);
        border: 2px solid #d4af37;
        padding: 12px;
        border-radius: 8px;
        font-family: Georgia, serif;
        color: #f4e4c1;
        font-size: 13px;
        z-index: 1000;
    ">
        <div style="font-weight: bold; margin-bottom: 8px; color: #d4af37; font-size: 14px;">Story Stats</div>
        <div>Passages: <span id="passage-count" style="font-weight: bold;">0</span></div>
        <div>Choices: <span id="choice-count" style="font-weight: bold;">0</span></div>
        <div style="color: #ff4444;">Missing: <span id="missing-count" style="font-weight: bold;">0</span></div>
        <div style="color: #66d9ef;">Orphans: <span id="orphan-count" style="font-weight: bold;">0</span></div>
    </div>

    <div id="legend" style="
        position: absolute;
        bottom: 10px;
        left: 10px;
        background: rgba(45, 27, 78, 0.95);
        border: 2px solid #d4af37;
        padding: 12px;
        border-radius: 8px;
        font-family: Georgia, serif;
        color: #f4e4c1;
        font-size: 12px;
        z-index: 1000;
    ">
        <div style="font-weight: bold; margin-bottom: 8px; color: #d4af37;">Legend</div>
        <div style="margin: 4px 0;">
            <span style="display: inline-block; width: 25px; height: 2px; background: #9b4dca; vertical-align: middle; margin-right: 8px;"></span>
            <span style="vertical-align: middle;">Choice</span>
        </div>
        <div style="margin: 4px 0;">
            <span style="display: inline-block; width: 25px; height: 2px; background: #ff9f43; vertical-align: middle; margin-right: 8px; border-top: 2px dashed #ff9f43;"></span>
            <span style="vertical-align: middle;">Conditional</span>
        </div>
        <div style="margin: 4px 0;">
            <span style="display: inline-block; width: 25px; height: 3px; background: #d4af37; vertical-align: middle; margin-right: 8px;"></span>
            <span style="vertical-align: middle;">Jump</span>
        </div>
        <div style="margin: 8px 0 4px 0; font-size: 11px; font-weight: bold;">Nodes:</div>
        <div style="margin: 4px 0;">
            <span style="display: inline-block; width: 12px; height: 12px; border: 2px solid #d4af37; vertical-align: middle; margin-right: 8px;"></span>
            <span style="vertical-align: middle;">Start</span>
        </div>
        <div style="margin: 4px 0;">
            <span style="display: inline-block; width: 12px; height: 12px; border: 2px solid #66d9ef; vertical-align: middle; margin-right: 8px;"></span>
            <span style="vertical-align: middle;">Orphan</span>
        </div>
        <div style="margin: 4px 0;">
            <span style="display: inline-block; width: 12px; height: 12px; border: 2px solid #ff4444; background: #4a0000; vertical-align: middle; margin-right: 8px;"></span>
            <span style="vertical-align: middle;">Missing</span>
        </div>
    </div>

    <div id="mynetwork"></div>

    <script>
        (function() {
            const vscode = acquireVsCodeApi();

            // Read graph data from the JSON script tag
            const graphData = JSON.parse(document.getElementById('graph-data').textContent);

            console.log('Graph data loaded:', graphData);

            // Update stats
            const realPassages = graphData.nodes.filter(function(n) { return !n.isMissing; }).length;
            document.getElementById('passage-count').textContent = realPassages;
            document.getElementById('choice-count').textContent = graphData.edges.length;
            document.getElementById('missing-count').textContent = (graphData.missingPassages || []).length;
            document.getElementById('orphan-count').textContent = (graphData.orphanPassages || []).length;

            // Create nodes with Bardic styling
            const nodes = new vis.DataSet(
                graphData.nodes.map(function(node) {
                    let bgColor = '#2d1b4e';
                    let borderColor = '#9b4dca';
                    let borderWidth = 2;
                    let fontColor = '#f4e4c1';

                    if (node.isMissing) {
                        bgColor = '#4a0000';
                        borderColor = '#ff4444';
                        borderWidth = 3;
                        fontColor = '#ffcccc';
                    } else if (node.isOrphan) {
                        borderColor = '#66d9ef';
                        borderWidth = 3;
                    } else if (node.id === graphData.startPassage) {
                        borderColor = '#d4af37';
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
                                background: node.isMissing ? '#6a0000' : '#3d2b5e',
                                border: node.isMissing ? '#ff6666' : '#f4e4c1'
                            },
                            hover: {
                                background: node.isMissing ? '#6a0000' : '#3d2b5e',
                                border: node.isMissing ? '#ff6666' : '#d4af37'
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
            const container = document.getElementById('mynetwork');
            const data = { nodes: nodes, edges: edges };
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

            const network = new vis.Network(container, data, options);

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

                    let bgColor = '#2d1b4e';
                    let borderColor = '#9b4dca';
                    let borderWidth = 2;

                    if (node.isMissing) {
                        bgColor = '#4a0000';
                        borderColor = '#ff4444';
                        borderWidth = 3;
                    } else if (node.isOrphan) {
                        borderColor = '#66d9ef';
                        borderWidth = 3;
                    } else if (node.id === graphData.startPassage) {
                        borderColor = '#d4af37';
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
    dispose() {
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
exports.BardGraphPanel = BardGraphPanel;
//# sourceMappingURL=graphPanel.js.map