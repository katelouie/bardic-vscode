"use strict";
// ============================================
// FILE: src/compiler.ts
// WHAT IT DOES: Compiles .bard files using CLI or simple parser
// ============================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.BardCompiler = void 0;
const vscode = require("vscode");
const child_process_1 = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
class BardCompiler {
    constructor(pythonManager) {
        this.pythonManager = pythonManager;
    }
    /**
     * Compile using best available method (CLI preferred, simple parser fallback)
     */
    async compile(filePath) {
        // Get settings
        const config = vscode.workspace.getConfiguration('bardic');
        const preferCLI = config.get('preferCLI', true);
        if (!preferCLI) {
            // User explicitly disabled CLI - use simple parser
            const content = await fs.promises.readFile(filePath, 'utf-8');
            return this.compileWithSimpleParser(content, filePath);
        }
        // Try CLI first if available
        const pythonPath = await this.pythonManager.getPythonPath();
        if (pythonPath) {
            const hasBardic = await this.pythonManager.isBardicInstalled(pythonPath);
            if (hasBardic) {
                const result = await this.compileWithCLI(filePath, pythonPath);
                if (result.success) {
                    return result;
                }
                // CLI failed - check if it's a non-fatal error (missing passages)
                if (result.error?.message.includes('Target passage') && result.error?.message.includes('does not exist')) {
                    console.warn('[Bardic] CLI found missing passage targets, falling back to simple parser');
                    // Fall through to simple parser - don't return the error
                }
                else {
                    // Real syntax error - return it
                    console.warn('[Bardic] CLI compilation failed with syntax error:', result.error?.message);
                    return result;
                }
            }
        }
        // Fallback to simple parser
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const result = await this.compileWithSimpleParser(content, filePath);
        // Add warning if we wanted CLI but couldn't use it
        // BUT: don't warn if we already tried CLI and it just had missing passages
        const triedCLI = pythonPath && await this.pythonManager.isBardicInstalled(pythonPath);
        if (!triedCLI) {
            if (!result.warnings) {
                result.warnings = [];
            }
            if (!pythonPath) {
                result.warnings.push('Python interpreter not selected. Using simplified graph generation.');
            }
            else {
                result.warnings.push('Bardic not installed in Python environment. Using simplified graph generation.');
            }
        }
        return result;
    }
    /**
     * Compile using bardic CLI
     */
    async compileWithCLI(filePath, pythonPath) {
        return new Promise((resolve) => {
            const tempOutput = path.join(os.tmpdir(), `bardic-${Date.now()}.json`);
            const config = vscode.workspace.getConfiguration('bardic');
            const timeout = Math.min(config.get('compilationTimeout', 10000), 60000);
            console.log('[Bardic] Starting CLI compilation:', {
                pythonPath,
                filePath,
                tempOutput,
                timeout
            });
            const process = (0, child_process_1.spawn)(pythonPath, [
                '-m', 'bardic.cli.main',
                'compile',
                filePath,
                '-o', tempOutput
            ]);
            let stderr = '';
            let stdout = '';
            process.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            process.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            let timedOut = false;
            const timeoutHandle = setTimeout(() => {
                timedOut = true;
                process.kill();
                resolve({
                    success: false,
                    error: {
                        type: 'timeout',
                        message: `Compilation timeout (${timeout}ms)`,
                        hint: 'Try increasing bardic.compilationTimeout setting'
                    },
                    method: 'cli'
                });
            }, timeout);
            process.on('close', async (code) => {
                clearTimeout(timeoutHandle);
                if (timedOut) {
                    return; // Already resolved
                }
                console.log('[Bardic] CLI process closed:', {
                    exitCode: code,
                    stdout: stdout.trim(),
                    stderr: stderr.trim()
                });
                if (code === 0) {
                    try {
                        const json = await fs.promises.readFile(tempOutput, 'utf-8');
                        const storyData = JSON.parse(json);
                        const graphData = this.convertToGraphFormat(storyData);
                        // Clean up temp file
                        await fs.promises.unlink(tempOutput).catch(() => { });
                        console.log('[Bardic] CLI compilation SUCCESS!', {
                            nodes: graphData.nodes.length,
                            edges: graphData.edges.length
                        });
                        resolve({
                            success: true,
                            data: graphData,
                            method: 'cli'
                        });
                    }
                    catch (error) {
                        console.log('[Bardic] CLI compilation FAILED to parse output:', error);
                        resolve({
                            success: false,
                            error: {
                                type: 'unknown',
                                message: `Failed to parse CLI output: ${error.message}`
                            },
                            method: 'cli'
                        });
                    }
                }
                else {
                    // Parse stderr for helpful error messages
                    const error = this.parseBardError(stderr, filePath);
                    console.log('[Bardic] CLI compilation FAILED with error:', error);
                    // Check if it's a "missing passage" error - treat as non-fatal
                    if (stderr.includes('Target passage') && stderr.includes('does not exist')) {
                        console.log('[Bardic] Non-fatal error (missing passage target) - will use simple parser');
                        resolve({
                            success: false,
                            error: {
                                ...error,
                                type: 'syntax-error' // Still treat as error for fallback
                            },
                            method: 'cli'
                        });
                    }
                    else {
                        resolve({
                            success: false,
                            error,
                            method: 'cli'
                        });
                    }
                }
            });
            process.on('error', (error) => {
                clearTimeout(timeoutHandle);
                resolve({
                    success: false,
                    error: {
                        type: 'python-not-found',
                        message: `Failed to execute Python: ${error.message}`,
                        hint: 'Check that Python is correctly installed'
                    },
                    method: 'cli'
                });
            });
        });
    }
    /**
     * Parse bardic CLI error output
     */
    parseBardError(stderr, filePath) {
        // Example bardic error format:
        // Error in test.bard:42: SyntaxError: Unclosed conditional
        const lineMatch = /Error in (.+?):(\d+):\s*(.+)/.exec(stderr);
        if (lineMatch) {
            return {
                type: 'syntax-error',
                message: lineMatch[3],
                filePath: lineMatch[1],
                lineNumber: parseInt(lineMatch[2]),
                hint: 'Check the syntax at the line mentioned above'
            };
        }
        if (stderr.includes('No module named')) {
            return {
                type: 'bardic-not-installed',
                message: 'Bardic is not installed in the selected Python environment',
                hint: 'Run: pip install bardic'
            };
        }
        return {
            type: 'unknown',
            message: stderr || 'Unknown compilation error',
            hint: 'Check the bardic CLI output for details'
        };
    }
    /**
     * Convert CLI JSON output to graph format
     */
    convertToGraphFormat(storyData) {
        const nodes = [];
        const edges = [];
        const passages = storyData.passages || {};
        const startPassage = storyData.start_passage || Object.keys(passages)[0];
        const referencedPassages = new Set();
        const allTargets = new Set();
        // Helper to extract choices from content (including for_loops, nested in conditionals, etc.)
        const extractChoicesFromContent = (content) => {
            const choices = [];
            if (!content)
                return choices;
            content.forEach((token) => {
                // Check for for_loop with choices
                if (token.type === 'for_loop' && token.choices) {
                    choices.push(...token.choices);
                    // Recursively check for_loop's content for more nested structures
                    if (token.content) {
                        choices.push(...extractChoicesFromContent(token.content));
                    }
                }
                // Check for conditionals with branches
                if (token.type === 'conditional' && token.branches) {
                    token.branches.forEach((branch) => {
                        // Recursively extract from branch content
                        if (branch.content) {
                            choices.push(...extractChoicesFromContent(branch.content));
                        }
                        // Also include branch's own choices (if any)
                        if (branch.choices) {
                            choices.push(...branch.choices);
                        }
                    });
                }
                // Could extend for other nested structures in the future
            });
            return choices;
        };
        // Build edges and track targets
        Object.keys(passages).forEach(passageName => {
            const passage = passages[passageName];
            // Get both static choices and dynamic choices from for_loops
            const staticChoices = passage.choices || [];
            const dynamicChoices = extractChoicesFromContent(passage.content || []);
            const allChoices = [...staticChoices, ...dynamicChoices];
            if (dynamicChoices.length > 0) {
                console.log(`[Bardic] Found ${dynamicChoices.length} dynamic choices in ${passageName}:`, dynamicChoices.map((c) => c.target));
            }
            allChoices.forEach((choice) => {
                const target = choice.target;
                if (!target)
                    return;
                allTargets.add(target);
                if (passages[target]) {
                    referencedPassages.add(target);
                }
                // Avoid duplicate edges
                const edgeKey = `${passageName}->${target}`;
                if (!edges.find(e => `${e.from}->${e.to}` === edgeKey)) {
                    // choice.text might be array of token objects or string - normalize it
                    let choiceText = choice.text || '→';
                    if (Array.isArray(choiceText)) {
                        // Extract .value from each token object and join
                        choiceText = choiceText.map((token) => {
                            if (typeof token === 'string')
                                return token;
                            return token.value || '';
                        }).join('');
                    }
                    choiceText = String(choiceText);
                    edges.push({
                        from: passageName,
                        to: target,
                        label: this.wrapEdgeLabel(choiceText, 12),
                        title: choiceText,
                        isConditional: !!choice.condition,
                        isJump: choice.type === 'jump' || !choice.text
                    });
                }
            });
        });
        // Build nodes
        Object.keys(passages).forEach(passageName => {
            const passage = passages[passageName];
            const displayName = passage.name || passageName;
            // Check if passage has parameters (CLI stores as array of param objects)
            const hasParams = passage.params && Array.isArray(passage.params) && passage.params.length > 0;
            const isOrphan = !referencedPassages.has(passageName) && passageName !== startPassage;
            nodes.push({
                id: passageName,
                label: this.wrapLabel(displayName, 20),
                title: isOrphan
                    ? `⚠️ ORPHAN: ${displayName} (nothing points here)`
                    : `Click to jump to ${displayName}`,
                hasParams,
                isMissing: false,
                isOrphan
            });
        });
        // Add missing passage nodes
        const missingPassages = Array.from(allTargets).filter(target => !passages[target]);
        missingPassages.forEach(passageName => {
            nodes.push({
                id: passageName,
                label: this.wrapLabel(passageName, 20) + '\n🚨 MISSING',
                title: `🚨 MISSING PASSAGE: ${passageName} is referenced but doesn't exist!`,
                hasParams: false,
                isMissing: true,
                isOrphan: false
            });
        });
        const orphanPassages = nodes
            .filter(n => n.isOrphan && !n.isMissing)
            .map(n => n.id);
        return {
            nodes,
            edges,
            startPassage,
            missingPassages,
            orphanPassages,
            passages,
            imports: storyData.imports || [],
            metadata: storyData.metadata || {},
            version: storyData.version || '0.1.0'
        };
    }
    /**
     * Compile using simple parser (from graphPanel.ts)
     */
    async compileWithSimpleParser(content, filePath) {
        // This will use the existing _simpleParse logic from graphPanel
        // For now, return a result that indicates simple parser should be used
        return {
            success: true,
            data: undefined, // Will be handled by graphPanel
            method: 'simple-parser'
        };
    }
    wrapLabel(label, maxLength) {
        if (label.length <= maxLength) {
            return label;
        }
        // Simple wrapping - break on dots, underscores, or capitals
        const lines = [];
        let currentLine = '';
        for (const char of label) {
            if (currentLine.length >= maxLength && (char === '.' || char === '_' || char === char.toUpperCase())) {
                lines.push(currentLine);
                currentLine = char;
            }
            else {
                currentLine += char;
            }
        }
        if (currentLine) {
            lines.push(currentLine);
        }
        return lines.join('\n');
    }
    wrapEdgeLabel(label, maxLength) {
        if (!label || label === '→' || label.length <= maxLength) {
            return label;
        }
        // Truncate long labels
        if (label.length > 60) {
            label = label.substring(0, 60) + '...';
        }
        // Split on spaces
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
        return lines.slice(0, 3).join('\n');
    }
}
exports.BardCompiler = BardCompiler;
//# sourceMappingURL=compiler.js.map